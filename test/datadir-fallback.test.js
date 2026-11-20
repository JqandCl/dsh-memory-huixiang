import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDefaultDataDir } from '../lib/store.js'

// 2026-11-20 改名 dsh-memory-huixiang：新目录叫 huixiang，但老库在 cyber-hippocampus/ 下不能因此消失。
// 用 DSH_HOME 指到临时目录来测四种情形（真 ~/.dsh 不碰）。

const withHome = (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'hc-home-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { return fn(home) } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
}

test('新老目录都没有：用新目录 huixiang', () => {
  withHome((home) => {
    assert.equal(resolveDefaultDataDir(), join(home, 'huixiang'))
  })
})

test('旧目录有卡、新目录不存在：继续用旧目录', () => {
  withHome((home) => {
    mkdirSync(join(home, 'cyber-hippocampus', 'notes'), { recursive: true })
    writeFileSync(join(home, 'cyber-hippocampus', 'notes', 'm-1.md'), 'x')
    assert.equal(resolveDefaultDataDir(), join(home, 'cyber-hippocampus'))
  })
})

test('旧目录只有空壳（没有 notes）：用新目录，不继承空壳', () => {
  withHome((home) => {
    mkdirSync(join(home, 'cyber-hippocampus'), { recursive: true })
    assert.equal(resolveDefaultDataDir(), join(home, 'huixiang'))
  })
})

test('新目录已存在：优先新目录（手动迁移过就按新的走）', () => {
  withHome((home) => {
    mkdirSync(join(home, 'cyber-hippocampus', 'notes'), { recursive: true })
    mkdirSync(join(home, 'huixiang', 'notes'), { recursive: true })
    assert.equal(resolveDefaultDataDir(), join(home, 'huixiang'))
  })
})