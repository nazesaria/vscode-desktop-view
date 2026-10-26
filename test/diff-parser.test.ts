import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { parseDiff } from '../src/diff-parser'

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

import { buildPartialPatch, diffGaps } from '../src/diff-parser'

test('partial patch with nothing selected is null', () => {
  const d = parseDiff('@@ -1 +1 @@\n-a\n+b\n')
  assert.equal(buildPartialPatch('x', d.hunks, new Set(['0:1', '0:2']), false), null)
})

test('partial patch keeps CRLF line endings', () => {
  const d = parseDiff('@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n')
  const patch = buildPartialPatch('x', d.hunks, new Set(), false)!
  assert.match(patch, / a\r\n-b\r\n\+c\r\n$/)
})

test('gaps between hunks and up to the end of file', () => {
  const d = parseDiff('@@ -5,3 +5,4 @@\n a\n+n\n b\n c\n@@ -20,2 +21,2 @@\n x\n-y\n+z\n')
  const gaps = diffGaps(d.hunks, 30)
  assert.deepEqual(gaps, [
    { newFirst: 1, newLast: 4, delta: 0 },
    { newFirst: 9, newLast: 20, delta: 1 },
    { newFirst: 23, newLast: 30, delta: 1 },
  ])
})
