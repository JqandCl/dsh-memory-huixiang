// 2026-11-14 养鱼 23 条落地的两条：召回兜底 + 写卡门槛。
// 同日晚按只读复核意见收紧了证据判据（罕见词、英文词边界、场合按同义复述也认、空结果不挂空壳）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { HippocampusStore } from '../lib/store.js'
import { keywordFallback } from '../lib/recall.js'

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
  const dataDir = mkdtempSync(join(tmpdir(), 'hc-fb-'))
  const { ctx, tools } = fakeCtx()
  await apply(ctx, { dataDir })
  const store = new HippocampusStore(dataDir)
  const call = (name, args) => tools.get(name).execute(args)
  return { store, call }
}

// 与生产代码同口径：本地日期（#1 之前这里是 UTC，晚上跑测试会差一天）。
const day = (n) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA')
const now = Date.now()
const NOISE = '南极 企鹅 冰川 火山 岩浆 珊瑚 海藻 绒鸭'

test('keywordFallback：正文里的罕见词能捞到，字段是 from/coverage/excerpt', () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-fb1-')))
  store.ensure()
  store.put({ id: 'm-a', kind: 'knowledge', source: 'self', tags: ['t'], title: '回响注入', body: '插值异常时把模板关掉', condition: '探针', weight: 2, last_hit: now })
  const r = keywordFallback(store, '插值')
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].from, 'card')
  assert.equal(r.items[0].kind, 'knowledge')
  assert.equal(r.items[0].lowConfidence, true)
  assert.equal(r.items[0].coverage, 1)
  assert.match(r.items[0].excerpt, /插值/)
})

test('keywordFallback：英文按词边界匹配（ai 不撞 email / main）', () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-fb2-')))
  store.ensure()
  store.put({ id: 'm-b', kind: 'knowledge', source: 'self', tags: ['t'], title: '邮件服务', body: 'email 服务要开 SSL', condition: '探针', weight: 2, last_hit: now })
  assert.equal(keywordFallback(store, 'ai').items.length, 0)
  assert.equal(keywordFallback(store, 'email').items.length, 1)
})

test('keywordFallback：到处都是的词不算线索（今天/随便 满库都是时捞不出东西）', () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-fb3-')))
  store.ensure()
  for (let i = 0; i < 25; i += 1) {
    store.put({ id: 'n' + i, kind: 'experience', source: 'self', tags: ['t'], title: '日常' + i, body: i < 10 ? '今天随便聊聊' : '别的内容', condition: '探针', weight: 1, last_hit: now })
  }
  const r = keywordFallback(store, '今天 随便 问问')
  assert.equal(r.items.length, 0, 'df 高的词该被剔掉，条目也不该靠这些词命中')
})

test('keywordFallback：死卡默认不捞，审计模式才捞', () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-fb4-')))
  store.ensure()
  store.put({ id: 'm-dead', kind: 'knowledge', source: 'self', tags: ['t'], title: '旧方案', body: 'memorilla 那套', condition: '探针', valid_until: day(-1), weight: 2, last_hit: now })
  assert.equal(keywordFallback(store, 'memorilla').items.length, 0)
  assert.equal(keywordFallback(store, 'memorilla', { includeSuperseded: true }).items.length, 1)
})

test('keywordFallback：空库 / 空线索 / 纯标点都不抛异常', () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-fb5-')))
  store.ensure()
  for (const cue of ['', '，。！', 'a', null]) {
    const r = keywordFallback(store, cue)
    assert.deepEqual(r.items, [])
  }
})

test('hc_recall：not_found 且零线索 → 兜底为 null（不给空壳）；有线索才挂', async () => {
  const { store, call } = await boot()
  store.put({ id: 'm-fb', kind: 'knowledge', source: 'self', tags: ['t'], title: '回响注入', body: '插值异常时把模板关掉', condition: '探针', weight: 1, last_hit: now })
  const miss = await call('hc_recall', { cue: NOISE })
  assert.equal(miss.status, 'not_found')
  assert.equal(miss.兜底, null, '一个线索都没有就别挂空兜底')
  const before = store.get('m-fb').weight
  assert.equal(store.get('m-fb').weight, before, 'not_found 不改权重')
  // 卡片召回看不到原话流水：兜底真正补的是这一块。给 stream 塞一句带罕见词的，再看兜底。
  store.appendStream({ role: 'owner', text: '绒鸭在南极的岩石上排队', at: now })
  const withLead = await call('hc_recall', { cue: '南极 企鹅 绒鸭' })
  assert.equal(withLead.status, 'not_found')
  assert.ok(withLead.兜底 && withLead.兜底.stream.length >= 1, '原话里有的罕见词应该给低置信线索')
  assert.equal(withLead.兜底.stream[0].from, 'stream')
  assert.ok(!withLead.兜底.items.some((it) => it.id === 'm-fb'), '不相干的卡不该被捞进来')
  assert.equal(store.get('m-fb').weight, before, '兜底不是「想起来了」，不许加热')
})

