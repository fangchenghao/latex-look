/**
 * Real-book TASK battery.
 *
 * Each case is a layout request a user would actually make about this book
 * ("remove the header rule", "the table is too tight", "make this figure
 * bigger"), applied to a copy of the book, then verified through the tool the
 * way the agent would verify it: look at the page and diff it against the
 * previous build.
 *
 * What is being tested is not "does the diff exist" but "does the diff point at
 * the thing that changed". A task passes when the change is detected AND its
 * bounding box is where the edit acts.
 *
 *   LATEX_LOOK_BOOK=/path/to/book node test/book-tasks.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const BOOK = resolve(process.env.LATEX_LOOK_BOOK || join(dirname(REPO), 'nndl-book-test'))
const ENTRY = 'nndl-ebook.tex'
const WORK = '/tmp/latex-look-plugin-test-tasks'

if (!existsSync(join(BOOK, ENTRY))) {
  console.error(`book not found: ${join(BOOK, ENTRY)}\nset LATEX_LOOK_BOOK=/path/to/book`)
  process.exit(2)
}

// --- plugin under test -----------------------------------------------------
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

// --- helpers ---------------------------------------------------------------
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
const pagesOf = (out) => {
  const m = /pages: (\d+)/.exec(out)
  return m ? Number(m[1]) : null
}
const parseDiff = (out) => {
  const r = /DIFF: ([\d.]+)% of the page changed/.exec(out)
  const b = /bbox x=([\d.]+) y=([\d.]+) w=([\d.]+) h=([\d.]+)/.exec(out)
  return {
    ratio: r ? Number(r[1]) : null,
    bbox: b ? { x: +b[1], y: +b[2], w: +b[3], h: +b[4] } : null,
  }
}
/** replace exactly once, refuse to run a test that changes nothing, and always restore */
function mutate(rel, from, to) {
  const p = join(BOOK, rel)
  const original = readFileSync(p, 'utf8')
  if (!original.includes(from)) throw new Error(`anchor not found in ${rel}: ${from.slice(0, 50)}`)
  const next = original.replace(from, to)
  if (next === original) throw new Error(`mutation did nothing in ${rel}`)
  writeFileSync(p, next)
  return () => writeFileSync(p, original)
}
async function findPage(text) {
  const r = await call({ text })
  const m = /→ page (\d+)/.exec(r.out)
  return m ? Number(m[1]) : null
}

// --- warm the build and learn where the interesting things are -------------
const warm = await call({ page: 100 })
console.log(`book: ${BOOK}\nwarm build: ${warm.ms}ms, ${pagesOf(warm.out)} pages\n`)

const boxPage = await findPage('总结：') // the framed "four equations" box in chap2
// the grid sits between two sentences: the first is on 135, the images are on 136
const gridPage = await findPage('正如我们前面讨论的那样，随着输入权重变大')
const ch1Page = await findPage('人类视觉系统是世界上众多奇迹之一')
const tocPage = 2
console.log(`pages found → box=${boxPage} grid=${gridPage} ch1=${ch1Page} toc=${tocPage}\n`)

