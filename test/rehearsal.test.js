// 用进废退：被想起一次就变重、并且记一笔账；没想起就不该记账。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'

const fresh = () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-')))
  store.ensure()
  return store
}

test('想起一次：重量加上去，账本留一条', () => {
  const store = fresh()
  store.put({ id: 'm1', title: '生日', body: '主人六月十五号生日。', tags: ['生日'] })
  const before = store.get('m1').weight
  const after = store.touch('m1', Date.now(), '生日')
  assert.ok(after.weight > before)
  assert.equal(store.rehearsalsMap().get('m1'), 1)
})

test('没碰过的记忆，账本里没有它', () => {
  const store = fresh()
  store.put({ id: 'm1', body: '一条没被想起来的记忆。' })
  store.put({ id: 'm2', body: '另一条。' })
  store.touch('m2')
  const map = store.rehearsalsMap()
  assert.equal(map.get('m1'), undefined)
  assert.equal(map.get('m2'), 1)
})

test('账本越积越多，计数跟着涨', () => {
  const store = fresh()
  store.put({ id: 'm1', body: '会被想起很多次的记忆。' })
  for (let i = 0; i < 3; i += 1) store.touch('m1')
  assert.equal(store.rehearsalsMap().get('m1'), 3)
})
