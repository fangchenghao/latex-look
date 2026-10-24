/**
 * latex-look core — the four senses an agent needs to see a LaTeX document:
 *   compile (multi-pass, verified) · render (PDF → PNG) · locate (PDF ↔ source)
 *   · diff (pixel-level before/after).
 *
 * Zero npm dependencies. External binaries: a TeX engine, `synctex`, `gs`.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'

export const ENGINES = ['xelatex', 'lualatex', 'pdflatex', 'latexmk', 'tectonic']

// ---------------------------------------------------------------------------
// process helper
// ---------------------------------------------------------------------------

export function run(cmd, args, { cwd, timeoutMs = 300000 } = {}) {
  return new Promise((done) => {
    let settled = false
    let timer = null
    const finish = (v) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      done(v)
    }
    let child
    try {
      child = spawn(cmd, args, { cwd, detached: true })
    } catch (err) {
      return finish({ code: null, stdout: '', stderr: String(err.message), error: String(err.message) })
    }
    let stdout = ''
    let stderr = ''
    const killTree = () => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
    }
    if (timeoutMs > 0) timer = setTimeout(() => { killTree(); finish({ code: null, stdout, stderr, timedOut: true }) }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (e) => finish({ code: null, stdout, stderr: String(e.message), error: String(e.message) }))
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }))
  })
}

export function findBinary(cmd) {
  const extra = ['/Library/TeX/texbin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']
  const dirs = [...(process.env.PATH || '').split(':'), ...extra]
  for (const d of dirs) {
    if (!d) continue
    const p = join(d, cmd)
    if (existsSync(p)) return p
  }
  return cmd
}

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

const AUX = ['.aux', '.toc', '.out', '.lof', '.lot', '.bbl', '.idx', '.gls']

/**
 * Every file whose content can change the output: the document itself, whatever
 * it \input/\include's (three levels), the images it pulls in, and the generated
 * aux files — a stray rebuild from an editor invalidates the cache, which is
 * exactly what we want.
 */
async function collectReachable(texPath) {
  const main = resolve(texPath)
  const seen = new Set([main])
  // \graphicspath{{images/}} decides where \includegraphics{max_function} lives. Without
  // it a replaced figure was invisible to the build cache: the signature only covered
  // files found next to the .tex, so "I changed the picture" rebuilt nothing.
  const graphicsDirs = new Set()
  const queue = [[main, 0]]
  while (queue.length) {
    const [f, depth] = queue.shift()
    let src = ''
    try { src = await readFile(f, 'utf8') } catch { continue }
    const d = dirname(f)
    for (const gm of src.matchAll(/\\graphicspath\s*\{([\s\S]*?)\}\s*(?=%|\n|$)/g)) {
      for (const dm of gm[1].matchAll(/\{([^}]*)\}/g)) {
        const rel = dm[1].trim()
        if (rel) graphicsDirs.add(resolve(d, rel))
      }
    }
    if (depth < 3) {
      for (const m of src.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) {
        const name = m[1].trim()
        const p = resolve(d, name.endsWith('.tex') ? name : name + '.tex')
        if (!seen.has(p)) { seen.add(p); queue.push([p, depth + 1]) }
      }
    }
    for (const m of src.matchAll(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      const raw = m[1].trim()
      const exts = ['.png', '.jpg', '.jpeg', '.pdf', '.eps']
      let found = false
      for (const base of [d, ...graphicsDirs]) {
        for (const cand of [raw, ...exts.map((e) => raw + e)]) {
          const p = resolve(base, cand)
          if (existsSync(p)) { seen.add(p); found = true; break }
        }
        if (found) break
      }
    }
  }
  return [...seen]
}

async function sourceSignature(texPath, tag) {
  const main = resolve(texPath)
  const dir = dirname(main)
  const stem = basename(main).replace(/\.tex$/i, '')
  const files = await collectReachable(main)
  for (const e of AUX) files.push(join(dir, stem + e))
  const h = createHash('sha1')
  h.update(JSON.stringify(tag))
  for (const f of files.sort()) {
    let s = null
    try { s = await stat(f) } catch {}
    h.update(`\n${f}\u0000${s ? s.mtimeMs : '-'}\u0000${s ? s.size : '-'}`)
  }
  return h.digest('hex')
}

async function auxSignature(texPath) {
  const base = texPath.replace(/\.tex$/i, '')
  const parts = []
  for (const ext of AUX) {
    try {
      const s = await stat(base + ext)
      if (s.isFile()) parts.push(ext + ':' + (await readFile(base + ext, 'utf8')))
    } catch {}
  }
  return createHash('sha1').update(parts.join('\u0000')).digest('hex')
}

function splitFileLine(s) {
  const m = /^(.+?\.(?:tex|sty|cls|ltx)):(\d+):\s*(.*)$/.exec(s)
  if (m) return { file: m[1], line: Number(m[2]), message: m[3].trim() }
  return { file: null, line: null, message: String(s).trim() }
}

/**
 * Parse engine output into errors and warnings.
 * Handles tectonic's structured `error: file:line: msg` stderr, the classic
 * `! msg` + `l.<n>` transcript, LaTeX/Package/Class warnings, and the
 * Overfull/Underfull box diagnostics that make a page look wrong.
 */
export function parseProblems(tex) {
  const errors = []
  const warnings = []
  const seen = new Set()
  const lines = String(tex).split(/\r?\n/)

  const push = (arr, item) => {
    const key = `${item.file || ''}|${item.line || ''}|${item.message}`
    if (seen.has(key)) return
    seen.add(key)
    arr.push(item)
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]

    // tectonic / rust-style structured stderr
    const err = /^error:\s*(.+)$/.exec(raw)
    if (err) { push(errors, { severity: 'error', ...splitFileLine(err[1]) }); continue }

    const warn = /^warning:\s*(.+)$/.exec(raw)
    if (warn) { push(warnings, { severity: 'warning', ...splitFileLine(warn[1]) }); continue }

    // Classic engines are run with -file-line-error, so their errors arrive as
    // `./doc.tex:12: Undefined control sequence.` and never carry a `! ` prefix.
    // Without this branch a failing compile parsed as zero problems, and the
    // tool reported FAILED with no explanation at all.
    const ffl = /^(.+?\.(?:tex|sty|cls|ltx|def|cfg|clo)):(\d+):\s*(.+)$/.exec(raw)
    if (ffl && !/Warning/i.test(ffl[3])) {
      push(errors, { severity: 'error', file: ffl[1], line: Number(ffl[2]), message: ffl[3].trim().slice(0, 240) })
      continue
    }

    // classic bang error, with the line number on a following `l.<n>` line
    if (/^! /.test(raw)) {
      let line = null
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const m = /^l\.(\d+)/.exec(lines[j])
        if (m) { line = Number(m[1]); break }
      }
      push(errors, { severity: 'error', file: null, line, message: raw.slice(2).trim() })
      continue
    }

    // boxes that overflow the text block — the usual cause of an ugly page
    const box = /^(Overfull|Underfull)\s+\\([hv])box\b(.*)$/.exec(raw)
    if (box) {
      push(warnings, {
        severity: 'warning',
        file: null,
        line: null,
        kind: `${box[1].toLowerCase()}-${box[2]}box`,
        message: raw.trim().slice(0, 240),
      })
      continue
    }

    const w = /^(LaTeX Warning:|Package .+? Warning:|Class .+? Warning:|pdfTeX warning|LaTeX Font Warning:)\s*(.*)$/.exec(raw)
    if (w) {
      push(warnings, { severity: 'warning', file: null, line: null, message: `${w[1]} ${w[2]}`.trim().slice(0, 240) })
    }
  }

  return { errors: errors.slice(0, 40), warnings: warnings.slice(0, 40) }
}

