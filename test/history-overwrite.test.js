import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'

const setup = () => new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-hist-')))

test('覆盖一张卡会留旧版（trash 只救删除，救不了覆盖）', () => {
  const store = setup()
  const a = store.put({ id: 'h1', kind: 'knowledge', source: 'owner', title: '值班时间', body: '周三晚上八点。', tags: ['ws:x'] })
  store.put({ ...store.get('h1'), body: '周三晚上九点。' })
  const dir = join(store.dir, 'history', 'h1')
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  assert.equal(files.length, 1, '应该留一份旧版')
  assert.match(files[0], /^\d{4}-/)
  assert.ok(a.body.includes('八点'))
})

test('只改权重/召回时间不留旧版（否则 history 会被 touch 刷满）', () => {
  const store = setup()
  store.put({ id: 'h2', kind: 'knowledge', source: 'owner', title: '卡', body: '正文。', tags: ['ws:y'] })
  store.touch('h2', Date.now(), 'recall')
  store.touch('h2', Date.now(), 'recall')
  let files = []
  try { files = readdirSync(join(store.dir, 'history', 'h2')).filter((f) => f.endsWith('.md')) } catch {}
  assert.equal(files.length, 0)
})

test('每张卡旧版最多留 20 份', () => {
  const store = setup()
  store.put({ id: 'h3', kind: 'knowledge', source: 'owner', title: '卡', body: 'v0', tags: ['ws:z'] })
  for (let i = 1; i <= 25; i += 1) store.put({ ...store.get('h3'), body: `v${i}` })
  const files = readdirSync(join(store.dir, 'history', 'h3')).filter((f) => f.endsWith('.md'))
  assert.ok(files.length <= 20, `最多 20 份，实际 ${files.length}`)
})
