import * as fs from 'fs-extra'
import * as path from 'path'

export async function touch(p: string): Promise<void> {
  try {
    await fs.utimes(p, new Date(), new Date())
  } catch {
    await fs.outputFile(p, '')
  }
}

export async function ls(dir: string): Promise<Array<{path: string, stat: fs.Stats}>> {
  const files = await fs.readdir(dir)
  const paths = files.map(f => path.join(dir, f))
  return Promise.all(paths.map(path => fs.stat(path).then(stat => ({path, stat}))))
}

export async function rm(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.rm(dir, {recursive: true}, (err: Error | null) => {
      if (err) reject(err)
      resolve()
    })
  })
}

export function wait(ms: number, unref = false): Promise<void> {
  return new Promise(resolve => {
    const t: any = setTimeout(() => resolve(), ms)
    if (unref) t.unref()
  })
}
