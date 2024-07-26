import {Config, Interfaces, ux} from '@oclif/core'
import {green, yellow} from 'ansis'
import makeDebug from 'debug'
import fileSize from 'filesize'
import {HTTPError, got} from 'got'
import {Stats, existsSync} from 'node:fs'
import {mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile} from 'node:fs/promises'
import {basename, dirname, join} from 'node:path'
import {ProxyAgent} from 'proxy-agent'

import {Extractor} from './tar.js'
import {ls, wait} from './util.js'

const debug = makeDebug('oclif:update')

const filesize = (n: number): string => {
  const [num, suffix] = fileSize(n, {output: 'array'})
  return Number.parseFloat(num).toFixed(1) + ` ${suffix}`
}

async function httpGet<T>(url: string) {
  debug(`[${url}] GET`)
  return got
    .get<T>(url, {
      agent: {https: new ProxyAgent()},
    })
    .then((res) => {
      debug(`[${url}] ${res.statusCode}`)
      return res
    })
    .catch((error) => {
      debug(`[${url}] ${error.response?.statusCode ?? error.code}`)
      // constructing a new HTTPError here will produce a more actionable stack trace
      debug(new HTTPError(error.response))
      throw error
    })
}

type Options = {
  autoUpdate: boolean
  channel?: string | undefined
  force?: boolean
  version?: string | undefined
}

type VersionIndex = Record<string, string>

export class Updater {
  private readonly clientBin: string
  private readonly clientRoot: string

  constructor(private config: Config) {
    this.clientRoot = config.scopedEnvVar('OCLIF_CLIENT_HOME') ?? join(config.dataDir, 'client')
    this.clientBin = join(this.clientRoot, 'bin', config.windows ? `${config.bin}.cmd` : config.bin)
  }

  public async fetchVersionIndex(): Promise<VersionIndex> {
    const newIndexUrl = this.config.s3Url(s3VersionIndexKey(this.config))
    try {
      const {body} = await httpGet<VersionIndex>(newIndexUrl)
      return typeof body === 'string' ? JSON.parse(body) : body
    } catch {
      throw new Error(`No version indices exist for ${this.config.name}.`)
    }
  }

  public async findLocalVersions(): Promise<string[]> {
    await ensureClientDir(this.clientRoot)
    const dirOrFiles = await readdir(this.clientRoot)
    return dirOrFiles
      .filter((dirOrFile) => dirOrFile !== 'bin' && dirOrFile !== 'current')
      .map((f) => join(this.clientRoot, f))
  }

