/* eslint-disable unicorn/prefer-module */
import {Config, ux, Interfaces} from '@oclif/core'
import {green, yellow} from 'chalk'
import {Stats, existsSync} from 'node:fs'
import {readdir, writeFile, rm, symlink, mkdir, readFile, stat, utimes} from 'node:fs/promises'
import HTTP from 'http-call'
import * as path from 'path'
import throttle from 'lodash.throttle'
import fileSize from 'filesize'

import {extract} from './tar'
import {ls, wait} from './util'

const filesize = (n: number): string => {
  const [num, suffix] = fileSize(n, {output: 'array'})
  return Number.parseFloat(num).toFixed(1) + ` ${suffix}`
}

export namespace Updater {
  export type Options = {
    autoUpdate: boolean;
    channel?: string | undefined;
    version?: string | undefined
    force?: boolean;
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
    const {autoUpdate, version, force = false} = options
    if (autoUpdate) await debounce(this.config.cacheDir)

    ux.action.start(`${this.config.name}: Updating CLI`)

    if (notUpdatable(this.config)) {
      ux.action.stop('not updatable')
      return
    }

    const [channel, current] = await Promise.all([
      options.channel ?? determineChannel({version, config: this.config}),
      determineCurrentVersion(this.clientBin, this.config.version),
    ])

    if (version) {
      const localVersion = force ? null : await this.findLocalVersion(version)

      if (alreadyOnVersion(current, localVersion || null)) {
        ux.action.stop(this.config.scopedEnvVar('HIDE_UPDATED_MESSAGE') ? 'done' : `already on version ${current}`)
        return
      }

      await this.config.runHook('preupdate', {channel, version})

      if (localVersion) {
        await this.updateToExistingVersion(current, localVersion)
      } else {
        const index = await this.fetchVersionIndex()
        const url = index[version]
        if (!url) {
          throw new Error(`${version} not found in index:\n${Object.keys(index).join(', ')}`)
        }

        const manifest = await this.fetchVersionManifest(version, url)
        const updated = manifest.sha ? `${manifest.version}-${manifest.sha}` : manifest.version
        await this.update(manifest, current, updated, force, channel)
      }

      await this.config.runHook('update', {channel, version})
      ux.action.stop()
      ux.log()
      ux.log(`Updating to a specific version will not update the channel. If autoupdate is enabled, the CLI will eventually be updated back to ${channel}.`)
    } else {
      const manifest = await fetchChannelManifest(channel, this.config)
      const updated = manifest.sha ? `${manifest.version}-${manifest.sha}` : manifest.version

      if (!force && alreadyOnVersion(current, updated)) {
        ux.action.stop(this.config.scopedEnvVar('HIDE_UPDATED_MESSAGE') ? 'done' : `already on version ${current}`)
      } else {
        await this.config.runHook('preupdate', {channel, version: updated})
        await this.update(manifest, current, updated, force, channel)
      }

      await this.config.runHook('update', {channel, version: updated})
      ux.action.stop()
    }

    await this.touch()
    await this.tidy()
    ux.debug('done')
  }

  public async findLocalVersions(): Promise<string[]> {
    await ensureClientDir(this.clientRoot)
    return (await readdir(this.clientRoot))
    .filter(dirOrFile => dirOrFile !== 'bin' && dirOrFile !== 'current')
    .map(f => path.join(this.clientRoot, f))
  }

