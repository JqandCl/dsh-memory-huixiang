// 回响 b05d2f3 · 第二轮复核新发现问题（TDD RED）
// 用法：放进仓库 test/，跑 TZ=Asia/Shanghai node --test test/回响-第二轮新发现问题.test.js
// 预期：当前版本 3 条全红。N1/B6R 是必修；N2 是判据健壮性。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { maybeDream } from '../lib/autodream.js'
import { appendStream } from '../lib/stream.js'
import { apply } from '../index.js'

async function bootPlugin(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hx-r2-'))
  const defs = new Map()
  const ctx = { effect: (fn) => { fn() }, on: () => {}, inject: () => {}, tools: { register: (d) => defs.set(d.name, d) } }
  await apply(ctx, { dataDir: dir, autoDream: { enabled: false }, ...config })
  return { dir, call: (n, a) => defs.get(n).execute(a) }
}

test('N1 B1修复不完整：links 带换行仍能伪造 frontmatter（store.js renderCard links/sourceIds 未过 flat）', async () => {
  const { dir, call } = await bootPlugin()
  const r = await call('hc_remember', {
    body: '正常记忆内容。', title: '正常', source: 'owner',
    links: ['a\nsuperseded_by: hacked'],
  })
  assert.equal(r.ok, true)
  const back = new HippocampusStore(dir).get(r.id)
  assert.ok(!back.superseded_by,
    `links 项内嵌换行伪造了 superseded_by="${back.superseded_by}"，卡被静默判死。flat() 漏了 links 和 sourceIds 两个数组字段`)
})

test('B6R 删流水重建恰逢同毫秒：firstAt>doneAt 漏判，自动做梦还停摆（autodream.js 判据②边界）', async (t) => {
  // 固定时钟： dreaming 与重建后第一行落在同一毫秒（真机快速路径/测试里必然出现，实测 5 次里 1 次）
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-21T12:00:00+08:00').getTime() })
  const dir = mkdtempSync(join(tmpdir(), 'b6r-'))
  const store = new HippocampusStore(dir); store.ensure()
  for (let i = 0; i < 25; i++) appendStream(store, { role: 'owner', text: `第${i}句` })
  const r1 = maybeDream(store, { everyLines: 20, cooldownMs: 0 })
  assert.equal(r1.ran, true, '前置：第一次应做梦')
  writeFileSync(join(dir, 'stream.jsonl'), '')
  for (let i = 0; i < 30; i++) appendStream(store, { role: 'owner', text: `新第${i}句` })
  const r2 = maybeDream(store, { everyLines: 20, cooldownMs: 0 })
  assert.equal(r2.ran, true,
    `firstAt==doneAt（同毫秒）时判据② firstAt>doneAt 不成立、判据① total<last 也不成立 → fresh=${r2.fresh}，停摆。改 >= 或改用首行身份判据`)
})

test('N2 首行时间戳在未来：reset 永久成立，没有新内容也每个冷却期空梦（autodream.js 时间判据不防时钟漂移）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'n2-'))
  const store = new HippocampusStore(dir); store.ensure()
  const now = Date.now()
  appendStream(store, { role: 'owner', text: '改过时钟时写入的第一句', at: now + 86400000 })
  for (let i = 0; i < 24; i++) appendStream(store, { role: 'owner', text: `第${i}句日常` })
  const r1 = maybeDream(store, { everyLines: 20, cooldownMs: 0 }, now)
  assert.equal(r1.ran, true, '前置：第一次应做梦')
  // 此后没有任何新内容，一小时后再问：不该再梦
  const r2 = maybeDream(store, { everyLines: 20, cooldownMs: 0 }, now + 3600000)
  assert.equal(r2.ran, false,
    '首行 at 在未来 → firstAt>doneAt 恒成立 → 水位永久失效，零新增也照梦（实测 6/6），每次白扫全库。建议 dreamState 记首行身份（at+n），不同即重建，不依赖时钟先后')
})
