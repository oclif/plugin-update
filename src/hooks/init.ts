import * as Config from '@oclif/config'

import {Updater} from '../update'

export const init: Config.Hook<'init'> = async function (opts) {
  const updater = new Updater(opts.config)
  await updater.autoupdate()
}
