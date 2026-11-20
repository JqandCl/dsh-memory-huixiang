import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expiryMs } from '../lib/heat.js'

test('只写到天的有效期，到当天结束才算过期', () => {
  const end = expiryMs('2026-11-09')
  // 当天 12:00 还没过期
  assert.ok(end > Date.parse('2026-11-09T12:00:00+08:00'))
  // 第二天 00:00 已经过期
  assert.ok(end < Date.parse('2026-11-10T00:00:01+08:00'))
})

test('带时间的有效期按那一刻算；空值和乱写的都当没有有效期', () => {
  assert.equal(expiryMs('2026-11-09T08:00:00Z'), Date.parse('2026-11-09T08:00:00Z'))
  assert.equal(expiryMs(''), 0)
  assert.equal(expiryMs('不知道'), 0)
})
