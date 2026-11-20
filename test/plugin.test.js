// 不依赖 DSH 运行时，用一个假 ctx 把 index.js 的接线跑一遍。
// 验的是「注册了什么、注入什么、事件进来会不会写链」，不是 UI。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

function fakeCtx() {
  const tools = new Map()
  const sections = []
  const contexts = []
  const handlers = []
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (def) => tools.set(def.name, def) },
    on: (event, fn) => handlers.push({ event, fn }),
    inject: (names, cb) => {
      assert.deepEqual(names, ['systemPrompt'])
      cb({
        effect: (fn) => fn(),
        systemPrompt: {
          section: (s) => sections.push(s),
          context: (s) => contexts.push(s),
        },
      })
    },
  }
  return { ctx, tools, sections, contexts, handlers }
}

test('装上之后：六个工具、两段提示词、一条事件监听', async () => {
  const { ctx, tools, sections, contexts, handlers } = fakeCtx()
  await apply(ctx, { dataDir: mkdtempSync(join(tmpdir(), 'hc-')) })
  assert.deepEqual([...tools.keys()].sort(), ['hc_dream', 'hc_evidence', 'hc_persona', 'hc_recall', 'hc_remember', 'hc_selfnote', 'hc_status'])
  assert.equal(sections.length, 1)
  assert.equal(contexts.length, 1)
  assert.equal(handlers.length, 1)
  assert.ok(sections[0].text().includes('记忆规矩'))
})

test('工具真的能写、能读回来', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hc-'))
  const { ctx, tools, contexts } = fakeCtx()
  await apply(ctx, { dataDir })
  const wrote = await tools.get('hc_remember').execute({
    body: '主人六月生日。',
    kind: 'knowledge',
    source: 'owner',
    tags: ['生日'],
    title: '主人六月生日',
  })
  assert.equal(wrote.ok, true)
  const recalled = await tools.get('hc_recall').execute({ cue: '还记得我生日吗' })
  assert.equal(recalled.status, 'matched')
  assert.equal(recalled.items[0].id, wrote.id)
  const status = await tools.get('hc_status').execute({})
  assert.equal(status.cards, 1)
  assert.ok(contexts[0].text().includes('六月生日'))
})

test('会话事件进因果链，别人说的话不记', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hc-'))
  const { ctx, handlers } = fakeCtx()
  await apply(ctx, { dataDir })
  const handler = handlers[0].fn
  handler({}, { type: 'user/message', data: { message: { content: [{ type: 'text', text: '鱼，在吗' }] } } })
  handler({}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的在的' }] } } })
  handler({}, { type: 'tool/result', data: { text: '不该进去' } })
  handler({}, { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier ones.' }] } } })
  handler({}, { type: 'user/message', data: { message: { content: [{ type: 'text', text: '<system-reminder>skills…</system-reminder>' }] } } })
  const { HippocampusStore } = await import('../lib/store.js')
  const tail = new HippocampusStore(dataDir).chainTail(10)
  assert.equal(tail.length, 2)
  assert.ok(tail[0].includes('主人: 鱼，在吗'))
  assert.ok(tail[1].includes('本鲸: 在的在的'))
})

test('人格和笔记能改，状态留在历史里', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hc-'))
  const { ctx, tools } = fakeCtx()
  await apply(ctx, { dataDir })
  await tools.get('hc_persona').execute({ base: '小助手', state: '一' })
  await tools.get('hc_persona').execute({ state: '二', note: '换状态' })
  const p = await tools.get('hc_persona').execute({})
  assert.equal(p.base, '小助手')
  assert.equal(p.history.length, 1)
  await tools.get('hc_selfnote').execute({ write: '今天被主人夸了。' })
  const notes = await tools.get('hc_selfnote').execute({ last: 5 })
  assert.equal(notes.count, 1)
})
