import { test, before, after } from 'node:test'
import * as assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dropPullStash,
  getSyncStatus,
  git,
  isBlockedByLocalChanges,
  parsePullStashes,
  restorePullStash,
  stashForPull,
} from '../src/git'

let base: string
let repo: string
let upstream: string
const inDir = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
const run = (...args: string[]) => inDir(repo, ...args)

function configure(dir: string) {
  inDir(dir, 'config', 'user.name', 'Test User')
  inDir(dir, 'config', 'user.email', 'test@example.com')
  inDir(dir, 'config', 'commit.gpgsign', 'false')
}

before(() => {
  base = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'dv-stash-'))
  upstream = join(base, 'upstream')
  repo = join(base, 'repo')
  inDir(base, 'init', '-q', '-b', 'main', upstream)
  configure(upstream)
  writeFileSync(join(upstream, 'a.txt'), 'one\ntwo\n')
  inDir(upstream, 'add', '.')
  inDir(upstream, 'commit', '-q', '-m', 'Initial')
  inDir(base, 'clone', '-q', upstream, repo)
  configure(repo)
})

after(() => rmSync(base, { recursive: true, force: true }))

test('recognises errors a stash can solve', () => {
  assert.ok(isBlockedByLocalChanges('error: Your local changes to the following files would be overwritten by merge:\n\ta.txt'))
  assert.ok(isBlockedByLocalChanges('error: The following untracked working tree files would be overwritten by merge:'))
  assert.ok(isBlockedByLocalChanges('error: cannot pull with rebase: You have unstaged changes.'))
  assert.ok(!isBlockedByLocalChanges('fatal: Could not read from remote repository.'))
  assert.ok(!isBlockedByLocalChanges('error: Pulling is not possible because you have unmerged files.'))
})

test('keeps the real stash position and ignores other stashes', () => {
  const output = 'On main: my own\x1f100\nOn feature/x: Desktop View: stashed before pull\x1f200\nWIP on main: abc\x1f300\n'
  assert.deepEqual(parsePullStashes(output), [{ index: 1, branch: 'feature/x', date: 200000 }])
})

test('a blocked pull goes through after stashing, and restore brings the changes back', async () => {
  writeFileSync(join(upstream, 'a.txt'), 'one\nupstream\n')
  inDir(upstream, 'commit', '-q', '-am', 'Upstream change')
  writeFileSync(join(repo, 'a.txt'), 'one\nlocal\n')
  writeFileSync(join(repo, 'new.txt'), 'untracked\n')

  await assert.rejects(git(repo, ['pull', '--quiet']), (e: Error) => isBlockedByLocalChanges(e.message))
  assert.equal((await getSyncStatus(repo)).stashedAt, null)

  await stashForPull(repo)
  assert.ok(!existsSync(join(repo, 'new.txt')))
  assert.ok((await getSyncStatus(repo)).stashedAt)
  await git(repo, ['pull', '--quiet'])
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\nupstream\n')

  // Both sides changed the same line: git keeps the stash and reports the conflict.
  await assert.rejects(restorePullStash(repo))
  assert.ok((await getSyncStatus(repo)).stashedAt)
  run('reset', '-q', '--hard')
  rmSync(join(repo, 'new.txt'), { force: true })

  await dropPullStash(repo)
  assert.equal((await getSyncStatus(repo)).stashedAt, null)
})

test('restore without a conflict removes the stash', async () => {
  writeFileSync(join(repo, 'b.txt'), 'untracked\n')
  await stashForPull(repo)
  await restorePullStash(repo)
  assert.equal(readFileSync(join(repo, 'b.txt'), 'utf8'), 'untracked\n')
  assert.equal(run('stash', 'list'), '')
})

test('stashes of another branch are not offered here', async () => {
  writeFileSync(join(repo, 'c.txt'), 'untracked\n')
  await stashForPull(repo)
  run('checkout', '-q', '-b', 'other')
  assert.equal((await getSyncStatus(repo)).stashedAt, null)
  await assert.rejects(restorePullStash(repo), /no stashed changes/)
  run('checkout', '-q', 'main')
  assert.ok((await getSyncStatus(repo)).stashedAt)
})
