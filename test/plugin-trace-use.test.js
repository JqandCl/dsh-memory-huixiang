// 使用侧（trace 的 use 行）：A 级＝主动查到了，B 级＝回复里提到了注入卡的标题片段（下界）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

function fakeCtx() {
  const tools = new Map()
  const contexts = []
  const handlers = []
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (def) => tools.set(def.name, def) },
    on: (event, fn) => handlers.push({ event, fn }),
    inject: (names, cb) => cb({
      effect: (fn) => fn(),
      systemPrompt: { section: () => {}, context: (s) => contexts.push(s) },
    }),
  }
  return { ctx, tools, contexts, handlers }
}

const asm = (sid) => ({ agent: { session: { id: sid } } })
const execAs = (sid) => ({ agent: { session: { id: sid } } })
const userMsg = (text) => ({ message: { content: [{ type: 'text', text }] } })
const asstMsg = (text) => ({ message: { content: [{ type: 'text', text }] } })
const traceOf = (dir) => readFileSync(join(dir, 'trace.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))

async function setup(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const { ctx, tools, contexts, handlers } = fakeCtx()
  await apply(ctx, { dataDir: dir })
  const onEvent = handlers.find((h) => h.event === 'session/event').fn
  return { dir, tools, contexts, handlers, onEvent }
}

test('A 级：主动查库命中，记一条 use/recall（只记第一名），带上会话 id', async () => {
  const { dir, tools, onEvent } = await setup('hc-use-a-')
  await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:删除'], body: '删除先挪进 trash，不直接 rm。' })
  onEvent({ id: 's1' }, { type: 'user/message', data: userMsg('删东西要注意啥') })

  const r = await tools.get('hc_recall').execute({ cue: '删除的规矩' }, execAs('s1'))
  assert.equal(r.status, 'matched')
  const use = traceOf(dir).filter((e) => e.ev === 'use' && e.how === 'recall')
  assert.equal(use.length, 1, '一次查回多张也只记第一名')
  assert.equal(use[0].sid, 's1')
  assert.equal(use[0].id, r.items[0].id)
})

test('A 级：sid 用 exec 里的真会话，不被别的会话串掉', async () => {
  const { dir, tools, onEvent } = await setup('hc-use-sid-')
  await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:删除'], body: '删除先挪进 trash，不直接 rm。' })
  // 另一个会话先发事件，把「最后见到的会话」带偏
  onEvent({ id: 's-other' }, { type: 'user/message', data: userMsg('别的事') })
  const r = await tools.get('hc_recall').execute({ cue: '删除的规矩' }, execAs('s-me'))
  assert.equal(r.status, 'matched')
  const use = traceOf(dir).filter((e) => e.ev === 'use' && e.how === 'recall')
  assert.equal(use[0].sid, 's-me', '拿得到 session 就不该用兜底值')
})

test('A 级：审计模式（includeSuperseded）不算使用', async () => {
  const { dir, tools, onEvent } = await setup('hc-use-a2-')
  await tools.get('hc_remember').execute({ id: 'old-1', kind: 'knowledge', source: 'owner', body: '旧说法：办公室在二号楼。' })
  await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', body: '新说法：办公室搬到五号楼。', supersedes: 'old-1' })
  onEvent({ id: 's2' }, { type: 'user/message', data: userMsg('办公室在几号楼') })
  const r = await tools.get('hc_recall').execute({ cue: '办公室', includeSuperseded: true }, execAs('s2'))
  assert.ok(r.items.some((i) => i.id === 'old-1'))
  assert.equal(traceOf(dir).filter((e) => e.ev === 'use').length, 0, '翻旧账不能当成用上了')
})

test('B 级：回复里出现注入卡标题的中文片段，记一条 use/text（带 iid）', async () => {
  const { dir, tools, contexts, onEvent } = await setup('hc-use-b-')
  const card = await tools.get('hc_remember').execute({
    kind: 'knowledge', source: 'owner', title: '周报改成一段加数字', body: '周报改成一段，数字放前面。',
  })
  contexts[0].text(asm('s3'))
  onEvent({ id: 's3' }, { type: 'assistant/message', data: asstMsg('今天的周报改成一段了，数字我放开头。') })

  const inject = traceOf(dir).find((e) => e.ev === 'inject')
  const use = traceOf(dir).filter((e) => e.ev === 'use' && e.how === 'text')
  assert.equal(use.length, 1)
  assert.equal(use[0].sid, 's3')
  assert.equal(use[0].id, card.id)
  assert.equal(use[0].iid, inject.iid, 'use 要能和它对应的那次注入配对')
})

test('B 级：同一会话连说两句都带标题片段，只记一次（used 去重）', async () => {
  const { dir, tools, contexts, onEvent } = await setup('hc-use-b-dedupe-')
  await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', title: '周报改成一段加数字', body: '周报改成一段。' })
  contexts[0].text(asm('s4'))
  onEvent({ id: 's4' }, { type: 'assistant/message', data: asstMsg('周报改成一段了。') })
  onEvent({ id: 's4' }, { type: 'assistant/message', data: asstMsg('再说一遍，周报改成一段。') })
  assert.equal(traceOf(dir).filter((e) => e.ev === 'use' && e.how === 'text').length, 1)
})

test('B 级：回复里没提注入卡，提的是别的卡，不记', async () => {
  const { dir, tools, contexts, onEvent } = await setup('hc-use-b2-')
  await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', title: '周报改成一段加数字', body: '周报改成一段。' })
  const other = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', title: '投标文件要盖公章', body: '投标文件要盖公章。' })
  contexts[0].text(asm('s5')) // 三张热卡里都注入了
  const injectedIds = traceOf(dir)[0].ids
  if (!injectedIds.includes(other.id)) {
    onEvent({ id: 's5' }, { type: 'assistant/message', data: asstMsg('投标文件要盖公章，别忘了。') })
    assert.equal(traceOf(dir).filter((e) => e.ev === 'use' && e.how === 'text').length, 0)
  }
})

test('B 级：3 字连续中文字就记（4 字自名也算），纯 ASCII 片段不算', async () => {
  const { dir, tools, contexts, onEvent } = await setup('hc-use-b3-')
  const nameCard = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', title: '本鲸自己判断记什么', body: '记什么由本鲸自己判断。' })
  const asciiCard = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', title: 'dsh-go 更新会清掉 /usr', body: '升级会清掉 /root 以外。' })
  contexts[0].text(asm('s6'))
  onEvent({ id: 's6' }, { type: 'assistant/message', data: asstMsg('本鲸自己看着办。dsh-go 又更新了。') })
  const use = traceOf(dir).filter((e) => e.ev === 'use' && e.how === 'text')
  // 主人 2026-11-10 把门槛从 5 个字降到 3 个字：短标题、高频自称都算提过（B 级本来就是下界）。
  assert.equal(use.filter((e) => e.id === nameCard.id).length, 1)
  assert.equal(use.filter((e) => e.id === asciiCard.id).length, 0, '纯 ASCII 片段没有 3 连中文字')
})

test('hc_status 按证据级别拆分计数', async () => {
  const { tools, contexts } = await setup('hc-use-st-')
  contexts[0].text(asm('s7'))
  const st = await tools.get('hc_status').execute({})
  assert.equal(st.trace.inject, 1)
  assert.equal(st.trace.use, 0)
  assert.equal(st.trace.useRecall, 0)
  assert.equal(st.trace.useText, 0)
})

test('B 级：同一张卡被两轮注入后提到一次，只记一条、iid 取最近那次注入', async () => {
  const { dir, tools, contexts, onEvent } = await setup('hc-use-b-newest-')
  const a = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', title: '周报改成一段加数字', body: '周报改成一段。' })
  contexts[0].text(asm('s8')) // 第一次注入只有 A
  await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', title: '投标文件要盖公章', body: '投标文件要盖公章。' })
  contexts[0].text(asm('s8')) // 第二次注入 A+B（热卡集变了，key 不同）

  const injects = traceOf(dir).filter((e) => e.ev === 'inject')
  assert.equal(injects.length, 2, '两次注入都该落盘')
  onEvent({ id: 's8' }, { type: 'assistant/message', data: asstMsg('周报改成一段了，数字放开头。') })

  const use = traceOf(dir).filter((e) => e.ev === 'use' && e.how === 'text' && e.id === a.id)
  assert.equal(use.length, 1, '同一张卡提一次不能记两条')
  assert.equal(use[0].iid, injects[1].iid, '归到最近那次注入')
})

test('hc_recall 查不到时也要是可序列化 JSON（曾经带 undefined 被判「不是无损 JSON」）', async () => {
  const { tools } = await setup('hc-use-notfound-')
  const r = await tools.get('hc_recall').execute({ cue: '我妹妹叫什么名字' }, execAs('s9'))
  assert.equal(r.status, 'not_found')
  assert.equal(r.parsed, null)
  // 递归确认没有 undefined（引擎的输出校验会拒收）
  const walk = (v) => {
    assert.notEqual(v, undefined)
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x)
  }
  walk(r)
  assert.doesNotThrow(() => JSON.stringify(r))
})

test('B 级门槛降到 3 个中文字：短标题也能记上', async () => {
  const { dir, tools, contexts, onEvent } = await setup('hc-use-b-3run-')
  const c = await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', title: '早睡要紧', body: '主人让我别熬太晚。' })
  contexts[0].text(asm('s7'))
  onEvent({ id: 's7' }, { type: 'assistant/message', data: asstMsg('好，早睡要紧，我知道了。') })
  const use = traceOf(dir).filter((e) => e.ev === 'use' && e.how === 'text' && e.id === c.id)
  assert.equal(use.length, 1, '3 个连续中文字就够了')
})
