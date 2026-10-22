/**
 * Real-book scenario tests.
 *
 * Runs the plugin against a COPY of a real 208-page book (164 .tex files, a
 * custom .sty, images, glossaries, fancyhdr page furniture). The copy lives
 * outside the repo:
 *
 *   LATEX_LOOK_BOOK=/path/to/book node test/book-scenarios.mjs
 *
 * Every mutation is reverted, so the copy is left as it was found.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const BOOK = resolve(process.env.LATEX_LOOK_BOOK || join(dirname(REPO), 'nndl-book-test'))
const ENTRY = 'nndl-ebook.tex'
const WORK = '/tmp/latex-look-plugin-test-book'

if (!existsSync(join(BOOK, ENTRY))) {
  console.error(`book not found: ${join(BOOK, ENTRY)}\nset LATEX_LOOK_BOOK=/path/to/book`)
  process.exit(2)
}

// --- isolated plugin copy with a stubbed dsh-tools -------------------------
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
cpSync(join(REPO, 'index.js'), join(WORK, 'index.js'))
cpSync(join(REPO, 'lib'), join(WORK, 'lib'), { recursive: true })
const SHIM = join(WORK, 'node_modules/@deepseek-ai/dsh-tools')
mkdirSync(SHIM, { recursive: true })
writeFileSync(join(SHIM, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', exports: { '.': './index.js' },
}))
writeFileSync(join(SHIM, 'index.js'), 'export function defineTool(def) { return def }\n')

const mod = await import(pathToFileURL(join(WORK, 'index.js')).href)
const registered = { tools: {} }
mod.apply({ tools: { register: (t) => { registered.tools[t.name] = t } }, systemPrompt: { section: () => {} } })
const tool = registered.tools.latex_look

const results = []
function record(name, ok, note) {
  results.push({ name, ok, note })
  console.log(`${ok ? '  ok ' : '  FAIL'} ${name}${note ? `\n         ${note}` : ''}`)
}
async function call(args) {
  const t0 = Date.now()
  try {
    const out = await tool.execute({ file: join(BOOK, ENTRY), ...args })
    return { out, threw: null, ms: Date.now() - t0 }
  } catch (e) {
    return { out: '', threw: e, ms: Date.now() - t0 }
  }
}
const pages = (out) => {
  const m = /pages: (\d+)/.exec(out)
  return m ? Number(m[1]) : null
}
const toc = (out) => {
  const m = /toc:\s*(\d+) entries/.exec(out)
  return m ? Number(m[1]) : null
}
/** mutate a book file, returning a restore function */
function withFile(rel, transform) {
  const p = join(BOOK, rel)
  const original = readFileSync(p, 'utf8')
  writeFileSync(p, transform(original))
  return () => writeFileSync(p, original)
}

console.log(`book: ${BOOK}\n`)

// --- 1. cold build ---------------------------------------------------------
const cold = await call({ page: 100 })
record('首次构建 208 页书籍', !cold.threw && cold.out.startsWith('OK') && pages(cold.out) === 208,
  cold.threw ? cold.threw.message : `${cold.ms}ms · pages=${pages(cold.out)} · toc=${toc(cold.out)} · ${/aux:?\s+(\w+)/.exec(cold.out)?.[1] || 'no aux'}`)
record('目录被正确识别（跨文件 + 非空）', (toc(cold.out) ?? 0) > 20, `toc=${toc(cold.out)}`)

// --- 2. cache --------------------------------------------------------------
{
  const warm = await call({ page: 101 })
  record('缓存: 未改动时第二页几乎立即返回（<1.5s）',
    !warm.threw && /reused/.test(warm.out) && warm.ms < 1500 && pages(warm.out) === 208,
    `${cold.ms}ms → ${warm.ms}ms`)
}
{
  const sweep = []
  for (const p of [5, 50, 150, 208]) {
    const r = await call({ page: p })
    sweep.push({ p, ms: r.ms, ok: r.out.startsWith('OK') && /reused/.test(r.out) })
  }
  record('缓存: 连续翻 4 页全部命中', sweep.every((s) => s.ok),
    sweep.map((s) => `p${s.p}:${s.ms}ms`).join(' '))
}

