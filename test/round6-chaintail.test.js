// 因果链尾只读文件尾部 64KB：长跑几年后 chain.txt 到几 MB，只拿最后 20 行不该读全文件（2026-11-21 #23）。
// 这条是等价性回归保护（旧实现也绿），验的是「尾部读法」与「全读再切片」结果一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'

test('chain.txt 超过 64KB 时，chainTail 与全读结果一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-chaintail-'))
  try {
    const store = new HippocampusStore(dir)
    store.ensure()
    const pad = '细'.repeat(120)
    for (let i = 0; i < 1200; i += 1) appendFileSync(store.chainPath, '2026-11-21T00:00:00.000Z 主人: ' + pad + i + String.fromCharCode(10))
    const all = readFileSync(store.chainPath, 'utf8').split(String.fromCharCode(10)).filter(Boolean)
    assert.ok(all.length > 20)
    assert.deepEqual(store.chainTail(20), all.slice(-20))
    assert.deepEqual(store.chainTail(3), all.slice(-3))
    assert.deepEqual(store.chainTail(0), [])
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  }
})
