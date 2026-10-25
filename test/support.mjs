/**
 * Locate the running DSH installation so the Host-side probes can import its
 * second-party packages by absolute path.
 *
 * The plugin itself never imports DSH packages; only these dev probes do, so
 * the tests must degrade gracefully when no DSH installation is present
 * (for example on a clean CI runner). Resolution order:
 *
 * 1. `DSH_INSTALL_ROOT` — the `@deepseek-ai/dsh` package directory.
 * 2. The `dsh` executable on `PATH` — its real path is
 *    `<root>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`.
 * 3. `npm root -g` — `<root>/@deepseek-ai/dsh`.
 *
 * Set `DSH_SKIP_DSH_TESTS=1` to force a skip.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SESSION_MODULE = ['node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js']
const FORMAT_MODULE = ['node_modules', '@deepseek-ai', 'dsh-session-format-v3-to-v4', 'lib', 'index.js']

/** @param {string} file @returns {string} */
function fileUrl(file) {
  return pathToFileURL(file).href
}

/** @param {string[]} candidates @returns {string | undefined} */
function firstValidRoot(candidates) {
  for (const root of candidates) {
    if (root === undefined || root === '') continue
    try {
      if (!existsSync(path.join(root, ...SESSION_MODULE))) continue
      if (!existsSync(path.join(root, ...FORMAT_MODULE))) continue
      return root
    } catch {
      // Ignore candidates that cannot be inspected.
    }
  }
  return undefined
}

/** @param {string} command @param {string[]} args @returns {string | undefined} */
function output(command, args) {
  try {
    const text = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** @returns {string[]} candidate `@deepseek-ai/dsh` package directories. */
function candidateRoots() {
  const candidates = []
  if (process.env.DSH_INSTALL_ROOT !== undefined) candidates.push(process.env.DSH_INSTALL_ROOT)

  const bin = output('sh', ['-c', 'command -v dsh'])
  if (bin !== undefined) {
    try {
      const real = realpathSync(bin)
      // <root>/lib/bin.js or <root>/lib/node_modules/.../lib/bin.js depending on layout.
      candidates.push(path.resolve(path.dirname(real), '..', '..'))
      candidates.push(path.resolve(path.dirname(real), '..'))
    } catch {
      // Ignore a dangling dsh bin.
    }
  }

  const npmRoot = output('npm', ['root', '-g'])
  if (npmRoot !== undefined) candidates.push(path.join(npmRoot, '@deepseek-ai', 'dsh'))
  return candidates
}

/**
 * Resolve the imports the Host probes need.
 * @returns {{ root: string, sessionModule: string, formatModule: string } | undefined}
 *   module URLs, or undefined when no installation is available.
 */
export function loadDshModules() {
  if (process.env.DSH_SKIP_DSH_TESTS === '1') return undefined
  const root = firstValidRoot(candidateRoots())
  if (root === undefined) return undefined
  return {
    root,
    sessionModule: fileUrl(path.join(root, ...SESSION_MODULE)),
    formatModule: fileUrl(path.join(root, ...FORMAT_MODULE))
  }
}

/**
 * Print a skip notice and end the process successfully.
 * @param {string} suite - test file name for the notice.
 */
export function skipSuite(suite) {
  console.log(`SKIP ${suite}: no DSH installation found; set DSH_INSTALL_ROOT to the @deepseek-ai/dsh package directory to run the Host probes.`)
  process.exit(0)
}
