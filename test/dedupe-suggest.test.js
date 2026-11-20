// 11-14 复核后：写侧去重窗口 7 天、相似卡只给合并建议、边界缺失卡注入标「临时情报」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { HippocampusStore } from '../lib/store.js'
import { renderSnapshot } from '../lib/prompt.js'

function fakeCtx() {
  const tools = new Map()
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (def) => tools.set(def.name, def) },
    on: () => {},
    inject: (names, cb) => cb({ effect: (fn) => fn(), systemPrompt: { section: () => {}, context: () => {} } }),
  }
  return { ctx, tools }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hc-dedupe7d-'))
  const { ctx, tools } = fakeCtx()
  await apply(ctx, { dataDir: dir })
  return { tools, store: new HippocampusStore(dir), dir }
}

const age = (store, id, days) => {
  const card = store.get(id)
  const t = Date.now() - days * 86_400_000
  store.put({ ...card, created: new Date(t).toISOString(), last_write: t })
}

test('窗口放宽到 7 天：6 天前记过同一句话，再记一次仍算重复', async () => {
  const { tools, store } = await setup()
  const a = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:七'], body: '主人说周四去体检。' })
  age(store, a.id, 6)
  const b = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:七'], body: '主人说周四去体检。' })
  assert.equal(b.dedupe, true)
  assert.equal(b.id, a.id)
  assert.equal(store.all().length, 1)
})

test('超过 7 天同一句话是新的一笔，不再并进旧卡', async () => {
  const { tools, store } = await setup()
  const a = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:八'], body: '主人说周四去体检。' })
  age(store, a.id, 8)
  const b = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:八'], body: '主人说周四去体检。' })
  assert.ok(!b.dedupe, '过了窗口就不该并')
  assert.notEqual(b.id, a.id)
  assert.equal(store.all().length, 2)
})

test('相似但不同的卡：新建 + 给合并/接替建议，不吞新卡', async () => {
  const { tools, store } = await setup()
  const a = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:相似'], body: '主人说周四去体检，在二号楼。' })
  const b = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:相似'], body: '周四去体检，主人说在二号楼做。' })
  assert.ok(!b.dedupe, '相似不等于同一件事，必须保留新卡')
  assert.equal(store.all().length, 2)
  assert.ok(b.suggest_merge && b.suggest_merge.id === a.id, '应指回相似旧卡：' + JSON.stringify(b))
  assert.ok(b.suggest_merge.similarity >= 0.72)
  assert.ok(b.suggest_merge.diff && Array.isArray(b.suggest_merge.diff.newOnly), '合并建议要带差异点：' + JSON.stringify(b.suggest_merge))
  assert.match(b.note, /差异：/, 'note 里也要能直接看出差在哪：' + b.note)
  assert.match(b.note, /相似老卡/, '提示里要说清是建议、不自动并：' + b.note)
})

test('死卡不会出现在合并建议里', async () => {
  const { tools, store } = await setup()
  const a = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:死'], body: '主人说周四去体检，在二号楼。' })
  const card = store.get(a.id)
  store.put({ ...card, superseded_by: 'm-dead-x', valid_until: '2026-01-01' })
  const b = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:死'], body: '周四去体检，主人说在二号楼做。' })
  assert.ok(!b.suggest_merge, '别建议合并到一张已经死掉的卡')
})

test('注入时只有「本鲸推的 + 没写边界」标临时情报；owner / pinned 不标', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-bound-'))
  const store = new HippocampusStore(dir)
  store.ensure()
  const hot = [
    { id: 'x1', title: '那家米店周末排队', body: '那家米店周末排队', source: 'self', weight: 3, live_weight: 3, tags: ['ws:吃'], conflict: false },
    { id: 'x2', title: '主人公司在城西', body: '主人公司在城西', source: 'owner', weight: 3, live_weight: 3, tags: ['ws:工作'], conflict: false, condition: '换工作就不成立' },
    { id: 'x3', title: '主人本名阿岚', body: '主人本名阿岚', source: 'owner', weight: 4, live_weight: 4, tags: ['global:主人'], conflict: false },
    { id: 'x4', title: '删除先挪进 trash', body: '删除先挪进 trash', source: 'self', pinned: true, weight: 4, live_weight: 4, tags: ['global:规矩'], conflict: false },
  ]
  const text = renderSnapshot({ store, hot })
  assert.match(text, /临时情报/, 'self 无边界卡要被标出来')
  assert.match(text, /换工作就不成立/, '有边界的卡照常写边界')
  const lines = text.split('\n').filter((l) => l.startsWith('- ['))
  assert.ok(lines[0].includes('临时情报'))
  assert.ok(!lines[1].includes('临时情报'), '写了边界的不标')
  assert.ok(!lines[2].includes('临时情报'), '主人亲口说的不标临时情报：' + lines[2])
  assert.ok(!lines[3].includes('临时情报'), 'pinned 底线卡不标临时情报：' + lines[3])
  // 标记必须在卡尾（重量之后），别动行首——行首一变整段前缀缓存就作废。
  assert.ok(lines[0].indexOf('临时情报') > lines[0].indexOf('重量'), '临时情报要放卡尾：' + lines[0])
})
