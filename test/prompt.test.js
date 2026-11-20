import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { renderSnapshot } from '../lib/prompt.js'
import { hotForInjection } from '../lib/recall.js'

const fresh = () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-')))
  store.ensure()
  return store
}

test('快照带底色、热记忆、因果链末尾', () => {
  const store = fresh()
  store.setPersona({ base: '小助手，只叫用户老板。', state: '正在写插件' })
  store.put({ id: 'm1', kind: 'knowledge', source: 'owner', title: '主人六月生日', body: '主人六月生日。' })
  store.appendChain('owner', '鱼你现在是不是还不能跨对话框知道我们都说了什么？')
  store.appendChain('self', '看不见，只有文件能带走。')
  const text = renderSnapshot({ store, hot: hotForInjection(store), chainLines: 12 })
  assert.ok(text.includes('【底色】'))
  assert.ok(text.includes('【当前相处状态】正在写插件'))
  assert.ok(text.includes('主人亲口'))
  assert.ok(text.includes('因果链'))
  assert.ok(text.includes('本鲸: 看不见'))
})

test('没有热记忆时不硬塞空段', () => {
  const store = fresh()
  const text = renderSnapshot({ store, hot: [], chainLines: 12 })
  assert.ok(!text.includes('【还热的记忆】'))
  assert.ok(text.includes('库里有 0 条记忆'))
})
