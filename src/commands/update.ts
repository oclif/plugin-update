import color from '@oclif/color'
import Command, {flags} from '@oclif/command'
import {IManifest} from '@oclif/dev-cli'
import cli from 'cli-ux'
import * as spawn from 'cross-spawn'
import * as fs from 'fs-extra'
import HTTP from 'http-call'
import * as _ from 'lodash'
import * as path from 'path'

import {extract} from '../tar'
import {ls, wait} from '../util'
import UpdateCli from '../update'
import {Config} from '@oclif/config'

async function getPinToVersion(): Promise<string> {
  return cli.prompt('Enter a version to update to')
}

export default class UpdateCommand extends Command {
  static description = 'update the <%= config.bin %> CLI'

  static args = [{name: 'channel', optional: true}]

  static flags: flags.Input<any> = {
    autoupdate: flags.boolean({hidden: true}),
    'from-local': flags.boolean({description: 'interactively choose an already installed version'}),
  }
  async run() {
    const {args, flags} = this.parse(UpdateCommand)
    const updateCli = new UpdateCli({channel: args.channel, autoUpdate: flags.autoupdate, fromLocal: flags['from-local'], config: this.config as Config, exit: this.exit, getPinToVersion: getPinToVersion})
    return updateCli.runUpdate()
  }

}
