// Update boundaries without network access or replacing the real package.
// Run: node test/review-update.mjs
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkForUpdate, compareVersions, parseVersion, restartNote } from '../lib/update.mjs'

let failures = 0
let checks = 0
async function check(name, fn) {
  checks++
  try { await fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`) }
}

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const root = resolve(tmpdir())
const dir = await mkdtemp(join(root, "latex-look-update review 中文's-"))
try {
  await check('the registry time budget also covers the response body', async () => {
    const result = await checkForUpdate({
      ttlMs: -1, timeoutMs: 40,
      fetchImpl: async (_url, { signal }) => ({
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          const late = setTimeout(() => reject(new Error('body stayed open')), 500)
          signal.addEventListener('abort', () => {
            clearTimeout(late)
            reject(new Error('body was aborted'))
          }, { once: true })
        }),
      }),
    })
    assert.equal(result.error, 'body was aborted')
  })
  await check('running version belongs to import time, even before its first caller', async () => {
    await mkdir(join(dir, 'lib'))
    await copyFile(join(repo, 'lib', 'update.mjs'), join(dir, 'lib', 'update.mjs'))
    const packageFile = join(dir, 'package.json')
    await writeFile(packageFile, JSON.stringify({ version: '1.2.3' }))
    const loaded = await import(pathToFileURL(join(dir, 'lib', 'update.mjs')).href)
    // This is the gap the lazy initializer missed: code was already imported,
    // but no render/update check had called currentVersion yet.
    await writeFile(packageFile, JSON.stringify({ version: '1.3.0' }))
    assert.equal(await loaded.currentVersion(), '1.2.3')
    assert.equal(await loaded.versionOnDisk(), '1.3.0')
    assert.match(await loaded.restartPending(), /1\.3\.0 is installed on disk.*still running 1\.2\.3/)
    await writeFile(packageFile, JSON.stringify({ version: '1.4.0' }))
    assert.equal(await loaded.currentVersion(), '1.2.3')
    assert.equal(await loaded.versionOnDisk(), '1.4.0')
  })
  await check('build metadata is parsed separately and ignored in precedence', () => {
    assert.deepEqual(parseVersion('1.2.3+build.7'), { major: 1, minor: 2, patch: 3, pre: '' })
    assert.deepEqual(parseVersion('1.2.3-rc.1+build.7'), { major: 1, minor: 2, patch: 3, pre: 'rc.1' })
    assert.equal(compareVersions('1.2.3+build.7', '1.2.3'), 0)
    assert.equal(compareVersions('1.2.3+build.7', '1.2.3+build.99'), 0)
    assert.equal(compareVersions('1.2.3-rc.1+build.7', '1.2.3-rc.1+build.99'), 0)
    assert.equal(restartNote('1.2.3+build.7', '1.2.3+build.99'), null)
  })
  await check('numeric prerelease identifiers use numeric rather than lexical order', () => {
    for (const [later, earlier] of [
      ['1.2.3-rc.10', '1.2.3-rc.2'],
      ['1.2.3-beta.11', '1.2.3-beta.2'],
      ['1.2.3-rc.9007199254740993', '1.2.3-rc.9007199254740992'],
    ]) {
      assert.equal(compareVersions(later, earlier), 1)
      assert.equal(compareVersions(earlier, later), -1)
    }
    assert.match(restartNote('1.2.3-rc.2', '1.2.3-rc.10'), /restart/)
  })
  await check('canonical SemVer prerelease chain is ordered and antisymmetric', () => {
    const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
    for (let i = 0; i < chain.length; i++) {
      assert.equal(compareVersions(chain[i], chain[i]), 0)
      for (let j = i + 1; j < chain.length; j++) {
        assert.equal(compareVersions(chain[i], chain[j]), -1, `${chain[i]} < ${chain[j]}`)
        assert.equal(compareVersions(chain[j], chain[i]), 1, `${chain[j]} > ${chain[i]}`)
      }
    }
  })
  await check('numeric identifiers precede nonnumeric ones; more identifiers follow fewer', () => {
    assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.0'), -1)
    assert.equal(compareVersions('1.0.0-alpha.0', '1.0.0-alpha.0.0'), -1)
    assert.equal(compareVersions('v1.2.3', ' 1.2.3 '), 0)
  })
  await check('invalid versions retain the nonthrowing zero fallback', () => {
    for (const bad of ['garbage', '1.2', '01.2.3', '1.2.3-01', '1.2.3-a..b', '1.2.3+', null]) {
      assert.deepEqual(parseVersion(bad), { major: 0, minor: 0, patch: 0, pre: '' })
      assert.equal(compareVersions(bad, '0.0.0'), 0)
    }
  })
} finally {
  // Verify the exact mkdtemp child before recursive removal.
  assert.equal(dirname(resolve(dir)), root)
  assert.ok(dir.startsWith(join(root, 'latex-look-update review ')))
  await rm(dir, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} update checks passed`)
if (failures) process.exitCode = 1