  public async runUpdate(options: Options): Promise<void> {
    const {autoUpdate, force = false, version} = options
    if (autoUpdate) await debounce(this.config.cacheDir)

    ux.action.start(`${this.config.name}: Updating CLI`)

    if (notUpdatable(this.config)) {
      ux.action.stop('not updatable')
      return
    }

    const [channel, current] = await Promise.all([
      options.channel ?? determineChannel({config: this.config, version}),
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
        ux.action.status = 'fetching version index'
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
      ux.stdout()
      ux.stdout(
        `Updating to a specific version will not update the channel. If autoupdate is enabled, the CLI will eventually be updated back to ${channel}.`,
      )
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
    debug('done')
  }

  private async createBin(version: string): Promise<void> {
    const dst = this.clientBin
    const {bin, windows} = this.config
    const binPathEnvVar = this.config.scopedEnvVarKey('BINPATH')
    const redirectedEnvVar = this.config.scopedEnvVarKey('REDIRECTED')
    await mkdir(dirname(dst), {recursive: true})

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
      await rm(join(this.clientRoot, 'current'), {force: true, recursive: true})
      await symlink(`./${version}`, join(this.clientRoot, 'current'))
    }
  }

  private async fetchVersionManifest(version: string, url: string): Promise<Interfaces.S3Manifest> {
    const parts = url.split('/')
    const hashIndex = parts.indexOf(version) + 1
    const hash = parts[hashIndex]
    const s3Key = s3VersionManifestKey({config: this.config, hash, version})
    return fetchManifest(s3Key, this.config)
  }

  private async findLocalVersion(version: string): Promise<string | undefined> {
    const versions = await this.findLocalVersions()
    return versions.map((file) => basename(file)).find((file) => file.startsWith(version))
  }

  private async refreshConfig(version: string): Promise<void> {
    this.config = (await Config.load({root: join(this.clientRoot, version)})) as Config
  }

  // removes any unused CLIs
  private async tidy(): Promise<void> {
    debug('tidy')
    try {
      const root = this.clientRoot
      if (!existsSync(root)) return
      const files = await ls(root)

      const isNotSpecial = (fPath: string, version: string): boolean =>
        !['bin', 'current', version].includes(basename(fPath))

      const isOld = (fStat: Stats): boolean => {
        const {mtime} = fStat
        mtime.setHours(mtime.getHours() + 42 * 24)
        return mtime < new Date()
      }

      await Promise.all(
        files
          .filter((f) => isNotSpecial(this.config.version, f.path) && isOld(f.stat))
          .map((f) => rm(f.path, {force: true, recursive: true})),
      )
    } catch (error: unknown) {
      ux.warn(error as Error | string)
    }
  }

  private async touch(): Promise<void> {
    // touch the client so it won't be tidied up right away
    try {
      const p = join(this.clientRoot, this.config.version)
      debug('touching client at', p)
      if (!existsSync(p)) return
      return utimes(p, new Date(), new Date())
    } catch (error: unknown) {
      ux.warn(error as Error | string)
    }
  }

  // eslint-disable-next-line max-params
  private async update(
    manifest: Interfaces.S3Manifest,
    current: string,
    updated: string,
    force: boolean,
    channel: string,
  ) {
    ux.action.start(
      `${this.config.name}: Updating CLI from ${green(current)} to ${green(updated)}${
        channel === 'stable' ? '' : ' (' + yellow(channel) + ')'
      }`,
    )

    await ensureClientDir(this.clientRoot)
    const output = join(this.clientRoot, updated)

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
}

const alreadyOnVersion = (current: string, updated: null | string): boolean => current === updated

const ensureClientDir = async (clientRoot: string): Promise<void> => {
  try {
    await mkdir(clientRoot, {recursive: true})
  } catch (error: unknown) {
    const {code} = error as {code: string}
    if (code === 'EEXIST') {
      // for some reason the client directory is sometimes a file
      // if so, this happens. Delete it and recreate
      await rm(clientRoot, {force: true, recursive: true})
      await mkdir(clientRoot, {recursive: true})
    } else {
      throw error
    }
  }
}

const mtime = async (f: string): Promise<Date> => (await stat(f)).mtime

const notUpdatable = (config: Config): boolean => {
  if (!config.binPath) {
    const instructions = config.scopedEnvVar('UPDATE_INSTRUCTIONS')
    if (instructions) {
      ux.warn(instructions)
      // once the spinner stops, it'll eat this blank line
      // https://github.com/oclif/core/issues/799
      ux.stdout()
    }

    return true
  }

  return false
}

const composeS3SubDir = (config: Config): string => {
  let s3SubDir = config.pjson.oclif.update?.s3?.folder || ''
  if (s3SubDir !== '' && s3SubDir.slice(-1) !== '/') s3SubDir = `${s3SubDir}/`
  return s3SubDir
}

const fetchManifest = async (s3Key: string, config: Config): Promise<Interfaces.S3Manifest> => {
  ux.action.status = 'fetching manifest'

  const url = config.s3Url(s3Key)
  const {body} = await httpGet<Interfaces.S3Manifest | string>(url)
  if (typeof body === 'string') {
    return JSON.parse(body)
  }

  return body
}

const s3VersionIndexKey = (config: Config): string => {
  const {arch, bin} = config
  const s3SubDir = composeS3SubDir(config)
  return join(s3SubDir, 'versions', `${bin}-${determinePlatform(config)}-${arch}-tar-gz.json`)
}

const determinePlatform = (config: Config): Interfaces.PlatformTypes =>
  config.platform === 'wsl' ? 'linux' : config.platform

const s3ChannelManifestKey = (channel: string, config: Config): string => {
  const {arch, bin} = config
  const s3SubDir = composeS3SubDir(config)
  return join(s3SubDir, 'channels', channel, `${bin}-${determinePlatform(config)}-${arch}-buildmanifest`)
}

const s3VersionManifestKey = ({config, hash, version}: {config: Config; hash: string; version: string}): string => {
  const {arch, bin} = config
  const s3SubDir = composeS3SubDir(config)
  return join(
    s3SubDir,
    'versions',
    version,
    hash,
    `${bin}-v${version}-${hash}-${determinePlatform(config)}-${arch}-buildmanifest`,
  )
}

// when autoupdating, wait until the CLI isn't active
const debounce = async (cacheDir: string): Promise<void> => {
  let output = false
  const lastrunfile = join(cacheDir, 'lastrun')
  const m = await mtime(lastrunfile)
  m.setHours(m.getHours() + 1)
  if (m > new Date()) {
    const msg = `waiting until ${m.toISOString()} to update`
    if (output) {
      debug(msg)
    } else {
      ux.stdout(msg)
      output = true
    }

    await wait(60 * 1000) // wait 1 minute
    return debounce(cacheDir)
  }

  ux.stdout('time to update')
}

const setChannel = async (channel: string, dataDir: string): Promise<void> =>
  writeFile(join(dataDir, 'channel'), channel, 'utf8')

const fetchChannelManifest = async (channel: string, config: Config): Promise<Interfaces.S3Manifest> => {
  const s3Key = s3ChannelManifestKey(channel, config)
  try {
    return await fetchManifest(s3Key, config)
  } catch (error: unknown) {
    const {code, statusCode} = error as {code?: string; statusCode?: number}
    if (statusCode === 403 || code === 'ERR_NON_2XX_3XX_RESPONSE')
      throw new Error(`HTTP 403: Invalid channel ${channel}`)
    throw error
  }
}

const downloadAndExtract = async (
  output: string,
  manifest: Interfaces.S3Manifest,
  channel: string,
  config: Config,
): Promise<void> => {
  const {gz, sha256gz, version} = manifest

  const gzUrl =
    gz ??
    config.s3Url(
      config.s3Key('versioned', {
        arch: config.arch,
        bin: config.bin,
        channel,
        ext: 'gz',
        platform: determinePlatform(config),
        version,
      }),
    )
  const stream = got.stream(gzUrl)

  stream.pause()

  const baseDir =
    manifest.baseDir ??
    config.s3Key('baseDir', {
      arch: config.arch,
      bin: config.bin,
      channel,
      platform: determinePlatform(config),
      version,
    })
  const extraction = Extractor.extract(stream, baseDir, output, sha256gz)

  if (ux.action.type === 'spinner') {
    stream.on('downloadProgress', (progress) => {
      ux.action.status =
        progress.percent === 1
          ? `${filesize(progress.transferred)}/${filesize(progress.total)} - Finishing up...`
          : `${filesize(progress.transferred)}/${filesize(progress.total)}`
    })
  }

  stream.resume()
  await extraction
}

const determineChannel = async ({config, version}: {config: Config; version?: string}): Promise<string> => {
  ux.action.status = version ? `Determining channel for ${version}` : 'Determining channel'

  const channelPath = join(config.dataDir, 'channel')

  const channel = existsSync(channelPath) ? (await readFile(channelPath, 'utf8')).trim() : 'stable'

  if (config.pjson.oclif.update?.disableNpmLookup ?? false) {
    return channel
  }

  try {
    const {body} = await httpGet<{'dist-tags': Record<string, string>}>(
      `${config.npmRegistry ?? 'https://registry.npmjs.org'}/${config.pjson.name}1`,
    )
    const tags = body['dist-tags']
    const tag = Object.keys(tags).find((v) => tags[v] === version) ?? channel
    // convert from npm style tag defaults to OCLIF style
    if (tag === 'latest') return 'stable'
    if (tag === 'latest-rc') return 'stable-rc'
    return tag
  } catch {
    return channel
  }
}

const determineCurrentVersion = async (clientBin: string, version: string): Promise<string> => {
  try {
    const currentVersion = await readFile(clientBin, 'utf8')
    const matches = currentVersion.match(/\.\.[/\\|](.+)[/\\|]bin/)
    return matches ? matches[1] : version
  } catch (error) {
    if (error instanceof Error) {
      debug(error.name, error.message)
    } else if (typeof error === 'string') {
      debug(error)
    }
  }

  return version
}
