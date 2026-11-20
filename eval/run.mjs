// 回响 · 检索验收（golden set）
// 用法：node eval/run.mjs            → 跑全题库，打印每题结果与三个指
//       node eval/run.mjs --json     → 只出机器可读结果
// 标准：paraphrase/update 题 = 期望卡进前 3；abstain 题 = 应当 not_found（别硬凑）
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HippocampusStore } from '../lib/store.js'
import { recallByCue } from '../lib/recall.js'

const here = dirname(fileURLToPath(import.meta.url))
// 2026-11-20：题库与库目录都可传参。仓库里带的是示例题库（假数据），
// 真用起来要按自己的库重建：node eval/run.mjs --golden ~/my.jsonl --dir ~/.dsh/huixiang
const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const GOLDEN = argOf('--golden', join(here, 'golden.jsonl'))
const TOPK = 3

const rows = readFileSync(GOLDEN, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))

const store = new HippocampusStore(argOf('--dir', undefined))
const results = []
for (const q of rows) {
  const r = recallByCue(store, q.query, { limit: TOPK })
  const ids = (r.items || []).map((i) => i.id)
  let pass
  if (q.kind === 'abstain') pass = r.status === 'not_found'
  else pass = ids.includes(q.expect)
  results.push({
    id: q.id,
    kind: q.kind,
    query: q.query,
    expect: q.expect,
    got: ids,
    status: r.status,
    rank: q.expect ? ids.indexOf(q.expect) + 1 : null,
    pass,
  })
}

const hit = results.filter((r) => r.kind !== 'abstain')
const abs = results.filter((r) => r.kind === 'abstain')
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0)
const summary = {
  总题数: results.length,
  'Recall@3': `${hit.filter((r) => r.pass).length}/${hit.length}（${pct(hit.filter((r) => r.pass).length, hit.length)}%）`,
  'MRR（命中题平均）': (() => {
    const ranks = hit.filter((r) => r.rank).map((r) => r.rank)
    return ranks.length ? (ranks.reduce((a, b) => a + 1 / b, 0) / hit.length).toFixed(2) : '0.00'
  })(),
  '弃权正确（没记过就承认）': `${abs.filter((r) => r.pass).length}/${abs.length}`,
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ summary, results }, null, 1))
} else {
  for (const r of results) {
    const mark = r.pass ? '✅' : '❌'
    const want = r.kind === 'abstain' ? '（应 not_found）' : `期望 ${r.expect}`
    const got = r.status === 'not_found' ? '没翻到' : `第${r.rank || '-'}名 ${r.got.join(',')}`
    console.log(`${mark} ${r.id} [${r.kind}] ${r.query}  → ${want} 实际：${got}`)
  }
  console.log('\n' + JSON.stringify(summary, null, 1))
}
