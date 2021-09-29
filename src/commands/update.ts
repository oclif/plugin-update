import * as path from 'path'

import cli from 'cli-ux'
import * as fs from 'fs-extra'

import Command, {flags} from '@oclif/command'

import LocalUpdater from '../local'
import S3Updater from '../s3'
import Updater from '../updater'
import {wait} from '../util'

export default class UpdateCommand extends Command {
  static description = 'update the <%= config.bin %> CLI'

  static args = [{name: 'channel', optional: true}]

  static flags: flags.Input<any> = {
    autoupdate: flags.boolean({hidden: true}),
    'from-local': flags.boolean({description: 'interactively choose an already installed version'}),
  }

  private autoupdate!: boolean

  channel!: string

  private updater!: Updater

  async run() {
    const {args, flags} = this.parse(UpdateCommand)
    this.autoupdate = Boolean(flags.autoupdate)

    if (this.autoupdate) await this.debounce()

    this.channel = args.channel || await this.determineChannel()

    if (flags['from-local']) {
      this.updater = new LocalUpdater(this, this.debug, this.log, this.warn)
    } else {
      this.updater = new S3Updater(this, this.debug, this.log, this.warn)
    }

    await this.updater.update()
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
        this.debug(msg)
      } else {
        await cli.log(msg)
        output = true
      }
      await wait(60 * 1000) // wait 1 minute
      return this.debounce()
    }
    cli.log('time to update')
  }

  private async determineChannel(): Promise<string> {
    const channelPath = path.join(this.config.dataDir, 'channel')
    if (fs.existsSync(channelPath)) {
      const channel = await fs.readFile(channelPath, 'utf8')
      return String(channel).trim()
    }
    return this.config.channel || 'stable'
  }

  private async mtime(f: string) {
    const {mtime} = await fs.stat(f)
    return mtime
  }
}
