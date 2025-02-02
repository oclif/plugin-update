# @oclif/plugin-update

[![Version](https://img.shields.io/npm/v/@oclif/plugin-update.svg)](https://npmjs.org/package/@oclif/plugin-update)
[![Downloads/week](https://img.shields.io/npm/dw/@oclif/plugin-update.svg)](https://npmjs.org/package/@oclif/plugin-update)
[![License](https://img.shields.io/npm/l/@oclif/plugin-update.svg)](https://github.com/oclif/plugin-update/blob/main/package.json)

<!-- toc -->

- [@oclif/plugin-update](#oclifplugin-update)
- [Usage](#usage)
- [Commands](#commands)
- [Contributing](#contributing)
<!-- tocstop -->

# Usage

See https://oclif.io/docs/releasing.html#autoupdater

# Commands

<!-- commands -->

- [`oclif-example update [CHANNEL]`](#oclif-example-update-channel)

## `oclif-example update [CHANNEL]`

update the oclif-example CLI

```
USAGE
  $ oclif-example update [CHANNEL] [--force |  | [-a | -v <value> | -i]] [-b ]

FLAGS
  -a, --available        See available versions.
  -b, --verbose          Show more details about the available versions.
  -i, --interactive      Interactively select version to install. This is ignored if a channel is provided.
  -v, --version=<value>  Install a specific version.
      --force            Force a re-download of the requested version.

DESCRIPTION
  update the oclif-example CLI

EXAMPLES
  Update to the stable channel:

    $ oclif-example update stable

  Update to a specific version:

    $ oclif-example update --version 1.0.0

  Interactively select version:

    $ oclif-example update --interactive

  See available versions:

    $ oclif-example update --available
```

_See code: [src/commands/update.ts](https://github.com/oclif/plugin-update/blob/4.6.29/src/commands/update.ts)_

<!-- commandsstop -->

# Contributing

See [contributing guide](./CONRTIBUTING.md)
