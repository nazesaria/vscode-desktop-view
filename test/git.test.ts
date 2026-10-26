import { test, before, after } from 'node:test'
import * as assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getBranches,
  getCommitDiff,
  getCommitFiles,
  getCurrentBranch,
  getHistory,
  getWorkingChanges,
  getWorkingDiff,
  parseGitHubRemote,
  parseNumstat,
} from '../src/git'

let repo: string
const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

before(() => {
  repo = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'dv-test-'))
  run('init', '-q', '-b', 'main')
  run('config', 'user.name', 'Test User')
  run('config', 'user.email', 'test@example.com')
  run('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'old name.txt'), 'rename me\nplease\nkeep\n')
  run('add', '.')
  run('commit', '-q', '-m', 'Initial commit')
  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n')
  renameSync(join(repo, 'old name.txt'), join(repo, 'new name.txt'))
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]))
  run('add', '-A')
  run('commit', '-q', '-m', 'Second commit', '-m', 'With a body')
  run('branch', 'feature')
  run('checkout', '-q', 'feature')
  writeFileSync(join(repo, 'f.txt'), 'feature\n')
  run('add', '.')
  run('commit', '-q', '-m', 'Feature work')
  run('checkout', '-q', 'main')
  // Working tree changes
  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n')
  writeFileSync(join(repo, 'untracked.txt'), 'new\n')
})

after(() => rmSync(repo, { recursive: true, force: true }))

test('history, pagination and branch compare', async () => {
  const page = await getHistory(repo, 0, 1)
  assert.equal(page.commits.length, 1)
  assert.equal(page.hasMore, true)
  assert.equal(page.commits[0].summary, 'Second commit')
  assert.equal(page.commits[0].body, 'With a body')
  assert.equal(page.commits[0].authorName, 'Test User')
  assert.ok(page.commits[0].refs.includes('main'))

  const all = await getHistory(repo, 0, 50)
  assert.equal(all.commits.length, 2)
  assert.equal(all.hasMore, false)

  const behind = await getHistory(repo, 0, 50, { branch: 'feature', mode: 'behind' })
  assert.deepEqual(behind.commits.map(c => c.summary), ['Feature work'])
  const ahead = await getHistory(repo, 0, 50, { branch: 'feature', mode: 'ahead' })
  assert.equal(ahead.commits.length, 0)

  assert.equal(await getCurrentBranch(repo), 'main')
  assert.deepEqual((await getBranches(repo)).sort(), ['feature', 'main'])
})

test('commit files with renames, binaries and stats', async () => {
  const [second, first] = (await getHistory(repo, 0, 50)).commits
  const files = await getCommitFiles(repo, second.sha)
  const byPath = new Map(files.map(f => [f.path, f]))
  assert.equal(byPath.get('a.txt')?.status, 'modified')
  assert.equal(byPath.get('a.txt')?.additions, 1)
  assert.equal(byPath.get('a.txt')?.deletions, 1)
  assert.equal(byPath.get('new name.txt')?.status, 'renamed')
  assert.equal(byPath.get('new name.txt')?.oldPath, 'old name.txt')
  assert.equal(byPath.get('bin.dat')?.binary, true)

  const rootFiles = await getCommitFiles(repo, first.sha)
  assert.deepEqual(rootFiles.map(f => f.status), ['added', 'added'])

  const diff = await getCommitDiff(repo, second.sha, byPath.get('a.txt')!, 3, false)
  assert.match(diff.text, /^-two$/m)
  assert.match(diff.text, /^\+TWO$/m)
  const bin = await getCommitDiff(repo, second.sha, byPath.get('bin.dat')!, 3, false)
  assert.equal(bin.binary, true)
  const rootDiff = await getCommitDiff(repo, first.sha, rootFiles[0], 3, false)
  assert.match(rootDiff.text, /^\+one$/m)
})

test('working tree changes and diffs', async () => {
  const changes = await getWorkingChanges(repo)
  assert.deepEqual(
    changes.map(f => [f.path, f.status]),
    [
      ['a.txt', 'modified'],
      ['untracked.txt', 'untracked'],
    ]
  )
  const modified = await getWorkingDiff(repo, changes[0], 3, false)
  assert.match(modified.text, /^\+four$/m)
  const untracked = await getWorkingDiff(repo, changes[1], 3, false)
  assert.match(untracked.text, /^\+new$/m)
})

test('numstat parsing with renames', () => {
  const stats = parseNumstat('1\t2\ta.txt\0' + '0\t0\t\0old\0new\0' + '-\t-\tbin\0')
  assert.deepEqual(stats.get('a.txt'), { additions: 1, deletions: 2, binary: false })
  assert.equal(stats.has('new'), true)
  assert.equal(stats.get('bin')?.binary, true)
})

test('GitHub remote parsing', () => {
  assert.deepEqual(parseGitHubRemote('git@github.com:andreantunes/game_core.git'), { owner: 'andreantunes', name: 'game_core' })
  assert.deepEqual(parseGitHubRemote('https://github.com/shiftkey/desktop.git'), { owner: 'shiftkey', name: 'desktop' })
  assert.deepEqual(parseGitHubRemote('https://token@github.com/a/b'), { owner: 'a', name: 'b' })
  assert.equal(parseGitHubRemote('batista@beta1:~/spawner'), null)
})
