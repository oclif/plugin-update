import {readdir, stat, writeFile, utimes} from 'node:fs/promises'
import {Stats} from 'node:fs'
import {join} from 'node:path'

export async function touch(p: string): Promise<void> {
  try {
    await utimes(p, new Date(), new Date())
  } catch {
    await writeFile(p, '')
  }
}

export async function ls(dir: string): Promise<Array<{path: string, stat: Stats}>> {
  const files = await readdir(dir)
  const paths = files.map(f => join(dir, f))
  return Promise.all(paths.map(path => stat(path).then(s => ({path, stat: s}))))
}

export function wait(ms: number, unref = false): Promise<void> {
  return new Promise(resolve => {
    const t: any = setTimeout(() => resolve(), ms)
    if (unref) t.unref()
  })
}
