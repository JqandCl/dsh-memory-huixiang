import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { recallByCue, hotForInjection } from '../lib/recall.js'
import { appendStream } from '../lib/stream.js'
import { decayedWeight, tierOf } from '../lib/heat.js'

const fresh = () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-audit-')))
  store.ensure()
  return store
}

test('单字查询也能召回（猫 / 雨）', () => {
  const store = fresh()
  store.put({ id: 'cat', kind: 'experience', source: 'self', title: '楼下的猫', body: '那只猫每天蹲在花坛边', tags: [], weight: 1, last_hit: Date.now() })
  store.put({ id: 'rain', kind: 'experience', source: 'self', title: '下雨那天', body: '雨很大，本鲸没带伞', tags: [], weight: 1, last_hit: Date.now() })
  assert.equal(recallByCue(store, '猫').items[0]?.id, 'cat')
  assert.equal(recallByCue(store, '雨').items[0]?.id, 'rain')
})

test('长问句里只撞上一个词也能命中', () => {
  const store = fresh()
  store.put({ id: 'bak', kind: 'knowledge', source: 'self', title: '备份脚本', body: '改记忆库前先跑备份脚本', tags: [], weight: 1, last_hit: Date.now() })
  const r = recallByCue(store, '我记得之前是不是说过那个备份怎么做来着')
  assert.equal(r.items[0]?.id, 'bak')
})

test('时间/疑问类噪声词不算证据，无关问题老实说没有', () => {
  const store = fresh()
  store.put({ id: 'bak', kind: 'knowledge', source: 'self', title: '备份脚本', body: '改记忆库前先跑备份脚本', tags: [], weight: 1, last_hit: Date.now() })
  assert.equal(recallByCue(store, '今天天气怎么样').status, 'not_found')
  assert.equal(recallByCue(store, '那个东西怎么办').status, 'not_found')
})

test('热注入凑得满 3 条，且不重复', () => {
  const store = fresh()
  const now = Date.now()
  for (const id of ['a', 'b', 'c']) {
    store.put({ id, kind: 'knowledge', source: 'self', title: `卡${id}`, body: '内容', tags: [], weight: 3, last_hit: now })
  }
  const hot = hotForInjection(store, { limit: 3 })
  assert.equal(hot.length, 3)
  assert.equal(new Set(hot.map((c) => c.id)).size, 3)
})

test('流行号连续、不重复；重开也不重号', () => {
  const store = fresh()
  assert.equal(appendStream(store, { text: '第一句' }), 1)
  assert.equal(appendStream(store, { text: '第二句' }), 2)
  const reopened = new HippocampusStore(store.dir)
  assert.equal(appendStream(reopened, { text: '第三句' }), 3)
})

test('自我笔记里混进坏行不炸，且写入后没有残留临时文件', () => {
  const store = fresh()
  store.addSelfNote('正常一条')
  const p = join(store.dir, 'selfnote.jsonl')
  writeFileSync(p, readFileSync(p, 'utf8') + '{坏行\n')
  assert.equal(store.selfNotes().length, 1)
  assert.equal(store.selfNotes()[0].text, '正常一条')
  assert.equal(readdirSync(store.dir).filter((f) => f.includes('.tmp-')).length, 0)
})

test('时间戳坏掉（0 / 未来）不会把卡憋死或冻住', () => {
  const now = Date.now()
  const live = decayedWeight(1, 0, now)
  assert.ok(live > 0.9, '解析失败应视为刚想起，而不是 1970 年')
  assert.equal(tierOf(1, 0, now), 'hot')
  const future = decayedWeight(1, now + 10 * 86400000, now)
  assert.ok(future <= 1, '未来时间戳不该让重量涨')
})

test('hc_remember 的 id 不能穿出目录', async () => {
  const plugin = await import('../index.js')
  const reg = []
  const noop = () => () => {}
  const ctx = {
    tools: { register: (d) => { reg.push(d); return () => {} } },
    effect: (fn) => fn(),
    on: noop,
    inject: () => {},
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  }
  await plugin.apply(ctx, { dataDir: mkdtempSync(join(tmpdir(), 'hc-id-')) })
  const remember = reg.find((d) => d.name === 'hc_remember')
  const bad = await remember.execute({ body: '测试', id: '../../evil' })
  assert.equal(bad.ok, false)
  const ok = await remember.execute({ body: '楼下的猫会蹲在花坛边', id: 'm-ok-1' })
  assert.equal(ok.ok, true)
  // 手动召回不该被「像不像在翻旧事」的门控挡住：单字线索也要能查。
  const recall = reg.find((d) => d.name === 'hc_recall')
  const hit = await recall.execute({ cue: '猫' })
  assert.equal(hit.status, 'matched')
  assert.equal(hit.items[0]?.id, 'm-ok-1')
})

test('删卡先挪进 trash，还能捞回来', () => {
  const store = fresh()
  store.put({ id: 'gone', kind: 'knowledge', source: 'self', title: '要删的卡', body: '内容', tags: [], weight: 1, last_hit: Date.now() })
  assert.equal(store.get('gone')?.id, 'gone')
  assert.equal(store.remove('gone'), true)
  assert.equal(store.get('gone'), undefined)
  const trashRoot = join(store.dir, 'trash')
  assert.ok(existsSync(trashRoot), '应该有 trash 目录')
  const day = readdirSync(trashRoot)[0]
  const restored = readFileSync(join(trashRoot, day, 'gone.md'), 'utf8')
  assert.ok(restored.includes('要删的卡'), '原卡内容还在 trash 里')
  assert.equal(store.gitSnapshot('测试'), false, '非 git 目录不报错、只返回 false')
})
