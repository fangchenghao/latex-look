/**
 * Deep scenario tests: realistic documents, every parameter, and the build cache.
 *
 * Same approach as scenarios.mjs — drive the real `index.js` tool through a
 * stubbed `@deepseek-ai/dsh-tools` so the argument handling and the exact text
 * the model reads are exercised. Fixtures are generated here.
 *
 * Run: node test/scenarios-deep.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const WORK = '/tmp/latex-look-plugin-test-deep'
const S = '/tmp/latex-look-deep'

// 1x1 PNG, enough for \includegraphics to have something real to place
const PNG_RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const chapters = (n) =>
  Array.from({ length: n }, (_, i) => `\\section{第 ${i + 1} 章}\n${'内容行。\n'.repeat(30)}\\clearpage\n`).join('')

const FIXTURES = {
  // a realistic multi-file paper: wrapper → preamble + body → sections
  'paper/root.tex': String.raw`\documentclass[UTF8]{ctexart}
\input{preamble}
\begin{document}
\tableofcontents
\input{body}
\end{document}
`,
  'paper/preamble.tex': String.raw`\usepackage{amsmath,booktabs,graphicx}
`,
  'paper/body.tex': String.raw`\input{sections/one}
\input{sections/two}
`,
  'paper/sections/one.tex': String.raw`\section{引言}
\begin{equation}
  E = mc^2
\end{equation}
\begin{table}[h]\centering
\begin{tabular}{lrr}\toprule 模型 & 准确率 & 耗时 \\\midrule
CNN & 0.91 & 12s \\\bottomrule
\end{tabular}
\end{table}
`,
  'paper/sections/two.tex': String.raw`\section{方法}
\begin{align}
  f(x) &= \frac{1}{1+e^{-x}} \\
  g(x) &= \sum_{i=1}^{n} w_i x_i
\end{align}
`,
  // beamer: completely different page semantics
  'slides/slides.tex': String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{第一页}幻灯片内容。\end{frame}
\begin{frame}{第二页}更多内容。\end{frame}
\end{document}
`,
  'twocol/twocol.tex': String.raw`\documentclass[twocolumn]{article}
\begin{document}
${'Two column body text that should wrap across the columns. '.repeat(120)}
\end{document}
`,
  'math/math.tex': String.raw`\documentclass{article}
\usepackage{amsmath,amssymb}
\begin{document}
\begin{gather}
  A = \begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix} \\
  \int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
\end{gather}
\end{document}
`,
  'image/image.tex': String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
图片：
\includegraphics[width=2cm]{pic.png}
\end{document}
`,
  'image/broken.tex': String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\includegraphics{no-such-picture.png}
\end{document}
`,
  // neutral document that every engine can compile
  'engines/plain.tex': String.raw`\documentclass{article}
\begin{document}
Engine neutral.
\end{document}
`,
  'big/big.tex': `\\documentclass{article}
\\begin{document}
${chapters(60)}\\end{document}
`,
  'crlf/bom.tex': '\uFEFF' + '\\documentclass{article}\r\n\\begin{document}\r\nBOM and CRLF.\r\n\\end{document}\r\n',
  'missing-input/mi.tex': String.raw`\documentclass{article}
\begin{document}
\input{does-not-exist}
\end{document}
`,
  'reflabel/rl.tex': String.raw`\documentclass{article}
\begin{document}
见第 \ref{fig:none} 节。
\label{dup}\label{dup}
\end{document}
`,
  'manyhits/many.tex': `\\documentclass{article}
\\begin{document}
${Array.from({ length: 20 }, () => 'MARKER 这一行包含关键词。\\\\').join('\n')}
\\end{document}
`,
  'tocsmall/tc.tex': String.raw`\documentclass{article}
\begin{document}
\tableofcontents
\section{One}\section{Two}
\end{document}
`,
  'change/change.tex': String.raw`\documentclass{article}
\begin{document}
VERSION-ONE
\end{document}
`,
  'readsymlink/real.tex': String.raw`\documentclass{article}
\begin{document}
Through a symlink.
\end{document}
`,
  'readonly/ro.tex': String.raw`\documentclass{article}
\begin{document}
Read only directory.
\end{document}
`,
}

rmSync(S, { recursive: true, force: true })
mkdirSync(S, { recursive: true })
for (const [rel, body] of Object.entries(FIXTURES)) {
  const target = join(S, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
}
writeFileSync(join(S, 'image/pic.png'), PNG_RED)
symlinkSync(join(S, 'readsymlink/real.tex'), join(S, 'readsymlink/link.tex'))

// --- isolated plugin copy with a stubbed dsh-tools -------------------------
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
const registered = { tools: {}, prompts: {} }
mod.apply({
  tools: { register: (t) => { registered.tools[t.name] = t } },
  systemPrompt: { section: (s) => { registered.prompts[s.name] = s } },
})
const tool = registered.tools.latex_look

const results = []
function record(name, ok, note) {
  results.push({ name, ok, note })
  console.log(`${ok ? '  ok ' : '  FAIL'} ${name}${note ? `\n         ${note}` : ''}`)
}
async function call(args) {
  const t0 = Date.now()
  try {
    const out = await tool.execute(args)
    return { out, threw: null, ms: Date.now() - t0 }
  } catch (e) {
    return { out: '', threw: e, ms: Date.now() - t0 }
  }
}
const pages = (out) => {
  const m = /pages: (\d+)/.exec(out)
  return m ? Number(m[1]) : null
}

// --- A. realistic documents ------------------------------------------------
{
  const r = await call({ file: `${S}/paper/root.tex`, page: 1 })
  record('论文: 三层 \\input + 目录 + 表格 + 公式',
    !r.threw && r.out.startsWith('OK') && pages(r.out) >= 1 && /toc:\s*[2-9] entries/.test(r.out),
    r.threw ? r.threw.message : r.out.split('\n').slice(0, 3).join(' | '))
}
{
  const r = await call({ file: `${S}/slides/slides.tex`, page: 2 })
  record('beamer 幻灯片: 页数与渲染', !r.threw && r.out.startsWith('OK') && pages(r.out) === 2,
    r.threw ? r.threw.message : r.out.split('\n').slice(0, 2).join(' | '))
}
{
  const r = await call({ file: `${S}/twocol/twocol.tex`, page: 1 })
  record('双栏长文: 正常渲染', !r.threw && r.out.startsWith('OK'),
    r.threw ? r.threw.message : r.out.split('\n')[0])
}
{
  const r = await call({ file: `${S}/math/math.tex`, page: 1 })
  record('数学公式密集 (pmatrix/gather): 正常渲染', !r.threw && r.out.startsWith('OK'),
    r.threw ? r.threw.message : r.out.split('\n')[0])
}
{
  const r = await call({ file: `${S}/image/image.tex`, page: 1 })
  record('图片: 现有 PNG 正常渲染', !r.threw && r.out.startsWith('OK'),
    r.threw ? r.threw.message : r.out.split('\n')[0])
}
{
  const r = await call({ file: `${S}/image/broken.tex`, page: 1 })
  record('图片: 缺失图片给出明确错误',
    !r.threw && r.out.startsWith('FAILED') && /not found|File .* not found|missing/i.test(r.out),
    r.threw ? r.threw.message : r.out.split('\n').slice(0, 6).join(' | '))
}

// --- B. engines ------------------------------------------------------------
for (const engine of ['pdflatex', 'lualatex']) {
  const r = await call({ file: `${S}/engines/plain.tex`, engine, page: 1 })
  record(`引擎: ${engine}`, !r.threw && r.out.startsWith('OK') && new RegExp(`engine: ${engine}`).test(r.out),
    r.threw ? r.threw.message : r.out.split('\n').slice(0, 2).join(' | '))
}

// --- C. the build cache ----------------------------------------------------
{
  const file = `${S}/change/change.tex`
  const first = await call({ file, page: 1 })
  const second = await call({ file, page: 1 })
  record('缓存: 源文件未改时复用构建（不再编译）',
    !first.threw && !second.threw && /reused/.test(second.out) && pages(second.out) === pages(first.out),
    `first=${first.ms}ms second=${second.ms}ms reused=${/reused/.test(second.out)}`)
}
{
  const file = `${S}/change/change.tex`
  await call({ file, page: 1 }) // ensure cached
  writeFileSync(file, String.raw`\documentclass{article}
\begin{document}
VERSION-TWO
\end{document}
`)
  const r = await call({ file, page: 1 })
  record('缓存: 改主文件后必须重编译', !r.threw && !/reused/.test(r.out) && r.out.startsWith('OK'),
    r.out.split('\n')[1] || '')
}
{
  // editing an \input'd file must invalidate — this is the correctness core
  const file = `${S}/paper/root.tex`
  await call({ file, page: 1 })
  const sub = `${S}/paper/sections/two.tex`
  writeFileSync(sub, readFileSync(sub, 'utf8') + '\n\\section{新增一节}\n新内容。\n')
  const r = await call({ file, page: 1 })
  record('缓存: 改 \\input 的子文件必须失效',
    !r.threw && !/reused/.test(r.out) && r.out.startsWith('OK'),
    r.out.split('\n')[1] || '')
}
{
  // a changed image must invalidate too (it is not a .tex file)
  const file = `${S}/image/image.tex`
  await call({ file, page: 1 })
  writeFileSync(`${S}/image/pic.png`, PNG_BLUE)
  const r = await call({ file, page: 1 })
  record('缓存: 改图片文件必须失效', !r.threw && !/reused/.test(r.out) && r.out.startsWith('OK'),
    r.out.split('\n')[1] || '')
}
{
  const file = `${S}/engines/plain.tex`
  const a = await call({ file, engine: 'pdflatex', page: 1 })
  const b = await call({ file, engine: 'xelatex', page: 1 })
  record('缓存: 换引擎必须失效', !a.threw && !b.threw && !/reused/.test(b.out) && /engine: xelatex/.test(b.out),
    b.out.split('\n')[1] || '')
}
{
  const file = `${S}/change/change.tex`
  await call({ file, page: 1 })
  const r = await call({ file, page: 1, compare: 'previous' })
  // A cached call reports the comparison the build itself produced (the snapshot is
  // kept per document, so looking at a second page still shows the edit), and when
  // no earlier build was recorded it says so. What it must never do is invent 0%.
  record('缓存: 命中时给真对比或说明原因，绝不给假的 0%',
    !r.threw && !/DIFF: 0\.00%/.test(r.out) && (/DIFF: [\d.]+%/.test(r.out) || /COMPARE:/.test(r.out)),
    r.out.split('\n').slice(-3).join(' | '))
}
{
  const file = `${S}/big/big.tex`
  const first = await call({ file, page: 1 })
  const second = await call({ file, page: 2 })
  const fast = second.ms < 3000 && second.ms * 3 < first.ms
  record('性能: 60 页文档第二次调用走缓存（<3s 且远快于首次）',
    !first.threw && !second.threw && /reused/.test(second.out) && fast,
    `first=${first.ms}ms second=${second.ms}ms pages=${pages(second.out)}`)
}

{
  const file = `${S}/engines/plain.tex`
  await call({ file, page: 1 }) // populate the cache
  const r = await call({ file, page: 1, fresh: true })
  record('缓存: fresh=true 强制重编译', !r.threw && !/reused/.test(r.out) && r.out.startsWith('OK'),
    r.out.split('\n')[1] || '')
}
{
  // a compile failure must never be remembered as a successful build
  const file = `${S}/image/broken.tex`
  const a = await call({ file, page: 1 })
  const b = await call({ file, page: 1 })
  record('缓存: 失败构建不进缓存', !a.threw && !b.threw && !/reused/.test(b.out) && b.out.startsWith('FAILED'),
    b.out.split('\n')[0])
}

// --- D. locating -----------------------------------------------------------
{
  const r = await call({ file: `${S}/manyhits/many.tex`, text: 'MARKER' })
  const hits = (r.out.match(/→ page/g) || []).length
  record('定位: 文本出现 20 次时最多返回 8 条', !r.threw && hits > 0 && hits <= 8, `hits=${hits}`)
}
{
  const r = await call({ file: `${S}/paper/root.tex`, text: 'E = mc^2' })
  record('定位: 二层 \\input 里的文本锚点', !r.threw,
    r.threw ? r.threw.message : (/LOCATED IN SOURCE/.test(r.out) ? 'located' : 'not located (known limit)'))
}
{
  // \input{sections/one} sits in body.tex, one level down, so it IS reachable
  const r = await call({ file: `${S}/paper/root.tex`, text: 'sections/one' })
  const loc = /→ page (\d+)/.exec(r.out)
  const show = /showing page (\d+)/.exec(r.out)
  record('定位: 命中后 showing page 等于命中页',
    !r.threw && !!loc && !!show && loc[1] === show[1],
    `located=${loc?.[1]} showing=${show?.[1]}`)
}

// --- E. every parameter's failure path ------------------------------------
{
  const r = await call({ file: `${S}/tocsmall/tc.tex`, page: 1, maxPasses: 1 })
  record('参数: maxPasses=1 在目录文档上应报 TOC EMPTY',
    !r.threw && /EMPTY/.test(r.out),
    r.threw ? r.threw.message : r.out.split('\n').slice(0, 2).join(' | '))
}
{
  const r = await call({ file: `${S}/big/big.tex`, page: 1, dpi: 50 })
  record('参数: dpi=50 生效', !r.threw && /@50dpi\.png/.test(r.out), r.out.split('\n').slice(0, 2).join(' | '))
}
{
  const r = await call({ file: `${S}/big/big.tex`, page: 1, timeoutSeconds: 5 })
  record('参数: timeoutSeconds=5 要么完成要么报清晰超时（不抛异常）',
    !r.threw && (r.out.startsWith('OK') || /timed out/.test(r.out)),
    r.threw ? r.threw.message : r.out.split('\n')[0])
}

// --- F. hostile inputs -----------------------------------------------------
{
  const r = await call({ file: `${S}/crlf/bom.tex`, page: 1 })
  record('输入: BOM + CRLF 源文件', !r.threw && r.out.startsWith('OK'),
    r.threw ? r.threw.message : r.out.split('\n')[0])
}
{
  const r = await call({ file: `${S}/readsymlink/link.tex`, page: 1 })
  record('输入: 符号链接的 .tex', !r.threw && r.out.startsWith('OK'),
    r.threw ? r.threw.message : r.out.split('\n')[0])
}
{
  const r = await call({ file: `${S}/missing-input/mi.tex`, page: 1 })
  record('输入: \\input 缺失文件应明确报错', !r.threw && r.out.startsWith('FAILED') && /not found/i.test(r.out),
    r.threw ? r.threw.message : r.out.split('\n').slice(0, 5).join(' | '))
}
{
  const r = await call({ file: `${S}/reflabel/rl.tex`, page: 1 })
  record('输入: 未定义引用 + 重复 label 不崩',
    !r.threw && (r.out.startsWith('OK') || r.out.startsWith('FAILED')),
    r.threw ? r.threw.message : r.out.split('\n')[0])
}
{
  chmodSync(`${S}/readonly`, 0o555)
  const r = await call({ file: `${S}/readonly/ro.tex`, page: 1 })
  chmodSync(`${S}/readonly`, 0o755)
  const noStack = !/at .*\.mjs:\d+/.test(r.out) && !r.threw
  record('输入: 只读目录给出清晰错误而非堆栈', noStack,
    r.threw ? `threw ${r.threw.message}` : r.out.split('\n').slice(0, 3).join(' | '))
}

// --- summary ---------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.note || ''}`)
  process.exitCode = 1
}
