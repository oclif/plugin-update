import {Args, Command, Flags, ux} from '@oclif/core'
import inquirer from 'inquirer'
import {basename} from 'node:path'
import {sort} from 'semver'

import {Updater} from '../update.js'

export default class UpdateCommand extends Command {
  static args = {
    channel: Args.string({optional: true}),
  }

  static description = 'update the <%= config.bin %> CLI'

  static examples = [
    {
      command: '<%= config.bin %> <%= command.id %> stable',
      description: 'Update to the stable channel:',
    },
    {
      command: '<%= config.bin %> <%= command.id %> --version 1.0.0',
      description: 'Update to a specific version:',
    },
    {
      command: '<%= config.bin %> <%= command.id %> --interactive',
      description: 'Interactively select version:',
    },
    {
      command: '<%= config.bin %> <%= command.id %> --available',
      description: 'See available versions:',
    },
  ]

  static flags = {
    autoupdate: Flags.boolean({hidden: true}),
    available: Flags.boolean({
      char: 'a',
      description: 'See available versions.',
    }),
    force: Flags.boolean({
      description: 'Force a re-download of the requested version.',
    }),
    interactive: Flags.boolean({
      char: 'i',
      description: 'Interactively select version to install. This is ignored if a channel is provided.',
      exclusive: ['version'],
    }),
    version: Flags.string({
      char: 'v',
      description: 'Install a specific version.',
      exclusive: ['interactive'],
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(UpdateCommand)
    const updater = new Updater(this.config)
    if (flags.available) {
      const index = await updater.fetchVersionIndex()
      const allVersions = sort(Object.keys(index)).reverse()
      const localVersions = await updater.findLocalVersions()

      const table = allVersions.map((version) => {
        const location = localVersions.find((l) => basename(l).startsWith(version)) || index[version]
        return {location, version}
      })

      ux.table(table, {location: {}, version: {}})
      return
    }

    if (args.channel && flags.version) {
      this.error('You cannot specify both a version and a channel.')
    }

    return updater.runUpdate({
      autoUpdate: flags.autoupdate,
      channel: args.channel,
      force: flags.force,
      version: flags.interactive ? await this.promptForVersion(updater) : flags.version,
    })
  }

  private async promptForVersion(updater: Updater): Promise<string> {
    const choices = sort(Object.keys(await updater.fetchVersionIndex())).reverse()
    const {version} = await inquirer.prompt<{version: string}>({
      choices: [...choices, new inquirer.Separator()],
      message: 'Select a version to update to',
      name: 'version',
      type: 'list',
    })
    return version
  }
}
