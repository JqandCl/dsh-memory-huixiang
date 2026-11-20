// 梦游整理（BV1dDxC67Ep3）：闲下来时按主题把散的事件归成一句话，
// 但**保留来源、保留矛盾**，不把两条冲突的记忆强行合成一个说法。
// 这里故意不调模型：先把结构跑通，谁来写「概括」以后可以换成本鲸自己。
import { tokenize, isDead } from './recall.js'

const DAY = 86_400_000

// 归纳条目得是整句（11-14 复核：原先 slice(0,60) 把 16 张归纳卡、37 条来源行全截在半句）。
// 现在按句末标点收口（中英文都认），最长 120 字；退到逗号/英文空格，再不行硬截，结果长度不超过 max。
export const ITEM_MAX = 120
const SENTENCE_ENDS = '。！？；…!?;'
const COMMA_ENDS = '，、,'
const OPENERS = '（「『【《(〔['
export function clipItem(text, max = ITEM_MAX) {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : ITEM_MAX
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (s.length <= limit) return s
  const win = s.slice(0, limit)
  // 1) 句末标点收口；太靠前的标点不算，免得只剩半句
  let end = -1
  for (let i = win.length - 1; i >= 0; i -= 1) if (SENTENCE_ENDS.includes(win[i])) { end = i; break }
  if (end >= 20) return win.slice(0, end + 1)
  // 2) 退到逗号；英文没有逗号就退到最后一个空格
  let cut = -1
  for (let i = win.length - 1; i >= 20; i -= 1) if (COMMA_ENDS.includes(win[i])) { cut = i; break }
  if (cut < 20) {
    const sp = win.lastIndexOf(' ')
    cut = sp >= 20 ? sp : limit - 1
  }
  let head = win.slice(0, cut)
  // 别停在开括号/空格上，也别把 emoji 的代理对切成一半
  while (head && (OPENERS.includes(head[head.length - 1]) || head[head.length - 1] === ' ')) head = head.slice(0, -1)
  const last = head.charCodeAt(head.length - 1)
  if (head && last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1)
  return `${head}…`
}


// ── 体积闸（2026-11-16）─────────────────────────────────────────────
// 归纳卡的意义是「把一堆事压薄」，不是把原文再抄一遍。
// 原来每条固定 clip 到 120 字，原文短的时候归纳反而更厚（5 条小事能写出 700 字），
// 进了注入就是拿新长出来的卡去挤真东西。现在按原文总量算预算，写不进去就少写几条。
// 阈值不是拍脑袋：2026-11-16 量了真库 14 天内可归纳的 17 组，原文总量 188–665 字（中位 470）。
// 闸设 400 会砍掉 5/17；设 150 一组不漏，又仍能挡住「两三条十几字的小事」。
export const SRC_MIN_CHARS = 150      // 原文太薄就别归纳：压不薄，写了只是重说一遍
export const INSIGHT_RATIO = 0.6      // 归纳正文 ≤ 它引用的原文总长的 60%
// 地板按实测的两个条目的最小开销定：head 20 + 两条(2×24 字 + 2×27 字 id/来源) + tail 12 ≈ 136，取 140。
// 原来是 100，会让 112、114 这种预算白白走一遍 buildInsightBody 再落回「装不下」。
export const INSIGHT_MIN_BUDGET = 140 // 预算低于这个数也不写，写出来只剩个标题壳（至少得放得下两条）
export const INSIGHT_CAP = 1200       // 绝对上限（注入侧也会截，别让它无限长）

/**
 * 按预算拼归纳正文：先按平常宽度整组写，装不下就把每条压窄，再装不下就少列几条，
 * 被裁掉的那些在正文里留 id 指针——**原文一条不删**，顺着 id 能回原卡。
 */
// 从正文里扒来源 id（旧卡没有 sourceIds 字段时的退路）：只认「（来源 X，id）」这个格式。
// ⚠️ 体积闸裁过的正文里，被裁的条目只剩「另有 N 条…：id、id」那种裸 id，这个正则抓不到——
// 所以新卡优先读 sourceIds，别指望正文（2026-11-16 只读复核指出过这个洞）。
export function idsFromBody(text) {
  return new Set([...String(text || '').matchAll(/（来源 [^，]+，([A-Za-z0-9\u4e00-\u9fff_-]+)）/gu)].map((m) => m[1]))
}

