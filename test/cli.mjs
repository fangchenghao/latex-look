// The CLI's own argument handling.
//
// `--point 300 78` once produced NaN, the point branch was skipped, and the run
// printed a page and exited 0 without locating anything. Most cases below drive
// the real binary and real engine; the final two copy only the CLI and stub look()
// to observe its timeout argument and inject an extraction failure deterministically.
//
// Run: node test/cli.mjs

import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'bin', 'latex-look.mjs')
const dir = await mkdtemp(join(tmpdir(), 'latex-look-cli-'))

let failures = 0
let checks = 0
async function check(name, fn) {
  checks++
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

/** Run the CLI and collect stdout, stderr and the exit status. */
function run(args, binary = entry) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [binary, ...args], { cwd: dir })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

try {
const tex = join(dir, 'doc.tex')
await writeFile(tex, String.raw`\documentclass{article}
\begin{document}
\section{Alpha}
Some text here to point at.
\end{document}
`)
// Warm the cross-process build cache. Fresh/error paths below may still rebuild.
const initial = await run([tex, '--page', '1'])
assert(initial.code === 0, `fixture did not compile: ${initial.stderr}\n${initial.stdout}`)
await check('a first build explains why compare previous has no baseline', async () => {
  assert(/COMPARE.*no earlier build/.test(initial.stdout), `comparison silently skipped:\n${initial.stdout}`)
  assert(!/^DIFF/m.test(initial.stdout), `invented a first-build diff:\n${initial.stdout}`)
})

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

for (const args of [['80,105'], ['80', '105'], ['8e1', '+105.0']]) {
  await check(`--point ${args.join(' ')} works before the file`, async () => {
    const r = await run(['--point', ...args, tex])
    assert(r.code === 0, `exit ${r.code}: ${r.stderr}`)
    assert(locatedAt(r.stdout, 80, 105), `wrong coordinates:\n${r.stdout}`)
  })
}

for (const args of [[], ['300,'], [',78'], ['300,,78'], ['300,78,9'], ['300', '--page', '1', '78']]) {
  await check(`malformed point ${JSON.stringify(args)} is refused`, async () => {
    const r = await run([tex, '--point', ...args])
    assert(r.code === 1, `exit ${r.code}: ${r.stdout}`)
    assert(/--point needs two numbers/.test(r.stderr), `unhelpful stderr: ${r.stderr}`)
    assert(!/^OK/m.test(r.stdout), `rendered after invalid argv:\n${r.stdout}`)
  })
}
for (const args of [['80', '105', '9'], ['80,105', '9']]) {
  await check(`a third point token ${JSON.stringify(args)} is not ignored`, async () => {
    const r = await run([tex, '--point', ...args])
    assert(r.code === 1, `exit ${r.code}: ${r.stdout}`)
    assert(/unexpected positional argument/.test(r.stderr), `unhelpful stderr: ${r.stderr}`)
  })
}

for (const option of ['page', 'text', 'compare', 'dpi', 'engine', 'max-passes', 'timeout', 'audit-blank', 'sequence']) {
  await check(`--${option} without a value is refused`, async () => {
    const r = await run([tex, `--${option}`])
    assert(r.code === 1, `exit ${r.code}: ${r.stdout}`)
    assert(r.stderr.includes(`--${option} needs a value`), `unhelpful stderr: ${r.stderr}`)
  })
}
await check('an option cannot be consumed as another option\'s value', async () => {
  const r = await run([tex, '--page', '--json'])
  assert(r.code === 1 && /--page needs a value/.test(r.stderr), JSON.stringify(r))
})
await check('unknown options and extra files are refused', async () => {
  for (const args of [[tex, '--typo'], [tex, 'second.tex']]) {
    const r = await run(args)
    assert(r.code === 1, `exit ${r.code}: ${r.stdout}`)
    assert(/unknown option|unexpected positional argument/.test(r.stderr), `unhelpful stderr: ${r.stderr}`)
  }
})
await check('--fresh before the file is a flag and forces a build', async () => {
  const r = await run(['--fresh', tex, '--json'])
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`)
  assert(JSON.parse(r.stdout).cached === false, `did not rebuild:\n${r.stdout}`)
})
await check('--audit before the file is a flag and produces an audit', async () => {
  const r = await run(['--audit', tex, '--json'])
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`)
  assert(JSON.parse(r.stdout).audit, `no audit:\n${r.stdout}`)
})
await check('explicit false boolean values remain false', async () => {
  const r = await run(['--fresh', 'false', '--audit', 'false', tex, '--json'])
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`)
  const parsed = JSON.parse(r.stdout)
  assert(parsed.cached === true && parsed.audit === null, `ignored false:\n${r.stdout}`)
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

await check('--json is machine-readable and carries a real edit diff', async () => {
  const source = await readFile(tex, 'utf8')
  await writeFile(tex, source.replace('Some text here to point at.', 'A visibly different replacement paragraph, with more words.'))
  const r = await run([tex, '--page', '1', '--compare', 'previous', '--json'])
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`)
  const parsed = JSON.parse(r.stdout)
  assert(parsed.page === 1 && parsed.ok === true, `wrong page/status: ${r.stdout}`)
  assert(parsed.diff?.changedPixels > 0, `no real diff: ${r.stdout}`)
  assert(parsed.diff?.bbox?.width > 0 && parsed.images?.sideBySide, `no diff image/bbox: ${r.stdout}`)
})

