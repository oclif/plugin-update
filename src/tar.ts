import * as fs from 'fs-extra'
import * as path from 'path'

import {touch} from './util'

const debug = require('debug')('oclif-update')

export async function extract(stream: NodeJS.ReadableStream, basename: string, output: string, sha?: string) {
  const getTmp = () => `${output}.partial.${Math.random().toString().split('.')[1].slice(0, 5)}`
  let tmp = getTmp()
  if (fs.pathExistsSync(tmp)) tmp = getTmp()
  debug(`extracting to ${tmp}`)
  try {
    await new Promise((resolve, reject) => {
      const zlib = require('zlib')
      const tar = require('tar-fs')
      const crypto = require('crypto')
      let shaValidated = false
      let extracted = false
      const check = () => shaValidated && extracted && resolve()

      if (sha) {
        const hasher = crypto.createHash('sha256')
        stream.on('error', reject)
        stream.on('data', d => hasher.update(d))
        stream.on('end', () => {
          const shasum = hasher.digest('hex')
          if (sha === shasum) {
            shaValidated = true
            check()
          } else {
            reject(new Error(`SHA mismatch: expected ${shasum} to be ${sha}`))
          }
        })
      } else shaValidated = true

      const ignore = (_: any, header: any) => {
        switch (header.type) {
        case 'directory':
        case 'file':
          if (process.env.OCLIF_DEBUG_UPDATE_FILES) debug(header.name)
          return false
        case 'symlink':
          return true
        default:
          throw new Error(header.type)
        }
      }
      const extract = tar.extract(tmp, {ignore})
      extract.on('error', reject)
      extract.on('finish', () => {
        extracted = true
        check()
      })

      const gunzip = zlib.createGunzip()
      gunzip.on('error', reject)

      stream.pipe(gunzip).pipe(extract)
    })

    if (await fs.pathExists(output)) {
      try {
        const tmp = getTmp()
        await fs.move(output, tmp)
        await fs.remove(tmp).catch(debug)
      } catch (error) {
        debug(error)
        await fs.remove(output)
      }
    }
    const from = path.join(tmp, basename)
    debug('moving %s to %s', from, output)
    await fs.rename(from, output)
    await fs.remove(tmp).catch(debug)
    await touch(output)
    debug('done extracting')
  } catch (error) {
    await fs.remove(tmp).catch(process.emitWarning)
    throw error
  }
}
