// 文件写锁：同一份库可能被工具调用与夜间整理同时写（BV14qxL6WEGZ 评论区那条「两个进程抢写」的坑）。
// 用 O_EXCL 建锁文件，拿不到就短暂自旋；超过 10 秒的锁视为前任崩了，直接清掉。
// 原来长在 store.js 里，2026-11-21 抽出来给 stream.js 的 appendStream 也用（#29 多进程重号）。
import { rmSync, statSync, writeFileSync } from 'node:fs'

export const LOCK_WAIT_MS = 3000
export const LOCK_STALE_MS = 10_000

export function withLock(path, fn) {
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