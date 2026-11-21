// 折叠自知：把一轮压缩的 token 数记一笔，并且让快照里看得到。
//
// 2026-11-21 复核 P1：原来的测试喂的是「多条 prune 累加 + summary 落账」——
// 这个形状宿主根本不发。prune 是「工具结果瘦身」发的影子定价事件（早于 start、也不在同一个事务里），
// start 又会把累加器清零，所以线上 compactions.jsonl 从 2026-11-05 建库起一行都没写进去，测试却是绿的。
// 现在按宿主真实顺序写：start → summary（带 shadowedTokenCount / shadowedRange）→ end。
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

async function setup() {
  const { ctx, handlers } = fakeCtx()
  const dir = mkdtempSync(join(tmpdir(), 'hc-'))
  await apply(ctx, { dataDir: dir })
  const store = new HippocampusStore(dir)
  store.ensure()
  const onEvent = handlers.find((h) => h.event === 'session/event').fn
  // session 为 null 时 foldKey 是 ''，退回「最新一条」口径。
  const fire = (event, session = null) => onEvent(session, event)
  return { store, fire }
}

test('宿主真实顺序 start → summary → end：按 summary 的 shadowedTokenCount 记一笔', async () => {
  const { store, fire } = await setup()
  fire({ type: 'compaction/start', data: { compactionId: 'c1' } })
  fire({
    type: 'compaction/summary',
    data: { summary: '摘要', shadowedTokenCount: 18588, shadowedRange: { start: 879, end: 4018 } },
  })
  fire({ type: 'compaction/end', data: { compactionId: 'c1' } })

  const last = store.lastCompaction()
  assert.ok(last, 'summary 之后应该有一笔账')
  assert.equal(last.tokens, 18588)
  assert.equal(last.seqStart, 879)
  assert.equal(last.seqEnd, 4018)
})

test('工具结果瘦身（只有 prune、没有 summary）不算折叠账', async () => {
  // 真红保护：旧代码拿 prune 累加、end 落账，这条会写出「6k token 被折叠」——那只是工具结果瘦身。
  const { store, fire } = await setup()
  fire({ type: 'compaction/start', data: {} })
  fire({ type: 'compaction/prune', data: { shadowedTokenCount: 6096, shadowedRange: { start: 3, end: 9 } } })
  fire({ type: 'compaction/end', data: {} })
  assert.equal(store.lastCompaction(), null)
})

test('第二次折叠不带上一次的账', async () => {
  const { store, fire } = await setup()
  fire({ type: 'compaction/start', data: {} })
  fire({ type: 'compaction/summary', data: { shadowedTokenCount: 1000, shadowedRange: { start: 1, end: 2 } } })
  fire({ type: 'compaction/end', data: {} })
  fire({ type: 'compaction/start', data: {} })
  fire({ type: 'compaction/summary', data: { shadowedTokenCount: 700, shadowedRange: { start: 9, end: 9 } } })
  fire({ type: 'compaction/end', data: {} })

  assert.equal(store.lastCompaction().tokens, 700)
  assert.equal(store.lastCompaction().seqStart, 9)
})

test('折叠账带会话归属：别的窗口读不到这笔', async () => {
  // 真红保护：旧 recordCompaction 不存 sid、lastCompaction 又不收参，A 被压掉多少会念给 B 听。
  const { store, fire } = await setup()
  fire(
    { type: 'compaction/summary', data: { shadowedTokenCount: 5000, shadowedRange: { start: 1, end: 9 } } },
    { id: 'A' },
  )
  assert.equal(store.lastCompaction('A').tokens, 5000)
  assert.equal(store.lastCompaction('B'), null)
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
