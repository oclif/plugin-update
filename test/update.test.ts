import * as fs from 'fs-extra'
import * as path from 'path'
import {Config} from '@oclif/core'
import {Config as IConfig} from '@oclif/core/lib/interfaces'
import {expect} from '@oclif/test'
import UpdateCli from '../src/update'
import {Options} from 'cli-ux/lib/action/base'
import * as zlib from 'zlib'
import * as nock from 'nock'
import * as getStream from 'get-stream'
import * as tar from 'tar-fs'
import * as sinon from 'sinon'
import stripAnsi = require('strip-ansi')
import {Tar} from '../src/tar'

type OutputCollectors = {
  stdout: string[];
  stderr: string[];
}
async function loadConfig(options: {root: string}): Promise<IConfig> {
  const config = await Config.load(options.root)
  return config
}

function setupClientRoot(ctx: { config: IConfig }, createVersion?: string): string {
  const clientRoot = ctx.config.scopedEnvVar('OCLIF_CLIENT_HOME') || path.join(ctx.config.dataDir, 'client')
  // Ensure installed version structure is present
  fs.ensureDirSync(clientRoot)
  if (createVersion) {
    fs.ensureDirSync(path.join(clientRoot, 'bin'))
    fs.ensureFileSync(path.join(clientRoot, '2.0.0'))
    fs.ensureSymlinkSync(path.join(clientRoot, '2.0.0'), path.join(clientRoot, 'current'))
    fs.writeFileSync(path.join(clientRoot, 'bin', ctx.config.bin), '../2.0.0/bin', 'utf8')
  }

  return clientRoot
}

function initUpdateCli(options: {args: {[p: string]: any}; flags: {[p: string]: any}; config: Config; collector: OutputCollectors}): UpdateCli {
  const updateCli = new UpdateCli({args: options.args, flags: options.flags, config: options.config, exit: undefined, getPinToVersion: async () => '2.0.0'})
  expect(updateCli).to.be.ok
  updateCli
  .on('debug', () => {
  })
  .on('warn', (input: string | Error) => {
    options.collector.stderr.push(input.toString())
  })
  .on('log', (...args: any) => {
    options.collector.stdout.push([...args].map(v => v.toString()).join(' '))
  })
  .on('action.start', (action: string, status?: string | undefined, opts?: Options) => {
    options.collector.stdout.push(`${action} ${status || ''}, ${opts || ''}`)
  })
  .on('action.stop', (msg?: string | undefined) => {
    options.collector.stdout.push(msg || '')
  })
  .on('action.status', (status: string | undefined) => {
    options.collector.stdout.push(status || '')
  })
  return updateCli
}

