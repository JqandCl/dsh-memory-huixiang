// 文件写锁：同一份库可能被工具调用与夜间整理同时写（BV14qxL6WEGZ 评论区那条「两个进程抢写」的坑）。
// 用 O_EXCL 建锁文件，拿不到就短暂自旋；超过 LOCK_STALE_MS 的锁视为前任崩了，抢过来清掉。
// 原来长在 store.js 里，2026-11-21 抽出来给 stream.js 的 appendStream 也用（#29 多进程重号）。
//
// 2026-11-21 复核 P2 修的三处：
//   ① 等待时间原来 3s、比过期判定 10s 还短 —— 崩溃留下的锁，在 3~10s 窗口里同一路径的写全部失败
//      「写锁超时」。现在等得比过期久，能自己等到锁被回收。
//   ② 过期锁不再直接 rm：先 rename 抢所有权，抢到的那一个才删。直接 rm 会出现
//      「A 判定过期、B 也判定过期、A 把 B 刚建的新锁删掉」→ 两个人同时持锁。
//   ③ finally 不再无条件 rm：读回来确认还是自己那把再删，免得把别人抢到的新锁带走。
//
// 已知边界：持锁期间不刷新 mtime，所以单个临界区超过 LOCK_STALE_MS 会被别人当过期抢走。
// 现在所有临界区都是毫秒级（store.put 约 4.5ms、dreamPass 300 张卡约 170ms），留个注释在这儿。
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'

export const LOCK_WAIT_MS = 15_000
export const LOCK_STALE_MS = 10_000

export function withLock(path, fn) {
  const lock = `${path}.lock`
  // 每把锁有自己的名字：判「这锁还是不是我的」靠它，不靠 pid（同一进程可能持有过同名多把）。
  const token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const start = Date.now()
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: 'wx' })
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let stale = false
      try {
        stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS
      } catch {
        // 锁刚好被别人回收了：直接重试，别当成过期去 rename。
        continue
      }
      if (stale) {
        const grave = `${lock}.stale-${token}`
        try {
          renameSync(lock, grave)
          rmSync(grave, { force: true })
        } catch {
          // 别人抢先改名了，这颗不归我，回到循环重抢。
        }
        continue
      }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`写锁超时：${lock}`)
      // 原来的同步空转会把整个 agent 循环卡住；用 Atomics.wait 真睡 20ms。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    return fn()
  } finally {
    try {
      if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true })
    } catch {
      // 锁已经没了或被别人接管：什么都别做，绝不能顺手删掉别人的。
    }
  }
}
