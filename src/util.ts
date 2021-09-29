import * as path from 'path'

import * as fs from 'fs-extra'

export async function touch(p: string) {
  try {
    await fs.utimes(p, new Date(), new Date())
  } catch {
    await fs.outputFile(p, '')
  }
}

export async function ls(dir: string) {
  const files = await fs.readdir(dir)
  const paths = files.map(f => path.join(dir, f))
  return Promise.all(paths.map(path => fs.stat(path).then(stat => ({path, stat}))))
}

export function wait(ms: number, unref = false): Promise<void> {
  return new Promise(resolve => {
    const t: any = setTimeout(() => resolve(), ms)
    if (unref) t.unref()
  })
}
