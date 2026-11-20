// 按量做梦：不等定时器，stream 每新增 N 行就整理一次（2026-11-12）。
// 为什么按量：闲不闲跟「攒了多少事」没关系，攒够 20 句话就是该归一次的时候。
// 冷启动保护：第一次跑只在没梦过时补一次，不追着历史把 900 多行一次全梦完。
import { dreamPass } from './dream.js'

export const DREAM_DEFAULTS = {
  everyLines: 20,          // stream 新增这么多行就梦一次
  cooldownMs: 60 * 60_000, // 一小时最多梦一次（防止一句话一句话地连刷）
  dryRun: false,           // 默认真写：整理出的 insight 落盘
}

/**
 * 到点了就梦一次。返回 { ran, ... }，调用方只负责打日志。
 * 不抛异常：做梦失败不能影响对话。
 */
export function maybeDream(store, opts = {}, now = Date.now()) {
  const cfg = { ...DREAM_DEFAULTS, ...opts }
  try {
    const total = store.streamSize()
    const st = store.dreamState()
    // stream.jsonl 被删/重建（README 教用户删原话的隐私操作）后行数水位失效。
    // 判据两条，任一成立就基线归零，否则自动做梦会停摆（2026-11-21 B6）：
    //   ① 现在比上次梦时还少；② 第一行不是上次梦时那一行了（比首行摘要，不看时钟先后）。
    // 为什么不用「首行时间比上次梦新」：同毫秒重建会漏判，首行时间戳落在未来会永久误判，两种都会
    // 让水位失效、自动做梦停摆或空转（2026-11-21 千问第二轮 B6R/N2）。
    const firstKey = store.streamFirstKey?.() || ''
    const reset = total < (Number(st?.line) || 0) || Boolean(st?.firstKey && firstKey && st.firstKey !== firstKey)
    const last = reset ? 0 : (Number(st?.line) || 0)
    const fresh = total - last
    if (fresh < cfg.everyLines) return { ran: false, reason: 'below-threshold', fresh, total, last }
    const lastAt = st?.at ? Date.parse(st.at) : 0
    // 时间戳落在未来（手动改时间/NTP 回拨）时不进冷却：否则要一直等到那个「未来」才肯再梦（2026-11-21 #32）。
    const lastAtUsable = Number.isFinite(lastAt) && lastAt > 0 && lastAt <= now + 60_000
    if (lastAtUsable && now - lastAt < cfg.cooldownMs) {
      return { ran: false, reason: 'cooldown', fresh, total, last, waitMs: cfg.cooldownMs - (now - lastAt) }
    }
    const result = dreamPass(store, { dryRun: cfg.dryRun })
    // 先梦再记账：梦崩了就把记忆点留着，下次还会重来，不会「以为梦过了」。
    store.setDreamState({ line: total, at: new Date(now).toISOString(), wrote: result.wrote, firstKey })
    return { ran: true, fresh, total, ...result }
  } catch (err) {
    return { ran: false, reason: 'error', error: String(err?.message || err) }
  }
}
