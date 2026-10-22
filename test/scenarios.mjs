/**
 * Scenario tests for the latex-look PLUGIN path.
 *
 * These deliberately go through `index.js` (apply → tool.execute) instead of
 * calling `lib/core.mjs` directly, so they exercise the real argument handling,
 * error paths and formatting the model sees. `@deepseek-ai/dsh-tools` is stubbed
 * in a throwaway copy of the plugin, because that package only exists inside the
 * Harness.
 *
 * Run: node test/scenarios.mjs
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const WORK = '/tmp/latex-look-plugin-test'
const S = '/tmp/latex-look-scenarios'

// --- fixtures --------------------------------------------------------------
// The suite creates its own documents so it runs on a clean checkout; nothing
// outside this file is required.
const FIXTURES = {
  'basic/basic.tex': String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
你好，世界。
\end{document}
`,
  'toc/toc.tex': String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
\tableofcontents
\section{第一章}\section{第二章}\section{第三章}
\end{document}
`,
  // root is a wrapper; both the TOC and the glossary are declared in included files
  'toc-in-input/root.tex': String.raw`\documentclass[UTF8]{ctexart}
\input{preamble}
\begin{document}
\input{body}
\end{document}
`,
  'toc-in-input/preamble.tex': String.raw`\usepackage{amsmath}
`,
  'toc-in-input/body.tex': String.raw`\tableofcontents
\section{甲}\section{乙}\section{丙}
`,
  'empty-toc/empty.tex': String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
\tableofcontents
\section*{不编号}
\end{document}
`,
  'glossary/gl.tex': String.raw`\documentclass[UTF8]{ctexart}
\usepackage{glossaries}
\makeglossaries
\newglossaryentry{nn}{name={神经网络},description={网络模型}}
\newglossaryentry{bp}{name={反向传播},description={梯度算法}}
\begin{document}
\section{引言}
用到 \gls{nn} 和 \gls{bp}。
\printglossaries
\end{document}
`,
  'glossary-input/root.tex': String.raw`\documentclass[UTF8]{ctexart}
\input{preamble}
\begin{document}
\section{引言}
用到 \gls{nn}。
\printglossaries
\end{document}
`,
  'glossary-input/preamble.tex': String.raw`\usepackage{glossaries}
\makeglossaries
\newglossaryentry{nn}{name={神经网络},description={网络模型}}
`,
  'err/err.tex': String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
前文
\thiscommanddoesnotexist{abc}
\end{document}
`,
  'overfull/of.tex': String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
\noindent\rule{1.35\textwidth}{3pt}

一段正常文字。
\end{document}
`,
  'table/table.tex': String.raw`\documentclass[UTF8]{ctexart}
\usepackage{booktabs}
\begin{document}
\begin{table}[h]
\centering
\caption{测试表格}
\begin{tabular}{lcc}
\toprule
项目 & 数量 & 比例 \\
\midrule
甲 & 12 & 0.30 \\
乙 & 34 & 0.55 \\
丙 & 6  & 0.15 \\
\bottomrule
\end{tabular}
\end{table}
\end{document}
`,
  'header/hdr.tex': String.raw`\documentclass[UTF8]{ctexart}
\usepackage{fancyhdr}
\pagestyle{fancy}
\fancyhf{}
\fancyhead[C]{页眉文字}
\fancyfoot[C]{\thepage}
\begin{document}
\section{测试}
正文内容。
\newpage
第二页内容。
\end{document}
`,
  'pages/pages.tex': String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
第一页\newpage 第二页\newpage 第三页\newpage 第四页\newpage 第五页
\end{document}
`,
  '中文 路径/zz.tex': String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
中文路径测试。
\end{document}
`,
  // parentheses and $ in a path: gs builds a PostScript string out of the path
  '论文(终稿)/p.tex': String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
带括号的路径。
\end{document}
`,
  "price $5's/p.tex": String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
带美元符号和单引号的路径。
\end{document}
`,
  // unbalanced parens: they terminate gs's PostScript string early, which used
  // to make the page count come back as '?' and silently disable the range check
  '终稿)/p.tex': String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
右括号不配对。
\end{document}
`,
  '(初稿/p.tex': String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
左括号不配对。
\end{document}
`,
  '100%/a.tex': String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
目录名里有百分号。
\end{document}
`,
}

rmSync(S, { recursive: true, force: true })
for (const [rel, body] of Object.entries(FIXTURES)) {
  const target = join(S, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
}

// --- build an isolated copy of the plugin with a stubbed dsh-tools ----------
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
cpSync(join(REPO, 'index.js'), join(WORK, 'index.js'))
cpSync(join(REPO, 'lib'), join(WORK, 'lib'), { recursive: true })
const SHIM = join(WORK, 'node_modules/@deepseek-ai/dsh-tools')
mkdirSync(SHIM, { recursive: true })
writeFileSync(join(SHIM, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module',
  exports: { '.': './index.js' },
}))
writeFileSync(join(SHIM, 'index.js'), 'export function defineTool(def) { return def }\n')

const mod = await import(pathToFileURL(join(WORK, 'index.js')).href)

// --- install the plugin into a fake context --------------------------------
const registered = { tools: {}, prompts: {} }
const ctx = {
  tools: { register: (t) => { registered.tools[t.name] = t } },
  systemPrompt: { section: (s) => { registered.prompts[s.name] = s } },
}
mod.apply(ctx)
const tool = registered.tools.latex_look

// --- helpers ---------------------------------------------------------------
const results = []
function record(name, ok, note) {
  results.push({ name, ok, note })
  const mark = ok ? '  ok ' : '  FAIL'
  console.log(`${mark} ${name}${note ? `\n         ${note}` : ''}`)
}

async function call(args) {
  try {
    return { out: await tool.execute(args), threw: null }
  } catch (e) {
    return { out: '', threw: e }
  }
}

/** A boundary case passes when it neither throws nor leaks a stack trace. */
function noCrash(name, r) {
  if (r.threw) return record(name, false, `threw: ${r.threw.message}`)
  if (/at \w+ \(.*:\d+:\d+\)/.test(r.out)) return record(name, false, 'raw stack trace in output')
  record(name, true)
}

