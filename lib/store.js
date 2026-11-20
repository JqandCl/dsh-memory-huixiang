// 外文库：一条记忆 = 磁盘上一个纯文本 .md，索引只是一份 JSON。
// 不依赖向量库，打包走人就能带走（BV121xg6kEqx 的第一层）。
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { DEFAULT_HEAT, liveWeightOf, rehearse } from './heat.js'
import { appendStream, searchStream, streamSize, streamFirstAt, streamFirstKey } from './stream.js'
import { isDead, tokenize, tokenWeight } from './recall.js'

// 数据目录（2026-11-20 改名 dsh-memory-huixiang）：新目录叫 huixiang。老用户的库在 cyber-hippocampus/ 下，
// 不能因为改名就「记忆消失」——新目录还没有、旧目录里已经有卡，就继续用旧目录。
// 迁移留给用户自己 mv（插件不替人搬库，搬错了没法回退）。
export function resolveDefaultDataDir() {
  const root = process.env.DSH_HOME || join(homedir(), '.dsh')
  const preferred = join(root, 'huixiang')
  const legacy = join(root, 'cyber-hippocampus')
  try {
    if (!existsSync(preferred) && existsSync(join(legacy, 'notes'))) return legacy
  } catch { /* 判断失败按新目录走 */ }
  return preferred
}
export const DEFAULT_DATA_DIR = resolveDefaultDataDir()

// 卡 id 会被直接拼进文件路径（get/put），因此只允许安全字符。
// 2026-11-20 复核：原来只在校验工具入参那一层净化，store 层的 get/put 还能被 `../x` 带出 notes/。
// 允许 Unicode 字母数字：归纳卡 id 形如 `ins-云州-mwp5qm0r`（2026-11-20 实测），不能只放行 ASCII。
const ID_RE = /^[\p{L}\p{N}._-]+$/u
export function isSafeId(id) {
  const s = String(id ?? '')
  return Boolean(s) && ID_RE.test(s) && !s.includes('..')
}
function assertSafeId(id) {
  if (!isSafeId(id)) throw new Error(`非法卡 id：${String(id)}（只允许字母数字与 . _ -，且不能含 ..）`)
  return String(id)
}
const SELF_NOTE_CAP = 40 // BV1S6xY65Eey：self note 最多 40 条，写满就把旧的挤掉

const nowIso = () => new Date().toISOString()

/** 二元组 Jaccard 相似度（只在「标题相同、正文改写幅度很小」时用来放宽判定）。 */
function bigramSimilarity(a, b) {
  const grams = (s) => {
    const out = new Set()
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2))
    return out
  }
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 两版卡的内容是否真的变了（只看写作者会改的字段，不看 weight/last_hit/last_write）。 */
function contentChanged(a, b) {
  const pick = (c) => JSON.stringify([
    c.title, c.body, c.kind, c.source, c.quote, c.valid_until, c.condition, c.source_date,
    c.conflict === true, c.pinned === true, c.superseded_by || '', c.supersedes || '',
    [...(c.tags || [])].sort(), [...(c.aka || [])].sort(),
    [...(c.sourceIds || [])].sort(),
    [...(c.links || [])].sort(),
  ])
  return pick(a) !== pick(b)
}

/** 归一化：去掉标点空白、只留中英文数字、小写。正文用它整段比对，绝不截断。 */
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/** 标题指纹：归一化后截前 40 字（标题只是辅助判据，截断只影响「同题」这一路）。 */
function fingerprint(text) {
  return normalizeText(text).slice(0, 40)
}
const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}
// 写锁：同一份库可能被工具调用与夜间整理同时写（BV14qxL6WEGZ 评论区那条「两个进程抢写」的坑）。
// 用 O_EXCL 建锁文件，拿不到就短暂自旋；超过 10 秒的锁视为前任崩了，直接清掉。
const LOCK_WAIT_MS = 3000
const LOCK_STALE_MS = 10_000
const withLock = (path, fn) => {
  const lock = `${path}.lock`
  const start = Date.now()
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { force: true })
          continue
        }
      } catch {}
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`写锁超时：${lock}`)
      // 原来的同步空转会把整个 agent 循环卡住；用 Atomics.wait 真睡 20ms。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

