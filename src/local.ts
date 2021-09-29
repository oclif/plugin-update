import * as path from 'path'

import cli from 'cli-ux'
import * as fs from 'fs-extra'

import Updater from './updater'

export default class LocalUpdater extends Updater {
  async update() {
    await this.ensureClientDir()
    this.debug(`Looking for locally installed versions at ${this.clientRoot}`)

    // Do not show known non-local version folder names, bin and current.
    const versions = fs.readdirSync(this.clientRoot).filter(dirOrFile => dirOrFile !== 'bin' && dirOrFile !== 'current')
    if (versions.length === 0) throw new Error('No locally installed versions found.')

    this.log(`Found versions: \n${versions.map(version => `     ${version}`).join('\n')}\n`)

    const pinToVersion = await cli.prompt('Enter a version to update to')
    if (!versions.includes(pinToVersion)) throw new Error(`Version ${pinToVersion} not found in the locally installed versions.`)

    if (!await fs.pathExists(path.join(this.clientRoot, pinToVersion))) {
      throw new Error(`Version ${pinToVersion} is not already installed at ${this.clientRoot}.`)
    }

    this.start()

    this.debug(`Switching to existing version ${pinToVersion}`)
    this.updateToExistingVersion(pinToVersion)

    this.log(`\nUpdating to an already installed version will not update the channel. If autoupdate is enabled, the CLI will eventually be updated back to ${this.channel}.`)

    this.stop()
  }

  private async updateToExistingVersion(version: string) {
    await this.createBin(version)
    await this.touch()
  }
}
