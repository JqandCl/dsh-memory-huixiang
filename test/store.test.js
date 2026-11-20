import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'

const fresh = () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-')))
  store.ensure()
  return store
}

test('写一条读一条，frontmatter 能还原', () => {
  const store = fresh()
  store.put({ id: 'm1', kind: 'knowledge', source: 'owner', tags: ['生日', '主人'], title: '生日', body: '主人说他生日在六月。' })
  const card = store.get('m1')
  assert.equal(card.kind, 'knowledge')
  assert.equal(card.source, 'owner')
  assert.deepEqual(card.tags, ['生日', '主人'])
  assert.equal(card.body, '主人说他生日在六月。')
  assert.ok(readFileSync(join(store.notesDir, 'm1.md'), 'utf8').startsWith('---'))
})

test('续写同一 id 不会丢 created', () => {
  const store = fresh()
  const first = store.put({ id: 'm1', body: '旧正文' })
  store.put({ id: 'm1', body: '新正文', weight: 2 })
  const card = store.get('m1')
  assert.equal(card.body, '新正文')
  assert.equal(card.weight, 2)
  assert.equal(card.created, first.created)
})

test('因果链只留末尾 N 行', () => {
  const store = fresh()
  for (let i = 0; i < 30; i += 1) store.appendChain(i % 2 ? 'self' : 'owner', `第 ${i} 句`)
  assert.equal(store.chainSize(), 30)
  const tail = store.chainTail(5)
  assert.equal(tail.length, 5)
  assert.ok(tail.at(-1).includes('第 29 句'))
  assert.ok(tail.at(-1).includes('本鲸:'))
})

test('自我笔记封顶 40 条，挤掉最旧的', () => {
  const store = fresh()
  for (let i = 0; i < 45; i += 1) store.addSelfNote(`笔记 ${i}`)
  const notes = store.selfNotes()
  assert.equal(notes.length, 40)
  assert.equal(notes[0].text, '笔记 5')
  assert.equal(notes.at(-1).text, '笔记 44')
})

test('人格状态变更留史，底色不覆盖', () => {
  const store = fresh()
  store.setPersona({ base: '小助手', state: '刚被装上记忆' })
  store.setPersona({ state: '正在写插件', note: '主人让做的' })
  const p = store.persona()
  assert.equal(p.base, '小助手')
  assert.equal(p.state, '正在写插件')
  assert.equal(p.history.length, 1)
  assert.equal(p.history[0].state, '刚被装上记忆')
})
