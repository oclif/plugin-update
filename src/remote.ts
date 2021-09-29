import * as path from 'path'

import cli from 'cli-ux'
import * as spawn from 'cross-spawn'
import * as fs from 'fs-extra'

import color from '@oclif/color'
import {IManifest} from '@oclif/dev-cli'

import Updater from './updater'
import {ls} from './util'

export default abstract class RemoteUpdater extends Updater {
  private currentVersion?: string

  private updatedVersion!: string

  protected abstract fetchManifest(): Promise<IManifest>

  protected abstract downloadAndExtract(output: string, manifest: IManifest, channel: string): void

  async update() {
    this.start()

    await this.config.runHook('preupdate', {channel: this.channel})

    const manifest = await this.fetchManifest()
    this.currentVersion = await this.determineCurrentVersion()
    this.updatedVersion = (manifest as any).sha ? `${manifest.version}-${(manifest as any).sha}` : manifest.version

    const reason = await this.skipUpdate()
    if (reason) cli.action.stop(reason || 'done')
    else await this.installUpdate(manifest)

    this.debug('tidy')
    await this.tidy()

    await this.config.runHook('update', {channel: this.channel})

    this.stop()
  }

  private async installUpdate(manifest: IManifest, channel = 'stable') {
    const {channel: manifestChannel} = manifest
    if (manifestChannel) channel = manifestChannel
    cli.action.start(`${this.config.name}: Updating CLI from ${color.green(this.currentVersion)} to ${color.green(this.updatedVersion)}${channel === 'stable' ? '' : ' (' + color.yellow(channel) + ')'}`)

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

  private async logChop() {
    try {
      this.debug('log chop')
      const logChopper = require('log-chopper').default
      await logChopper.chop(this.config.errlog)
    } catch (error) {
      this.debug(error.message)
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

  private async setChannel() {
    const channelPath = path.join(this.config.dataDir, 'channel')
    fs.writeFile(channelPath, this.channel, 'utf8')
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

  // removes any unused CLIs
  private async tidy() {
    try {
      const root = this.clientRoot
      if (!await fs.pathExists(root)) return
      const files = await ls(root)
      const promises = files.map(async f => {
        if (['bin', 'current', this.config.version].includes(path.basename(f.path))) return
        const mtime = f.stat.mtime
        mtime.setHours(mtime.getHours() + (42 * 24))
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
}
