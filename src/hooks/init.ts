import {Interfaces} from '@oclif/core'
import makeDebug from 'debug'
import {spawn} from 'node:child_process'
import {existsSync} from 'node:fs'
import {mkdir, open, stat, unlink, writeFile} from 'node:fs/promises'
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

  // Ensure the cache directory exists
  await mkdir(config.cacheDir, {recursive: true})

  async function autoupdateNeeded(): Promise<boolean> {
    try {
      const m = await mtime(autoupdatefile)
      let days = 1
      if (opts.config.channel === 'stable') days = 14

      // Check for custom update check interval in configuration
      const debounce = config.pjson.oclif?.update?.autoupdate?.debounce
      if (debounce !== undefined && debounce > 0) {
        days = debounce
      }

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

  // Atomically claim the right to spawn an autoupdate.
  //
  // The original `if (!(await autoupdateNeeded())) return; await writeFile(...)`
  // sequence had a non-atomic read-then-write window: several otto invocations
  // starting in parallel on a machine with no marker file (e.g. a fresh
  // laptop being set up) could all pass the autoupdateNeeded() check before
  // any one of them wrote the marker, and each would spawn its own
  // `<cli> update --autoupdate` child. Those children then pin in debounce()
  // (which never exits while CLI activity continues) and accumulate until OOM.
  //
  // Fix: combine the check and the marker creation into a single atomic step
  // using O_EXCL (`open(path, 'wx')`). Only one process can create the marker;
  // others see EEXIST and bail (or, if the marker is stale, race to reclaim it
  // — which is bounded to one race per debounce window per machine).
  if (!(await claimAutoupdate(autoupdatefile))) return

  debug('autoupdate running')

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
    .on('close', () => fd.close())
    .unref()

  async function claimAutoupdate(markerPath: string): Promise<boolean> {
    // Fast path: try to atomically create the marker. Wins the race when no
    // marker exists yet (fresh-laptop case — the catastrophic scenario).
    try {
      const fd = await open(markerPath, 'wx')
      await fd.close()
      return true
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== 'EEXIST') throw err
    }

    // Marker exists. If it's within the debounce window, nothing to do.
    if (!(await autoupdateNeeded())) return false

    // Marker is stale (debounce window has elapsed). Reclaim by unlinking and
    // re-creating atomically. There remains a tiny window between unlink and
    // open where two stale-marker processes could both win, but it's
    // microseconds vs the multi-await window of the original bug, and
    // bounded to one race per debounce window per machine.
    try {
      await unlink(markerPath)
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') throw err
    }

    try {
      const fd = await open(markerPath, 'wx')
      await fd.close()
      return true
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'EEXIST') return false
      throw err
    }
  }
}
