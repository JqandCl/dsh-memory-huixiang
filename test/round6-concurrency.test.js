// 多进程同时写原话流水：行号必须唯一（2026-11-21 #29，实测 8 进程 200 行只用了 88 个号）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { HippocampusStore } from '../lib/store.js'

const STORE = new URL('../lib/store.js', import.meta.url).href

function worker(dir, tag, n) {
  const code = [
    `const { HippocampusStore } = await import(${JSON.stringify(STORE)})`,
    "const { DIR, TAG, N } = process.env",
    'const store = new HippocampusStore(DIR)',
    'store.ensure()',
    'const nos = []',
    "for (let i = 0; i < Number(N); i++) nos.push(store.appendStream({ role: 'owner', text: '并发 ' + TAG + ' 第 ' + i + ' 行原话', sessionId: 'test' }))",
    'console.log(JSON.stringify(nos))',
  ].join('\n')
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DIR: dir, TAG: tag, N: String(n) } })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code2) => {
      if (code2 !== 0) return reject(new Error(`worker ${tag} 退出码 ${code2}: ${err.slice(0, 200)}`))
      try { resolve(JSON.parse(out.trim())) } catch (e) { reject(new Error(`worker ${tag} 输出不可解析: ${out.slice(0, 120)}`)) }
    })
  })
}

test('多进程同时 appendStream：行号不重复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-conc-test-'))
  try {
    const PROCS = 4, PER = 10
    const lists = await Promise.all(Array.from({ length: PROCS }, (_, i) => worker(dir, String(i), PER)))
    const all = lists.flat()
    assert.equal(all.length, PROCS * PER, '每个进程都该拿到行号')
    const uniq = new Set(all)
    assert.equal(uniq.size, PROCS * PER, `行号重复：${PROCS * PER} 行只有 ${uniq.size} 个不同的号`)
    const lines = readFileSync(join(dir, 'stream.jsonl'), 'utf8').split('\n').filter(Boolean)
    assert.equal(lines.length, PROCS * PER, '落盘行数应与写入次数一致')
    const fileNos = lines.map((l) => JSON.parse(l).n)
    assert.equal(new Set(fileNos).size, PROCS * PER, '落盘的行号也应唯一')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
// #17：put 是「读 prev → 合并 → 写」。读和写不在同一个锁里，两个进程同时写同一张卡时，
// 后写的那个拿着旧的 prev，会把先写那个刚加的字段覆盖掉（丢更新）。
function putWorker(dir, field, value, n) {
  const code = [
    'const { HippocampusStore } = await import(' + JSON.stringify(process.env.STORE_URL) + ')',
    'const { DIR, FIELD, VALUE, N } = process.env',
    'const store = new HippocampusStore(DIR)',
    'store.ensure()',
    'let violations = 0',
    'for (let i = 0; i < Number(N); i++) {',
    '  const patch = { id: "shared", kind: "experience", title: "共享卡", body: "同一张卡被两个进程交替写。" + i, source: "self" }',
    '  patch[FIELD] = FIELD === "weight" ? Number(VALUE) : JSON.parse(VALUE)',
    '  store.put(patch)',
    '  const back = store.get("shared")',
    '  const got = FIELD === "weight" ? back.weight : back[FIELD]',
    '  if (JSON.stringify(got) !== JSON.stringify(FIELD === "weight" ? Number(VALUE) : JSON.parse(VALUE))) violations++',
    '}',
    'console.log(JSON.stringify({ violations }))',
  ].join('\n')
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DIR: dir, FIELD: field, VALUE: JSON.stringify(value), N: String(n) } })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code2) => {
      if (code2 !== 0) return reject(new Error('put worker 退出码 ' + code2 + ': ' + err.slice(0, 200)))
      try { resolve(JSON.parse(out.trim())) } catch { reject(new Error('put worker 输出不可解析: ' + out.slice(0, 120))) }
    })
  })
}

test('两个进程交替 put 同一张卡：不丢更新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-put-test-'))
  process.env.STORE_URL = STORE
  try {
    const [a, b] = await Promise.all([putWorker(dir, 'tags', ['并发写'], 40), putWorker(dir, 'weight', 2.5, 40)])
    assert.equal(a.violations, 0, '写 tags 的进程有 ' + a.violations + ' 次读回发现自己的字段被覆盖')
    assert.equal(b.violations, 0, '写 weight 的进程有 ' + b.violations + ' 次读回发现自己的字段被覆盖')
  } finally {
    delete process.env.STORE_URL
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  }
})

// #20：addSelfNote 是「读全文件 → 追加 → 整文件重写」，读和写不在同一把锁里，
// 两个进程同时记笔记时，后写的那个会把先写那个刚加的整批覆盖回去。
function noteWorker(dir, tag, n) {
  const code = [
    'const { HippocampusStore } = await import(' + JSON.stringify(process.env.STORE_URL) + ')',
    'const { DIR, TAG, N } = process.env',
    'const store = new HippocampusStore(DIR)',
    'store.ensure()',
    'for (let i = 0; i < Number(N); i++) store.addSelfNote(TAG + "-" + i)',
  ].join(String.fromCharCode(10))
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DIR: dir, TAG: tag, N: String(n) } })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code2) => (code2 === 0 ? resolve() : reject(new Error('note worker 退出码 ' + code2 + ': ' + err.slice(0, 200)))))
  })
}

test('多进程同时 addSelfNote：一条都不丢', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-note-test-'))
  process.env.STORE_URL = STORE
  try {
    await Promise.all([noteWorker(dir, 'A', 10), noteWorker(dir, 'B', 10), noteWorker(dir, 'C', 10), noteWorker(dir, 'D', 10)])
    const store = new HippocampusStore(dir)
    const texts = store.selfNotes().map((n) => n.text)
    assert.equal(texts.length, 40, '40 条笔记只留下 ' + texts.length + ' 条')
  } finally {
    delete process.env.STORE_URL
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  }
})
