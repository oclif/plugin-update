# `oclif-example update`

update the oclif-example CLI

- [`oclif-example update [CHANNEL]`](#oclif-example-update-channel)

## `oclif-example update [CHANNEL]`

update the oclif-example CLI

```
USAGE
  $ oclif-example update [CHANNEL] [-a] [--force] [-i | -v <value>]

FLAGS
  -a, --available        See available versions.
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

_See code: [src/commands/update.ts](https://github.com/oclif/plugin-update/blob/4.2.1/src/commands/update.ts)_
