import { test, beforeEach, afterEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPartialPatch, parseDiff, selectableKeys } from '../src/diff-parser'
import {
  canUndoLastCommit,
  checkoutPullRequest,
  commitChanges,
  getCommitFiles,
  getCurrentBranch,
  getFileContent,
  getWorkingChanges,
  getWorkingDiff,
  restoreToHead,
  undoLastCommit,
} from '../src/git'

let base: string
let repo: string
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const r = (...args: string[]) => run(repo, ...args)
const write = (name: string, text: string) => writeFileSync(join(repo, name), text)
const read = (name: string) => readFileSync(join(repo, name), 'utf8')
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n'

beforeEach(() => {
  base = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'dv-commit-'))
  repo = join(base, 'repo')
  run(base, 'init', '-q', '-b', 'main', 'repo')
  r('config', 'user.name', 'Test User')
  r('config', 'user.email', 'test@example.com')
  r('config', 'commit.gpgsign', 'false')
  write('a.txt', lines(30, i => `line ${i}`))
  write('b.txt', 'b\n')
  r('add', '.')
  r('commit', '-q', '-m', 'Initial')
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

test('commits only the selected files and keeps other staged changes staged', async () => {
  write('a.txt', read('a.txt').replace('line 1\n', 'LINE 1\n'))
  write('b.txt', 'b changed\n')
  write('new.txt', 'new\n')
  r('add', 'b.txt')
  const changes = await getWorkingChanges(repo)
  const a = changes.find(f => f.path === 'a.txt')!
  const n = changes.find(f => f.path === 'new.txt')!
  await commitChanges(repo, 'Pick a and new\n\n#123 keeps hash lines\n', [{ file: a }, { file: n }])

  assert.equal(r('log', '-1', '--format=%B').trim(), 'Pick a and new\n\n#123 keeps hash lines')
  assert.deepEqual(r('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['a.txt', 'new.txt'])
  // b.txt is still staged and modified, untouched by the commit.
  assert.equal(r('diff', '--cached', '--name-only').trim(), 'b.txt')
  assert.equal(r('status', '--porcelain'), 'M  b.txt\n')
})

test('commits a partial selection of lines and leaves the rest in the working tree', async () => {
  const original = read('a.txt')
  write('a.txt', original.replace('line 2\n', 'line 2 edited\n').replace('line 25\n', 'line 25 edited\n'))
  const [file] = await getWorkingChanges(repo)
  const diff = parseDiff((await getWorkingDiff(repo, file, 3, false)).text)
  assert.equal(diff.hunks.length, 2)
  // Exclude every change of the second hunk.
  const excluded = new Set(selectableKeys(diff.hunks).filter(k => k.startsWith('1:')))
  const patch = buildPartialPatch(file.path, diff.hunks, excluded, false)!
  await commitChanges(repo, 'Partial', [{ file, patch }])

  const committed = r('show', 'HEAD:a.txt')
  assert.match(committed, /^line 2 edited$/m)
  assert.match(committed, /^line 25$/m)
  assert.match(read('a.txt'), /^line 25 edited$/m)
  assert.equal(r('diff', '--name-only').trim(), 'a.txt')
  assert.equal(r('diff', '--cached', '--name-only').trim(), '')
})

test('partial selection inside one hunk: excluded deletion becomes context, excluded addition is dropped', async () => {
  write('a.txt', read('a.txt').replace('line 5\nline 6\n', 'five\nsix\n'))
  const [file] = await getWorkingChanges(repo)
  const diff = parseDiff((await getWorkingDiff(repo, file, 3, false)).text)
  const keys = selectableKeys(diff.hunks)
  // Lines in order: -line 5, -line 6, +five, +six. Keep only "-line 5" and "+five".
  const kinds = keys.map(k => {
    const [h, i] = k.split(':').map(Number)
    return `${diff.hunks[h].lines[i].kind}:${diff.hunks[h].lines[i].text}`
  })
  const excluded = new Set(keys.filter((_, i) => kinds[i] === 'delete:line 6' || kinds[i] === 'add:six'))
  const patch = buildPartialPatch(file.path, diff.hunks, excluded, false)!
  await commitChanges(repo, 'Swap five', [{ file, patch }])
  assert.match(r('show', 'HEAD:a.txt'), /^line 4\nline 6\nfive\nline 7$/m)
})

test('partial commit of a new untracked file', async () => {
  write('fresh.txt', 'one\ntwo\nthree\n')
  const file = (await getWorkingChanges(repo)).find(f => f.path === 'fresh.txt')!
  const diff = parseDiff((await getWorkingDiff(repo, file, 3, false)).text)
  const keys = selectableKeys(diff.hunks)
  const patch = buildPartialPatch(file.path, diff.hunks, new Set([keys[1]]), true)!
  await commitChanges(repo, 'Fresh', [{ file, patch }])
  assert.equal(r('show', 'HEAD:fresh.txt'), 'one\nthree\n')
  assert.equal(read('fresh.txt'), 'one\ntwo\nthree\n')
})

test('a failing commit leaves the index untouched', async () => {
  write('b.txt', 'b staged\n')
  r('add', 'b.txt')
  write('a.txt', 'changed\n')
  const a = (await getWorkingChanges(repo)).find(f => f.path === 'a.txt')!
  await assert.rejects(commitChanges(repo, 'Bad', [{ file: a, patch: 'not a patch\n' }]))
  assert.equal(r('diff', '--cached', '--name-only').trim(), 'b.txt')
  assert.equal(r('log', '--format=%s').trim(), 'Initial')
})

test('undo last commit restores the message and keeps the changes', async () => {
  write('b.txt', 'b2\n')
  const [b] = await getWorkingChanges(repo)
  // The first commit cannot be undone.
  assert.equal(await canUndoLastCommit(repo), false)
  await commitChanges(repo, 'Summary line\n\nBody text\n', [{ file: b }])
  assert.equal(await canUndoLastCommit(repo), true)
  const message = await undoLastCommit(repo)
  assert.deepEqual(message, { summary: 'Summary line', description: 'Body text' })
  assert.equal(r('log', '--format=%s').trim(), 'Initial')
  assert.equal(read('b.txt'), 'b2\n')
})

test('restoreToHead reverts modified, deleted, added and renamed files', async () => {
  write('a.txt', 'modified\n')
  rmSync(join(repo, 'b.txt'))
  write('added.txt', 'x\n')
  r('add', 'added.txt')
  const files = await getWorkingChanges(repo)
  // The panel moves working copies to the trash first; emulate that.
  rmSync(join(repo, 'a.txt'))
  rmSync(join(repo, 'added.txt'))
  await restoreToHead(repo, files)
  assert.equal(r('status', '--porcelain'), '')
  assert.match(read('a.txt'), /^line 1$/m)
  assert.equal(read('b.txt'), 'b\n')
})

test('range diff across several commits and file content at a ref', async () => {
  write('b.txt', 'b2\n')
  r('commit', '-qam', 'Second')
  write('c.txt', 'c\n')
  r('add', 'c.txt')
  r('commit', '-qm', 'Third')
  const [third, second] = r('log', '--format=%H', '-2').trim().split('\n')
  const files = await getCommitFiles(repo, third, second)
  assert.deepEqual(files.map(f => f.path).sort(), ['b.txt', 'c.txt'])
  assert.equal(await getFileContent(repo, second, 'b.txt'), 'b2\n')
  write('c.txt', 'working\n')
  assert.equal(await getFileContent(repo, null, 'c.txt'), 'working\n')
})

test('checks out pull requests from the same repository and from forks', async () => {
  const remote = join(base, 'remote.git')
  run(base, 'init', '-q', '--bare', 'remote.git')
  r('remote', 'add', 'origin', remote)
  r('push', '-q', 'origin', 'main')
  // Same-repository PR branch.
  r('checkout', '-q', '-b', 'feature/x')
  write('x.txt', 'x\n')
  r('add', 'x.txt')
  r('commit', '-qm', 'X')
  r('push', '-q', 'origin', 'feature/x')
  // Fork PR: only reachable through refs/pull/7/head.
  r('checkout', '-q', '-b', 'fork-work', 'main')
  write('y.txt', 'y\n')
  r('add', 'y.txt')
  r('commit', '-qm', 'Y')
  r('push', '-q', 'origin', 'fork-work:refs/pull/7/head')
  r('checkout', '-q', 'main')
  r('branch', '-q', '-D', 'feature/x', 'fork-work')

  assert.equal(await checkoutPullRequest(repo, 'origin', { number: 3, headBranch: 'feature/x', fromFork: false }), 'feature/x')
  assert.equal(await getCurrentBranch(repo), 'feature/x')
  assert.equal(r('rev-parse', '--abbrev-ref', '@{upstream}').trim(), 'origin/feature/x')
  assert.ok(existsSync(join(repo, 'x.txt')))

  assert.equal(await checkoutPullRequest(repo, 'origin', { number: 7, headBranch: 'whatever', fromFork: true }), 'pr/7')
  assert.equal(await getCurrentBranch(repo), 'pr/7')
  assert.ok(existsSync(join(repo, 'y.txt')))
  // Checking out again fast-forwards the existing branch.
  r('checkout', '-q', 'main')
  assert.equal(await checkoutPullRequest(repo, 'origin', { number: 7, headBranch: 'whatever', fromFork: true }), 'pr/7')
})
