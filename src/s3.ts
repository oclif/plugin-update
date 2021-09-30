import * as path from 'path'

import cli from 'cli-ux'
import HTTP from 'http-call'

import {IManifest} from '@oclif/dev-cli'

import RemoteUpdater from './remote'

export default class S3Updater extends RemoteUpdater {
  protected async fetchManifest(): Promise<IManifest> {
    const http: typeof HTTP = require('http-call').HTTP

    cli.action.status = 'fetching manifest'
    if (!this.config.scopedEnvVarTrue('USE_LEGACY_UPDATE')) {
      try {
        const newManifestUrl = this.config.s3Url(
          this.s3ChannelManifestKey(
            this.config.bin,
            this.config.platform,
            this.config.arch,
            (this.config.pjson.oclif.update.s3 as any).folder,
          ),
        )
        const {body} = await http.get<IManifest | string>(newManifestUrl)
        if (typeof body === 'string') {
          return JSON.parse(body)
        }
        return body
      } catch (error) {
        this.debug(error.message)
      }
    }

    try {
      const url = this.config.s3Url(this.config.s3Key('manifest', {
        channel: this.channel,
        platform: this.config.platform,
        arch: this.config.arch,
      }))
      const {body} = await http.get<IManifest | string>(url)

      // in case the content-type is not set, parse as a string
      // this will happen if uploading without `oclif-dev publish`
      if (typeof body === 'string') {
        return JSON.parse(body)
      }
      return body
    } catch (error) {
      if (error.statusCode === 403) throw new Error(`HTTP 403: Invalid channel ${this.channel}`)
      throw error
    }
  }

  protected async initializeDownload(output: string, manifest: IManifest) {
    const {version, sha256gz} = manifest
    const channel = this.channel
    const gzUrl = manifest.gz || this.config.s3Url(this.config.s3Key('versioned', {
      version,
      channel,
      bin: this.config.bin,
      platform: this.config.platform,
      arch: this.config.arch,
      ext: 'gz',
    }))
    const baseDir = manifest.baseDir || this.config.s3Key('baseDir', {
      version,
      channel,
      bin: this.config.bin,
      platform: this.config.platform,
      arch: this.config.arch,
    })
    await this.downloadAndExtract(output, gzUrl, baseDir, sha256gz)
  }

  private s3ChannelManifestKey(bin: string, platform: string, arch: string, folder?: string): string {
    let s3SubDir = folder || ''
    if (s3SubDir !== '' && s3SubDir.slice(-1) !== '/') s3SubDir = `${s3SubDir}/`
    return path.join(s3SubDir, 'channels', this.channel, `${bin}-${platform}-${arch}-buildmanifest`)
  }

  protected getReqHeaders(): {headers?: {Authorization?: string}} | undefined {
    return undefined
  }
}
