/* eslint-disable unicorn/prefer-module */
import color from '@oclif/color'
import {Config, CliUx, Interfaces} from '@oclif/core'

import * as fs from 'fs-extra'
import HTTP from 'http-call'
import * as path from 'path'
import throttle from 'lodash.throttle'
import fileSize from 'filesize'

import {extract} from './tar'
import {ls, rm, wait} from './util'

const filesize = (n: number): string => {
  const [num, suffix] = fileSize(n, {output: 'array'})
  return Number.parseFloat(num).toFixed(1) + ` ${suffix}`
}

export namespace Updater {
  export type Options = {
    channel?: string | undefined;
    autoUpdate: boolean;
    version?: string | undefined
    hard: boolean;
  }

  export type VersionIndex = Record<string, string>
}

export class Updater {
  private readonly clientRoot: string
  private readonly clientBin: string

  constructor(private config: Config) {
    this.clientRoot = config.scopedEnvVar('OCLIF_CLIENT_HOME') || path.join(config.dataDir, 'client')
    this.clientBin = path.join(this.clientRoot, 'bin', config.windows ? `${config.bin}.cmd` : config.bin)
  }

  public async runUpdate(options: Updater.Options): Promise<void> {
    const {autoUpdate, version, hard} = options
    if (autoUpdate) await this.debounce()

    CliUx.ux.action.start(`${this.config.name}: Updating CLI`)

    if (this.notUpdatable()) {
      CliUx.ux.action.stop('not updatable')
      return
    }

    if (hard) {
      CliUx.ux.action.start(`${this.config.name}: Removing old installations`)
      await rm(path.dirname(this.clientRoot))
    }

    const channel = options.channel || await this.determineChannel()
    const current = await this.determineCurrentVersion()

    if (version) {
      await this.config.runHook('preupdate', {channel, version})

      const localVersion = await this.findLocalVersion(version)

      if (this.alreadyOnVersion(current, localVersion || null)) {
        CliUx.ux.action.stop(this.config.scopedEnvVar('HIDE_UPDATED_MESSAGE') ? 'done' : `already on version ${current}`)
      } else if (localVersion) {
        this.updateToExistingVersion(current, localVersion)
      } else {
        const index = await this.fetchVersionIndex()
        const url = index[version]
        if (!url) {
          throw new Error(`${version} not found in index:\n${Object.keys(index).join(', ')}`)
        }

        const manifest = await this.fetchVersionManifest(version, url)
        const updated = manifest.sha ? `${manifest.version}-${manifest.sha}` : manifest.version
        await this.update(manifest, current, updated)
        await this.tidy()
      }

      await this.config.runHook('update', {channel, version})
      CliUx.ux.action.stop()
      CliUx.ux.log()
      CliUx.ux.log(`Updating to a specific version will not update the channel. If autoupdate is enabled, the CLI will eventually be updated back to ${channel}.`)
    } else {
      const manifest = await this.fetchChannelManifest(channel)
      const updated = manifest.sha ? `${manifest.version}-${manifest.sha}` : manifest.version
      await this.config.runHook('preupdate', {channel, version: updated})

      if (!hard && this.alreadyOnVersion(current, updated)) {
        CliUx.ux.action.stop(this.config.scopedEnvVar('HIDE_UPDATED_MESSAGE') ? 'done' : `already on version ${current}`)
      } else {
        await this.update(manifest, current, updated, channel)
        await this.tidy()
      }

      await this.config.runHook('update', {channel, version: updated})
      CliUx.ux.action.stop()
    }

    CliUx.ux.debug('done')
  }

  public async findLocalVersions(): Promise<string[]> {
    await this.ensureClientDir()
    return fs
    .readdirSync(this.clientRoot)
    .filter(dirOrFile => dirOrFile !== 'bin' && dirOrFile !== 'current')
    .map(f => path.join(this.clientRoot, f))
  }

  public async fetchVersionIndex(): Promise<Updater.VersionIndex> {
    CliUx.ux.action.status = 'fetching version index'
    const newIndexUrl = this.config.s3Url(this.s3VersionIndexKey())
    try {
      const {body} = await HTTP.get<Updater.VersionIndex>(newIndexUrl)
      if (typeof body === 'string') {
        return JSON.parse(body)
      }

      return body
    } catch {
      throw new Error(`No version indices exist for ${this.config.name}.`)
    }
  }