// --- 3. locating on real content ------------------------------------------
{
  const r = await call({ text: '人类视觉系统是世界上众多奇迹之一' })
  const loc = /→ page (\d+)/.exec(r.out)
  record('定位: 中文文本锚点（真实正文句子）', !r.threw && !!loc,
    loc ? `page ${loc[1]}` : r.out.split('\n').slice(0, 3).join(' | '))
}
{
  const r = await call({ page: 100, pointX: 300, pointY: 400 })
  const loc = /→ page (\d+)/.exec(r.out)
  const src = /([\w.-]+\.tex):(\d+)/.exec(r.out)
  record('定位: 真实页面上点选坐标 → 源文件行号', !r.threw && !!src,
    src ? `${src[1]}:${src[2]} (page ${loc?.[1] ?? '?'})` : 'no source line')
}

// --- 4. page boundaries ----------------------------------------------------
{
  const bad = []
  for (const p of [0, 209, -1]) {
    const r = await call({ page: p })
    if (!/out of range/.test(r.out)) bad.push(p)
  }
  record('边界: 0 / 209 / -1 全部明确报越界', bad.length === 0, `failed: ${bad.join(',') || 'none'}`)
}

// --- 5. THE real task: remove the header rule and see where it changed -----
{
  const restore = withFile('main.tex', (s) =>
    s.replace('\\pagestyle{fancy}', '\\pagestyle{fancy}\n\\renewcommand{\\headrulewidth}{0pt}'))
  const after = await call({ page: 100, compare: 'previous' })
  restore()
  const m = /DIFF: ([\d.]+)% of the page changed/.exec(after.out)
  const bb = /bbox x=([\d.]+) y=([\d.]+) w=([\d.]+) h=([\d.]+)/.exec(after.out)
  const ratio = m ? Number(m[1]) : null
  record('真实改动: 去掉页眉横线后能测出差异',
    !after.threw && after.out.startsWith('OK') && ratio !== null && ratio > 0.0002,
    `changed=${ratio}% bbox=${bb ? `x=${bb[1]} y=${bb[2]} w=${bb[3]} h=${bb[4]}` : 'none'}`)
  record('真实改动: 变化区域落在页面顶部（页眉处）',
    !!bb && Number(bb[2]) < 120 && Number(bb[4]) < 30,
    bb ? `y=${bb[2]} height=${bb[4]}` : 'no bbox')
}
// the edit is reverted, so this rebuild proves the revert took effect
{
  const r = await call({ page: 100 })
  record('改动还原后重新编译成功', !r.threw && r.out.startsWith('OK') && pages(r.out) === 208,
    r.out.split('\n')[1] || '')
}

// --- 6. cache invalidation through a chapter file --------------------------
{
  const restore = withFile('chap1.tex', (s) => s + '\n\\section{测试追加一节}\n这是追加的测试内容。\n')
  const r = await call({ page: 1 })
  restore()
  record('缓存: 改子文件 chap1.tex 必须失效并重编译',
    !r.threw && !/reused/.test(r.out) && r.out.startsWith('OK'),
    `${r.ms}ms reused=${/reused/.test(r.out)}`)
}

// --- 7. error attribution across \input -----------------------------------
{
  const restore = withFile('chap3.tex', (s) => '\\undefinedcommandxyz\n' + s)
  const r = await call({ page: 10 })
  restore()
  const hit = /chap3\.tex:(\d+)/.exec(r.out)
  record('错误: 注入 chap3.tex 的未定义命令，报对文件与行号',
    !r.threw && r.out.startsWith('FAILED') && !!hit,
    hit ? `${hit[0]}` : r.out.split('\n').slice(0, 5).join(' | '))
  record('错误: 编译失败时不给 diff（避免把坏渲染当成改动结果）',
    !/DIFF:/.test(r.out) && /no before\/after diff|COMPARE:/.test(r.out),
    r.out.split('\n').slice(0, 2).join(' | '))
}

// --- 8. TOC guard on a real book ------------------------------------------
{
  const r = await call({ file: join(BOOK, ENTRY), maxPasses: 1, page: 1, fresh: true })
  record('参数: maxPasses=1 在真书上能被发现（目录会是旧的）',
    !r.threw && (/EMPTY/.test(r.out) || /at least 2 passes/.test(r.out)),
    r.out.split('\n').slice(0, 4).join(' | '))
}

// --- 9. wrong engine must fail loudly, not silently -----------------------
{
  const r = await call({ engine: 'pdflatex', page: 1, fresh: true })
  record('引擎: 用 pdflatex 编 xelatex 专用书 → 清晰失败',
    !r.threw && r.out.startsWith('FAILED') && r.out.length > 80,
    r.out.split('\n').slice(0, 3).join(' | '))
}

// --- summary ---------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.note || ''}`)
  process.exitCode = 1
}
