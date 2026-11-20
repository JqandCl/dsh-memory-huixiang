// 死卡（被接替 / 过期）在检索里的态度：默认不返回，审计能翻到。
// 2026-11-10 补：原来 hotForInjection 硬过滤、recallByCue 只降权，同一概念两套标准。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { recallByCue, hotForInjection, isDead } from '../lib/recall.js'

const fresh = () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-dead-')))
  store.ensure()
  return store
}

test('被接替的卡默认不召回，includeSuperseded 时仍能翻到', () => {
  const store = fresh()
  store.put({ id: 'old', kind: 'knowledge', source: 'owner', tags: ['周报'], body: '周报要写三段。' })
  store.put({ id: 'new', kind: 'knowledge', source: 'owner', tags: ['周报'], body: '周报改成一段加数字。', supersedes: 'old' })
  // 把 old 标成已被 new 接替
  store.put({ id: 'old', kind: 'knowledge', source: 'owner', tags: ['周报'], body: '周报要写三段。', superseded_by: 'new' })

  const plain = recallByCue(store, '周报怎么写')
  assert.equal(plain.items.some((i) => i.id === 'old'), false, '死卡不该出现在默认召回里')
  assert.equal(plain.items.some((i) => i.id === 'new'), true, '现行卡该在')

  const audit = recallByCue(store, '周报怎么写', { includeSuperseded: true })
  assert.equal(audit.items.some((i) => i.id === 'old'), true, '审计模式必须能翻到旧卡')
})

test('过期卡默认不召回', () => {
  const store = fresh()
  store.put({ id: 'exp', kind: 'knowledge', source: 'owner', tags: ['值班'], body: '这周三是本鲸值班。', valid_until: '2026-01-01' })
  assert.equal(recallByCue(store, '值班').items.some((i) => i.id === 'exp'), false)
  assert.equal(recallByCue(store, '值班', { includeSuperseded: true }).items.some((i) => i.id === 'exp'), true)
})

test('热注入和召回用同一把尺子', () => {
  const store = fresh()
  store.put({ id: 'old', kind: 'knowledge', source: 'owner', tags: ['计划'], body: '下周去临海。' })
  store.put({ id: 'new', kind: 'knowledge', source: 'owner', tags: ['计划'], body: '改成去高邮。', supersedes: 'old' })
  store.put({ id: 'old', kind: 'knowledge', source: 'owner', tags: ['计划'], body: '下周去临海。', superseded_by: 'new' })
  const injected = hotForInjection(store, { limit: 3 }).map((c) => c.id)
  assert.equal(injected.includes('old'), false, '死卡不该被自动注入')
  assert.equal(injected.includes('new'), true)
})

test('isDead 判据：接替与过期都算死，正常卡不算', () => {
  assert.equal(isDead({ superseded_by: 'x' }), true)
  assert.equal(isDead({ valid_until: '2020-01-01' }), true)
  assert.equal(isDead({}), false)
  assert.equal(isDead({ valid_until: '2999-01-01' }), false)
})

test('过期卡也不进热注入（两把尺子同一把）', () => {
  const store = fresh()
  store.put({ id: 'exp2', kind: 'knowledge', source: 'owner', tags: ['会议'], body: '周五三点开评审。', valid_until: '2026-01-01' })
  store.put({ id: 'live1', kind: 'knowledge', source: 'owner', tags: ['会议'], body: '周六四点复盘。' })
  const injected = hotForInjection(store, { limit: 3 }).map((c) => c.id)
  assert.equal(injected.includes('exp2'), false, '过期卡不该被自动注入')
  assert.equal(injected.includes('live1'), true)
})

test('isDead 对写坏的 valid_until 视为无有效期（宁可不拦也不让卡失踪）', () => {
  // 2026-11-10 确认的行为选择：expiryMs 解析失败返 0，旧 inline 判断会把它当「已过期」永久踢出注入。
  assert.equal(isDead({ valid_until: 'garbage' }), false)
})