const writeAtomic = (path, text) => withLock(path, () => {
  const tmp = `${path}.tmp-${process.pid}`
  // 先 fsync 再 rename：否则断电/掉电时 rename 可能指向一个还没落盘的空文件（2026-11-21 B12）。
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
})

/** 极简 frontmatter 解析：只认 key: value 一行一个，够用。 */
function parseCard(id, raw, mtimeMs = 0) {
  // Windows 编辑器（记事本 / VS Code 另存）会给整份文件换成 CRLF。不归一的话正则匹配不上，
  // 整张卡静默退化成默认值（weight 重置、tags/pinned/valid_until 全丢），不报错（2026-11-21 B16）。
  raw = String(raw).replace(/\r\n?/g, '\n')
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { id, kind: 'experience', source: 'self', tags: [], weight: 1, last_hit: Date.now(), body: raw.trim() }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return {
    id,
    kind: meta.kind || 'experience',
    source: meta.source || 'self',        // owner = 主人亲口说的；self = 本鲸推的
    // source_type：主人亲口/找到证据/没证据的推断（2026-11-19）。老卡没有这个字段就保持 undefined，不补值。
    ...(meta.source_type ? { source_type: meta.source_type } : {}),
    tags: meta.tags ? meta.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    weight: Number(meta.weight) || 1,
    // 字段坏了别回退成「现在」——那会让这张卡永远不衰减。依次退到 created、文件 mtime。
    last_hit: Date.parse(meta.last_hit || '') || Date.parse(meta.created || '') || mtimeMs || 0,
    created: meta.created || meta.last_hit || nowIso(),
    valid_until: meta.valid_until || '',
    // condition：这条在什么条件下不成立/会变（2026-11-12 取自「放错层比忘掉更贵」）。
    condition: (meta.condition || '').replace(/\s*⏎\s*/g, '\n'),
    source_date: meta.source_date || '',
    supersedes: meta.supersedes || '',
    superseded_by: meta.superseded_by || '',
    quote: (meta.quote || '').replace(/\s*⏎\s*/g, '\n'),
    conflict: meta.conflict === 'true',
    // 原文指针：归纳/整理卡记着它从哪几条来的，被裁剩几条也不丢来源（2026-11-16）。
    sourceIds: meta.sourceIds ? meta.sourceIds.split(',').map((s) => s.trim()).filter(Boolean) : [],
    // 显式因果边（2026-11-16）：只在写卡时明确给的才连；不拿「同一轮写过」当因果（那是共现，不是因果）。
    links: meta.links ? meta.links.split(',').map((s) => s.trim()).filter(Boolean) : [],
    title: meta.title || '',
    // 别名：主人亲口叫过的说法，召回时当正文一起算（只该收主人说过的）。
    aka: meta.aka ? meta.aka.split(',').map((a) => a.trim()).filter(Boolean) : [],
    // pinned：主人定的底线（本名/忌口/删除规矩这类），不衰减、永远算热（2026-11-11）。
    pinned: meta.pinned === 'true',
    // last_write：上一次「写这条卡」的时间（记忆内容被写/改），跟「被想起」（last_hit）分开。
    // 去重窗口锚它：常被召回的卡不该因此一直处在「可被合并」状态（2026-11-11 主人拍板）。
    last_write: Date.parse(meta.last_write || '') || Date.parse(meta.created || '') || mtimeMs || 0,
    body: (m[2] || '').trim(),
  }
}

// frontmatter 是行式格式：提交进来的换行能伪造一整行（title: "正常\nsuperseded_by: hacked"），
// 落盘前把单行字段统一压平（2026-11-21 千问复核 B1）。
const flat = (v) => String(v ?? '').replace(/\s*\n\s*/g, ' ⏎ ').trim()