  public async fetchVersionIndex(): Promise<Updater.VersionIndex> {
    ux.action.status = 'fetching version index'
    const newIndexUrl = this.config.s3Url(s3VersionIndexKey(this.config))
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

  private async fetchVersionManifest(version: string, url: string): Promise<Interfaces.S3Manifest> {
    const parts = url.split('/')
    const hashIndex = parts.indexOf(version) + 1
    const hash = parts[hashIndex]
    const s3Key = s3VersionManifestKey({version, hash, config: this.config})
    return fetchManifest(s3Key, this.config)
  }

  // eslint-disable-next-line max-params
  private async update(manifest: Interfaces.S3Manifest, current: string, updated: string, force: boolean, channel: string) {
    ux.action.start(`${this.config.name}: Updating CLI from ${green(current)} to ${green(updated)}${channel === 'stable' ? '' : ' (' + yellow(channel) + ')'}`)

    await ensureClientDir(this.clientRoot)
    const output = path.join(this.clientRoot, updated)

    if (force || !existsSync(output)) await downloadAndExtract(output, manifest, channel, this.config)

    await this.refreshConfig(updated)
    await setChannel(channel, this.config.dataDir)
    await this.createBin(updated)
  }

  private async updateToExistingVersion(current: string, updated: string): Promise<void> {
    ux.action.start(`${this.config.name}: Updating CLI from ${green(current)} to ${green(updated)}`)
    await ensureClientDir(this.clientRoot)
    await this.refreshConfig(updated)
    await this.createBin(updated)
  }

  private async findLocalVersion(version: string): Promise<string | undefined> {
    const versions = await this.findLocalVersions()
    return versions
    .map(file => path.basename(file))
    .find(file => file.startsWith(version))
  }

  // removes any unused CLIs
  private async tidy(): Promise<void> {
    ux.debug('tidy')
    try {
      const root = this.clientRoot
      if (!existsSync(root)) return
      const files = await ls(root)

      const isNotSpecial = (fPath: string, version: string): boolean =>
        !(['bin', 'current', version].includes(path.basename(fPath)))

      const isOld = (fStat: Stats): boolean => {
        const mtime = fStat.mtime
        mtime.setHours(mtime.getHours() + (42 * 24))
        return mtime < new Date()
      }

      await Promise.all(files.filter(
        f => isNotSpecial(this.config.version, f.path) && isOld(f.stat),
      )
      .map(f => rm(f.path, {recursive: true, force: true})))

      await logChop(this.config.errlog)
    } catch (error: any) {
      ux.warn(error)
    }
  }

  private async touch(): Promise<void> {
    // touch the client so it won't be tidied up right away
    try {
      const p = path.join(this.clientRoot, this.config.version)
      ux.debug('touching client at', p)
      if (!existsSync(p)) return
      return utimes(p, new Date(), new Date())
    } catch (error: any) {
      ux.warn(error)
    }
  }

  private async refreshConfig(version: string): Promise<void> {
    this.config = await Config.load({root: path.join(this.clientRoot, version)}) as Config
  }

  private async createBin(version: string): Promise<void> {
    const dst = this.clientBin
    const {bin, windows} = this.config
    const binPathEnvVar = this.config.scopedEnvVarKey('BINPATH')
    const redirectedEnvVar = this.config.scopedEnvVarKey('REDIRECTED')
    await mkdir(path.dirname(dst), {recursive: true})

    if (windows) {
      const body = `@echo off
setlocal enableextensions
set ${redirectedEnvVar}=1
set ${binPathEnvVar}=%~dp0${bin}
"%~dp0..\\${version}\\bin\\${bin}.cmd" %*
`
      await writeFile(dst, body)
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
      await writeFile(dst, body, {mode: 0o755})
      await rm(path.join(this.clientRoot, 'current'), {recursive: true, force: true})
      await symlink(`./${version}`, path.join(this.clientRoot, 'current'))
    }
  }
}

const alreadyOnVersion = (current: string, updated: string | null): boolean =>
  current === updated

const ensureClientDir = async (clientRoot: string): Promise<void> => {
  try {
    await mkdir(clientRoot, {recursive: true})
  } catch (error: any) {
    if (error.code === 'EEXIST') {
      // for some reason the client directory is sometimes a file
      // if so, this happens. Delete it and recreate
      await rm(clientRoot, {recursive: true, force: true})
      await mkdir(clientRoot, {recursive: true})
    } else {
      throw error
    }
  }
}

const mtime = async (f: string): Promise<Date> =>  (await stat(f)).mtime

const notUpdatable = (config: Config): boolean => {
  if (!config.binPath) {
    const instructions = config.scopedEnvVar('UPDATE_INSTRUCTIONS')
    if (instructions) ux.warn(instructions)
    return true
  }

  return false
}

const composeS3SubDir = (config: Config): string => {
  let s3SubDir = (config.pjson.oclif.update.s3 as any).folder || ''
  if (s3SubDir !== '' && s3SubDir.slice(-1) !== '/') s3SubDir = `${s3SubDir}/`
  return s3SubDir
}

const fetchManifest = async (s3Key: string, config: Config): Promise<Interfaces.S3Manifest> => {
  ux.action.status = 'fetching manifest'

  const url = config.s3Url(s3Key)
  const {body} = await HTTP.get<Interfaces.S3Manifest | string>(url)
  if (typeof body === 'string') {
    return JSON.parse(body)
  }

  return body
}

const s3VersionIndexKey = (config: Config): string => {
  const {bin, arch} = config
  const s3SubDir = composeS3SubDir(config)
  return path.join(s3SubDir, 'versions', `${bin}-${determinePlatform(config)}-${arch}-tar-gz.json`)
}

const determinePlatform = (config: Config): Interfaces.PlatformTypes => config.platform === 'wsl' ? 'linux' : config.platform

const s3ChannelManifestKey = (channel: string, config: Config): string => {
  const {bin, arch} = config
  const s3SubDir = composeS3SubDir(config)
  return path.join(s3SubDir, 'channels', channel, `${bin}-${determinePlatform(config)}-${arch}-buildmanifest`)
}

const s3VersionManifestKey = ({version, hash, config}: { version: string; hash: string; config: Config }): string => {
  const {bin, arch} = config
  const s3SubDir = composeS3SubDir(config)
  return path.join(s3SubDir, 'versions', version, hash, `${bin}-v${version}-${hash}-${determinePlatform(config)}-${arch}-buildmanifest`)
}

// when autoupdating, wait until the CLI isn't active
const debounce = async (cacheDir: string): Promise<void> => {
  let output = false
  const lastrunfile = path.join(cacheDir, 'lastrun')
  const m = await mtime(lastrunfile)
  m.setHours(m.getHours() + 1)
  if (m > new Date()) {
    const msg = `waiting until ${m.toISOString()} to update`
    if (output) {
      ux.debug(msg)
    } else {
      ux.log(msg)
      output = true
    }

    await wait(60 * 1000) // wait 1 minute
    return debounce(cacheDir)
  }

  ux.log('time to update')
}

const  setChannel = async (channel: string, dataDir:string): Promise<void> =>
  writeFile(path.join(dataDir, 'channel'), channel, 'utf8')

const  fetchChannelManifest = async (channel: string, config: Config): Promise<Interfaces.S3Manifest> => {
  const s3Key = s3ChannelManifestKey(channel, config)
  try {
    return await fetchManifest(s3Key, config)
  } catch (error: any) {
    if (error.statusCode === 403) throw new Error(`HTTP 403: Invalid channel ${channel}`)
    throw error
  }
}

const downloadAndExtract = async (output: string, manifest: Interfaces.S3Manifest, channel: string, config: Config): Promise<void> => {
  const {version, gz, sha256gz} = manifest

  const gzUrl = gz ?? config.s3Url(config.s3Key('versioned', {
    version,
    channel,
    bin: config.bin,
    platform: determinePlatform(config),
    arch: config.arch,
    ext: 'gz',
  }))
  const {response: stream} = await HTTP.stream(gzUrl)
  stream.pause()

  const baseDir = manifest.baseDir ?? config.s3Key('baseDir', {
    version,
    channel,
    bin: config.bin,
    platform: determinePlatform(config),
    arch: config.arch,
  })
  const extraction = extract(stream, baseDir, output, sha256gz)

  if (ux.action.type === 'spinner') {
    const total = Number.parseInt(stream.headers['content-length']!, 10)
    let current = 0
    const updateStatus = throttle(
      (newStatus: string) => {
        ux.action.status = newStatus
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

const determineChannel = async ({version, config}: { version?: string; config: Config }): Promise<string> => {
  const channelPath = path.join(config.dataDir, 'channel')

  const channel = existsSync(channelPath) ? (await readFile(channelPath, 'utf8')).trim() : 'stable'

  try {
    const {body} = await HTTP.get<{'dist-tags':Record<string, string>}>(`${config.npmRegistry ?? 'https://registry.npmjs.org'}/${config.pjson.name}`)
    const tags = body['dist-tags']
    const tag = Object.keys(tags).find(v => tags[v] === version) ?? channel
    // convert from npm style tag defaults to OCLIF style
    if (tag === 'latest') return 'stable'
    if (tag === 'latest-rc') return 'stable-rc'
    return tag
  } catch {
    return channel
  }
}

const determineCurrentVersion = async (clientBin: string, version:string): Promise<string> => {
  try {
    const currentVersion = await readFile(clientBin, 'utf8')
    const matches = currentVersion.match(/\.\.[/\\|](.+)[/\\|]bin/)
    return matches ? matches[1] : version
  } catch (error: any) {
    ux.debug(error)
  }

  return version
}

const logChop = async (errlogPath:string): Promise<void> => {
  try {
    ux.debug('log chop')
    const logChopper = require('log-chopper').default
    await logChopper.chop(errlogPath)
  } catch (error: any) {
    ux.debug(error.message)
  }
}
