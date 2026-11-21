// 整句拆解：把「昨晚南瓜鸡最后一句说的什么」拆成「谁 · 什么时候 · 实词 · 要不要最近的」。
// 纯规则、不调模型，零成本；拆错了在结果第一行写回去，一眼看得见（借 dsh-memory-vault 1.6.0 的思路）。
import { tokenize } from './recall.js'

const DAY_MS = 86_400_000
const midNight = (t) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// 时间词 → 相对今天的天数偏移
const DAY_WORDS = [
  // 大前天必须排在「前天」前面：先命中长的，否则「大前天」被拆成「大」+ 前天（按 -2 天算，B5）。
  ['大前天晚上', -3], ['大前天', -3],
  ['前天晚上', -2], ['前天', -2],
  ['昨天晚上', -1], ['昨晚', -1], ['昨夜', -1], ['昨天', -1],
  ['今天早上', 0], ['今早', 0], ['今晚', 0], ['今天', 0], ['刚才', 0], ['刚刚', 0],
  ['上周', -7], ['上个月', -30],
]
const LATEST_WORDS = ['最后', '最近', '最新', '临了', '末尾']
const OWNER_WORDS = ['主人', '管理员']
const SELF_WORDS = ['本鲸', '自己']
const QUESTION_WORDS = ['什么', '怎么', '为啥', '为什么', '哪个', '谁', '吗', '呢', '是不是', '还记得', '记不记得', '说了', '说的', '那句', '一句', '话']

const stripAll = (text, words) => {
  let s = text
  for (const w of words) s = s.split(w).join(' ')
  return s
}

/** 拆一句线索。返回 { who, when, since, until, wantLatest, keywords, raw } */
export function parseCue(cue, now = Date.now()) {
  const raw = String(cue || '')
  const out = { who: [], when: '', since: null, until: null, wantLatest: false, keywords: [], raw }

  for (const [word, offset] of DAY_WORDS) {
    if (!raw.includes(word)) continue
    const base = midNight(now) + offset * DAY_MS
    out.since = base
    out.until = base + DAY_MS
    out.when = word
    break
  }
  if (!out.when) {
    const m = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/)
    if (m) {
      const d = new Date(now)
      d.setMonth(Number(m[1]) - 1, Number(m[2]))
      d.setHours(0, 0, 0, 0)
      // 2 月 30 日会滚成 3 月 2 日：不存在的日期就当没说，别拿错的一天去搜（2026-11-21 #31）。
      if (d.getMonth() === Number(m[1]) - 1 && d.getDate() === Number(m[2])) {
        out.since = d.getTime()
        out.until = out.since + DAY_MS
        out.when = `${m[1]}月${m[2]}日`
      }
    }
  }

  if (LATEST_WORDS.some((w) => raw.includes(w))) out.wantLatest = true
  if (OWNER_WORDS.some((w) => raw.includes(w))) out.who.push('主人')
  if (SELF_WORDS.some((w) => raw.includes(w))) out.who.push('本鲸')

  let rest = raw
  for (const [word] of DAY_WORDS) rest = rest.split(word).join(' ')
  rest = stripAll(rest, LATEST_WORDS)
  rest = stripAll(rest, OWNER_WORDS)
  rest = stripAll(rest, SELF_WORDS)
  rest = stripAll(rest, QUESTION_WORDS)
  out.keywords = [...tokenize(rest)].slice(0, 8)
  return out
}

/** 一句话把拆解结果说清楚，给人核对。 */
export function describeCue(parsed) {
  const bits = []
  if (parsed.when) bits.push(parsed.when)
  else if (parsed.wantLatest) bits.push('最近')
  if (parsed.who.length) bits.push(parsed.who.join('＋'))
  if (parsed.wantLatest && parsed.when) bits.push('要最近的')
  const kw = parsed.keywords.length ? `词：${parsed.keywords.join(' ')}` : '没剩下实词'
  return bits.length ? `${bits.join(' · ')}（${kw}）` : kw
}

/** 这张卡是否落在解析出来的时间窗里（用记下/被想起的时间近似）。 */
export function inWindow(card, parsed) {
  if (parsed.since === null) return false
  const stamps = [Date.parse(card.created || ''), Number(card.last_hit) || 0].filter((t) => t > 0)
  return stamps.some((t) => t >= parsed.since && t < parsed.until)
}
