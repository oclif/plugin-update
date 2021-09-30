import * as path from 'path'

import cli from 'cli-ux'
import * as fs from 'fs-extra'

import {IConfig} from '@oclif/config'

import UpdateCommand from './commands/update'

export default abstract class Updater {
  private readonly command!: UpdateCommand

  protected readonly config!: IConfig

  protected readonly debug: (...args: any[]) => void

  protected readonly log: (...args: any[]) => void

  protected readonly warn: (...args: any[]) => void

  protected readonly exit: (...args: any[]) => void

  protected readonly channel: string

  protected readonly clientRoot: string

  protected readonly clientBin: string

  constructor(command: UpdateCommand, debug: (...args: any[]) => void, log: (...args: any[]) => void, warn: (...args: any[]) => void) {
    this.command = command
    this.config = command.config
    this.channel = command.channel
    this.exit = command.exit
    this.debug = debug
    this.log = log
    this.warn = warn
    this.clientRoot = this.config.scopedEnvVar('OCLIF_CLIENT_HOME') || path.join(this.config.dataDir, 'client')
    this.clientBin = path.join(this.clientRoot, 'bin', this.config.windows ? `${this.config.bin}.cmd` : this.config.bin)
  }

  abstract update(): void

  protected start() {
    cli.action.start(`${this.config.name}: Updating CLI`)
  }

  protected stop() {
    this.debug('done')

    cli.action.stop()
  }

  protected async createBin(version: string) {
    const dst = this.clientBin
    const {bin} = this.command.config
    const binPathEnvVar = this.command.config.scopedEnvVarKey('BINPATH')
    const redirectedEnvVar = this.command.config.scopedEnvVarKey('REDIRECTED')
    if (this.command.config.windows) {
      const body = `@echo off
setlocal enableextensions
set ${redirectedEnvVar}=1
set ${binPathEnvVar}=%~dp0${bin}
"%~dp0..\\${version}\\bin\\${bin}.cmd" %*
`
      await fs.outputFile(dst, body)
    } else {
      /* eslint-disable no-useless-escape */
      const body = `#!/usr/bin/env bash
set -e
get_script_dir () {
  SOURCE="\${BASH_SOURCE[0]}"
  # While $SOURCE is a symlink, resolve it
  while [ -h "$SOURCE" ]; do
    DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
    SOURCE="$( readlink "$SOURCE" )"
    # If $SOURCE was a relative symlink (so no "/" as prefix, need to resolve it relative to the symlink base directory
    [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
  done
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  echo "$DIR"
}
DIR=$(get_script_dir)
${binPathEnvVar}="\$DIR/${bin}" ${redirectedEnvVar}=1 "$DIR/../${version}/bin/${bin}" "$@"
`
      /* eslint-enable no-useless-escape */

      await fs.remove(dst)
      await fs.outputFile(dst, body)
      await fs.chmod(dst, 0o755)
      await fs.remove(path.join(this.clientRoot, 'current'))
      await fs.symlink(`./${version}`, path.join(this.clientRoot, 'current'))
    }
  }

  protected async ensureClientDir() {
    try {
      await fs.mkdirp(this.clientRoot)
    } catch (error) {
      if (error.code === 'EEXIST') {
        // for some reason the client directory is sometimes a file
        // if so, this happens. Delete it and recreate
        await fs.remove(this.clientRoot)
        await fs.mkdirp(this.clientRoot)
      } else {
        throw error
      }
    }
  }

  // touch the client so it won't be tidied up right away
  protected async touch() {
    try {
      const p = path.join(this.clientRoot, this.command.config.version)
      this.debug('Touching client at', p)
      if (!await fs.pathExists(p)) return
      await fs.utimes(p, new Date(), new Date())
    } catch (error) {
      this.warn(error)
    }
  }
}
