#!/usr/bin/env node
/**
 * `prepare` hook — runs after a Git install (pnpm/npm) and before packing.
 *
 * Preferred distribution is the published npm package, which already ships the
 * built `lib/` and needs no build here. For someone installing straight from a
 * git host, this builds `lib/` from source when a DSH source checkout is
 * available (the client bundle preset, CSS handling, and `@deepseek-ai/*` type
 * declarations live in the monorepo). If no checkout is found it prints clear
 * guidance and exits 0 — `dsh plugin add dsh-workbench` (npm) is the supported path.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const checkout = process.env.DSH_CHECKOUT ?? resolve(root, '../../../source/deepseek-harness')
const tsdown = resolve(checkout, 'node_modules/.bin/tsdown')

if (!existsSync(tsdown)) {
  console.warn(
    [
      '[dsh-workbench] prepare: no DSH source checkout found, so lib/ was not built.',
      '  This package is meant to be installed from npm (prebuilt). If you are',
      '  installing from a git host, set DSH_CHECKOUT to a deepseek-harness source',
      '  checkout first, e.g.:',
      '    DSH_CHECKOUT=/path/to/deepseek-harness pnpm install',
      '  or install the published package: dsh plugin add dsh-workbench',
    ].join('\n'),
  )
  process.exit(0)
}

process.env.DSH_CHECKOUT = checkout
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(`[dsh-workbench] prepare: building against ${checkout}`)
run(process.execPath, ['scripts/link-deps.mjs'])
run(process.execPath, ['scripts/build.mjs'])