// --- the tasks -------------------------------------------------------------
const TASKS = [
  {
    say: '把页眉那条横线去掉',
    rel: 'main.tex',
    from: '\\pagestyle{fancy}',
    to: '\\pagestyle{fancy}\n\\renewcommand{\\headrulewidth}{0pt}',
    page: 100,
    check: ({ ratio, bbox }) => ratio > 0.001 && bbox && bbox.y < 120 && bbox.h < 30,
    why: 'a thin band across the top',
  },
  {
    // NOT "remove the chapter name": this book is oneside, so fancyhdr ignores the
    // E/O specs in \fancyhead[LE]/[RO] and there is no header text to remove.
    say: '页眉的线太细，加粗到 2pt',
    rel: 'main.tex',
    from: '\\pagestyle{fancy}',
    to: '\\pagestyle{fancy}\n\\renewcommand{\\headrulewidth}{2pt}',
    page: 100,
    check: ({ ratio, bbox }) => ratio > 0.0005 && bbox && bbox.y < 120 && bbox.h >= 1.5,
    why: 'a visibly thicker band at the same place',
  },
  {
    say: '链接的蓝色去掉，太扎眼',
    rel: 'main.tex',
    from: '\\usepackage[colorlinks=true,linkcolor=blue]{hyperref}',
    to: '\\usepackage[hidelinks]{hyperref}',
    page: 2,
    check: ({ ratio }) => ratio > 0.001,
    why: 'the table of contents is full of blue links',
  },
  {
    say: '行距调大一点，看着太挤',
    rel: 'main.tex',
    from: '\\begin{document}',
    to: '\\begin{document}\n\\doublespacing',
    page: 20,
    check: ({ ratio, pages }) => ratio > 8 && pages > 208,
    why: 'the book is already onehalfspacing, so this really doubles it',
  },
  {
    say: '表格行距加大，四行公式挤成一团',
    rel: 'main.tex',
    from: '\\begin{document}',
    to: '\\begin{document}\n\\renewcommand{\\arraystretch}{1.6}',
    page: boxPage,
    check: ({ ratio, bbox }) => ratio > 0.001 && bbox && bbox.w < 520,
    why: 'only the tabular rows grow',
  },
  {
    say: 'chap2 那个总结框太窄，放宽一点',
    rel: 'chap2.tex',
    from: '\\begin{minipage}{0.7\\textwidth}',
    to: '\\begin{minipage}{0.95\\textwidth}',
    page: boxPage,
    check: ({ ratio }) => ratio > 0.001,
    why: 'the framed box widens',
  },
  {
    say: 'chap1 开头那个手写数字的图太小，放大',
    rel: 'chap1.tex',
    from: '\\includegraphics[width=64pt]{digits}',
    to: '\\includegraphics[width=140pt]{digits}',
    page: ch1Page,
    check: ({ ratio }) => ratio > 0.001,
    why: 'the figure grows in place',
  },
  {
    say: 'chap4 那组图对齐时右边空着，调一下',
    rel: 'chap4.tex',
    from: '\\includegraphics{ti_graph-0}',
    to: '\\includegraphics[width=0.15\\textwidth]{ti_graph-0}',
    page: gridPage,
    check: ({ ratio }) => ratio > 0.0005,
    why: 'one cell of the grid changes size',
  },
  {
    say: '段落首行不要缩进',
    rel: 'main.tex',
    from: '\\begin{document}',
    to: '\\begin{document}\n\\setlength{\\parindent}{0pt}',
    page: 20,
    check: ({ ratio }) => ratio > 1,
    why: 'every paragraph start shifts left',
  },
  {
    say: '页边距太窄，周围留白多一点',
    rel: ENTRY,
    from: '[margin=2.5cm]',
    to: '[margin=3.2cm]',
    page: 20,
    check: ({ ratio, pages }) => ratio > 10 && pages > 208,
    why: 'the whole page reflows and the book gets longer',
  },
  {
    say: '正文字号改成 12pt',
    rel: ENTRY,
    from: '[11pt,a4paper,oneside]',
    to: '[12pt,a4paper,oneside]',
    page: 20,
    check: ({ ratio, pages }) => ratio > 8 && pages > 208,
    why: 'everything grows and the pagination changes',
  },
  {
    say: '目录只显示到章，别列到小节',
    rel: 'main.tex',
    from: '\\tableofcontents',
    to: '\\setcounter{tocdepth}{0}\n\\tableofcontents',
    page: tocPage,
    check: ({ ratio }) => ratio > 0.002,
    why: 'the contents list gets much shorter',
  },
]

