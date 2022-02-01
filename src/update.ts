/* eslint-disable unicorn/prefer-module */
import color from '@oclif/color'
import {Config, CliUx, Interfaces} from '@oclif/core'

import * as fs from 'fs-extra'
import HTTP from 'http-call'
import * as _ from 'lodash'
import * as path from 'path'

import {extract} from './tar'
import {ls, rm, wait} from './util'

export interface UpdateCliOptions {
  channel?: string;
  autoUpdate: boolean;
  version: string | undefined;
  hard: boolean;
  config: Config;
  exit: (code?: number | undefined) => void;
}

export type VersionIndex = Record<string, string>

function composeS3SubDir(config: Config): string {
  let s3SubDir = (config.pjson.oclif.update.s3 as any).folder || ''
  if (s3SubDir !== '' && s3SubDir.slice(-1) !== '/') s3SubDir = `${s3SubDir}/`
  return s3SubDir
}

export default class UpdateCli {
  private channel!: string

  private currentVersion?: string

  private updatedVersion!: string

  private readonly clientRoot: string

  private readonly clientBin: string

  public static async findLocalVersions(config: Config): Promise<string[]> {
    const clientRoot = UpdateCli.getClientRoot(config)
    await UpdateCli.ensureClientDir(clientRoot)
    return fs
    .readdirSync(clientRoot)
    .filter(dirOrFile => dirOrFile !== 'bin' && dirOrFile !== 'current')
    .map(f => path.join(clientRoot, f))
  }

  public static async fetchVersionIndex(config: Config): Promise<VersionIndex> {
    const http: typeof HTTP = require('http-call').HTTP

    CliUx.ux.action.status = 'fetching version index'
    const newIndexUrl = config.s3Url(
      UpdateCli.s3VersionIndexKey(config),
    )

    const {body} = await http.get<VersionIndex>(newIndexUrl)
    if (typeof body === 'string') {
      return JSON.parse(body)
    }

    return body
  }