  private async ensureClientDir(): Promise<void> {
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

  private composeS3SubDir(): string {
    let s3SubDir = (this.config.pjson.oclif.update.s3 as any).folder || ''
    if (s3SubDir !== '' && s3SubDir.slice(-1) !== '/') s3SubDir = `${s3SubDir}/`
    return s3SubDir
  }

  private s3ChannelManifestKey(channel: string): string {
    const {bin, platform, arch} = this.config
    const s3SubDir = this.composeS3SubDir()
    return path.join(s3SubDir, 'channels', channel, `${bin}-${platform}-${arch}-buildmanifest`)
  }

  private s3VersionManifestKey(version: string, hash: string): string {
    const {bin, platform, arch} = this.config
    const s3SubDir = this.composeS3SubDir()
    return path.join(s3SubDir, 'versions', version, hash, `${bin}-v${version}-${hash}-${platform}-${arch}-buildmanifest`)
  }

  private s3VersionIndexKey(): string {
    const {bin, platform, arch} = this.config
    const s3SubDir = this.composeS3SubDir()
    return path.join(s3SubDir, 'versions', `${bin}-${platform}-${arch}-tar-gz.json`)
  }

  private async fetchChannelManifest(channel: string): Promise<Interfaces.S3Manifest> {
    const s3Key = this.s3ChannelManifestKey(channel)
    try {
      return await this.fetchManifest(s3Key)
    } catch (error: any) {
      if (error.statusCode === 403) throw new Error(`HTTP 403: Invalid channel ${channel}`)
      throw error
    }
  }

  private async fetchVersionManifest(version: string, url: string): Promise<Interfaces.S3Manifest> {
    const parts = url.split('/')
    const hashIndex = parts.indexOf(version) + 1
    const hash = parts[hashIndex]
    const s3Key = this.s3VersionManifestKey(version, hash)
    return this.fetchManifest(s3Key)
  }

  private async fetchManifest(s3Key: string): Promise<Interfaces.S3Manifest> {
    CliUx.ux.action.status = 'fetching manifest'

    const url = this.config.s3Url(s3Key)
    const {body} = await HTTP.get<Interfaces.S3Manifest | string>(url)
    if (typeof body === 'string') {
      return JSON.parse(body)
    }

    return body
  }

  private async downloadAndExtract(output: string, manifest: Interfaces.S3Manifest, channel: string) {
    const {version, gz, sha256gz} = manifest

    const gzUrl = gz || this.config.s3Url(this.config.s3Key('versioned', {
      version,
      channel,
      bin: this.config.bin,
      platform: this.config.platform,
      arch: this.config.arch,
      ext: 'gz',
    }))
    const {response: stream} = await HTTP.stream(gzUrl)
    stream.pause()

    const baseDir = manifest.baseDir || this.config.s3Key('baseDir', {
      version,
      channel,
      bin: this.config.bin,
      platform: this.config.platform,
      arch: this.config.arch,
    })
    const extraction = extract(stream, baseDir, output, sha256gz)

    if (CliUx.ux.action.type === 'spinner') {
      const total = Number.parseInt(stream.headers['content-length']!, 10)
      let current = 0
      const updateStatus = throttle(
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

  private async update(manifest: Interfaces.S3Manifest, current: string, updated: string, channel = 'stable') {
    CliUx.ux.action.start(`${this.config.name}: Updating CLI from ${color.green(current)} to ${color.green(updated)}${channel === 'stable' ? '' : ' (' + color.yellow(channel) + ')'}`)

    await this.ensureClientDir()
    const output = path.join(this.clientRoot, updated)

    if (!await fs.pathExists(output)) {
      await this.downloadAndExtract(output, manifest, channel)
    }

    await this.setChannel(channel)
    await this.createBin(updated)
    await this.touch()
    CliUx.ux.action.stop()
  }

  private async updateToExistingVersion(current: string, updated: string): Promise<void> {
    CliUx.ux.action.start(`${this.config.name}: Updating CLI from ${color.green(current)} to ${color.green(updated)}`)
    await this.createBin(updated)
    await this.touch()
    CliUx.ux.action.stop()
  }

  private notUpdatable(): boolean {
    if (!this.config.binPath) {
      const instructions = this.config.scopedEnvVar('UPDATE_INSTRUCTIONS')
      if (instructions) CliUx.ux.warn(instructions)
      return true
    }

    return false
  }

  private alreadyOnVersion(current: string, updated: string | null): boolean {
    return current === updated
  }

  private async determineChannel(): Promise<string> {
    const channelPath = path.join(this.config.dataDir, 'channel')
    if (fs.existsSync(channelPath)) {
      const channel = await fs.readFile(channelPath, 'utf8')
      return String(channel).trim()
    }

    return this.config.channel || 'stable'
  }

  private async determineCurrentVersion(): Promise<string> {
    try {
      const currentVersion = await fs.readFile(this.clientBin, 'utf8')
      const matches = currentVersion.match(/\.\.[/\\|](.+)[/\\|]bin/)
      return matches ? matches[1] : this.config.version
    } catch (error: any) {
      CliUx.ux.debug(error)
    }

    return this.config.version
  }

  private async findLocalVersion(version: string): Promise<string | undefined> {
    const versions = await this.findLocalVersions()
    return versions
    .map(file => path.basename(file))
    .find(file => file.startsWith(version))
  }

  private async setChannel(channel: string): Promise<void> {
    const channelPath = path.join(this.config.dataDir, 'channel')
    fs.writeFile(channelPath, channel, 'utf8')
  }

  private async logChop(): Promise<void> {
    try {
      CliUx.ux.debug('log chop')
      const logChopper = require('log-chopper').default
      await logChopper.chop(this.config.errlog)
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
    const lastrunfile = path.join(this.config.cacheDir, 'lastrun')
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
    CliUx.ux.debug('tidy')
    try {
      const root = this.clientRoot
      if (!await fs.pathExists(root)) return
      const files = await ls(root)
      const promises = files.map(async (f: any) => {
        if (['bin', 'current', this.config.version].includes(path.basename(f.path))) return
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
      const p = path.join(this.clientRoot, this.config.version)
      CliUx.ux.debug('touching client at', p)
      if (!await fs.pathExists(p)) return
      await fs.utimes(p, new Date(), new Date())
    } catch (error: any) {
      CliUx.ux.warn(error)
    }
  }

  private async createBin(version: string): Promise<void> {
    const dst = this.clientBin
    const {bin, windows} = this.config
    const binPathEnvVar = this.config.scopedEnvVarKey('BINPATH')
    const redirectedEnvVar = this.config.scopedEnvVarKey('REDIRECTED')
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
