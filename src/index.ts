import * as Config from '@oclif/config'
import {cli} from 'cli-ux'
import * as spawn from 'cross-spawn'
import * as dateIsAfter from 'date-fns/is_after'
import * as dateSubDays from 'date-fns/sub_days'
import * as dateSubHours from 'date-fns/sub_hours'
import * as fs from 'fs-extra'
import HTTP from 'http-call'
import * as Lodash from 'lodash'
import * as path from 'path'

import {ls, minorVersionGreater, touch} from './util'

const debug = require('debug')('cli:updater')

export interface IVersion {
  version: string
  channel: string
  message?: string
}

export interface IManifest {
  version: string
  channel: string
  sha256gz: string
  priority?: number
}

async function mtime(f: string) {
  const {mtime} = await fs.stat(f)
  return mtime
}

function timestamp(msg: string): string {
  return `[${new Date().toISOString()}] ${msg}`
}

export class Updater {
  constructor(public config: Config.IConfig) {
    this.config = config
  }

  get channel(): string {
    let pjson = this.config.pjson.oclif as any
    if (pjson.channel) return pjson.channel
    return 'stable'
  }

  get reexecBin(): string | undefined {
    return this.config.scopedEnvVar('CLI_BINPATH')
  }

  get name(): string {
    return this.config.name === '@oclif/plugin-update' ? 'heroku-cli' : this.config.name
  }

  get autoupdatefile(): string {
    return path.join(this.config.cacheDir, 'autoupdate')
  }
  get autoupdatelogfile(): string {
    return path.join(this.config.cacheDir, 'autoupdate.log')
  }
  get versionFile(): string {
    return path.join(this.config.cacheDir, `${this.channel}.version`)
  }
  get lastrunfile(): string {
    return path.join(this.config.cacheDir, 'lastrun')
  }

  private get clientRoot(): string {
    return path.join(this.config.dataDir, 'client')
  }
  private get clientBin(): string {
    let b = path.join(this.clientRoot, 'bin', this.config.bin)
    return this.config.windows ? `${b}.cmd` : b
  }

  private get binPath(): string {
    return this.reexecBin || this.config.bin
  }

  private get s3Host(): string | undefined {
    const pjson = this.config.pjson.oclif as any
    return (pjson.s3 && pjson.s3.host) || this.config.scopedEnvVar('S3_HOST')
  }

  s3url(channel: string, p: string): string {
    if (!this.s3Host) throw new Error('S3 host not defined')
    return `https://${this.s3Host}/${this.name}/channels/${channel}/${p}`
  }

  async fetchManifest(channel: string): Promise<IManifest> {
    const http: typeof HTTP = require('http-call').HTTP
    try {
      let {body} = await http.get(this.s3url(channel, `${this.config.platform}-${this.config.arch}`))
      return body
    } catch (err) {
      if (err.statusCode === 403) throw new Error(`HTTP 403: Invalid channel ${channel}`)
      throw err
    }
  }

