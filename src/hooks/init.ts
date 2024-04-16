import {Interfaces} from '@oclif/core'
import makeDebug from 'debug'
import {spawn} from 'node:child_process'
import {existsSync} from 'node:fs'
import {open, stat, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {touch} from '../util.js'
const debug = makeDebug('cli:updater')

function timestamp(msg: string): string {
  return `[${new Date().toISOString()}] ${msg}`
}

async function mtime(f: string) {
  const {mtime} = await stat(f)
  return mtime
}

export const init: Interfaces.Hook<'init'> = async function (opts) {
  if (opts.id === 'update') return
  if (opts.config.scopedEnvVarTrue('DISABLE_AUTOUPDATE')) return

  const {config, error: throwError} = this
  const binPath = config.binPath ?? config.bin
  const lastrunfile = join(config.cacheDir, 'lastrun')
  const autoupdatefile = join(config.cacheDir, 'autoupdate')
  const autoupdatelogfile = join(config.cacheDir, 'autoupdate.log')
  const clientRoot = config.scopedEnvVar('OCLIF_CLIENT_HOME') ?? join(config.dataDir, 'client')

  const autoupdateEnv = {
    ...process.env,
    [config.scopedEnvVarKey('SKIP_ANALYTICS')]: '1',
    [config.scopedEnvVarKey('TIMESTAMPS')]: '1',
  }

  async function autoupdateNeeded(): Promise<boolean> {
    try {
      const m = await mtime(autoupdatefile)
      let days = 1
      if (opts.config.channel === 'stable') days = 14
      m.setHours(m.getHours() + days * 24)
      return m < new Date()
    } catch (error: unknown) {
      const err = error as {code: string; stack: string}
      if (err.code !== 'ENOENT') throwError(err.stack)
      debug('autoupdate ENOENT')
      return true
    }
  }

  await touch(lastrunfile)
  const clientDir = join(clientRoot, config.version)
  if (existsSync(clientDir)) await touch(clientDir)
  if (!(await autoupdateNeeded())) return

  debug('autoupdate running')
  await writeFile(autoupdatefile, '')

  debug(`spawning autoupdate on ${binPath}`)

  const fd = await open(autoupdatelogfile, 'a')
  await writeFile(
    fd,
    timestamp(`starting \`${binPath} update --autoupdate\` from ${process.argv.slice(1, 3).join(' ')}\n`),
  )

  const stream = fd.createWriteStream()
  spawn(binPath, ['update', '--autoupdate'], {
    detached: !config.windows,
    env: autoupdateEnv,
    stdio: ['ignore', stream, stream],
    ...(config.windows ? {shell: true} : {}),
  })
    .on('error', (e: Error) => process.emitWarning(e))
    .unref()
}
