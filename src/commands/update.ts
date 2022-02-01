import {Command, Flags, Config} from '@oclif/core'
import {prompt} from 'inquirer'
import {sort} from 'semver'
import UpdateCli from '../update'

export default class UpdateCommand extends Command {
  static description = 'update the <%= config.bin %> CLI'

  static args = [{name: 'channel', optional: true}]

  static flags = {
    autoupdate: Flags.boolean({hidden: true}),
    'from-local': Flags.boolean({
      description: 'Interactively choose an already installed version. This is ignored if a channel is provided.',
      exclusive: ['version', 'interactive'],
    }),
    version: Flags.string({
      description: 'Install a specific version.',
      exclusive: ['from-local', 'interactive'],
    }),
    interactive: Flags.boolean({
      description: 'Interactively select version to install. This is ignored if a channel is provided.',
      exclusive: ['from-local', 'version'],
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(UpdateCommand)

    if (args.channel && flags.version) {
      this.error('You cannot specifiy both a version and a channel.')
    }

    let version = flags.version
    if (flags['from-local']) {
      version = await this.promptForLocalVersion()
    } else if (flags.interactive) {
      version = await this.promptForRemoteVersion()
    }

    const updateCli = new UpdateCli({
      channel: args.channel,
      autoUpdate: flags.autoupdate,
      fromLocal: flags['from-local'],
      version,
      config: this.config as Config,
      exit: this.exit,
    })
    return updateCli.runUpdate()
  }

  private async promptForRemoteVersion(): Promise<string> {
    const choices = sort(Object.keys(await UpdateCli.fetchVersionIndex(this.config))).reverse()
    const {version} = await prompt<{version: string}>({
      name: 'version',
      message: 'Select a version to update to',
      type: 'list',
      choices,
    })
    return version
  }

  private async promptForLocalVersion(): Promise<string> {
    const choices = sort(UpdateCli.findLocalVersions(this.config)).reverse()
    const {version} = await prompt<{version: string}>({
      name: 'version',
      message: 'Select a version to update to',
      type: 'list',
      choices,
    })
    return version
  }
}