// --- 0. plugin contract ----------------------------------------------------
record('plugin: 注册了 latex_look 工具', !!tool, tool ? '' : 'tool missing')
record('plugin: 注入了 system prompt 段', !!registered.prompts['tool:latex-look'])
record(
  'plugin: system prompt 要求先看再断言',
  /Never report a layout fix as done/.test(registered.prompts['tool:latex-look']?.text || ''),
)
record(
  'plugin: file 参数标记为必填',
  tool?.parameters?.file?.required === true,
)

// --- 1. realistic documents ------------------------------------------------
const CASES = [
  ['真实: 单页基础文档', { file: `${S}/basic/basic.tex`, page: 1 },
    (o) => o.startsWith('OK') && /pages: 1 /.test(o)],
  ['真实: 根文件里的目录', { file: `${S}/toc/toc.tex`, page: 1 },
    (o) => /toc: 3 entries/.test(o)],
  ['真实: 目录声明在 \\input 子文件', { file: `${S}/toc-in-input/root.tex`, page: 1 },
    (o) => /toc: 3 entries/.test(o)],
  ['真实: 空目录必须判失败', { file: `${S}/empty-toc/empty.tex`, page: 1 },
    (o) => o.startsWith('FAILED') && /EMPTY/.test(o)],
  ['真实: 术语表自动构建', { file: `${S}/glossary/gl.tex`, page: 1 },
    (o) => /aux: makeglossaries/.test(o)],
  ['真实: 术语表声明在子文件', { file: `${S}/glossary-input/root.tex`, page: 1 },
    (o) => /aux: makeglossaries/.test(o)],
  ['真实: 编译错误带定位', { file: `${S}/err/err.tex`, page: 1 },
    (o) => o.startsWith('FAILED') && /PROBLEMS/.test(o) && /err\.tex:4/.test(o)],
  ['真实: 溢出警告', { file: `${S}/overfull/of.tex`, page: 1 },
    (o) => /Overfull/.test(o)],
  ['真实: 按文本锚点定位表格', { file: `${S}/table/table.tex`, text: '测试表格' },
    (o) => /LOCATED IN SOURCE/.test(o) && /table\.tex:\d+/.test(o)],
  ['真实: 指定第 2 页', { file: `${S}/header/hdr.tex`, page: 2 },
    (o) => /pages: 2 /.test(o) && /showing page 2/.test(o)],
  ['真实: 指定第 3 页', { file: `${S}/pages/pages.tex`, page: 3 },
    (o) => /showing page 3/.test(o)],
  ['真实: 中文+空格的路径', { file: `${S}/中文 路径/zz.tex`, page: 1 },
    (o) => o.startsWith('OK')],
  ['真实: 路径含括号（gs 的 PS 字符串）', { file: `${S}/论文(终稿)/p.tex`, page: 1 },
    (o) => o.startsWith('OK')],
  ['真实: 路径含 $ 和单引号', { file: `${S}/price $5's/p.tex`, page: 1 },
    (o) => o.startsWith('OK')],
  ['真实: 路径含不成对右括号（页数必须正确）', { file: `${S}/终稿)/p.tex`, page: 1 },
    (o) => o.startsWith('OK') && /pages: 1 /.test(o)],
  ['真实: 路径含不成对左括号（页数必须正确）', { file: `${S}/(初稿/p.tex`, page: 1 },
    (o) => o.startsWith('OK') && /pages: 1 /.test(o)],
]

