import hljs from 'highlight.js/lib/common'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import nginx from 'highlight.js/lib/languages/nginx'

hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('nginx', nginx)

const extensionAliases: Record<string, string> = {
  h: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  inl: 'cpp',
  otui: 'yaml',
  otmod: 'yaml',
  vue: 'xml',
  svg: 'xml',
  mjs: 'javascript',
  cjs: 'javascript',
  tsx: 'typescript',
  jsx: 'javascript',
  scss: 'scss',
  yml: 'yaml',
  conf: 'nginx',
}

export function languageForPath(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'dockerfile') {
    return 'dockerfile'
  }
  if (name === 'makefile') {
    return 'makefile'
  }
  const dot = name.lastIndexOf('.')
  if (dot < 0) {
    return undefined
  }
  const ext = name.slice(dot + 1)
  const language = extensionAliases[ext] ?? ext
  return hljs.getLanguage(language) ? language : undefined
}

const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => escapes[c])
}

/** Highlighting a block costs roughly linear time; past this, fall back to escaping. */
const MaxBlockChars = 400_000

/**
 * Highlights consecutive lines as one block, so constructs spanning lines
 * (block comments, long strings) are coloured correctly, then splits the
 * HTML back into one string per line, re-opening the spans cut at each newline.
 */
export function highlightLines(lines: ReadonlyArray<string>, language: string | undefined): string[] {
  const text = lines.join('\n')
  if (!language || text.length > MaxBlockChars) {
    return lines.map(escapeHtml)
  }
  let html: string
  try {
    html = hljs.highlight(text, { language, ignoreIllegals: true }).value
  } catch {
    return lines.map(escapeHtml)
  }
  return splitHighlighted(html)
}

export function splitHighlighted(html: string): string[] {
  const result: string[] = []
  const open: string[] = []
  let current = ''
  for (const [token] of html.matchAll(/<span[^>]*>|<\/span>|\n|[^<\n]+/g)) {
    if (token === '\n') {
      result.push(current + '</span>'.repeat(open.length))
      current = open.join('')
    } else if (token === '</span>') {
      open.pop()
      current += token
    } else if (token.startsWith('<span')) {
      open.push(token)
      current += token
    } else {
      current += token
    }
  }
  result.push(current + '</span>'.repeat(open.length))
  return result
}