  private static async ensureClientDir(clientRoot: string): Promise<void> {
    try {
      await fs.mkdirp(clientRoot)
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // for some reason the client directory is sometimes a file
        // if so, this happens. Delete it and recreate
        await fs.remove(clientRoot)
        await fs.mkdirp(clientRoot)
      } else {
        throw error
      }
    }
  }

  private static s3ChannelManifestKey(config: Config, channel: string): string {
    const {bin, platform, arch} = config
    const s3SubDir = composeS3SubDir(config)
    return path.join(s3SubDir, 'channels', channel, `${bin}-${platform}-${arch}-buildmanifest`)
  }

  private static s3VersionManifestKey(config: Config, version: string, hash: string): string {
    const {bin, platform, arch} = config
    const s3SubDir = composeS3SubDir(config)
    return path.join(s3SubDir, 'versions', version, hash, `${bin}-v${version}-${hash}-${platform}-${arch}-buildmanifest`)
  }

  private static s3VersionIndexKey(config: Config): string {
    const {bin, platform, arch} = config
    const s3SubDir = composeS3SubDir(config)
    return path.join(s3SubDir, 'versions', `${bin}-${platform}-${arch}-tar-gz.json`)
  }

  private static getClientRoot(config: Config): string {
    return config.scopedEnvVar('OCLIF_CLIENT_HOME') || path.join(config.dataDir, 'client')
  }

  private static getClientBin(config: Config): string {
    return path.join(UpdateCli.getClientRoot(config), 'bin', config.windows ? `${config.bin}.cmd` : config.bin)
  }

  constructor(private options: UpdateCliOptions) {
    this.clientRoot = UpdateCli.getClientRoot(options.config)
    this.clientBin = UpdateCli.getClientBin(options.config)
  }

  public async runUpdate(): Promise<void> {
    if (this.options.autoUpdate) await this.debounce()

    this.channel = this.options.channel || await this.determineChannel()

    if (this.options.hard) {
      CliUx.ux.action.start(`${this.options.config.name}: Removing old installations`)
      await rm(path.dirname(this.clientRoot))
    }

    CliUx.ux.action.start(`${this.options.config.name}: Updating CLI`)

    if (this.options.version) {
      await this.options.config.runHook('preupdate', {channel: this.channel, version: this.options.version})

      const localVersion = await this.findLocalVersion(this.options.version)

      if (localVersion) {
        this.updateToExistingVersion(localVersion)
      } else {
        const index = await UpdateCli.fetchVersionIndex(this.options.config)
        const url = index[this.options.version]
        if (!url) {
          throw new Error(`${this.options.version} not found in index:\n${Object.keys(index).join(', ')}`)
        }

        const manifest = await this.fetchVersionManifest(this.options.version, url)
        this.currentVersion = await this.determineCurrentVersion()
        this.updatedVersion = manifest.sha ? `${manifest.version}-${manifest.sha}` : manifest.version
        const reason = await this.skipUpdate()
        if (reason) CliUx.ux.action.stop(reason || 'done')
        else await this.update(manifest)

        CliUx.ux.debug('tidy')
        await this.tidy()
      }

      await this.options.config.runHook('update', {channel: this.channel, version: this.updatedVersion})
      CliUx.ux.action.stop()
      CliUx.ux.log()
      CliUx.ux.log(`Updating to a specific version will not update the channel. If autoupdate is enabled, the CLI will eventually be updated back to ${this.channel}.`)
    } else {
      const manifest = await this.fetchChannelManifest()
      this.currentVersion = await this.determineCurrentVersion()
      this.updatedVersion = manifest.sha ? `${manifest.version}-${manifest.sha}` : manifest.version
      await this.options.config.runHook('preupdate', {channel: this.channel, version: this.updatedVersion})
      const reason = await this.skipUpdate()
      if (reason) CliUx.ux.action.stop(reason || 'done')
      else await this.update(manifest)
      CliUx.ux.debug('tidy')
      await this.tidy()
      await this.options.config.runHook('update', {channel: this.channel, version: this.updatedVersion})
      CliUx.ux.action.stop()
    }

    CliUx.ux.debug('done')
  }

  private async fetchChannelManifest(): Promise<Interfaces.S3Manifest> {
    const s3Key = UpdateCli.s3ChannelManifestKey(this.options.config, this.channel)
    return this.fetchManifest(s3Key)
  }

  private async fetchVersionManifest(version: string, url: string): Promise<Interfaces.S3Manifest> {
    const parts = url.split('/')
    const hashIndex = parts.indexOf(version) + 1
    const hash = parts[hashIndex]
    const s3Key = UpdateCli.s3VersionManifestKey(this.options.config, version, hash)
    return this.fetchManifest(s3Key)
  }

  private async fetchManifest(s3Key: string): Promise<Interfaces.S3Manifest> {
    const http: typeof HTTP = require('http-call').HTTP

    CliUx.ux.action.status = 'fetching manifest'

    try {
      const url = this.options.config.s3Url(s3Key)
      const {body} = await http.get<Interfaces.S3Manifest | string>(url)
      if (typeof body === 'string') {
        return JSON.parse(body)
      }

      return body
    } catch (error: any) {
      if (error.statusCode === 403) throw new Error(`HTTP 403: Invalid channel ${this.channel}`)
      throw error
    }
  }

  private async downloadAndExtract(output: string, manifest: Interfaces.S3Manifest, channel: string) {
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

  private async update(manifest: Interfaces.S3Manifest, channel = 'stable') {
    CliUx.ux.action.start(`${this.options.config.name}: Updating CLI from ${color.green(this.currentVersion)} to ${color.green(this.updatedVersion)}${channel === 'stable' ? '' : ' (' + color.yellow(channel) + ')'}`)

    await UpdateCli.ensureClientDir(this.clientRoot)
    const output = path.join(this.clientRoot, this.updatedVersion)

    if (!await fs.pathExists(output)) {
      await this.downloadAndExtract(output, manifest, channel)
    }

    await this.setChannel()
    await this.createBin(this.updatedVersion)
    await this.touch()
    CliUx.ux.action.stop()
  }

  private async updateToExistingVersion(version: string): Promise<void> {
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

  private async findLocalVersion(version: string): Promise<string | undefined> {
    const versions = await UpdateCli.findLocalVersions(this.options.config)
    return versions
    .map(file => path.basename(file))
    .find(file => file.startsWith(version))
  }

  private async setChannel(): Promise<void> {
    const channelPath = path.join(this.options.config.dataDir, 'channel')
    fs.writeFile(channelPath, this.channel, 'utf8')
  }

  private async logChop(): Promise<void> {
    try {
      CliUx.ux.debug('log chop')
      const logChopper = require('log-chopper').default
      await logChopper.chop(this.options.config.errlog)
    } catch (error: any) {
      CliUx.ux.debug(error.message)
    }
  }

  private async mtime(f: string): Promise<Date> {
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
        CliUx.ux.log(msg)
        output = true
      }

      await wait(60 * 1000) // wait 1 minute
      return this.debounce()
    }

    CliUx.ux.log('time to update')
  }

  // removes any unused CLIs
  private async tidy(): Promise<void> {
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

  private async touch(): Promise<void> {
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

  private async createBin(version: string): Promise<void> {
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
}
