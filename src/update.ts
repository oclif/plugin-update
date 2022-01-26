/* eslint-disable unicorn/prefer-module */
import color from '@oclif/color'
import {Config, CliUx} from '@oclif/core'
import {IManifest} from 'oclif'

import * as spawn from 'cross-spawn'
import * as fs from 'fs-extra'
import HTTP from 'http-call'
import * as _ from 'lodash'
import * as path from 'path'

import {extract} from './tar'
import {ls, wait} from './util'

export interface UpdateCliOptions {
  channel?: string;
  autoUpdate: boolean;
  fromLocal: boolean;
  config: Config;
  exit: any;
  getPinToVersion: () => Promise<string>;
}

export default class UpdateCli {
  private channel!: string

  private currentVersion?: string

  private updatedVersion!: string

  private readonly clientRoot: string

  private readonly clientBin: string

  constructor(private options: UpdateCliOptions) {
    this.clientRoot = this.options.config.scopedEnvVar('OCLIF_CLIENT_HOME') || path.join(this.options.config.dataDir, 'client')
    this.clientBin = path.join(this.clientRoot, 'bin', this.options.config.windows ? `${this.options.config.bin}.cmd` : this.options.config.bin)
  }

  async runUpdate(): Promise<void> {
    if (this.options.autoUpdate) await this.debounce()

    this.channel = this.options.channel || await this.determineChannel()

    if (this.options.fromLocal) {
      await this.ensureClientDir()
      CliUx.ux.debug(`Looking for locally installed versions at ${this.clientRoot}`)

      // Do not show known non-local version folder names, bin and current.
      const versions = fs.readdirSync(this.clientRoot).filter(dirOrFile => dirOrFile !== 'bin' && dirOrFile !== 'current')
      if (versions.length === 0) throw new Error('No locally installed versions found.')

      CliUx.ux.log(`Found versions: \n${versions.map(version => `     ${version}`).join('\n')}\n`)

      const pinToVersion = await this.options.getPinToVersion()
      if (!versions.includes(pinToVersion)) throw new Error(`Version ${pinToVersion} not found in the locally installed versions.`)

      if (!await fs.pathExists(path.join(this.clientRoot, pinToVersion))) {
        throw new Error(`Version ${pinToVersion} is not already installed at ${this.clientRoot}.`)
      }

      CliUx.ux.action.start(`${this.options.config.name}: Updating CLI`)
      CliUx.ux.debug(`switching to existing version ${pinToVersion}`)
      this.updateToExistingVersion(pinToVersion)

      CliUx.ux.log()
      CliUx.ux.log(`Updating to an already installed version will not update the channel. If autoupdate is enabled, the CLI will eventually be updated back to ${this.channel}.`)
    } else {
      CliUx.ux.action.start(`${this.options.config.name}: Updating CLI`)
      await this.options.config.runHook('preupdate', {channel: this.channel})
      const manifest = await this.fetchManifest()
      this.currentVersion = await this.determineCurrentVersion()
      this.updatedVersion = (manifest as any).sha ? `${manifest.version}-${(manifest as any).sha}` : manifest.version
      const reason = await this.skipUpdate()
      if (reason) CliUx.ux.action.stop(reason || 'done')
      else await this.update(manifest)
      CliUx.ux.debug('tidy')
      await this.tidy()
      await this.options.config.runHook('update', {channel: this.channel})
    }

    CliUx.ux.debug('done')
    CliUx.ux.action.stop()
  }

  private async fetchManifest(): Promise<IManifest> {
    const http: typeof HTTP = require('http-call').HTTP

    CliUx.ux.action.status = 'fetching manifest'

    try {
      const url = this.options.config.s3Url(this.options.config.s3Key('manifest', {
        channel: this.channel,
        platform: this.options.config.platform,
        arch: this.options.config.arch,
      }))
      const {body} = await http.get<IManifest | string>(url)

      // in case the content-type is not set, parse as a string
      // this will happen if uploading without `oclif-dev publish`
      if (typeof body === 'string') {
        return JSON.parse(body)
      }

      return body
    } catch (error: any) {
      if (error.statusCode === 403) throw new Error(`HTTP 403: Invalid channel ${this.channel}`)
      throw error
    }
  }

