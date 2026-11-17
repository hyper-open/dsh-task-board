#!/usr/bin/env node
/**
 * Recreate ./node_modules for the out-of-tree DSH Workbench plugin by linking
 * the source checkout's packages. The plugin compiles against the checkout's
 * BUILT `@deepseek-ai/*` declarations and runs from the profile that installs
 * it, so it needs no independent install of those packages — only resolution
 * for `tsc`/`tsdown` here.
 *
 * Links:
 *   - every `@deepseek-ai/*` package found under the checkout's `packages/`,
 *     `vendor/`, and `native/system/packages/` into ./node_modules/@deepseek-ai
 *   - react, react-dom, clsx from the checkout's pnpm store
 *
 * Run once before `npm run build`. Override the checkout with DSH_CHECKOUT.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const checkout = process.env.DSH_CHECKOUT ?? resolve(root, '../../../source/deepseek-harness')

const collect = (dir, out) => {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    const manifest = join(full, 'package.json')
    if (existsSync(manifest)) {
      try {
        const name = JSON.parse(readFileSync(manifest, 'utf8')).name
        if (typeof name === 'string' && name.startsWith('@deepseek-ai/')) out.push([name, full])
      } catch { /* ignore malformed manifests */ }
    }
    collect(full, out)
  }
}

const packages = []
for (const base of ['packages', 'vendor', 'native/system/packages']) collect(join(checkout, base), packages)
if (packages.length === 0) {
  console.error(`link-deps: no packages found under ${checkout}; set DSH_CHECKOUT`)
  process.exit(1)
}

const scope = join(root, 'node_modules', '@deepseek-ai')
rmSync(scope, { recursive: true, force: true })
mkdirSync(scope, { recursive: true })
let linked = 0
for (const [name, full] of packages) {
  try { symlinkSync(resolve(full), join(scope, name.slice('@deepseek-ai/'.length)), 'dir'); linked++ } catch { /* exists */ }
}

// React and friends live in the pnpm store, not the checkout root. A pnpm store
// directory name replaces the scope slash with `+` (e.g. `@types+node@22.20.1`).
const storeDirPrefix = (pkg) => pkg.replace('/', '+')
const linkStore = (pkg) => {
  const storeBase = join(checkout, 'node_modules/.pnpm')
  if (!existsSync(storeBase)) return false
  const prefix = storeDirPrefix(pkg)
  // Prefer an exact match, else the highest-sorting version directory.
  const candidates = readdirSync(storeBase).filter(name => name === prefix || name.startsWith(`${prefix}@`))
  candidates.sort()
  const dir = candidates.at(-1)
  if (dir === undefined) return false
  const target = join(storeBase, dir, 'node_modules', pkg)
  if (!existsSync(target)) return false
  const link = join(root, 'node_modules', pkg)
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { recursive: true, force: true })
  symlinkSync(target, link, 'dir')
  return true
}
const extraLinked = ['react', 'react-dom', 'clsx', 'zod', '@types/node', '@types/react', '@types/react-dom'].map(linkStore)

console.log(`link-deps: linked ${linked} @deepseek-ai packages; extras: ${extraLinked.join(", ")}`)
