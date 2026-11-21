// 两个会话同时压缩时，折叠账必须各记各的（2026-11-21 #6：folding 是模块级单变量）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

function fakeCtx() {
  const handlers = []
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: () => {} },
    on: (event, fn) => handlers.push({ event, fn }),
    inject: () => {},
  }
  return { ctx, handlers }
}

test('两个会话同时压缩：各记各的账，不串也不丢', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-folding-'))
  const { ctx, handlers } = fakeCtx()
  await apply(ctx, { dataDir: dir })
  const onEvent = handlers.find((h) => h.event === 'session/event').fn

  // A 先开始，B 紧跟着开始（两会话并发压自己的历史）
  onEvent({ id: 'A' }, { type: 'compaction/start', data: {} })
  onEvent({ id: 'B' }, { type: 'compaction/start', data: {} })
  onEvent({ id: 'A' }, { type: 'compaction/prune', data: { shadowedTokenCount: 100, shadowedRange: { start: 1, end: 10 } } })
  onEvent({ id: 'B' }, { type: 'compaction/prune', data: { shadowedTokenCount: 200, shadowedRange: { start: 50, end: 80 } } })
  onEvent({ id: 'A' }, { type: 'compaction/end', data: {} })
  onEvent({ id: 'B' }, { type: 'compaction/end', data: {} })

  const rows = readFileSync(join(dir, 'compactions.jsonl'), 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(rows.length, 2, '两会话压缩只记了 ' + rows.length + ' 笔')
  const a = rows.find((r) => r.tokens === 100)
  const b = rows.find((r) => r.tokens === 200)
  assert.ok(a, 'A 的 100 token 那笔没记'); assert.ok(b, 'B 的 200 token 那笔没记')
  assert.equal(a.seqStart, 1); assert.equal(a.seqEnd, 10)
  assert.equal(b.seqStart, 50); assert.equal(b.seqEnd, 80)
})
