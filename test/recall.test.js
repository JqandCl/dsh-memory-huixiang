import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { tokenize, shouldRecall, recallByCue, hotForInjection } from '../lib/recall.js'
import { DAY_MS } from '../lib/heat.js'

const fresh = () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-')))
  store.ensure()
  return store
}

test('中文切二元组，虚词不进索引', () => {
  const t = tokenize('你还记得南湖那家面馆吗')
  assert.ok(t.has('南湖'))
  assert.ok(t.has('面馆'))
  assert.ok(!t.has('吗'))
})

test('空线索不翻库；有实词就允许翻（门槛放宽了）', () => {
  assert.equal(shouldRecall('你还记得上次我说的那个事吗'), true)
  assert.equal(shouldRecall('生日'), true)
  assert.equal(shouldRecall('嗯'), false)
  assert.equal(shouldRecall(''), false)
})

test('顺着标签摸回事件', () => {
  const store = fresh()
  store.put({ id: 'e1', kind: 'experience', source: 'owner', tags: ['南湖', '面馆'], body: '主人带本鲸在南湖边吃了一碗阳春面。' })
  const hit = recallByCue(store, '你还记得南湖那家面馆吗')
  assert.equal(hit.status, 'matched')
  assert.equal(hit.items[0].id, 'e1')
  assert.equal(hit.items[0].source, 'owner')
})

test('库里没有就老实说没有', () => {
  const store = fresh()
  const miss = recallByCue(store, '还记得我提过的那个北极熊吗')
  assert.equal(miss.status, 'not_found')
  assert.deepEqual(miss.items, [])
})

test('冷的记忆不进上下文，但能按线索搜到', () => {
  const store = fresh()
  const old = new Date(Date.now() - 200 * DAY_MS).toISOString()
  store.put({ id: 'e-old', kind: 'experience', tags: ['小学'], body: '主人说他小学门口有棵银杏。', last_hit: Date.parse(old), created: old })
  assert.deepEqual(hotForInjection(store).map((c) => c.id).filter((id) => id === 'e-old'), [])
  const hit = recallByCue(store, '还记得我小学那棵树吗')
  assert.equal(hit.status, 'matched')
  assert.equal(hit.items[0].id, 'e-old')
})

test('弃权：只有「名字/叫什么」这种泛词命中的卡不算线索', () => {
  const store = fresh()
  store.put({ id: 'p1', kind: 'knowledge', source: 'owner', tags: ['global:名字', 'global:主人'], title: '主人本名阿岚', body: '主人叫阿岚。' })
  assert.equal(recallByCue(store, '我妹妹叫什么名字').status, 'not_found')
  // 带上别的实词就该翻到（「主人」不算泛词）
  const r = recallByCue(store, '主人叫什么名字')
  assert.equal(r.status, 'matched')
  assert.equal(r.items[0].id, 'p1')
})

test('改述：瞎编→虚报、打字太长→片段、现在叫→改名', () => {
  const store = fresh()
  store.put({ id: 'h1', kind: 'knowledge', source: 'owner', tags: ['ws:诚实'], title: '不许虚报：没查就说没查', body: '拿不准说「我还没查」，说「好了」要带证据。' })
  store.put({ id: 'f1', kind: 'knowledge', source: 'owner', tags: ['global:对话'], title: '片段式说话：连着上文看', body: '人说话是片段式的，一件事分几段讲。' })
  store.put({ id: 'n1', kind: 'knowledge', source: 'owner', tags: ['ws:记忆'], title: '记忆插件改名叫「回响」', body: '插件新名字回响。' })

  assert.equal(recallByCue(store, '我说的话你会不会瞎编').items[0]?.id, 'h1')
  assert.equal(recallByCue(store, '打字太长该怎么跟你说').items[0]?.id, 'f1')
  assert.equal(recallByCue(store, '记忆插件现在叫什么').items[0]?.id, 'n1')
})

test('别名 aka：主人叫过的说法能当索引，存盘也能读回来', () => {
  const store = fresh()
  const id = 'q1'
  store.put({ id, kind: 'knowledge', source: 'owner', title: 'QQ 通道打通了', aka: ['聊天线'], body: '桥接跑通了。' })
  assert.deepEqual(store.get(id).aka, ['聊天线'])
  const r = recallByCue(store, '聊天线通了吗')
  assert.equal(r.items[0]?.id, id)
})
