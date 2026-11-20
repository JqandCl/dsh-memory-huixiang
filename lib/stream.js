// 原话流水：一句一句落盘，只增不改。
// 摘要会骗人，原话不会 —— 记不清当时怎么说的，就来这里按行号回查（借 dsh-hippocampus 0.2.40 的思路）。
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tokenize, truncate, tokenWeight, containsToken } from './recall.js'

export const STREAM_FILE = 'stream.jsonl'
const COUNT_FILE = 'stream.count'
const MAX_CHARS = 4000 // 单条上限：整段视频转写那种不塞，只留开头

const pathOf = (store) => join(store.dir, STREAM_FILE)
const countPathOf = (store) => join(store.dir, COUNT_FILE)

function nextNo(store) {
  // 原来先写计数文件再 append：两步之间被杀 → 计数虚高、行号跳号；计数文件被截断 → 归零重号。
  // 现在直接数已有行数，慢一点但不会骗人（千行级别，可忽略）。
  try {
    const all = readFileSync(pathOf(store), 'utf8')
    return all ? all.split('\n').filter(Boolean).length + 1 : 1
  } catch {
    return 1
  }
}

/** 落一行原话，返回行号（从 1 开始）。空话不落。 */
export function appendStream(store, { role = 'owner', text = '', sessionId = '', at = Date.now() } = {}) {
  const clean = String(text || '').replace(/\r/g, '').trim()
  if (!clean) return 0
  const body = clean.length > MAX_CHARS ? `${clean.slice(0, MAX_CHARS)}…(截断)` : clean
  const n = nextNo(store)
  const line = JSON.stringify({ n, at: new Date(at).toISOString(), role, sid: String(sessionId || ''), text: body })
  appendFileSync(pathOf(store), `${line}\n`, { mode: 0o600 })
  return n
}

