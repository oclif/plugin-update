import {Command, Flags, Config, CliUx} from '@oclif/core'
import * as path from 'path'
import UpdateCli from '../update'

async function getPinToVersion(): Promise<string> {
  return CliUx.ux.prompt('Enter a version to update to')
}

export default class UpdateCommand extends Command {
  static description = 'update the <%= config.bin %> CLI'

  static args = [{name: 'channel', optional: true}]

  static flags = {
    autoupdate: Flags.boolean({hidden: true}),
    'from-local': Flags.boolean({description: 'interactively choose an already installed version'}),
  }

  private channel!: string

  private readonly clientRoot = this.config.scopedEnvVar('OCLIF_CLIENT_HOME') || path.join(this.config.dataDir, 'client')

  private readonly clientBin = path.join(this.clientRoot, 'bin', this.config.windows ? `${this.config.bin}.cmd` : this.config.bin)

  async run(): Promise<void> {
    const {args, flags} = await this.parse(UpdateCommand)
    const updateCli = new UpdateCli({channel: args.channel, autoUpdate: flags.autoupdate, fromLocal: flags['from-local'], config: this.config as Config, exit: this.exit, getPinToVersion: getPinToVersion})
    return updateCli.runUpdate()
  }
}
