import HTTP from 'http-call'

import {Updater} from '.'

export interface IManifest {
  version: string
  channel: string
  sha256gz: string
  priority?: number
}

export class S3Updater extends Updater {
  async update({channel}: {channel?: string}) {
    channel = channel || 'stable'
    const manifest = await this.fetchManifest(channel)
    const base = this.base(manifest.version)
    const url = `https://${this.s3Host}/${this.config.bin}/channels/${manifest.channel}/${base}.tar.gz`
    return super.update({url, version: manifest.version, sha256: manifest.sha256gz, channel})
  }

  async needsUpdate(channel: string) {
    if (channel !== this.channel) return true
    let manifest = await this.fetchManifest(channel)
    return this.config.version !== manifest.version
  }

  private get s3Host(): string | undefined {
    return this.config.pjson.oclif.s3Host || this.config.scopedEnvVar('S3_HOST')
  }

  private s3url(channel: string, p: string): string {
    if (!this.s3Host) throw new Error('S3 host not defined')
    // TODO: handle s3Prefix
    return `https://${this.s3Host}/${this.config.bin}/channels/${channel}/${p}`
  }

  private async fetchManifest(channel: string): Promise<IManifest> {
    const http: typeof HTTP = require('http-call').HTTP
    try {
      let {body} = await http.get(this.s3url(channel, `${this.config.platform}-${this.config.arch}`))
      return body
    } catch (err) {
      if (err.statusCode === 403) throw new Error(`HTTP 403: Invalid channel ${channel}`)
      throw err
    }
  }
}
