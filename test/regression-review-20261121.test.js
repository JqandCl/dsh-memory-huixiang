// 回响 fbdd216 · bug 回归测试（TDD RED 阶段）
// 用法：把本文件放进仓库 test/ 目录，跑：
//   TZ=Asia/Shanghai node --test test/回响-bug回归测试.test.js
// 预期：当前版本 10 条全红，每条失败信息里写了对应 bug 的位置。
// 修一个 bug → 对应一条转绿；全绿即 10 个 bug 全部修复且无回归。
// 零第三方依赖，node:test + node:assert，Node 22+。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { injectionBriefs } from '../lib/recall.js'
import { dreamPass } from '../lib/dream.js'
import { maybeDream } from '../lib/autodream.js'
import { appendStream } from '../lib/stream.js'
import { apply } from '../index.js'

const tmpStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hx-reg-'))
  const store = new HippocampusStore(dir)
  store.ensure()
  return { dir, store }
}

// 用最小桩 ctx 启动真实插件，拿到真实工具的 execute（不 mock 业务逻辑）
async function bootPlugin(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hx-boot-'))
  const defs = new Map()
  const ctx = {
    effect: (fn) => { fn() },
    on: () => {},
    inject: () => {},
    tools: { register: (d) => defs.set(d.name, d) },
  }
  await apply(ctx, { dataDir: dir, autoDream: { enabled: false }, ...config })
  return { dir, call: (name, args, exec) => defs.get(name).execute(args, exec) }
}

test('B1 frontmatter注入：title带换行不得伪造 superseded_by（store.js renderCard L193）', () => {
  const { store } = tmpStore()
  store.put({
    id: 't1', kind: 'knowledge', source: 'self', tags: ['x'],
    title: '正常标题\nsuperseded_by: hacked', body: '正文',
    weight: 1, last_hit: Date.now(), last_write: Date.now(),
  })
  const back = store.get('t1')
  assert.ok(!back.superseded_by,
    `title 内嵌换行伪造了 superseded_by="${back.superseded_by}"，卡被静默判死。期望：换行被转义或拒绝`)
})

test('B2 梦游不得把已被接替的旧卡归进活 insight（dream.js L104 缺 isDead 过滤）', () => {
  const { store } = tmpStore()
  const now = Date.now()
  const long = '主人说周四去体检，早上空腹，记得带身份证，医院在城西那家，打车大概二十分钟，费用预计三百元左右，报告三天后出，前一天晚上十点以后不要吃东西，水也尽量少喝，穿宽松的衣服方便检查，抽血的窗口在二楼东侧，B超要憋尿，心电图在三楼，全部做完大约需要一个上午，结束后可以吃早饭。'
  for (const [id, extra] of [['old1', ''], ['old2', '另外要提前预约。']]) {
    store.put({
      id, kind: 'experience', source: 'owner', tags: ['体检'], title: `体检${id}`,
      body: long + extra, weight: 1, last_hit: now, last_write: now,
      superseded_by: 'new1', valid_until: '2026-11-20',
    })
  }
  const r = dreamPass(store, { dryRun: false, now })
  assert.equal(r.wrote, 0,
    `已被接替的旧说法被归进活 insight（${JSON.stringify(r.insights)}），绕过全部死卡闸门。期望：死卡不参与归纳`)
})

test('B3 ids召回：valid_until=今天的卡本地中午不得判过期（index.js L545 应用 expiryMs）', async (t) => {
  // 固定在本地（UTC+8）2026-11-21 中午12点，复刻 11-09 修过的「值班卡中午被判死」
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-21T12:00:00+08:00').getTime() })
  const { dir, call } = await bootPlugin()
  const store = new HippocampusStore(dir)
  store.put({
    id: 't3', kind: 'knowledge', source: 'owner', tags: ['值班'], title: '今天值班',
    body: '今天轮到主人值班。', weight: 1, last_hit: Date.now(), last_write: Date.now(),
    valid_until: '2026-11-21',
  })
  const r = await call('hc_recall', { ids: ['t3'] })
  assert.equal(r.status, 'matched')
  assert.ok(!r.items[0].expired,
    'valid_until=今天，本地中午就被 ids 分支判过期（Date.parse 把纯日期当 UTC 零点）。期望：与 cue 路径 isDead/expiryMs 同口径，当天过完才算过期')
})

