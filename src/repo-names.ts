import * as path from 'path'

/**
 * Tells apart repositories with the same folder name by the closest parent
 * folders that differ: `cards/login-2fa/site` and `cards/authfix/site` become
 * "login-2fa" and "authfix".
 */
export function repositoryQualifiers(roots: string[]): Map<string, string> {
  const byName = new Map<string, string[]>()
  for (const root of roots) {
    const name = path.basename(root)
    byName.set(name, [...(byName.get(name) ?? []), root])
  }
  const result = new Map<string, string>()
  for (const group of byName.values()) {
    if (group.length < 2) {
      continue
    }
    const parents = group.map(r => path.dirname(r).split(/[\\/]/).filter(Boolean))
    for (let i = 0; i < group.length; i++) {
      const mine = parents[i]
      let take = 1
      while (
        take < mine.length &&
        parents.some((other, j) => j !== i && other.slice(-take).join('/') === mine.slice(-take).join('/'))
      ) {
        take++
      }
      result.set(group[i], mine.slice(-take).join('/'))
    }
  }
  return result
}