for (const [name, args, expect] of CASES) {
  const r = await call(args)
  if (r.threw) { record(name, false, `threw: ${r.threw.message}`); continue }
  record(name, !!expect(r.out), expect(r.out) ? '' : r.out.split('\n').slice(0, 3).join(' | '))
}

// --- 2. boundaries ---------------------------------------------------------
{
  const r = await call({ file: '/tmp/definitely-missing.tex' })
  record('边界: 不存在的文件', !r.threw && /file not found/.test(r.out),
    r.threw ? `threw: ${r.threw.message}` : '')
}
{
  const r = await call({ file: `${S}/pages/pages.tex`, page: 99 })
  record(
    '边界: 页码超出总页数 (99/5) 应给出范围错误',
    !r.threw && r.out.startsWith('FAILED') && /out of range/.test(r.out),
    r.threw ? `threw: ${r.threw.message}` : r.out.split('\n').slice(0, 2).join(' | '),
  )
}
{
  const r = await call({ file: `${S}/pages/pages.tex`, page: 0 })
  record(
    '边界: page=0 应给出范围错误',
    !r.threw && /out of range/.test(r.out),
    r.threw ? `threw: ${r.threw.message}` : r.out.split('\n').slice(0, 2).join(' | '),
  )
}
{
  const r = await call({ file: `${S}/pages/pages.tex`, page: -3 })
  record(
    '边界: page=-3 应给出范围错误',
    !r.threw && /out of range/.test(r.out),
    r.threw ? `threw: ${r.threw.message}` : r.out.split('\n').slice(0, 2).join(' | '),
  )
}
{
  const r = await call({ file: `${S}/pages/pages.tex`, page: 2.5 })
  noCrash('边界: page=2.5（小数）', r)
}
{
  const r = await call({ file: `${S}/pages/pages.tex`, page: '3' })
  noCrash('边界: page="3"（字符串）', r)
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, text: '这句话在文档里不存在' })
  record('边界: 文本找不到', !r.threw && !/LOCATED IN SOURCE/.test(r.out),
    r.threw ? `threw: ${r.threw.message}` : '')
}
{
  const r = await call({ file: `${S}/table/table.tex`, text: '(测试' })
  noCrash('边界: 文本含正则元字符 "(测试"', r)
}
{
  const r = await call({ file: `${S}/table/table.tex`, text: '\\caption' })
  noCrash('边界: 文本含反斜杠 "\\\\caption"', r)
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, compare: '/tmp/does-not-exist.pdf' })
  noCrash('边界: compare 指向不存在的文件', r)
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, compare: `${S}/images-do-not-exist.pdf` })
  noCrash('边界: compare 指向不存在的目录', r)
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, pointX: 100 })
  noCrash('边界: 只给 pointX 不给 pointY', r)
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, pointX: 999999, pointY: 999999 })
  noCrash('边界: 坐标远超页面', r)
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, pointX: -50, pointY: -50 })
  noCrash('边界: 坐标为负', r)
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, dpi: 1000 })
  noCrash('边界: dpi=1000 应被夹到 300', r)
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, dpi: 0 })
  noCrash('边界: dpi=0', r)
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, dpi: -10 })
  noCrash('边界: dpi=-10', r)
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, maxPasses: 0 })
  noCrash('边界: maxPasses=0', r)
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, engine: 'nonsense-engine' })
  noCrash('边界: engine 名字无效', r)
}

