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

/** Highlights a single line. Multi-line constructs (block comments) are best effort. */
export function highlightLine(text: string, language: string | undefined): string {
  if (!language || text.length > 1000) {
    return escapeHtml(text)
  }
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(text)
  }
}
