// 原话流水：只增不改、能按线索回查、行号稳定。
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

test('每一句都落盘，行号从 1 起、不回头改', () => {
  const store = fresh()
  assert.equal(store.appendStream({ role: 'owner', text: '主人说她生日是六月十五号。' }), 1)
  assert.equal(store.appendStream({ role: 'self', text: '本鲸记下了。' }), 2)
  assert.equal(store.streamSize(), 2)
  const hits = store.searchStream('生日')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].no, 1)
  assert.equal(hits[0].role, 'owner')
  assert.ok(hits[0].excerpt.includes('六月十五号'))
})

test('空话不落盘，长句截断但不丢行号', () => {
  const store = fresh()
  assert.equal(store.appendStream({ role: 'owner', text: '   ' }), 0)
  assert.equal(store.streamSize(), 0)
  const long = '小'.repeat(5000)
  const n = store.appendStream({ role: 'owner', text: long })
  assert.equal(n, 1)
  const hits = store.searchStream('小小小')
  assert.equal(hits.length, 1)
  assert.ok(hits[0].excerpt.endsWith('…'))
})

test('回查不到就说没有，不硬凑', () => {
  const store = fresh()
  store.appendStream({ role: 'owner', text: '今天吃了白米饭。' })
  assert.deepEqual(store.searchStream('火箭发射'), [])
})
