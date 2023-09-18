import {Command, Flags, ux, Args} from '@oclif/core'
import {prompt, Separator} from 'inquirer'
import * as path from 'node:path'
import {sort} from 'semver'
import {Updater} from '../update.js'

export default class UpdateCommand extends Command {
  static description = 'update the <%= config.bin %> CLI'

  static args = {
    channel: Args.string({optional: true}),
  }

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
      description: 'See available versions:',
      command: '<%= config.bin %> <%= command.id %> --available',
    },
  ]

  static flags = {
    autoupdate: Flags.boolean({hidden: true}),
    available: Flags.boolean({
      char: 'a',
      description: 'Install a specific version.',
    }),
    version: Flags.string({
      char: 'v',
      description: 'Install a specific version.',
      exclusive: ['interactive'],
    }),
    interactive: Flags.boolean({
      char: 'i',
      description: 'Interactively select version to install. This is ignored if a channel is provided.',
      exclusive: ['version'],
    }),
    force: Flags.boolean({
      description: 'Force a re-download of the requested version.',
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(UpdateCommand)
    const updater = new Updater(this.config)
    if (flags.available) {
      const index = await updater.fetchVersionIndex()
      const allVersions = sort(Object.keys(index)).reverse()
      const localVersions = await updater.findLocalVersions()

      const table = allVersions.map(version => {
        const location = localVersions.find(l => path.basename(l).startsWith(version)) || index[version]
        return {version, location}
      })

      ux.table(table, {version: {}, location: {}})
      return
    }

    if (args.channel && flags.version) {
      this.error('You cannot specify both a version and a channel.')
    }

    return updater.runUpdate({
      channel: args.channel,
      autoUpdate: flags.autoupdate,
      force: flags.force,
      version: flags.interactive ? await this.promptForVersion(updater) : flags.version,
    })
  }

  private async promptForVersion(updater: Updater): Promise<string> {
    const choices = sort(Object.keys(await updater.fetchVersionIndex())).reverse()
    const {version} = await prompt<{version: string}>({
      name: 'version',
      message: 'Select a version to update to',
      type: 'list',
      choices: [...choices, new Separator()],
    })
    return version
  }
}

