#!/usr/bin/env ts-node
// eslint-disable-next-line node/shebang
async function main() {
  const {execute} = await import('@oclif/core')
  await execute({development: true, dir: import.meta.url})
}

await main()