// --- 2b. the before/after diff, which is the whole point ------------------
{
  const dir = join(S, 'diff')
  const tex = join(dir, 'doc.tex')
  const withRule = String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
\noindent\rule{\textwidth}{4pt}

测试文字。
\end{document}
`
  const withoutRule = String.raw`\documentclass[UTF8]{ctexart}
\begin{document}

测试文字。
\end{document}
`
  mkdirSync(dir, { recursive: true })
  writeFileSync(tex, withRule)

  const first = await call({ file: tex, page: 1 })
  const beforePdf = join(dir, 'before.pdf')
  let copied = false
  try {
    copyFileSync(join(dir, 'doc.pdf'), beforePdf)
    copied = true
  } catch {}

  writeFileSync(tex, withoutRule)
  const r = await call({ file: tex, page: 1, compare: beforePdf })
  const m = /DIFF: ([\d.]+)% of the page changed/.exec(r.out)
  const bb = /bbox x=([\d.]+) y=([\d.]+) w=([\d.]+) h=([\d.]+)/.exec(r.out)
  const ratio = m ? Number(m[1]) : null
  record(
    'diff: 删掉页顶横线后能测出变化',
    !r.threw && copied && first.out.startsWith('OK') && ratio !== null && ratio > 0.01 && !!bb,
    r.threw ? r.threw.message : `changed=${ratio}% bbox=${bb ? bb[1] + ',' + bb[2] : 'none'}`,
  )
  record(
    'diff: 变化区域落在页面顶部（横线所在处）',
    !!bb && Number(bb[2]) < 200,
    bb ? `y=${bb[2]}` : 'no bbox',
  )
}

// --- 2c. the compared PDF usually has the same basename as the document ------
{
  const dir = join(S, 'collide')
  const oldDir = join(dir, 'old')
  mkdirSync(oldDir, { recursive: true })
  const tex = join(dir, 'two.tex')
  const withRule = String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
\noindent\rule{\textwidth}{6pt}

碰撞测试。
\end{document}
`
  const withoutRule = String.raw`\documentclass[UTF8]{ctexart}
\begin{document}

碰撞测试。
\end{document}
`
  writeFileSync(tex, withRule)
  await call({ file: tex, page: 1 })
  copyFileSync(join(dir, 'two.pdf'), join(oldDir, 'two.pdf')) // same basename on purpose
  writeFileSync(tex, withoutRule)

  const r = await call({ file: tex, page: 1, compare: join(oldDir, 'two.pdf') })
  const after = /image \(open it with an image reader\): (.+)/.exec(r.out)?.[1]
  const before = /image before the edit: (.+)/.exec(r.out)?.[1]
  let identical = true
  try {
    identical = readFileSync(after).equals(readFileSync(before))
  } catch {}
  record(
    'diff: compare 与文档同名的 PDF 不覆盖改后图',
    !!after && !!before && after !== before && !identical,
    `after=${after || 'none'} before=${before || 'none'} identical=${identical}`,
  )
}