test('hc_recall：matched 与 ambiguous 都不挂兜底', async () => {
  const { store, call } = await boot()
  store.put({ id: 'm-x', kind: 'knowledge', source: 'self', tags: ['t'], title: '插值模板', body: '插值异常时关模板', condition: '探针', weight: 2, last_hit: now })
  store.put({ id: 'm-y', kind: 'knowledge', source: 'self', tags: ['t'], title: '插值模板二', body: '插值异常时也关模板', condition: '探针', weight: 2, last_hit: now })
  const hit = await call('hc_recall', { cue: '插值异常' })
  assert.ok(hit.status === 'matched' || hit.status === 'ambiguous')
  assert.equal(hit.兜底, null)
})

test('写卡门槛：self 新卡证据不足 → 30 天临时情报 + 说明', async () => {
  const { store, call } = await boot()
  const r = await call('hc_remember', { title: '某条规律', body: '只在正文里出现的一个说法', source: 'self', condition: '换场景再说时' })
  assert.equal(store.get(r.id).valid_until, day(30))
  assert.match(String(r.note || ''), /样本不足/)
})

test('写卡门槛：显式 valid_until:"" 等同于没写，仍过闸', async () => {
  const { store, call } = await boot()
  const r = await call('hc_remember', { title: '某条规律二', body: '正文', source: 'self', condition: '换场景再说时', valid_until: '' })
  assert.equal(store.get(r.id).valid_until, day(30))
})

test('写卡门槛：3 个不同日子的同义复述也认，不降级', async () => {
  const { store, call } = await boot()
  const lines = ['又碰到场景复用的老毛病', '场景复用这事儿又来了', '复用场景真烦']
  for (let i = 0; i < lines.length; i += 1) store.appendStream({ role: 'owner', text: lines[i], at: now - (3 - i) * 86_400_000 })
  const r = await call('hc_remember', { title: '场景复用', body: '场景复用的规律', source: 'self', condition: '换场景再说时' })
  assert.equal(store.get(r.id).valid_until, '')
  assert.doesNotMatch(String(r.note || ''), /样本不足/)
})

test('写卡门槛：泛标题撞上满流水的「问题」不算场合', async () => {
  const { store, call } = await boot()
  for (let i = 0; i < 25; i += 1) store.appendStream({ role: 'owner', text: '这个问题有点烦', at: now - (i % 3) * 86_400_000 })
  const r = await call('hc_remember', { title: '问题', body: '某件事', source: 'self', condition: '换场景再说时' })
  assert.equal(store.get(r.id).valid_until, day(30), '泛词该被 df 过滤掉，不能算三个场合')
})

test('写卡门槛：标题只剩一个实词时不算多次（宁降级）', async () => {
  const { store, call } = await boot()
  for (let i = 0; i < 3; i += 1) store.appendStream({ role: 'owner', text: '插值又出问题了', at: now - (3 - i) * 86_400_000 })
  const r = await call('hc_remember', { title: '插值', body: '一次观察', source: 'self', condition: '换插件时' })
  assert.equal(store.get(r.id).valid_until, day(30))
})

test('写卡门槛：主人亲口、续写旧卡、显式有效期都不过闸', async () => {
  const { store, call } = await boot()
  const o = await call('hc_remember', { title: '主人说的', body: '主人说的规矩', source: 'owner', condition: '改口前' })
  assert.equal(store.get(o.id).valid_until, '')
  const old = store.put({ id: 'm-old', kind: 'knowledge', source: 'self', tags: ['t'], title: '旧规律', body: '旧正文', condition: '换场景再说时', weight: 2, last_hit: now })
  const re = await call('hc_remember', { id: old.id, body: '旧正文补一句' })
  assert.equal(store.get(re.id).valid_until, '', '续写不该把长期卡悄悄改成 30 天')
  const explicit = await call('hc_remember', { title: '显式有效期', body: '正文', source: 'self', condition: '换场景再说时', valid_until: '2027-06-30' })
  assert.equal(store.get(explicit.id).valid_until, '2027-06-30')
})