import Command, {flags} from '@oclif/command'
import cli from 'cli-ux'
import * as path from 'path'

import UpdateCli from '../update'
import {Options} from 'cli-ux/lib/action/base'
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

  private readonly clientRoot = this.config.scopedEnvVar('OCLIF_CLIENT_HOME') || path.join(this.config.dataDir, 'client')

  async run(): Promise<void> {
    const {args, flags} = await this.parse(UpdateCommand)
    const updatePlugin = new UpdateCli({args, flags, config: this.config as Config, exit: this.exit, getPinToVersion: getPinToVersion})
    updatePlugin
    .on('debug', (...args: any) => {
      this.debug(...args)
    })
    .on('warn', (input: string | Error) => {
      this.warn(input)
    })
    .on('log', (...args: any) => {
      this.log(...args)
    })
    .on('action.start', (action: string, status?: string | undefined, opts?: Options) => {
      cli.action.start(action, status, opts)
    })
    .on('action.stop', (msg?: string | undefined) => {
      cli.action.stop(msg)
    })
    .on('action.status', (status: string | undefined) => {
      cli.action.status = status
    })
    return updatePlugin.runUpdate()
  }
}
