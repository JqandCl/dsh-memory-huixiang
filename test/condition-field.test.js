import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { renderSnapshot } from '../lib/prompt.js'

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-cond-'))
  const store = new HippocampusStore(dir)
  store.ensure()
  return { dir, store }
}

test('condition / source_date 能存能读（含换行与冒号）', () => {
  const { dir, store } = fresh()
  try {
    store.put({
      id: 'c1', kind: 'knowledge', source: 'self', tags: ['t'], title: '标题',
      body: '正文', condition: '主人不吃高蛋白时\n尤其是晚上', source_date: '2026-11-12', weight: 1, last_hit: Date.now(),
    })
    const back = store.get('c1')
    assert.equal(back.condition, '主人不吃高蛋白时\n尤其是晚上')
    assert.equal(back.source_date, '2026-11-12')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('注入里条件写在标题后面，没有条件就不加尾巴', () => {
  const { dir, store } = fresh()
  try {
    const now = Date.now()
    const withCond = { id: 'a', kind: 'knowledge', source: 'owner', title: '主人不能吃高蛋白', body: 'x', condition: '体检指标恢复后', weight: 2, last_hit: now, live_weight: 2 }
    const noCond = { id: 'b', kind: 'knowledge', source: 'owner', title: '主人是男孩子', body: 'y', weight: 2, last_hit: now, live_weight: 2 }
    const text = renderSnapshot({ store, hot: [withCond, noCond], chainLines: 0, now })
    assert.match(text, /主人不能吃高蛋白｜不成立：体检指标恢复后/)
    assert.doesNotMatch(text, /主人是男孩子｜不成立/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('改条件算内容变更，会留旧版；只 touch 不算', () => {
  const { dir, store } = fresh()
  try {
    store.put({ id: 'm', kind: 'knowledge', source: 'self', tags: ['t'], title: 't', body: 'b', condition: '旧条件', weight: 1, last_hit: Date.now() })
    store.put({ id: 'm', ...store.get('m'), condition: '新条件', last_write: Date.now() })
    const histDir = join(dir, 'history', 'm')
    assert.ok(readdirSync(histDir).length >= 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
