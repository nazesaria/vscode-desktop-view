import { test, beforeEach, afterEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repositoryQualifiers } from '../src/repo-names'
import { buildDiscardPatch, buildPartialPatch, lineKey, parseDiff, selectableKeys } from '../src/diff-parser'
import {
  canUndoLastCommit,
  checkoutBranch,
  checkoutPullRequest,
  commitChanges,
  createBranch,
  deleteBranch,
  discardPatch,
  getCommitFiles,
  getCurrentBranch,
  getFileContent,
  getHistory,
  getWorkingChanges,
  getSyncStatus,
  getWorkingDiff,
  listBranches,
  renameBranch,
  restoreToHead,
  undoLastCommit,
  validateBranchName,
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
  // The temporary fetch ref is not left behind.
  assert.equal(r('for-each-ref', 'refs/desktop-view'), '')
})

/** Keys of the diff lines whose kind and text match, e.g. 'add:five'. */
const keysWhere = (hunks: ReturnType<typeof parseDiff>['hunks'], wanted: string[]) => {
  const keys = new Set<string>()
  hunks.forEach((hunk, h) =>
    hunk.lines.forEach((line, i) => wanted.includes(`${line.kind}:${line.text}`) && keys.add(lineKey(h, i)))
  )
  return keys
}

test('discards selected lines and keeps the others', async () => {
  const original = read('a.txt')
  write(
    'a.txt',
    original
      .replace('line 5\nline 6\n', 'five\nsix\n')
      .replace('line 10\n', 'line 10\nextra\n')
      .replace('line 25\n', 'line 25 edited\n')
  )
  const [file] = await getWorkingChanges(repo)
  const diff = parseDiff((await getWorkingDiff(repo, file, 3, false)).text)
  // Revert "line 5" -> "five" and the second hunk; keep the "line 6" -> "six" swap and "extra".
  const selected = keysWhere(diff.hunks, ['delete:line 5', 'add:five', 'delete:line 25', 'add:line 25 edited'])
  await discardPatch(repo, buildDiscardPatch(file.path, diff.hunks, selected)!)
  assert.equal(
    read('a.txt'),
    original.replace('line 6\n', 'six\n').replace('line 10\n', 'line 10\nextra\n')
  )
  // Discarding only an added line and only a deleted line.
  const diff2 = parseDiff((await getWorkingDiff(repo, file, 3, false)).text)
  await discardPatch(repo, buildDiscardPatch(file.path, diff2.hunks, keysWhere(diff2.hunks, ['add:extra']))!)
  const diff3 = parseDiff((await getWorkingDiff(repo, file, 3, false)).text)
  await discardPatch(repo, buildDiscardPatch(file.path, diff3.hunks, keysWhere(diff3.hunks, ['delete:line 6']))!)
  assert.equal(read('a.txt'), original.replace('line 6\n', 'line 6\nsix\n'))
  assert.equal(buildDiscardPatch(file.path, diff3.hunks, new Set()), null)
})

test('discards lines of a CRLF file without touching line endings', async () => {
  write('crlf.txt', 'one\r\ntwo\r\nthree\r\n')
  r('add', 'crlf.txt')
  r('commit', '-qm', 'crlf')
  write('crlf.txt', 'one\r\nTWO\r\nthree\r\nfour\r\n')
  const file = (await getWorkingChanges(repo)).find(f => f.path === 'crlf.txt')!
  const diff = parseDiff((await getWorkingDiff(repo, file, 3, false)).text)
  await discardPatch(repo, buildDiscardPatch(file.path, diff.hunks, keysWhere(diff.hunks, ['add:four']))!)
  assert.equal(read('crlf.txt'), 'one\r\nTWO\r\nthree\r\n')
})

test('lists, validates, creates, switches, renames and deletes branches', async () => {
  assert.equal(await validateBranchName(repo, 'main'), 'A branch named "main" already exists.')
  assert.match((await validateBranchName(repo, 'bad..name'))!, /not a valid/)
  assert.equal(await validateBranchName(repo, 'feature/new'), null)

  write('b.txt', 'uncommitted\n')
  await createBranch(repo, 'feature/new')
  assert.equal(await getCurrentBranch(repo), 'feature/new')
  // Uncommitted changes travel with the switch.
  assert.equal(read('b.txt'), 'uncommitted\n')
  r('commit', '-qam', 'On feature')

  await checkoutBranch(repo, { name: 'main', remote: false, date: 0 })
  assert.equal(await getCurrentBranch(repo), 'main')
  await renameBranch(repo, 'feature/new', 'feature/renamed')
  const names = (await listBranches(repo)).map(b => b.name)
  assert.deepEqual(names.sort(), ['feature/renamed', 'main'])
  // Unmerged work is protected unless forced.
  await assert.rejects(deleteBranch(repo, 'feature/renamed', false))
  await deleteBranch(repo, 'feature/renamed', true)
  assert.deepEqual((await listBranches(repo)).map(b => b.name), ['main'])
})