function needsRerun(text) {
  return /Label\(s\) may have changed|Rerun to get (cross-references|outlines|citations) right|There were undefined references|Package rerunfilecheck Warning/i.test(text)
}

/**
 * Run the external tools a document asks for (glossaries, index, bibliography).
 * Skipping them is the same class of silent failure as an empty TOC: the PDF
 * builds cleanly, but \printglossaries shows stale or empty data.
 */
async function runAuxTools(texPath, dir, stem) {
  const ran = []
  const call = async (tool, args) => {
    const r = await run(findBinary(tool), args, { cwd: dir, timeoutMs: 180000 })
    ran.push({ tool, ok: r.code === 0, code: r.code })
    return r.code === 0
  }
  const has = async (ext) => {
    try {
      const s = await stat(join(dir, stem + ext))
      return s.isFile() && s.size > 0
    } catch { return false }
  }

  // Decide from the artifacts pass 1 wrote, not from the root file's text: in a
  // multi-file project \makeglossaries usually lives in an \input'ed preamble,
  // so scanning only the root file silently misses it.
  if (await has('.glo')) await call('makeglossaries', [stem])
  else if (await has('.idx')) await call('makeindex', [stem + '.idx'])

  if (await has('.bcf')) {
    await call('biber', [stem])
  } else {
    const aux = await readFile(join(dir, stem + '.aux'), 'utf8').catch(() => '')
    if (/\\bibdata\{/.test(aux)) await call('bibtex', [stem])
  }

  return ran
}

/**
 * Compile with enough passes for TOC/cross-refs, then verify the PDF.
 * Always injects -synctex=1 so `locate` works afterwards.
 */
// --- one build per document at a time --------------------------------------
// Two compiles of the same document at once share its .aux/.toc files and destroy
// each other: racing two processes on this very book, one of them died with an
// unreadable error and produced no PDF. Serialise in-process with a promise queue
// (the plugin host can be handed two tool calls at once) and across processes with
// a lock file (a CLI run next to a plugin build).
const docQueues = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function serialise(key, fn) {
  const prev = docQueues.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(() => {}, () => {})
  docQueues.set(key, tail)
  tail.then(() => { if (docQueues.get(key) === tail) docQueues.delete(key) })
  return run
}

async function withDocLock(file, fn) {
  const key = createHash('sha1').update(resolve(file)).digest('hex').slice(0, 16)
  return serialise(key, () => withFileLock(key, fn))
}

async function withFileLock(key, fn) {
  const dir = join(tmpdir(), 'latex-look-locks')
  await mkdir(dir, { recursive: true })
  const lockPath = join(dir, `${key}.lock`)
  const deadline = Date.now() + 180000
  let fd = null
  for (;;) {
    try {
      fd = await open(lockPath, 'wx')
      await fd.writeFile(String(process.pid))
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // A crashed build leaves the lock behind. Trust its PID over the clock, so a
      // killed run does not wedge the document for ten minutes.
      let stale = false
      try {
        const pid = Number((await readFile(lockPath, 'utf8')).trim())
        if (pid > 0) {
          try { process.kill(pid, 0) } catch (err) { if (err.code === 'ESRCH') stale = true }
        }
      } catch { stale = true }
      if (!stale) {
        try {
          const st = await stat(lockPath)
          if (Date.now() - st.mtimeMs > 600000) stale = true
        } catch {}
      }
      if (stale) { await rm(lockPath, { force: true }); continue }
      if (Date.now() > deadline) {
        throw new Error('another build of this document is still running; gave up waiting after 3 minutes')
      }
      await sleep(250)
    }
  }
  try {
    return await fn()
  } finally {
    try { await fd.close() } catch {}
    try { await rm(lockPath, { force: true }) } catch {}
  }
}

export async function compile(texPath, options = {}) {
  return withDocLock(texPath, () => compileDoc(texPath, options))
}

async function compileDoc(texPath, { engine, maxPasses = 3, timeoutMs = 120000, noCache = false } = {}) {
  const file = resolve(texPath)
  await stat(file)
  const dir = dirname(file)
  const base = basename(file)
  const stem = base.replace(/\.tex$/i, '')
  const want = !engine || engine === 'auto' ? autoEngine() : engine
  const bin = findBinary(want)
  const pdf = join(dir, stem + '.pdf')

  const classic = ['xelatex', 'lualatex', 'pdflatex'].includes(want)
  const args = want === 'latexmk'
    ? [`-${want === 'latexmk' ? flavor(file) : 'pdf'}`, '-synctex=1', '-interaction=nonstopmode', '-file-line-error', base]
    : ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', base]
  const finalArgs = want === 'tectonic' ? ['--synctex', '--keep-logs', base] : args

  let passes = 0
  let last = null
  let prevSig = null
  let aux = []
  let auxDone = false
  const limit = classic ? Math.max(1, Math.min(10, maxPasses)) : 1
  const tocPath = join(dir, stem + '.toc')
  const tocBefore = existsSync(tocPath) ? (await stat(tocPath)).size : 0

  // Recompiling an unchanged document is pure latency: a 208-page book costs ~16s
  // per call and an agent typically looks at a dozen pages in a row. Remember the
  // shape of every input and reuse the PDF when none of them moved.
  const cacheDir = join(tmpdir(), 'latex-look-cache')
  const cachePath = join(cacheDir, createHash('sha1').update(file).digest('hex') + '.json')
  const cacheTag = { v: 1, want, limit }
  const sigBefore = noCache ? null : await sourceSignature(file, cacheTag)
  try {
    const hit = noCache ? null : JSON.parse(await readFile(cachePath, 'utf8'))
    if (hit && hit.sig === sigBefore && hit.want === want && existsSync(pdf)) {
      const art = await inspectPdf(pdf, file)
      if (art.exists && art.valid) {
        return {
          engine: want, passes: hit.passes || 0, code: 0, pdf,
          problems: [], warnings: hit.warnings || [], artifacts: art,
          log: '', ok: true, fatal: null, aux: hit.aux || [], cached: true,
        }
      }
    }
  } catch {}

  while (passes < limit) {
    last = await run(bin, finalArgs, { cwd: dir, timeoutMs })
    passes += 1
    if (last.error) { last.fatal = `failed to run ${want}: ${last.error}`; break }
    if (last.timedOut) {
      // A pass that blows the budget is nearly always a loop, not a slow machine:
      // ulem's \\uline inside a tabular is the classic one. Say so, and say how to raise it.
      last.fatal =
        `pass ${passes} did not finish within ${Math.round(timeoutMs / 1000)}s — an infinite loop in a macro is the usual cause ` +
        `(ulem's \\uline inside a tabular, or a \\loop with no exit). Raise timeoutSeconds if the document is genuinely that slow.`
      break
    }
    if (last.code !== 0) break
    if (!classic) break
    // Glossaries/index/bibliography run once, after pass 1 has written .glo/.idx,
    // so the remaining passes pick up the regenerated data.
    if (!auxDone) { aux = await runAuxTools(file, dir, stem); auxDone = true }
    const sig = await auxSignature(file)
    const log = await readFile(join(dir, stem + '.log'), 'utf8').catch(() => '')
    if (prevSig !== null && sig === prevSig && !needsRerun([last.stdout, last.stderr, log].join('\n'))) break
    prevSig = sig
  }

  const log = await readFile(join(dir, stem + '.log'), 'utf8').catch(() => '')
  const parsed = parseProblems([log, last?.stdout || '', last?.stderr || ''].join('\n'))
  const art = await inspectPdf(pdf, file)
  const problems = [...parsed.errors]
  // The reason a pass was killed (an infinite loop, or the engine could not be run at
  // all) used to live only in `fatal`, so the reader saw "no PDF was produced" and had
  // to guess why. Put it first: it is the only message that says what to do.
  if (last?.fatal) problems.unshift({ severity: 'error', file: null, line: null, message: last.fatal })
  if (!art.exists) {
    problems.push({ severity: 'error', file: null, line: null, message: `no PDF was produced (expected ${pdf})` })
  } else if (!art.valid) {
    problems.push({ severity: 'error', file: null, line: null, message: 'the produced PDF is invalid or truncated (missing %PDF- header or %%EOF marker)' })
  }
  if (art.tocExpected && !art.tocEntries) {
    problems.push({
      severity: 'error', file: null, line: null,
      message: 'the document declares \\tableofcontents but the table of contents is EMPTY (not enough passes, or there are no numbered sections)',
    })
  }
  // The .toc file is written as sections are processed, i.e. AFTER the TOC page
  // has already been typeset. So a single-pass build still finds entries in .toc
  // while the TOC page in the PDF is blank — the exact silent failure this tool
  // exists to catch. Only a pass count tells the two apart.
  if (art.tocExpected && passes < 2) {
    if (tocBefore > 0) {
      // unshift: a real book produces dozens of package warnings, and the display
      // only keeps the first few — this one must not be buried among them.
      parsed.warnings.unshift({
        severity: 'warning', file: null, line: null,
        message: `only ${passes} compile pass ran, so the table of contents is what the previous build wrote; at least 2 passes are needed for it to reflect this build — raise maxPasses`,
      })
    } else {
      problems.push({
        severity: 'error', file: null, line: null,
        message: `the table of contents page is EMPTY: \\tableofcontents needs at least 2 passes and maxPasses allowed only ${passes}`,
      })
    }
  }
  // A failing engine that yielded no parsed error must still explain itself;
  // silence here is exactly the failure mode this tool exists to prevent.
  if (last && last.code !== 0 && problems.length === 0) {
    problems.push({
      severity: 'error',
      file: null,
      line: null,
      message: `the engine exited with code ${last.code} but produced no recognisable error message; read ${join(dir, stem + '.log')}`,
    })
  }
  const ok = last?.code === 0 && !last?.timedOut && !last?.fatal && problems.length === 0

  // Only a clean build is worth remembering; a failing one is being edited right now.
  try {
    if (ok) {
      await mkdir(cacheDir, { recursive: true })
      const sigAfter = await sourceSignature(file, cacheTag)
      await writeFile(cachePath, JSON.stringify({
        sig: sigAfter, want, passes, warnings: parsed.warnings, aux, at: Date.now(),
      }))
    } else {
      await rm(cachePath, { force: true })
    }
  } catch {}

  return {
    engine: want, passes, code: last?.code ?? null, pdf,
    problems, warnings: parsed.warnings, artifacts: art, log, ok, fatal: last?.fatal, aux,
  }
}

function autoEngine() {
  for (const e of ENGINES) {
    if (findBinary(e) !== e) return e
  }
  return 'xelatex'
}

function flavor(texPath) {
  // Match the backend to the document; getting this wrong makes latexmk fail
  // outright on CJK documents, which are all xelatex here.
  try {
    const head = readFileSync(texPath, 'utf8').slice(0, 4000)
    const magic = /%!TEX\s+(?:TS-)?program\s*=\s*(xelatex|lualatex|pdflatex)/i.exec(head)
    if (magic) return magic[1].toLowerCase()
    if (/luatexja|luatexja-fontspec/i.test(head)) return 'lualatex'
    if (/(ctex|xeCJK|fontspec)/.test(head)) return 'xelatex'
  } catch {}
  return 'pdf'
}

/** Escape a path for use inside a PostScript string literal: ( ) and \ end it early. */
function psString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/**
 * Does any .tex reachable through \input/\include match `pattern`?
 * Scanning only the root file misses declarations that live in an included
 * preamble — the usual layout in multi-file books, where the root is a one-line
 * wrapper around \input{main}.
 */
async function anySourceMatches(texPath, pattern, maxDepth = 3) {
  const seen = new Set()
  let found = false
  const walk = async (p, depth) => {
    if (found || depth < 0) return
    const abs = resolve(p)
    if (seen.has(abs)) return
    seen.add(abs)
    const src = await readFile(abs, 'utf8').catch(() => null)
    if (src === null) return
    if (pattern.test(src)) { found = true; return }
    for (const m of src.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) {
      const name = m[1].trim()
      const target = name.endsWith('.tex') ? name : name + '.tex'
      await walk(resolve(dirname(abs), target), depth - 1)
    }
  }
  await walk(texPath, maxDepth)
  return found
}

async function inspectPdf(pdf, texPath) {
  const info = {
    path: pdf, exists: false, valid: false, bytes: 0, pages: null,
    tocExpected: false, tocEntries: null,
  }
  try {
    const s = await stat(pdf)
    if (!s.isFile()) return info
    info.exists = true
    info.bytes = s.size
    const buf = await readFile(pdf)
    info.valid = buf.subarray(0, 5).toString('latin1') === '%PDF-' && buf.subarray(-2048).toString('latin1').includes('%%EOF')
  } catch {}
  const r = await run(findBinary('gs'), [
    '-q', '-dNODISPLAY', '-dNOSAFER', '-c',
    `(${psString(pdf)}) (r) file runpdfbegin pdfpagecount = quit`,
  ])
  const n = parseInt((r.stdout || '').trim(), 10)
  if (Number.isFinite(n)) info.pages = n

  // A document that asks for a table of contents and gets an empty one is the
  // classic silent failure: clean log, exit code 0, blank TOC page. The
  // declaration often lives in an \input'ed preamble, so scan the whole tree.
  if (texPath) {
    info.tocExpected = await anySourceMatches(texPath, /\\tableofcontents/)
    if (info.tocExpected) {
      const toc = await readFile(String(texPath).replace(/\.tex$/i, '.toc'), 'utf8').catch(() => '')
      info.tocEntries = (toc.match(/\\contentsline/g) || []).length
    }
  }
  return info
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

/**
 * Rasterise every page in ONE gs invocation and measure the ink profile of each.
 *
 * A one-page-at-a-time loop is 200+ process spawns on a book; gs writes the whole
 * sequence in a single run (the `%04d` in the output name is the page counter).
 *
 * Rows are "ink" when they hold at least `minInkPixels` dark pixels, so a stray
 * anti-aliasing speck cannot extend the text block by a millimetre.
 */
async function inkProfiles(pdf, { dpi = 72, minInkPixels = 2, dark = 200 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'latex-look-audit-'))
  const tpl = join(dir, 'p%04d.ppm')
  const r = await run(findBinary('gs'), [
    '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=ppmraw', `-r${dpi}`,
    '-sOutputFile=' + tpl, pdf,
  ])
  if (r.code !== 0) throw new Error(`gs failed while profiling pages: ${r.stderr || r.stdout}`)
  const files = (await readdir(dir)).filter((f) => /^p\d+\.ppm$/.test(f)).sort()
  const out = []
  for (const f of files) {
    const img = parsePpm(await readFile(join(dir, f)))
    if (!img) continue
    const { width, height, data } = img
    const rows = []
    for (let y = 0; y < height; y++) {
      let n = 0
      const base = y * width * 3
      for (let x = 0; x < width; x++) {
        const i = base + x * 3
        if (data[i] < dark && data[i + 1] < dark && data[i + 2] < dark) n++
      }
      rows.push(n >= minInkPixels)
    }
    const ink = []
    for (let y = 0; y < height; y++) if (rows[y]) ink.push(y)
    const top = ink.length ? ink[0] : null
    const bottom = ink.length ? ink[ink.length - 1] : null
    // Largest run of blank rows strictly inside the content, in points.
    let gap = { height: 0, start: null }
    if (top != null) {
      let runStart = null
      for (let y = top; y <= bottom; y++) {
        if (!rows[y]) { if (runStart == null) runStart = y }
        else {
          if (runStart != null && y - runStart > gap.height) gap = { height: y - runStart, start: runStart }
          runStart = null
        }
      }
    }
    out.push({ top, bottom, height, gap, ink, rows, coverage: ink.length / height })
    await rm(join(dir, f), { force: true })
  }
  await rm(dir, { recursive: true, force: true })
  return out
}

/**
 * Find the pages a reader would call broken: a big hole at the page bottom, a page
 * that starts far below the top (a lone caption or a one-line paragraph), or a
 * nearly empty page.
 *
 * The reference text block is taken from the document itself (the highest and
 * lowest ink any page reaches), so no margin has to be guessed: a page whose last
 * ink sits 60 mm above the lowest ink of the whole book is a hole by any measure.
 *
 * @param {number} [opts.blankMm] a bottom hole this deep (mm) is reported
 */
export async function auditLayout(pdf, {
  blankMm = 30, minCoverage = 0.02, withText = true, furniture = true,
} = {}) {
  const profiles = await inkProfiles(pdf, { dpi: 72 })
  const n = profiles.length
  if (!n) return { pages: 0, findings: [], note: 'the PDF has no pages' }

  // Running heads, rules and page numbers sit at nearly the same height on every
  // page; body lines do not. A row that carries ink on >80% of the pages AND lies in
  // the outer 8% of the sheet is furniture, not content. Without this step a book's
  // page number becomes "the lowest ink of the book" and every single page looks
  // like it stops short.
  let furnitureRows = new Set()
  if (furniture) {
    const height = profiles[0].height
    const counts = new Array(height).fill(0)
    for (const p of profiles) for (const y of p.ink) counts[y]++
    for (let y = 0; y < height; y++) {
      const inBand = y < height * 0.08 || y > height * 0.92
      // 0.35, not 0.8: a running head is set in different words on different pages,
      // so its ascender rows light up on 70% of pages and its descender rows on 20%.
      // A per-row threshold high enough to keep body text out would let the head
      // through, and then "the deepest text of the book" becomes the page number.
      if (inBand && counts[y] / n > 0.35) furnitureRows.add(y)
    }
  }

  // A row mask is not enough: on a page whose running head has an ascender one row
  // higher than its neighbours', that row is *not* a majority row, so the page keeps
  // a "content top" up in the header. Once ANY row of the head/foot is recognised, the
  // whole band it belongs to is furniture.
  const height = profiles[0].height
  const headRows = [...furnitureRows].filter((y) => y < height * 0.08)
  const footRows = [...furnitureRows].filter((y) => y > height * 0.92)
  const headBandEnd = headRows.length ? Math.max(...headRows) + 2 : -1
  const footBandStart = footRows.length ? Math.min(...footRows) - 2 : height + 1
  const isFurniture = (y) => y <= headBandEnd || y >= footBandStart

  const pages = profiles.map((p, i) => {
    const keep = p.ink.filter((y) => !isFurniture(y))
    const top = keep.length ? keep[0] : null
    const bottom = keep.length ? keep[keep.length - 1] : null
    let gap = { height: 0, start: null }
    if (top != null) {
      let runStart = null
      for (let y = top; y <= bottom; y++) {
        if (isFurniture(y)) continue
        if (!p.rows[y]) { if (runStart == null) runStart = y }
        else {
          if (runStart != null && y - runStart > gap.height) gap = { height: y - runStart, start: runStart }
          runStart = null
        }
      }
    }
    return { page: i + 1, top, bottom, gap, coverage: keep.length / p.height, height: p.height }
  })

  const bounded = pages.filter((p) => p.top != null)
  if (!bounded.length) {
    return { pages: n, findings: [], furnitureRows: furnitureRows.size, note: 'every page is blank once page furniture is removed' }
  }
  const percentile = (arr, q) => {
    const a = [...arr].sort((x, y) => x - y)
    return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)))]
  }
  // The reference text block: how far the fullest pages reach. Percentiles rather
  // than min/max, so one deliberately short title page cannot redefine the block.
  const blockTop = percentile(bounded.map((p) => p.top), 0.05)
  const blockBottom = percentile(bounded.map((p) => p.bottom), 0.95)
  const mm = (pt) => (pt / 72) * 25.4
  const findings = []
  for (const p of pages) {
    if (p.top == null) {
      findings.push({ kind: 'blank-page', page: p.page, mm: mm(p.height), detail: 'no ink at all' })
      continue
    }
    if (p.coverage < minCoverage) {
      findings.push({ kind: 'nearly-empty', page: p.page, mm: mm(p.bottom - p.top), detail: `only ${(p.coverage * 100).toFixed(1)}% of the page carries ink` })
      continue
    }
    const bottomHole = blockBottom - p.bottom
    const topHole = p.top - blockTop
    if (mm(bottomHole) >= blankMm) {
      // A chapter or a section ends here, or content was pushed off the page. The
      // difference is visible: when a heading starts the next page it is set lower
      // than body text, so the next page begins well below the normal top. If the
      // next page starts at the normal top, the same section is still running and
      // this page simply stopped early — that is the hole a reader complains about.
      const next = pages[p.page] // pages[] is 0-based, so this is page+1
      const blockHeight = blockBottom - blockTop
      const continues = next && next.top != null && next.top - blockTop < blockHeight * 0.3
      findings.push({
        kind: continues ? 'bottom-hole' : 'section-end',
        page: p.page,
        mm: mm(bottomHole),
        detail: continues
          ? `content stops ${mm(bottomHole).toFixed(0)} mm above the deepest text of the book, and the next page resumes at the normal top — the text did not end here, it was pushed`
          : `content stops ${mm(bottomHole).toFixed(0)} mm above the deepest text of the book, and the next page opens a new chapter or section`,
      })
    } else if (mm(topHole) >= blankMm) {
      findings.push({ kind: 'starts-low', page: p.page, mm: mm(topHole), detail: `page starts ${mm(topHole).toFixed(0)} mm below the highest text of the book` })
    }
    if (mm(p.gap.height) >= Math.max(blankMm, 35)) {
      findings.push({ kind: 'hole-inside', page: p.page, mm: mm(p.gap.height), detail: `${mm(p.gap.height).toFixed(0)} mm of blank space inside the content` })
    }
  }
  // "The page stops short and the next page opens with a caption" is the single most
  // common complaint a reader makes about a LaTeX book: the figure did not fit, so it
  // moved. Naming the figure turns the finding from a measurement into a lead.
  if (withText) {
    let texts = null
    try { texts = await pageTexts(pdf) } catch { texts = null }
    if (texts) {
      for (const f of findings) {
        const nextText = texts[f.page] // 0-based: index f.page is page f.page+1
        if (!nextText) continue
        // The text layer of a page begins with its running head, so the caption is the
        // first match within the opening lines rather than literally the first line.
        const opening = nextText.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3)
        for (const line of opening) {
          const cap = line.match(/^([^\s\d]{1,6})\s*(\d+)\s*[-–—.]\s*(\d+)\s+\S/)
          if (cap) { f.nextPageOpensWith = `${cap[1]} ${cap[2]}-${cap[3]}`; break }
        }
      }
    }
  }
  if (withText) {
    for (const f of findings.slice(0, 40)) {
      try {
        const t = await pdfPageText(pdf, f.page)
        // The text layer of a page includes its running head and page number. Taking
        // the last line blindly makes the "last thing before the hole" the page number,
        // which is two characters long and useless as an identity anchor.
        const lines = String(t || '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !/^[0-9ivxlc]+$/i.test(l))
        if (lines.length) {
          f.lastLine = lines[lines.length - 1].slice(0, 60)
          f.firstLine = lines[0].slice(0, 60)
        }
      } catch {}
    }
  }
  return { pages: n, blockTop, blockBottom, furnitureRows: furnitureRows.size, findings }
}