/** 一张卡记着的来源 id：有结构化 sourceIds 就用它，旧卡才退回正文正则。 */
export function sourceIdSet(card) {
  return Array.isArray(card.sourceIds) && card.sourceIds.length
    ? new Set(card.sourceIds)
    : idsFromBody(card.body)
}

export function buildInsightBody(tag, list, conflicts, budget) {
  const head = `这一阵关于「${tag}」攒了 ${list.length} 件事：`
  const tail = conflicts.length
    ? `其中 ${conflicts.join('、')} 还跟别的说法打架，先并排放着，不替谁圆。`
    : '暂时没有互相打架的说法。'
  const line = (c, max) => `- ${clipItem(String(c.body || '').split('\n')[0], max) || '（无正文）'}（来源 ${c.source === 'owner' ? '主人亲口' : '本鲸推的'}，${c.id}）`
  for (const max of [ITEM_MAX, 60, 40, 24]) {
    const body = [head, ...list.map((c) => line(c, max)), tail].join('\n')
    if (body.length <= budget) return body
  }
  // 再装不下就少列几条，被裁掉的留 id 指针。注意「另有 N 条」那行本身也要算进预算
  // （2026-11-16 自查抓到：第一版漏算这行，150 字的预算写出了 179 字）。
  const build = (arr, rest) => {
    const lines = [head, ...arr.map((c) => line(c, 24))]
    if (rest.length) lines.push(`…另有 ${rest.length} 条没挤进来，按 id 回原文看：${rest.map((c) => c.id).join('、')}`)
    lines.push(tail)
    return lines.join('\n')
  }
  // 只塞得进一条就别写了：一句话加个指针不叫归纳，不如让人直接看原文。
  for (let k = list.length; k >= 2; k -= 1) {
    const body = build(list.slice(0, k), list.slice(k))
    if (body.length <= budget) return body
  }
  return ''
}

