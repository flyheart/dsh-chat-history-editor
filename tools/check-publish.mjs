#!/usr/bin/env node
/**
 * Fail fast before `npm publish` on the mistakes that only the registry would
 * report after the tarball is built: a private manifest, a placeholder name, a
 * Client module id that disagrees with the package name, missing display
 * resources, or no DSH compatibility range.
 *
 * Usage: node tools/check-publish.mjs   (wired into prepublishOnly)
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const problems = []

if (manifest.private === true) problems.push('package.json still declares "private": true')
if (typeof manifest.name !== 'string' || manifest.name.startsWith('@local/')) {
  problems.push(`package name "${manifest.name}" is a local placeholder; run "node tools/rename.mjs <name>"`)
}
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  problems.push(`package version "${String(manifest.version)}" is not a publishable SemVer`)
}
if (typeof manifest.engines?.dsh !== 'string') problems.push('package.json needs engines.dsh for the DSH compatibility check')
if (typeof manifest.dsh?.bundle?.patch !== 'string') problems.push('package.json needs dsh.bundle.patch')
if (manifest.dsh?.client?.platform !== 'web') problems.push('package.json needs dsh.client.platform = "web"')
if (typeof manifest.exports?.['./client'] !== 'string') problems.push('package.json needs exports["./client"]')
for (const required of ['index.js', 'history-ops.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
  if (!existsSync(path.join(root, required))) problems.push(`missing publish file: ${required}`)
}

const client = readFileSync(path.join(root, 'client.js'), 'utf8')
const moduleId = /window\.__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(client)?.[1]
if (moduleId !== manifest.name) {
  problems.push(`client.js module id "${String(moduleId)}" must equal the package name "${manifest.name}" (run node tools/rename.mjs)`)
}

if (problems.length > 0) {
  console.error('publish preflight failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`publish preflight ok: ${manifest.name}@${manifest.version}`)
