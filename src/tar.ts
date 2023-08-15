import * as fs from 'node:fs/promises'
import {existsSync} from 'node:fs'
import * as path from 'path'

import {touch} from './util'

const debug = require('debug')('oclif-update')

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

export async function extract(stream: NodeJS.ReadableStream, basename: string, output: string, sha?: string): Promise<void> {
  const getTmp = () => `${output}.partial.${Math.random().toString().split('.')[1].slice(0, 5)}`
  let tmp = getTmp()
  if (existsSync(tmp)) tmp = getTmp()
  debug(`extracting to ${tmp}`)
  try {
    await new Promise((resolve, reject) => {
      const zlib = require('zlib')
      const tar = require('tar-fs')
      const crypto = require('crypto')
      let shaValidated = false
      let extracted = false
      const check = () => shaValidated && extracted && resolve(null)

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

    if (existsSync(output)) {
      try {
        const tmp = getTmp()
        const {move} = await import('fs-extra')
        await move(output, tmp)
        await fs.rm(tmp, {recursive: true, force: true}).catch(debug)
      } catch (error: any) {
        debug(error)
        await fs.rm(tmp, {recursive: true, force: true}).catch(debug)
      }
    }

    const from = path.join(tmp, basename)
    debug('moving %s to %s', from, output)
    await fs.rename(from, output)
    await fs.rm(tmp, {recursive: true, force: true}).catch(debug)
    await touch(output)
    debug('done extracting')
  } catch (error: any) {
    await fs.rm(tmp, {recursive: true, force: true}).catch(process.emitWarning)
    throw error
  }
}
