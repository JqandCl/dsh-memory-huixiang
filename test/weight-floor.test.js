import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DAY_MS, DEFAULT_HEAT, isFloored, liveWeightOf, tierOfCard } from '../lib/heat.js'

const now = 10_000 * DAY_MS

test('够重的卡衰减到地板就停住，不再沉进冷库', () => {
  const card = { id: 'x', weight: 3.5, last_hit: now - 400 * DAY_MS }
  assert.ok(isFloored(card))
  assert.equal(liveWeightOf(card, now), DEFAULT_HEAT.floorWeight)
  // 400 天没想起也不判冷——这正是加地板的原因
  assert.notEqual(tierOfCard(card, now), 'cold')
})

test('没到线的卡照常衰减（地板只管底线级）', () => {
  const card = { id: 'y', weight: 3.1, last_hit: now - 400 * DAY_MS }
  assert.equal(isFloored(card), false)
  assert.ok(liveWeightOf(card, now) < DEFAULT_HEAT.floorWeight)
  assert.equal(tierOfCard(card, now), 'cold')
})

test('pinned 是硬钉子，不受地板影响，也永远算热', () => {
  const card = { id: 'z', weight: 1, last_hit: now - 900 * DAY_MS, pinned: true }
  assert.equal(isFloored(card), false)
  assert.equal(liveWeightOf(card, now), DEFAULT_HEAT.pinWeight)
  assert.equal(tierOfCard(card, now), 'hot')
})

test('新卡（刚想起）不受地板影响，还是按衰减算', () => {
  const card = { id: 'n', weight: 3.5, last_hit: now }
  assert.equal(liveWeightOf(card, now), 3.5)
  assert.equal(tierOfCard(card, now), 'hot')
})
