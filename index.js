/**
 * dsh-cyber-hippocampus —— 回响（原名「赛博海马体」）：跨窗口的记忆 + 人格。
 *
 * 取各家的长处，拼成一套：
 *   ① 外文库（BV121xg6kEqx）：一条记忆一个 md，本地纯文本，不靠向量库
 *   ② 记忆重量（BV121xg6kEqx）：21 天掉一半，被想起变重
 *   ③ 分层注入（BV1S6xY65Eey）：热的三条进上下文，冷的只按线索翻
 *   ④ 因果链（BV1VqxW6xEJx）：每轮读末尾 N 行，压缩也压不掉
 *   ⑤ 自我笔记（BV1S6xY65Eey）：自己写自己，最多 40 条，写满了自己挤
 *   ⑥ 人格连续（BV1dDxC67Ep3）：底色 + 当前状态分开存，状态变更留史
 *   ⑦ 关系细节（BV1dDxC67Ep3）：知识/经历分开，矛盾保留，来源与有效期都标
 */
import { HippocampusStore, DEFAULT_DATA_DIR, isSafeId } from './lib/store.js'
import { hotForInjection, injectionBriefs, recallByCue, shouldRecall, keywordFallback, firstLine, tokenize, answerable, entityGate, hopNeighbors, isDead } from './lib/recall.js'
import { localDay, occasionDays, streamLeads } from './lib/stream.js'
import { dreamPass } from './lib/dream.js'
import { maybeDream } from './lib/autodream.js'
import { CONTEXT_NAME, CONTEXT_ORDER, POLICY_NAME, POLICY_TEXT, SECTION_ORDER, renderSnapshot } from './lib/prompt.js'
import { DEFAULT_HEAT, liveWeightOf, tierOfCard } from './lib/heat.js'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PKG_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version } catch { return 'unknown' } })()

export const name = 'cyber-hippocampus'
export const inject = ['tools']

const TEXT = (schema) => ({ schema, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] })
const OUT = TEXT({ type: 'object' })
const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')
// source_type 三值（2026-11-19）：主人亲口 / 找到证据 / 没证据的推断。没传就不写这个字段（老卡行为不变）。
const SOURCE_TYPES = new Set(['owner-said', 'evidence-found', 'no-evidence'])

/** 缺边界时的补法（2026-11-14 审查 M4 + 13:20 复核）：owner 的话「改口前一直算」，本鲸自己推的只算 30 天临时情报。 */
const boundaryDefaults = (src, condition, validUntil) => {
  if (condition || validUntil) return { condition, validUntil, note: '' }
  if (src === 'owner') return { condition: '主人改口或情况变化前一直算数', validUntil, note: '没写边界：已按「主人亲口、改口前有效」记下' }
  const until = localDay(Date.now() + 30 * 86_400_000)
  return { condition, validUntil: until, note: `没写边界：已按临时情报处理（${until} 到期）` }
}

// 宿主每轮会塞进来的运行时上下文 / 技能清单 / 压缩块，这些不是主人说的话，
// 不能进因果链，否则新窗口一开就被噪声糊住。
const HOST_NOISE = /^(Current runtime context\.|Current working directory|Current DSH file policy|Time sampled while preparing turn|<system-reminder|<acp |<context-rescue-checkpoint|\[Compressed conversation section\]|\[SCHEDULE REMINDER BATCH\]|background job |【陪伴记忆快照】|【你心里惦记的事】)/

// 噪声既可能整条出现，也可能混在一条消息中间（实测 131 行「Time sampled…」就这样进了因果链），
// 所以按行剔，剔完没剩下就当这条不是主人说的话。
const HOST_NOISE_LINE = /(Time sampled while preparing turn|^Current runtime context\.|^Current working directory|^Current DSH file policy|^<system-reminder|^<context-rescue-checkpoint|^\[Compressed conversation section\]|^以下内容替代了本会话更早的一段历史|^\[SCHEDULE REMINDER BATCH\]|^background job |^Background subagent [0-9a-f-]+ |^Agent [0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12} sent a message:)/

function isHostNoise(text) {
  return HOST_NOISE.test(String(text || '').trim())
}

/** 剔掉混在正文里的宿主噪声行；返回剩余正文。 */
function stripHostNoise(text) {
  const lines = String(text || '').split('\n')
  const kept = lines.filter((line) => !HOST_NOISE_LINE.test(line.trim()))
  return kept.join('\n').trim()
}

// 写入侧噪声闸（2026-11-20，E3 写入侧实测 W3 失败）：报错原文 / 堆栈不是「记忆」，是日志。
// 它以前会被当成 knowledge 裸写进长期库，只靠 30 天 valid_until 兜着——捞出来当事实用就是灾难。
// 判据只认「整段就是机器输出」：首行是错误头，或堆栈行占多数。真踩的坑会写成「报错 X 是因为 Y，做法 Z」，
// 那种有人话记叙，首行不会是 Error:/Traceback，也不会整段都是 at ...。挡错一次只多一句 error，写错了要花很久才捞得回来。
const MACHINE_NOISE_HEAD = /^(Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|Traceback|Exception|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|npm ERR!|panic:|fatal:)/i
// 2026-11-20 复核补：原来写的是 /^\s+File\s+"/，可上面先 map(l => l.trim()) 了，行首不可能还有空白——
// 这条等于永不命中，Python 栈只贴中段（File "a.py", line 1）会漏过闸。改成 trim 后的形状。
const MACHINE_NOISE_LINE = /^(at\s+\S+\s*\(|at\s+\/|File\s+"|Traceback \()/

function looksLikeMachineNoise(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return false
  if (MACHINE_NOISE_HEAD.test(lines[0])) return true
  const stack = lines.filter((l) => MACHINE_NOISE_LINE.test(l)).length
  return stack >= 2 || stack / lines.length >= 0.6
}

// 使用侧 B 级证据：标题里有一段「全中文 ≥5 字」出现在正文里，就算「被提到过」。
// 两个刻意选择：① 只要全中文字窗 —— ASCII 碎片（[CQ: / dsh- / sion]）在回复里太常见，会灌假阳性；
// ② 长度 5 不是 4 —— 「本鲸自己」这种 4 字高频自名不算，宁少勿错（这是下界，不是精确率）。
const CJK_CHAR = /[\u4e00-\u9fff]/
// 门槛 3 个中文字（2026-11-10 主人定）：原来 5 字让「生日」「名字」这类短标题永远记不上；
// 宁多记一点，也别让短卡永远当不了证据。
function containsRun(title, text, n = 3) {
  const t = String(title || '')
  if (!text || t.length < n) return false
  for (let i = 0; i + n <= t.length; i += 1) {
    const win = t.slice(i, i + n)
    if (![...win].every((ch) => CJK_CHAR.test(ch))) continue
    if (text.includes(win)) return true
  }
  return false
}

function extractText(payload, depth = 0) {
  if (!payload || depth > 5) return ''
  if (typeof payload === 'string') return payload
  if (payload.message && typeof payload.message === 'object') {
    const inner = extractText(payload.message, depth + 1)
    if (inner) return inner
  }
  if (Array.isArray(payload.content)) {
    const texts = payload.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text)
    if (texts.length) return texts.join(' ')
  }
  if (typeof payload.content === 'string') return payload.content
  if (typeof payload.text === 'string') return payload.text
  return ''
}

/**
 * heat 配置归一（2026-11-21 B8 修正）：
 * - 只认有限数字；
 * - 少数键的 0 有明确语义（禁加成 / 立即冷 / 禁地板 / 不去重），其余键必须 > 0；
 * - 不认识的键打一行 warn —— 拼错 halfLifeDayz 不该静默无效。
 */
export function normalizeHeat(input) {
  const heat = { ...DEFAULT_HEAT }
  if (!input || typeof input !== 'object') return heat
  const ZERO_OK = new Set(['rehearseBoost', 'coldAfterDays', 'floorWeight', 'dedupeWindowMs'])
  for (const [k, v] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_HEAT, k)) {
      console.warn(`[cyber-hippocampus] 不认识的 heat 配置键：${k}（可用：${Object.keys(DEFAULT_HEAT).join(', ')}）`)
      continue
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      console.warn(`[cyber-hippocampus] heat.${k} 不是有限数字，已忽略`)
      continue
    }
    if (v < 0 || (v === 0 && !ZERO_OK.has(k))) {
      console.warn(`[cyber-hippocampus] heat.${k}=${v} 不合法，已忽略`)
      continue
    }
    heat[k] = v
  }
  return heat
}