  private async downloadAndExtract(output: string, manifest: IManifest, channel: string) {
    const {version, gz, sha256gz} = manifest

    const filesize = (n: number): string => {
      const [num, suffix] = require('filesize')(n, {output: 'array'})
      return num.toFixed(1) + ` ${suffix}`
    }

    const http: typeof HTTP = require('http-call').HTTP
    const gzUrl = gz || this.options.config.s3Url(this.options.config.s3Key('versioned', {
      version,
      channel,
      bin: this.options.config.bin,
      platform: this.options.config.platform,
      arch: this.options.config.arch,
      ext: 'gz',
    }))
    const {response: stream} = await http.stream(gzUrl)
    stream.pause()

    const baseDir = manifest.baseDir || this.options.config.s3Key('baseDir', {
      version,
      channel,
      bin: this.options.config.bin,
      platform: this.options.config.platform,
      arch: this.options.config.arch,
    })
    const extraction = extract(stream, baseDir, output, sha256gz)

    // to-do: use cli.action.type
    if ((CliUx.ux.action as any).frames) {
      // if spinner action
      const total = Number.parseInt(stream.headers['content-length']!, 10)
      let current = 0
      const updateStatus = _.throttle(
        (newStatus: string) => {
          CliUx.ux.action.status = newStatus
        },
        250,
        {leading: true, trailing: false},
      )
      stream.on('data', data => {
        current += data.length
        updateStatus(`${filesize(current)}/${filesize(total)}`)
      })
    }

    stream.resume()
    await extraction
  }

  private async update(manifest: IManifest, channel = 'stable') {
    CliUx.ux.action.start(`${this.options.config.name}: Updating CLI from ${color.green(this.currentVersion)} to ${color.green(this.updatedVersion)}${channel === 'stable' ? '' : ' (' + color.yellow(channel) + ')'}`)

    await this.ensureClientDir()
    const output = path.join(this.clientRoot, this.updatedVersion)

    if (!await fs.pathExists(output)) {
      await this.downloadAndExtract(output, manifest, channel)
    }

    await this.setChannel()
    await this.createBin(this.updatedVersion)
    await this.touch()
    await this.reexec()
  }

  private async updateToExistingVersion(version: string) {
    await this.createBin(version)
    await this.touch()
  }

  private async skipUpdate(): Promise<string | false> {
    if (!this.options.config.binPath) {
      const instructions = this.options.config.scopedEnvVar('UPDATE_INSTRUCTIONS')
      if (instructions) CliUx.ux.warn(instructions)
      return 'not updatable'
    }

    if (this.currentVersion === this.updatedVersion) {
      if (this.options.config.scopedEnvVar('HIDE_UPDATED_MESSAGE')) return 'done'
      return `already on latest version: ${this.currentVersion}`
    }

    return false
  }

  private async determineChannel(): Promise<string> {
    const channelPath = path.join(this.options.config.dataDir, 'channel')
    if (fs.existsSync(channelPath)) {
      const channel = await fs.readFile(channelPath, 'utf8')
      return String(channel).trim()
    }

    return this.options.config.channel || 'stable'
  }

  private async determineCurrentVersion(): Promise<string|undefined> {
    try {
      const currentVersion = await fs.readFile(this.clientBin, 'utf8')
      const matches = currentVersion.match(/\.\.[/\\|](.+)[/\\|]bin/)
      return matches ? matches[1] : this.options.config.version
    } catch (error: any) {
      CliUx.ux.debug(error)
    }

    return this.options.config.version
  }

  private s3ChannelManifestKey(bin: string, platform: string, arch: string, folder = ''): string {
    let s3SubDir = folder || ''
    if (s3SubDir !== '' && s3SubDir.slice(-1) !== '/') s3SubDir = `${s3SubDir}/`
    return path.join(s3SubDir, 'channels', this.channel, `${bin}-${platform}-${arch}-buildmanifest`)
  }

  private async setChannel() {
    const channelPath = path.join(this.options.config.dataDir, 'channel')
    fs.writeFile(channelPath, this.channel, 'utf8')
  }

  private async logChop() {
    try {
      CliUx.ux.debug('log chop')
      const logChopper = require('log-chopper').default
      await logChopper.chop(this.options.config.errlog)
    } catch (error: any) {
      CliUx.ux.debug(error.message)
    }
  }

