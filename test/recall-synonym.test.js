// 2026-11-07 加：拆词修过一轮，这几条是当时的回测用例，别再退回去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { tokenize, expandSynonyms, stripHookLines, recallByCue } from '../lib/recall.js'

const fresh = () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-syn-')))
  store.ensure()
  return store
}

test('全虚词二元组不进索引（这张、掉吧这种）', () => {
  const t = tokenize('这张旧截图删掉吧')
  assert.ok(!t.has('这张'))
  assert.ok(!t.has('掉吧'))
  assert.ok(t.has('截图') || t.has('删掉'))
})

test('口语补标准词：删掉→删除/trash，截图→图片/相册', () => {
  const s = expandSynonyms('这张旧截图删掉吧')
  assert.ok(s.includes('删除'))
  assert.ok(s.includes('trash'))
  assert.ok(s.includes('图片'))
})

test('「钩子：」那行不参与打分', () => {
  const body = '正文一句\n钩子：要删东西之前想起这张'
  assert.equal(stripHookLines(body), '正文一句')
})

test('删东西的线索能摸到「先挪 trash」那张卡', () => {
  const store = fresh()
  store.put({
    id: 'm-trash-test',
    kind: 'knowledge',
    source: 'owner',
    tags: ['删除', '规矩'],
    title: '删除先挪进 trash，不直接 rm',
    body: '要删的东西先 mv 到 trash/<日期>/，确认没用再清。',
  })
  store.put({
    id: 'm-noise-test',
    kind: 'knowledge',
    source: 'owner',
    tags: ['名字'],
    title: '主人本名阿岚',
    body: '主人在 B站私信里说：本名阿岚。\n钩子：叫主人、需要称呼时想起这张。',
  })
  const r = recallByCue(store, '这张旧截图删掉吧', { limit: 3 })
  assert.equal(r.status, 'matched')
  assert.equal(r.items[0].id, 'm-trash-test')
  // 光靠「这张」这种通用词蹭进来的，不许加热
  const noise = r.items.find((it) => it.id === 'm-noise-test')
  if (noise) assert.equal(noise.rehearsable, false)
})
