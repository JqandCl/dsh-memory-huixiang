// 两个进程同时做梦：同一主题只能归出一张（2026-11-21 #6 姊妹项，dream 快照互不可见）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'

const DREAM = new URL('../lib/dream.js', import.meta.url).href
const STORE = new URL('../lib/store.js', import.meta.url).href

const NL = String.fromCharCode(10)

function dreamWorker(dir) {
  const code = [
    'const { dreamPass } = await import(' + JSON.stringify(DREAM) + ')',
    'const { HippocampusStore } = await import(' + JSON.stringify(STORE) + ')',
    'const fs = await import("node:fs")',
    'const store = new HippocampusStore(process.env.DIR)',
    'store.ensure()',
    'fs.writeFileSync(process.env.DIR + "/ready-" + process.pid, "1")',
    'const t0 = Date.now()',
    'while (Date.now() - t0 < 5000) {',
    '  const n = fs.readdirSync(process.env.DIR).filter((f) => f.startsWith("ready-")).length',
    '  if (n >= 2) break',
    '  await new Promise((r) => setTimeout(r, 5))',
    '}',
    'dreamPass(store, { dryRun: false })',
  ].join(NL)
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DIR: dir } })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('dream worker 退出码 ' + c + ': ' + err.slice(0, 300)))))
  })
}

function seed(dir) {
  const store = new HippocampusStore(dir)
  store.ensure()
  const tag = 'ws:梦测'
  const now = Date.now()
  const bodies = [
    '今天在机房把备份脚本又跑了一遍，发现顺手清掉的旧包比留着更省心，以后每周照这样清一次就行，不用再每次都问一遍要不要留，省下的时间够多跑一趟整理。',
    '整理笔记的时候想明白一件事，同一个决定记两遍不如只留一条，多出来的那一条只会让后来的人挑错时间，还得多维护一处，最后两份都不太可信。',
    '晚上试了新的落盘顺序，先写临时文件再改名，中间断电也不会留下半截内容，这个做法比直接覆盖要稳，值得以后所有写盘的地方都照这样改一遍。',
    '复盘这周的改动，发现最值钱的不是新功能，而是把三处会静默坏掉的地方改成了会报错的样子，坏的时候至少有人知道，修起来也快得多。',
  ]
  bodies.forEach((body, i) => {
    store.put({ id: 'e' + i, kind: 'experience', source: 'self', tags: [tag, 'test'], title: '梦测' + i, body, created: new Date(now - i * 60_000).toISOString() })
  })
}

test('多进程同时做梦：同一主题只归出一张', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-dream-race-'))
  try {
    seed(dir)
    await Promise.all([dreamWorker(dir), dreamWorker(dir)])
    const store = new HippocampusStore(dir)
    const ins = store.all().filter((c) => c.kind === 'insight')
    assert.equal(ins.length, 1, '同一主题归出了 ' + ins.length + ' 张：' + ins.map((c) => c.id).join(', '))
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  }
})
