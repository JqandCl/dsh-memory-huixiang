import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { recallByCue, entityGate, askedEntitiesOf } from '../lib/recall.js'

const fresh = () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-gate-')))
  store.ensure()
  return store
}

const seeded = () => {
  const store = fresh()
  store.put({ id: 'b1', kind: 'knowledge', source: 'owner', tags: ['global:生日'], title: '主人生日：六月十五号', body: '主人生日是 六月十五号，那天想普普通通陪着过。' })
  store.put({ id: 'm1', kind: 'knowledge', source: 'owner', tags: ['ws:记忆'], title: '记忆整理要遵守什么', body: '记忆整理先看有没有重复，再看冲突，别合并改期。' })
  store.put({ id: 'h1', kind: 'experience', source: 'owner', tags: ['南湖'], body: '主人带本鲸在南湖边走了很久，记得湖边那碗阳春面。' })
  store.put({ id: 'c1', kind: 'knowledge', source: 'owner', tags: ['猫'], title: '猫', body: '主人说猫喜欢晒太阳。' })
  return store
}

test('实体槽第二根轴：问表弟生日 → not_found（不拿生日卡凑答案）', () => {
  const store = seeded()
  const r = recallByCue(store, '我表弟的生日是哪天')
  assert.equal(r.status, 'not_found')
  assert.deepEqual(r.items, [])
  assert.match(r.reason, /表弟/)
})

test('实体槽第二根轴：同事老周住哪 → not_found', () => {
  const store = seeded()
  const r = recallByCue(store, '我同事老周住哪个区')
  assert.equal(r.status, 'not_found')
})

test('实体槽第二根轴：体检血压 → not_found', () => {
  const store = seeded()
  const r = recallByCue(store, '我上次体检的血压是多少')
  assert.equal(r.status, 'not_found')
})

test('改述问句不被误杀：记忆整理 / 分身干活 / 南湖', () => {
  const store = seeded()
  assert.equal(recallByCue(store, '记忆整理要遵守什么').status, 'matched')
  assert.equal(recallByCue(store, '记忆整理要遵守什么').items[0].id, 'm1')
  assert.equal(recallByCue(store, '南湖那天走了哪里').items[0].id, 'h1')
})

test('slotMiss 标记：实体槽/弃权闸判死都带，供上层按实体过滤兜底', () => {
  const store = seeded()
  assert.equal(recallByCue(store, '我表弟的生日是哪天').slotMiss, true)
  assert.equal(recallByCue(store, '北极熊最近怎么样').slotMiss, true)
})


test('老实体词也走同一道闸：问车 → not_found 且带 slotMiss（原来不带，兜底会递回生日卡）', () => {
  const store = seeded()
  const r = recallByCue(store, '主人开什么车')
  assert.equal(r.status, 'not_found')
  assert.equal(r.slotMiss, true)
})

test('统一实体闸：卡里真提到实体就放行，没提到就拦', () => {
  const birthday = { id: 'b1', title: '主人生日：六月十五号', body: '主人生日是 六月十五号。' }
  const car = { id: 't1', title: '主人上班', body: '主人开白色的车上班，车是两年前买的。' }
  assert.equal(entityGate('主人开什么车', car).ok, true)
  assert.equal(entityGate('主人开什么车', birthday).ok, false)
  assert.equal(entityGate('我表弟的生日是哪天', birthday).ok, false)
  assert.equal(entityGate('北极熊最近怎么样', birthday).ok, true)
})

test('多义词只在特定问法里算实体：地址/角色/年龄', () => {
  // 2026-11-20 P2 收窄位置槽后：「住哪」同时算「位置」和「住址」（两个 need 取并集，住址卡只需含住/地址之一即可）
  assert.deepEqual(askedEntitiesOf('主人住哪，地址是什么'), ['位置', '住址'])
  assert.deepEqual(askedEntitiesOf('备份包地址在哪'), [])
  assert.deepEqual(askedEntitiesOf('本鲸算什么动漫角色'), ['角色'])
  assert.deepEqual(askedEntitiesOf('本鲸算什么角色'), [])
  assert.deepEqual(askedEntitiesOf('主人年龄多大'), ['年龄'])
  assert.deepEqual(askedEntitiesOf('主人年龄'), [])
})

test('单字查询照旧能召回', () => {
  const store = seeded()
  const r = recallByCue(store, '猫')
  assert.equal(r.status, 'matched')
  assert.equal(r.items[0].id, 'c1')
})
