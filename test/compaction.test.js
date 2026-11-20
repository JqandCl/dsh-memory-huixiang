// 折叠自知：把一轮压缩的 token 数攒起来记一笔，并且让快照里看得到。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { apply } from '../index.js'
import { renderSnapshot } from '../lib/prompt.js'

function fakeCtx() {
  const handlers = []
  const contexts = []
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: () => {} },
    on: (event, fn) => handlers.push({ event, fn }),
    inject: (_names, cb) => {
      cb({
        effect: (fn) => fn(),
        systemPrompt: { section: () => {}, context: (s) => contexts.push(s) },
      })
    },
  }
  return { ctx, handlers, contexts }
}

test('一轮 prune 攒到 summary，记成一笔', async () => {
  const { ctx, handlers } = fakeCtx()
  const dir = mkdtempSync(join(tmpdir(), 'hc-'))
  await apply(ctx, { dataDir: dir })
  const store = new HippocampusStore(dir)
  store.ensure()

  const fire = (event) => handlers[0].fn(null, event)
  fire({ type: 'compaction/start', data: { compactionId: 'c1' } })
  fire({ type: 'compaction/prune', data: { shadowedTokenCount: 6096, shadowedRange: { start: 879, end: 879 } } })
  fire({ type: 'compaction/prune', data: { shadowedTokenCount: 12492, shadowedRange: { start: 3948, end: 4018 } } })
  fire({ type: 'compaction/summary', data: { text: '摘要' } })

  const last = store.lastCompaction()
  assert.equal(last.tokens, 18588)
  assert.equal(last.seqStart, 879)
  assert.equal(last.seqEnd, 4018)
})

test('第二次折叠不带上一次的账', async () => {
  const { ctx, handlers } = fakeCtx()
  const dir = mkdtempSync(join(tmpdir(), 'hc-'))
  await apply(ctx, { dataDir: dir })
  const store = new HippocampusStore(dir)
  store.ensure()
  const fire = (event) => handlers[0].fn(null, event)

  fire({ type: 'compaction/start', data: {} })
  fire({ type: 'compaction/prune', data: { shadowedTokenCount: 1000, shadowedRange: { start: 1, end: 2 } } })
  fire({ type: 'compaction/end', data: {} })
  fire({ type: 'compaction/start', data: {} })
  fire({ type: 'compaction/prune', data: { shadowedTokenCount: 700, shadowedRange: { start: 9, end: 9 } } })
  fire({ type: 'compaction/end', data: {} })

  assert.equal(store.lastCompaction().tokens, 700)
  assert.equal(store.lastCompaction().seqStart, 9)
})

test('快照里会写「刚被折叠」，并指路去查原话', () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-')))
  store.ensure()
  store.recordCompaction({ tokens: 12492, seqStart: 3948, seqEnd: 4018 })
  const text = renderSnapshot({ store, hot: [], chainLines: 3 })
  assert.ok(text.includes('刚被折叠'))
  assert.ok(text.includes('12.5k'))
  assert.ok(text.includes('hc_evidence'))
})

test('小到不值一提的压缩不打扰上下文', () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-')))
  store.ensure()
  store.recordCompaction({ tokens: 120 })
  const text = renderSnapshot({ store, hot: [], chainLines: 3 })
  assert.ok(!text.includes('刚被折叠'))
})
