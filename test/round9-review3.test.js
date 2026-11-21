// 2026-11-21 三合一外部复核（千问 / 豆包 / DeepSeek）修完的回归保护。
// 规矩：每条都要先在旧码上是红的，否则等于没测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { apply, containsRun, sweepIdem } from '../index.js'
import { truncate, firstLine, injectionBriefs, recallByCue } from '../lib/recall.js'
import { appendStream } from '../lib/stream.js'
import { parseCue } from '../lib/parse.js'

// 孤立代理对（半个 emoji）检查：高代理后面必须跟低代理，低代理前面必须有高代理。
const hasLoneSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s) || /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'hx-r9-'))
  const defs = new Map()
  const ctx = { effect: (fn) => { fn() }, on: () => {}, inject: () => {}, tools: { register: (d) => defs.set(d.name, d) } }
  await apply(ctx, { dataDir: dir, autoDream: { enabled: false } })
  return { dir, call: (n, a) => defs.get(n).execute(a, {}) }
}

test('B1 supersedes 传尾 4 位也要接上：旧卡标过期，别让钉住的旧话继续注入', async () => {
  const { dir, call } = await boot()
  const store = new HippocampusStore(dir)
  store.ensure()
  store.put({ id: 'm-oldone-abcd', title: '忌口', body: '主人不吃香菜。', tags: ['global:忌口'], source: 'owner', pinned: true })
  const r = await call('hc_remember', { title: '忌口', body: '主人现在能吃一点香菜了。', tags: ['global:忌口'], source: 'owner', supersedes: 'abcd' })
  assert.equal(r.ok, true)
  const old = store.get('m-oldone-abcd')
  assert.ok(String(old.superseded_by || '').includes(r.id), '旧卡没接上（尾 4 位没解析）：superseded_by=' + JSON.stringify(old.superseded_by))
  assert.ok(old.valid_until, '旧卡没被标过期：valid_until 是空的')
})
test('A1 带 BOM 的卡也要正常解析：编辑器存出来的 BOM 不能把整张卡打成默认值', async () => {
  const { dir } = await boot()
  const store = new HippocampusStore(dir)
  store.ensure()
  store.put({ id: 'm-bom-one-0001', title: 'BOM 卡', body: '正文。', tags: ['global:bom', 'ws:测试'], source: 'owner', pinned: true, condition: '一直算', valid_until: '2027-01-01' })
  const file = join(store.notesDir, 'm-bom-one-0001.md')
  writeFileSync(file, '\uFEFF' + readFileSync(file, 'utf8'))
  const c = store.get('m-bom-one-0001')
  assert.equal(c.tags.length, 2, 'BOM 让 frontmatter 整块没解析出来：tags=' + JSON.stringify(c.tags))
  assert.equal(c.source, 'owner', 'source 被打回默认值：' + c.source)
  assert.equal(c.pinned, true, 'pinned 丢了')
  assert.equal(c.valid_until, '2027-01-01', 'valid_until 丢了：' + JSON.stringify(c.valid_until))
  assert.ok(!c.body.startsWith('---'), '正文里混进了整份 YAML')
})
test('A3 truncate / firstLine 不许切出半个 emoji（孤立代理对会变乱码进上下文）', () => {
  const s = 'a'.repeat(39) + '😀' + '弯'.repeat(5)
  const t = truncate(s, 40)
  assert.ok(!hasLoneSurrogate(t), 'truncate 切出了孤立代理对：' + JSON.stringify(t))
  assert.equal(t, 'a'.repeat(39) + '…')
  const f = firstLine('a'.repeat(39) + '😀' + '尾巴')
  assert.ok(!hasLoneSurrogate(f), 'firstLine 切出了孤立代理对：' + JSON.stringify(f))
})
test('A4 时刻式 valid_until 过期后，续写不传有效期要能复活（别拿 ISO 串跟纯日期串比大小）', async () => {
  const { dir, call } = await boot()
  const store = new HippocampusStore(dir)
  store.ensure()
  const past = new Date(Date.now() - 60_000).toISOString()
  store.put({ id: 'm-isovu-one-0002', title: '临时口径', body: '先这么算。', tags: ['global:临时'], source: 'self', valid_until: past })
  const r = await call('hc_remember', { id: 'm-isovu-one-0002', title: '临时口径', body: '改成这么算了。' })
  assert.equal(r.ok, true)
  const c = store.get('m-isovu-one-0002')
  assert.notEqual(c.valid_until, past, '过期的 ISO 有效期没清掉，卡续写了还判死：' + JSON.stringify(c.valid_until))
  assert.ok(!c.valid_until || Date.parse(c.valid_until.length === 10 ? c.valid_until + 'T23:59:59' : c.valid_until) > Date.now(), '续写后有效期还是过去的：' + JSON.stringify(c.valid_until))
  assert.ok(String(r.note || '').includes('复活'), '没说明复活：' + JSON.stringify(r.note))
})
test('B2 崩溃留下的半行尾巴，不能被下一条原话拼成一整行垃圾', async () => {
  const { dir } = await boot()
  const store = new HippocampusStore(dir)
  store.ensure()
  const p = join(dir, 'stream.jsonl')
  writeFileSync(p, JSON.stringify({ n: 1, at: new Date().toISOString(), role: 'owner', sid: '', text: '第一句' }) + '\n' + '{"n":2,"text":"半')
  appendStream(store, { text: '第二句' })
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 3, '半行被拼进下一条了，两条一起变垃圾：' + JSON.stringify(lines))
  assert.equal(JSON.parse(lines[2]).text, '第二句', '新记录没独立成行')
})
test('A7 catalogLimit 配 0 就该是关掉目录，不能悄悄落回 130', async () => {
  const { dir } = await boot()
  const store = new HippocampusStore(dir)
  store.ensure()
  for (let i = 0; i < 6; i++) store.put({ id: 'm-cat-' + i + '-000' + i, title: '目录卡 ' + i, body: '正文 ' + i, tags: ['global:目录'] })
  const { catalog } = injectionBriefs(store, { catalogLimit: 0, limit: 1 })
  assert.equal(catalog.length, 0, '要求关目录却还是列了 ' + catalog.length + ' 条')
})
test('A5 两字标题也要能记成「被提到过」；单字标题不算证据', () => {
  assert.equal(containsRun('生日', '今天是你生日呀'), true, '2 字标题永远记不上')
  assert.equal(containsRun('生日', '今天天气不错'), false, '不该误判')
  assert.equal(containsRun('鱼', '鱼'), false, '单个字到处都有，不能当证据')
})

