// 2026-11-14 便签轮转回归：便签按 6h 窗口切片，不许冻在前 N 张（分身模拟出过 30 天只轮到 21/124）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { HippocampusStore } from '../lib/store.js'
import { hotForInjection, injectionBriefs } from '../lib/recall.js'

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hc-brief-'))
  const tools = new Map()
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (def) => tools.set(def.name, def) },
    on: () => {},
    inject: () => {},
  }
  await apply(ctx, { dataDir })
  const store = new HippocampusStore(dataDir)
  return { store, call: (name, args) => tools.get(name).execute(args) }
}

test('便签按 6 小时窗口轮转：30 天覆盖 >= 80% 动态池', async () => {
  const { store, call } = await boot()
  for (let i = 0; i < 80; i++) {
    await call('hc_remember', { title: '测试卡 ' + i, body: '第 ' + i + ' 条各不相同的测试记忆', source: 'self', condition: '测试用' })
  }
  const base = Date.now()
  const cards = store.all()
  const seen = new Set()
  for (let w = 0; w <= 120; w++) {
    const now = base + w * 6 * 3_600_000
    const hot = hotForInjection(store, { now, limit: 3, cards })
    const { briefs } = injectionBriefs(store, { now, limit: 10, cards, excludeIds: hot.map((c) => c.id) })
    for (const b of briefs) seen.add(b.id)
  }
  const pool = cards.length - hotForInjection(store, { now: base, limit: 3, cards }).length
  assert.ok(seen.size / pool >= 0.8, '30 天只覆盖 ' + seen.size + '/' + pool)
})

test('同窗口内便签稳定（同一 6h 窗口多次装配结果一致）', async () => {
  const { store, call } = await boot()
  for (let i = 0; i < 30; i++) await call('hc_remember', { title: '卡 ' + i, body: '内容 ' + i, source: 'self', condition: '测试' })
  const cards = store.all()
  const t0 = 1_800_000_000_000
  const a = injectionBriefs(store, { now: t0, limit: 10, cards }).briefs.map((c) => c.id)
  const b = injectionBriefs(store, { now: t0 + 1000, limit: 10, cards }).briefs.map((c) => c.id)
  assert.deepEqual(a, b)
})