export async function renderPage(pdf, page, { dpi = 140, outDir = tmpdir() } = {}) {
  await mkdir(outDir, { recursive: true })
  // gs treats %d in -sOutputFile as a page-number template, so a literal % in a
  // filename would quietly write a different file and look like a render failure.
  const label = basename(pdf).replace(/\.pdf$/i, '').replace(/%/g, '_')
  const out = join(outDir, `${label}-p${page}@${dpi}dpi.png`)
  const r = await run(findBinary('gs'), [
    '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', `-r${dpi}`,
    '-dFirstPage=' + page, '-dLastPage=' + page, '-sOutputFile=' + out, pdf,
  ])
  if (r.code !== 0) throw new Error(`gs render failed: ${r.stderr || r.stdout}`)
  if (!existsSync(out)) {
    throw new Error(`gs produced no image for page ${page} of ${basename(pdf)} (the page number is probably out of range)`)
  }
  const s = await stat(out)
  return { path: out, bytes: s.size, width: null, height: null }
}

async function renderPpm(pdf, page, dpi) {
  const out = join(tmpdir(), `latex-look-${process.pid}-${Date.now()}-p${page}.ppm`)
  const r = await run(findBinary('gs'), [
    '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=ppmraw', `-r${dpi}`,
    '-dFirstPage=' + page, '-dLastPage=' + page, '-sOutputFile=' + out, pdf,
  ])
  if (r.code !== 0) return null
  const buf = await readFile(out)
  await rm(out, { force: true })
  return parsePpm(buf)
}

