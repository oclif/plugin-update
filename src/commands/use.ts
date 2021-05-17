import cli from 'cli-ux'
import * as fs from 'fs-extra'
import * as semver from 'semver'

import UpdateCommand from './update'

export default class UseCommand extends UpdateCommand {
    static args = [{name: 'version', optional: false}]

    static flags = {}

    async run() {
      const {args} = this.parse(UseCommand)

      // Check if this command is trying to update the channel. TODO: make this dynamic
      const channelUpdateRequested = ['alpha', 'beta', 'next', 'stable'].some(c => args.version === c)
      this.channel = channelUpdateRequested ? args.version : await this.determineChannel()

      const targetVersion = semver.clean(args.version) || args.version

      // Determine if the version is from a different channel and update to account for it (ex. cli-example update 3.0.0-next.22 should update the channel to next as well.)
      const versionParts = targetVersion?.split('-') || ['', '']
      if (versionParts && versionParts[1]) {
        this.channel = versionParts[1].substr(0, versionParts[1].indexOf('.'))
        this.debug(`Flag overriden target channel: ${this.channel}`)
      }

      await this.ensureClientDir()
      this.debug(`Looking for locally installed versions at ${this.clientRoot}`)

      // Do not show known non-local version folder names, bin and current.
      const versions = fs.readdirSync(this.clientRoot).filter(dirOrFile => dirOrFile !== 'bin' && dirOrFile !== 'current')
      if (versions.length === 0) throw new Error('No locally installed versions found.')

      if (versions.includes(targetVersion)) {
        this.updateToExistingVersion(targetVersion)
      } else if (channelUpdateRequested) {
        // Begin prompt
        cli.action.start(`${this.config.name}: Updating CLI`)

        // Run pre-update hook
        await this.config.runHook('preupdate', {channel: this.channel})
        const manifest = await this.fetchManifest()

        // Determine version differences
        this.currentVersion = await this.determineCurrentVersion()
        this.updatedVersion = (manifest as any).sha ? `${manifest.version}-${(manifest as any).sha}` : manifest.version

        // Check if this update should be skipped
        const reason = await this.skipUpdate()
        if (reason) {
          cli.action.stop(reason || 'done')
        } else {
          // Update using the new channel specification
          await this.update(manifest, this.channel)
        }

        this.debug('tidy')
        await this.tidy()
        await this.config.runHook('update', {channel: this.channel})
      } else {
        throw new Error(`Requested version could not be found. Please try running \`${this.config.bin} install ${targetVersion}\``)
      }

      this.log()
      this.log(`Updating to an already installed version will not update the channel. If autoupdate is enabled, the CLI will eventually be updated back to ${this.channel}.`)

      this.debug('done')
      cli.action.stop()
    }
}
