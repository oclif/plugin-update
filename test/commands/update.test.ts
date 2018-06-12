import {expect} from 'chai'
import * as path from 'path'
import * as qq from 'qqjs'

const skipIfWindows = process.platform === 'win32' ? it.skip : it

describe('update', () => {
  skipIfWindows('tests the updater', async () => {
    await qq.rm([process.env.HOME!, '.local', 'share', 'oclif-example-s3-cli'])
    await qq.x('aws s3 rm --recursive s3://oclif-staging/s3-update-example-cli')
    const sha = await qq.x.stdout('git', ['rev-parse', '--short', 'HEAD'])
    const stdout = await qq.x.stdout('npm', ['pack', '--unsafe-perm'])
    const tarball = path.resolve(stdout.split('\n').pop()!)

    qq.cd('examples/s3-update-example-cli')
    process.env.EXAMPLE_CLI_DISABLE_AUTOUPDATE = '1'
    process.env.YARN_CACHE_FOLDER = path.resolve('tmp', 'yarn')
    await qq.rm(process.env.YARN_CACHE_FOLDER)
    const pjson = await qq.readJSON('package.json')
    pjson.oclif.bin = pjson.name = `s3-update-example-cli-${Math.floor(Math.random() * 100000)}`
    delete pjson.dependencies['@oclif/plugin-update']
    await qq.writeJSON('package.json', pjson)

    await qq.rm('yarn.lock')
    await qq.x(`yarn add ${tarball}`)
    // await qq.x('yarn')

    const release = async (version: string) => {
      const pjson = await qq.readJSON('package.json')
      pjson.version = version
      await qq.writeJSON('package.json', pjson)
      await qq.x('./node_modules/.bin/oclif-dev pack')
      await qq.x('./node_modules/.bin/oclif-dev publish')
    }
    const checkVersion = async (version: string, nodeVersion = pjson.oclif.update.node.version) => {
      const stdout = await qq.x.stdout(`./tmp/${pjson.oclif.bin}/bin/${pjson.oclif.bin}`, ['version'])
      expect(stdout).to.equal(`${pjson.oclif.bin}/${version} ${process.platform}-${process.arch} node-v${nodeVersion}`)
    }
    const update = async (channel?: string) => {
      const f = `tmp/${pjson.oclif.bin}/package.json`
      const pj = await qq.readJSON(f)
      pj.version = '0.0.0'
      await qq.writeJSON(f, pj)
      const args = ['update']
      if (channel) args.push(channel)
      await qq.x(`./tmp/${pjson.oclif.bin}/bin/${pjson.oclif.bin}`, args)
    }
    await release('1.0.0')
    await checkVersion('1.0.0', process.versions.node)
    await release('2.0.0-beta')
    await checkVersion(`2.0.0-beta.${sha}`, process.versions.node)
    await update()
    await checkVersion('1.0.0')
    await release('1.0.1')
    await checkVersion('1.0.0')
    await update()
    await checkVersion('1.0.1')
    await update()
    await checkVersion('1.0.1')
    await update('beta')
    await checkVersion(`2.0.0-beta.${sha}`)
    await release('2.0.1-beta')
    await checkVersion(`2.0.0-beta.${sha}`)
    await update()
    await checkVersion(`2.0.1-beta.${sha}`)
    await update()
    await checkVersion(`2.0.1-beta.${sha}`)
    await release('1.0.3')
    await update()
    await checkVersion(`2.0.1-beta.${sha}`)
    await update('stable')
    await checkVersion('1.0.3')
  })
})