await check('an unreadable explicit compare path is explained instead of silently omitted', async () => {
  const missing = join(dir, 'missing.pdf')
  const r = await run([tex, '--compare', missing])
  assert(r.code === 0, `valid document failed: ${r.stderr}`)
  assert(/COMPARE.*could not read the compare PDF/.test(r.stdout) && r.stdout.includes(missing), `no explanation:\n${r.stdout}`)
  assert(!/^DIFF/m.test(r.stdout), `compared another baseline:\n${r.stdout}`)
})
await check('an invalid explicit compare PDF reports that no comparison ran', async () => {
  const invalid = join(dir, 'invalid.pdf')
  await writeFile(invalid, 'This is not a PDF.\n')
  const r = await run([tex, '--compare', invalid])
  assert(r.code === 0, `valid document failed: ${r.stderr}`)
  assert(/^COMPARE/m.test(r.stdout), `invalid baseline silently omitted:\n${r.stdout}`)
  assert(!/^DIFF/m.test(r.stdout), `invented a diff:\n${r.stdout}`)
})
await check('--help includes audit, sequence, both point forms, and the timeout default', async () => {
  const r = await run(['--help'])
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`)
  for (const flag of ['--audit', '--audit-blank', '--sequence', '--point 300 78']) {
    assert(r.stdout.includes(flag), `missing ${flag}: ${r.stdout}`)
  }
  assert(/--timeout.*default 120/.test(r.stdout), `wrong timeout help: ${r.stdout}`)
})

// Copy the CLI unchanged; substitute only imports. This observes its options without
// waiting 120 seconds, and exercises a hard-to-trigger extraction failure in summary().
const stub = join(dir, 'stub')
await mkdir(join(stub, 'bin'), { recursive: true })
await mkdir(join(stub, 'lib'), { recursive: true })
const stubEntry = join(stub, 'bin', 'latex-look.mjs')
await copyFile(entry, stubEntry)
await writeFile(join(stub, 'lib', 'core.mjs'), `
export async function look(file, options) {
  return { ok: true, file, options, sequence: { error: 'simulated text extraction failure' } }
}
`)
await writeFile(join(stub, 'lib', 'update.mjs'), 'export const checkForUpdate=()=>({}), currentVersion=()=>"test", upgradeCommand=()=>null;\n')
await writeFile(join(stub, 'lib', 'mcp.mjs'), 'export function serveStdio() {}\n')
await check('the CLI passes a 120-second default, not the core default', async () => {
  const r = await run([tex, '--json'], stubEntry)
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`)
  assert(JSON.parse(r.stdout).options.timeoutSeconds === 120, `wrong default: ${r.stdout}`)
  const explicit = await run([tex, '--timeout', '9', '--json'], stubEntry)
  assert(explicit.code === 0 && JSON.parse(explicit.stdout).options.timeoutSeconds === 9, `lost override: ${explicit.stdout}`)
})
await check('a sequence extraction error is visible, never reported in order', async () => {
  const r = await run([tex, '--sequence', 'Figure'], stubEntry)
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`)
  assert(/ORDER.*cannot check the order.*simulated text extraction failure/.test(r.stdout), `silent extraction error:\n${r.stdout}`)
  assert(!/all in reading order/.test(r.stdout), `false pass:\n${r.stdout}`)
})
} finally {
  const root = await realpath(tmpdir())
  const target = await realpath(dir)
  assert(target.startsWith(root + sep) && dirname(target) === root && target.includes('latex-look-cli-'), `unsafe cleanup target: ${target}`)
  await rm(target, { recursive: true, force: true })
}
console.log(`\n${checks - failures}/${checks} CLI checks passed`)
if (failures) process.exitCode = 1