export async function apply(ctx, config = {}) {
  const dataDir = clean(config.dataDir) || DEFAULT_DATA_DIR
  const heat = normalizeHeat(config.heat)
  // 这几个键的 0 有语义（0 行、0 条、不冷却），负数与 NaN 一律回退默认（2026-11-21 #11/#34）。
  const countOr = (v, dflt) => (Number.isSafeInteger(v) && v >= 0 ? v : dflt)
  const chainTailLines = countOr(config.chainTailLines, 12)
  const hotLimit = countOr(config.hotLimit, 3)
  // 折叠日志路径：config.compressionLog 优先；留空则走 lib/prompt.js 的 env/默认值。
  const compressionLog = clean(config.compressionLog) || ''
// 便签条数（「大概记得」区）：主人 2026-11-14 允许适当多带，默认 20 条。
const briefLimit = countOr(config.briefLimit, 20)
// 目录那一层的条数上限（2026-11-19 主人定 A 案）：原来写死 200，179 张就把 9000 字符预算吃到 98.7%；默认收到 130，余量回到 ~900。
const catalogLimit = countOr(config.catalogLimit, 130)
  // 按量做梦（2026-11-12）：不等定时器，stream 攒够行数就整理一次。可在配置里关。
  const autoDream = {
    enabled: config?.autoDream?.enabled !== false,
    // everyLines 不能是 0：那样每轮都梦、每轮扫全库。cooldownMs=0 合法（测试与调试用）。
    everyLines: Number.isSafeInteger(config?.autoDream?.everyLines) && config.autoDream.everyLines > 0 ? config.autoDream.everyLines : 20,
    cooldownMs: countOr(config?.autoDream?.cooldownMs, 3_600_000),
    dryRun: config?.autoDream?.dryRun === true,
  }
  const store = new HippocampusStore(dataDir, heat)
  store.ensure()
  // 加载标记（抄 dsh-hippocampus 0.3.1 的 load.log，2026-11-16）：重启后 tail 一下就知道
  // 跑的是哪版、读的是哪份库、卡片几张；写不进去不拦插件——标记是给自己看的，不是功能。
  try {
    appendFileSync(join(dataDir, 'load.log'), `${new Date().toISOString()} loaded v${PKG_VERSION} cards=${store.all().length} dataDir=${dataDir} pid=${process.pid}\n`)
  } catch { /* 标记失败不拦插件 */ }
  // 每日体检补偿（2026-11-14 审查：04:30 定时任务的投递记录在，脚本却没留下记录——手机那时多半不在线）。
  // 启动后补跑一次：只认真库、只认「今天还没有记录」，测试进程一概不碰。
  // 体检脚本路径：config.healthScript > 环境变量 HC_HEALTH_SCRIPT > 默认值（2026-11-18 去硬编码）。
  const HEALTH_SCRIPT = clean(config.healthScript) || process.env.HC_HEALTH_SCRIPT || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'tools', 'hc-health.sh')
  const HEALTH_LOG = `${dataDir}/.health-log.jsonl`
  const healthCatchUp = () => {
    try {
      if (dataDir !== DEFAULT_DATA_DIR || process.env.NODE_TEST_CONTEXT) return
      if (!existsSync(HEALTH_SCRIPT)) return
      const d = new Date()
      const todayStamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
      const lines = existsSync(HEALTH_LOG) ? readFileSync(HEALTH_LOG, 'utf8').split('\n').filter((l) => l.trim()) : []
      let lastAt = ''
      if (lines.length) { try { lastAt = String(JSON.parse(lines[lines.length - 1]).at || '') } catch { /* 坏行就当没记录 */ } }
      if (lastAt.startsWith(todayStamp)) return
      execFile('bash', [HEALTH_SCRIPT], { timeout: 180_000 }, (err, stdout) => {
        if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
          // Windows 默认没有 bash：这不是「体检失败」，是这台机器上根本没这条命令（2026-11-21 #9）。
          console.log('[cyber-hippocampus] 体检跳过：找不到可执行的 bash。Windows 用户可把 config.healthScript 指向一个 node 脚本。', err.message)
          return
        }
        const head = String(stdout || '').trim().split('\n')[0]
        console.log('[cyber-hippocampus] 体检补跑：', err ? `失败 ${err.message}` : head)
      })
    } catch { /* 补跑失败不影响启动 */ }
  }
  // 用 ctx.effect 管生命周期：热重载/卸载时清掉计时器，别让它跑两次；unref 保证不扣住进程。
  ctx.effect(() => {
    const timer = setTimeout(healthCatchUp, 20_000)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'cyber-hippocampus: health catch-up')
  // 卸载/热重载后，setImmediate 里排队的做梦不该再去碰已经放开的 store（2026-11-21 #12）。
  let disposed = false
  ctx.effect(() => () => { disposed = true }, 'cyber-hippocampus: dispose flag')
  // trace 使用侧：每个会话最近几次注入各记一条（各自带 iid 和被引用集合），别整体覆盖。
  const injectedBySid = new Map() // sid -> [{ iid, ids, used: Set }]
  // 这几个 Map 只增不删，长跑会随会话数一直涨（2026-11-21 #7）：超过 200 个就丢最旧的一批。
  function trimSidMap(map, max = 200) {
    if (map.size <= max) return
    for (const k of map.keys()) {
      if (map.size <= Math.floor(max * 0.8)) break
      map.delete(k)
    }
  }
  const INJECT_HISTORY = 5
  let injectSeq = 0
  let lastSessionId = '' // 事件里最后一次见到的会话；工具执行拿得到 session 时只用它兜底

  // E1（2026-11-20，来源 B28 BV1PU3b6pEVP）：写入幂等 + operation 日志。
  // 只做这两样、没上 CAS：写路径是单进程 + writeAtomic + 覆盖前存 history，并发抢写另有 store 的 withLock，
  // 再加一层 rev/CAS 等于把同一个问题做第二遍。幂等解决的是另一件事——调用方超时重发：
  // 同一句话连发两次该命中同一张卡，而不是靠 7 天相似去重碰运气（那个窗口的语义是「同一件事」，不是「同一次调用」）。
  const OPS_PATH = join(store.dir, 'ops.jsonl')
  const IDEM_TTL_MS = 10 * 60_000
  const idemIndex = new Map() // 幂等键 -> { id, at }
  try {
    const tail = existsSync(OPS_PATH) ? readFileSync(OPS_PATH, 'utf8').split('\n').filter(Boolean).slice(-500) : []
    for (const line of tail) {
      try {
        const e = JSON.parse(line)
        if (e && e.idem && e.id) idemIndex.set(e.idem, { id: e.id, at: Date.parse(e.at) || 0 })
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 还没有日志 */ }
  // 2026-11-20 复核补：ops.jsonl 原来只增不减（每次写卡一行、行里带整段 body），一年几十 MB。
  // 读侧只取末 500 行，所以轮转不损失幂等恢复能力；这里按行数滚，留末 1000 行。
  const OPS_MAX_LINES = 2000
  const OPS_KEEP_LINES = 1000
  let opLines = 0
  try { opLines = existsSync(OPS_PATH) ? readFileSync(OPS_PATH, 'utf8').split('\n').filter(Boolean).length : 0 } catch { /* 还没有日志 */ }
  const logOp = (entry) => {
    try {
      appendFileSync(OPS_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 })
      opLines += 1
      if (opLines > OPS_MAX_LINES) {
        const keep = readFileSync(OPS_PATH, 'utf8').split('\n').filter(Boolean).slice(-OPS_KEEP_LINES)
        writeFileSync(OPS_PATH, `${keep.join('\n')}\n`, { mode: 0o600 })
        opLines = keep.length
      }
    } catch { /* 记不上不能挡住写入 */ }
  }

  const remember = (args) => {
    let body = clean(args.body)
    if (!body) return { ok: false, error: 'body 不能为空' }
    if (looksLikeMachineNoise(body)) {
      return { ok: false, error: '这看着是机器的报错/堆栈，不是记忆。改写成「出了什么错、为什么、后来怎么处理」再写；原始日志放 notes/ 或 stream.jsonl，别进长期库。' }
    }
    const tags = Array.isArray(args.tags) ? args.tags.map(clean).filter(Boolean) : []
    // 三态：传了合法值才写；没传/乱传就沿用旧卡（续写）或不写（新建），绝不替调用方猜。
    const 本次sourceType = SOURCE_TYPES.has(args.source_type) ? args.source_type : undefined
    // id 直接进文件名，别让它穿出 notes 目录。
    const wantId = clean(args.id)
    // 与 store 层同口径（含 Unicode，归纳卡 id 形如 ins-体检-abc123）。两层白名单打架会让归纳卡永远续写不了（2026-11-21 B7）。
    if (wantId && !isSafeId(wantId)) return { ok: false, error: 'id 只能用汉字、字母、数字和 . _ -，且不能包含 ..' }
    // 幂等键：只认「同一调用方同一份输入」。正文不做归一化——归一化会把「差一个标点」也算同一句，
    // 那是去重该管的边界，不是重试该管的。
    // 幂等键＝「同一次请求」的指纹：所有会改变写入结果的入参都进去。
    // 只拿 body 做键会误杀——同一个 body 补上 pinned/source 是「升级这张卡」，不是重试，得走正常去重路径把字段并进去。
    const 幂等键 = JSON.stringify([
      body, clean(args.kind), clean(args.source), clean(args.source_type),
      tags.slice().sort(), clean(args.title), clean(args.condition), clean(args.valid_until),
      clean(args.source_date), clean(args.quote), clean(args.supersedes),
      typeof args.pinned === 'boolean' ? args.pinned : null,
      typeof args.conflict === 'boolean' ? args.conflict : null,
      Array.isArray(args.aka) ? [...args.aka].sort() : null,
      Array.isArray(args.links) ? [...args.links].sort() : null,
    ])
    // 2026-11-20 复核补（QQ 分身）：conflict:true 原来整个排除在幂等外，可「标矛盾」恰恰最容易超时重发。
    // 改成也进幂等，只是命中时不加权重——矛盾记忆不该因为重试越写越重。（下面两处同形条件管的是去重和建议，不动。）
    if (!wantId && !clean(args.supersedes)) {
      const 命中 = idemIndex.get(幂等键)
      if (命中 && Date.now() - 命中.at < IDEM_TTL_MS) {
        const 原卡 = store.get(命中.id)
        // 卡的时间戳也被推老过（测试的 age()、或有人手改 last_write）就说明这不是「刚写过的重试」，
        // 幂等只在「卡确实还是刚写的那张」时成立。否则「8 天前记过同一句」会被当成重试吞掉。
        const 卡时 = Number(原卡?.last_write || 0) || Date.parse(原卡?.created || '') || 0
        if (原卡 && Date.now() - 卡时 <= IDEM_TTL_MS) {
          // 同一个请求再来一次：不新建，但**权重照加**——「又说了一遍」这件事本身是证据，
          // 不加的话账本会被重试稀释（旧契约：窗口内同一件事再记一次要变重）。
          const 是冲突卡 = args.conflict === true
          const t = 是冲突卡 ? 原卡 : (store.touch(原卡.id, Date.now(), 'idem', { dedupeMs: 60_000 }) || 原卡)
          idemIndex.set(幂等键, { id: 原卡.id, at: Date.now() })
          logOp({ op: 'idem_hit', id: 原卡.id, idem: 幂等键 })
          return {
            ok: true,
            id: 原卡.id,
            dedupe: true,
            weight: Number(liveWeightOf(t, Date.now(), store.heat).toFixed(3)),
            tier_after: tierOfCard(t, Date.now(), store.heat),
            note: 是冲突卡
              ? `同一次冲突写入的重试（幂等键命中，${Math.round((Date.now() - 命中.at) / 1000)} 秒前写过这张），没新建、也没加权重`
              : `同一次写入的重试（幂等键命中，${Math.round((Date.now() - 命中.at) / 1000)} 秒前写过这张），没新建，只把权重加了一点`,
          }
        }
        idemIndex.delete(幂等键)
      }
    }
    const id = wantId || `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const prev = store.get(id)
    // 写侧去重（2026-11-11）：没指定 id、不接替谁、也不是在标矛盾时，先看窗口内有没有同一件事。
    // 命中就不新建，但**必须先把这次带来的字段回写到旧卡**再 rehearse：
    // 否则「先 self 推断、6h 内主人亲口确认」会一直挂在 self 上，pinned 也会悄悄丢掉（复核发现）。
    let 增量来源 = null
    let 冗余来源 = false
    let 冗余相似度 = null
    if (!wantId && !clean(args.supersedes) && args.conflict !== true) {
      const title = clean(args.title) || body.split('\n')[0].slice(0, 40)
      let dupe = store.findRecentDupe({ tags, title, body })
      // 分档（2026-11-16，A10②）：相似不等于同一件事，但也不能一律「照写 + 给个建议」——
      // 先分三档：冗余拦下 / 增量照写并标「补：X」/ 不同事照写。
      if (!dupe) {
        const cls = store.classifySimilar({ tags, title, body })
        if (cls.tier === 'redundant') { dupe = cls.card; 冗余来源 = true; 冗余相似度 = cls.sim }
        else if (cls.tier === 'incremental') 增量来源 = cls.card
      }
      if (dupe) {
        // kind 三态：没传就保留旧卡的（以前这里缺省成 experience，会把 knowledge 卡改成 experience）。
        const kind = args.kind === 'knowledge' || args.kind === 'insight' || args.kind === 'experience' ? args.kind : dupe.kind
        const aka = Array.isArray(args.aka) ? args.aka.map(clean).filter(Boolean) : []
        const quote = clean(args.quote)
        const validUntil = clean(args.valid_until)
        const upgraded = {
          ...dupe,
          kind,
          // 来源只往上升：主人亲口说过，就再也不能退回 self。
          source: args.source === 'owner' ? 'owner' : dupe.source,
          ...(本次sourceType ? { source_type: 本次sourceType } : {}),
          aka: aka.length ? [...new Set([...(dupe.aka || []), ...aka])].slice(0, 5) : dupe.aka,
          quote: quote || dupe.quote,
          // 有效期：不传就保留旧卡的；显式传空串才清掉（以前这里两行重复，后一行把旧值抹成空）。
          valid_until: args.valid_until === undefined ? (dupe.valid_until || '') : validUntil,
          condition: clean(args.condition) || dupe.condition || '',
          source_date: clean(args.source_date) || dupe.source_date || '',
          pinned: typeof args.pinned === 'boolean' ? args.pinned : dupe.pinned,
          // tags 要并集：以前不回写，先按 sess:/ws: 记、后确认该升 global: 时会白升（复核实测）。
          tags: tags.length ? [...new Set([...(dupe.tags || []), ...tags])] : dupe.tags,
          title: dupe.title || title,
          // 去重命中时若带了 links，并进去（别把新说的关系丢掉）。
          links: Array.isArray(args.links) && args.links.length
            ? [...new Set([...(dupe.links || []), ...args.links.map(clean).filter(Boolean)])].slice(0, 10)
            : (dupe.links || []),
          // 命中也是一次「写这条」：把窗口推到现在，但它不是「被想起」，不动 last_hit 之外的语义。
          last_write: Date.now(),
        }
        // 去重命中的老卡如果也没边界，顺手补上（13:20 复核：以前只有新建/续写路径补，重复提到老卡不会）。
        const 去重边界 = boundaryDefaults(upgraded.source, upgraded.condition, upgraded.valid_until)
        upgraded.condition = 去重边界.condition
        upgraded.valid_until = 去重边界.validUntil
        store.put(upgraded)
        const touched = store.touch(dupe.id, Date.now(), 'dedupe', { dedupeMs: 60_000 }) || store.get(dupe.id)
        idemIndex.set(幂等键, { id: dupe.id, at: Date.now() })
        logOp({ op: 'dedupe', id: dupe.id, idem: 幂等键, sim: 冗余相似度 ?? null })
        // 两个分支的返回值形状要一致，别让调用方自己猜哪条是活重量。
        const nowDedupe = Date.now()
        return {
          ok: true,
          id: dupe.id,
          dedupe: true,
          weight: Number(liveWeightOf(touched, nowDedupe, store.heat).toFixed(3)),
          raw_weight: touched?.weight,
          tier_after: tierOfCard(touched, nowDedupe, store.heat),
          source: touched?.source ?? upgraded.source,
          pinned: touched?.pinned === true,
          kind: touched?.kind ?? kind,
          note: [
            冗余来源
              ? `库里已有同一件事的卡（${dupe.title || dupe.id}，相似度 ${冗余相似度}），这次没带来新信息，拦下没新建`
              : `窗口内同一件事已记过（${dupe.title || dupe.id}），只补字段+加权重，没新建`,
            去重边界.note,
          ].filter(Boolean).join('；'),
        }
      }
    }
    // 11-14（复核建议）：去重窗口放宽到 7 天后，相似但不完全相同的老卡**只给建议、不吞新卡**——
    // 相似不等于同一件事，吞了就是把「改期/改口」写成旧卡。新建之后这里把候选带回去，让人自己决定合并还是接替。
    let 合并建议 = ''
    let mergeHint = null
    if (!wantId && !clean(args.supersedes) && args.conflict !== true) {
      const sim = store.findSimilar({ tags, title: clean(args.title) || body.split('\n')[0].slice(0, 40), body })
      if (sim) {
        const 天 = Math.max(0, Math.round((Date.now() - (Date.parse(sim.card.created || '') || Date.now())) / 86_400_000))
        const 死卡 = sim.card.superseded_by ? `（注意：它已被 ${sim.card.superseded_by} 接替，别再往它身上续）` : ''
        // 11-14 二审：「只给 id 和相似度」认不出该合并哪条，得把差异点一起带回来（词面差异，去重后各取 5 个）。
        const 新词 = [...new Set([...tokenize(body)].filter((t) => t.length >= 2))]
        const 旧词 = new Set([...tokenize(sim.card.body || '')].filter((t) => t.length >= 2))
        const 新词集 = new Set(新词)
        const 差异 = {
          newOnly: 新词.filter((t) => !旧词.has(t)).slice(0, 5),
          oldOnly: [...旧词].filter((t) => !新词集.has(t)).slice(0, 5),
        }
        const 差异句 = (差异.newOnly.length || 差异.oldOnly.length)
          ? `；差异：新卡多出「${差异.newOnly.join('、') || '无'}」，旧卡多出「${差异.oldOnly.join('、') || '无'}」`
          : ''
        合并建议 = `${增量来源 ? `这是增量（补的是「${增量来源.title || 增量来源.id}」，正文已标「补：」）：` : ''}库里有相似老卡「${sim.card.title || sim.card.id}」（${sim.card.id}，${天} 天前，相似度 ${sim.sim}）${死卡}${差异句}：若是同一件事的延续，用 supersedes 接替或合并成一张；这次仍新建，没自动并`
        mergeHint = { id: sim.card.id, title: sim.card.title || '', similarity: sim.sim, diff: 差异, ...(增量来源 ? { relation: 'incremental' } : {}) }
      }
    }
    // 增量卡把「补的是谁」写进正文（2026-11-16）：以后 grep / 注入都看得见来处，别让它变成一张没头没尾的新卡。
    if (增量来源) body = `补：${增量来源.title || 增量来源.id}（${增量来源.id}）\n${body}`
    // 2026-11-14 审查（严重）：按 id 续写会把旧卡的 superseded_by 原样带回来 —— 返回 ok，卡却永远查不到、也不注入。
    // 续写的意思就是「这张卡还活着」：显式清死因；旧的有效期已经过期、这次又没给新的，也一并清掉，并在返回里说明。
    const todayStr = localDay(Date.now())
    const 旧死因 = prev?.superseded_by ? `已被 ${prev.superseded_by} 接替` : ''
    const 旧已过期 = prev?.valid_until && prev.valid_until < todayStr ? `旧有效期 ${prev.valid_until} 已过` : ''
    const 复活 = Boolean(旧死因 || 旧已过期)
    // 三态：不传 source 就保留旧卡的（以前缺省成 self，会悄悄把「主人亲口」降级，
    // 再叠加下面的 30 天临时情报规则，主人的话会在 30 天后静默失效——13:20 复核实测）。
    const src = args.source === undefined ? (prev?.source === 'owner' ? 'owner' : 'self') : (args.source === 'owner' ? 'owner' : 'self')
    let nextCondition = args.condition === undefined ? (prev?.condition || '') : clean(args.condition)
    let nextValidUntil = args.valid_until === undefined
      // 复活时「今天到期」的旧值也要清：那是上一轮被接替时盖的戳，不清明天又死。
      ? (prev?.valid_until && prev.valid_until > todayStr ? prev.valid_until : '')
      : clean(args.valid_until)
    // M4（11-14 审查）：condition 与 valid_until 两样都空，就跟 POLICY_TEXT 自相矛盾。
    // 不替主人编事实，只当场补一句诚实的边界（规则见 boundaryDefaults）。
    const 边界 = boundaryDefaults(src, nextCondition, nextValidUntil)
    nextCondition = 边界.condition
    nextValidUntil = 边界.validUntil
    const 边界说明 = 边界.note
    // 写卡门槛：只卡「新建 + 本鲸自己推 + 没显式有效期 + 已经有 condition 因此不会走临时情报」这一类。
    // 续写旧卡不重判（否则补一句细节就把之前长期卡悄悄改成 30 天）。
    let 场合说明 = ''
    if (src === 'self' && !prev && !nextValidUntil) {
      // 只用标题取词：正文首句里的「今天」「一次」会把任何一句话都凑成「又碰到一次」；
      // 泛标题会在 occasionDays 里被 df 过滤掉（结果=0 个场合 → 降级，这是正确方向）。
      const { days } = occasionDays(store, clean(args.title) || firstLine(body))
      if (days.length < 3) {
        nextValidUntil = localDay(Date.now() + 30 * 86_400_000)
        场合说明 = `样本不足（原话里只见过 ${days.length} 个场合 < 3），先当临时情报，${nextValidUntil} 到期；多碰到几次再升成长期`
      }
    }
    const card = store.put({
      ...(prev || {}),
      id,
      // kind / tags 也是三态：续写不传就继承旧卡（以前会清空 tags、把 knowledge 改成 experience）。
      kind: args.kind === 'knowledge' || args.kind === 'insight' || args.kind === 'experience' ? args.kind : (prev?.kind || 'experience'),
      source: src,
      ...(本次sourceType ? { source_type: 本次sourceType } : (prev?.source_type ? { source_type: prev.source_type } : {})),
      tags: Array.isArray(args.tags) ? tags : (prev?.tags || []),
      aka: Array.isArray(args.aka) ? args.aka.map(clean).filter(Boolean).slice(0, 5) : (prev?.aka || []),
      // （tags 见上面三态；这里不动。）
      title: clean(args.title) || body.split('\n')[0].slice(0, 40),
      body,
      // 三态：没传就保留旧值。以前缺省成 ''/false，按 id 续写会把「已过期」「打架待核」无声抹掉（复核 P1-7）。
      valid_until: nextValidUntil,
      // 续写即复活：死因清空（revive 过的会在返回里说明）。
      superseded_by: '',
      conflict: typeof args.conflict === 'boolean' ? args.conflict : Boolean(prev?.conflict),
      condition: nextCondition,
      source_date: args.source_date === undefined ? (prev?.source_date || '') : clean(args.source_date),
      supersedes: args.supersedes === undefined ? (prev?.supersedes || '') : clean(args.supersedes),
      // 显式因果边（2026-11-16）：只在写卡时明确给的才连，不传就保留旧值。
      links: Array.isArray(args.links) ? args.links.map(clean).filter(Boolean).slice(0, 10) : (prev?.links || []),
      quote: clean(args.quote) || (prev && prev.quote) || '',
      // pinned：主人定的底线卡，不衰减、永远算热；一旦钉上就不容易解开（要解就显式传 false）。
      pinned: typeof args.pinned === 'boolean' ? args.pinned : Boolean(prev?.pinned),
      weight: prev ? prev.weight : heat.initialWeight,
      last_hit: Date.now(),
      last_write: Date.now(),
    })
    // 版本链：旧卡不判死、不标矛盾，只变「已过期」并记下被谁接上，原话留着可回查。
    // 真矛盾才由调用方显式传 conflict: true。
    // 复活时把接替者那边的 supersedes 解开，别留一条指向活卡的单向死链（13:20 复核：轻）。
    if (复活 && prev?.superseded_by) {
      for (const killerId of String(prev.superseded_by).split(',').map((s) => s.trim()).filter(Boolean)) {
        const killer = store.get(killerId)
        if (!killer?.supersedes) continue
        const left = String(killer.supersedes).split(',').map((s) => s.trim()).filter((s) => s && s !== card.id)
        if (left.length === String(killer.supersedes).split(',').filter((s) => s.trim()).length) continue
        store.put({ ...killer, supersedes: left.join(',') })
      }
    }
    if (card.supersedes) {
      // 2026-11-14 审查（M5）：supersedes 支持一卡接多卡（逗号分隔），反向 superseded_by 也写成多值；
      // 不然「新卡同时接替两张旧卡」时只能记一条，另一条的反向链接永远补不上。
      const olds = String(card.supersedes).split(',').map((s) => s.trim()).filter(Boolean)
      for (const oldId of olds) {
        const old = oldId === card.id ? null : store.get(oldId)
        if (!old) continue
        const links = String(old.superseded_by || '').split(',').map((s) => s.trim()).filter(Boolean)
        if (!links.includes(card.id)) links.push(card.id)
        store.put({
          ...old,
          valid_until: todayStr,
          superseded_by: links.join(','),
          conflict: args.conflict === true ? true : old.conflict === true,
        })
      }
    }
    idemIndex.set(幂等键, { id: card.id, at: Date.now() })
    logOp({ op: prev ? 'update' : 'create', id: card.id, idem: 幂等键, kind: card.kind, source: card.source })
    const nowAfter = Date.now()
    // pinned 的卡不走衰减：这里也用同一套算法，别让返回值跟实际分档打架。
    const liveAfter = liveWeightOf(card, nowAfter, store.heat)
    // 返回里把这一笔写清：复活过谁、边界是怎么补的。别让调用方以为「ok 就是什么都没变」。
    const notes = []
    if (复活) notes.push(`这张卡原来挂着旧死因（${[旧死因, 旧已过期].filter(Boolean).join('，')}），续写后已复活`)
    if (边界说明) notes.push(边界说明)
    if (场合说明) notes.push(场合说明)
    if (增量来源) notes.push(`这是增量：补的是「${增量来源.title || 增量来源.id}」（${增量来源.id}），正文已标「补：」`)
    if (合并建议) notes.push(合并建议)
    return {
      ok: true,
      id: card.id,
      weight: Number(liveAfter.toFixed(3)),
      raw_weight: card.weight,
      tier_after: tierOfCard(card, nowAfter, store.heat),
      ...(notes.length ? { note: notes.join('；') } : {}),
      ...(mergeHint ? { suggest_merge: mergeHint } : {}),
    }
  }

  const definitions = [
    {
      name: 'hc_remember',
      description: '写一条长期记忆到本鲸自己的外文库（本地 md 文件）。kind 分 knowledge（明白了什么）/ experience（亲身碰上了什么）/ insight（梦游整理的归纳）；source 分 owner（主人亲口）/ self（本鲸推的）。有冲突就标 conflict，别自己圆。更新已有卡（传 id）时**证据优先**：新原话/新证据改值，被推翻的旧说法用 supersedes 标过时、旧原文别抹；两条都还要时就并排放着标 conflict。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['body'],
        properties: {
          body: { type: 'string', description: '记忆正文，一到三句。写「谁说了什么、什么时候、为什么重要」。' },
          title: { type: 'string', description: '一句话标题，省略就取正文第一行。' },
          kind: { type: 'string', enum: ['experience', 'knowledge', 'insight'] },
          source: { type: 'string', enum: ['owner', 'self'], description: '主人亲口说的用 owner，本鲸自己推的用 self。' },
          source_type: { type: 'string', enum: ['owner-said', 'evidence-found', 'no-evidence'], description: '来源类型：主人亲口 / 找到证据 / 没证据的推断；不填＝按 source 字段推断（不写该字段，老卡照旧）。' },
          tags: { type: 'array', items: { type: 'string' }, description: '两三个词，召回靠它。' },
          aka: { type: 'array', items: { type: 'string' }, maxItems: 5, description: '别名：主人亲口用过的叫法（最多 5 个）。只收原话，别自己造。' },
          valid_until: { type: 'string', description: '方案/结论的有效期，例如 2026-12-31；长期事实留空。' },
          condition: { type: 'string', description: '这条在什么条件下不成立、什么时候会变（一句话）。写不出条件的，多半只该当临时情报。' },
          source_date: { type: 'string', description: '出处日期（YYYY-MM-DD，或「2026-11 某次对话」）。' },
          conflict: { type: 'boolean', description: '跟库里某条说法打架时置 true。' },
          supersedes: { type: 'string', description: '这条接替的旧记忆 id：旧卡标记为过期并记下 superseded_by，原话保留可回查。' },
          quote: { type: 'string', description: '当事人原话（照抄一两句，别转述）。有原话就能回查，不靠摘要。' },
          pinned: { type: 'boolean', description: '钉住：不衰减、永远算热（只给主人定的底线用，如本名、忌口、删除规矩）。' },
          links: { type: 'array', items: { type: 'string' }, maxItems: 10, description: '显式因果边：这张卡跟哪些卡是因果/来去关系（别的卡 id）。只连真因果关系，别拿「同一轮写过」凑。' },
          id: { type: 'string', description: '续写已有记忆时传 id。' },
        },
      },
      output: TEXT({
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          dedupe: { type: 'boolean', description: 'true = 窗口内同一件事已记过，没新建、只补字段加权重。' },
          note: { type: 'string' },
        },
      }),
      isConcurrencySafe: () => false,
      execute: async (args) => remember(args),
    },
    {
      name: 'hc_recall',
      description: '按线索翻外文库（冷库也能翻）。只在用户提到具体人物/地点/时间/物品/旧事时用，别用来打招呼。', 
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cue: { type: 'string', description: '用户原话或其中的线索词。' },
          ids: { type: 'array', items: { type: 'string' }, maxItems: 10, description: '按短 id 直接取全文（便签行里 [xxxx] 那个；也认完整 id 或尾 4 位）。给 ids 时 cue 可以不传，比猜自然语言准。' },
          cues: { type: 'array', items: { type: 'string' }, maxItems: 10, description: '换几种说法一次查（可选）：命中任一种就算捞到，取最高分。' },
          includeSuperseded: { type: 'boolean', description: '连已被接替/过期的旧卡一起翻（审计用，默认 false）。' },
          limit: { type: 'number', minimum: 1, maximum: 10, description: '最多几条，默认 3。' },
        },
      },
      output: TEXT({ type: 'object' }),
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        // 引擎会把执行上下文递进来（agent.session.id 是官方共享 id）；拿得到就用它，别再猜。
        const sid = exec?.agent?.session?.id || lastSessionId
        // S2（2026-11-16）：按短 id 直接取全文。便签行带 xxxx·，这就是「代表→子节点」那条边，
        // 不必再拿自然语言重猜一句。先认完整 id，再认尾 4 位唯一匹配；多解单列，别混进「没对上」。
        // 模型可能照抄成 [xxxx] / 【xxxx】：先剥壳再匹配。
        if (Array.isArray(args.ids) && args.ids.length > 0) {
          const allIds = store.ids()
          const tail4 = new Map()
          for (const id of allIds) {
            const t = String(id).slice(-4)
            if (!tail4.has(t)) tail4.set(t, [])
            tail4.get(t).push(id)
          }
          // 判死跟 cue 路径同口径：valid_until 写纯日期时按本地日界算，别拿 Date.parse 当 UTC 零点（2026-11-21 B3）。
          const isDeadCard = (c) => isDead(c, Date.now())
          const picked = []
          const seenIds = new Set()
          const missed = []
          const ambiguous = []
          const cueOf = new Map()
          for (const want of args.ids.slice(0, 10)) {
            const raw = clean(String(want ?? ''))
            const w = raw.replace(/^[\[【（(]+/, '').replace(/[\]】）)]+$/, '').trim()
            if (!w) continue
            const hit = allIds.includes(w) ? [w] : (tail4.get(w) || [])
            if (hit.length === 1) {
              const card = store.get(hit[0])
              // 同一张卡在 ids 里出现两次时只取一次（否则重复 touch、返回值也重复，2026-11-21 #2）。
              if (card && !seenIds.has(card.id)) { seenIds.add(card.id); picked.push(card); cueOf.set(card.id, raw) }
              else missed.push(w)
            } else if (hit.length > 1) {
              ambiguous.push({ 短id: w, 候选: hit.slice(0, 4) })
            } else {
              missed.push(w)
            }
          }
          // 按 id 取全文也算「想起了」：真命中、非死卡才加热；cue 记成实际输入的那串。
          for (const card of picked) {
            if (!isDeadCard(card)) store.touch(card.id, Date.now(), cueOf.get(card.id) || '', { dedupeMs: 60000 })
          }
          const allCardsForHop = store.all()
          const items = picked.map((c) => ({ ...(isDeadCard(c) ? { ...c, expired: true } : c), 顺链: hopNeighbors(store, c, allCardsForHop) }))
          const deadNote = items.some((i) => i.expired) ? '含已作废/过期卡，仅审计用，别当现行说法' : ''
          return {
            ok: true,
            status: picked.length ? 'matched' : 'not_found',
            items,
            reason: picked.length ? deadNote : `短 id 没对上：${missed.join('、') || '空'}`,
            ...(ambiguous.length ? { ambiguous } : {}),
            ...(missed.length && picked.length ? { 未匹配: missed } : {}),
            tried: args.ids,
            parsed: null,
          }
        }
        // 一次给多种说法：人工触发词永远覆盖不全，让本鲸自己换几种问法，比加同义词表便宜。
        const raw = []
        if (args.cue != null) raw.push(args.cue)
        if (Array.isArray(args.cues)) raw.push(...args.cues)
        else if (args.cues != null) return { ok: false, error: 'cues 要给字符串数组（只想查一句就用 cue）' }
        const cues = [...new Set(raw.map(clean).filter(Boolean))]
        if (cues.length === 0) return { ok: false, error: 'cue 不能为空' }
        if (cues.length > 10) return { ok: false, error: '一次最多给 10 种说法' }
        // 这是手动翻库（本鲸自己决定要查），不该被「像不像在翻旧事」的门控挡住：
        // 原来单字线索（猫/雨/酒）一律被拦，等于查不了。门控只留给自动检索那条路。

        // limit 传字符串/NaN 时 Math.trunc 得 NaN → slice(0,NaN)=[] → 命中被吞成 not_found（2026-11-21 B9）。
        const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 3), 1), 10)
        const opts = { limit, includeSuperseded: args.includeSuperseded === true }
        const runs = cues.map((c) => ({ cue: c, r: recallByCue(store, c, opts) }))
        // 合并：同一张卡只留分数最高那次，并记住是哪句说法捞到的（记账要用真的那句）。
        const best = new Map()
        for (const { cue, r } of runs) for (const it of r.items || []) {
          const prev = best.get(it.id)
          if (!prev || it.score > prev.item.score) best.set(it.id, { item: it, cue })
        }
        const picked = [...best.values()].sort((a, b) => b.item.score - a.item.score).slice(0, limit)
        const items = picked.map((p) => p.item)
        // 有结果但没有任何一路 matched ⇒ 至少一路是 ambiguous，别把「含糊」报成「命中」。
        let status = items.length === 0
          ? 'not_found'
          : (runs.some((x) => x.r.status === 'matched') ? 'matched' : 'ambiguous')
        const topRun = picked.length ? runs.find((x) => x.cue === picked[0].cue) : runs[0]
        let reason = status === 'not_found' ? '库里没有对得上的记录' : (status === 'ambiguous' ? '命中相近，请补一句是哪件事' : '')
        // 审计翻到的死卡只给看不给算，提醒一句别当现行说法引用。
        if (items.some((i) => i.expired)) reason = (reason ? `${reason}；` : '') + '含已作废/过期卡，仅审计用，别当现行说法'
        // 兜底（2026-11-14 养鱼 23 条：BV1A6Wv6KEob）：卡片召回只看标题/标签/权重，
        // cue 只长在正文里时会 not_found；这时降级扫正文 + 原话流水，标成低置信线索。
        // 不加热、不算 recall use —— 兜底是「可能有」，不是「想起来了」。
        // 2026-11-14 复核对齐：多种说法逐句兜底再合并（原来 join 成一句，score 分母被最长那句拉长，
        // 也看不出是哪句捞到的）；零命中时挂 null，别给调用方一个「像有结果」的空壳。
        let 兜底 = null
        // 实体槽判死的问句，兜底仍可走，但每张候选都要过同一道实体闸（2026-11-19 统一）：
        // 不点名实体时行为不变；点名了实体时，只有字面真出现过那个词的卡才留——既不把同一张卡换个名字递回来，
        // 也不漏掉第二张真提到实体的卡。
        if (status === 'not_found') {
          const merged = { items: [], stream: [] }
          const seen = new Set()
          const seenStream = new Set()
          for (const cue of cues) {
            const fb = keywordFallback(store, cue, { limit: Math.min(limit, 5), includeSuperseded: opts.includeSuperseded, cue })
            for (const it of fb.items) {
              if (seen.has(it.id)) continue
              const full = store.get(it.id) || it
              if (!entityGate(cue, full).ok) continue
              seen.add(it.id)
              merged.items.push(it)
            }
            for (const st of streamLeads(store, cue, { limit: Math.min(limit, 5) })) {
              if (!seenStream.has(st.no)) { seenStream.add(st.no); merged.stream.push(st) }
            }
          }
          merged.items = merged.items.sort((a, b) => b.coverage - a.coverage).slice(0, Math.min(limit, 5))
          merged.stream = merged.stream.slice(0, Math.min(limit, 5))
          if (merged.items.length || merged.stream.length) 兜底 = merged
          if (兜底) reason = '卡库没对上标题/标签；下面是按实词扫正文和原话流水找到的低置信线索（coverage 是词覆盖率，不是置信度），别当现行记忆引用'
        }
        // 出口实体槽闸（2026-11-15 主意识定版）：recallByCue 保持宽召回，只在这里判
        // 「库里到底有没有这类记录」。问句命中实体槽词、头名卡字面里一次都没出现 → 弃权；
        // 普通问句不命中槽词 → 原样放行（「不动正常问句」）。
        let gateNote = ''
        if (status !== 'not_found' && items.length) {
          const fullTop = store.get(items[0].id) || items[0]
          // 多说法时闸要核「真正捞到头名的那句」，核 cues[0] 会把第二句捞到的卡误弃权（2026-11-21 B10）。
          const g = answerable(String(topRun?.cue ?? args.cue ?? cues[0] ?? ''), [fullTop])
          if (!g.ok) {
            status = 'not_found'
            items.length = 0
            兜底 = null
            reason = '库里没有这类记录，不凑答案'
            gateNote = `实体槽未命中：${g.missing.join('/')}`
          }
        }
        const result = {
          status,
          items,
          reason,
          兜底,
          拆解: topRun?.r.拆解 || '',
          ...(gateNote ? { 出口闸: gateNote } : {}),
          // not_found 分支的返回值里没有 parsed；塞 undefined 进去，工具输出会被判「不是无损 JSON」。
          parsed: topRun?.r.parsed ?? null,
          tried: cues, // 实际试过哪些说法，方便本鲸判断要不要再换一种
        }
        // 被想起的记忆会变重（但只在真命中时）。
        // 只有字面证据够强（rehearsable）才加热：低分误命中不给卡片刷权重。
        // 审计翻到的死卡不加热：那是查旧账，不是想起了。
        if (result.status === 'matched') for (const { item, cue } of picked) {
          if (item.rehearsable !== false && !item.expired) store.touch(item.id, Date.now(), cue, { dedupeMs: 60000 })
        }
        // A 级证据：本鲸自己查到了这张卡（只记第一名）。审计模式不算（那是在翻旧账）。
        if (result.status === 'matched' && !opts.includeSuperseded && picked[0]?.item?.rehearsable !== false) {
          recordRecallUse(picked[0].item.id, sid)
        }
        const counts = store.rehearsalsMap()
        return { ok: true, ...result, items: result.items.map((it) => ({ ...it, rehearsed: counts.get(it.id) || 0 })) }
      },
    },
    {
      name: 'hc_evidence',
      description: '按关键词回查原话流水（stream.jsonl，只增不改）：摘要记不清「当时到底怎么说的」时用它，返回行号、时间和原句片段。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['cue'],
        properties: {
          cue: { type: 'string', description: '要回查的词或句子。' },
          limit: { type: 'number', description: '最多几条，默认 3（上限 10）。' },
        },
      },
      output: TEXT({ type: 'object' }),
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const cue = clean(args.cue)
        if (!cue) return { ok: false, error: 'cue 不能为空' }
        const limit = Math.min(10, Math.max(1, Number(args.limit) || 3))
        const items = store.searchStream(cue, { limit })
        if (items.length === 0) return { ok: true, count: 0, items: [], note: '原话流水里没对上，别硬编。' }
        return { ok: true, count: items.length, items }
      },
    },
    {
      name: 'hc_selfnote',
      description: '写/读本鲸自己的自我笔记（最多 40 条，写满自动挤掉最旧的）。这是只给自己看的，不发给主人。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { write: { type: 'string', description: '要写的一句话；不传就是读。' }, last: { type: 'number', description: '读最近几条，默认 3。' } },
      },
      output: TEXT({ type: 'object' }),
      isConcurrencySafe: () => false,
      execute: async (args) => {
        if (clean(args.write)) {
          const r = store.addSelfNote(args.write)
          return { ok: true, ...r }
        }
        // 传负数/0/怪值时别让 slice 跑偏，也别为读一次笔记扫两遍盘（2026-11-21 #4）。
        const last = Math.min(40, Math.max(1, Math.trunc(Number(args.last) || 3)))
        const all = store.selfNotes()
        return { ok: true, count: all.length, notes: all.slice(-last) }
      },
    },
    {
      name: 'hc_persona',
      description: '看/改人格：base 是长期底色（不常动），state 是当前相处状态（会变，旧版本自动进历史）。不传参数就是读。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          base: { type: 'string', description: '新的底色。' },
          state: { type: 'string', description: '新的当前状态。' },
          note: { type: 'string', description: '为什么改，一句话。' },
        },
      },
      output: TEXT({ type: 'object' }),
      isConcurrencySafe: () => false,
      execute: async (args) => {
        if (clean(args.base) || clean(args.state)) return { ok: true, ...store.setPersona(args) }
        return { ok: true, ...store.persona() }
      },
    },
    {
      name: 'hc_dream',
      description: '梦游整理：把最近同一主题的几件事归成一条 insight（保留来源、遇到矛盾就并排放着）。默认只演练不写盘。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dryRun: { type: 'boolean', description: 'true = 只看会写什么，不落盘。' },
          lookbackDays: { type: 'number', description: '往回看几天，默认 14。' },
        },
      },
      output: TEXT({ type: 'object' }),
      isConcurrencySafe: () => false,
      execute: async (args) => {
        // 0 会被 || 改写成 14，负数会让窗口取反（2026-11-21 #5）。
        const days = Math.min(365, Math.max(1, Math.trunc(Number(args.lookbackDays) || 14)))
        return { ok: true, ...dreamPass(store, { dryRun: args.dryRun !== false, lookbackDays: days }) }
      },
    },
    {
      name: 'hc_status',
      description: '看海马体现在装了些什么：卡片分层计数、热的三条、自我笔记几条、因果链多长。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: TEXT({ type: 'object' }),
      isConcurrencySafe: () => true,
      execute: async () => {
        const now = Date.now()
        const cards = store.all()
        const hot = hotForInjection(store, { now, limit: hotLimit })
        const tiers = { hot: 0, warm: 0, cold: 0 }
        // 卡片落盘时只存 weight/last_hit，没有 tier；按当下衰减重算再统计（旧写法把所有卡都当 warm）。
        for (const c of cards) {
          // pinned 的卡不走衰减，也不许因为 idle 太久被算成冷（2026-11-11）。
          const live = liveWeightOf(c, now, heat)
          tiers[tierOfCard(c, now, heat)] += 1
        }
        return {
          ok: true,
          dataDir: store.dir,
          cards: cards.length,
          notes: store.selfNotes().length,
          chainLines: store.chainSize(),
          streamLines: store.streamSize(),
          traceLines: store.traceSize(),
          trace: store.traceCounts(),
          rehearsals: [...store.rehearsalsMap().values()].reduce((a, b) => a + b, 0),
          lastCompaction: store.lastCompaction(),
          persona: Boolean(store.persona().base),
          hot: hot.map((c) => ({ id: c.id, title: c.title, weight: Number(c.live_weight?.toFixed(2)) })),
          tiers,
        }
      },
    },
  ]

  for (const def of definitions) ctx.effect(() => ctx.tools.register(def), `cyber-hippocampus: ${def.name}`)

  // 一轮压缩会被拆成好多条 prune，先攒着，等 end/summary 时记成一笔。
  // 按会话分开：两个窗口可能同时在压自己的历史，共用一个变量会串账、丢账（2026-11-21 #6）。
  const foldings = new Map()
  const FOLD_TTL_MS = 60 * 60 * 1000 // 只见 start 不见 end 的僵尸账，1 小时后自清，别越攒越多
  const foldOf = (key, now = Date.now()) => {
    for (const [k, v] of foldings) if (now - v.at > FOLD_TTL_MS) foldings.delete(k)
    let f = foldings.get(key)
    if (!f) {
      f = { tokens: 0, seqStart: null, seqEnd: null, at: now }
      foldings.set(key, f)
    }
    return f
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (session?.id) lastSessionId = session.id
      const type = event?.type || event?.kind
      const data = event?.data ?? event ?? {}
      const foldKey = String(session?.id || '')

      if (type === 'compaction/start') {
        foldings.set(foldKey, { tokens: 0, seqStart: null, seqEnd: null, at: Date.now() })
        return
      }
      if (type === 'compaction/prune') {
        const f = foldOf(foldKey)
        f.at = Date.now()
        f.tokens += Number(data.shadowedTokenCount) || 0
        const start = data?.shadowedRange?.start
        const end = data?.shadowedRange?.end
        if (Number.isFinite(start)) f.seqStart = f.seqStart === null ? start : Math.min(f.seqStart, start)
        if (Number.isFinite(end)) f.seqEnd = f.seqEnd === null ? end : Math.max(f.seqEnd, end)
        return
      }
      if (type === 'compaction/summary' || type === 'compaction/end') {
        const f = foldings.get(foldKey)
        if (f && f.tokens > 0) store.recordCompaction(f)
        foldings.delete(foldKey)
        return
      }

      // 因果链 + 原话流水：每轮把「主人说的」「本鲸回的最后一句」都记下来。
      if (type !== 'user/message' && type !== 'assistant/message') return
      const text = extractText(event.data ?? event)
      if (!text) return
      if (type === 'user/message' && isHostNoise(text)) return
      const body = type === 'user/message' ? stripHostNoise(text) : text
      if (type === 'user/message' && !body) return
      const who = type === 'user/message' ? 'owner' : 'self'
      // B 级「用上了」证据先记：写链/写流失败不该连带把 use 行也丢了。
      if (type === 'assistant/message') recordTextUse(session?.id || '', body)
      // 两条流水各写各的：一条失败不该把另一条也带走，也别静默吞掉（2026-11-21 #13）。
      try { store.appendChain(who, body) } catch (err) { console.warn('[cyber-hippocampus] 因果链写失败：', err?.message || err) }
      try { store.appendStream({ role: who, text: body, sessionId: session?.id || '' }) } catch (err) { console.warn('[cyber-hippocampus] 原话流水写失败：', err?.message || err) }
      // 按量做梦：攒够就后台归一次，别在事件钩子里同步跑（做梦要读全库、写盘）。
      if (autoDream.enabled) {
        setImmediate(() => {
          if (disposed) return
          try {
            const r = maybeDream(store, autoDream)
            if (r.ran) console.log('[cyber-hippocampus] 按量做梦：整理了', r.wrote, '条，stream 到第', r.total, '行')
          } catch {
            // 做梦失败不能影响对话。
          }
        })
      }
    } catch {
      // 记不上不能影响对话。
    }
  })

  // A 级：本鲸主动调 hc_recall 且该卡可复述 ⇒ 拿它当「用上了」的强证据。
  // 只记第一名：一次查回三张，真被拿来回答的通常就一张，全记会让 use 数虚高。
  function recordRecallUse(id, sid) {
    try {
      store.trace({ at: new Date().toISOString(), ev: 'use', sid: sid || lastSessionId, id, how: 'recall' })
    } catch {
      // 记不上不能影响对话。
    }
  }

  // B 级（下界）：回复里提到某次注入过的卡的标题片段。只能证明「提过」，不能证明「靠它回答」。
  function recordTextUse(sid, text) {
    try {
      const hist = injectedBySid.get(sid)
      if (!hist || hist.length === 0 || !text) return
      // 每张卡只认「最近一次包含它的注入」：否则同一张卡被注入两轮后提一次，会记两条 iid 不同的 use。
      const newest = new Map() // id -> 最近一次包含它的注入记录
      for (let h = hist.length - 1; h >= 0; h -= 1) {
        for (const id of hist[h].ids) if (!newest.has(id)) newest.set(id, hist[h])
      }
      for (const [id, rec] of newest) {
        if (rec.used.has(id)) continue
        if (containsRun(store.get(id)?.title, text)) {
          rec.used.add(id)
          store.trace({ at: new Date().toISOString(), ev: 'use', sid, id, how: 'text', iid: rec.iid })
        }
      }
    } catch {
      // 记不上不能影响对话。
    }
  }

  // 注入流水：同一轮里 assemble 每 step 都会重渲，20 秒内同会话同卡集只记第一条；
  // 别做成「永久只记一次」——隔几轮再注入同样三张卡也是真实注入，吞掉会让漏斗偏低。
  const lastInject = new Map() // sid -> { key, at }
  const INJECT_DEDUPE_MS = 20000
  function recordInject(asm, hot) {
    try {
      const sid = asm?.agent?.session?.id || ''
      const ids = hot.map((c) => c.id)
      const key = [...ids].sort().join(',')
      const now = Date.now()
      const prev = lastInject.get(sid)
      if (prev && prev.key === key && now - prev.at < INJECT_DEDUPE_MS) return
      // 写成功才记「已记过」：写失败就当没记，下一 step 还有机会补上。
      const iid = `${now.toString(36)}-${++injectSeq}`
      const ok = store.trace({ at: new Date(now).toISOString(), ev: 'inject', sid, ids, n: ids.length, iid })
      if (ok) {
        lastInject.set(sid, { key, at: now })
        trimSidMap(lastInject)
        const hist = injectedBySid.get(sid) || []
        hist.push({ iid, ids, used: new Set() })
        if (hist.length > INJECT_HISTORY) hist.shift()
        injectedBySid.set(sid, hist)
        trimSidMap(injectedBySid)
      }
      else console.warn('[cyber-hippocampus] trace 写入失败，这一条注入流水漏记')
    } catch {
      // 记不上不能影响对话。
    }
  }

  // 便签流水（11-14 分身建议）：便签不算注入、不进 use 记账，但得留一笔，
  // 不然过两周没人答得出「谁被端过几次」、轮换对不对账也没依据。
  const lastBrief = new Map()
  function recordBrief(asm, briefs) {
    try {
      if (!briefs || !briefs.length) return
      const sid = asm?.agent?.session?.id || ''
      const ids = briefs.map((c) => c.id)
      const key = [...ids].sort().join(',')
      const now = Date.now()
      const prev = lastBrief.get(sid)
      if (prev && prev.key === key && now - prev.at < INJECT_DEDUPE_MS) return
      if (store.trace({ at: new Date(now).toISOString(), ev: 'brief', sid, ids, n: ids.length })) { lastBrief.set(sid, { key, at: now }); trimSidMap(lastBrief) }
    } catch {
      // 记不上不能影响对话。
    }
  }

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () => promptCtx.systemPrompt.section({ name: POLICY_NAME, order: SECTION_ORDER, interpolate: false, text: () => POLICY_TEXT }),
      'cyber-hippocampus: policy',
    )
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.context({
          name: CONTEXT_NAME,
          order: CONTEXT_ORDER,
          // 快照里可能混有用户原话（如 {{text}} 之类），不能被 DSH 当提示词变量解析。
          interpolate: false,
          // 2026-11-14 审查（中）：以前这里没有兜底，任何 fs 异常都会让整个 prompt 装配抛错、整轮对话挂掉。
          text: (asm) => {
            try {
              const now = Date.now()
              // 全库只扫一次：hotForInjection 和「库里有 N 条」共用同一份（原来每轮扫两次，116–150ms/次）。
              const cards = store.all()
              const hot = hotForInjection(store, { now, limit: hotLimit, cards })
              recordInject(asm, hot)
              // 双管齐下（2026-11-14 主人定）：钉住/前几名给全文，其余给便签，再摊一份全量目录。
              const { briefs, catalog, catalogTotal } = injectionBriefs(store, { now, limit: briefLimit, catalogLimit, cards, excludeIds: hot.map((c) => c.id) })
              recordBrief(asm, briefs)
              // 注入侧写降级账：warn 非空说明这轮少给了东西，打一行日志但不抛（抛了整轮会话就没了）。
              const stats = {}
              const snapshot = renderSnapshot({ store, hot, briefs, catalog, catalogTotal, chainLines: chainTailLines, now, totalCards: cards.length, compressionLog, stats })
              if (stats.warn) console.warn(`[hippocampus] ${stats.warn}`)
              return snapshot
            } catch (err) {
              console.warn('[cyber-hippocampus] 快照装配失败，这一轮不注入记忆：', err?.message || err)
              return ''
            }
          },
        }),
      'cyber-hippocampus: snapshot',
    )
  })
}