/** Parse a binary P6 PPM. */
export function parsePpm(buf) {
  let i = 0
  const token = () => {
    while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i++
    if (buf[i] === 0x23) { while (i < buf.length && buf[i] !== 0x0a) i++; return token() }
    const start = i
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) i++
    return buf.subarray(start, i).toString('latin1')
  }
  if (token() !== 'P6') return null
  const w = parseInt(token(), 10)
  const h = parseInt(token(), 10)
  const maxv = parseInt(token(), 10)
  i++ // single whitespace after header
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  // A truncated raster would make diffRaster read past the buffer, produce NaN,
  // and silently report a 0% change. Refuse it instead.
  if (buf.length - i < w * h * 3) return null
  return { width: w, height: h, max: maxv, data: buf.subarray(i) }
}

/**
 * Pixel diff between two PPM rasters.
 * Returns the fraction of changed pixels and the bounding box of the change,
 * expressed in points (72/inch) so it can feed straight into `synctex edit`.
 */
export function diffRaster(a, b, dpi = 72) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return null
  const n = a.width * a.height
  let changed = 0
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  const ch = 3
  for (let p = 0; p < n; p++) {
    const o = p * ch
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2])
    if (d > 24) {
      changed++
      const x = p % a.width
      const y = (p - x) / a.width
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!changed) return { changedRatio: 0, bbox: null }
  const k = 72 / dpi
  return {
    changedRatio: changed / n,
    changedPixels: changed,
    bbox: {
      x: +(minX * k).toFixed(2), y: +(minY * k).toFixed(2),
      width: +((maxX - minX + 1) * k).toFixed(2), height: +((maxY - minY + 1) * k).toFixed(2),
    },
  }
}

