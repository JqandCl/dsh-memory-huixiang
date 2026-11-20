// 注入流水（trace.jsonl）：记「这一轮进了哪几张卡」，同一轮重复渲染只记一次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

function fakeCtx() {
  const tools = new Map()
  const contexts = []
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (def) => tools.set(def.name, def) },
    on: () => {},
    inject: (names, cb) => cb({
      effect: (fn) => fn(),
      systemPrompt: { section: () => {}, context: (s) => contexts.push(s) },
    }),
  }
  return { ctx, tools, contexts }
}

const asm = (sid) => ({ agent: { session: { id: sid } } })

test('注入时记一行；同一 session 重复渲染只记一次；换 session 再记一行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-trace-'))
  const { ctx, tools, contexts } = fakeCtx()
  await apply(ctx, { dataDir: dir })
  const snap = contexts[0]
  assert.ok(snap?.text, '注入钩子要在')

  snap.text(asm('s1'))
  snap.text(asm('s1'))
  snap.text(asm('s1'))
  snap.text(asm('s2'))

  const lines = readFileSync(join(dir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(lines.length, 2, 's1 只留一条，s2 一条')
  assert.equal(lines[0].ev, 'inject')
  assert.equal(lines[0].sid, 's1')
  assert.ok(Array.isArray(lines[0].ids))
  assert.equal(lines[1].sid, 's2')

  const st = await tools.get('hc_status').execute({})
  assert.equal(st.traceLines, 2, 'hc_status 要报 trace 行数')
})

test('trace 写失败时对话照常：text() 仍返回快照字符串，不抛', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-trace3-'))
  const { ctx, contexts } = fakeCtx()
  await apply(ctx, { dataDir: dir })
  const snap = contexts[0]
  // 把 trace.jsonl 换成同名目录 ⇒ appendFileSync 抛 EISDIR
  const { rmSync, mkdirSync } = await import('node:fs')
  rmSync(join(dir, 'trace.jsonl'))
  mkdirSync(join(dir, 'trace.jsonl'))
  const out = snap.text(asm('s1'))
  assert.equal(typeof out, 'string', '写流水失败不能挡住注入')
  assert.ok(out.length > 0)
  // 失败之后不能被当成「已记过」：修好文件后同一组卡还能补记
  rmSync(join(dir, 'trace.jsonl'), { recursive: true })
  snap.text(asm('s1'))
  const lines = readFileSync(join(dir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1, '写失败那一轮不该把后续也吞掉')
})

test('没有 session id 也不炸，照样记（sid 留空；同一个空桶 20 秒内相同卡集只记一条）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-trace2-'))
  const { ctx, contexts } = fakeCtx()
  await apply(ctx, { dataDir: dir })
  contexts[0].text(undefined)
  const lines = readFileSync(join(dir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].sid, '')
})
