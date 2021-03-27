import color from '@oclif/color'
import Command, {flags} from '@oclif/command'
import {IManifest} from '@oclif/dev-cli'
import cli from 'cli-ux'
import * as spawn from 'cross-spawn'
import * as fs from 'fs-extra'
import HTTP from 'http-call'
import * as _ from 'lodash'
import * as path from 'path'
import * as semver from 'semver'

import {extract} from '../tar'
import {ls, wait} from '../util'

export default class UpdateCommand extends Command {
  static description = 'update the <%= config.bin %> CLI'

  static args = [{name: 'channel', optional: true}]

  static flags: flags.Input<any> = {
    autoupdate: flags.boolean({hidden: true}),
    'from-local': flags.boolean({description: 'interactively choose an already installed version'}),
    'switch-to': flags.string({char: 'v', description: 'specify a specific version to switch to'}),
  }

  private autoupdate!: boolean

  private channel!: string

  private currentVersion?: string

  private updatedVersion!: string

  private readonly clientRoot = this.config.scopedEnvVar('OCLIF_CLIENT_HOME') || path.join(this.config.dataDir, 'client')

  private readonly clientBin = path.join(this.clientRoot, 'bin', this.config.windows ? `${this.config.bin}.cmd` : this.config.bin)

  async run() {
    const {args, flags} = this.parse(UpdateCommand)
    this.autoupdate = Boolean(flags.autoupdate)

    if (this.autoupdate) await this.debounce()

    this.channel = args.channel || await this.determineChannel()

    if (flags['from-local']) {
      // Do not show known non-local version folder names, bin and current.
      const versions = fs.readdirSync(this.clientRoot).filter(dirOrFile => dirOrFile !== 'bin' && dirOrFile !== 'current')

      await this.ensureClientDir()
      this.debug(`Looking for locally installed versions at ${this.clientRoot}`)

      if (versions.length === 0) throw new Error('No locally installed versions found.')

      this.log(`Found versions: \n${versions.map(version => `     ${version}`).join('\n')}\n`)

      const pinToVersion = await cli.prompt('Enter a version to update to')
      if (!versions.includes(pinToVersion)) throw new Error(`Version ${pinToVersion} not found in the locally installed versions.`)

      if (!await fs.pathExists(path.join(this.clientRoot, pinToVersion))) {
        throw new Error(`Version ${pinToVersion} is not already installed at ${this.clientRoot}.`)
      }
      cli.action.start(`${this.config.name}: Updating CLI`)
      this.debug(`switching to existing version ${pinToVersion}`)
      this.updateToExistingVersion(pinToVersion)

      this.log()
      this.log(`Updating to an already installed version will not update the channel. If autoupdate is enabled, the CLI will eventually be updated back to ${this.channel}.`)
    } else {
      let targetVersion
      if (flags['switch-to']) {
        targetVersion = semver.clean(flags['switch-to'])
        this.debug(`Flag overriden target version: ${targetVersion}`)
        const versionParts = targetVersion?.split('-') || ['', '']
        if (versionParts && versionParts[1]) {
          this.channel = versionParts[1].substr(0, versionParts[1].indexOf('.'))
        }
        this.debug(`Flag overriden target channel: ${this.channel}`)
      }

      cli.action.start(`${this.config.name}: Updating CLI`)
      await this.config.runHook('preupdate', {channel: this.channel})
      const manifest = await this.fetchManifest()
      this.currentVersion = await this.determineCurrentVersion()

      this.updatedVersion = (manifest as any).sha ? `${targetVersion || manifest.version}-${(manifest as any).sha}` : targetVersion || manifest.version
      this.debug(`Updating to ${this.updatedVersion}`)
      const reason = await this.skipUpdate()
      if (reason) cli.action.stop(reason || 'done')
      else await this.update(manifest, this.channel, targetVersion || '')
      this.debug('tidy')
      await this.tidy()
      await this.config.runHook('update', {channel: this.channel})
    }

    this.debug('done')
    cli.action.stop()
  }

  private async fetchManifest(): Promise<IManifest> {
    const http: typeof HTTP = require('http-call').HTTP

    cli.action.status = 'fetching manifest'
    if (!this.config.scopedEnvVarTrue('USE_LEGACY_UPDATE')) {
      try {
        const newManifestUrl = this.config.s3Url(
          this.s3ChannelManifestKey(
            this.config.bin,
            this.config.platform,
            this.config.arch,
            (this.config.pjson.oclif.update.s3 as any).folder,
          ),
        )
        const {body} = await http.get<IManifest | string>(newManifestUrl)
        if (typeof body === 'string') {
          return JSON.parse(body)
        }
        return body
      } catch (error) {
        this.debug(error.message)
      }
    }

    try {
      const url = this.config.s3Url(this.config.s3Key('manifest', {
        channel: this.channel,
        platform: this.config.platform,
        arch: this.config.arch,
      }))
      const {body} = await http.get<IManifest | string>(url)

      // in case the content-type is not set, parse as a string
      // this will happen if uploading without `oclif-dev publish`
      if (typeof body === 'string') {
        return JSON.parse(body)
      }
      return body
    } catch (error) {
      if (error.statusCode === 403) throw new Error(`HTTP 403: Invalid channel ${this.channel}`)
      throw error
    }
  }

