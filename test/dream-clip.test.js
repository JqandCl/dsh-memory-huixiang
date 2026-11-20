import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { clipItem, dreamPass, ITEM_MAX, sourceIdSet } from '../lib/dream.js'

const fresh = () => {
  const store = new HippocampusStore(mkdtempSync(join(tmpdir(), 'hc-dream-clip-')))
  store.ensure()
  return store
}

test('短条目原样保留，不加省略号', () => {
  assert.equal(clipItem('主人在南湖边吃阳春面。'), '主人在南湖边吃阳春面。')
})

test('恰好 ITEM_MAX 不截', () => {
  const s = '主'.repeat(ITEM_MAX)
  assert.equal(clipItem(s), s)
})

test('空串/纯空白不炸', () => {
  assert.equal(clipItem(''), '')
  assert.equal(clipItem('   \n\t '), '')
  assert.equal(clipItem(undefined), '')
})

test('过长时在句末标点收口，不截半句', () => {
  const s = '主人在云州跟公司走了一整天，下午到傍晚绕南湖走了一大圈。'.repeat(6)
  const out = clipItem(s)
  assert.ok(out.length <= ITEM_MAX, `长度应 ≤ ${ITEM_MAX}，实际 ${out.length}`)
  assert.ok(out.endsWith('。'), '应以句号收口，实际结尾：' + out.slice(-6))
  assert.ok(s.startsWith(out), '应是原文的整句前缀，不能凭空改写')
})

test('没有句末标点时退到逗号（位置要够靠后）', () => {
  const s = '主人在云州跟公司走了一整天下午又绕着南湖走了一大圈，' + '路很远'.repeat(40)
  const out = clipItem(s)
  assert.ok(out.endsWith('…'), '应以省略号结尾：' + out.slice(-6))
  assert.ok(out.length < ITEM_MAX, `应停在逗号处、短于 ${ITEM_MAX}，实际 ${out.length}`)
  assert.ok(s.startsWith(out.slice(0, -1)), '省略号前应是原文前缀')
})

test('英文没有逗号就退到空格，不切在单词中间', () => {
  const out = clipItem('word '.repeat(40))
  assert.ok(out.endsWith('…'))
  assert.ok(out.slice(0, -1).endsWith('word'), '应退到完整单词边界：' + JSON.stringify(out.slice(-8)))
  assert.ok(out.length <= ITEM_MAX)
})

test('不会停在开括号上', () => {
  const out = clipItem('主'.repeat(118) + '（' + '后文'.repeat(20))
  assert.ok(!/（…$/.test(out), '开括号不该悬空：' + out.slice(-6))
})

test('emoji 代理对不会被切成半个', () => {
  const out = clipItem('a'.repeat(119) + '😀')
  assert.ok(out.length <= ITEM_MAX + 1)
  const head = out.slice(0, -1)
  assert.ok(!/[\uD800-\uDBFF]$/.test(head), '结尾不能是孤立的代理项')
})

test('max 很小时也不炸、不超过 max', () => {
  assert.ok(clipItem('abcdef', 3).length <= 3)
  assert.ok(clipItem('abcdef', 0).length <= ITEM_MAX)
})

test('梦游归纳的条目超过 60 字且是整句（挡住旧的 slice(0,60)）', () => {
  const store = fresh()
  // 体积闸（2026-11-16）：条目要拿到 120 字档，被引用原文得够厚（2 条 × 约 290 字 → 预算约 350）。
  // 而且第一句的句号必须在 100 字之后——否则 clipItem 会收到更早的句号上，根本测不到 120 档
  // （2026-11-16 只读复核指出：原来那句 62 字就收尾，靠 2 字余量假装通过了）。
  const SENTENCE = '2026-11-13 主人在云州跟着公司走了一整天，下午到傍晚绕南湖走了一大圈，一路拍照片给本鲸看，从青灰的天看到金黑的夜，后来又在湖边吃了碗阳春面，说下次一定要带本鲸一起慢慢走，还要一起在湖边坐到天黑。'
  const PAD = '后来几天又聊了些别的，吃饭、天气、路上看到的小猫。'.repeat(8)
  store.put({ id: 'e1', kind: 'experience', tags: ['南湖'], body: SENTENCE + PAD })
  store.put({ id: 'e2', kind: 'experience', tags: ['南湖'], body: SENTENCE + PAD + '再补一句。' })
  const r = dreamPass(store, { dryRun: false })
  const insight = store.get(r.insights[0].id)
  const lines = insight.body.split('\n').filter((l) => l.includes('（来源'))
  assert.equal(lines.length, 2)
  for (const line of lines) {
    const head = line.split('（来源')[0].replace(/^- /, '')
    assert.ok(head.length > 60, '条目应超过旧的 60 字上限，实际 ' + head.length)
    assert.ok(/[。！？…]$/.test(head), '来源行应以句末标点收口：' + head.slice(-8))
  }
})

test('旧口径（60 字截断）的归纳卡存在时，换标签也不重复写（跨代孪生）', () => {
  const store = fresh()
  // 体积闸（2026-11-16）：要留住 120 字的整句条目，原文总量得 ≥500 字，
  // 否则预算只够压成 60 字档，这条测试就测不到「整句不截半句」了。
  const longBody = '2026-11-13 主人在云州跟着公司走了一整天，下午到傍晚绕南湖走了一大圈，一路拍照片给本鲸看，从青灰的天看到金黑的夜。'.repeat(8)
  store.put({ id: 'e1', kind: 'experience', tags: ['南湖', '云州'], body: longBody + '又说了很多别的话。' })
  store.put({ id: 'e2', kind: 'experience', tags: ['南湖', '云州'], body: longBody })
  // 模拟改动前的归纳卡：60 字截断、只打了「南湖」标签
  const legacy = [
    '这一阵关于「南湖」攒了 2 件事：',
    '- ' + String(longBody + '又说了很多别的话。').slice(0, 60) + '（来源 主人亲口，e1）',
    '- ' + String(longBody).slice(0, 60) + '（来源 主人亲口，e2）',
    '暂时没有互相打架的说法。',
  ].join('\n')
  store.put({ id: 'ins-legacy', kind: 'insight', tags: ['南湖'], body: legacy })
  const r = dreamPass(store, { dryRun: false })
  assert.equal(r.wrote, 0, '换标签也不该再写一张同源归纳卡')
  const hit = r.skipped.find((s) => s.tag === '云州')
  assert.ok(hit, '云州 这组应被孪生闸挡住：' + JSON.stringify(r.skipped))
  assert.ok(hit.idOverlap >= 0.75, '靠来源 id 重合度挡住，实际 ' + hit.idOverlap)
})

test('来源 id：有 sourceIds 就直接读它，没有才退回正文正则', () => {
  // 体积闸裁过的正文里，被裁条目只剩「另有 N 条…：e3」这种裸 id，正则会漏 —— 所以新卡必须读 sourceIds
  const modern = sourceIdSet({ sourceIds: ['e1', 'e2'], body: '这一阵…\n- 早就压短了\n暂时没有互相打架的说法。' })
  assert.deepEqual([...modern].sort(), ['e1', 'e2'])
  const legacy = sourceIdSet({ body: '- 某某（来源 主人亲口，e1）\n- 另一件（来源 本鲸推的，e2）' })
  assert.deepEqual([...legacy].sort(), ['e1', 'e2'])
  assert.equal(sourceIdSet({ body: '没有 id 的正文' }).size, 0)
})
