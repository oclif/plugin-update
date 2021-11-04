import {expect} from 'chai'
import * as path from 'node:path'
import * as shelljs from 'shelljs'
import * as fs from 'fs-extra'
const skipIfWindows = process.platform === 'win32' ? it.skip : it

describe.skip('update', () => {
  skipIfWindows('tests the updater', async () => {
    await shelljs.rm([process.env.HOME!, '.local', 'share', 'oclif-example-s3-cli'])
    await shelljs.exec('aws s3 rm --recursive s3://oclif-staging/s3-update-example-cli')
    const sha = await shelljs.exec('git rev-parse --short HEAD').stdout
    const stdout = await shelljs.exec('npm pack --unsafe-perm').stdout
    const tarball = path.resolve(stdout.split('\n').pop()!)

    shelljs.cd('examples/s3-update-example-cli')
    process.env.EXAMPLE_CLI_DISABLE_AUTOUPDATE = '1'
    process.env.YARN_CACHE_FOLDER = path.resolve('tmp', 'yarn')
    await shelljs.rm(process.env.YARN_CACHE_FOLDER)
    const pjson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    pjson.name = `s3-update-example-cli-${Math.floor(Math.random() * 100_000)}`
    pjson.oclif.bin = pjson.name
    delete pjson.dependencies['@oclif/plugin-update']
    fs.writeFileSync('package.json', JSON.stringify(pjson, undefined, 2))

    await shelljs.rm('yarn.lock')
    await shelljs.exec(`yarn add ${tarball}`)
    // await shelljs.exec('yarn')

    const release = async (version: string) => {
      const pjson = await JSON.parse(fs.readFileSync('package.json', 'utf8'))
      pjson.version = version
      fs.writeFileSync('package.json', JSON.stringify(pjson, undefined, 2))
      await shelljs.exec('./node_modules/.bin/oclif-dev pack')
      await shelljs.exec('./node_modules/.bin/oclif-dev publish')
    }

    const checkVersion = async (version: string, nodeVersion = pjson.oclif.update.node.version) => {
      const stdout = await shelljs.exec(`./tmp/${pjson.oclif.bin}/bin/${pjson.oclif.bin} 'version'`).stdout
      expect(stdout).to.equal(`${pjson.oclif.bin}/${version} ${process.platform}-${process.arch} node-v${nodeVersion}`)
    }

    const update = async (channel?: string) => {
      const f = `tmp/${pjson.oclif.bin}/package.json`
      const pj = JSON.parse(fs.readFileSync(f, 'utf8'))
      pj.version = '0.0.0'
      fs.writeFileSync(f, JSON.stringify(pj, undefined, 2))
      const args = ['update']
      if (channel) args.push(channel)
      await shelljs.exec(`./tmp/${pjson.oclif.bin}/bin/${pjson.oclif.bin} ${args.join(' ')}`)
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
