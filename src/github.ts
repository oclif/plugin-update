import HTTP from 'http-call'

import {IManifest} from '@oclif/dev-cli'

import RemoteUpdater from './remote'

export default class GithubUpdater extends RemoteUpdater {
  protected async fetchManifest(): Promise<IManifest> {
    const http: typeof HTTP = require('http-call').HTTP

    let owner
    let repo
    try {
      const url = this.config.pjson.repository.url
      const matches = url.match(/.+?:(.+?)\/(.+?)\.git/)
      owner = matches[1]
      repo = matches[2]
    } catch (error) {
      this.debug(error)
      throw new Error('Github repository not defined')
    }

    const {body} = await http.get(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, this.getReqHeaders())
    const release = typeof body === 'string' ? JSON.parse(body) : body
    const version = release.tag_name
    const binKey = this.getBinKey(
      this.config.bin,
      version,
      this.config.platform,
      this.config.arch,
    )
    const asset = release.assets.find((a: any) => a.name === binKey)

    if (asset) {
      return {
        version,
        channel: 'stable', // No channel support for now
        gz: asset.url,
        sha256gz: '', // Skipping sha validation for now
        baseDir: this.config.bin,
        node: {
          compatible: this.config.pjson.oclif.update.node.version || '', // Included because it is part of IManifest
          recommended: this.config.pjson.oclif.update.node.version || '', // Included because it is part of IManifest
        },
      }
    }

    throw new Error('No compatible release found')
  }

  protected async initializeDownload(output: string, manifest: IManifest) {
    const {gz: gzUrl, baseDir} = manifest
    const sha256gz: string | undefined = manifest.sha256gz === '' ? undefined : manifest.sha256gz
    await this.downloadAndExtract(output, gzUrl, baseDir, sha256gz)
  }

  // Get the name of the manifest we are looking for - no channel support for now
  private getBinKey(bin: string, version: string, platform: string, arch: string): string {
    return `${bin}-${version}-${platform}-${arch}.tar.gz`
  }

  protected getReqHeaders(): {headers?: {Authorization?: string}} | undefined {
    const token = this.config.scopedEnvVar('GITHUB_TOKEN')
    if (token) {
      return {headers: {Authorization: 'Bearer ' + token}}
    }
  }
}
