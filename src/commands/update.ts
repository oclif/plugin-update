import {Command, Flags, Config} from '@oclif/core'
import {prompt} from 'inquirer'
import {sort} from 'semver'
import UpdateCli from '../update'

export default class UpdateCommand extends Command {
  static description = 'update the <%= config.bin %> CLI'

  static args = [{name: 'channel', optional: true}]

  static examples = [
    {
      description: 'Update to the stable channel:',
      command: '<%= config.bin %> <%= command.id %> stable',
    },
    {
      description: 'Update to a specific version:',
      command: '<%= config.bin %> <%= command.id %> --version 1.0.0',
    },
    {
      description: 'Update to a previously installed version:',
      command: '<%= config.bin %> <%= command.id %> --version 1.0.0 --local',
    },
    {
      description: 'Interactively select version:',
      command: '<%= config.bin %> <%= command.id %> --interactive',
    },
    {
      description: 'Interactively select a previously installed version:',
      command: '<%= config.bin %> <%= command.id %> --interactive --local',
    },
    {
      description: 'Remove all existing versions and install stable channel version:',
      command: '<%= config.bin %> <%= command.id %> stable --hard',
    },
    {
      description: 'Remove all existing versions and install specific version:',
      command: '<%= config.bin %> <%= command.id %> --version 1.0.0 --hard',
    },
  ]

  static flags = {
    autoupdate: Flags.boolean({hidden: true}),
    local: Flags.boolean({
      description: 'Switch to an already installed version. This is ignored if a channel is provided.',
    }),
    version: Flags.string({
      description: 'Install a specific version.',
      exclusive: ['interactive'],
    }),
    interactive: Flags.boolean({
      description: 'Interactively select version to install. This is ignored if a channel is provided.',
      exclusive: ['version'],
    }),
    hard: Flags.boolean({
      description: 'Remove all existing versions before updating to new version.',
      exclusive: ['local'],
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(UpdateCommand)

    if (args.channel && flags.version) {
      this.error('You cannot specifiy both a version and a channel.')
    }

    let version = flags.version
    if (flags.interactive && flags.local) {
      version = await this.promptForLocalVersion()
    } else if (flags.interactive) {
      version = await this.promptForRemoteVersion()
    }

    const updateCli = new UpdateCli({
      channel: args.channel,
      autoUpdate: flags.autoupdate,
      local: flags.local,
      hard: flags.hard,
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
