#!/usr/bin/env node
/**
 * Generate a format-1 plugin market index document for this bundle.
 *
 * The index is the single JSON file a DSH reader fetches: users add its URL in
 * Discover/Settings, and the `plugin_market` tool (plus the Discover tab) lists
 * the plugins it declares with their install targets. This tool writes one
 * plugin entry, one version, from the package manifest, the exported locales,
 * and the icon.
 *
 * Usage:
 *   node tools/market-index.mjs -o market/index.json \
 *     --author "Your Name" --repository https://github.com/you/dsh-chat-history-editor \
 *     --timestamp 1790000000 [--registry https://registry.npmjs.org/] [--validate]
 *
 * Validation uses @deepseek-ai/dsh-plugin-market-index from the running dsh
 * installation; pass --dsh-root <installation dir> when it is not discoverable.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** @returns {{ values: Map<string,string>, argv: string[] }} parsed flags and positionals */
function parseArgs(argv) {
  const values = new Map()
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--validate') {
      values.set('validate', 'true')
      continue
    }
    if (arg === '-o') {
      const value = argv[index + 1]
      if (value === undefined) {
        console.error('missing value for -o')
        process.exit(1)
      }
      values.set('out', value)
      index += 1
      continue
    }
    if (!arg.startsWith('--')) {
      rest.push(arg)
      continue
    }
    const key = arg.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error(`missing value for --${key}`)
      process.exit(1)
    }
    values.set(key, value)
    index += 1
  }
  return { values, argv: rest }
}

/** @param {object} manifest @returns {{ en: string, zh: string } | string | undefined} */
function localizedMeta(manifest, field) {
  const locales = {}
  for (const id of ['en', 'zh']) {
    const file = path.join(root, 'locale', `${id}.json`)
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'))
      const text = value?.meta?.[field]
      if (typeof text === 'string' && text.length > 0) locales[id] = text
    } catch {
      // A missing locale is fine; the manifest fallback below fills English.
    }
  }
  if (locales.en === undefined) {
    const fallback = field === 'title' ? manifest.name : manifest.description
    if (typeof fallback === 'string' && fallback.length > 0) locales.en = fallback
  }
  if (locales.en === undefined) return undefined
  return Object.keys(locales).length === 1 && locales.en !== undefined ? locales.en : locales
}

const { values } = parseArgs(process.argv.slice(2))
const out = values.get('out')
if (out === undefined) {
  console.error('usage: node tools/market-index.mjs -o <index.json> [--author ...] [--repository ...] [--timestamp <unix-seconds>] [--validate]')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
if (manifest.private === true) console.error('warning: package.json still has "private": true; remove it before publishing')
if (typeof manifest.engines?.dsh !== 'string') console.error('warning: package.json declares no engines.dsh compatibility range')

const iconFile = path.join(root, 'icon.svg')
const iconBytes = readFileSync(iconFile)
const iconData = `data:image/svg+xml;base64,${iconBytes.toString('base64')}`

const timestamp = Number(values.get('timestamp'))
const publishTimestamp = Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : Math.floor(Date.now() / 1000)
const registry = values.get('registry')

const plugin = {
  name: manifest.name,
  ...localizedMeta(manifest, 'title') === undefined ? {} : { title: localizedMeta(manifest, 'title') },
  ...localizedMeta(manifest, 'description') === undefined ? {} : { description: localizedMeta(manifest, 'description') },
  icon: iconData,
  ...values.get('author') === undefined ? {} : { author: values.get('author') },
  ...values.get('homepage') === undefined ? {} : { homepage: values.get('homepage') },
  ...values.get('repository') === undefined
    ? {}
    : {
        repository: {
          url: values.get('repository'),
          ...values.get('directory') === undefined ? {} : { directory: values.get('directory') }
        }
      },
  metadata: {
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [],
    labels: [],
    sortKeys: {}
  },
  versions: [
    {
      version: manifest.version,
      publishTimestamp,
      source: { type: 'npm', ...registry === undefined ? {} : { registry } },
      engines: typeof manifest.engines?.dsh === 'string' ? { dsh: manifest.engines.dsh } : {}
    }
  ]
}

const index = {
  format: 1,
  title: { en: 'Chat History Editor market index', zh: '聊天历史编辑器插件索引' },
  description: { en: 'Plugins generated from this workspace.', zh: '由该工作区生成的插件索引。' },
  metadata: { categories: {}, labels: {}, sortKeys: {} },
  plugins: [plugin]
}

if (values.get('validate') === 'true') {
  const modulePath = values.get('dsh-root') === undefined
    ? '@deepseek-ai/dsh-plugin-market-index'
    : pathToFileURL(path.join(values.get('dsh-root'), 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js')).href
  try {
    const { parseMarketIndex } = await import(modulePath)
    parseMarketIndex(index, 'https://example.invalid/index.json')
    console.error('index valid: parseMarketIndex accepted the document')
  } catch (error) {
    console.error(`index validation failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

writeFileSync(path.resolve(out), `${JSON.stringify(index, null, 2)}\n`)
console.error(`wrote ${out} (${index.plugins.length} plugin, ${index.plugins[0].versions.length} version)`)