function renderCard(card) {
  const lines = [
    '---',
    `kind: ${card.kind}`,
    `source: ${card.source}`,
    // 只在有值时才写：老卡重新落盘不该凭空多出一行（2026-11-19）。
    ...(card.source_type ? [`source_type: ${card.source_type}`] : []),
    `tags: ${(card.tags || []).map(flat).join(', ')}`,
    `weight: ${Number(card.weight).toFixed(3)}`,
    `last_hit: ${new Date(card.last_hit).toISOString()}`,
    `created: ${card.created || nowIso()}`,
    `valid_until: ${flat(card.valid_until)}`,
    `condition: ${flat(card.condition)}`,
    `source_date: ${flat(card.source_date)}`,
    `supersedes: ${flat(card.supersedes)}`,
    `superseded_by: ${flat(card.superseded_by)}`,
    `quote: ${flat(card.quote)}`,
    `conflict: ${card.conflict === true}`,
    // 只在有值时才写这行：旧卡重新落盘不该凭空多出一行空字段。
    ...(Array.isArray(card.sourceIds) && card.sourceIds.length
      ? [`sourceIds: ${card.sourceIds.map((x) => flat(String(x))).join(', ')}`]
      : []),
    ...(Array.isArray(card.links) && card.links.length
      ? [`links: ${card.links.map((x) => flat(String(x))).join(', ')}`]
      : []),
    `title: ${flat(card.title)}`,
    `aka: ${(card.aka || []).map(flat).join(', ')}`,
    `pinned: ${card.pinned === true}`,
    `last_write: ${Number.isFinite(card.last_write) && card.last_write > 0 ? new Date(card.last_write).toISOString() : (card.created || nowIso())}`,
    '---',
    card.body || '',
    '',
  ]
  return lines.join('\n')
}

export class HippocampusStore {
  constructor(dataDir = DEFAULT_DATA_DIR, heat = DEFAULT_HEAT) {
    this.dir = dataDir
    this.notesDir = join(dataDir, 'notes')
    this.heat = heat
    this.chainPath = join(dataDir, 'chain.txt')
    this.selfNotePath = join(dataDir, 'selfnote.jsonl')
    this.personaPath = join(dataDir, 'persona.json')
    this.rehearsalPath = join(dataDir, 'rehearsals.jsonl')
    this.compactionPath = join(dataDir, 'compactions.jsonl')
    this.tracePath = join(dataDir, 'trace.jsonl')
  }

  ensure() {
    // 0700 / 0600：库里是主人的私事，同机别的账户不该读得到（2026-11-20 复核）。
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    mkdirSync(this.notesDir, { recursive: true, mode: 0o700 })
    if (!existsSync(this.chainPath)) writeFileSync(this.chainPath, '', { mode: 0o600 })
    if (!existsSync(this.selfNotePath)) writeFileSync(this.selfNotePath, '', { mode: 0o600 })
    if (!existsSync(this.rehearsalPath)) writeFileSync(this.rehearsalPath, '', { mode: 0o600 })
    if (!existsSync(this.compactionPath)) writeFileSync(this.compactionPath, '', { mode: 0o600 })
    if (!existsSync(this.tracePath)) writeFileSync(this.tracePath, '', { mode: 0o600 })
    if (!existsSync(this.personaPath)) {
      writeAtomic(this.personaPath, JSON.stringify({ base: '', state: '', history: [] }, null, 1))
    }
  }

  // ── trace：注入/使用流水（只增不改，用来算漏斗）──────────────────────────
  // 和 rehearsals 分开：那边是「权重变了」，这边是「这次进过 / 用没用」。
  trace(entry) {
    this.ensure()
    try {
      appendFileSync(this.tracePath, `${JSON.stringify(entry)}\n`)
      return true
    } catch {
      // 记不上不能影响对话；返回 false 让调用方别把「漏记」当成「记过了」。
      return false
    }
  }

