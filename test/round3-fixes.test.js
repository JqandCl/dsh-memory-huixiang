// 第三轮：千问复核点出的 B16(CRLF) / B8(0 值语义) / #34(chainTail 负数) / B7(文案)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { normalizeHeat, apply } from '../index.js'

test('B16 Windows 记事本另存的 CRLF 卡不该整卡降级成默认值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crlf-'))
  const store = new HippocampusStore(dir)
  store.ensure()
  const CRLF = String.fromCharCode(13) + String.fromCharCode(10)
  const card = [
    '---',
    'kind: experience',
    'source: owner',
    'tags: 喜好, 食物',
    'weight: 3.500',
    'last_hit: 2026-11-20T00:00:00.000Z',
    'created: 2026-11-01T00:00:00.000Z',
    'pinned: true',
    'valid_until: 2026-12-31',
    'title: 测试卡',
    '---',
    '正文第一行',
    '正文第二行',
    '',
  ].join(CRLF)
  writeFileSync(join(dir, 'notes', 'crlf-card.md'), card)
  const c = store.get('crlf-card')
  assert.equal(c.weight, 3.5, 'weight 被重置成默认值')
  assert.deepEqual(c.tags, ['喜好', '食物'])
  assert.equal(c.pinned, true)
  assert.equal(c.valid_until, '2026-12-31')
  assert.equal(c.title, '测试卡')
  assert.ok(c.body.includes('正文第二行'))
})

test('B8 heat 配置：0 在允许的键上合法，负数/NaN/0 在不允许的键上仍回退默认', () => {
  const h = normalizeHeat({ rehearseBoost: 0, coldAfterDays: 0, floorWeight: 0, halfLifeDays: 0, maxWeight: -1, hotAt: NaN })
  assert.equal(h.rehearseBoost, 0, '禁加成是合法语义')
  assert.equal(h.coldAfterDays, 0, '立即冷是合法语义')
  assert.equal(h.floorWeight, 0, '禁地板是合法语义')
  assert.equal(h.halfLifeDays, 21, '半衰期 0 应回退默认')
  assert.equal(h.maxWeight, 4, '负上限应回退默认')
  assert.equal(h.hotAt, 0.55, 'NaN 应回退默认')
})

test('B8 heat 配置：拼错的键要出声，别静默无效', () => {
  const seen = []
  const orig = console.warn
  console.warn = (...a) => seen.push(a.join(' '))
  try {
    const h = normalizeHeat({ halfLifeDayz: 30 })
    assert.equal(h.halfLifeDays, 21)
  } finally {
    console.warn = orig
  }
  assert.ok(seen.some((s) => s.includes('halfLifeDayz')), '拼错的键没有 warn')
})

test('#34 chainTail 收到负数不能返回整条链', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'))
  const store = new HippocampusStore(dir)
  store.ensure()
  for (let i = 0; i < 8; i++) store.appendChain('第' + i + '句', '鲸玘')
  assert.deepEqual(store.chainTail(-5), [], '负数被当成 slice(5)，返回了除前 5 行外的全部')
  assert.equal(store.chainTail(2).length, 2)
})

test('B7 报错文案与 Unicode 白名单一致（归纳卡 id 里有汉字）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idmsg-'))
  const defs = new Map()
  const ctx = { effect: (fn) => { fn() }, on: () => {}, inject: () => {}, tools: { register: (d) => defs.set(d.name, d) } }
  await apply(ctx, { dataDir: dir, autoDream: { enabled: false } })
  const call = (n, a) => defs.get(n).execute(a)
  const bad = await call('hc_remember', { body: 'x', id: '../../etc/passwd' })
  assert.equal(bad.ok, false)
  assert.ok(!/只能用字母数字和/.test(bad.error), '文案还写着只许字母数字，但汉字 id 现在合法')
  assert.ok(/汉字|Unicode|中文/.test(bad.error), '文案没提汉字/Unicode')
})
