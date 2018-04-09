import color from '@heroku-cli/color'
import Command, {flags} from '@oclif/command'
import {ITargetManifest} from '@oclif/dev-cli'
import cli from 'cli-ux'
import * as spawn from 'cross-spawn'
import * as fs from 'fs-extra'
import HTTP from 'http-call'
import * as _ from 'lodash'
import * as path from 'path'
import {URL} from 'url'

import {extract} from '../tar'
import {ls, wait} from '../util'

export default class UpdateCommand extends Command {
  static description = 'update the <%= config.bin %> CLI'
  static args = [{name: 'channel', optional: true}]
  static flags = {
    autoupdate: flags.boolean({hidden: true}),
  }

  private autoupdate!: boolean
  private channel!: string
  private readonly clientRoot = path.join(this.config.dataDir, 'client')
  private readonly clientBin = path.join(this.clientRoot, 'bin', this.config.windows ? `${this.config.bin}.cmd` : this.config.bin)
  private readonly s3Host = this.config.pjson.oclif.update.s3.host

  async run() {
    const {args, flags} = this.parse(UpdateCommand)
    this.autoupdate = !!flags.autoupdate

    if (this.autoupdate) await this.debounce()

    cli.action.start(`${this.config.name}: Updating CLI`)
    this.channel = args.channel || this.config.channel || 'stable'
    const manifest = await this.fetchManifest()
    let reason = await this.skipUpdate()
    if (reason) cli.action.stop(reason || 'done')
    else await this.update(manifest)
    this.debug('tidy')
    await this.tidy()
    await this.config.runHook('update', {channel: this.channel})
    this.debug('done')
    cli.action.stop()
  }

  private async fetchManifest(): Promise<ITargetManifest> {
    if (!this.s3Host) throw new Error('S3 host not defined')
    const http: typeof HTTP = require('http-call').HTTP
    try {
      const key = _.template(this.config.pjson.oclif.update.s3.templates.platformManifest)({...this.config, channel: this.channel})
      const url = new URL(this.s3Host)
      url.pathname = path.join(url.pathname, key)
      let {body} = await http.get(url.toString())
      return body
    } catch (err) {
      if (err.statusCode === 403) throw new Error(`HTTP 403: Invalid channel ${this.channel}`)
      throw err
    }
  }

  private async update(manifest: ITargetManifest) {
    const {version, channel} = manifest
    cli.action.start(`${this.config.name}: Updating CLI from ${color.green(this.config.version)} to ${color.green(version)}${channel === 'stable' ? '' : ' (' + color.yellow(channel) + ')'}`)
    const http: typeof HTTP = require('http-call').HTTP
    const filesize = require('filesize')
    const output = path.join(this.clientRoot, version)

    const {response: stream} = await http.stream(manifest.gz)

    let extraction = extract(stream, manifest.baseDir, output, manifest.sha256gz)

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

    await this.createBin(version)
    await this.reexec()
  }

  private async skipUpdate(): Promise<string | false> {
    if (!this.config.binPath) return 'not updatable'
    if (this.autoupdate && this.config.scopedEnvVar('DISABLE_AUTOUPDATE') === '1') return 'autoupdates disabled'
    const manifest = await this.fetchManifest()
    if (this.config.version === manifest.version) {
      if (this.config.scopedEnvVar('HIDE_UPDATED_MESSAGE')) return 'done'
      return `already on latest version: ${this.config.version}`
    }
    return false
  }

  private async logChop() {
    try {
      this.debug('log chop')
      const logChopper = require('log-chopper').default
      await logChopper.chop(this.config.errlog)
    } catch (e) {
      this.debug(e.message)
    }
  }

  private async mtime(f: string) {
    const {mtime} = await fs.stat(f)
    return mtime
  }

  // when autoupdating, wait until the CLI isn't active
  private async debounce(): Promise<void> {
    const lastrunfile = path.join(this.config.cacheDir, 'lastrun')
    const m = await this.mtime(lastrunfile)
    m.setHours(m.getHours() + 1)
    if (m < new Date()) {
      await cli.log(`waiting until ${m.toISOString()} to update`)
      await wait(60 * 1000) // wait 1 minute
      return this.debounce()
    }
    cli.log('time to update')
  }

  // removes any unused CLIs
  private async tidy() {
    try {
      if (!this.config.binPath) return
      if (!this.config.binPath.includes(this.config.version)) return
      let root = this.clientRoot
      if (!await fs.pathExists(root)) return
      let files = await ls(root)
      let promises = files.map(async f => {
        if (['bin', this.config.version].includes(path.basename(f.path))) return
        const mtime = f.stat.mtime
        mtime.setHours(mtime.getHours() + 7 * 24)
        if (mtime < new Date()) {
          await fs.remove(f.path)
        }
      })
      for (let p of promises) await p
      await this.logChop()
    } catch (err) {
      cli.warn(err)
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
            this.exit(status)
          } catch (err) {
            reject(err)
          }
        })
    })
  }

  private async createBin(version: string) {
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
