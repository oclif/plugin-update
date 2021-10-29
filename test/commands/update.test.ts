import {expect, test, FancyTypes} from '@oclif/test'
import * as path from 'path'
import * as nock from 'nock'
import * as zlib from 'zlib'
import * as fs from 'fs-extra'
import UpdateCommand from '../../src/commands/update'
import {IConfig} from '@oclif/config'

function setupClientRoot<O>(ctx: { config: IConfig } & { stubs: any[] } & FancyTypes.Context & O, createVersion?: string) {
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

describe('update', () => {
  const rootDir = path.join(process.cwd(), 'examples', 's3-update-example-cli')
  let clientRoot: string
  beforeEach(() => {
    if (!nock.isActive()) {
      nock.activate()
    }
  })
  afterEach(() => {
    nock.cleanAll()
    nock.restore()
    if (fs.pathExistsSync(clientRoot)) {
      fs.remove(clientRoot)
    }
  })
  test
  .stub(UpdateCommand.prototype, 'reexec', async () => {})
  .env({EXAMPLE_CLI_BINPATH: 'foobarbaz'})
  .loadConfig({root: path.join(process.cwd(), 'examples', 's3-update-example-cli')})
  .do(ctx => {
    clientRoot = setupClientRoot(ctx, '2.0.0')
    nock(/oclif-staging.s3.amazonaws.com/)
    .get(/tarballs\/example-cli\/darwin-x64/)
    .reply(200, {version: '2.0.0'})
    .get(/channels\/stable\/example-cli-darwin-x64-buildmanifest/)
    .reply(200, {version: '2.0.0'})
  })
  .stdout()
  .stderr()
  .command(['update'])
  .it('should not update - already on same version', ctx => {
    expect(ctx.stderr).to.include('already on latest version')
  })

  test
  .stub(UpdateCommand.prototype, 'reexec', async () => {})
  .loadConfig({root: path.join(process.cwd(), 'examples', 's3-update-example-cli')})
  .do(() => {
    nock(/oclif-staging.s3.amazonaws.com/)
    .get(/tarballs\/example-cli\/darwin-x64/)
    .reply(200, {version: '2.0.0'})
    .get(/channels\/stable\/example-cli-darwin-x64-buildmanifest/)
    .reply(200, {version: '2.0.0'})
  })
  .stdout()
  .stderr()
  .command(['update'])
  .it('should not update - not updatable', ctx => {
    expect(ctx.stderr).to.include('not updatable')
  })
  test
  .stub(UpdateCommand.prototype, 'reexec', async () => {})
  .env({EXAMPLE_CLI_BINPATH: 'foobarbaz'})
  .loadConfig({root: rootDir})
  .do(ctx => {
    clientRoot = setupClientRoot(ctx, '2.0.0')
    const message = 'Lorem ipsum dolor sit amet'
    const compressedMessage = zlib.gzipSync(message).toString()
    nock(/oclif-staging.s3.amazonaws.com/)
    .get(/tarballs\/example-cli\/darwin-x64/)
    .reply(200, {version: '2.0.0'})
    .get(/channels\/stable\/example-cli-darwin-x64-buildmanifest/)
    .reply(200, {version: '2.0.1'})
    .get(/tarballs\/example-cli\/example-cli-v2.0.1\/example-cli-v2.0.1-darwin-x64gz/)
    .reply(200, compressedMessage, {
      'X-Transfer-Length': String(compressedMessage.length),
      'Content-Encoding': 'gzip',
    })
  })
  .stdout()
  .stderr()
  .command(['update'])
  .it('should update', ctx => {
    expect(ctx.stderr).to.include('Updating CLI from 2.0.0 to 2.0.1')
  })
  test
  .stub(UpdateCommand.prototype, 'reexec', async () => {})
  .env({EXAMPLE_CLI_BINPATH: 'foobarbaz', EXAMPLE_CLI_USE_LEGACY_UPDATE: 'true'})
  .loadConfig({root: rootDir})
  .do(ctx => {
    clientRoot = setupClientRoot(ctx, '2.0.0')
    const message = 'Lorem ipsum dolor sit amet'
    const compressedMessage = zlib.gzipSync(message).toString()
    nock(/oclif-staging.s3.amazonaws.com/)
    .get(/tarballs\/example-cli\/darwin-x64/)
    .reply(200, {version: '2.0.1'})
    .get(/channels\/stable\/example-cli-darwin-x64-buildmanifest/)
    .reply(200, {version: '2.0.1'})
    .get(/tarballs\/example-cli\/example-cli-v2.0.1\/example-cli-v2.0.1-darwin-x64gz/)
    .reply(200, compressedMessage, {
      'X-Transfer-Length': String(compressedMessage.length),
      'Content-Encoding': 'gzip',
    })
  })
  .stdout()
  .stderr()
  .command(['update'])
  .it('should update with legacy update', ctx => {
    expect(ctx.stderr).to.include('Updating CLI from 2.0.0 to 2.0.1')
  })
  test
  .stub(UpdateCommand.prototype, 'reexec', async () => {})
  .stub(UpdateCommand.prototype, 'getPinToVersion', async () => '2.0.1')
  .stub(fs, 'readdirSync', () => {
    return ['2.0.0', '2.0.1']
  })
  .stub(fs, 'pathExists', async () => true)
  .env({EXAMPLE_CLI_BINPATH: 'foobarbaz'})
  .loadConfig({root: rootDir})
  .do(ctx => {
    clientRoot = setupClientRoot(ctx)
    const message = 'Lorem ipsum dolor sit amet'
    const compressedMessage = zlib.gzipSync(message).toString()
    nock(/oclif-staging.s3.amazonaws.com/)
    .get(/tarballs\/example-cli\/darwin-x64/)
    .reply(200, {version: '2.0.0'})
    .get(/channels\/stable\/example-cli-darwin-x64-buildmanifest/)
    .reply(200, {version: '2.0.1'})
    .get(/tarballs\/example-cli\/example-cli-v2.0.1\/example-cli-v2.0.1-darwin-x64gz/)
    .reply(200, compressedMessage, {
      'X-Transfer-Length': String(compressedMessage.length),
      'Content-Encoding': 'gzip',
    })
  })
  .stdout()
  .stderr()
  .command(['update', '--from-local'])
  .it('should update from local file', ctx => {
    expect(ctx.stderr).to.include('Updating CLI...')
  })
})
