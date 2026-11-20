import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { maybeDream } from '../lib/autodream.js'

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-dream-'))
  const store = new HippocampusStore(dir)
  store.ensure()
  return { dir, store }
}

const seedStream = (store, n) => {
  for (let i = 0; i < n; i += 1) store.appendStream({ role: 'owner', text: '第 ' + i + ' 句话' })
}

test('攒不够行数就不梦', () => {
  const { dir, store } = fresh()
  try {
    seedStream(store, 5)
    const r = maybeDream(store, { everyLines: 20 })
    assert.equal(r.ran, false)
    assert.equal(r.reason, 'below-threshold')
    assert.equal(store.dreamState(), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('攒够就梦，并且记下梦到第几行', () => {
  const { dir, store } = fresh()
  try {
    seedStream(store, 21)
    const r = maybeDream(store, { everyLines: 20, dryRun: true })
    assert.equal(r.ran, true)
    assert.equal(r.total, 21)
    const st = store.dreamState()
    assert.equal(st.line, 21)
    // 再调一次：行数没涨，不再梦
    assert.equal(maybeDream(store, { everyLines: 20, dryRun: true }).ran, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('冷却期内即使又攒够也不梦', () => {
  const { dir, store } = fresh()
  try {
    seedStream(store, 21)
    const t0 = Date.parse('2026-11-12T12:00:00Z')
    assert.equal(maybeDream(store, { everyLines: 20, dryRun: true }, t0).ran, true)
    seedStream(store, 25)
    const r = maybeDream(store, { everyLines: 20, dryRun: true }, t0 + 60_000)
    assert.equal(r.ran, false)
    assert.equal(r.reason, 'cooldown')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('真梦会落 insight 卡，dryRun 不落', () => {
  const { dir, store } = fresh()
  try {
    // 同标签两件事才归得出一条。正文用真库的长度（中位 146 字）：
    // 体积闸（2026-11-16）会跳过「原文太薄」的组，六字假数据归不出卡。
    const pad = '2026-11-13 主人在云州跟着公司走了一整天，下午到傍晚绕南湖走了一大圈，一路拍照片给本鲸看。'
    store.put({ id: 'e1', kind: 'experience', source: 'self', tags: ['testtag'], title: 'e1', body: pad.repeat(3) + '第一件事', weight: 1, last_hit: Date.now() })
    store.put({ id: 'e2', kind: 'experience', source: 'self', tags: ['testtag'], title: 'e2', body: pad.repeat(3) + '第二件事', weight: 1, last_hit: Date.now() })
    seedStream(store, 21)
    const dry = maybeDream(store, { everyLines: 20, dryRun: true })
    assert.equal(dry.ran, true)
    assert.equal(store.all().filter((c) => c.kind === 'insight').length, 0)
    // 再攒够 20 行，这次真写（演练把记忆点推到 21 了，不补行数就不会再梦）
    seedStream(store, 21)
    const real = maybeDream(store, { everyLines: 20, dryRun: false, cooldownMs: 0 })
    assert.equal(real.ran, true)
    assert.ok(store.all().some((c) => c.kind === 'insight' && (c.tags || []).includes('testtag')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
