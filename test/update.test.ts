import * as fse from 'fs-extra'
import {existsSync} from 'node:fs'
import {writeFile, rm, mkdir} from 'node:fs/promises'

import * as path from 'path'
import {Config, ux} from '@oclif/core'
import {Config as IConfig} from '@oclif/core/lib/interfaces'
import {Updater} from '../src/update'
import * as zlib from 'zlib'
import nock from 'nock'
import * as sinon from 'sinon'
import stripAnsi = require('strip-ansi')
import * as extract from '../src/tar'
import {expect} from 'chai'
import HTTP from 'http-call'

type OutputCollectors = {
  stdout: string[];
  stderr: string[];
}
async function loadConfig(options: {root: string}): Promise<IConfig> {
  return Config.load(options.root)
}

const  setupClientRoot = async (ctx: { config: IConfig }, createVersion?: string): Promise<string> => {
  const clientRoot = ctx.config.scopedEnvVar('OCLIF_CLIENT_HOME') || path.join(ctx.config.dataDir, 'client')
  // Ensure installed version structure is present
  await mkdir(clientRoot, {recursive: true})
  if (createVersion) {
    await mkdir(path.join(clientRoot, 'bin'), {recursive: true})
    fse.ensureFileSync(path.join(clientRoot, '2.0.0'))
    fse.ensureSymlinkSync(path.join(clientRoot, '2.0.0'), path.join(clientRoot, 'current'))
    await writeFile(path.join(clientRoot, 'bin', ctx.config.bin), '../2.0.0/bin', 'utf8')
  }

  return clientRoot
}

function initUpdater(config: Config): Updater {
  const updater = new Updater(config)
  expect(updater).to.be.ok
  return updater
}

