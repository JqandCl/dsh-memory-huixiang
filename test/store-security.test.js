import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore, isSafeId } from '../lib/store.js'

// 2026-11-20 发布前复核：卡 id 会被拼进文件路径，store 层必须自己拦住上跳与分隔符。

const fresh = () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-sec-')))
  store.ensure()
  return store
}

test('合法 id 放行：ASCII 与中文归纳 id 都算', () => {
  for (const id of ['m-mw4e6pji-qdbm', 'ins-云州-mwp5qm0r', 'a.b_c-1']) {
    assert.equal(isSafeId(id), true, id)
  }
})

test('非法 id 全拒：分隔符、上跳、空、空格', () => {
  const bad = ['../x', 'a/b', 'a\\b', '', null, undefined, 'a b']
  for (const id of bad) {
    assert.equal(isSafeId(id), false, String(id))
  }
})

test('get 遇非法 id 返回 undefined，不抛', () => {
  const store = fresh()
  assert.equal(store.get('../notes/x'), undefined)
  assert.equal(store.get(''), undefined)
})

test('put 遇非法 id 抛错，且没在目录外写文件', () => {
  const store = fresh()
  const outside = join(store.dir, 'evil.md')
  assert.throws(() => store.put({ id: '../evil', body: 'x' }), /非法卡 id/)
  assert.equal(existsSync(outside), false)
})

test('卡文件 0600、notes 目录 0700（同机别的账户读不到）', () => {
  const store = fresh()
  store.put({ id: 'ok1', body: '这是一条正常记忆。' })
  assert.equal(statSync(join(store.notesDir, 'ok1.md')).mode & 0o777, 0o600)
  assert.equal(statSync(store.notesDir).mode & 0o777, 0o700)
})