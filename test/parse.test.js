// 整句拆解：谁、什么时候、要最近的、剩下的实词。纯规则，错了一眼看得见。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCue, describeCue } from '../lib/parse.js'
import { recallByCue, shouldRecall } from '../lib/recall.js'
import { HippocampusStore } from '../lib/store.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NOW = Date.parse('2026-11-05T15:00:00+08:00')

test('「昨晚…最后一句」拆出时间、最近、实词', () => {
  const p = parseCue('昨晚南瓜鸡最后一句说的什么', NOW)
  assert.equal(p.when, '昨晚')
  assert.equal(p.wantLatest, true)
  assert.ok(p.keywords.includes('南瓜'))
  assert.ok(p.since < NOW && p.until > p.since)
  assert.ok(describeCue(p).includes('昨晚'))
  assert.ok(describeCue(p).includes('要最近的'))
})

test('点名主人、点名本鲸分得开', () => {
  assert.deepEqual(parseCue('主人昨天说了什么', NOW).who, ['主人'])
  assert.deepEqual(parseCue('本鲸前天说过啥', NOW).who, ['本鲸'])
})

test('具体日期也认', () => {
  const p = parseCue('11月4日说的那句', NOW)
  assert.equal(p.when, '11月4日')
  assert.ok(p.since > NOW - 3 * 86_400_000)
})

test('「生日」这种单个实词也允许翻库（以前会被门槛挡掉）', () => {
  assert.equal(shouldRecall('生日'), true)
  assert.equal(shouldRecall(''), false)
})

test('时间窗能真正帮上忙：说了昨天，就先给昨天的', () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-')))
  store.ensure()
  const now = Date.now()
  store.put({ id: 'old', title: '南瓜鸡', body: '南瓜鸡说它喜欢吃南瓜。', tags: ['南瓜'], created: new Date(now - 10 * 86_400_000).toISOString(), last_hit: now - 10 * 86_400_000 })
  store.put({ id: 'new', title: '南瓜鸡', body: '南瓜鸡昨晚说南瓜要蒸着吃。', tags: ['南瓜'], created: new Date(now - 86_400_000 + 3_600_000).toISOString(), last_hit: now - 86_400_000 + 3_600_000 })
  const r = recallByCue(store, '昨天南瓜最后一句说的什么', { now, limit: 2 })
  assert.equal(r.status, 'matched')
  assert.equal(r.items[0].id, 'new')
  assert.ok(r.拆解.includes('昨天'))
})
