/**
 * Does a newer release exist?
 *
 * A DSH plugin is installed once and then runs for months; without this the only
 * way to learn about a fix is to remember to look. The check is deliberately
 * quiet: it never blocks a tool call, never throws into one, and caches its
 * answer so a long session asks the registry once, not on every render.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

export const PACKAGE = '@fffangchenghao/dsh-latex-look'
export const REGISTRY = 'https://registry.npmjs.org'

/**
 * Split "1.2.3-beta.2" into its numeric parts and its prerelease tag.
 * Anything unparseable compares as 0.0.0 rather than throwing: a version string
 * is not worth breaking a tool call over.
 */
export function parseVersion(value) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(String(value ?? ''))
  if (!m) return { major: 0, minor: 0, patch: 0, pre: '' }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: (m[4] || '').trim() }
}

/**
 * Standard semver ordering, minus build metadata: a prerelease sorts BELOW the
 * release it precedes, so 0.3.0-rc.1 does not count as newer than 0.3.0.
 */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] > y[key] ? 1 : -1
  }
  if (!x.pre && !y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre === y.pre ? 0 : x.pre > y.pre ? 1 : -1
}

export function currentVersion() {
  // Read lazily: importing package.json at module load makes every consumer pay for
  // it, and in a bundled plugin the path to it is not guaranteed to exist.
  const url = new URL('../package.json', import.meta.url)
  return readFile(url, 'utf8')
    .then((raw) => JSON.parse(raw).version)
    .catch(() => '0.0.0')
}

function cachePath() {
  return join(tmpdir(), 'dsh-latex-look', 'update.json')
}

async function readCache(ttlMs) {
  try {
    const raw = await readFile(cachePath(), 'utf8')
    const data = JSON.parse(raw)
    if (!data || typeof data.latest !== 'string') return null
    if (!Number.isFinite(data.at) || Date.now() - data.at > ttlMs) return { ...data, stale: true }
    return data
  } catch {
    return null
  }
}

async function writeCache(latest) {
  try {
    const file = cachePath()
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ at: Date.now(), latest }))
  } catch {
    // A read-only tmpdir costs the cache, not the check.
  }
}

/**
 * @returns {Promise<{current:string, latest:string|null, outdated:boolean, cached:boolean, error?:string}>}
 * Never rejects: an offline machine or a slow registry must not surface as a
 * plugin failure.
 */
export async function checkForUpdate({
  ttlMs = 24 * 60 * 60 * 1000,
  timeoutMs = 2500,
  registry = REGISTRY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const current = await currentVersion()
  const cached = await readCache(ttlMs)
  if (cached && !cached.stale) {
    return { current, latest: cached.latest, outdated: compareVersions(cached.latest, current) > 0, cached: true }
  }
  if (typeof fetchImpl !== 'function') {
    return { current, latest: cached?.latest ?? null, outdated: cached ? compareVersions(cached.latest, current) > 0 : false, cached: Boolean(cached), error: 'no fetch' }
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // The endpoint returns the version document for `latest` directly.
    const res = await fetchImpl(`${registry}/${PACKAGE}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    }).finally(() => clearTimeout(timer))
    if (!res.ok) throw new Error(`registry responded ${res.status}`)
    const body = await res.json()
    const latest = String(body.version || '')
    if (!latest) throw new Error('registry response had no version')
    await writeCache(latest)
    return { current, latest, outdated: compareVersions(latest, current) > 0, cached: false }
  } catch (e) {
    // Fall back to whatever was cached, even when stale: an old answer beats no answer.
    if (cached) return { current, latest: cached.latest, outdated: compareVersions(cached.latest, current) > 0, cached: true, error: e instanceof Error ? e.message : String(e) }
    return { current, latest: null, outdated: false, cached: false, error: e instanceof Error ? e.message : String(e) }
  }
}