// ---------------------------------------------------------------------------
// one picture instead of two: the page before | the page after
// ---------------------------------------------------------------------------
//
// Handing back two separate PNGs asks the reader to open both and hunt for the
// difference — for someone who only reads the PDF, that is the hard part. One
// side-by-side image answers "did it change and how" at a glance.
//
// A PNG needs no dependency: signature, IHDR, IDAT (zlib), IEND. zlib ships with
// node, so the encoder is twenty lines of chunk framing plus a CRC table.

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** Encode 8-bit RGB pixels as a PNG buffer. */
export function encodePng(width, height, rgb) {
  const stride = width * 3
  const raw = Buffer.allocUnsafe((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type 0, per row
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 4 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Compose two parsed PPM rasters: left | gutter | right, on white. */
export function sideBySide(left, right, gap = 24) {
  const width = left.width + gap + right.width
  const height = Math.max(left.height, right.height)
  const out = Buffer.alloc(width * height * 3, 0xff)
  const blit = (img, x) => {
    for (let y = 0; y < img.height; y++) {
      const from = y * img.width * 3
      img.data.copy(out, (y * width + x) * 3, from, from + img.width * 3)
    }
  }
  blit(left, 0)
  blit(right, left.width + gap)
  return { width, height, data: out }
}

// ---------------------------------------------------------------------------
// locate (SyncTeX, both directions)
// ---------------------------------------------------------------------------

/** PDF point (72/inch, origin top-left) → source location. */
export async function locateFromPoint(pdf, page, x, y) {
  const r = await run(findBinary('synctex'), ['edit', '-o', `${page}:${x}:${y}:${pdf}`])
  const out = (r.stdout || '') + (r.stderr || '')
  const input = /^Input:\s*(.+)$/m.exec(out)
  const line = /^Line:\s*(-?\d+)/m.exec(out)
  const col = /^Column:\s*(-?\d+)/m.exec(out)
  if (!input || !line || Number(line[1]) < 0) return null
  return { file: input[1].trim(), line: Number(line[1]), column: col ? Number(col[1]) : null, page: Number(page) }
}

/** Source line → PDF page and point. */
export async function locateFromLine(texPath, pdf, line) {
  const r = await run(findBinary('synctex'), ['view', '-i', `${line}:1:${texPath}`, '-o', pdf])
  const out = (r.stdout || '') + (r.stderr || '')
  const page = /^Page:\s*(\d+)/m.exec(out)
  const px = /^x:\s*([\d.]+)/m.exec(out)
  const py = /^y:\s*([\d.]+)/m.exec(out)
  if (!page || !px || !py) return null
  return { page: Number(page[1]), x: Number(px[1]), y: Number(py[1]) }
}

/**
 * Find a text anchor in the source, forward-map it to PDF coordinates, and
 * return the candidates together with their source lines.
 *
 * Searches every file reachable through \input/\include (three levels), not just
 * the root: a real book is root → main → chap1, so a one-level scan finds nothing
 * in it, which is exactly the case this tool exists for. Returns the hits plus how
 * many files were searched, so a miss can say something useful instead of nothing.
 */
// --- the PDF's own text layer, to check where a box really landed ------------
//
// SyncTeX records the page on which a box was BUILT. A float that TeX moves to the
// next page therefore gets the previous page's number: the revision-history table in
// the test book is on page 206, SyncTeX says 205, and page 205 is the acknowledgements.
// An agent following that number renders the wrong page and concludes the text is gone.

const pageTextCache = new Map()

/** One page's text layer via Ghostscript's txtwrite device. null when unavailable. */
/**
 * The text layer of every page, in one gs run.
 *
 * `txtwrite` separates pages with a form feed, so a book that takes 200 separate
 * processes to read page by page comes back in one. Anything that needs the text of
 * many pages — an audit, an ordering check — must use this rather than looping.
 */
export async function pageTexts(pdf) {
  const dir = await mkdtemp(join(tmpdir(), 'latex-look-text-'))
  const tpl = join(dir, 'p%04d.txt')
  const r = await run(findBinary('gs'), [
    '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=txtwrite', '-sOutputFile=' + tpl, pdf,
  ])
  if (r.code !== 0) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(`gs text extraction failed: ${r.stderr || r.stdout}`)
  }
  // One file per page, numbered from 1: the %04d counter IS the page number, so the
  // array index can never drift from the page it describes. Splitting one big file on
  // form feeds would be cheaper but gs does not reliably separate pages that way.
  const files = (await readdir(dir)).filter((f) => /^p\d+\.txt$/.test(f)).sort()
  const out = []
  for (const f of files) {
    out.push(await readFile(join(dir, f), 'utf8').catch(() => ''))
    await rm(join(dir, f), { force: true })
  }
  await rm(dir, { recursive: true, force: true })
  return out
}

/**
 * Reading order of numbered things — figures, tables, equations.
 *
 * A numbered object that becomes a float can land AFTER an object with a larger
 * number that stayed inline, and the reader turns the page to see 图 3-4 before
 * 图 3-3. Nothing else in the tool looks at order, and the source order is exactly
 * what a float does not preserve.
 *
 * Only labels that START a line are counted: a caption begins its own line in the
 * text layer, while a reference in the middle of a paragraph ("如图 3-4 所示") does
 * not, and references are legitimately out of order.
 */
export async function findSequence(pdf, { label = '图', maxGap = 6 } = {}) {
  const pages = await pageTexts(pdf)
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|\\n)[ \\t]*${esc}\\s*(\\d+)\\s*[-–—]\\s*(\\d+)`, 'g')
  const seen = []
  for (let i = 0; i < pages.length; i++) {
    const text = pages[i]
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) {
      seen.push({ chapter: Number(m[2]), number: Number(m[3]), page: i + 1, label: `${label} ${m[2]}-${m[3]}` })
    }
  }
  // The same label can appear twice on a page (a long caption wraps, the number is
  // repeated in a continuation line). Consecutive duplicates are one object.
  const unique = []
  for (const s of seen) {
    const last = unique[unique.length - 1]
    if (last && last.chapter === s.chapter && last.number === s.number) continue
    unique.push(s)
  }
  const inversions = []
  for (let i = 1; i < unique.length; i++) {
    const a = unique[i - 1], b = unique[i]
    if (b.chapter < a.chapter || (b.chapter === a.chapter && b.number < a.number)) {
      inversions.push({ before: a, after: b, gap: a.page - b.page })
    }
  }
  const firstOnEachPage = []
  for (const s of unique) {
    const last = firstOnEachPage[firstOnEachPage.length - 1]
    if (last && last.page === s.page) continue
    firstOnEachPage.push(s)
  }
  return { label, total: unique.length, inversions, firstOnEachPage }
}

export async function pdfPageText(pdf, page) {
  const key = `${pdf}\u0000${page}`
  if (pageTextCache.has(key)) return pageTextCache.get(key)
  const out = join(tmpdir(), `latex-look-${process.pid}-${Date.now()}-t${page}.txt`)
  let text = null
  try {
    const r = await run(findBinary('gs'), [
      '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=txtwrite',
      `-dFirstPage=${page}`, `-dLastPage=${page}`, '-sOutputFile=' + out, pdf,
    ])
    if (r.code === 0) text = await readFile(out, 'utf8')
  } catch {
    text = null
  } finally {
    await rm(out, { force: true })
  }
  pageTextCache.set(key, text)
  return text
}

// Whitespace differs between the source and the typeset page (line breaks, indentation),
// so compare with all whitespace removed.
const squeeze = (s) => String(s).replace(/\s+/g, '')

/**
 * Which page actually carries `needle`? Trust SyncTeX's guess only if the page's text
 * layer agrees; otherwise look one and two pages either side.
 */
export async function pageCarryingText(pdf, guess, needle) {
  const want = squeeze(needle)
  if (!want) return { page: guess, verified: false }
  for (const candidate of [guess, guess - 1, guess + 1, guess - 2, guess + 2]) {
    if (!Number.isInteger(candidate) || candidate < 1) continue
    const text = await pdfPageText(pdf, candidate)
    if (text && squeeze(text).includes(want)) return { page: candidate, verified: true }
  }
  return { page: guess, verified: false }
}

export async function locateText(texPath, pdf, text) {
  const main = resolve(texPath)
  const needle = String(text).trim()
  const hits = []
  // A whitespace-only needle matches every line, which produced eight confident
  // "locations" that were pure noise.
  if (!needle) return { hits, searched: 0 }
  const files = (await collectReachable(main)).filter((f) => /\.tex$/i.test(f))
  for (const f of files) {
    let src = ''
    try { src = await readFile(f, 'utf8') } catch { continue }
    const lines = src.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(needle)) continue
      const pos = await locateFromLine(f, pdf, i + 1)
      if (pos) {
        const where = await pageCarryingText(pdf, pos.page, needle)
        hits.push({
          file: f,
          line: i + 1,
          ...pos,
          page: where.page,
          synctexPage: pos.page,
          pageVerified: where.verified,
          context: lines[i].trim().slice(0, 120),
        })
      }
      if (hits.length >= 8) return { hits, searched: files.length }
    }
  }
  return { hits, searched: files.length }
}

// ---------------------------------------------------------------------------
// one-call convenience: the whole "look" verb
// ---------------------------------------------------------------------------

/**
 * Compile, render, optionally locate and diff. This is what both the CLI and
 * the MCP tool call.
 */
export async function look(file, {
  page, at, compare = 'previous', dpi = 140, engine,
  maxPasses = 3, timeoutSeconds = 300, outDir, fresh = false,
  audit = false, auditBlankMm = 30, sequence = null,
} = {}) {
  const texPath = resolve(file)
  const stem = basename(texPath).replace(/\.tex$/i, '')
  const dir = dirname(texPath)
  const pdf = join(dir, stem + '.pdf')
  const workDir = outDir || join(tmpdir(), `latex-look-${process.pid}`)
  await mkdir(workDir, { recursive: true })

  // An `engine` value reached spawn() unvalidated, so a caller could name any
  // executable on disk. Only the engines this tool actually supports are allowed.
  if (engine && engine !== 'auto' && !ENGINES.includes(String(engine))) {
    const msg = `unknown engine "${engine}": expected auto or one of ${ENGINES.join(', ')}`
    return {
      ok: false, engine: String(engine), passes: 0, file: texPath, pdf,
      pages: null, page: 1,
      images: { after: null, before: null }, located: null, diff: null,
      problems: [{ severity: 'error', file: null, line: null, message: msg }],
      warnings: [], toc: { expected: false, entries: null },
      aux: [], fatal: msg, compareError: null,
    }
  }

  // Snapshot the comparison PDF BEFORE compiling: a caller-supplied compare path
  // is very often the document's own PDF, which the compile is about to overwrite.
  //
  // The "previous" snapshot is kept per document rather than per call. An agent
  // that just edited something inspects several pages of the SAME build; with a
  // per-call snapshot only the first of those pages could be diffed, because every
  // later call is served from the build cache and has nothing left to compare to.
  const prevKey = createHash('sha1').update(texPath).digest('hex')
  // One directory per document, and the snapshot keeps the document's own name: a
  // snapshot called 1ec06dee....pdf produced a "before" image called
  // 1ec06dee...-p11.png, which tells the user nothing about which file it is.
  const prevDir = join(tmpdir(), 'latex-look-prev', prevKey)
  const prevTmp = join(prevDir, `${stem}-before.tmp.pdf`)
  const prevCommitted = join(prevDir, `${stem}-before.pdf`)
  let beforePdf = null
  let compareError = null
  // Snapshot unconditionally, not only when a diff is requested: the snapshot is the
  // baseline for the NEXT comparison, and a plain look that rebuilds must advance it.
  // Otherwise the next "compare to previous" spans two edits and reports twice the
  // change. A few megabytes of copy is nothing next to the compile that follows.
  try {
    await stat(pdf)
    await mkdir(prevDir, { recursive: true })
    await copyFile(pdf, prevTmp)
    beforePdf = prevTmp
  } catch { beforePdf = null }
  if (typeof compare === 'string' && compare !== 'previous') {
    const abs = resolve(compare)
    try {
      await stat(abs)
      beforePdf = join(workDir, `compare-${stem}.pdf`)
      await copyFile(abs, beforePdf)
    } catch {
      beforePdf = null
      compareError = `could not read the compare PDF: ${abs}`
    }
  }

  let pdfBefore = null
  try {
    const s = await stat(pdf)
    pdfBefore = { mtimeMs: s.mtimeMs, size: s.size }
  } catch { pdfBefore = null }

  const build = await compile(texPath, { engine, maxPasses, noCache: fresh, timeoutMs: Math.max(5, timeoutSeconds) * 1000 })
  const pages = build.artifacts.pages

  // Publish the pre-build snapshot after EVERY real build, not only when a diff was
  // requested. Otherwise a plain look leaves the baseline one edit behind, and the
  // next "compare to previous" silently spans two edits — the user's last edit plus
  // the one before it.
  if (!build.cached && build.ok && beforePdf) {
    try {
      await rename(prevTmp, prevCommitted)
      beforePdf = prevCommitted
    } catch {}
  }

  if (compare === 'previous') {
    if (build.cached) {
      // Nothing was rebuilt, so the state worth comparing against is the snapshot
      // published by the last real build — the PDF on disk IS that build.
      beforePdf = existsSync(prevCommitted) ? prevCommitted : null
      if (!beforePdf) {
        compareError = 'nothing was recompiled and no earlier build was recorded, so there is nothing to compare against'
      }
    }
  }

  // A failed compile leaves the previous PDF untouched. Rendering that file and
  // diffing it against the pre-compile snapshot reports "0.00% changed", which
  // reads as "your edit changed nothing" when nothing compiled at all. A fixed
  // time window is not enough (two runs a second apart defeat it), so compare the
  // file's identity before and after the compile instead.
  let pdfStale = false
  if (!build.cached) {
    try {
      const s = await stat(build.pdf)
      pdfStale = pdfBefore ? (s.mtimeMs === pdfBefore.mtimeMs && s.size === pdfBefore.size) : false
    } catch {
      pdfStale = true
    }
  }

  if (pdfStale) {
    // When a pass was killed, that reason is the whole story ("did not finish within
    // 120s — infinite loop"), and it is more useful than "produced no PDF".
    const killed = build.fatal ? `${build.fatal.replace(/\s+$/, '')} — so there is no page to show` : null
    const msg = killed || (!build.artifacts.exists
      ? 'the document did not compile and produced no PDF, so there is no page to show'
      : build.problems.length
        ? 'the document did not compile, so no page is shown (the PDF on disk is left over from an earlier run)'
        : 'the document produced no PDF, so no page is shown')
    return {
      ok: false, engine: build.engine, passes: build.passes, file: texPath, pdf: build.pdf,
      pages, page: Number.isInteger(page) ? page : 1,
      images: { after: null, before: null },
      located: null, diff: null,
      problems: [...build.problems, { severity: 'error', file: null, line: null, message: msg }],
      warnings: build.warnings || [],
      toc: { expected: build.artifacts.tocExpected, entries: build.artifacts.tocEntries },
      aux: build.aux || [],
      fatal: msg,
    }
  }

  // which page to show. A non-integer must stay visible so badPage can reject it;
  // mapping it to null made "page 2.5" quietly render page 1.
  let targetPage = page == null ? null : Number.isInteger(page) ? page : NaN
  let located = null
  if (at && typeof at === 'object' && at.text) {
    located = (await locateText(texPath, build.pdf, at.text))
    const found = Array.isArray(located) ? { hits: located, searched: 0 } : located
    located = found.hits
    if (targetPage === null && located.length) targetPage = located[0].page
    if (!located.length && found.searched > 0) {
      // Silence is the worst possible answer to "where is this text?".
      ;(build.warnings || (build.warnings = [])).unshift({
        severity: 'warning', file: null, line: null,
        message: `the text "${String(at.text).slice(0, 60)}" was not found in any of the ${found.searched} source files reached through \\input/\\include`,
      })
    }
  } else if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    const hit = await locateFromPoint(build.pdf, targetPage || 1, at.x, at.y)
    located = hit ? [hit] : []
  }
  // Default only when the caller said nothing. `!targetPage` also swallowed an
  // explicit page 0, which then silently rendered page 1 instead of complaining.
  if (targetPage === null) targetPage = 1

  // Asking for a page the document does not have used to reach stat() inside
  // renderPage and throw ENOENT straight out of the tool. That is a wrong page
  // number, not a crash: report it and skip rendering.
  const badPage =
    !Number.isInteger(targetPage) || targetPage < 1 || (Number.isInteger(pages) && targetPage > pages)
  if (badPage) {
    const msg = !Number.isInteger(targetPage)
      ? `page must be a whole number, got ${targetPage}`
      : Number.isInteger(pages)
        ? `page ${targetPage} is out of range: the document has ${pages} page(s)`
        : `page ${targetPage} is not a valid page number`
    return {
      ok: false, engine: build.engine, passes: build.passes, file: texPath, pdf: build.pdf,
      pages, page: targetPage,
      images: { after: null, before: null },
      located, diff: null,
      problems: [...build.problems, { severity: 'error', file: null, line: null, message: msg }],
      warnings: build.warnings || [],
      toc: { expected: build.artifacts.tocExpected, entries: build.artifacts.tocEntries },
      aux: build.aux || [],
      fatal: msg,
    }
  }

  let after
  try {
    after = await renderPage(build.pdf, targetPage, { dpi, outDir: workDir })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // If the compile itself failed, that is the cause. "the page number is probably
    // out of range" is a misdiagnosis for a document that produced no pages at all.
    const compileFailed = build.problems.length > 0
    const fatal = compileFailed
      ? 'the document did not compile, so no page could be rendered (see PROBLEMS)'
      : msg
    return {
      ok: false, engine: build.engine, passes: build.passes, file: texPath, pdf: build.pdf,
      pages, page: targetPage,
      images: { after: null, before: null },
      located, diff: null,
      problems: compileFailed
        ? build.problems
        : [...build.problems, { severity: 'error', file: null, line: null, message: msg }],
      warnings: build.warnings || [],
      toc: { expected: build.artifacts.tocExpected, entries: build.artifacts.tocEntries },
      aux: build.aux || [],
      fatal,
    }
  }
  let before = null
  let diff = null
  // A diff only means something when the build succeeded. Comparing against a page
  // that failed to compile invites reading a broken render as the intended result.
  if (beforePdf && build.ok) {
    try {
      // A separate directory: the compared PDF usually has the SAME basename as
      // the document's own PDF, and renderPage names its image after that
      // basename — so both renders landed on one file and the "after" image was
      // silently replaced by the pre-edit one.
      before = await renderPage(beforePdf, targetPage, { dpi, outDir: join(workDir, 'before') })
      const [pa, pb] = [await renderPpm(beforePdf, targetPage, 72), await renderPpm(build.pdf, targetPage, 72)]
      diff = diffRaster(pa, pb, 72)
    } catch {
      // Most often the page does not exist in the older build: after an edit that
      // repaginates, page 230 of the new build may be page 230 of a 208-page PDF.
      if (!compareError) {
        let had = ''
        try {
          const bp = await inspectPdf(beforePdf)
          if (bp.pages) had = `; it had ${bp.pages} page${bp.pages === 1 ? '' : 's'}`
        } catch {}
        compareError = `page ${targetPage} does not exist in the previous build${had}, so there is nothing to diff — the document was probably repaginated by the edit`
      }
    }
  } else if (beforePdf && !build.ok && !compareError) {
    compareError = 'the compile failed, so no before/after diff was computed'
  } else if (compare === 'previous' && !beforePdf && !compareError) {
    // No earlier PDF to copy: the first look of a document, or the PDF was removed.
    // Saying nothing would read as "your edit changed nothing".
    compareError = 'there was no earlier build of this document to compare against'
  }

  // One file instead of two: the page before on the left, the page after on the
  // right, at the same resolution as the single-page renders.
  let sideBySideImage = null
  // Only when something actually moved: two identical pages side by side answer
  // nothing, and the composite costs two extra renders plus a PNG encode.
  if (before && build.ok && diff && diff.changedPixels > 0) {
    try {
      const [pl, pr] = [
        await renderPpm(beforePdf, targetPage, dpi),
        await renderPpm(build.pdf, targetPage, dpi),
      ]
      if (pl && pr) {
        const merged = sideBySide(pl, pr)
        sideBySideImage = join(workDir, `compare-p${targetPage}@${dpi}dpi.png`)
        await writeFile(sideBySideImage, encodePng(merged.width, merged.height, merged.data))
      }
    } catch {
      sideBySideImage = null
    }
  }

  // Reading order: a float can land after an object with a larger number that stayed
  // inline, and the reader turns the page to see 图 3-4 before 图 3-3.
  let sequenceReport = null
  if (sequence) {
    try {
      sequenceReport = await findSequence(build.pdf, { label: String(sequence) })
    } catch (e) {
      sequenceReport = { error: e instanceof Error ? e.message : String(e) }
    }
  }

  // Whole-document audit with a BASELINE: a chapter that ends two thirds down a page
  // is normal typography, and reporting all of them buries the one page the reader is
  // complaining about. The first run records a baseline; after an edit only findings
  // that were not there before are worth the reader's attention — those are the ones
  // the edit itself introduced.
  let auditReport = null
  if (audit) {
    try {
      const current = await auditLayout(build.pdf, { blankMm: auditBlankMm, withText: true })
      const baseDir = join(tmpdir(), 'latex-look-audit-baseline', prevKey)
      const baseFile = join(baseDir, `${stem}.json`)
      let baseline = null
      try { baseline = JSON.parse(await readFile(baseFile, 'utf8')) } catch { baseline = null }
      // Match on the TEXT at the break, not on the page number: any edit that adds or
      // removes a line repaginates the whole book, so "the page that stops short" moves
      // even when it is the same hole. The last line of text before the hole is the
      // stable identity; the page number is only a fallback for pages with no text.
      const anchor = (f) => (f.lastLine ? f.lastLine.replace(/\s+/g, '').slice(0, 14) : '')
      const same = (a, b) => {
        const aa = anchor(a), bb = anchor(b)
        if (aa && bb && aa.length >= 6 && bb.length >= 6) return aa.slice(0, 8) === bb.slice(0, 8)
        return a.kind === b.kind && Math.abs(a.page - b.page) <= 2 && Math.abs(a.mm - b.mm) <= Math.max(8, b.mm * 0.4)
      }
      // With no baseline there is nothing to have changed from: every finding is
      // pre-existing, so none of them is "new". Reporting them as new made a first
      // audit of an untouched book look like the book had just been broken.
      const fresh = []
      if (baseline) {
        for (const f of current.findings) {
          if (f.kind === 'section-end') continue
          if (!baseline.findings.some((b) => same(f, b))) fresh.push(f)
        }
      }
      await mkdir(baseDir, { recursive: true })
      await writeFile(baseFile, JSON.stringify({
        at: new Date().toISOString(),
        pages: current.pages,
        blockTop: current.blockTop,
        blockBottom: current.blockBottom,
        findings: current.findings,
      }))
      auditReport = {
        pages: current.pages,
        findings: current.findings.filter((f) => f.kind !== 'section-end'),
        sectionEnds: current.findings.filter((f) => f.kind === 'section-end').length,
        newFindings: fresh,
        hadBaseline: !!baseline,
        baselinePages: baseline?.pages ?? null,
      }
    } catch (e) {
      auditReport = { error: e instanceof Error ? e.message : String(e) }
    }
  }

  return {
    ok: build.ok,
    engine: build.engine,
    passes: build.passes,
    file: texPath,
    pdf: build.pdf,
    pages,
    page: targetPage,
    audit: auditReport,
    sequence: sequenceReport,
    images: { after: after.path, before: before?.path || null, sideBySide: sideBySideImage },
    located,
    diff,
    problems: build.problems,
    warnings: build.warnings || [],
    toc: { expected: build.artifacts.tocExpected, entries: build.artifacts.tocEntries },
    aux: build.aux || [],
    compareError,
    cached: !!build.cached,
    fatal: build.fatal || null,
  }
}
