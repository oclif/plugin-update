import * as path from 'path'

import cli from 'cli-ux'
import HTTP from 'http-call'
import {throttle} from 'lodash'

import {IManifest} from '@oclif/dev-cli'

import RemoteUpdater from './remote'
import {extract} from './tar'

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

  protected async downloadAndExtract(output: string, manifest: IManifest, channel: string) {
    const {version} = manifest

    const filesize = (n: number): string => {
      const [num, suffix] = require('filesize')(n, {output: 'array'})
      return num.toFixed(1) + ` ${suffix}`
    }

    const http: typeof HTTP = require('http-call').HTTP
    const gzUrl = manifest.gz || this.config.s3Url(this.config.s3Key('versioned', {
      version,
      channel,
      bin: this.config.bin,
      platform: this.config.platform,
      arch: this.config.arch,
      ext: 'gz',
    }))
    const {response: stream} = await http.stream(gzUrl)
    stream.pause()

    const baseDir = manifest.baseDir || this.config.s3Key('baseDir', {
      version,
      channel,
      bin: this.config.bin,
      platform: this.config.platform,
      arch: this.config.arch,
    })
    const extraction = extract(stream, baseDir, output, manifest.sha256gz)

    // to-do: use cli.action.type
    if ((cli.action as any).frames) {
      // if spinner action
      const total = parseInt(stream.headers['content-length']!, 10)
      let current = 0
      const updateStatus = throttle(
        (newStatus: string) => {
          cli.action.status = newStatus
        },
        250,
        {leading: true, trailing: false},
      )
      stream.on('data', data => {
        current += data.length
        updateStatus(`${filesize(current)}/${filesize(total)}`)
      })
    }

    stream.resume()
    await extraction
  }

  private s3ChannelManifestKey(bin: string, platform: string, arch: string, folder?: string): string {
    let s3SubDir = folder || ''
    if (s3SubDir !== '' && s3SubDir.slice(-1) !== '/') s3SubDir = `${s3SubDir}/`
    return path.join(s3SubDir, 'channels', this.channel, `${bin}-${platform}-${arch}-buildmanifest`)
  }
}
