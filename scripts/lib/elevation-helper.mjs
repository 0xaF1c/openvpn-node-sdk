/**
 * Publish the compiled elevation helper under a `.mjs` name as well.
 *
 * The helper is an ES module, but `tsc` emits `.js`, and Node decides how to
 * parse a `.js` file from the nearest `package.json` (`"type": "module"`). That
 * is exactly what breaks in the two places the helper is used from:
 *
 * - Electron `asarUnpack`: the packager copies only the matching file, so the
 *   unpacked `elevate-helper.js` has no `package.json` above it and Node loads
 *   it as CommonJS -> `SyntaxError: Cannot use import statement outside a
 *   module` in the elevated process (invisible, except for a 120 s timeout in
 *   the parent).
 * - A host that copies the helper next to its own CJS bundle: the issue
 *   workaround renames it to `.mjs` for the same reason.
 *
 * Shipping the same source as `.mjs` makes the module type independent of the
 * surrounding `package.json`. The `.js` copy is kept because hosts may already
 * copy `dist/tap/src/elevate-helper.js` in their build; the resolver prefers
 * `.mjs`.
 */
import { copyFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Copy `compiledJs` (`.../elevate-helper.js`) to its `.mjs` sibling.
 *
 * @param {string} compiledJs Absolute path of the compiled helper.
 * @returns {string | null} The copied path, or `null` when the compile output is
 *   missing (the caller decides whether that is an error).
 */
export function copyElevationHelperAsMjs(compiledJs) {
  if (!path.isAbsolute(compiledJs)) throw new Error(`expected an absolute path, got ${compiledJs}`);
  if (!compiledJs.endsWith('.js')) throw new Error(`expected a .js file, got ${compiledJs}`);
  const target = compiledJs.replace(/\.js$/, '.mjs');
  try {
    copyFileSync(compiledJs, target);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  return target;
}