  async fetchVersion(download: boolean): Promise<IVersion> {
    const http: typeof HTTP = require('http-call').HTTP
    let v: IVersion | undefined
    try {
      if (!download) v = await fs.readJSON(this.versionFile)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    if (!v) {
      debug('fetching latest %s version', this.channel)
      let {body} = await http.get(this.s3url(this.channel, 'version'))
      v = body
      await this._catch(() => fs.outputJSON(this.versionFile, v))
    }
    return v!
  }

  public async warnIfUpdateAvailable() {
    await this._catch(async () => {
      if (!this.s3Host) return
      let v = await this.fetchVersion(false)
      if (minorVersionGreater(this.config.version, v.version)) {
        cli.warn(`${this.name}: update available from ${this.config.version} to ${v.version}`)
      }
      if (v.message) {
        cli.warn(`${this.name}: ${v.message}`)
      }
    })
  }

  public async autoupdate(force: boolean = false) {
    try {
      await touch(this.lastrunfile)
      const clientDir = path.join(this.clientRoot, this.config.version)
      if (await fs.pathExists(clientDir)) {
        await touch(clientDir)
      }
      await this.warnIfUpdateAvailable()
      if (!force && !await this.autoupdateNeeded()) return

      debug('autoupdate running')
      await fs.outputFile(this.autoupdatefile, '')

      debug(`spawning autoupdate on ${this.binPath}`)

      let fd = await fs.open(this.autoupdatelogfile, 'a')
      // @ts-ignore
      fs.write(
        fd,
        timestamp(`starting \`${this.binPath} update --autoupdate\` from ${process.argv.slice(1, 3).join(' ')}\n`),
      )

      spawn(this.binPath, ['update', '--autoupdate'], {
        detached: !this.config.windows,
        stdio: ['ignore', fd, fd],
        env: this.autoupdateEnv,
      })
        .on('error', (e: Error) => process.emitWarning(e))
        .unref()
    } catch (e) {
      process.emitWarning(e)
    }
  }

  async update(manifest: IManifest) {
    const _: typeof Lodash = require('lodash')
    const http: typeof HTTP = require('http-call').HTTP
    const filesize = require('filesize')
    let base = this.base(manifest)
    const output = path.join(this.clientRoot, manifest.version)
    const tmp = path.join(this.clientRoot, base)

    if (!this.s3Host) throw new Error('S3 host not defined')

    let url = `https://${this.s3Host}/${this.name}/channels/${manifest.channel}/${base}.tar.gz`
    let {response: stream} = await http.stream(url)

    await fs.emptyDir(tmp)
    let extraction = this.extract(stream, this.clientRoot, manifest.sha256gz)

    // TODO: use cli.action.type
    if ((cli.action as any).frames) {
      // if spinner action
      let total = stream.headers['content-length']
      let current = 0
      const updateStatus = _.throttle(
        (newStatus: string) => {
          cli.action.status = newStatus
        },
        500,
        {leading: true, trailing: false},
      )
      stream.on('data', data => {
        current += data.length
        updateStatus(`${filesize(current)}/${filesize(total)}`)
      })
    }

    await extraction
    if (await fs.pathExists(output)) {
      const old = `${output}.old`
      await fs.remove(old)
      await fs.rename(output, old)
    }
    await fs.rename(tmp, output)
    await touch(output)

    await this._createBin(manifest)
    await this.reexecUpdate()
  }

  public async tidy() {
    try {
      if (!this.reexecBin) return
      if (!this.reexecBin.includes(this.config.version)) return
      let root = this.clientRoot
      if (!await fs.pathExists(root)) return
      let files = await ls(root)
      let promises = files.map(async f => {
        if (['bin', this.config.version].includes(path.basename(f.path))) return
        if (dateIsAfter(f.stat.mtime, dateSubDays(new Date(), 7))) {
          await fs.remove(f.path)
        }
      })
      for (let p of promises) await p
    } catch (err) {
      cli.warn(err)
    }
  }

  private extract(stream: NodeJS.ReadableStream, dir: string, sha: string): Promise<void> {
    const zlib = require('zlib')
    const tar = require('tar-fs')
    const crypto = require('crypto')

    return new Promise((resolve, reject) => {
      let shaValidated = false
      let extracted = false

      let check = () => {
        if (shaValidated && extracted) {
          resolve()
        }
      }

      let fail = (err: Error) => {
        fs.remove(dir)
        .then(() => reject(err))
        .catch(reject)
      }

      let hasher = crypto.createHash('sha256')
      stream.on('error', fail)
      stream.on('data', d => hasher.update(d))
      stream.on('end', () => {
        let shasum = hasher.digest('hex')
        if (sha === shasum) {
          shaValidated = true
          check()
        } else {
          reject(new Error(`SHA mismatch: expected ${shasum} to be ${sha}`))
        }
      })

      let ignore = (_: any, header: any) => {
        switch (header.type) {
          case 'directory':
          case 'file':
            if (process.env.CLI_ENGINE_DEBUG_UPDATE_FILES) debug(header.name)
            return false
          case 'symlink':
            return true
          default:
            throw new Error(header.type)
        }
      }
      let extract = tar.extract(dir, {ignore})
      extract.on('error', fail)
      extract.on('finish', () => {
        extracted = true
        check()
      })

      let gunzip = zlib.createGunzip()
      gunzip.on('error', fail)

      stream.pipe(gunzip).pipe(extract)
    })
  }

  private base(manifest: IManifest): string {
    return `${this.name}-v${manifest.version}-${this.config.platform}-${this.config.arch}`
  }

  private async autoupdateNeeded(): Promise<boolean> {
    try {
      const m = await mtime(this.autoupdatefile)
      return dateIsAfter(m, dateSubHours(new Date(), 5))
    } catch (err) {
      if (err.code !== 'ENOENT') cli.error(err.stack)
      if ((global as any).testing) return false
      debug('autoupdate ENOENT')
      return true
    }
  }

  get timestampEnvVar(): string {
    // TODO: use function from @cli-engine/config
    let bin = this.config.bin.replace('-', '_').toUpperCase()
    return `${bin}_TIMESTAMPS`
  }

  get skipAnalyticsEnvVar(): string {
    let bin = this.config.bin.replace('-', '_').toUpperCase()
    return `${bin}_SKIP_ANALYTICS`
  }

  get autoupdateEnv(): { [k: string]: string | undefined } {
    return {...process.env,
      [this.timestampEnvVar]: '1',
      [this.skipAnalyticsEnvVar]: '1'}
  }

  private async reexecUpdate() {
    cli.action.stop()
    return new Promise((_, reject) => {
      debug('restarting CLI after update', this.clientBin)
      spawn(this.clientBin, ['update'], {
        stdio: 'inherit',
        env: {...process.env, CLI_ENGINE_HIDE_UPDATED_MESSAGE: '1'},
      })
        .on('error', reject)
        .on('close', (status: number) => {
          try {
            cli.exit(status)
          } catch (err) {
            reject(err)
          }
        })
    })
  }

  private async _createBin(manifest: IManifest) {
    let dst = this.clientBin
    if (this.config.windows) {
      let body = `@echo off
"%~dp0\\..\\${manifest.version}\\bin\\${this.config.bin}.cmd" %*
`
      await fs.outputFile(dst, body)
      return
    }

    let src = path.join('..', manifest.version, 'bin', this.config.bin)
    await fs.mkdirp(path.dirname(dst))
    await fs.remove(dst)
    await fs.symlink(src, dst)
  }

  private async _catch(fn: () => {}) {
    try {
      return await Promise.resolve(fn())
    } catch (err) {
      debug(err)
    }
  }
}
