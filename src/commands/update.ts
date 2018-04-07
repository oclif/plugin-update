import {color} from '@heroku-cli/color'
import Command, {flags} from '@oclif/command'
import cli from 'cli-ux'
import * as dateAddHours from 'date-fns/add_hours'
import * as dateIsAfter from 'date-fns/is_after'
import * as fs from 'fs-extra'
import * as path from 'path'

import {IManifest, Updater} from '..'
import {wait} from '../util'

export default class UpdateCommand extends Command {
  static description = 'update the <%= config.bin %> CLI'
  static args = [{name: 'channel', optional: true}]
  static flags = {
    autoupdate: flags.boolean({hidden: true}),
  }

  updater = new Updater(this.config)
  autoupdate!: boolean

  async run() {
    const {args, flags} = this.parse(UpdateCommand)
    this.autoupdate = !!flags.autoupdate

    if (flags.autoupdate) {
      await this.debounce()
    } else {
      // on manual run, also log to file
      cli.config.errlog = path.join(this.config.cacheDir, 'autoupdate')
    }

    // if (this.config.updateDisabled) {
    //   // cli.warn(this.config.updateDisabled)
    // } else {
    cli.action.start(`${this.config.name}: Updating CLI`)
    let channel = args.channel || this.updater.channel
    let manifest = await this.updater.fetchManifest(channel)
    if (this.config.version === manifest.version && channel === this.updater.channel) {
      if (!process.env.OCLIF_HIDE_UPDATED_MESSAGE) {
        cli.action.stop(`already on latest version: ${this.config.version}`)
      }
    } else if (this.shouldUpdate(manifest)) {
      cli.action.start(
        `${this.config.name}: Updating CLI from ${color.green(this.config.version)} to ${color.green(
          manifest.version,
        )}${channel === 'stable' ? '' : ' (' + color.yellow(channel) + ')'}`,
      )
      await this.updater.update(manifest)
    }
    // }
    this.debug('fetch version')
    await this.updater.fetchVersion(true)
    this.debug('plugins update')
    // await PluginsUpdate.run([], this.config)
    this.debug('log chop')
    await this.logChop()
    this.debug('tidy')
    await this.updater.tidy()
    // const hooks = new Hooks(this.config)
    await this.config.runHook('update', {channel})
    this.debug('done')
    cli.action.stop()
  }

  async logChop() {
    try {
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

  private shouldUpdate(manifest: IManifest): boolean {
    try {
      const chance = Math.random() * 100
      if (this.autoupdate && manifest.priority && chance < manifest.priority) {
        cli.log(`skipping update. priority is ${manifest.priority} but chance is ${chance}`)
        return false
      }
    } catch (err) {
      cli.warn(err)
    }
    return true
  }

  private async debounce(): Promise<void> {
    const m = await this.mtime(this.updater.lastrunfile)
    const waitUntil = dateAddHours(m, 1)
    if (dateIsAfter(waitUntil, new Date())) {
      await cli.log(`waiting until ${waitUntil.toISOString()} to update`)
      await wait(60 * 1000) // wait 1 minute
      return this.debounce()
    }
    cli.log('time to update')
  }
}
