import {Command, Flags, Config, CliUx} from '@oclif/core'
import {prompt} from 'inquirer'
import * as path from 'path'
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
      description: 'Interactively select version:',
      command: '<%= config.bin %> <%= command.id %> --interactive',
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
    available: Flags.boolean({hidden: true}),
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
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(UpdateCommand)

    if (flags.available) {
      const index = await UpdateCli.fetchVersionIndex(this.config)
      const allVersions = sort(Object.keys(index)).reverse()
      const localVersions = await UpdateCli.findLocalVersions(this.config)

      const table = allVersions.map(version => {
        const location = localVersions.find(l => path.basename(l).startsWith(version)) || index[version]
        return {version, location}
      })

      CliUx.ux.table(table, {version: {}, location: {}})
      return
    }

    if (args.channel && flags.version) {
      this.error('You cannot specifiy both a version and a channel.')
    }

    const updateCli = new UpdateCli({
      channel: args.channel,
      autoUpdate: flags.autoupdate,
      hard: flags.hard,
      version: flags.interactive ? await this.promptForVersion() : flags.version,
      config: this.config as Config,
      exit: this.exit,
    })
    return updateCli.runUpdate()
  }

  private async promptForVersion(): Promise<string> {
    const choices = sort(Object.keys(await UpdateCli.fetchVersionIndex(this.config))).reverse()
    const {version} = await prompt<{version: string}>({
      name: 'version',
      message: 'Select a version to update to',
      type: 'list',
      choices,
    })
    return version
  }
}
