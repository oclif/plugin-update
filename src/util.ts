import * as fs from 'fs'
import * as path from 'path'

export async function touch(p: string): Promise<void> {
  try {
    await fs.promises.utimes(p, new Date(), new Date())
  } catch {
    await fs.promises.mkdir(path.dirname(p), {recursive: true})
    await fs.promises.writeFile(p, '')
  }
}

export async function ls(
  dir: string,
): Promise<Array<{ path: string; stat: fs.Stats }>> {
  const files = await fs.promises.readdir(dir)
  const paths = files.map(f => path.join(dir, f))
  return Promise.all(
    paths.map(path => fs.promises.stat(path).then(stat => ({path, stat}))),
  )
}

export function wait(ms: number, unref = false): Promise<void> {
  return new Promise(resolve => {
    const t: any = setTimeout(() => resolve(), ms)
    if (unref) t.unref()
  })
}