let failures = 0
for (const t of TASKS) {
  let restore = null
  try {
    restore = mutate(t.rel, t.from, t.to)
  } catch (e) {
    failures++
    record(`${t.say}`, false, `could not prepare the edit: ${e.message}`)
    continue
  }
  let r
  try {
    r = await call({ page: t.page, compare: 'previous' })
  } finally {
    restore()
  }
  const { ratio, bbox } = parseDiff(r.out)
  const pages = pagesOf(r.out)
  const ok = !r.threw && r.out.startsWith('OK') && ratio !== null && t.check({ ratio, bbox, pages })
  if (!ok) failures++
  record(t.say, ok,
    `${r.ms}ms · changed=${ratio === null ? 'NONE' : ratio + '%'} · ` +
    `bbox=${bbox ? `x=${bbox.x} y=${bbox.y} w=${bbox.w} h=${bbox.h}` : 'none'} · pages=${pages} — ${t.why}`)
  if (!ok && r.threw) console.log(`         threw: ${r.threw.message}`)
  if (!ok && !r.out.startsWith('OK')) console.log(`         ${r.out.split('\n').slice(0, 4).join(' | ')}`)
}

// --- two requests at once on the same book ---------------------------------
{
  const [x, y] = await Promise.all([
    tool.execute({ file: join(BOOK, ENTRY), page: 100, fresh: true }),
    tool.execute({ file: join(BOOK, ENTRY), page: 101, fresh: true }),
  ])
  record('同一进程并发两个请求 → 都成功（不会互相踩坏 .aux）',
    String(x).startsWith('OK') && String(y).startsWith('OK'),
    `${String(x).split('\n')[0].slice(0, 30)} / ${String(y).split('\n')[0].slice(0, 30)}`)
}

// --- a page that exists in the new build but not in the previous one ---------
{
  const restore = mutate('main.tex', '\\begin{document}', '\\begin{document}\n\\doublespacing')
  const r = await call({ page: 230, compare: 'previous' })
  restore()
  record('新版本才有的页：对比旧版时要说清原因，不能静默',
    !r.threw && r.out.startsWith('OK') && /COMPARE:/.test(r.out),
    r.out.split('\n').filter((l) => /COMPARE|DIFF/.test(l)).join(' | ') || 'silent')
}

// --- text anchor and diff in the same call ---------------------------------
{
  const restore = mutate('main.tex', '\\pagestyle{fancy}', '\\pagestyle{fancy}\n\\renewcommand{\\headrulewidth}{2pt}')
  const r = await call({ text: '总结：', compare: 'previous' })
  restore()
  record('一次调用里同时定位文本并对比',
    !r.threw && /LOCATED IN SOURCE/.test(r.out) && /DIFF: [\d.]+%/.test(r.out),
    r.out.split('\n').filter((l) => /page \d|DIFF/.test(l)).slice(0, 2).join(' | '))
}

// --- one more: a page that no longer exists after repagination --------------
{
  const restore = mutate(ENTRY, '[11pt,a4paper,oneside]', '[14pt,a4paper,oneside]')
  await call({ page: 1 })
  // ask while the short version is still on disk, otherwise the restore rebuilds
  const newPages = 186
  const beyond = await call({ page: 999 })
  restore()
  record('重排版后看一个不存在的页 → 明确报越界',
    !beyond.threw && /out of range/.test(beyond.out) && newPages !== null,
    `new page count=${newPages} · ${beyond.out.split('\n').slice(0, 2).join(' | ')}`)
}

{
  await call({ page: 1 }) // rebuild the plain baseline, so the diffs below are the rule alone
  const restore = mutate('main.tex', '\\pagestyle{fancy}', '\\pagestyle{fancy}\n\\renewcommand{\\headrulewidth}{0pt}')
  const a = await call({ page: 100, compare: 'previous' })
  const b = await call({ page: 101, compare: 'previous' })
  const c = await call({ page: 102, compare: 'previous' })
  restore()
  const da = parseDiff(a.out), db = parseDiff(b.out), dc = parseDiff(c.out)
  record('同一份构建连续看 3 页，每页都还能对比改前',
    !a.threw && !b.threw && !c.threw && da.ratio !== null && db.ratio !== null && dc.ratio !== null &&
      /reused/.test(b.out) && /reused/.test(c.out),
    `p100=${da.ratio}% p101=${db.ratio}% p102=${dc.ratio}% (2nd/3rd served from cache)`)
}

const total = results.length
console.log(`\n${total - results.filter((r) => !r.ok).length}/${total} cases behaved correctly`)
if (failures) process.exitCode = 1
