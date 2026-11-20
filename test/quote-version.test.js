import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { recallByCue } from '../lib/recall.js'

const fresh = () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-q-')))
  store.ensure()
  return store
}

test('原话能存能读，多行原话不会把 frontmatter 撑破', () => {
  const store = fresh()
  store.put({
    id: 'q1',
    title: '面试改期',
    body: '主人说面试改到周四了。',
    quote: '面试改到周四了\n别提醒我两次',
  })
  const card = store.get('q1')
  assert.equal(card.body, '主人说面试改到周四了。')
  assert.match(card.quote, /面试改到周四了/)
  assert.match(card.quote, /别提醒我两次/)
  // 再读一次（从盘上解析）仍然完整
  assert.equal(store.all().length, 1)
  assert.match(store.get('q1').quote, /别提醒我两次/)
})

test('旧卡被接替：标过期、记 superseded_by、原话和正文都还在', () => {
  const store = fresh()
  store.put({ id: 'old', title: '旧理解', body: '面试是周三。', quote: '周三面试', conflict: false })
  store.put({ id: 'new', title: '新理解', body: '面试改到周四了。', supersedes: 'old' })
  // 模拟 index.js 里的接替动作（与 remember() 一致）
  const old = store.get('old')
  store.put({
    ...old,
    valid_until: new Date().toISOString().slice(0, 10),
    superseded_by: 'new',
    conflict: old.conflict === true,
  })
  const after = store.get('old')
  assert.ok(after.valid_until, '旧卡应有过期日')
  assert.equal(after.superseded_by, 'new')
  assert.equal(after.conflict, false, '接替不是矛盾，不该标 conflict')
  assert.equal(after.body, '面试是周三。', '旧正文必须留着')
  assert.equal(after.quote, '周三面试', '旧原话必须留着')
})

test('召回结果带原话，方便按原话回查', () => {
  const store = fresh()
  store.put({ id: 'r1', title: '生日', body: '主人说生日在六月。', quote: '我生日六月啊', tags: ['生日'] })
  const res = recallByCue(store, '还记得生日吗', { limit: 3 })
  assert.equal(res.status, 'matched')
  assert.equal(res.items[0].quote, '我生日六月啊')
})