export function dreamPass(store, opts = {}) {
  const now = opts.now ?? Date.now()
  const lookbackDays = opts.lookbackDays ?? 14
  const minGroup = opts.minGroup ?? 2
  const dryRun = opts.dryRun !== false // 默认只演练，落盘得明说
  // 全库只扫一次（11-14 审查：以前每个 tag 组都 store.all()，真库 17 次全库扫、阻塞 1.9–5.9 秒）。
  const allCards = store.all()
  const insightsAll = allCards.filter((c) => c.kind === 'insight')
  // 死卡不进归纳：被接替/已过期的旧说法若经 insight 复活，等于绕过全部死卡闸门（2026-11-21 B2）。
  const cards = allCards.filter((c) => c.kind === 'experience' && !isDead(c, now) && c.created && now - Date.parse(c.created) <= lookbackDays * DAY)

  const groups = new Map()
  for (const card of cards) {
    for (const tag of card.tags || []) {
      if (!groups.has(tag)) groups.set(tag, [])
      groups.get(tag).push(card)
    }
  }

  const insights = []
  const skipped = []
  for (const [tag, list] of groups) {
    if (list.length < minGroup) continue
    // 同组里如果已经有一条针对这个标签的概括，就不再重复写。
    // 2026-11-20：这条以前是静默 continue，skipped 里看不见——「梦游为什么没归」说不清。
    // 现在照样跳过，但把理由进分类（C2 验收要的是「skip 理由分类」完整可读）。
    const sameTag = insightsAll.find((c) => (c.tags || []).includes(tag))
    if (sameTag) {
      skipped.push({ tag, reason: `已有同族归纳卡 ${sameTag.id}，不重复归`, twin: sameTag.id })
      continue
    }
    const ids = list.map((c) => c.id)
    const conflicts = list.filter((c) => c.conflict).map((c) => c.id)
    // 体积闸：先算它引用的原文多厚，归纳不许比原文还厚（2026-11-16）。
    const srcChars = list.reduce((n, c) => n + String(c.body || '').length, 0)
    if (srcChars < SRC_MIN_CHARS) {
      skipped.push({ tag, reason: `原文太薄（${srcChars} 字），压不薄就不归纳`, srcChars })
      continue
    }
    const budget = Math.min(INSIGHT_CAP, Math.floor(srcChars * INSIGHT_RATIO))
    if (budget < INSIGHT_MIN_BUDGET) {
      skipped.push({ tag, reason: `预算只剩 ${budget} 字，装不下两条`, srcChars })
      continue
    }
    const body = buildInsightBody(tag, list, conflicts, budget)
    if (!body) {
      skipped.push({ tag, reason: `预算 ${budget} 字装不下两条（原文 ${srcChars} 字）`, srcChars })
      continue
    }
    const insight = {
      id: `ins-${tag.replace(/[^\w\u4e00-\u9fff]+/g, '')}-${Date.now().toString(36)}`,
      kind: 'insight',
      source: 'self',
      tags: [tag, '梦游整理'],
      title: `归纳：${tag}`,
      body,
      weight: 0.8,
      last_hit: now,
      conflict: conflicts.length > 0,
      // 原文指针（结构化）：归纳被裁剩几条也不丢来源，顺着 id 能回原卡。
      sourceIds: ids,
      // 归纳卡也得带边界（13:20 复核：dream 走 store.put，绕过了 hc_remember 的 boundaryDefaults，
      // 每做一次梦就多一张「两样都空」的卡，跟 POLICY_TEXT 自相矛盾）。
      condition: '只归纳这一阵攒下的事；新情况进来就可能不成立',
    }
    // 同题不等于同一张卡（11-14 审查 M3）：不同标签会各自归一次，条目高度重合就成了同质卡。
    // 落盘前挡一道：正文相似度 ≥0.9，或来源 id 集合高度重合（≥0.75 且相似度 ≥0.5），都算同一份整理。
    // 第二判据是 11-14 只读复核补的：库里还留着 60 字截断的旧归纳卡时，正文相似度只有 0.88，会漏。
    // 两边都走 sourceIdSet：新卡读 sourceIds（体积闸会把条目压短，被裁掉的只留在「另有 N 条」那行，
    // 「（来源 X，id）」正则抓不到，2026-11-16 只读复核指出过这个洞），旧卡才退回正文。
    const myIds = new Set(ids)
    const twin = insightsAll
      .map((c) => {
        const sim = bodySimilar(body, c.body)
        const other = sourceIdSet(c)
        let inter = 0
        for (const id of myIds) if (other.has(id)) inter += 1
        const idOverlap = myIds.size + other.size ? (2 * inter) / (myIds.size + other.size) : 0
        return { c, sim, idOverlap }
      })
      .filter((x) => x.sim >= 0.9 || (x.idOverlap >= 0.75 && x.sim >= 0.5))
      .sort((a, b) => b.sim + b.idOverlap - (a.sim + a.idOverlap))[0]
    if (twin) {
      if (!dryRun) store.touch(twin.c.id, now, 'dream-dup')
      skipped.push({ tag, sim: Number(twin.sim.toFixed(2)), idOverlap: Number(twin.idOverlap.toFixed(2)), twin: twin.c.id })
      continue
    }
    if (!dryRun) store.put(insight)
    // 这一趟新写的也要进快照，否则同一趟里后面的标签组撞不出孪生，会再写一张同质卡（13:20 复核实测 0.951）。
    insightsAll.push(insight)
    insights.push({ tag, from: ids, id: insight.id, conflicts })
  }
  return { wrote: insights.length, insights, skipped }
}

/**
 * 两张 insight 正文的字符二元组 Jaccard（11-14 审查 M3 用的就是这把尺子，实测同质卡 0.96/0.98）。
 * 先去掉所有空白，避免换行/缩进把同一句话判定成两句。
 */
export function bodySimilar(a, b) {
  const grams = (s) => {
    const t = String(s || '').replace(/\s+/g, '')
    const set = new Set()
    for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2))
    return set
  }
  const A = grams(a)
  const B = grams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 给「检索键」用：把一张卡压成一行，方便 grep。 */
export function indexLine(card) {
  return [`#${card.id}`, card.kind, card.source, (card.tags || []).join(','), String(card.body || '').replace(/\s+/g, ' ').slice(0, 80)].join(' | ')
}

export { tokenize }
