// hc_recall 的 cues：一次给几种说法，命中任一种就算捞到（换说法救不回的补充手段）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

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
  await apply(ctx, { dataDir: mkdtempSync(join(tmpdir(), 'hc-cues-')) })
  await tools.get('hc_remember').execute({
    kind: 'knowledge', source: 'owner', tags: ['ws:忌口'], body: '主人不能吃高蛋白、高油脂，也不吃肥肉。',
  })
  return tools
}

test('单个 cue 捞不到，靠 cues 里的另一种说法捞到', async () => {
  const tools = await setup()
  const bad = await tools.get('hc_recall').execute({ cue: 'qqqzzz 无关的' })
  assert.equal(bad.status, 'not_found')

  const hit = await tools.get('hc_recall').execute({ cue: 'qqqzzz 无关的', cues: ['肥肉'] })
  assert.equal(hit.status, 'matched')
  assert.ok(hit.items.some((i) => i.title.includes('忌口') || (i.excerpt || '').includes('肥肉')))
})

test('多路命中同一张卡只出一条，且按最高分排、tried 去重', async () => {
  const tools = await setup()
  // 再加一张同时被两路命中的卡：分数更高，应排第一
  await tools.get('hc_remember').execute({
    kind: 'knowledge', source: 'owner', tags: ['肥肉', '高油脂'], body: '肥肉和高油脂都别给主人。',
  })
  const r = await tools.get('hc_recall').execute({ cue: '肥肉', cues: ['高油脂', '肥肉'] })
  const ids = r.items.map((i) => i.id)
  assert.equal(new Set(ids).size, ids.length, '同一张卡不能出现两次')
  const top = r.items[0]
  assert.ok(top.tagHit >= 2 || top.score >= (r.items[1]?.score ?? 0), '第一名应是两路都命中的那张')
  assert.deepEqual(r.tried, ['肥肉', '高油脂'], 'tried 要如实回报试过哪些说法，且不重复')
})

test('status：有结果但没有一路 matched，只能是 ambiguous，不能报 matched', async () => {
  const tools = await setup()
  // 两张只靠同名标签命中的卡（分低、彼此接近）⇒ 单独查就是 ambiguous
  await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:临海'], body: '甲说法。' })
  await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', tags: ['ws:临海'], body: '乙说法。' })
  const alone = await tools.get('hc_recall').execute({ cue: '临海' })
  assert.equal(alone.status, 'ambiguous', '两张同分卡要先构出 ambiguous 场景')
  // 搭一个完全无关的 cue：真实行为不变，不能被错报成 matched（也不能因此给卡加权）
  const mixed = await tools.get('hc_recall').execute({ cue: '临海', cues: ['qqqzzz 完全没关系的'] })
  assert.equal(mixed.status, 'ambiguous', '[ambiguous, not_found] 混合时必须仍是 ambiguous')
  assert.match(mixed.reason, /补一句/, '含糊时要提示补线索')
})

test('cues 不是数组就直接报错，别假装查了', async () => {
  const tools = await setup()
  const r = await tools.get('hc_recall').execute({ cue: '', cues: '肥肉' })
  assert.equal(r.ok, false)
  assert.match(r.error, /cues/)
})

test('cues 也照 includeSuperseded 走：默认翻不到死卡，审计能翻到', async () => {
  const tools = await setup()
  await tools.get('hc_remember').execute({ id: 'old-1', kind: 'knowledge', source: 'owner', body: '旧说法：办公室在二号楼。' })
  await tools.get('hc_remember').execute({ kind: 'knowledge', source: 'owner', body: '新说法：办公室搬到五号楼。', supersedes: 'old-1' })

  const plain = await tools.get('hc_recall').execute({ cue: '办公室', cues: ['在几号楼'] })
  assert.equal(plain.items.some((i) => i.id === 'old-1'), false)

  const audit = await tools.get('hc_recall').execute({ cue: '办公室', cues: ['在几号楼'], includeSuperseded: true })
  assert.equal(audit.items.some((i) => i.id === 'old-1'), true)
  assert.match(audit.reason, /审计/, '审计翻到死卡要在 reason 里提醒别当现行说法')
})
