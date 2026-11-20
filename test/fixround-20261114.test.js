// 2026-11-14 午后修复轮的回归测试（第二轮只读复核指出的缺口：这 10 项修复原先没有测试）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { HippocampusStore } from '../lib/store.js'
import { hotForInjection } from '../lib/recall.js'
import { dreamPass, bodySimilar } from '../lib/dream.js'

function fakeCtx() {
  const tools = new Map()
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (def) => tools.set(def.name, def) },
    on: () => {},
    inject: () => {},
  }
  return { ctx, tools }
}

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hc-fix-'))
  const { ctx, tools } = fakeCtx()
  await apply(ctx, { dataDir })
  const store = new HippocampusStore(dataDir)
  const call = (name, args) => tools.get(name).execute(args)
  return { store, call }
}

const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

test('续写已接替的卡：清死因、解反向链、返回里说明', async () => {
  const { store, call } = await boot()
  const a = await call('hc_remember', { title: '旧卡', body: '旧的说法', source: 'owner', condition: '探针' })
  const b = await call('hc_remember', { title: '新卡', body: '新的说法', source: 'self', supersedes: a.id })
  assert.equal(store.get(a.id).superseded_by, b.id)
  const re = await call('hc_remember', { id: a.id, body: '旧卡改过一遍' })
  const revived = store.get(a.id)
  assert.equal(revived.superseded_by, '')
  assert.match(String(re.note || ''), /复活/)
  // 接替者的 supersedes 也要解开，否则留一条指向活卡的单向死链
  assert.ok(!String(store.get(b.id).supersedes || '').split(',').map((s) => s.trim()).includes(a.id))
})

test('续写不传 source / kind / tags 时继承旧卡（不许把 owner 降成 self）', async () => {
  const { store, call } = await boot()
  const c = await call('hc_remember', { title: '主人说的', body: '主人说这条算数', source: 'owner', kind: 'knowledge', tags: ['global:x'], condition: '主人改口前' })
  await call('hc_remember', { id: c.id, body: '补一句细节' })
  const after = store.get(c.id)
  assert.equal(after.source, 'owner')
  assert.equal(after.kind, 'knowledge')
  assert.deepEqual(after.tags, ['global:x'])
  assert.equal(after.valid_until, '') // owner 卡不该被盖 30 天临时情报的有效期
})

test('缺边界时补边界：owner 补条件、self 给 30 天', async () => {
  const { store, call } = await boot()
  const o = await call('hc_remember', { title: '主人亲口', body: '某件事', source: 'owner' })
  assert.equal(store.get(o.id).condition, '主人改口或情况变化前一直算数')
  const s = await call('hc_remember', { title: '本鲸推的', body: '某个推测', source: 'self' })
  assert.equal(store.get(s.id).valid_until, day(30))
})

test('supersedes 多值：两张旧卡都记上同一位接替者', async () => {
  const { store, call } = await boot()
  const x = await call('hc_remember', { title: 'X', body: 'X 正文', source: 'self', condition: '探针' })
  const y = await call('hc_remember', { title: 'Y', body: 'Y 正文', source: 'self', condition: '探针' })
  const z = await call('hc_remember', { title: 'Z', body: 'Z 正文', source: 'self', supersedes: `${x.id}, ${y.id}` })
  assert.equal(store.get(x.id).superseded_by, z.id)
  assert.equal(store.get(y.id).superseded_by, z.id)
  assert.deepEqual(String(store.get(z.id).supersedes).split(',').map((s) => s.trim()), [x.id, y.id])
})

test('注入轮换席：池里有几张，几个窗口内每张都轮得到', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hc-rot-'))
  const store = new HippocampusStore(dataDir)
  store.ensure()
  const now = Date.now()
  const ids = []
  for (let i = 0; i < 6; i += 1) {
    ids.push(store.put({ id: `r${i}`, kind: 'knowledge', source: 'self', title: 'T' + i, body: 'B' + i, weight: 3 - i * 0.01, last_hit: now, condition: '探针' }).id)
  }
  const limit = 3
  const pool = ids.length - (limit - 1) // 池 = 除固定前 2 席以外的全部动态热卡
  const seen = new Set()
  for (let w = 0; w < pool; w += 1) {
    for (const c of hotForInjection(store, { now: now + w * 6 * 3_600_000, limit })) seen.add(c.id)
  }
  assert.equal(seen.size, ids.length, '轮转一圈应该覆盖所有动态热卡')
})

test('同一趟做梦不会写出两张同质归纳卡', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hc-dream-'))
  const store = new HippocampusStore(dataDir)
  store.ensure()
  const now = Date.now()
  // 体积闸（2026-11-16）按原文总量算预算，fixture 用贴近真库的正文长度（中位 146 字），
  // 十几字的数据会被判成「压不薄」跳过，就测不到孪生闸了。
  const pad = '2026-11-13 主人在云州跟着公司走了一整天，下午到傍晚绕南湖走了一大圈，一路拍照片给本鲸看。'
  for (let i = 0; i < 3; i += 1) {
    store.put({ id: `e${i}`, kind: 'experience', source: 'self', title: '事件' + i, body: pad.repeat(3) + '同一件事的第 ' + i + ' 个侧面', tags: ['t1', 't2'], weight: 1, last_hit: now, condition: '探针' })
  }
  const r = dreamPass(store, { dryRun: false })
  const insights = store.all().filter((c) => c.kind === 'insight')
  assert.equal(insights.length, 1, '两个标签组撞出同一份整理，只该留一张')
  let worst = 0
  for (let i = 0; i < insights.length; i += 1) for (let j = i + 1; j < insights.length; j += 1) worst = Math.max(worst, bodySimilar(insights[i].body, insights[j].body))
  assert.ok(worst < 0.9, '同质对相似度应低于 0.9，实际 ' + worst)
})
