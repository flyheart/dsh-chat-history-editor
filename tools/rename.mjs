#!/usr/bin/env node
/**
 * Rename this plugin package consistently in every place that must agree:
 * `package.json` name, the bundle patch row name, the Client module id (and its
 * CSS/style tag ids), and the client test's expected id.
 *
 * Usage: node tools/rename.mjs @your-scope/chat-history-editor
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const next = process.argv[2]
if (typeof next !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(next)) {
  console.error('usage: node tools/rename.mjs <package-name>')
  console.error('example: node tools/rename.mjs @your-scope/chat-history-editor')
  process.exit(1)
}

const manifestPath = path.join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const previous = manifest.name
if (previous === next) {
  console.log(`package is already named ${next}`)
  process.exit(0)
}

manifest.name = next
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

/** Replace the package name in one text file and require at least one hit. */
function replaceIn(relative, expected) {
  const file = path.join(root, relative)
  const source = readFileSync(file, 'utf8')
  const hits = source.split(previous).length - 1
  if (hits === 0) {
    console.error(`${relative}: expected at least one "${previous}" occurrence`)
    process.exit(1)
  }
  writeFileSync(file, source.split(previous).join(next))
  console.log(`${relative}: ${hits} occurrence(s) updated${expected === undefined ? '' : ` (${expected})`}`)
}

replaceIn('cordis.patch.yml', 'bundle patch row name')
replaceIn('client.js', 'Client module id + style tag ids')
replaceIn('test/client.test.mjs', 'expected module id')

console.log(`\nrenamed ${previous} -> ${next}`)
console.log('next: update README install name if it mentions the package, then run npm test and npm pack --dry-run')
