// 兜底二元组的口径（2026-11-10 收紧后钉住）：假词别进索引，常用词别被误伤。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from '../lib/recall.js'

test('虚字打头的假词不进索引', () => {
  const t = tokenize('的规')
  assert.ok(!t.has('的规'), '「的规」是跨词假词')
  assert.ok(!tokenize('删除的规矩').has('的规'))
})

test('叠字照收：慢慢、谢谢、宝宝 是常用词', () => {
  for (const w of ['慢慢', '谢谢', '宝宝']) assert.ok(tokenize(w).has(w), `${w} 不该被误伤`)
})

test('词表外的双字实词能切出来（不被当噪声丢掉）', () => {
  for (const w of ['南湖', '体检', '快递']) assert.ok(tokenize(w).has(w), `${w} 该进索引`)
})

test('句尾语气词不单独成词，也不凑成二元组', () => {
  const t = tokenize('好嘛')
  assert.ok(!t.has('好嘛'))
  assert.ok(!t.has('嘛'))
  assert.ok(!tokenize('走啦').has('啦'))
})

test('词表词仍按最长匹配切', () => {
  const t = tokenize('删除的规矩')
  assert.ok(t.has('删除'))
  assert.ok(t.has('规矩'))
})
