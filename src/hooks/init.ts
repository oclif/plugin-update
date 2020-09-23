import * as Config from '@oclif/config'
import cli from 'cli-ux'
import * as spawn from 'cross-spawn'
import * as fs from 'fs-extra'
import * as path from 'path'

import {touch} from '../util'

const debug = require('debug')('cli:updater')

function timestamp(msg: string): string {
  return `[${new Date().toISOString()}] ${msg}`
}

async function mtime(f: string) {
  const {mtime} = await fs.stat(f)
  return mtime
}

export const init: Config.Hook<'init'> = async function (opts) {
  if (opts.id === 'update') return
  if (opts.config.scopedEnvVarTrue('DISABLE_AUTOUPDATE')) return
  const binPath = this.config.binPath || this.config.bin
  const lastrunfile = path.join(this.config.cacheDir, 'lastrun')
  const autoupdatefile = path.join(this.config.cacheDir, 'autoupdate')
  const autoupdatelogfile = path.join(this.config.cacheDir, 'autoupdate.log')
  const clientRoot = this.config.scopedEnvVar('OCLIF_CLIENT_HOME') || path.join(this.config.dataDir, 'client')

  const autoupdateEnv = {
    ...process.env,
    [this.config.scopedEnvVarKey('TIMESTAMPS')]: '1',
    [this.config.scopedEnvVarKey('SKIP_ANALYTICS')]: '1',
  }

  async function autoupdateNeeded(): Promise<boolean> {
    try {
      const m = await mtime(autoupdatefile)
      let days = 1
      if (opts.config.channel === 'stable') days = 14
      m.setHours(m.getHours() + (days * 24))
      return m < new Date()
    } catch (error) {
      if (error.code !== 'ENOENT') cli.error(error.stack)
      if ((global as any).testing) return false
      debug('autoupdate ENOENT')
      return true
    }
  }

  await touch(lastrunfile)
  const clientDir = path.join(clientRoot, this.config.version)
  if (await fs.pathExists(clientDir)) await touch(clientDir)
  if (!await autoupdateNeeded()) return

  debug('autoupdate running')
  await fs.outputFile(autoupdatefile, '')

  debug(`spawning autoupdate on ${binPath}`)

  const fd = await fs.open(autoupdatelogfile, 'a')
  fs.write(
    fd,
    timestamp(`starting \`${binPath} autoupdate --autoupdate\` from ${process.argv.slice(1, 3).join(' ')}\n`),
  )

  spawn(binPath, ['autoupdate', '--autoupdate'], {
    detached: !this.config.windows,
    stdio: ['ignore', fd, fd],
    env: autoupdateEnv,
  })
  .on('error', (e: Error) => process.emitWarning(e))
  .unref()
}