test('B4 remove必须校验id：不得挪动 notes 目录外的文件（store.js L423）', () => {
  const { dir, store } = tmpStore()
  const outside = join(dir, 'secret.md')
  writeFileSync(outside, 'private')
  try { store.remove('../secret') } catch { /* 抛错也算正确的拒绝方式 */ }
  assert.ok(existsSync(outside),
    'remove("../secret") 把库外文件挪进了 trash。期望：与 get/put 一样做 isSafeId 校验')
})

test('B5 便签应按「最久没被想起」排序（recall.js L680 Date.parse 数字时间戳恒 NaN）', () => {
  const { store } = tmpStore()
  const now = Date.now()
  store.put({ id: 'hotA', kind: 'knowledge', source: 'self', tags: [], title: 'A刚想起', body: 'a', weight: 3, last_hit: now, last_write: now })
  store.put({ id: 'oldB', kind: 'knowledge', source: 'self', tags: [], title: 'B很久没想起', body: 'b', weight: 1, last_hit: now - 60 * 86400000, last_write: now })
  const { briefs } = injectionBriefs(store, { now, limit: 2 })
  assert.equal(briefs[0].id, 'oldB',
    `便签顺序为 ${briefs.map((c) => c.id).join('→')}，last_hit 是毫秒数字，Date.parse 后恒 NaN，排序退化成纯重量序。期望：Number(c.last_hit)`)
})

test('B6 删 stream.jsonl 后自动做梦应重置水位（autodream.js L21-23）', () => {
  const { dir, store } = tmpStore()
  for (let i = 0; i < 25; i++) appendStream(store, { role: 'owner', text: `第${i}句话，聊了些日常` })
  const r1 = maybeDream(store, { everyLines: 20, cooldownMs: 0 })
  assert.equal(r1.ran, true, '前置条件：第一次应正常做梦')
  writeFileSync(join(dir, 'stream.jsonl'), '') // README L182 官方建议的隐私操作
  for (let i = 0; i < 30; i++) appendStream(store, { role: 'owner', text: `删除后新攒的第${i}句` })
  const r2 = maybeDream(store, { everyLines: 20, cooldownMs: 0 })
  assert.equal(r2.ran, true,
    `删流水后新攒30行（≥阈值20）却 ran=false（fresh=${r2.fresh}），旧水位没重置，自动做梦停摆。期望：total < last 时基线归零`)
})

test('B7 工具层应接受归纳卡的中文id续写（index.js L216 与 store.js L28 白名单不一致）', async () => {
  const { call } = await bootPlugin()
  const r = await call('hc_remember', { body: '归纳内容更新', id: 'ins-体检-abc123' })
  assert.equal(r.ok, true,
    `store 层允许 Unicode id（dream 自动生成 ins-体检-xxx），工具层却拒绝：${r.error}。期望：复用 isSafeId`)
})

test('B8 config.heat非法值应回退默认：halfLifeDays=0不得让新卡秒冷（index.js L115）', async () => {
  const { call } = await bootPlugin({ heat: { halfLifeDays: 0 } })
  const w = await call('hc_remember', { body: '主人没有养猫。', title: '养宠情况', source: 'owner' })
  assert.equal(w.ok, true)
  const st = await call('hc_status', {})
  assert.equal(st.tiers.cold, 0,
    `halfLifeDays=0 未校验，刚写的卡 live_weight 变 NaN/0 直接进冷库（tiers=${JSON.stringify(st.tiers)}）。期望：非正有限数回退默认 21`)
})

test('B9 hc_recall limit传非数字不得把命中吞成空（index.js L594）', async () => {
  const { call } = await bootPlugin()
  await call('hc_remember', { body: '猫咪喜欢晒太阳，每天午后在窗台睡觉。', title: '猫', source: 'owner' })
  const r = await call('hc_recall', { cue: '猫', limit: 'abc' })
  assert.equal(r.status, 'matched',
    `limit="abc" → Math.trunc 得 NaN → slice(0,NaN)=[] → 有命中却报 not_found。期望：与 hc_evidence 同款 Number()||3`)
})

test('B10 多说法召回：出口实体闸应核实际命中那句（index.js L650）', async () => {
  const { call } = await bootPlugin()
  await call('hc_remember', { body: '猫咪喜欢晒太阳，每天午后在窗台睡觉。', title: '猫', source: 'owner' })
  const r = await call('hc_recall', { cues: ['我的车牌号是多少', '猫'] })
  assert.equal(r.status, 'matched',
    `头名卡由「猫」捞到，闸却拿 cues[0]「车牌号」去核 → 误弃权（reason=${r.reason}）。期望：用 picked[0].cue`)
})
