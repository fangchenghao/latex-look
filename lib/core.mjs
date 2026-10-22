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
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

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
  const queue = [[main, 0]]
  while (queue.length) {
    const [f, depth] = queue.shift()
    let src = ''
    try { src = await readFile(f, 'utf8') } catch { continue }
    const d = dirname(f)
    if (depth < 3) {
      for (const m of src.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) {
        const name = m[1].trim()
        const p = resolve(d, name.endsWith('.tex') ? name : name + '.tex')
        if (!seen.has(p)) { seen.add(p); queue.push([p, depth + 1]) }
      }
    }
    for (const m of src.matchAll(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      const raw = m[1].trim()
      for (const cand of [raw, ...['.png', '.jpg', '.jpeg', '.pdf', '.eps'].map((e) => raw + e)]) {
        const p = resolve(d, cand)
        if (existsSync(p)) { seen.add(p); break }
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
export async function compile(texPath, { engine, maxPasses = 3, timeoutMs = 300000, noCache = false } = {}) {
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
    if (last.timedOut) { last.fatal = `timed out after ${Math.round(timeoutMs / 1000)}s`; break }
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
      parsed.warnings.push({
        severity: 'warning', file: null, line: null,
        message: `only ${passes} compile pass ran, so the table of contents still shows what the previous build wrote; raise maxPasses for an accurate TOC`,
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
 * Searches the main file and every \input/\include target next to it.
 */
export async function locateText(texPath, pdf, text) {
  const main = resolve(texPath)
  const dir = dirname(main)
  const files = [main]
  try {
    const src = await readFile(main, 'utf8')
    for (const m of src.matchAll(/\\(?:input|include)\{([^}]+)\}/g)) {
      const p = resolve(dir, m[1].endsWith('.tex') ? m[1] : m[1] + '.tex')
      if (!files.includes(p)) files.push(p)
    }
  } catch {}
  const needle = String(text).trim()
  const hits = []
  // A whitespace-only needle matches every line, which produced eight confident
  // "locations" that were pure noise.
  if (!needle) return hits
  for (const f of files) {
    let src = ''
    try { src = await readFile(f, 'utf8') } catch { continue }
    const lines = src.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(needle)) continue
      const pos = await locateFromLine(f, pdf, i + 1)
      if (pos) hits.push({ file: f, line: i + 1, ...pos, context: lines[i].trim().slice(0, 120) })
      if (hits.length >= 8) return hits
    }
  }
  return hits
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
  let beforePdf = null
  let compareError = null
  if (compare === 'previous') {
    try {
      await stat(pdf)
      beforePdf = join(workDir, `${stem}-before.pdf`)
      await copyFile(pdf, beforePdf)
    } catch { beforePdf = null }
  } else if (typeof compare === 'string' && compare !== 'previous') {
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

  // A reused build means nothing was recompiled, so "the PDF from before this
  // call" is this very file — a diff would always report 0%.
  if (build.cached && compare === 'previous') {
    beforePdf = null
    compareError = 'the sources are unchanged since the last build, so nothing was recompiled and there is no before/after to show'
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
    const msg = !build.artifacts.exists
      ? 'the document did not compile and produced no PDF, so there is no page to show'
      : build.problems.length
        ? 'the document did not compile, so no page is shown (the PDF on disk is left over from an earlier run)'
        : 'the document produced no PDF, so no page is shown'
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
    located = await locateText(texPath, build.pdf, at.text)
    if (targetPage === null && located.length) targetPage = located[0].page
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
  if (beforePdf && !build.fatal) {
    try {
      // A separate directory: the compared PDF usually has the SAME basename as
      // the document's own PDF, and renderPage names its image after that
      // basename — so both renders landed on one file and the "after" image was
      // silently replaced by the pre-edit one.
      before = await renderPage(beforePdf, targetPage, { dpi, outDir: join(workDir, 'before') })
      const [pa, pb] = [await renderPpm(beforePdf, targetPage, 72), await renderPpm(build.pdf, targetPage, 72)]
      diff = diffRaster(pa, pb, 72)
    } catch { /* optional */ }
  }

  return {
    ok: build.ok,
    engine: build.engine,
    passes: build.passes,
    file: texPath,
    pdf: build.pdf,
    pages,
    page: targetPage,
    images: { after: after.path, before: before?.path || null },
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
