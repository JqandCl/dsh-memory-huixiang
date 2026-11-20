// 记忆重量：艾宾浩斯式衰减 + 被想起就变重。
// 取自 BV121xg6kEqx 那条「记忆有重量，21 天担一半，被想起又会变重」。
export const DAY_MS = 86_400_000

export const DEFAULT_HEAT = {
  halfLifeDays: 21,   // 21 天掉一半
  initialWeight: 1,   // 新记下的重量
  rehearseBoost: 0.6, // 被想起来的加成
  maxWeight: 4,       // 再重要也不会无限变重
  hotAt: 0.55,        // >= 这数算热（会注入上下文）
  warmAt: 0.18,       // >= 这数算温（只在召回时出现）
  coldAfterDays: 120, // 这么久没想起，直接冷存（仍然可搜）
  pinWeight: 4,       // pinned 卡的常温重量：不衰减、也不看 idle（2026-11-11 加）
  dedupeWindowMs: 7 * 86_400_000, // 写侧去重窗口（11-14 从 6h 放宽到 7 天）：同一件事隔几天再记，只补字段+加权重，不新建
  floorFromWeight: 3.2, // 原始重量到这条线就算「底线级」（本名/忌口这类反复被想起的）
  floorWeight: 0.5,     // 底线级卡片的衰减地板：再久也不沉进冷库（2026-11-12 加）
}

/**
 * 是不是「底线级」——重量够高、没被显式 pin 的卡。
 * pin 是硬钉子（永远进上下文），地板只是不让它沉底：久了会退成「温的」，召回还找得到。
 */
export function isFloored(card, cfg = DEFAULT_HEAT) {
  if (!card || card.pinned === true) return false
  const w = Number.isFinite(card.weight) ? card.weight : 0
  const from = Number.isFinite(cfg.floorFromWeight) ? cfg.floorFromWeight : Infinity
  return w >= from
}

/**
 * 一张卡此刻的「活重量」。pinned 的卡（主人亲口定的几条底线）不看时间：
 * 不加这一步，本名/忌口删规矩这类 120 天没提起也会沉进冷库（2026-11-11 改）。
 */
export function liveWeightOf(card, now = Date.now(), cfg = DEFAULT_HEAT) {
  const w = Number.isFinite(card?.weight) ? card.weight : cfg.initialWeight
  if (card && card.pinned === true) return Math.min(cfg.maxWeight, Math.max(cfg.pinWeight ?? cfg.maxWeight, w))
  const decayed = decayedWeight(w, card?.last_hit, now, cfg.halfLifeDays)
  // 地板：够重的卡衰减到 floorWeight 就不再往下掉（2026-11-12）。
  if (isFloored(card, cfg)) return Math.max(decayed, Number(cfg.floorWeight) || 0)
  return decayed
}

/** 分档的卡片版：pinned 的卡永远当热（要进上下文），不受 coldAfterDays 影响。 */
export function tierOfCard(card, now = Date.now(), cfg = DEFAULT_HEAT) {
  if (card && card.pinned === true) return 'hot'
  // 地板卡不看「多久没想起」那条：120 天没提起也不许归档成冷（这就是加地板的原因）。
  if (isFloored(card, cfg)) return tierOf(liveWeightOf(card, now, cfg), now, now, cfg)
  return tierOf(liveWeightOf(card, now, cfg), card?.last_hit, now, cfg)
}

/** 按「上次被想起到现在过了多少天」衰减。now/lastHit 都是毫秒时间戳。 */
export function decayedWeight(weight, lastHitAt, now = Date.now(), halfLifeDays = DEFAULT_HEAT.halfLifeDays) {
  // 时间戳解析失败（0/NaN）当「现在」，别当成 1970 年 ⇒ 一进门就冷到底；
  // 时间戳在未来（手机改过时间）夹到 now，别让它永不衰减。
  const hit = Number.isFinite(lastHitAt) && lastHitAt > 0 ? Math.min(lastHitAt, now) : now
  const days = Math.max(0, (now - hit) / DAY_MS)
  const w = Number.isFinite(weight) ? weight : DEFAULT_HEAT.initialWeight
  return w * Math.pow(0.5, days / halfLifeDays)
}

/** 被想起：先衰减到此刻，再加成。返回 { weight, lastHit }。 */
export function rehearse(weight, lastHitAt, now = Date.now(), cfg = DEFAULT_HEAT) {
  const current = decayedWeight(weight, lastHitAt, now, cfg.halfLifeDays)
  return { weight: Math.min(cfg.maxWeight, current + cfg.rehearseBoost), lastHit: now }
}

/** 分档：hot（进上下文）/ warm（召回时给）/ cold（冷库，只搜不注入）。 */
export function tierOf(weight, lastHitAt, now = Date.now(), cfg = DEFAULT_HEAT) {
  const hit = Number.isFinite(lastHitAt) && lastHitAt > 0 ? Math.min(lastHitAt, now) : now
  const idleDays = (now - hit) / DAY_MS
  if (idleDays > cfg.coldAfterDays) return 'cold'
  if (weight >= cfg.hotAt) return 'hot'
  if (weight >= cfg.warmAt) return 'warm'
  return 'cold'
}

/** 全库重算一遍，返回按重量排序的视图（不落盘）。 */
export function rankCards(cards, now = Date.now(), cfg = DEFAULT_HEAT) {
  return cards
    .map((card) => {
      const weight = liveWeightOf(card, now, cfg)
      return { ...card, live_weight: weight, tier: tierOfCard(card, now, cfg) }
    })
    .sort((a, b) => b.live_weight - a.live_weight)
}

/**
 * 有效期的终点。只写到「天」的日期（2026-11-04）意味着「那天过完才算过期」，
 * 不是当天 00:00 —— 否则当天的事到中午就被判死（2026-11-09 修：值班卡当天中午就"过期"了）。
 */
export function expiryMs(validUntil) {
  const s = String(validUntil || '').trim()
  if (!s) return 0
  const day = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (day) {
    // 按本机时区算「那天 23:59:59.999」，别用 Date.parse（它把纯日期当 UTC 零点）。
    const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 59, 999)
    return Number.isFinite(d.getTime()) ? d.getTime() : 0
  }
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}
