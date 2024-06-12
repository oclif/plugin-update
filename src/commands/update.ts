import select from '@inquirer/select'
import {Args, Command, Flags, Interfaces, ux} from '@oclif/core'
import {got} from 'got'
import {basename} from 'node:path'
import {sort} from 'semver'
import TtyTable from 'tty-table'

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
      exclusive: ['version', 'interactive'],
    }),
    force: Flags.boolean({
      description: 'Force a re-download of the requested version.',
      exclusive: ['interactive', 'available'],
    }),
    interactive: Flags.boolean({
      char: 'i',
      description: 'Interactively select version to install. This is ignored if a channel is provided.',
      exclusive: ['version'],
    }),
    version: Flags.string({
      char: 'v',
      description: 'Install a specific version.',
      exclusive: ['interactive', 'force'],
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(UpdateCommand)
    const updater = new Updater(this.config)
    if (flags.available) {
      const {distTags, index, localVersions} = await lookupVersions(updater, this.config)

      const headers = [
        {align: 'left', value: 'Location'},
        {align: 'left', value: 'Version'},
      ]

      if (distTags) {
        headers.push({align: 'left', value: 'Channel'})
      }

      // eslint-disable-next-line new-cap
      const t = TtyTable(
        headers,
        sort(Object.keys(index))
          .reverse()
          .map((version) => {
            const location = localVersions.find((l) => basename(l).startsWith(version)) || index[version]
            if (distTags) {
              return [location, version, distTags[version] ?? '']
            }

            return [location, version]
          }),
        {compact: true},
      )

      ux.stdout(t.render())
      return
    }

    if (args.channel && flags.version) {
      this.error('You cannot specify both a version and a channel.')
    }

    return updater.runUpdate({
      autoUpdate: flags.autoupdate,
      channel: args.channel,
      force: flags.force,
      version: flags.interactive ? await promptForVersion(updater, this.config) : flags.version,
    })
  }
}

const lookupVersions = async (updater: Updater, config: Interfaces.Config) => {
  ux.action.start('Looking up versions')
  const [index, localVersions, distTags] = await Promise.all([
    updater.fetchVersionIndex(),
    updater.findLocalVersions(),
    fetchDistTags(config),
  ])

  ux.action.stop(`Found ${Object.keys(index).length} versions`)
  return {
    distTags,
    index,
    localVersions,
  }
}

const fetchDistTags = async (config: Interfaces.Config) => {
  const distTags = config.pjson.oclif.update?.disableNpmLookup
    ? {}
    : await got
        .get(`${config.npmRegistry ?? 'https://registry.npmjs.org'}/${config.pjson.name}`)
        .json<{
          'dist-tags': Record<string, string>
        }>()
        .then((r) => r['dist-tags'])

  // Invert the distTags object so we can look up the channel by version
  return Object.fromEntries(Object.entries(distTags ?? {}).map(([k, v]) => [v, k]))
}

const displayName = (value: string, distTags: Record<string, string>) =>
  `${value} ${distTags[value] ? `(${distTags[value]})` : ''}`

const promptForVersion = async (updater: Updater, config: Interfaces.Config): Promise<string> => {
  const {distTags, index} = await lookupVersions(updater, config)
  return select({
    choices: sort(Object.keys(index))
      .reverse()
      .map((v) => ({name: displayName(v, distTags), value: v})),
    loop: false,
    message: 'Select a version to update to',
    pageSize: 10,
  })
}
