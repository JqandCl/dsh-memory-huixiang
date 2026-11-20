import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const nowStamp = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000) // 按 +08:00 写，贴近真机
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`
}

test('折叠记录会出现在注入口径里', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-fold-'))
  const log = join(dir, 'compression.log')
  writeFileSync(log, `# 头\n\n- ${nowStamp()} | 折叠 50% | 丢了五段对话\n`)
  const out = execFileSync(process.execPath, ['-e', `
    process.env.HC_COMPRESSION_LOG = ${JSON.stringify(log)};
    import('./lib/prompt.js').then(m => console.log(m.lastCompression()))
  `], { cwd: process.cwd(), encoding: 'utf8' })
  assert.match(out, /折叠 50%/)
})

test('几天前的折叠记录不再冒充「今天被折叠过」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-fold-old-'))
  const log = join(dir, 'compression.log')
  writeFileSync(log, '# 头\n\n- 2026-11-02 18:20 | 折叠 50% | 丢了五段对话\n')
  const out = execFileSync(process.execPath, ['-e', `
    process.env.HC_COMPRESSION_LOG = ${JSON.stringify(log)};
    import('./lib/prompt.js').then(m => console.log(JSON.stringify(m.lastCompression())))
  `], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(JSON.parse(out), '')
})

test('因果链里混过的宿主噪声不再被注入', async () => {
  const { HippocampusStore } = await import('../lib/store.js')
  const { renderSnapshot } = await import('../lib/prompt.js')
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'hc-chain-noise-'))
  const store = new HippocampusStore(dir)
  store.ensure()
  store.appendChain('owner', '<context-rescue-checkpoint> ## 会话急救摘要 …')
  store.appendChain('owner', '[SCHEDULE REMINDER BATCH] reminders_json: [...]')
  store.appendChain('owner', '正常的一句：今天先看视频')
  const out = renderSnapshot({ store, hot: [], chainLines: 12, now: Date.now() })
  assert.ok(!out.includes('context-rescue-checkpoint'))
  assert.ok(!out.includes('SCHEDULE REMINDER'))
  assert.ok(out.includes('今天先看视频'))
})
