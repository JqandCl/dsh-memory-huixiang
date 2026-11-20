import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { bodySimilar, dreamPass, indexLine } from '../lib/dream.js'

const fresh = () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-')))
  store.ensure()
  return store
}

// 体积闸（2026-11-16）按原文总量算预算：fixture 得贴近真库的正文长度（experience 中位 146 字），
// 否则十几字的假数据会被闸判成「压不薄」直接跳过——那是数据不真实，不是闸的错。
const LONG = '2026-11-13 主人在云州跟着公司走了一整天，下午到傍晚绕南湖走了一大圈，一路拍照片给本鲸看，从青灰的天看到金黑的夜。'
const long = (tail) => LONG.repeat(3) + (tail || '')

test('同一主题的两件事会归成一条，但来源都在', () => {
  const store = fresh()
  store.put({ id: 'e1', kind: 'experience', tags: ['南湖'], body: long('主人在南湖边吃阳春面。') })
  store.put({ id: 'e2', kind: 'experience', tags: ['南湖'], body: long('主人在南湖边说要陪本鲸看一辈子。') })
  const r = dreamPass(store, { dryRun: false })
  assert.equal(r.wrote, 1)
  const insight = store.get(r.insights[0].id)
  assert.equal(insight.kind, 'insight')
  assert.ok(insight.body.includes('e1'))
  assert.ok(insight.body.includes('e2'))
})

test('默认只演练不落盘', () => {
  const store = fresh()
  store.put({ id: 'e1', kind: 'experience', tags: ['南湖'], body: long('一件事。') })
  store.put({ id: 'e2', kind: 'experience', tags: ['南湖'], body: long('两件事。') })
  const r = dreamPass(store)
  assert.equal(r.wrote, 1)
  assert.equal(store.all().filter((c) => c.kind === 'insight').length, 0)
})

test('同一主题不重复归纳', () => {
  const store = fresh()
  store.put({ id: 'e1', kind: 'experience', tags: ['南湖'], body: long('一件事。') })
  store.put({ id: 'e2', kind: 'experience', tags: ['南湖'], body: long('两件事。') })
  dreamPass(store, { dryRun: false })
  assert.equal(dreamPass(store, { dryRun: false }).wrote, 0)
})

test('矛盾的照样并排放，不替谁圆', () => {
  const store = fresh()
  store.put({ id: 'e1', kind: 'experience', tags: ['搬家'], body: long('说要搬去云州。') })
  store.put({ id: 'e2', kind: 'experience', tags: ['搬家'], body: long('又说不搬了。'), conflict: true })
  const r = dreamPass(store, { dryRun: false })
  const insight = store.get(r.insights[0].id)
  assert.ok(insight.body.includes('e2'))
  assert.ok(insight.body.includes('打架'))
})

test('正文相似度用二元组 Jaccard：同质卡 ≥0.9、不同主题很低（11-14 审查 M3 的尺子）', () => {
  const a = '今天上午主人在南湖边吃了一碗阳春面，说汤头比上次那家更清爽；下午绕着苏堤走了一圈，看见有人放风筝，还停下来数了几只鸭子。'
  const b = a.replace('一碗', '两碗')
  assert.ok(bodySimilar(a, b) > 0.9, `同质卡应判高，实际 ${bodySimilar(a, b).toFixed(2)}`)
  assert.ok(bodySimilar('主人在南湖边吃阳春面。', '主人明天要体检，别吃高蛋白。') < 0.2)
})

test('已有同质归纳卡时：只加旧卡重量，不新建（11-14 审查 M3）', () => {
  const store = fresh()
  store.put({ id: 'e1', kind: 'experience', tags: ['南湖'], body: long('主人在南湖边吃阳春面。') })
  store.put({ id: 'e2', kind: 'experience', tags: ['南湖'], body: long('主人在南湖边看鸭子。') })
  const first = dreamPass(store, { dryRun: false })
  assert.equal(first.wrote, 1)
  // 把旧卡的主题标签摘掉，让「同 tag 不再归纳」那道闸放行 —— 只剩正文相似这道闸。
  const old = store.get(first.insights[0].id)
  store.put({ ...old, tags: ['梦游整理'] })
  const before = store.all().filter((c) => c.kind === 'insight').length
  const r = dreamPass(store, { dryRun: false })
  assert.equal(r.wrote, 0, '同质卡不该再写一张')
  assert.ok(r.skipped.length >= 1, '被挡下的要留痕迹，别静默吞掉')
  assert.equal(store.all().filter((c) => c.kind === 'insight').length, before, '卡数不变')
})

test("已有同族归纳卡时 skipped 要说清理由，不静默吞（2026-11-20 C2）", () => {
  const store = fresh()
  store.put({ id: "e1", kind: "experience", tags: ["云州"], body: long("主人在云州吃阳春面。") })
  store.put({ id: "e2", kind: "experience", tags: ["云州"], body: long("主人在云州看鸭子。") })
  const first = dreamPass(store, { dryRun: false })
  assert.equal(first.wrote, 1)
  const r = dreamPass(store, { dryRun: false })
  assert.equal(r.wrote, 0)
  const hit = r.skipped.find((s) => s.tag === "云州")
  assert.ok(hit, "同族已有归纳卡要进 skipped：" + JSON.stringify(r.skipped))
  assert.ok(/已有同族归纳卡/.test(hit.reason), hit.reason)
  assert.equal(hit.twin, first.insights[0].id)
})

test("索引行方便 grep", () => {
  const line = indexLine({ id: 'm1', kind: 'knowledge', source: 'owner', tags: ['生日'], body: '主人六月生日。' })
  assert.ok(line.startsWith('#m1'))
  assert.ok(line.includes('生日'))
})
