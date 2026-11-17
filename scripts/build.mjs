#!/usr/bin/env node
/**
 * Self-contained build for the out-of-tree DSH Workbench plugin.
 *
 * Steps:
 *   1. tsc  — emit `lib/types/**` (declarations + the intermediate JS tsdown
 *             consumes) against the source checkout's built `@deepseek-ai/*`
 *             declarations (linked into ./node_modules/@deepseek-ai).
 *   2. tsdown — emit `lib/index.js` (Loader-row node half) and `lib/client.js`
 *             (the `window.__ModuleLoader__.load(...)` browser bundle).
 *
 * The checkout path is resolved from DSH_CHECKOUT or the default below; both
 * the tsc binary and the tsdown binary come from that checkout so the emitted
 * browser bundle matches the exact artifact contract the web module loader
 * expects.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const checkout = process.env.DSH_CHECKOUT
  ?? resolve(root, '../../../source/deepseek-harness')

if (!existsSync(resolve(checkout, 'node_modules/.bin/tsc'))) {
  console.error(`build: cannot find the DSH source checkout at ${checkout}; set DSH_CHECKOUT`)
  process.exit(1)
}

const run = (label, cmd, args) => {
  console.log(`\n[workbench] ${label}: ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`[workbench] ${label} failed with code ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

run('tsc', resolve(checkout, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'])
run('tsdown', resolve(checkout, 'node_modules/.bin/tsdown'), ['--config-loader', 'native'])
console.log('\n[workbench] build complete: lib/index.js, lib/client.js')
