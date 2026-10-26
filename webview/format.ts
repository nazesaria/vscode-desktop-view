const locale: string = (window as any).__DESKTOP_VIEW_LOCALE__ || navigator.language || 'en'

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
const absolute = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' })

export function relativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.round((ms - now) / 1000)
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return relative.format(Math.trunc(seconds / size), unit)
    }
  }
  return relative.format(0, 'minute')
}

export function absoluteTime(ms: number): string {
  return absolute.format(new Date(ms))
}

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

/** GitHub avatar URL for an e-mail, the same lookup GitHub Desktop uses. */
export function avatarForEmail(email: string): string | undefined {
  const noreply = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email)
  if (noreply) {
    return `https://avatars.githubusercontent.com/u/${noreply[1]}?s=48`
  }
  if (!email) {
    return undefined
  }
  return `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email)}&s=48`
}
