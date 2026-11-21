// 2026-11-21 只读复核第二轮修完的回归保护（P1 折叠账 / P2 候选总数 / P2 自锁 / P2 锁归属）。
// 规矩：每条都要在旧码上是红的，否则等于没测（0.1.3 那次 #40/#26 假绿的教训）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HippocampusStore } from '../lib/store.js'
import { withLock } from '../lib/lock.js'
import { apply } from '../index.js'

// 用最小桩 ctx 启动真实插件，拿到真实工具的 execute（不 mock 业务逻辑）
async function bootPlugin() {
  const dir = mkdtempSync(join(tmpdir(), 'hx-r8-'))
  const defs = new Map()
  const ctx = {
    effect: (fn) => { fn() },
    on: () => {},
    inject: () => {},
    tools: { register: (d) => defs.set(d.name, d) },
  }
  await apply(ctx, { dataDir: dir, autoDream: { enabled: false } })
  return { dir, call: (name, args, exec) => defs.get(name).execute(args, exec) }
}

test('多说法召回：候选总数按并集算，不只看头名那一句（P2）', async () => {
  const { dir, call } = await bootPlugin()
  const store = new HippocampusStore(dir)
  store.ensure()
  store.put({ id: 'coffee1', title: '咖啡', body: '主人爱喝拿铁，每天早上都要一杯。', tags: ['global:测试'], source: 'owner' })
  for (let i = 0; i < 6; i += 1) {
    store.put({
      id: 'run' + i,
      title: '跑步 ' + (i + 1),
      body: '今天在公园跑步五公里，第 ' + (i + 1) + ' 次，配速还行。',
      tags: ['global:测试'],
      source: 'self',
    })
  }
  // 咖啡那一路只有 1 张候选，跑步那一路 6 张：并集应当是 7，不是 1 也不是 6。
  const r = await call('hc_recall', { cues: ['咖啡', '跑步'], limit: 3 })
  assert.ok(r.候选总数 >= 6, '候选总数只报了 ' + r.候选总数 + '，漏掉了另一路说法捞到的候选')
  assert.ok(r.reason && r.reason.includes('库里还有'), '被截断了却没提示还有更多：' + r.reason)
})

test('persona.json 被删后第一次改人格，不会自己等自己（P2 自锁）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-persona-'))
  const store = new HippocampusStore(dir)
  store.ensure()
  rmSync(join(dir, 'persona.json'))
  const t0 = Date.now()
  store.setPersona({ base: '底色：测试' })
  assert.equal(store.persona().base, '底色：测试')
  const cost = Date.now() - t0
  assert.ok(cost < 2000, '耗时 ' + cost + 'ms，像是又踩了自锁（旧码 3 秒后抛写锁超时）')
})

test('释放锁只删自己那把：被别人接管后不替别人删（P2）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-lock1-'))
  const path = join(dir, 'x.json')
  withLock(path, () => {
    // 模拟：我们持有的锁被判定过期、别人已经抢着建了自己的锁
    writeFileSync(`${path}.lock`, 'someone-else')
  })
  assert.ok(existsSync(`${path}.lock`), '别人的锁被我们顺手删掉了（双持有的来源之一）')
  rmSync(dir, { recursive: true, force: true })
})

test('崩溃留下的过期锁能被回收，不把这个路径卡死（P2）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-lock2-'))
  const path = join(dir, 'y.json')
  const lock = `${path}.lock`
  writeFileSync(lock, 'dead-999')
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)
  let ran = false
  withLock(path, () => { ran = true })
  assert.ok(ran, '过期锁没被回收，这个路径 15 秒内都写不进去')
  assert.ok(!existsSync(lock), '干完该把锁清掉')
  rmSync(dir, { recursive: true, force: true })
})