  private async mtime(f: string) {
    const {mtime} = await fs.stat(f)
    return mtime
  }

  // when autoupdating, wait until the CLI isn't active
  private async debounce(): Promise<void> {
    let output = false
    const lastrunfile = path.join(this.options.config.cacheDir, 'lastrun')
    const m = await this.mtime(lastrunfile)
    m.setHours(m.getHours() + 1)
    if (m > new Date()) {
      const msg = `waiting until ${m.toISOString()} to update`
      if (output) {
        CliUx.ux.debug(msg)
      } else {
        await CliUx.ux.log(msg)
        output = true
      }

      await wait(60 * 1000) // wait 1 minute
      return this.debounce()
    }

    CliUx.ux.log('time to update')
  }

  // removes any unused CLIs
  private async tidy() {
    try {
      const root = this.clientRoot
      if (!await fs.pathExists(root)) return
      const files = await ls(root)
      const promises = files.map(async (f: any) => {
        if (['bin', 'current', this.options.config.version].includes(path.basename(f.path))) return
        const mtime = f.stat.mtime
        mtime.setHours(mtime.getHours() + (42 * 24))
        if (mtime < new Date()) {
          await fs.remove(f.path)
        }
      })
      for (const p of promises) await p // eslint-disable-line no-await-in-loop
      await this.logChop()
    } catch (error: any) {
      CliUx.ux.warn(error)
    }
  }

  private async touch() {
    // touch the client so it won't be tidied up right away
    try {
      const p = path.join(this.clientRoot, this.options.config.version)
      CliUx.ux.debug('touching client at', p)
      if (!await fs.pathExists(p)) return
      await fs.utimes(p, new Date(), new Date())
    } catch (error: any) {
      CliUx.ux.warn(error)
    }
  }

  private async reexec() {
    CliUx.ux.action.stop()
    return new Promise((_, reject) => {
      CliUx.ux.debug('restarting CLI after update', this.clientBin)
      spawn(this.clientBin, ['update'], {
        stdio: 'inherit',
        env: {...process.env, [this.options.config.scopedEnvVarKey('HIDE_UPDATED_MESSAGE')]: '1'},
      })
      .on('error', reject)
      .on('close', (status: number) => {
        try {
          if (status > 0) this.options.exit(status)
        } catch (error: any) {
          reject(error)
        }
      })
    })
  }

  private async createBin(version: string) {
    const dst = this.clientBin
    const {bin, windows} = this.options.config
    const binPathEnvVar = this.options.config.scopedEnvVarKey('BINPATH')
    const redirectedEnvVar = this.options.config.scopedEnvVarKey('REDIRECTED')
    if (windows) {
      const body = `@echo off
setlocal enableextensions
set ${redirectedEnvVar}=1
set ${binPathEnvVar}=%~dp0${bin}
"%~dp0..\\${version}\\bin\\${bin}.cmd" %*
`
      await fs.outputFile(dst, body)
    } else {
      /* eslint-disable no-useless-escape */
      const body = `#!/usr/bin/env bash
set -e
get_script_dir () {
  SOURCE="\${BASH_SOURCE[0]}"
  # While $SOURCE is a symlink, resolve it
  while [ -h "$SOURCE" ]; do
    DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
    SOURCE="$( readlink "$SOURCE" )"
    # If $SOURCE was a relative symlink (so no "/" as prefix, need to resolve it relative to the symlink base directory
    [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
  done
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  echo "$DIR"
}
DIR=$(get_script_dir)
${binPathEnvVar}="\$DIR/${bin}" ${redirectedEnvVar}=1 "$DIR/../${version}/bin/${bin}" "$@"
`
      /* eslint-enable no-useless-escape */

      await fs.remove(dst)
      await fs.outputFile(dst, body)
      await fs.chmod(dst, 0o755)
      await fs.remove(path.join(this.clientRoot, 'current'))
      await fs.symlink(`./${version}`, path.join(this.clientRoot, 'current'))
    }
  }

  private async ensureClientDir() {
    try {
      await fs.mkdirp(this.clientRoot)
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // for some reason the client directory is sometimes a file
        // if so, this happens. Delete it and recreate
        await fs.remove(this.clientRoot)
        await fs.mkdirp(this.clientRoot)
      } else {
        throw error
      }
    }
  }
}
