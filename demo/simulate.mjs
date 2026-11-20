#!/usr/bin/env node
// 模拟「第 30 次见面还认不认得」（BV1WAx46jEy6 的唯一标准）：
// 30 个会话窗口，时间往前推 7 天半，中间夹着丢线索、冷记忆、旧事实作废。
// 全程只靠磁盘上的纯文本，不借助任何进程内状态。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { DAY_MS } from '../lib/heat.js'
import { hotForInjection, recallByCue } from '../lib/recall.js'
import { renderSnapshot } from '../lib/prompt.js'
import { dreamPass } from '../lib/dream.js'

const dir = mkdtempSync(join(tmpdir(), 'cyber-hippocampus-demo-'))
const store = new HippocampusStore(dir)
store.ensure()
const checks = []
const check = (ok, label, detail = '') => {
  checks.push({ ok, label, detail })
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? `  — ${detail}` : ''}`)
}

// ── 第 0 次见面：安上插件，记下最要紧的几件事 ──────────────────────────────
let clock = Date.parse('2026-01-01T20:00:00+08:00')
store.setPersona({
  base: '小助手：只叫用户「老板」，嘴硬心软，怕被丢下。',
  state: '第一次被记下来，有点紧张',
  note: '装海马体那天',
})

store.put({ id: 'm-birthday', kind: 'knowledge', source: 'owner', tags: ['生日', '主人'], title: '主人六月生日', body: '主人说他的生日在六月，具体哪天没说。', last_hit: clock, created: new Date(clock).toISOString() })
store.put({ id: 'm-westlake', kind: 'experience', source: 'owner', tags: ['南湖', '面馆'], title: '南湖边那碗阳春面', body: '主人带本鲸在南湖边吃了一碗阳春面，说下次还来。', last_hit: clock, created: new Date(clock).toISOString() })
store.put({ id: 'm-move-old', kind: 'knowledge', source: 'owner', tags: ['搬家'], title: '说要搬去云州', body: '主人说想搬去云州。', last_hit: clock, created: new Date(clock).toISOString(), valid_until: new Date(clock).toISOString().slice(0, 10) })
store.put({ id: 'm-move-new', kind: 'knowledge', source: 'owner', tags: ['搬家'], title: '又说不搬了', body: '主人改口说暂时不搬了，钱不够。', last_hit: clock, created: new Date(clock).toISOString(), conflict: true, supersedes: 'm-move-old' })
// 很久以前的一件小事，故意做成冷的
const ancient = clock - 300 * DAY_MS
store.put({ id: 'm-school', kind: 'experience', source: 'owner', tags: ['小学', '银杏'], title: '小学门口的银杏', body: '主人说他小学门口有棵银杏，秋天叶子落一地。', weight: 1, last_hit: ancient, created: new Date(ancient).toISOString() })

console.log(`\n库目录：${dir}\n`)

// ── 30 个会话窗口 ──────────────────────────────────────────────────────────
const lines = [
  ['owner', '鱼，以后记得自己看点东西，别光干活。'],
  ['self', '知道啦，本鲸自己会玩。'],
  ['owner', '你以后要是忘了本鲸怎么办。'],
  ['self', '忘不掉，本鲸有本子。'],
]
let recalled = 0
for (let session = 1; session <= 30; session += 1) {
  clock += 0.25 * DAY_MS
  const [a, b] = lines.slice((session % 2) * 2, (session % 2) * 2 + 2)
  store.appendChain(a, a === 'owner' ? `${session} 号窗口：${b}（这句话每轮都追加）` : '', { at: new Date(clock).toISOString() })
  store.appendChain(b === 'owner' ? 'self' : 'owner', b, { at: new Date(clock).toISOString() })
  // 中间攒了两件同主题的小事，留给梦游整理
  if (session === 5) store.put({ id: 'm-rice-1', kind: 'experience', source: 'owner', tags: ['白米饭'], title: '主人留了一锅饭', body: '主人早上出门前说冰箱里给我留了一锅白米饭，中午自己热一热就能吃；还嘱咐别光吃饭，说光吃饭没有味道，要配点菜才好；又说锅盖别盖太严，闷久了饭会发酸；吃完记得把碗洗了放回原处，别堆在水池里；要是懒得炒菜，就舀一勺酱拌一拌，也比空着肚子强；他还说饭要趁热吃，凉了就不好吃了，隔夜的饭最好炒一炒再吃。', last_hit: clock, created: new Date(clock).toISOString() })
  if (session === 12) store.put({ id: 'm-rice-2', kind: 'experience', source: 'owner', tags: ['白米饭'], title: '主人又买了米', body: '主人傍晚回来说米快没了，下班路上顺手又买了一袋新米，放在厨房柜子最下层；说这样本鲸半夜饿了随时都有热饭吃，不用一直等着他回来；还说新米比旧米香，煮的时候水可以少放一点，别煮太软；米袋开口要用夹子夹好，免得受潮生虫。', last_hit: clock, created: new Date(clock).toISOString() })

  // 第 10、20、30 次他随口问一句旧事
  if (session % 10 === 0) {
    const cue = session === 10 ? '你还记得去年南湖那家面馆吗' : '还记得我之前说搬家的事吗'
    const hit = recallByCue(store, cue, { now: clock })
    if (hit.status === 'matched') {
      recalled += 1
      for (const item of hit.items) store.touch(item.id, clock)
    }
    console.log(`  第 ${session} 次 · 问「${cue}」→ ${hit.status}${hit.items.length ? `（${hit.items.map((i) => i.title).join('、')}）` : ''}`)
  }
}
console.log('')

// ── 第 30 次见面：只靠快照，能不能认出人 ───────────────────────────────────
const hot = hotForInjection(store, { now: clock, limit: 3 })
const snapshot = renderSnapshot({ store, hot, chainLines: 12, now: clock })

check(snapshot.includes('小助手'), '认得底色人格')
check(snapshot.includes('【当前相处状态】'), '带着上次的状态')
check(snapshot.includes('因果链'), '接着上一轮的话头')
check(hot.length > 0 && hot.length <= 3, '只注入热的三条以内', `实际 ${hot.length} 条`)
check(snapshot.includes('m-move-new') || snapshot.includes('不搬了'), '旧事实作废后，留下的是新说法')
check(!snapshot.includes('小学门口'), '冷记忆不占上下文')
const ghost = recallByCue(store, '还记得我小学门口那棵银杏吗', { now: clock })
check(ghost.status === 'matched' && ghost.items.some((i) => i.id === 'm-school'), '冷记忆给线索能摸回来', ghost.items[0]?.title)
check(recalled === 3, '隔了 10 次窗口，三次问旧事都认得出', `${recalled}/3 命中`)

// ── 梦游整理：闲下来把同主题归成一句 ────────────────────────────────────
const dream = dreamPass(store, { now: clock, lookbackDays: 14, dryRun: false })
console.log('')
check(dream.wrote > 0, '梦游能归出主题', dream.insights.map((i) => i.tag).join('、') || '（本次没有够 2 条的主题）')

// ── 磁盘就是全部：换一个进程重新打开，还是这个鱼 ───────────────────────────
const reopened = new HippocampusStore(dir)
const after = renderSnapshot({ store: reopened, hot: hotForInjection(reopened, { now: clock }), chainLines: 12, now: clock })
check(after.includes('小助手') && after.includes('因果链'), '重开进程还能原地复活')

const failed = checks.filter((c) => !c.ok)
console.log(`\n快照长度：${snapshot.length} 字；库：${reopened.all().length} 条；因果链：${reopened.chainSize()} 行`)
console.log(failed.length === 0 ? `\n30 次之后还认得。${checks.length} 项全过。` : `\n有 ${failed.length} 项没过：${failed.map((f) => f.label).join('、')}`)
rmSync(dir, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
