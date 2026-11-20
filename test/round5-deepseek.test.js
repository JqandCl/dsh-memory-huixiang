// 第五轮（2026-11-21，DeepSeek 报告）：非法日期不滚动 / 截断不切代理对 / 梦游的坏时间戳与写盘失败 / 自我笔记条数 clamp / 历史版本同毫秒。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expiryMs } from '../lib/heat.js'
import { parseCue } from '../lib/parse.js'
import { safeCut, renderSnapshot } from '../lib/prompt.js'
import { isDead } from '../lib/recall.js'
import { dreamPass } from '../lib/dream.js'
import { HippocampusStore } from '../lib/store.js'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hc-r5-'))
  const store = new HippocampusStore(dir)
  store.ensure()
  return { store, dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('#15 非法日期 valid_until 不往后滚（2 月 30 日不能算成 3 月 2 日）', () => {
  assert.equal(expiryMs('2026-02-30'), 0)
  assert.equal(expiryMs('2026-04-31'), 0)
  // 合法日期照旧：那天 23:59:59.999 结束
  const ok = new Date(2026, 0, 31, 23, 59, 59, 999).getTime()
  assert.equal(expiryMs('2026-01-31'), ok)
})

test('#31 线索里的非法日期不产生时间窗（问 2 月 30 日不该搜到 3 月 2 日）', () => {
  const r = parseCue('2月30日那天做了什么', Date.now())
  assert.equal(r.when, '')
  assert.equal(r.since, null)
  // 合法日期仍然能解析
  const ok = parseCue('1月31日那天做了什么', Date.now())
  assert.equal(ok.when, '1月31日')
})

test('#35 截断不切坏 emoji 代理对', () => {
  const s = 'abc😀def'
  // 😀 占 2 个 code unit：切在 4 就是半个代理对，必须退一位
  assert.equal(safeCut(s, 4), 'abc')
  assert.equal(safeCut(s, 5), 'abc😀')
  assert.equal(safeCut('short', 99), 'short')
  assert.equal(safeCut('', 10), '')
})

// 注：旧式 now - Date.parse <= 对坏 created 得 NaN 也是 false，行为本来就对；这条是回归保护，不是修复验证（2026-11-21 只读复核实测旧码同样绿）。
test('#40 created 坏掉的卡不进归纳池，也不拖垮其它卡', () => {
  const { store, done } = tempStore()
  try {
    const ts = Date.now()
    store.put({ id: 'bad-created', kind: 'experience', title: '坏时间', body: '这条卡的时间戳是坏的，不该被归纳进来。', created: 'not-a-date', last_hit: ts })
    store.put({ id: 'good-created', kind: 'experience', title: '好时间', body: '这条卡时间正常，应该能进归纳池一起整理。', created: new Date(ts).toISOString(), last_hit: ts })
    const r = dreamPass(store, { now: ts, lookbackDays: 14, dryRun: false })
    const all = store.all().filter((c) => c.kind === 'insight')
    const used = all.flatMap((c) => c.sourceIds || [])
    assert.ok(!used.includes('bad-created'), '坏时间戳的卡不该被归纳')
  } finally { done() }
})

test('#38 落盘失败时进 skipped，不让整次做梦失败', () => {
  const { store, done } = tempStore()
  try {
    const ts = Date.now()
    const created = new Date(ts).toISOString()
    for (const i of [1, 2, 3, 4]) {
      store.put({ id: `flaky-${i}`, kind: 'experience', title: `写盘失败${i}`, body: `同一个小主题攒下的第 ${i} 件事：今天把这一阵攒下来的笔记重新翻了一遍，发现有几处说法前后不太一样，先把它们记下来，等以后有更多线索再回来核对。`, tags: ['ws:flaky'], created, last_hit: ts })
    }
    const origin = store.put.bind(store)
    store.put = (card) => { if (String(card.id).startsWith('ins-')) throw new Error('disk full'); return origin(card) }
    const r = dreamPass(store, { now: ts, lookbackDays: 14, dryRun: false })
    assert.equal(r.wrote, 0)
    assert.ok(r.skipped.some((s) => String(s.reason || '').includes('disk full')), '写盘失败要进 skipped 并带原因')
  } finally { done() }
})

// 注：两次调用很难真落在同一毫秒，这条挡的是「文件名加了随机尾巴后不许反向退化」，旧码连跑 5 次也绿；同毫秒真撞的概率约 1/46656，属可接受残余（2026-11-21 只读复核）。
test('#26 同一毫秒存两次历史，两份都要留下（后一份不能覆盖前一份）', () => {
  const { store, done } = tempStore()
  try {
    const ts = Date.now()
    const base = { id: 'hist-same-ms', kind: 'experience', title: '同一毫秒', body: '第一版', created: new Date(ts).toISOString(), last_hit: ts }
    store.put(base)
    const a = store.get('hist-same-ms')
    store.saveHistory(a)
    const b = { ...a, body: '第二版' }
    store.saveHistory(b)
    const files = readdirSync(join(store.dir, 'history', 'hist-same-ms')).filter((f) => f.endsWith('.md'))
    assert.ok(files.length >= 2, '同毫秒两次历史应各留一份，实际 ' + files.length)
  } finally { done() }
})
test('#15 非法日期不算过期：isDead 放行、注入也不许标「已过期」（两处口径要一致）', () => {
  const { store, done } = tempStore()
  try {
    const ts = Date.now()
    store.put({ id: 'bad-date', kind: 'experience', title: '日期写错的卡', body: '这张卡的 valid_until 写成了不存在的日子，按既有约定当作没写有效期。', valid_until: '2026-02-30', created: new Date(ts).toISOString(), last_hit: ts })
    const card = store.get('bad-date')
    assert.equal(isDead(card, ts), false, '日期读不懂按「无有效期」处理（lib/recall.js:132 的既有约定）')
    const out = renderSnapshot({ store, hot: [card], now: ts })
    assert.ok(!out.includes('已过期'), '既然 isDead 放行，注入里就不能同时写「已过期」')
  } finally { done() }
})
