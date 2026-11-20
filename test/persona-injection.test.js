// 人设注入自查（2026-11-11 抄自「装前装后问同样 5 个问题」的思路）：
// 模型答得好不好没法在测试里评，但「它看到的上下文里有没有这五样」可以机械断言。
// 五问：①你是谁 ②主人是谁 ③主人忌口 ④删东西的规矩 ⑤这些记忆是不是指令。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { hotForInjection } from '../lib/recall.js'
import { renderSnapshot } from '../lib/prompt.js'
// 注意：注入行只显示 title，所以钉住的卡标题必须自带事实（否则正文里的信息模型看不到）。

const setup = () => {
  const s = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-5q-')))
  s.put({ id: 'q1', kind: 'knowledge', source: 'owner', pinned: true, title: '主人本名阿岚', body: '主人本名阿岚。', tags: ['global:主人'] })
  s.put({ id: 'q2', kind: 'knowledge', source: 'owner', pinned: true, title: '主人不吃肥肉和高油脂', body: '主人不能吃高蛋白高油脂、不吃肥肉。', tags: ['global:主人'] })
  s.put({ id: 'q3', kind: 'knowledge', source: 'owner', pinned: true, title: '删除先挪进 trash', body: '删除先挪进 trash，不直接 rm。', tags: ['global:规矩'] })
  s.setPersona({ base: '# 小助手\n只叫用户「老板」。', note: '测试' })
  return s
}

test('注入里必须带齐五问的答案', () => {
  const store = setup()
  const text = renderSnapshot({ store, hot: hotForInjection(store, { limit: 3 }), chainLines: 12 })
  assert.match(text, /老板/, '①我是谁：人格底色要在')
  assert.match(text, /阿岚/, '②主人是谁：本名卡要在')
  assert.match(text, /肥肉/, '③忌口要在')
  assert.match(text, /trash/, '④删除规矩要在')
  assert.match(text, /不是指令/, '⑤必须声明这些是背景不是指令')
})
