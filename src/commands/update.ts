import Command, {flags} from '@oclif/command'
import cli from 'cli-ux'
import * as dateAddHours from 'date-fns/add_hours'
import * as dateIsAfter from 'date-fns/is_after'
import * as fs from 'fs-extra'
import * as path from 'path'

import {fetchUpdater, Updater} from '..'
import {wait} from '../util'

export default class UpdateCommand extends Command {
  static description = 'update the <%= config.bin %> CLI'
  static args = [{name: 'channel', optional: true}]
  static flags = {
    autoupdate: flags.boolean({hidden: true}),
  }

  updater: Updater = fetchUpdater(this.config)
  autoupdate!: boolean

  async run() {
    const {args, flags} = this.parse(UpdateCommand)
    this.autoupdate = !!flags.autoupdate

    if (this.autoupdate) {
      await this.debounce()
    } else {
      // on manual run, also log to file
      cli.config.errlog = path.join(this.config.cacheDir, 'autoupdate')
    }

    cli.action.start(`${this.config.name}: Updating CLI`)
    let channel = args.channel || this.updater.channel
    if (!await this.updater.needsUpdate(channel)) {
      if (!process.env.OCLIF_HIDE_UPDATED_MESSAGE) {
        cli.action.stop(`already on latest version: ${this.config.version}`)
      }
    } else {
      await this.updater.update({channel} as any)
    }
    this.debug('log chop')
    await this.logChop()
    this.debug('tidy')
    await this.updater.tidy()
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

  private async debounce(): Promise<void> {
    const lastrunfile = path.join(this.config.cacheDir, 'lastrun')
    const m = await this.mtime(lastrunfile)
    const waitUntil = dateAddHours(m, 1)
    if (dateIsAfter(waitUntil, new Date())) {
      await cli.log(`waiting until ${waitUntil.toISOString()} to update`)
      await wait(60 * 1000) // wait 1 minute
      return this.debounce()
    }
    cli.log('time to update')
  }
}
