import CommandsUpdate from './commands/update.js'
import {init} from './hooks/init.js'

export const commands = {
  update: CommandsUpdate,
}

export const hooks = {
  init,
}
