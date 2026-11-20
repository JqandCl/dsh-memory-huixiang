import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DAY_MS, decayedWeight, rehearse, tierOf, rankCards } from '../lib/heat.js'

test('21 天正好掉一半', () => {
  const now = 1_000 * DAY_MS
  assert.equal(decayedWeight(1, now - 21 * DAY_MS, now), 0.5)
  assert.ok(Math.abs(decayedWeight(2, now - 42 * DAY_MS, now) - 0.5) < 1e-9)
})

test('被想起会变重，但有上限', () => {
  const now = 1_000 * DAY_MS
  const once = rehearse(1, now - 21 * DAY_MS, now)
  assert.ok(Math.abs(once.weight - 1.1) < 1e-9, `实际 ${once.weight}`)
  const many = rehearse(3.9, now, now)
  assert.equal(many.weight, 4)
})

test('分三档：热 / 温 / 冷，久不想起直接冷存', () => {
  const now = 1_000 * DAY_MS
  assert.equal(tierOf(1, now, now), 'hot')
  assert.equal(tierOf(0.3, now, now), 'warm')
  assert.equal(tierOf(0.1, now, now), 'cold')
  assert.equal(tierOf(2, now - 121 * DAY_MS, now), 'cold')
})

test('排序按此刻重量，不改原卡', () => {
  const now = 1_000 * DAY_MS
  const cards = [
    { id: 'a', weight: 0.3, last_hit: now },
    { id: 'b', weight: 1, last_hit: now - 30 * DAY_MS },
  ]
  const ranked = rankCards(cards, now)
  assert.deepEqual(ranked.map((c) => c.id), ['b', 'a'])
  assert.equal(cards[0].live_weight, undefined)
})