// --- 2d. a failed compile must not pass off the old PDF as the new page -----
{
  const dir = join(S, 'stale')
  mkdirSync(dir, { recursive: true })
  const tex = join(dir, 'doc.tex')
  writeFileSync(tex, String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
正常的一页。
\end{document}
`)
  const good = await call({ file: tex, page: 1 })
  // a missing document class aborts before any shipout, so no new PDF is written
  // and doc.pdf stays exactly as the previous run left it
  writeFileSync(tex, String.raw`\documentclass[UTF8]{nosuchclass123}
\begin{document}
这一版编译不过。
\end{document}
`)
  const r = await call({ file: tex, page: 1 })
  record(
    '失败: 编译失败不拿旧 PDF 冒充当前页',
    !r.threw && good.out.startsWith('OK') && r.out.startsWith('FAILED') &&
      !/image \(open it/.test(r.out) && !/DIFF:/.test(r.out),
    r.threw ? r.threw.message : r.out.split('\n').slice(0, 4).join(' | '),
  )
}

// --- 2e. hardening regressions --------------------------------------------
{
  const r = await call({ file: `${S}/basic/basic.tex`, engine: 'sh' })
  record(
    '安全: engine 只接受白名单（sh 必须被拒绝）',
    !r.threw && /unknown engine/.test(r.out),
    r.threw ? r.threw.message : r.out.slice(0, 90),
  )
}
{
  const r = await call({ file: `${S}/pages/pages.tex`, page: 2.5 })
  record(
    '边界: page=2.5 应说明必须是整数',
    !r.threw && /whole number/.test(r.out),
    r.threw ? r.threw.message : r.out.split('\n')[0],
  )
}
{
  const r = await call({ file: `${S}/table/table.tex`, text: '   ' })
  record('边界: 纯空白 text 不产生假定位', !r.threw && !/LOCATED IN SOURCE/.test(r.out),
    r.threw ? r.threw.message : '')
}
{
  const r = await call({ file: `${S}/table/table.tex`, pointX: 100, pointY: 300 })
  record(
    '边界: point 模式定位必须带页号',
    !r.threw && /LOCATED IN SOURCE/.test(r.out) && /→ page \d+/.test(r.out) && !/page undefined/.test(r.out),
    r.threw ? r.threw.message : /LOCATED IN SOURCE/.test(r.out) ? 'located' : 'not located',
  )
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, pointX: 100 })
  record('边界: 只给 pointX 应提示两个都要给', !r.threw && /pointX and pointY/.test(r.out),
    r.threw ? r.threw.message : r.out.slice(0, 80))
}
{
  const r = await call({ file: `${S}/basic/basic.tex`, compare: '/tmp/nope-does-not-exist.pdf' })
  record('边界: compare 读不到要明说', !r.threw && /COMPARE:/.test(r.out),
    r.threw ? r.threw.message : r.out.split('\n').slice(-2).join(' | '))
}
{
  // a % in the path is the ghostscript -sOutputFile template hazard; the file NAME
  // cannot contain one because the TeX engine itself refuses it
  const r = await call({ file: `${S}/100%/a.tex`, page: 1 })
  record('边界: 路径含 % 仍能正确渲染', !r.threw && r.out.startsWith('OK') && /pages: 1 /.test(r.out),
    r.threw ? r.threw.message : r.out.split('\n').slice(0, 2).join(' | '))
}
{
  // the compare PDF is the document's OWN pdf — the case the system prompt invites
  const dir = join(S, 'selfcmp')
  mkdirSync(dir, { recursive: true })
  const tex = join(dir, 'self.tex')
  writeFileSync(tex, String.raw`\documentclass[UTF8]{ctexart}
\begin{document}
\noindent\rule{\textwidth}{5pt}

自比较。
\end{document}
`)
  await call({ file: tex, page: 1 })
  writeFileSync(tex, String.raw`\documentclass[UTF8]{ctexart}
\begin{document}

自比较。
\end{document}
`)
  const r = await call({ file: tex, page: 1, compare: join(dir, 'self.pdf') })
  const m = /DIFF: ([\d.]+)% of the page changed/.exec(r.out)
  const ratio = m ? Number(m[1]) : null
  record('diff: compare 指向文档自己的 PDF 仍给出真实差异', !r.threw && ratio !== null && ratio > 0.01,
    r.threw ? r.threw.message : `changed=${ratio}%`)
}

// --- 3. concurrency --------------------------------------------------------
{
  const [a, b] = await Promise.all([
    call({ file: `${S}/basic/basic.tex`, page: 1 }),
    call({ file: `${S}/toc/toc.tex`, page: 1 }),
  ])
  record(
    '并发: 两个文档同时渲染互不干扰',
    !a.threw && !b.threw && a.out.startsWith('OK') && b.out.startsWith('OK'),
    a.threw?.message || b.threw?.message || '',
  )
}

// --- summary ---------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name}${f.note ? `: ${f.note}` : ''}`)
  process.exitCode = 1
}
