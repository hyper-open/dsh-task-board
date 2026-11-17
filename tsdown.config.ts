/**
 * Build config for the out-of-tree DSH Workbench client plugin. Reuses the
 * source checkout's shared `clientBundle` preset (absolute import) so the
 * emitted `lib/client.js` matches the exact `window.__ModuleLoader__.load({id,
 * factory})` artifact contract the browser module loader consumes, and
 * `lib/index.js` is the Loader-row node half.
 *
 * The preset compiles the browser bundle from `lib/types/client/index.js`
 * (tsc output). Run `tsc -p tsconfig.json` first (see package `build`).
 */
import { clientBundle } from '../../../source/deepseek-harness/packages/client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js'])
