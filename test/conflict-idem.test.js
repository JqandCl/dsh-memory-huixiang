// 2026-11-20 复核补（QQ 分身挑出）：conflict:true 原来整个排除在幂等外——
// 标矛盾恰恰最容易超时重发，重发一次就多一张卡。改成也进幂等，但命中时不加权重。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { HippocampusStore } from '../lib/store.js'

function fakeCtx() {
  const tools = new Map()
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (def) => tools.set(def.name, def) },
    on: () => {},
    inject: (names, cb) => cb({ effect: (fn) => fn(), systemPrompt: { section: () => {}, context: () => {} } }),
  }
  return { ctx, tools }
}

async function setup() {
  const { ctx, tools } = fakeCtx()
  const dataDir = mkdtempSync(join(tmpdir(), 'hc-conflict-idem-'))
  await apply(ctx, { dataDir })
  return { tools, store: new HippocampusStore(dataDir), dataDir }
}

const 矛盾 = { kind: 'knowledge', source: 'owner', tags: ['ws:矛盾测'], body: '周四值班。', conflict: true }

test('conflict:true 的同一次重发只落一张卡（幂等命中）', async () => {
  const { tools, store } = await setup()
  const a = await tools.get('hc_remember').execute(矛盾)
  const b = await tools.get('hc_remember').execute(矛盾)
  assert.equal(b.dedupe, true, '同一次冲突写入的重试要走幂等')
  assert.equal(b.id, a.id, '重试返回同一张卡')
  assert.equal(store.all().length, 1, '库里不该多出第二张')
  assert.equal(store.get(a.id).conflict, true, '冲突标记要留着')
})

test('conflict:true 幂等命中不加权重（矛盾不该因重试变重）', async () => {
  const { tools, store } = await setup()
  const a = await tools.get('hc_remember').execute(矛盾)
  const before = store.get(a.id).weight
  const b = await tools.get('hc_remember').execute(矛盾)
  assert.equal(b.dedupe, true)
  assert.equal(store.get(a.id).weight, before, '权重不该变')
  assert.match(b.note, /没新建、也没加权重/)
})

test('不同内容的冲突照落新卡（幂等只认同一份入参）', async () => {
  const { tools, store } = await setup()
  const a = await tools.get('hc_remember').execute(矛盾)
  const b = await tools.get('hc_remember').execute({ ...矛盾, body: '周五值班。' })
  assert.notEqual(b.dedupe, true, '换了正文就不该命中幂等')
  assert.notEqual(b.id, a.id)
  assert.equal(store.all().length, 2, '两种说法并排放')
})

test('ops.jsonl 超 2000 行自动滚到末 1000 行', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hc-ops-roll-'))
  const opsPath = join(dataDir, 'ops.jsonl')
  const fake = Array.from({ length: 2500 }, (_, i) => JSON.stringify({ at: new Date().toISOString(), op: 'create', id: 'old-' + i }))
  writeFileSync(opsPath, fake.join('\n') + '\n')
  const { ctx, tools } = fakeCtx()
  await apply(ctx, { dataDir })
  await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:滚动'], body: '滚动测试。' })
  const lines = readFileSync(opsPath, 'utf8').split('\n').filter(Boolean)
  assert.ok(lines.length <= 1010, '应当滚到 1000 行 + 新写的那条，实际 ' + lines.length)
  assert.ok(lines.length >= 990, '不许滚得比保留量还少，实际 ' + lines.length)
  assert.equal(JSON.parse(lines[lines.length - 1]).op, 'create', '最新那条要留着')
  assert.ok(lines.some((l) => l.includes('old-2499')), '最近的老记录要留着')
})

test('ops.jsonl 记 create + idem_hit 各一条', async () => {
  const { tools, dataDir } = await setup()
  await tools.get('hc_remember').execute(矛盾)
  await tools.get('hc_remember').execute(矛盾)
  const opsPath = join(dataDir, 'ops.jsonl')
  assert.ok(existsSync(opsPath), 'ops.jsonl 应当存在')
  const ops = readFileSync(opsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(ops.filter((o) => o.op === 'create').length, 1)
  assert.equal(ops.filter((o) => o.op === 'idem_hit').length, 1)
})