  traceSize() {
    try {
      return readFileSync(this.tracePath, 'utf8').split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }

  // 注入/使用各多少条：漏斗要两个数才看得出问题。
  traceCounts() {
    // 拆开记：A 级（主动查到）和 B 级（回复里提到）不是一种证据，混成一个数会误导。
    const out = { inject: 0, use: 0, useRecall: 0, useText: 0 }
    try {
      for (const line of readFileSync(this.tracePath, 'utf8').split('\n')) {
        if (!line) continue
        try {
          const entry = JSON.parse(line)
          if (entry.ev === 'inject') out.inject += 1
          else if (entry.ev === 'use') {
            out.use += 1
            if (entry.how === 'recall') out.useRecall += 1
            else if (entry.how === 'text') out.useText += 1
          }
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* 文件还没生 */ }
    return out
  }

  // ── 记忆卡 ───────────────────────────────────────────────────────────────
  ids() {
    this.ensure()
    return readdirSync(this.notesDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
  }

  get(id) {
    // 读路径不抛：非法 id 当成「没这张卡」，别让一个坏 id 把整轮注入打掉。
    if (!isSafeId(id)) return undefined
    const path = join(this.notesDir, `${id}.md`)
    if (!existsSync(path)) return undefined
    return parseCard(id, readFileSync(path, 'utf8'), statSync(path).mtimeMs)
  }

  /**
   * 写侧去重：找一张「同一件事刚记过」的卡。命中就返回它，让调用方补字段、加权重，不新建。
   * 判据（2026-11-11；复核后收紧了一次，宁可漏挡也别误挡）：
   *   正文指纹前 16 字必须相同（真的是同一句话），并且满足其一：
   *     ① 标题指纹相同；
   *     ② 标签集合相同（「ws:临海」这类宽标签下面本来就该有甲乙两条）。
   * 只认「正文一致」是关键：光标题一样挡不住「周四体检」→「周四体检取消，改周五」这种
   * 结论相反的新说法——那必须落成新卡（还可能标 conflict），不能被去重吞掉。
   * 只在 last_hit（退而 created）落在窗口内才挡；窗口外照常另记一条（旧事又说一遍要留痕）。
   */
  findRecentDupe({ tags = [], title = '', body = '' }, { withinMs = this.heat.dedupeWindowMs ?? 7 * 86_400_000, now = Date.now() } = {}) {
    const keyTags = [...tags].map((t) => String(t).trim()).filter(Boolean).sort().join('|')
    const head = title || String(body || '').split('\n')[0]
    const keyTitle = fingerprint(head)
    const keyBody = normalizeText(body)
    if (!keyBody) return undefined
    let best
    for (const card of this.all()) {
      // 死卡（被接替 / 过期）绝不能当去重目标：把新事实写进一张检索永远过滤掉的卡，
      // 等于隐身失忆，而工具还回 ok（2026-11-11 专业审查 P0-3）。
      if (isDead(card, now)) continue
      const created = Date.parse(card.created || '') || 0
      // 窗口锚「上次写这条」：召回把它翻热不该延长窗口，否则热卡永远可被合并。
      const fresh = card.last_write || created
      if (!fresh || now - fresh > withinMs) continue
      const cardBody = normalizeText(card.body)
      // 判据只有一条：整段正文归一化后完全相等。差一个字的都要落新卡（让 conflict 闸去管），
      // 曾经放宽到「前 16 字」和「相似度 0.9」，都被实测证明会吞掉改期/改口的新结论。
      if (cardBody !== keyBody) continue
      // 同正文还要对上标题或标签之一，才算同一件事被说了两遍。
      const sameTitle = keyTitle && keyTitle === fingerprint(card.title || String(card.body || '').split('\n')[0])
      const cardTags = [...(card.tags || [])].map((t) => String(t).trim()).filter(Boolean).sort().join('|')
      if (!sameTitle && !(keyTags && keyTags === cardTags)) continue
      // 命中多张时挑最新被想起的那张（readdir 顺序跟新旧无关，别把权重加给旧卡）。
      if (!best || fresh > best.fresh) best = { card, fresh }
    }
    return best?.card
  }

  /**
   * 找「相似但不完全相同」的老卡（11-14 复核建议）：正文二元组/分词相似度 + 标签/标题/标题实词有一项对得上。
   * 只用来给「合并/接替」建议，绝不拿它当去重目标——相似不等于同一件事，吞了就是改口。
   * 11-14 复核：真重复回测只有 0.10/0.50/0.50/找不到，0.72 的门槛等于永不触发；
   * 门槛改 0.5，另加「标题实词重合 ≥2」这条弱证据，窗口给它单独放宽到 14 天（跨周重复才是漏的大头）。
   */
  findSimilar({ tags = [], title = '', body = '' }, { withinMs = 14 * 86_400_000, now = Date.now(), minSim = 0.5 } = {}) {
    const keyBody = normalizeText(body)
    if (!keyBody) return undefined
    const keyTags = new Set(tags.map((t) => String(t).trim()).filter(Boolean))
    const head = title || String(body || '').split('\n')[0]
    const keyTitle = fingerprint(head)
    const keyTitleWords = new Set([...tokenize(head)].filter((t) => tokenWeight(t) >= 0.8))
    const tokenSet = new Set(tokenize(body))
    let best
    for (const card of this.all()) {
      if (isDead(card, now)) continue
      const fresh = card.last_write || Date.parse(card.created || '') || 0
      if (!fresh || now - fresh > withinMs) continue
      const cardTags = new Set((card.tags || []).map((t) => String(t).trim()).filter(Boolean))
      const sharedTag = [...keyTags].some((t) => cardTags.has(t))
      const sameTitle = keyTitle && keyTitle === fingerprint(card.title || String(card.body || '').split('\n')[0])
      // 标题实词撞上 2 个也算「像同一件事」：真重复里标题常常几乎一样，正文却改写得很散。
      const cardTitleWords = [...tokenize(card.title || '')].filter((t) => tokenWeight(t) >= 0.8)
      const sharedTitleWords = cardTitleWords.filter((t) => keyTitleWords.has(t)).length
      if (!sharedTag && !sameTitle && sharedTitleWords < 2) continue
      // 二元组对中文改写太脆（实测真改写只有 0.23），再用分词集合的 Jaccard 兜一层：近义改写的词面重合更高。
      const other = new Set(tokenize(card.body))
      let inter = 0
      for (const t of tokenSet) if (other.has(t)) inter += 1
      const jac = tokenSet.size && other.size ? inter / (tokenSet.size + other.size - inter) : 0
      const sim = Math.max(bigramSimilarity(keyBody, normalizeText(card.body)), jac)
      if (sim < minSim) continue
      if (!best || sim > best.sim) best = { card, sim: Number(sim.toFixed(3)) }
    }
    return best
  }

  /**
   * 写前分档（2026-11-16，A10②）：相似老卡不是「要不要合并」一个模糊建议，而是三档。
   *   redundant  ：同一件事、没有新词（也没有新 tag）→ 拦下不写，沿用老卡并 rehearse
   *   incremental：同主题、有新信息 → 照写新卡，正文标「补：老标题（id）」
   *   different  ：像但不沾（相似门槛都没过）→ 当普通新卡
   * 相似判据复用 findSimilar（minSim 0.5 + 共享 tag/同标题/标题实词 ≥2），但窗口跟去重一致取 7 天
   * （14 天窗口是「给建议」的，不是「拦下不写」的——超过 7 天同一句话本鲸要落一笔新账，这是 11-14 定下的）；
   * 「有没有新信息」只看正文实词差集 + 新 tag，不猜语义。别把「改写说法」当新信息——
   * 那样改口会被写成两张卡；也别把「加了细节」当冗余——那样细节永远进不来。
   */
  classifySimilar({ tags = [], title = '', body = '' }, { now = Date.now(), withinMs = this.heat.dedupeWindowMs ?? 7 * 86_400_000 } = {}) {
    const sim = this.findSimilar({ tags, title, body }, { now, withinMs })
    if (!sim) return { tier: 'different' }
    const oldWords = new Set([...tokenize(sim.card.body || '')].filter((t) => t.length >= 2))
    const newWords = [...new Set([...tokenize(body)].filter((t) => t.length >= 2))].filter((t) => !oldWords.has(t))
    const oldTags = new Set((sim.card.tags || []).map((t) => String(t).trim()).filter(Boolean))
    const newTags = tags.map((t) => String(t).trim()).filter(Boolean).filter((t) => !oldTags.has(t))
    const tier = newWords.length > 0 || newTags.length > 0 ? 'incremental' : 'redundant'
    return { tier, card: sim.card, sim: sim.sim, newWords: newWords.slice(0, 8), newTags }
  }

  put(card) {
    this.ensure()
    if (!card.id) throw new Error('card.id 必填')
    card = { ...card, id: assertSafeId(card.id) }
    const path = join(this.notesDir, `${card.id}.md`)
    const prev = this.get(card.id)
    const merged = {
      ...prev,
      ...card,
      weight: card.weight ?? prev?.weight ?? this.heat.initialWeight,
      last_hit: card.last_hit ?? prev?.last_hit ?? Date.now(),
      created: prev?.created || nowIso(),
      // 只有明确传了 last_write 才算「写过」；touch/召回路径不传，窗口不会被召回延长。
      last_write: card.last_write ?? prev?.last_write ?? Date.now(),
    }
    // 覆盖前留旧版（2026-11-11 抄自「事件流水」思路）：只比内容字段，
    // touch 改的 weight/last_hit 不算改写，不会把 history 刷满。
    if (prev && contentChanged(prev, merged)) this.saveHistory(prev)
    writeAtomic(path, renderCard(merged))
    return merged
  }

  /** 把旧版落进 history/<id>/<时间>.md，误合并/误覆盖时能翻回去（trash 只救删除，救不了覆盖）。 */
  saveHistory(card) {
    try {
      const dir = join(this.dir, 'history', String(card.id))
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      writeFileSync(join(dir, `${stamp}.md`), renderCard(card))
      // 每张卡最多留 20 个旧版，超了从最老的开始删。
      const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
      for (const f of files.slice(0, Math.max(0, files.length - 20))) rmSync(join(dir, f), { force: true })
      return true
    } catch {
      return false // 留历史失败不能影响正事写入
    }
  }

  remove(id) {
    // id 直接拼路径：与 get/put 同口径校验，别让 ../ 把 notes 外的文件挪进 trash（2026-11-21 B4）。
    id = assertSafeId(id)
    const path = join(this.notesDir, `${id}.md`)
    if (!existsSync(path)) return true
    // 不直接 rm：先挪进 trash/<日期>/，留一条退路（主人 2026-11-06 定的规矩，这里落成代码）。
    const day = new Date().toISOString().slice(0, 10)
    const trashDir = join(this.dir, 'trash', day)
    mkdirSync(trashDir, { recursive: true })
    renameSync(path, join(trashDir, `${id}.md`))
    this.gitSnapshot(`删卡 ${id}`)
    return !existsSync(path)
  }

  /** 危险动作后自动留一个版本快照（不是 git 仓库就安静跳过）。 */
  gitSnapshot(message) {
    try {
      if (!existsSync(join(this.dir, '.git'))) return false
      execFileSync('git', ['-C', this.dir, 'add', '-A'], { timeout: 5000, stdio: 'ignore' })
      execFileSync(
        'git',
        ['-C', this.dir, '-c', 'user.email=jingqi@local', '-c', 'user.name=jingqi', 'commit', '-qm', String(message || '快照')],
        { timeout: 5000, stdio: 'ignore' },
      )
      return true
    } catch {
      return false
    }
  }

  all() {
    return this.ids().map((id) => this.get(id)).filter(Boolean)
  }

  /** 被想起：衰减到此刻 + 加成，写回，并记一笔账（用进废退可回查）。 */
  touch(id, now = Date.now(), cue = '', { dedupeMs = 0 } = {}) {
    const card = this.get(id)
    if (!card) return undefined
    // 召回路径会传 dedupeMs：同一轮里同一张卡被召回多次时（实测 91ms 内加两次 +0.6），
    // 窗口内不重复加成、也不重复记账。直接调 touch 不带参数时行为不变。
    if (dedupeMs > 0) {
      this._lastTouch ||= new Map()
      const prev = this._lastTouch.get(id) || 0
      if (now - prev < dedupeMs) return card
      this._lastTouch.set(id, now)
    }
    // 记账里的 from 用「活重量」：pinned 卡没有衰减，别在账本里给自己造一段假跌幅。
    const before = this.weigh(card, now)
    // pinned 的卡不走 rehearse：rehearse 先按天数衰减再加成，会把「200 天没碰的 pin」写成 0.6（复核实测），
    // 一旦哪天解钉，真实重量就只剩那点。这里只把 last_hit 推到现在、重量守在 pinWeight 以上。
    const next = card.pinned === true ? null : rehearse(card.weight, card.last_hit, now, this.heat)
    const weight = next ? next.weight : Math.min(this.heat.maxWeight, Math.max(this.heat.pinWeight ?? this.heat.maxWeight, card.weight))
    const lastHit = next ? next.lastHit : now
    const saved = this.put({ ...card, weight, last_hit: lastHit })
    this.logRehearsal({ id, from: before, to: this.weigh(saved, now), cue, at: now })
    return saved
  }

  // ── 用进废退的账本 ──────────────────────────────────────────────────────
  logRehearsal({ id, from = 0, to = 0, cue = '', at = Date.now() }) {
    this.ensure()
    const line = JSON.stringify({
      at: new Date(at).toISOString(),
      id,
      from: Number(Number(from).toFixed(3)),
      to: Number(Number(to).toFixed(3)),
      cue: String(cue || '').slice(0, 60),
    })
    appendFileSync(this.rehearsalPath, `${line}\n`)
  }

  /** id → 被想起过几次。 */
  rehearsalsMap() {
    this.ensure()
    const map = new Map()
    try {
      for (const raw of readFileSync(this.rehearsalPath, 'utf8').split('\n').filter(Boolean)) {
        let entry
        try { entry = JSON.parse(raw) } catch { continue }
        map.set(entry.id, (map.get(entry.id) || 0) + 1)
      }
    } catch {}
    return map
  }

  // ── 原话流水（只增不改，回查证据用）───────────────────────────────────────
  appendStream(payload) {
    this.ensure()
    return appendStream(this, payload)
  }

  searchStream(cue, opts = {}) {
    this.ensure()
    return searchStream(this, cue, opts)
  }

  streamSize() {
    this.ensure()
    return streamSize(this)
  }

  streamFirstAt() {
    this.ensure()
    return streamFirstAt(this)
  }

  streamFirstKey() {
    this.ensure()
    return streamFirstKey(this)
  }

  // ── 按量做梦的记忆点：上次梦到 stream 第几行、什么时候（2026-11-12）──────
  dreamState() {
    this.ensure()
    return readJson(join(this.dir, 'dream.state.json'), null)
  }

  setDreamState(state) {
    this.ensure()
    writeAtomic(join(this.dir, 'dream.state.json'), JSON.stringify({ ...state }, null, 1))
    return state
  }

  // ── 折叠自知：刚被压掉多少，这是本鲸自己记的账 ──────────────────────────
  recordCompaction({ tokens = 0, seqStart = null, seqEnd = null, at = Date.now() } = {}) {
    this.ensure()
    const entry = {
      at: new Date(at).toISOString(),
      tokens: Number(tokens) || 0,
      seqStart: seqStart ?? null,
      seqEnd: seqEnd ?? null,
    }
    appendFileSync(this.compactionPath, `${JSON.stringify(entry)}\n`)
    return entry
  }

  lastCompaction() {
    this.ensure()
    const lines = readFileSync(this.compactionPath, 'utf8').split('\n').filter(Boolean)
    if (lines.length === 0) return null
    try {
      return JSON.parse(lines[lines.length - 1])
    } catch {
      return null
    }
  }

  /** 只读地看此刻的重量，不写盘（pinned 的卡不走衰减）。 */
  weigh(card, now = Date.now()) {
    return liveWeightOf(card, now, this.heat)
  }

  // ── 因果链（BV1VqxW6xEJx）：压缩不掉的那一段 ─────────────────────────────
  appendChain(role, text, opts = {}) {
    this.ensure()
    const stamp = opts.at || nowIso()
    const who = role === 'owner' ? '主人' : '本鲸'
    const maxChars = opts.maxChars ?? 200
    const flat = String(text || '').replace(/\s+/g, ' ').trim()
    const clean = flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat
    if (!clean) return
    writeFileSync(this.chainPath, `${stamp} ${who}: ${clean}\n`, { flag: 'a' })
  }

  chainTail(lines = 20) {
    this.ensure()
    // 负数会被 slice 当成「从尾部倒数」的反面（slice(-5) 是 slice(5)？不，slice(5) 是去掉前 5 行），
    // 传 -5 原本返回除前 5 行外的全部，注入会撑爆（2026-11-21 #34）。
    const n = Number.isFinite(Number(lines)) ? Math.max(0, Math.trunc(Number(lines))) : 20
    if (n === 0) return []
    const all = readFileSync(this.chainPath, 'utf8').split('\n').filter(Boolean)
    return all.slice(-n)
  }

  chainSize() {
    this.ensure()
    return readFileSync(this.chainPath, 'utf8').split('\n').filter(Boolean).length
  }

  // ── 自我笔记（限 40 条，满了挤掉最旧的）──────────────────────────────────
  addSelfNote(text, at = nowIso()) {
    this.ensure()
    const all = this.selfNotes()
    all.push({ at, text: String(text).trim() })
    const kept = all.slice(-SELF_NOTE_CAP)
    // 整文件重写必须原子：写一半被杀，下次 selfNotes() 解析就炸，而它每轮都会被注入。
    writeAtomic(this.selfNotePath, kept.map((n) => JSON.stringify(n)).join('\n') + '\n')
    return { kept: kept.length, cap: SELF_NOTE_CAP }
  }

  selfNotes() {
    this.ensure()
    return readFileSync(this.selfNotePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)]
        } catch {
          return [] // 坏行跳过，别让一行坏数据毁掉每轮注入
        }
      })
  }

