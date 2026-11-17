// The CLI's own argument handling.
//
// Everything else drives `index.js` or the MCP server; nothing drove
// `bin/latex-look.mjs`, and that is exactly where `--point` broke: the documented
// `--point 300 78` spelling produced NaN, the point branch was skipped, and the run
// printed a page and exited 0 without locating anything. A locate request that
// locates nothing and says nothing is the failure this project exists to avoid, so
// it is checked here through the real binary, with argv as a shell would build it.
//
// Run: node test/cli.mjs

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'bin', 'latex-look.mjs')
const dir = await mkdtemp(join(tmpdir(), 'latex-look-cli-'))

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

/** Run the CLI and collect stdout, stderr and the exit status. */
function run(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: dir })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

const tex = join(dir, 'doc.tex')
await writeFile(tex, String.raw`\documentclass{article}
\begin{document}
\section{Alpha}
Some text here to point at.
\end{document}
`)
// One real build, so every case below is served from the cache and runs in ~0.3 s.
await run([tex, '--page', '1'])

// A point inside the text block. Whether the ink under it is a rule or text does not
// matter — that a LOCATED section appears, with the coordinates that were asked for.
const locatedAt = (out, x, y) =>
  new RegExp(`→ p1 x=${x}\\.0 y=${y}\\.0`).test(out)

await check('--point x,y locates the point', async () => {
  const r = await run([tex, '--point', '80,105'])
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`)
  assert(/LOCATED/.test(r.stdout), `no LOCATED section:\n${r.stdout}`)
  assert(locatedAt(r.stdout, 80, 105), `wrong coordinates:\n${r.stdout}`)
})

await check('--point x y (space-separated) locates the same point', async () => {
  // The regression: `String("80").split(',')` → ['80'], y became NaN, the point branch
  // was skipped for `Number.isFinite(NaN) === false`, and the tool exited 0 with no
  // LOCATED line — a locate request that silently located nothing.
  const r = await run([tex, '--point', '80', '105'])
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`)
  assert(/LOCATED/.test(r.stdout), `no LOCATED section for the space form:\n${r.stdout}`)
  assert(locatedAt(r.stdout, 80, 105), `wrong coordinates:\n${r.stdout}`)
})

await check('--point with non-numeric arguments is refused, not ignored', async () => {
  const r = await run([tex, '--point', 'abc,def'])
  assert(r.code !== 0, `exited 0 on a malformed point; stdout:\n${r.stdout}`)
  assert(/--point needs two numbers/.test(r.stderr), `unhelpful stderr: ${r.stderr}`)
})

await check('--point with one number is refused', async () => {
  const r = await run([tex, '--point', '80'])
  assert(r.code !== 0, `exited 0 with a single coordinate; stdout:\n${r.stdout}`)
  assert(/--point needs two numbers/.test(r.stderr), `unhelpful stderr: ${r.stderr}`)
})

await check('--text locates a string and shows its page', async () => {
  const r = await run([tex, '--text', 'Some text here'])
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`)
  assert(/doc\.tex:\d+\s+→ p1/.test(r.stdout), `no location:\n${r.stdout}`)
})

await check('a page out of range is reported, not thrown as ENOENT', async () => {
  // With a point, the out-of-range page used to die inside renderPpm: gs exits 0
  // having written nothing, and readFile threw ENOENT out of the tool.
  const r = await run([tex, '--page', '99', '--point', '80,105'])
  assert(r.code !== 0, `exited 0 for a page that does not exist:\n${r.stdout}`)
  assert(!/ENOENT/.test(r.stderr), `raw ENOENT leaked to the user: ${r.stderr}`)
  assert(/out of range/.test(r.stdout), `no range explanation:\n${r.stdout}`)
})

await check('a fractional page number is refused and echoes the value', async () => {
  const r = await run([tex, '--page', '2.5'])
  assert(r.code !== 0, `exited 0 for page 2.5:\n${r.stdout}`)
  assert(/page must be a whole number, got 2\.5/.test(r.stdout), `lost the value:\n${r.stdout}`)
})

await check('--json is machine-readable and carries the diff', async () => {
  const r = await run([tex, '--page', '1', '--json'])
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`)
  const parsed = JSON.parse(r.stdout)
  assert(parsed.page === 1, `page ${parsed.page}`)
  assert(typeof parsed.ok === 'boolean', 'no ok field')
})

await rm(dir, { recursive: true, force: true })
if (failures) {
  console.log(`\n${failures} CLI check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall CLI checks passed')
}