describe('update plugin', () => {
  let config: Config
  let updater: Updater
  let collector: OutputCollectors
  let clientRoot: string

  const sandbox = sinon.createSandbox()

  beforeEach(async () => {
    config = await loadConfig({root: path.join(process.cwd(), 'examples', 's3-update-example-cli')}) as Config
    config.binPath = config.binPath || config.bin
    collector = {stdout: [], stderr: []}
    sandbox.stub(ux, 'log').callsFake(line => collector.stdout.push(line || ''))
    sandbox.stub(ux, 'warn').callsFake(line => collector.stderr.push(line ? `${line}` : ''))
    sandbox.stub(ux.action, 'start').callsFake(line => collector.stdout.push(line || ''))
    sandbox.stub(ux.action, 'stop').callsFake(line => collector.stdout.push(line || ''))
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    sandbox.stub(Updater.prototype, 'refreshConfig').resolves()
  })

  afterEach(async () => {
    nock.cleanAll()
    if (existsSync(clientRoot)) {
      await rm(clientRoot, {recursive: true, force: true})
    }

    sandbox.restore()
  })

  it('should not update - already on same version', async () => {
    clientRoot = await setupClientRoot({config}, '2.0.0')
    const platformRegex = new RegExp(`tarballs\\/example-cli\\/${config.platform}-${config.arch}`)
    const manifestRegex = new RegExp(`channels\\/stable\\/example-cli-${config.platform}-${config.arch}-buildmanifest`)
    nock(/oclif-staging.s3.amazonaws.com/)
    .get(platformRegex)
    .reply(200, {version: '2.0.0'})
    .get(manifestRegex)
    .reply(200, {version: '2.0.0'})

    updater = initUpdater(config)
    await updater.runUpdate({autoUpdate: false})
    const stdout = collector.stdout.join(' ')
    expect(stdout).to.include('already on version 2.0.0')
  })

  it('should update to channel', async () => {
    clientRoot = await setupClientRoot({config})
    const platformRegex = new RegExp(`tarballs\\/example-cli\\/${config.platform}-${config.arch}`)
    const manifestRegex = new RegExp(`channels\\/stable\\/example-cli-${config.platform}-${config.arch}-buildmanifest`)
    const tarballRegex = new RegExp(`tarballs\\/example-cli\\/example-cli-v2.0.1\\/example-cli-v2.0.1-${config.platform}-${config.arch}gz`)
    const newVersionPath = path.join(clientRoot, '2.0.1')
    await mkdir(path.join(`${newVersionPath}.partial.11111`, 'bin'), {recursive: true})
    // await writeFile(path.join(`${newVersionPath}.partial.11111`, 'bin', 'example-cli'), '../2.0.1/bin', 'utf8')
    fse.writeFileSync(path.join(`${newVersionPath}.partial.11111`, 'bin', 'example-cli'), '../2.0.1/bin', 'utf8')

    sandbox.stub(extract, 'extract').resolves()
    sandbox.stub(zlib, 'gzipSync').returns(Buffer.alloc(1, ' '))

    const gzContents = zlib.gzipSync(' ')

    nock(/oclif-staging.s3.amazonaws.com/)
    .get(platformRegex)
    .reply(200, {version: '2.0.1'})
    .get(manifestRegex)
    .reply(200, {version: '2.0.1'})
    .get(tarballRegex)
    .reply(200, gzContents, {
      'X-Transfer-Length': String(gzContents.length),
      'content-length': String(gzContents.length),
      'Content-Encoding': 'gzip',
    })

    updater = initUpdater(config)
    await updater.runUpdate({autoUpdate: false})
    const stdout = stripAnsi(collector.stdout.join(' '))
    expect(stdout).to.matches(/Updating CLI from 2.0.0 to 2.0.1/)
  })

  it('should update to version', async () => {
    const hash = 'f289627'
    clientRoot = await setupClientRoot({config})
    const platformRegex = new RegExp(`tarballs\\/example-cli\\/${config.platform}-${config.arch}`)
    const manifestRegex = new RegExp(`channels\\/stable\\/example-cli-${config.platform}-${config.arch}-buildmanifest`)
    const versionManifestRegex = new RegExp(`example-cli-v2.0.1-${hash}-${config.platform}-${config.arch}-buildmanifest`)
    const tarballRegex = new RegExp(`tarballs\\/example-cli\\/example-cli-v2.0.1\\/example-cli-v2.0.1-${config.platform}-${config.arch}gz`)
    const indexRegex = new RegExp(`example-cli-${config.platform}-${config.arch}-tar-gz.json`)

    sandbox.stub(extract, 'extract').resolves()
    sandbox.stub(zlib, 'gzipSync').returns(Buffer.alloc(1, ' '))

    const gzContents = zlib.gzipSync(' ')

    nock(/oclif-staging.s3.amazonaws.com/)
    .get(platformRegex)
    .reply(200, {version: '2.0.1'})
    .get(manifestRegex)
    .reply(200, {version: '2.0.1'})
    .get(versionManifestRegex)
    .reply(200, {version: '2.0.1'})
    .get(tarballRegex)
    .reply(200, gzContents, {
      'X-Transfer-Length': String(gzContents.length),
      'content-length': String(gzContents.length),
      'Content-Encoding': 'gzip',
    })
    .get(indexRegex)
    .reply(200, {
      '2.0.1': `versions/example-cli/2.0.1/${hash}/example-cli-v2.0.1-${config.platform}-${config.arch}.gz`,
    })

    updater = initUpdater(config)
    await updater.runUpdate({autoUpdate: false, version: '2.0.1'})
    const stdout = stripAnsi(collector.stdout.join(' '))
    expect(stdout).to.matches(/Updating CLI from 2.0.0 to 2.0.1/)
  })

  it('will get the correct channel and use default registry', async () => {
    const request = sandbox.spy(HTTP,  'get')
    const hash = 'f289627'
    config.pjson.name = '@oclif/plugin-update'
    clientRoot = await setupClientRoot({config})
    const platformRegex = new RegExp(`tarballs\\/example-cli\\/${config.platform}-${config.arch}`)
    const manifestRegex = new RegExp(`channels\\/stable\\/example-cli-${config.platform}-${config.arch}-buildmanifest`)
    const versionManifestRegex = new RegExp(`example-cli-v2.0.1-${hash}-${config.platform}-${config.arch}-buildmanifest`)
    const tarballRegex = new RegExp(`tarballs\\/example-cli\\/example-cli-v2.0.1\\/example-cli-v2.0.1-${config.platform}-${config.arch}gz`)
    const indexRegex = new RegExp(`example-cli-${config.platform}-${config.arch}-tar-gz.json`)

    sandbox.stub(extract, 'extract').resolves()
    sandbox.stub(zlib, 'gzipSync').returns(Buffer.alloc(1, ' '))

    const gzContents = zlib.gzipSync(' ')

    nock(/oclif-staging.s3.amazonaws.com/)
    .get(platformRegex)
    .reply(200, {version: '2.0.1'})
    .get(manifestRegex)
    .reply(200, {version: '2.0.1'})
    .get(versionManifestRegex)
    .reply(200, {version: '2.0.1'})
    .get(tarballRegex)
    .reply(200, gzContents, {
      'X-Transfer-Length': String(gzContents.length),
      'content-length': String(gzContents.length),
      'Content-Encoding': 'gzip',
    })
    .get(indexRegex)
    .reply(200, {
      '2.0.1': `versions/example-cli/2.0.1/${hash}/example-cli-v2.0.1-${config.platform}-${config.arch}.gz`,
    })

    updater = initUpdater(config)
    await updater.runUpdate({autoUpdate: false, version: '2.0.1'})
    expect(request.callCount).to.equal(3)
    expect(request.firstCall.args[0]).to.include('https://registry.npmjs.org/@oclif/plugin-update')
  })
  it('will get the correct channel and use a custom registry', async () => {
    const request = sandbox.spy(HTTP,  'get')
    const hash = 'f289627'
    config.pjson.name = '@oclif/plugin-update'
    config.npmRegistry = 'https://myCustomRegistry.com'
    clientRoot = await setupClientRoot({config})
    const platformRegex = new RegExp(`tarballs\\/example-cli\\/${config.platform}-${config.arch}`)
    const manifestRegex = new RegExp(`channels\\/stable\\/example-cli-${config.platform}-${config.arch}-buildmanifest`)
    const versionManifestRegex = new RegExp(`example-cli-v2.0.1-${hash}-${config.platform}-${config.arch}-buildmanifest`)
    const tarballRegex = new RegExp(`tarballs\\/example-cli\\/example-cli-v2.0.1\\/example-cli-v2.0.1-${config.platform}-${config.arch}gz`)
    const indexRegex = new RegExp(`example-cli-${config.platform}-${config.arch}-tar-gz.json`)

    sandbox.stub(extract, 'extract').resolves()
    sandbox.stub(zlib, 'gzipSync').returns(Buffer.alloc(1, ' '))

    const gzContents = zlib.gzipSync(' ')

    nock(/oclif-staging.s3.amazonaws.com/)
    .get(platformRegex)
    .reply(200, {version: '2.0.1'})
    .get(manifestRegex)
    .reply(200, {version: '2.0.1'})
    .get(versionManifestRegex)
    .reply(200, {version: '2.0.1'})
    .get(tarballRegex)
    .reply(200, gzContents, {
      'X-Transfer-Length': String(gzContents.length),
      'content-length': String(gzContents.length),
      'Content-Encoding': 'gzip',
    })
    .get(indexRegex)
    .reply(200, {
      '2.0.1': `versions/example-cli/2.0.1/${hash}/example-cli-v2.0.1-${config.platform}-${config.arch}.gz`,
    })

    updater = initUpdater(config)
    await updater.runUpdate({autoUpdate: false, version: '2.0.1'})
    expect(request.callCount).to.equal(3)
    expect(request.firstCall.args[0]).to.include('https://myCustomRegistry.com/@oclif/plugin-update')
  })

  it('should not update - not updatable', async () => {
    clientRoot = await setupClientRoot({config})
    // unset binPath
    config.binPath = undefined
    nock(/oclif-staging.s3.amazonaws.com/)
    .get(/tarballs\/example-cli\/.+?/)
    .reply(200, {version: '2.0.0'})
    .get(/channels\/stable\/example-cli-.+?-buildmanifest/)
    .reply(200, {version: '2.0.0'})

    updater = initUpdater(config)
    await updater.runUpdate({autoUpdate: false})
    const stdout = collector.stdout.join(' ')
    expect(stdout).to.include('not updatable')
  })

  it('should update from local file', async () => {
    clientRoot = await setupClientRoot({config})
    const platformRegex = new RegExp(`tarballs\\/example-cli\\/${config.platform}-${config.arch}`)
    const manifestRegex = new RegExp(`channels\\/stable\\/example-cli-${config.platform}-${config.arch}-buildmanifest`)
    const tarballRegex = new RegExp(`tarballs\\/example-cli\\/example-cli-v2.0.0\\/example-cli-v2.0.1-${config.platform}-${config.arch}gz`)
    const newVersionPath = path.join(clientRoot, '2.0.1')
    await mkdir(path.join(newVersionPath, 'bin'), {recursive: true})
    await mkdir(path.join(`${newVersionPath}.partial.11111`, 'bin'), {recursive: true})
    await writeFile(path.join(`${newVersionPath}.partial.11111`, 'bin', 'example-cli'), '../2.0.1/bin', 'utf8')
    await writeFile(path.join(newVersionPath, 'bin', 'example-cli'), '../2.0.1/bin', 'utf8')
    sandbox.stub(extract, 'extract').resolves()
    sandbox.stub(zlib, 'gzipSync').returns(Buffer.alloc(1, ' '))

    const gzContents = zlib.gzipSync(' ')

    nock(/oclif-staging.s3.amazonaws.com/)
    .get(platformRegex)
    .reply(200, {version: '2.0.1'})
    .get(manifestRegex)
    .reply(200, {version: '2.0.1'})
    .get(tarballRegex)
    .reply(200, gzContents, {
      'X-Transfer-Length': String(gzContents.length),
      'content-length': String(gzContents.length),
      'Content-Encoding': 'gzip',
    })

    updater = initUpdater(config)
    await updater.runUpdate({autoUpdate: false, version: '2.0.1'})
    const stdout = stripAnsi(collector.stdout.join(' '))
    expect(stdout).to.matches(/Updating to a specific version will not update the channel/)
  })
})
