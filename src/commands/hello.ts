import {Command, flags} from '@oclif/command'

export default class Hello extends Command {
  static title = 'scaffolded command that says hello'

  // hide the command from help
  // can also set hidden on args and flags
  // static hidden = true

  // usage is set by default
  // add your own by setting this variable
  // can be a string or array
  // static usage = 'title of command'

  static description = `
Add a longer description here
...
...
`

  static examples = [
    `$ plugin-update hello
hello world from hello!
`,
    `$ plugin-update hello --name myname
hello myname from hello!
`,
    '$ plugin-update hello file outputs "hello world!" to file',
    '$ plugin-update hello --force',
    '$ plugin-update hello --help',
  ]

  // allow running this command by running `$ plugin-update foobar`
  // static aliases = ['foobar']

  static flags = {
    // flag with a value (-n, --name=VALUE)
    name: flags.string({
      char: 'n',                    // shorter flag version
      description: 'name to print', // help description for flag
      hidden: false,                // hide from help
      required: false,              // make flag required (probably should use an arg instead of a required flag though)
      multiple: false,              // allow setting this flag multiple times
      // options: ['a', 'b'],       // only allow the value to be from a discrete set
      // parse: input => 'output',  // instead of the user input, return a differnt value
      // default: 'world',          // default value if flag not passed
    }),

    // flag with no value (-f, --force)
    force: flags.boolean({
      char: 'f',

      // by default boolean flags may also be reversed with `--no-` (in this case: `--no-force`)
      // the flag will be set to false if reversed
      // set this to false to disable this functionality
      // allowNo: false,
    }),
  }

  static args = [
    {
      name: 'file',                  // name of arg to show in help and reference with this.options.args[name]
      required: false,               // make the arg required with `required: true`
      description: 'file to output', // help description
      // hidden: true,               // hide this flag from help
      // parse: input => 'output',   // instead of the user input, return a differnt value
      // default: 'world',           // default value if no arg input
      // options: ['a', 'b'],        // only allow input to be from a discrete set
    },
  ]

  // this makes the parser not fail when it receives invalid arguments
  // set it to off if you need to accept variable arguments
  // static strict = false

  // entry point of command
  async run() {
    const {args, flags} = this.parse(Hello)

    const name = flags.name || 'world'
    this.log(`hello ${name} from hello!`)
    if (args.file && flags.force) {
      this.log(`you input ${args.file}`)
    }
  }
}
