import * as Config from '@oclif/config'
import cli from 'cli-ux'

import {Updater} from '../update'

export const init: Config.Hook<'init'> = async function (opts) {
  cli.config.errlog = opts.config.errlog
  if (opts.id === 'update') return
  const updater = new Updater(opts.config)
  await updater.autoupdate()
}
