import * as fs from 'fs-extra'
import * as path from 'path'
import * as Semver from 'semver'

export function minorVersionGreater(fromString: string, toString: string): boolean {
  const semver: typeof Semver = require('semver')
  const from = semver.parse(fromString)!
  const to = semver.parse(toString)!
  if (from.major < to.major) return true
  if (from.major === to.major && from.minor < to.minor) return true
  return false
}

export async function touch(p: string) {
  try {
    await fs.utimes(p, new Date(), new Date())
  } catch {
    await fs.outputFile(p, '')
  }
}

export async function ls(dir: string) {
  let files = await fs.readdir(dir)
  let paths = files.map(f => path.join(dir, f))
  return Promise.all(paths.map(path => fs.stat(path).then(stat => ({path, stat}))))
}

export function wait(ms: number, unref: boolean = false): Promise<void> {
  return new Promise(resolve => {
    let t: any = setTimeout(() => resolve(), ms)
    if (unref) t.unref()
  })
}