export function streamLines(store) {
  try {
    return readFileSync(pathOf(store), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

export function streamSize(store) {
  return streamLines(store).length
}

/** 第一行的落盘时间（毫秒）。判「流水被删/重建」用：正常追加时第一行永远是最早那句。 */
export function streamFirstAt(store) {
  const line = streamLines(store)[0]
  if (!line) return 0
  try {
    const at = Date.parse(JSON.parse(line).at || '')
    return Number.isFinite(at) ? at : 0
  } catch {
    return 0
  }
}

/** 首行身份（首行原文的短摘要）。判「流水被删/重建」用：只比「第一行还是不是原来那一行」，
 *  不看时钟先后 —— 同毫秒重建、或首行时间戳落在未来，都不会让水位判错（2026-11-21 千问第二轮 N1/B6R/N2）。 */
export function streamFirstKey(store) {
  const line = streamLines(store)[0]
  if (!line) return ''
  return createHash('sha1').update(line).digest('hex').slice(0, 16)
}

/** 按线索回查原话；命中按「词重合度 + 越新越靠前」排。 */
export function searchStream(store, cue, opts = {}) {
  const limit = opts.limit ?? 3
  const q = tokenize(cue)
  if (q.size === 0) return []
  const hits = []
  for (const raw of streamLines(store)) {
    let line
    try {
      line = JSON.parse(raw)
    } catch {
      continue
    }
    const bag = tokenize(line.text)
    let overlap = 0
    for (const t of q) if (bag.has(t)) overlap += 1
    if (overlap === 0) continue
    hits.push({
      no: line.n,
      at: line.at,
      role: line.role,
      score: Number((overlap / q.size).toFixed(2)),
      excerpt: truncate(line.text, 180),
    })
  }
  hits.sort((a, b) => b.score - a.score || b.no - a.no)
  return hits.slice(0, limit)
}

/** 本地日期（UTC+8 的 23:30 与次日 00:30 不该算同一天；2026-11-14 复核指出只切 UTC 会少计场合）。 */
export function localDay(at) {
  try {
    return new Date(at).toLocaleDateString('en-CA')
  } catch {
    return String(at || '').slice(0, 10)
  }
}

/** 某件事在原话里出现过几个「不同日子」（2026-11-14 写卡门槛用）。
 *  判据：卡里的实词（两字以上）同一行里至少命中 minHit 个；到处都有的词（df > maxDf）先剔掉，
 *  免得「今天」「一次」把任何一句话都凑成「又碰到一次」（复核实测：逐字重复才数得出、同义复述数成 0）。
 *  收的是「同义复述也能凑够」这一侧：只要两个实词撞上就算碰到过。 */
export function occasionDays(store, text, { minHit = 2, maxDf = 0.3, maxTokens = 12 } = {}) {
  const tokens = [...new Set([...tokenize(text)].filter((t) => tokenWeight(t) >= 0.8))].slice(0, maxTokens)
  if (tokens.length === 0) return { days: [], tokens: [] }
  const lines = []
  for (const raw of streamLines(store)) {
    try {
      lines.push(JSON.parse(raw))
    } catch {}
  }
  if (lines.length === 0) return { days: [], tokens }
  const df = new Map(tokens.map((t) => [t, 0]))
  const rows = []
  for (const line of lines) {
    const s = String(line.text || '').toLowerCase()
    const hit = tokens.filter((t) => containsToken(s, t))
    for (const t of hit) df.set(t, df.get(t) + 1)
    rows.push({ at: line.at, hit })
  }
  // 小库（<20 行）不做 df 过滤，否则新环境永远凑不齐。
  const kept = lines.length >= 20 ? tokens.filter((t) => df.get(t) / lines.length <= maxDf) : tokens
  // 只剩一个实词时不算「见过多次」：单 token 太容易撞上（复核实测「测试门槛甲」就因为「测试」两字在多天出现而误放行）。
  // 降级成临时卡是保守方向——卡还在，30 天后还在就给长期。
  if (kept.length < minHit) return { days: [], tokens: kept }
  const need = minHit
  const days = new Set()
  for (const { at, hit } of rows) {
    if (hit.filter((t) => kept.includes(t)).length < need) continue
    days.add(localDay(at))
  }
  return { days: [...days], tokens: kept, need }
}

/** 兜底用的「原话线索」：用实词在流水里找，命中过半才算（2026-11-14 复核后从 searchStream 挪出来——
 *  那个函数会把单字也算进分母，'南极 企鹅 绒鸭' 这种词明明同时在，却永远够不到 0.5）。
 *  门槛是「至少撞上一个罕见词」：线索本来就是低置信的，宁可给一句带 case 的原话，也别因为另一个词不在就全丢。 */
export function streamLeads(store, cue, { limit = 3, minHit = 1, maxDf = 0.15 } = {}) {
  const tokens = [...new Set([...tokenize(cue)].filter((t) => tokenWeight(t) >= 0.8))].slice(0, 10)
  if (tokens.length === 0) return []
  const lines = []
  for (const raw of streamLines(store)) {
    try {
      lines.push(JSON.parse(raw))
    } catch {}
  }
  if (lines.length === 0) return []
  const df = new Map(tokens.map((t) => [t, 0]))
  const rows = []
  for (const line of lines) {
    const s = String(line.text || '').toLowerCase()
    const hit = tokens.filter((t) => containsToken(s, t))
    for (const t of hit) df.set(t, df.get(t) + 1)
    rows.push({ line, hit })
  }
  const kept = lines.length >= 20 ? tokens.filter((t) => (df.get(t) || 0) / lines.length <= maxDf) : tokens
  if (kept.length === 0) return []
  const need = Math.min(minHit, kept.length)
  const hits = []
  for (const { line, hit } of rows) {
    const matched = hit.filter((t) => kept.includes(t))
    if (matched.length < need) continue
    hits.push({
      from: 'stream',
      lowConfidence: true,
      no: line.n,
      at: line.at,
      role: line.role,
      score: Number((matched.length / kept.length).toFixed(2)),
      matched,
      excerpt: truncate(line.text, 180),
    })
  }
  hits.sort((a, b) => b.score - a.score || b.no - a.no)
  return hits.slice(0, limit)
}