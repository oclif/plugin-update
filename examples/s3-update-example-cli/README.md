s3-update-example-cli
=====================



[![Version](https://img.shields.io/npm/v/s3-update-example-cli.svg)](https://npmjs.org/package/s3-update-example-cli)
[![CircleCI](https://circleci.com/gh/jdxcode/s3-update-example-cli/tree/master.svg?style=shield)](https://circleci.com/gh/jdxcode/s3-update-example-cli/tree/master)
[![Appveyor CI](https://ci.appveyor.com/api/projects/status/github/jdxcode/s3-update-example-cli?branch=master&svg=true)](https://ci.appveyor.com/project/jdxcode/s3-update-example-cli/branch/master)
[![Codecov](https://codecov.io/gh/jdxcode/s3-update-example-cli/branch/master/graph/badge.svg)](https://codecov.io/gh/jdxcode/s3-update-example-cli)
[![Downloads/week](https://img.shields.io/npm/dw/s3-update-example-cli.svg)](https://npmjs.org/package/s3-update-example-cli)
[![License](https://img.shields.io/npm/l/s3-update-example-cli.svg)](https://github.com/jdxcode/s3-update-example-cli/blob/master/package.json)

<!-- toc -->
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->
# Usage
<!-- usage -->
```sh-session
$ npm install -g s3-update-example-cli
$ s3-update-example-cli COMMAND
running command...
$ s3-update-example-cli (-v|--version|version)
s3-update-example-cli/0.0.0 darwin-x64 node-v9.11.1
$ s3-update-example-cli --help [COMMAND]
USAGE
  $ s3-update-example-cli COMMAND
...
```
<!-- usagestop -->
# Commands
<!-- commands -->
* [s3-update-example-cli hello [FILE]](#s-3-update-example-cli-hello-file)
* [s3-update-example-cli help [COMMAND]](#s-3-update-example-cli-help-command)

## s3-update-example-cli hello [FILE]

describe the command here

```
USAGE
  $ s3-update-example-cli hello [FILE]

OPTIONS
  -f, --force
  -h, --help       show CLI help
  -n, --name=name  name to print

EXAMPLE
  $ s3-update-example-cli hello
  hello world from ./src/hello.ts!
```

_See code: [src/commands/hello.ts](https://github.com/jdxcode/s3-update-example-cli/blob/v0.0.0/src/commands/hello.ts)_

## s3-update-example-cli help [COMMAND]

display help for s3-update-example-cli

```
USAGE
  $ s3-update-example-cli help [COMMAND]

ARGUMENTS
  COMMAND  command to show help for

OPTIONS
  --all  see all commands in CLI
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v1.2.3/src/commands/help.ts)_
<!-- commandsstop -->