test('A6 ambiguous 交回候选时也要尊重 limit，别硬塞 3 条', async () => {
  const { dir } = await boot()
  const store = new HippocampusStore(dir)
  store.ensure()
  // 两张分数贴很近的卡，查询只给 limit 1
  store.put({ id: 'm-amb-a-0001', title: '跑步', body: '早上跑步五公里，跑完拉伸。', tags: ['global:运动'], weight: 3 })
  store.put({ id: 'm-amb-b-0002', title: '跑步', body: '晚上跑步三公里，跑完喝水。', tags: ['global:运动'], weight: 3 })
  // 带触发词、两张卡同分 → status=ambiguous，这时才走 ordered.slice(0, 3) 那条路
  const r = recallByCue(store, '还记得跑步吗', { limit: 1 })
  assert.equal(r.status, 'ambiguous', '夹具没构出 ambiguous：' + r.status)
  assert.equal(r.items.length, 1, 'limit 1 却给了 ' + r.items.length + ' 条')
})
test('A8 ids 里同一张卡写两遍：去重可以，但别把它报成「没对上」', async () => {
  const { dir, call } = await boot()
  const store = new HippocampusStore(dir)
  store.ensure()
  store.put({ id: 'm-dup-one-0001', title: '重复卡', body: '正文。', tags: ['global:dup'] })
  const r = await call('hc_recall', { ids: ['0001', '0001'] })
  assert.equal(r.items.length, 1, '同一张卡该只返回一次')
  assert.ok(!(r.未匹配 && r.未匹配.length), '重复的 id 被报进「没对上」了：' + JSON.stringify(r.未匹配))
})
test('A9 幂等索引要会自己清：过期条目清掉，超上限按最旧删', () => {
  const now = Date.now()
  const m = new Map()
  m.set('old', { id: 'a', at: now - 11 * 60_000 }) // 过期
  for (let i = 0; i < 600; i++) m.set('k' + i, { id: 'x' + i, at: now - (600 - i) * 1000 })
  sweepIdem(m, now, 512)
  assert.equal(m.size, 512, '没清到上限：' + m.size)
  assert.ok(!m.has('old'), '过期条目还在')
  assert.ok(m.has('k599'), '最新的被删了')
})
test('B5「大前天」是大前天（-3 天），不是前天；词里也别留个孤零零的「大」', () => {
  const now = new Date(2026, 10, 21, 15, 0, 0).getTime()
  const day = 86_400_000
  const a = parseCue('大前天说过什么', now)
  assert.equal(a.since, new Date(2026, 10, 18, 0, 0, 0, 0).getTime(), '大前天算成 ' + new Date(a.since).toDateString())
  const b = parseCue('前天说过什么', now)
  assert.equal(b.since, new Date(2026, 10, 19, 0, 0, 0, 0).getTime(), '前天算错')
  assert.ok(!a.keywords.includes('大'), '关键词里还留着「大」：' + JSON.stringify(a.keywords))
})
test('B3 condition 里的裸 \\r 也要压平，不能把后面半句截掉', async () => {
  const { dir } = await boot()
  const store = new HippocampusStore(dir)
  store.ensure()
  store.put({ id: 'm-cr-one-0001', title: '回车卡', body: '正文。', tags: ['global:cr'], condition: '如果\r前半\r后半' })
  const c = store.get('m-cr-one-0001')
  assert.ok(c.condition.includes('前半') && c.condition.includes('后半'), '后半句被回车截掉了：' + JSON.stringify(c.condition))
})

test('A2 tag 里带逗号/引号要原样存回来，不能拆成两个、也不能被剥掉引号', async () => {
  const { dir } = await boot()
  const store = new HippocampusStore(dir)
  store.ensure()
  const tags = ['a,b', '"引号"', "it's"]
  store.put({ id: 'm-tag-one-0001', title: '标签卡', body: '正文。', tags })
  const c = store.get('m-tag-one-0001')
  assert.deepEqual(c.tags, tags, '标签没原样回来：' + JSON.stringify(c.tags))
})
