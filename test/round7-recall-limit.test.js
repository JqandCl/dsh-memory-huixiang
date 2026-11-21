// 第七轮（2026-11-21）：hc_recall 默认条数 3 → 5，并把「候选总数」暴露给调用方。
// 依据：LongMemEval 全量 500 题实测，top3→top6 让 4~6 段会话的题从 10/33 涨到 21/33，
// 总分 80.8% → 83.0%，逼近「把原文全给」的上限 83.8%。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { recallByCue } from '../lib/recall.js'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hc-r7-'))
  const store = new HippocampusStore(dir)
  store.ensure()
  return { store, dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function fill(store, n) {
  for (let i = 0; i < n; i += 1) {
    store.put({
      id: 'whale' + i,
      title: '鲸鱼观察笔记 ' + (i + 1),
      body: '今天在码头看到鲸鱼跃出水面，记录编号 ' + i + '，海面很静。',
      tags: ['global:测试'],
      source: 'self',
      source_type: 'experience',
    })
  }
}

test('候选总数 >= 返回条数，且被 limit 截断时能看出来', () => {
  const { store, done } = tempStore()
  try {
    fill(store, 8)
    const few = recallByCue(store, '鲸鱼 码头', { limit: 2 })
    assert.ok(few.items.length <= 2)
    assert.equal(typeof few.候选总数, 'number')
    assert.ok(few.候选总数 >= few.items.length, '候选总数不能小于实际给出的条数')
    assert.ok(few.候选总数 > few.items.length, '限 2 条时应当能看出还有更多候选')
    const many = recallByCue(store, '鲸鱼 码头', { limit: 8 })
    assert.ok(many.items.length > few.items.length, 'limit 放大后应给出更多条')
  } finally {
    done()
  }
})

test('hc_recall 的默认条数是 5（改默认值时要同步改这条）', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(src, /Math\.trunc\(Number\(args\.limit\) \|\| 5\)/)
  // 工具描述里也写明默认 5，别让模型以为还是 3。
  assert.match(src, /最多几条，默认 5/)
})