describe('update plugin', () => {
  let config: IConfig
  let updateCli: UpdateCli
  let collector: OutputCollectors
  let clientRoot: string
  let sandbox: sinon.SinonSandbox

  beforeEach(async () => {
    config = await loadConfig({root: path.join(process.cwd(), 'examples', 's3-update-example-cli')})
    config.binPath = config.binPath || config.bin
    collector = {stdout: [], stderr: []}
    sandbox = sinon.createSandbox()
  })
  afterEach(() => {
    nock.cleanAll()
    if (fs.pathExistsSync(clientRoot)) {
      fs.removeSync(clientRoot)
    }
    sandbox.restore()
  })
  it('should not update - already on same version', async () => {
    clientRoot = setupClientRoot({config}, '2.0.0')
    const platformRegex = new RegExp(`tarballs\\/example-cli\\/${config.platform}-${config.arch}`)
    const manifestRegex = new RegExp(`channels\\/stable\\/example-cli-${config.platform}-${config.arch}-buildmanifest`)
    nock(/oclif-staging.s3.amazonaws.com/)
    .get(platformRegex)
    .reply(200, {version: '2.0.0'})
    .get(manifestRegex)
    .reply(200, {version: '2.0.0'})

    sandbox.stub(UpdateCli.prototype, 'reexec' as any).resolves()

    updateCli = initUpdateCli({args: {}, flags: {}, config: config as Config, collector: collector})
    await updateCli.runUpdate()
    const stdout = collector.stdout.join(' ')
    expect(stdout).to.include('already on latest version')
  })
  it('should update', async () => {
    clientRoot = setupClientRoot({config})
    const platformRegex = new RegExp(`tarballs\\/example-cli\\/${config.platform}-${config.arch}`)
    const manifestRegex = new RegExp(`channels\\/stable\\/example-cli-${config.platform}-${config.arch}-buildmanifest`)
    const tarballRegex = new RegExp(`tarballs\\/example-cli\\/example-cli-v2.0.1\\/example-cli-v2.0.1-${config.platform}-${config.arch}gz`)
    const newVersionPath = path.join(clientRoot, '2.0.1')
    // fs.mkdirpSync(path.join(newVersionPath, 'bin'))
    fs.mkdirpSync(path.join(`${newVersionPath}.partial.11111`, 'bin'))
    fs.writeFileSync(path.join(`${newVersionPath}.partial.11111`, 'bin', 'example-cli'), '../2.0.1/bin', 'utf8')
    // fs.writeFileSync(path.join(newVersionPath, 'bin', 'example-cli'), '../2.0.1/bin', 'utf8')
    const gzContents = zlib.gzipSync(await getStream(tar.pack(config.root, {finalize: true})))

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

    sandbox.stub(UpdateCli.prototype, 'reexec' as any).resolves()
    sandbox.stub(Tar, 'extract').resolves()

    updateCli = initUpdateCli({args: {}, flags: {}, config: config as Config, collector: collector})
    await updateCli.runUpdate()
    const stdout = stripAnsi(collector.stdout.join(' '))
    expect(stdout).to.matches(/Updating CLI from 2.0.0 to 2.0.1/)
  })
  it('should not update - not updatable', async () => {
    clientRoot = setupClientRoot({config})
    // unset binPath
    config.binPath = undefined
    nock(/oclif-staging.s3.amazonaws.com/)
    .get(/tarballs\/example-cli\/.+?/)
    .reply(200, {version: '2.0.0'})
    .get(/channels\/stable\/example-cli-.+?-buildmanifest/)
    .reply(200, {version: '2.0.0'})

    sandbox.stub(UpdateCli.prototype, 'reexec' as any).resolves()

    updateCli = initUpdateCli({args: {}, flags: {}, config: config as Config, collector: collector})
    await updateCli.runUpdate()
    const stdout = collector.stdout.join(' ')
    expect(stdout).to.include('not updatable')
  })
  it('should update from local file', async () => {
    clientRoot = setupClientRoot({config})
    const platformRegex = new RegExp(`tarballs\\/example-cli\\/${config.platform}-${config.arch}`)
    const manifestRegex = new RegExp(`channels\\/stable\\/example-cli-${config.platform}-${config.arch}-buildmanifest`)
    const tarballRegex = new RegExp(`tarballs\\/example-cli\\/example-cli-v2.0.1\\/example-cli-v2.0.0-${config.platform}-${config.arch}gz`)
    const newVersionPath = path.join(clientRoot, '2.0.0')
    fs.mkdirpSync(path.join(newVersionPath, 'bin'))
    fs.mkdirpSync(path.join(`${newVersionPath}.partial.11111`, 'bin'))
    fs.writeFileSync(path.join(`${newVersionPath}.partial.11111`, 'bin', 'example-cli'), '../2.0.0/bin', 'utf8')
    fs.writeFileSync(path.join(newVersionPath, 'bin', 'example-cli'), '../2.0.0/bin', 'utf8')
    const gzContents = zlib.gzipSync(await getStream(tar.pack(config.root, {finalize: true})))

    nock(/oclif-staging.s3.amazonaws.com/)
    .get(platformRegex)
    .reply(200, {version: '2.0.0'})
    .get(manifestRegex)
    .reply(200, {version: '2.0.0'})
    .get(tarballRegex)
    .reply(200, gzContents, {
      'X-Transfer-Length': String(gzContents.length),
      'content-length': String(gzContents.length),
      'Content-Encoding': 'gzip',
    })

    sandbox.stub(UpdateCli.prototype, 'reexec' as any).resolves()

    updateCli = initUpdateCli({args: {}, flags: {'from-local': true}, config: config as Config, collector: collector})
    await updateCli.runUpdate()
    const stdout = stripAnsi(collector.stdout.join(' '))
    expect(stdout).to.matches(/Updating to an already installed version will not update the channel/)
  })
})
