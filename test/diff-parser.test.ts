import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { parseDiff, toSplitRows } from '../src/diff-parser'

const sample = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,4 +1,5 @@ heading
 one
-two
+TWO
+two and a half
 three

@@ -10 +11,0 @@
-ten
\\ No newline at end of file
`

test('parses hunks, line numbers and stats', () => {
  const d = parseDiff(sample)
  assert.equal(d.hunks.length, 2)
  assert.equal(d.additions, 2)
  assert.equal(d.deletions, 2)
  const lines = d.hunks[0].lines
  assert.deepEqual(
    lines.map(l => [l.kind, l.oldLine, l.newLine]),
    [
      ['hunk', null, null],
      ['context', 1, 1],
      ['delete', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
      ['context', 4, 5],
    ]
  )
  assert.equal(d.hunks[1].oldCount, 1)
  assert.equal(d.hunks[1].newCount, 0)
  assert.equal(d.hunks[1].lines.at(-1)?.kind, 'noNewline')
})

test('accepts bare GitHub patches', () => {
  const d = parseDiff('@@ -1 +1 @@\n-a\n+b')
  assert.equal(d.hunks.length, 1)
  assert.equal(d.additions, 1)
})

test('detects binary diffs', () => {
  assert.equal(parseDiff('diff --git a/x b/x\nBinary files a/x and b/x differ\n').binary, true)
})

test('pairs deletes and adds in split rows', () => {
  const rows = toSplitRows(parseDiff(sample).hunks)
  const changed = rows.filter(r => r.kind === 'line' && (r.left?.kind === 'delete' || r.right?.kind === 'add'))
  assert.equal(changed.length, 3)
  assert.equal(changed[0].left?.text, 'two')
  assert.equal(changed[0].right?.text, 'TWO')
  assert.equal(changed[1].left, null)
  assert.equal(changed[2].left?.text, 'ten')
  assert.equal(changed[2].right, null)
})