  // ── 人格：底色 + 当前状态（跨会话，状态带历史）───────────────────────────
  persona() {
    this.ensure()
    // 2026-11-14 审查（中）：坏 JSON 以前静默退成空人格——底色整段消失，还没人知道。
    // 现在留一份坏文件、打一行警告，再退默认值；之后 setPersona 覆盖时至少能从 .bad-* 里找回底色。
    try {
      const parsed = JSON.parse(readFileSync(this.personaPath, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed
      throw new Error('persona.json 不是对象')
    } catch (err) {
      try {
        // 固定文件名、只备一次：坏文件没修好之前每轮装配都会走到这里，按时间戳命名会堆出一串备份。
        const bad = `${this.personaPath}.bad`
        if (!existsSync(bad)) writeFileSync(bad, readFileSync(this.personaPath))
        console.warn(`[cyber-hippocampus] persona.json 解析失败，原始文件留在 ${bad}：`, err?.message || err)
      } catch { /* 连备份都失败就只打日志 */ }
      return { base: '', state: '', history: [] }
    }
  }

  setPersona({ base, state, note = '' } = {}) {
    const p = this.persona()
    if (typeof base === 'string' && base.trim()) p.base = base.trim()
    if (typeof state === 'string' && state.trim() && state.trim() !== p.state) {
      if (p.state) p.history.push({ at: nowIso(), state: p.state, note: String(note).slice(0, 200) })
      p.state = state.trim()
    }
    p.history = (p.history || []).slice(-30)
    writeAtomic(this.personaPath, JSON.stringify(p, null, 1))
    return p
  }
}
