import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareScored } from '../lib/recall.js'

test('排序是全序：三张卡不管从哪张喂进来，排出来都一样（旧版「两两差<0.05 判并列」会出环）', () => {
  // 分数与 id 逆序：分最高的 id 排最后 —— 旧版会排出 A<C<B<A 的环
  // （2026-11-16 只读复核指出，这里用它的反例构造）
  const C = { id: 'C', score: 0.900, source: 'self', last_hit: 1 }
  const B = { id: 'B', score: 0.870, source: 'self', last_hit: 1 }
  const A = { id: 'A', score: 0.845, source: 'self', last_hit: 1 }
  const perms = [[A, B, C], [A, C, B], [B, A, C], [B, C, A], [C, A, B], [C, B, A]]
  const outs = new Set(perms.map((p) => [...p].sort(compareScored).map((c) => c.id).join('')))
  assert.equal(outs.size, 1, '结果应只有一个，实际：' + [...outs].join(' / '))
})

test('同档里主人亲口说的排前面', () => {
  const owner = { id: 'z-owner', score: 0.86, source: 'owner', last_hit: 1 }
  const self = { id: 'a-self', score: 0.88, source: 'self', last_hit: 9 }
  assert.ok(compareScored(owner, self) < 0, 'owner 应排在 self 前（同档）')
  assert.ok(compareScored(self, owner) > 0, '反过来应排在后面')
})

test('跨档时分数说话：主人亲口也不能越过一整档', () => {
  const self = { id: 'a-self', score: 0.90, source: 'self', last_hit: 1 }
  const owner = { id: 'z-owner', score: 0.82, source: 'owner', last_hit: 9 }
  assert.ok(compareScored(self, owner) < 0, '高分 self 应排前面')
})
