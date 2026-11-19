import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { ENGINES, look } from './lib/core.mjs'
import { formatResult } from './lib/format.mjs'
import { PACKAGE, checkForUpdate, restartPending, upgradeCommand } from './lib/update.mjs'

// The plugin id, deliberately unchanged when the package moved to a scope: profile
// config, enable state and the bundle row (`id: latex-look`) all key off it, and a
// reader does not care what a package is called. The npm name lives in package.json.
export const name = 'dsh-latex-look'

// What to say about versions, worked out at most once a minute while the tool is in
// use. Two different situations, and telling them apart is the whole point:
//
//   - a newer release exists on npm       → it is not here yet
//   - a newer release is already on disk  → it is here, this process is not running it
//
// The second is what an automatic update leaves behind, and it stays invisible
// unless the disk is asked: the running code reads its version off a package.json
// that was replaced underneath it, so it happily reports the new number while
// executing the old code.
let versionNote = null
let versionNoteAt = 0

async function currentVersionNote() {
  if (Date.now() - versionNoteAt < 60_000) return versionNote
  versionNoteAt = Date.now()
  const [restart, release] = await Promise.all([
    restartPending().catch(() => null),
    checkForUpdate().catch(() => null),
  ])
  // An update already on disk that has not been loaded is the whole story; also
  // announcing that npm has that same version would say it twice.
  if (restart) {
    versionNote = restart
    return versionNote
  }
  if (release && release.outdated && release.latest) {
    const how = upgradeCommand()
    versionNote =
      `note: ${PACKAGE} ${release.latest} is published; this process is running ${release.current}.` +
      (how ? ` Upgrade with: ${how}` : ' Upgrading is a profile install; the new code loads on restart.')
    return versionNote
  }
  versionNote = null
  return versionNote
}

// `tools` to register latex_look; `systemPrompt` so the "look before you claim
// it is done" discipline is unconditional rather than dependent on the skill
// being loaded in time.
export const inject = ['tools', 'systemPrompt']

const SYSTEM_PROMPT = [
  'A LaTeX document that compiles can still look wrong, and blind editing will not reveal it.',
  'When the user describes a page visually — a table style, a rule to remove, spacing, a line running into the margin, a figure that is too large, page headers and footers —',
  'or before claiming any layout change is finished, call the `latex_look` tool:',
  'it compiles the document, renders the requested page to a PNG, locates source text, and maps a selected point to its nearest SyncTeX box. A decorative rule may have an unconfirmed source.',
  'Keep the verified PDF page when looking up a text anchor. After editing, look again with the default `compare` value of "previous" to see the change.',
  'Never report a layout fix as done without having looked at the rendered page afterwards.',
  // Two lessons from a reader who only sees the PDF: page numbers in the file are
  // not the numbers printed on the page, and a reply full of pixel counts answers a
  // question they did not ask.
  '`page` is the PDF page index, not the number printed on the page: in a book the front matter shifts them by ten or more.',
  'When the user quotes a page number, render that page first and read the number printed at its foot before you edit anything.',
  'When reporting back, lead with the before/after image and say in one plain sentence what changed and which pages were affected;',
  'mention pixel counts or bounding boxes only when asked for evidence.',
].join(' ')

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'tool:latex-look', order: 1100, text: SYSTEM_PROMPT })

  // Fire and forget: plugin load must not wait on the network, and a registry outage
  // must never look like a broken tool. The answer is not thrown away any more —
  // it feeds currentVersionNote(), which the reply picks up.
  currentVersionNote()
    .then((note) => {
      if (note) ctx.logger?.info?.(`[latex-look] ${note}`)
    })
    .catch(() => {})

  ctx.tools.register(
    defineTool({
      name: 'latex_look',
      description:
        'See what a LaTeX document actually looks like. Compiles the main .tex with enough passes for the table of contents ' +
        'and cross-references to settle, renders the requested page to a PNG that the image reader can open, optionally resolves ' +
        'a text anchor to its source or a PDF point to the nearest SyncTeX box, and optionally diffs the page against the ' +
        'previous PDF so you can see what an edit changed (both pages in one side-by-side image). ' +
        'Note that `page` is the PDF page index, not the number printed on the page. ' +
        'Also runs makeglossaries/makeindex/biber when the document needs them, ' +
        'and reports structured problems: file:line errors, LaTeX and Overfull/Underfull warnings, and an empty table of contents.',
      parameters: {
        file: {
          type: 'string',
          required: true,
          description: 'Path to the main .tex file (absolute, or relative to the current directory).',
        },
        page: {
          type: 'number',
          description: '1-based PDF page to render. With text, restrict source matches to this page. Omit to find the page from the text.',
        },
        text: {
          type: 'string',
          description:
            'A short string visible on the page (a caption, a heading, a unique phrase). Resolves to its source file:line and page.',
        },
        pointX: {
          type: 'number',
          description:
            'X in PDF points from the top left, together with pointY. Multiply original preview pixel coordinates by 72 / dpi. A diff bbox is already in PDF points.',
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
          description: 'Recompile even on a cache hit. The cache checks project inputs recorded by TeX, literal source, style, image and bibliography references, aux files and the output PDF. Use fresh after changing an external dependency.',
        },
        audit: {
          type: 'boolean',
          description:
            'Audit every page for layout regressions. Compare with the previous distinct PDF audited at the same auditBlankMm. ' +
            'Reports newly short, low-starting or nearly empty pages and gaps that grew substantially. ' +
            'Use after changing captions, headers or spacing across pages.',
        },
        auditBlankMm: {
          type: 'number',
          description: 'How deep a hole at the foot of a page must be (mm) before the audit calls it one. Defaults to 30.',
        },
        sequence: {
          type: 'string',
          description:
            "Check reading order for numbered labels that start with this prefix (e.g. '图' or 'Figure'). Reports any " +
            "inversion, which is what a figure that became a float while its neighbours stayed inline causes: the reader " +
            "turns the page to see 图 3-4 before 图 3-3. Run it after any change to how objects are placed.",
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Per-pass time budget in seconds before the engine is killed. Defaults to 120.',
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

          // An idle session may need a registry refresh. Let an available
          // note accompany this page without waiting for network I/O.
          currentVersionNote().catch(() => {})
          const result = await look(file, {
            // pass `page` through untouched: core rejects a decimal or an out of
            // range value instead of quietly falling back to page 1
            page: args.page,
            at,
            compare: args.compare,
            dpi: clampInt(args.dpi, 50, 300, 140),
            engine: args.engine,
            maxPasses: clampInt(args.maxPasses, 1, 10, 3),
            timeoutSeconds: clampInt(args.timeoutSeconds, 5, 3600, 120),
            fresh: args.fresh === true,
            audit: args.audit === true,
            auditBlankMm: clampInt(args.auditBlankMm, 5, 200, 30),
            sequence: args.sequence ? String(args.sequence) : null,
          })
          return formatResult(result, { hint: versionNote })
        } catch (e) {
          return `latex_look: ${e instanceof Error ? e.message : String(e)}`
        }
      },
    }),
  )
}
