import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { ENGINES, look } from './lib/core.mjs'

export const name = 'dsh-latex-look'

// `tools` to register latex_look; `systemPrompt` so the "look before you claim
// it is done" discipline is unconditional rather than dependent on the skill
// being loaded in time.
export const inject = ['tools', 'systemPrompt']

const SYSTEM_PROMPT = [
  'A LaTeX document that compiles can still look wrong, and blind editing will not reveal it.',
  'When the user describes a page visually — a table style, a rule to remove, spacing, a line running into the margin, a figure that is too large, page headers and footers —',
  'or before claiming any layout change is finished, call the `latex_look` tool:',
  'it compiles the document, renders the requested page to a PNG you can open with an image reader, and maps a PDF point or a text anchor back to the exact source line.',
  'Work in the loop look → diagnose → edit → look again, passing the previous PDF as `compare` so the diff shows precisely what your edit changed.',
  'Never report a layout fix as done without having looked at the rendered page afterwards.',
].join(' ')

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function format(r) {
  const L = []
  L.push(`${r.ok ? 'OK' : 'FAILED'} — ${r.file}`)
  L.push(`engine: ${r.engine} | ${r.cached ? 'reused (nothing changed since the last build)' : `passes: ${r.passes}`} | pages: ${r.pages ?? '?'} | showing page ${r.page}`)
  if (r.toc?.expected) L.push(`toc: ${r.toc.entries ?? 0} entries`)
  if (r.aux?.length) {
    L.push(`aux: ${r.aux.map((a) => `${a.tool}${a.ok ? '' : ' FAILED'}`).join(', ')}`)
  }
  if (r.images?.after) L.push(`image (open it with an image reader): ${r.images.after}`)
  if (r.images?.before) L.push(`image before the edit: ${r.images.before}`)
  if (r.fatal) L.push(`FATAL: ${r.fatal}`)
  if (r.compareError) L.push(`COMPARE: ${r.compareError}`)
  if (r.problems?.length) {
    L.push('')
    L.push(`PROBLEMS (${r.problems.length}):`)
    for (const p of r.problems.slice(0, 15)) {
      const where = p.file ? `${p.file}${p.line ? `:${p.line}` : ''}: ` : p.line ? `line ${p.line}: ` : ''
      L.push(`  ${where}${p.message}`)
    }
  }
  if (r.warnings?.length) {
    L.push('')
    L.push(`WARNINGS (${r.warnings.length}${r.warnings.length > 10 ? ', first 10' : ''}):`)
    for (const w of r.warnings.slice(0, 10)) L.push(`  ${w.message}`)
  }
  if (r.located?.length) {
    L.push('')
    L.push('LOCATED IN SOURCE:')
    for (const h of r.located.slice(0, 8)) {
      const y = typeof h.y === 'number' ? ` y=${h.y.toFixed(1)}` : ''
      L.push(`  ${h.file}:${h.line} → page ${h.page}${y}`)
    }
  }
  if (r.diff) {
    const pct = (r.diff.changedRatio * 100).toFixed(2)
    const b = r.diff.bbox
    L.push('')
    L.push(
      `DIFF: ${pct}% of the page changed` +
        (b ? ` | bbox x=${b.x} y=${b.y} w=${b.width} h=${b.height} (PDF points, origin top-left)` : ''),
    )
  }
  return L.join('\n')
}

export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'tool:latex-look', order: 1100, text: SYSTEM_PROMPT })

  ctx.tools.register(
    defineTool({
      name: 'latex_look',
      description:
        'See what a LaTeX document actually looks like. Compiles the main .tex with enough passes for the table of contents ' +
        'and cross-references to settle, renders the requested page to a PNG that the image reader can open, optionally resolves ' +
        'a text anchor or a PDF point to the exact source file and line via SyncTeX, and optionally diffs the page against the ' +
        'previous PDF so you can see what an edit changed. Also runs makeglossaries/makeindex/biber when the document needs them, ' +
        'and reports structured problems: file:line errors, LaTeX and Overfull/Underfull warnings, and an empty table of contents.',
      parameters: {
        file: {
          type: 'string',
          required: true,
          description: 'Path to the main .tex file (absolute, or relative to the current directory).',
        },
        page: {
          type: 'number',
          description: 'PDF page to render, 1-based. Omit when using `text`, which finds the page itself.',
        },
        text: {
          type: 'string',
          description:
            'A short string visible on the page (a caption, a heading, a unique phrase). Resolves to its source file:line and page.',
        },
        pointX: {
          type: 'number',
          description:
            'X of a point on the page, used together with pointY. Feed back the bbox of a previous diff to inspect what changed.',
        },
        pointY: {
          type: 'number',
          description: 'Y of the same point, in PDF points measured from the top-left corner of the page.',
        },
        compare: {
          type: 'string',
          description:
            'Path to an earlier PDF of the same document. The page is then diffed against it and a before image is rendered.',
        },
        dpi: { type: 'number', description: 'Render resolution, 50-300. Defaults to 140.' },
        engine: {
          type: 'string',
          description:
            'auto | xelatex | lualatex | pdflatex | latexmk | tectonic. Defaults to auto, which picks from what the document uses.',
        },
        maxPasses: {
          type: 'number',
          description: 'Maximum compile passes for classic engines, 1-10. Defaults to 3.',
        },
        fresh: {
          type: 'boolean',
          description: 'Ignore the build cache and compile from scratch. The cache is keyed on the mtime and size of the document, every file it \\input/\\include\'s, its images and its aux files; use this only if you suspect it is out of date.',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Per-pass time budget in seconds before the engine is killed. Defaults to 300.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        try {
          const file = isAbsolute(args.file) ? args.file : resolve(args.file)
          if (!existsSync(file)) return `latex_look: file not found: ${file}`
          // Never hand a caller-supplied name to spawn() as a binary.
          if (args.engine && args.engine !== 'auto' && !ENGINES.includes(String(args.engine))) {
            return `latex_look: unknown engine "${args.engine}"; expected auto or one of ${ENGINES.join(', ')}`
          }
          const hasX = Number.isFinite(args.pointX)
          const hasY = Number.isFinite(args.pointY)
          if (hasX !== hasY) return 'latex_look: pointX and pointY must be given together'

          const text = args.text == null ? '' : String(args.text).trim()
          const at = text ? { text } : hasX ? { x: args.pointX, y: args.pointY } : null

          const result = await look(file, {
            // pass `page` through untouched: core rejects a decimal or an out of
            // range value instead of quietly falling back to page 1
            page: args.page,
            at,
            compare: args.compare,
            dpi: clampInt(args.dpi, 50, 300, 140),
            engine: args.engine,
            maxPasses: clampInt(args.maxPasses, 1, 10, 3),
            timeoutSeconds: clampInt(args.timeoutSeconds, 5, 3600, 300),
            fresh: args.fresh === true,
          })
          return format(result)
        } catch (e) {
          return `latex_look: ${e instanceof Error ? e.message : String(e)}`
        }
      },
    }),
  )
}
