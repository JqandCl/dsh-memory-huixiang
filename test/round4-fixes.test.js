// 第四轮：#1 日期口径（本地日期，不用 UTC）/ #8 Windows 保留名与尾随点。
// #9（Windows 上没有 bash）无法在本机复现，见 notes 里的说明，不写假测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSafeId } from '../lib/store.js'
import { localDay } from '../lib/stream.js'

const here = dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFileSync(join(here, '..', rel), 'utf8')

test('#1 生产代码里不再用 UTC 日期当「今天/到期日」', () => {
  for (const rel of ['index.js', 'lib/store.js']) {
    const text = src(rel)
    assert.ok(!text.includes('toISOString().slice(0, 10)'), rel + ' 里还有 UTC 截日期')
    assert.ok(!text.includes('toISOString().slice(0,10)'), rel + ' 里还有 UTC 截日期')
  }
})

test('#1 localDay 用的是本地时区，不随 UTC 漂', () => {
  const at = Date.now()
  assert.equal(localDay(at), new Date(at).toLocaleDateString('en-CA'))
  // 东八区：UTC 20:00 已经是本地第二天。这条在 TZ=UTC 也成立（两种算法相等），只锁形状。
  assert.match(localDay(at), /^\d{4}-\d{2}-\d{2}$/)
})

test('#8 Windows 设备名不能当卡 id（CON.md 也是设备）', () => {
  for (const bad of ['CON', 'con', 'nul', 'Aux', 'com1', 'LPT9', 'CON.md', 'nul.txt']) {
    assert.equal(isSafeId(bad), false, bad + ' 应该被拒')
  }
})

test('#8 尾随的点/空格不能当卡 id（Windows 会裁掉，撞名）', () => {
  for (const bad of ['foo.', 'foo ', 'foo. ']) assert.equal(isSafeId(bad), false, JSON.stringify(bad) + ' 应该被拒')
})

test('#8 正常 id 与含汉字的归纳卡 id 照旧放行', () => {
  for (const ok of ['m-mw7y78e4-aldt', 'ins-云州-mwp5qm0r', 'demo-allergy', 'a.b_c-d', 'console1', 'com10']) {
    assert.equal(isSafeId(ok), true, ok + ' 应该放行')
  }
})