  private async downloadAndExtract(output: string, manifest: IManifest, channel: string, targetVersion?: string) {
    const filesize = (n: number): string => {
      const [num, suffix] = require('filesize')(n, {output: 'array'})
      return num.toFixed(1) + ` ${suffix}`
    }

    const http: typeof HTTP = require('http-call').HTTP
    const gzUrl = !targetVersion && manifest.gz ? manifest.gz : this.config.s3Url(this.config.s3Key('versioned', {
      version: targetVersion,
      channel,
      bin: this.config.bin,
      platform: this.config.platform,
      arch: this.config.arch,
      ext: targetVersion ? '.tar.gz' : 'gz',
    }))

    const {response: stream} = await http.stream(gzUrl)
    stream.pause()

    const baseDir = manifest.baseDir || this.config.s3Key('baseDir', {
      version: targetVersion,
      channel,
      bin: this.config.bin,
      platform: this.config.platform,
      arch: this.config.arch,
    })
    const extraction = extract(stream, baseDir, output, manifest.sha256gz)

    // to-do: use cli.action.type
    if ((cli.action as any).frames) {
      // if spinner action
      const total = parseInt(stream.headers['content-length']!, 10)
      let current = 0
      const updateStatus = _.throttle(
        (newStatus: string) => {
          cli.action.status = newStatus
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

  private async update(manifest: IManifest, channel = 'stable', targetVersion: string) {
    const {channel: manifestChannel} = manifest
    if (manifestChannel) channel = manifestChannel

    cli.action.start(`${this.config.name}: Updating CLI from ${color.green(this.currentVersion)} to ${color.green(this.updatedVersion)}${channel === 'stable' ? '' : ' (' + color.yellow(channel) + ')'}`)

    await this.ensureClientDir()
    const output = path.join(this.clientRoot, this.updatedVersion)

    if (!await fs.pathExists(output)) {
      await this.downloadAndExtract(output, manifest, channel, targetVersion)
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
    if (!this.config.binPath) {
      const instructions = this.config.scopedEnvVar('UPDATE_INSTRUCTIONS')
      if (instructions) this.warn(instructions)
      return 'not updatable'
    }
    if (this.currentVersion === this.updatedVersion) {
      if (this.config.scopedEnvVar('HIDE_UPDATED_MESSAGE')) return 'done'
      return `already on latest version: ${this.currentVersion}`
    }
    return false
  }

  private async determineChannel(): Promise<string> {
    const channelPath = path.join(this.config.dataDir, 'channel')
    if (fs.existsSync(channelPath)) {
      const channel = await fs.readFile(channelPath, 'utf8')
      return String(channel).trim()
    }
    return this.config.channel || 'stable'
  }

  private async determineCurrentVersion(): Promise<string|undefined> {
    try {
      const currentVersion = await fs.readFile(this.clientBin, 'utf8')
      const matches = currentVersion.match(/\.\.[/|\\](.+)[/|\\]bin/)
      return matches ? matches[1] : this.config.version
    } catch (error) {
      this.debug(error)
    }
    return this.config.version
  }

  private s3ChannelManifestKey(bin: string, platform: string, arch: string, folder?: string): string {
    let s3SubDir = folder || ''
    if (s3SubDir !== '' && s3SubDir.slice(-1) !== '/') s3SubDir = `${s3SubDir}/`
    return path.join(s3SubDir, 'channels', this.channel, `${bin}-${platform}-${arch}-buildmanifest`)
  }

  private async setChannel() {
    const channelPath = path.join(this.config.dataDir, 'channel')
    fs.writeFile(channelPath, this.channel, 'utf8')
  }

  private async logChop() {
    try {
      this.debug('log chop')
      const logChopper = require('log-chopper').default
      await logChopper.chop(this.config.errlog)
    } catch (error) {
      this.debug(error.message)
    }
  }

  private async mtime(f: string) {
    const {mtime} = await fs.stat(f)
    return mtime
  }

  // when autoupdating, wait until the CLI isn't active
  private async debounce(): Promise<void> {
    let output = false
    const lastrunfile = path.join(this.config.cacheDir, 'lastrun')
    const m = await this.mtime(lastrunfile)
    m.setHours(m.getHours() + 1)
    if (m > new Date()) {
      const msg = `waiting until ${m.toISOString()} to update`
      if (output) {
        this.debug(msg)
      } else {
        await cli.log(msg)
        output = true
      }
      await wait(60 * 1000) // wait 1 minute
      return this.debounce()
    }
    cli.log('time to update')
  }

  // removes any unused CLIs
  private async tidy() {
    try {
      const root = this.clientRoot
      if (!await fs.pathExists(root)) return
      const files = await ls(root)
      const promises = files.map(async f => {
        if (['bin', 'current', this.config.version].includes(path.basename(f.path))) return
        const mtime = f.stat.mtime
        mtime.setHours(mtime.getHours() + (14 * 24))
        if (mtime < new Date()) {
          await fs.remove(f.path)
        }
      })
      for (const p of promises) await p // eslint-disable-line no-await-in-loop
      await this.logChop()
    } catch (error) {
      cli.warn(error)
    }
  }

  private async touch() {
    // touch the client so it won't be tidied up right away
    try {
      const p = path.join(this.clientRoot, this.config.version)
      this.debug('touching client at', p)
      if (!await fs.pathExists(p)) return
      await fs.utimes(p, new Date(), new Date())
    } catch (error) {
      this.warn(error)
    }
  }

  private async reexec() {
    cli.action.stop()
    return new Promise((_, reject) => {
      this.debug('restarting CLI after update', this.clientBin)
      spawn(this.clientBin, ['update'], {
        stdio: 'inherit',
        env: {...process.env, [this.config.scopedEnvVarKey('HIDE_UPDATED_MESSAGE')]: '1'},
      })
      .on('error', reject)
      .on('close', (status: number) => {
        try {
          if (status > 0) this.exit(status)
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  private async createBin(version: string) {
    const dst = this.clientBin
    const {bin} = this.config
    const binPathEnvVar = this.config.scopedEnvVarKey('BINPATH')
    const redirectedEnvVar = this.config.scopedEnvVarKey('REDIRECTED')
    if (this.config.windows) {
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
    } catch (error) {
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

