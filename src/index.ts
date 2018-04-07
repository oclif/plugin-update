import color from '@heroku-cli/color'
import * as Config from '@oclif/config'
import {cli} from 'cli-ux'
import * as spawn from 'cross-spawn'
import * as dateIsAfter from 'date-fns/is_after'
import * as dateSubDays from 'date-fns/sub_days'
import * as fs from 'fs-extra'
import HTTP from 'http-call'
import * as Lodash from 'lodash'
import * as path from 'path'

import {ls, touch} from './util'

const debug = require('debug')('cli:updater')

export function fetchUpdater(config: Config.IConfig): Updater {
  switch (config.pjson.oclif.autoupdate) {
    case 'github':
      return new (require('./github').GithubUpdater)(config)
    case 's3':
      return new (require('./s3').S3Updater)(config)
  }
  throw new Error('oclif.autoupdate must be set to "github" or "s3"')
}

export abstract class Updater {
  constructor(public config: Config.IConfig) {}

  get channel(): string {
    let pjson = this.config.pjson.oclif as any
    if (pjson.channel) return pjson.channel
    return 'stable'
  }

  get reexecBin(): string | undefined {
    return this.config.scopedEnvVar('CLI_BINPATH')
  }

  private get clientRoot(): string {
    return path.join(this.config.dataDir, 'client')
  }
  private get clientBin(): string {
    let b = path.join(this.clientRoot, 'bin', this.config.bin)
    return this.config.windows ? `${b}.cmd` : b
  }

  async update({version, url, sha256, channel}: {url: string, version: string, sha256?: string, channel?: string}) {
    if (!channel) channel = 'stable'
    cli.action.start(`${this.config.name}: Updating CLI from ${color.green(this.config.version)} to ${color.green(version)}${channel === 'stable' ? '' : ' (' + color.yellow(channel) + ')'}`)
    const _: typeof Lodash = require('lodash')
    const http: typeof HTTP = require('http-call').HTTP
    const filesize = require('filesize')
    const output = path.join(this.clientRoot, version)
    const tmp = path.join(this.clientRoot, this.config.bin)

    let {response: stream} = await http.stream(url)

    await fs.emptyDir(tmp)
    let extraction = this.extract(stream, this.clientRoot, sha256)

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

    await this._createBin(version)
    await this.reexec()
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

  public abstract needsUpdate(channel: string): Promise<boolean>

  protected base(version: string): string {
    return `${this.config.bin}-v${version}-${this.config.platform}-${this.config.arch}`
  }

  private extract(stream: NodeJS.ReadableStream, dir: string, sha?: string): Promise<void> {
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

      if (sha) {
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
      } else {
        shaValidated = true
      }

      let ignore = (_: any, header: any) => {
        switch (header.type) {
          case 'directory':
          case 'file':
            if (process.env.OCLIF_DEBUG_UPDATE_FILES) debug(header.name)
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

  private async reexec() {
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

  private async _createBin(version: string) {
    let dst = this.clientBin
    if (this.config.windows) {
      let body = `@echo off
"%~dp0\\..\\${version}\\bin\\${this.config.bin}.cmd" %*
`
      await fs.outputFile(dst, body)
    } else {
      let body = `#!/usr/bin/env bash
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
HEROKU_CLI_REDIRECTED=1 "$DIR/../${version}/bin/${this.config.bin}" "$@"
`

      await fs.remove(dst)
      await fs.outputFile(dst, body)
      await fs.chmod(dst, 0o755)
    }
  }
}