test('sync status counts ahead/behind and remote branches check out as tracking branches', async () => {
  let status = await getSyncStatus(repo)
  assert.deepEqual({ ...status, lastFetched: null }, {
    remote: null, branch: 'main', upstream: null, ahead: 0, behind: 0, lastFetched: null, undoable: null, stashedAt: null,
  })

  const remote = join(base, 'remote.git')
  run(base, 'init', '-q', '--bare', '-b', 'main', 'remote.git')
  r('remote', 'add', 'origin', remote)
  status = await getSyncStatus(repo)
  assert.equal(status.remote, 'origin')
  assert.equal(status.upstream, null)

  r('push', '-q', '-u', 'origin', 'main')
  r('push', '-q', 'origin', 'main:topic')
  write('b.txt', 'local\n')
  r('commit', '-qam', 'Local')
  // Someone else pushes to main.
  const other = join(base, 'other')
  run(base, 'clone', '-q', remote, 'other')
  run(other, '-c', 'user.name=O', '-c', 'user.email=o@example.com', 'commit', '-q', '--allow-empty', '-m', 'Remote')
  run(other, 'push', '-q', 'origin', 'main')
  r('fetch', '-q')

  status = await getSyncStatus(repo)
  assert.equal(status.upstream, 'origin/main')
  assert.equal(status.ahead, 1)
  assert.equal(status.behind, 1)
  assert.ok(status.lastFetched && status.lastFetched > Date.now() - 60_000)

  const topic = (await listBranches(repo)).find(b => b.name === 'origin/topic')!
  assert.equal(topic.remote, true)
  assert.equal(await checkoutBranch(repo, topic), 'topic')
  assert.equal(r('rev-parse', '--abbrev-ref', '@{upstream}').trim(), 'origin/topic')
  assert.equal((await listBranches(repo)).find(b => b.name === 'main')!.upstream, 'origin/main')
})

test('history marks the commits the remote does not have yet', async () => {
  const flags = async () => (await getHistory(repo, 0, 10)).commits.map(c => `${c.summary}:${!!c.unpushed}`)
  // No remote at all: nothing to push to, so nothing is flagged.
  assert.deepEqual(await flags(), ['Initial:false'])

  run(base, 'init', '-q', '--bare', '-b', 'main', 'remote.git')
  r('remote', 'add', 'origin', join(base, 'remote.git'))
  // Unpublished branch: every commit on no remote branch counts.
  assert.deepEqual(await flags(), ['Initial:true'])

  r('push', '-q', '-u', 'origin', 'main')
  r('commit', '-q', '--allow-empty', '-m', 'Second')
  r('commit', '-q', '--allow-empty', '-m', 'Third')
  assert.deepEqual(await flags(), ['Third:true', 'Second:true', 'Initial:false'])

  r('push', '-q')
  assert.deepEqual(await flags(), ['Third:false', 'Second:false', 'Initial:false'])

  // A new branch without upstream: only its own commits, not those already on origin/main.
  r('checkout', '-q', '-b', 'feature')
  r('commit', '-q', '--allow-empty', '-m', 'Feature')
  assert.deepEqual(await flags(), ['Feature:true', 'Third:false', 'Second:false', 'Initial:false'])
})

test('repositories with the same folder name are told apart by their parent folders', () => {
  const q = repositoryQualifiers([
    '/w/repos/core',
    '/w/cards/_fechados/merge-bots/core',
    '/w/cards/login-2fa/site',
    '/w/cards/authfix/site',
    '/w/a/x/game',
    '/w/b/x/game',
    '/w/repos/luna',
  ])
  assert.deepEqual(Object.fromEntries(q), {
    '/w/repos/core': 'repos',
    '/w/cards/_fechados/merge-bots/core': 'merge-bots',
    '/w/cards/login-2fa/site': 'login-2fa',
    '/w/cards/authfix/site': 'authfix',
    '/w/a/x/game': 'a/x',
    '/w/b/x/game': 'b/x',
  })
})

test('sync status offers Undo only for a local, non-merge HEAD commit', async () => {
  // The first commit has no parent to go back to.
  assert.equal((await getSyncStatus(repo)).undoable, null)
  write('b.txt', 'second\n')
  r('commit', '-qam', 'Second')
  const undoable = (await getSyncStatus(repo)).undoable
  assert.equal(undoable?.summary, 'Second')
  assert.equal(undoable?.sha, r('rev-parse', 'HEAD').trim())

  run(base, 'init', '-q', '--bare', '-b', 'main', 'remote.git')
  r('remote', 'add', 'origin', join(base, 'remote.git'))
  r('push', '-q', '-u', 'origin', 'main')
  assert.equal((await getSyncStatus(repo)).undoable, null)
})

test('reading the status leaves .git/index alone, so it never fights the git extension for index.lock', async () => {
  const index = join(repo, '.git', 'index')
  // Make the index stale, the case where a plain `git status` rewrites it.
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(repo, 'b.txt'), new Date(), new Date())
  utimesSync(index, old, old)
  const before = statSync(index).mtimeMs
  await getWorkingChanges(repo)
  assert.equal(statSync(index).mtimeMs, before)
})
