import fs from 'node:fs'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { HippocampusStore } from '../../lib/store.js'
import { recallByCue } from '../../lib/recall.js'

// LongMemEval（oracle 版）全量跑分，三阶段：build -> answer -> judge
// 用法：
//   export DEEPSEEK_API_KEY=sk-...
//   node eval/bench/longmemeval.mjs build 3
//   node eval/bench/longmemeval.mjs answer 3
//   node eval/bench/longmemeval.mjs judge 3
// 环境变量：
//   BENCH_DATA  题库 json 路径（默认 eval/bench/longmemeval_oracle.json）
//   BENCH_OUT   输出目录（默认 eval/bench/out）
//   BENCH_LIMIT 每题召回几张卡（默认 5，即 README 里 81.6% 那组的口径）

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BENCH_OUT || join(HERE, 'out')
const DATA = process.env.BENCH_DATA || join(HERE, 'longmemeval_oracle.json')
const KEY = process.env.DEEPSEEK_API_KEY
if (!KEY) { console.error('需要环境变量 DEEPSEEK_API_KEY'); process.exit(1) }
if (!fs.existsSync(DATA)) { console.error('题库不存在：' + DATA + '（见 eval/bench/README.md 的下载地址）'); process.exit(1) }
mkdirSync(BASE, { recursive: true })
const LIMIT = Math.max(1, Number(process.env.BENCH_LIMIT) || 5)
const ROOT = BASE + '/db'
const QF = BASE + '/lme500-queries.json'
const AF = BASE + '/lme500-answers.json'
const JF = BASE + '/lme500-judge.json'
const STAGE = process.argv[2] || 'build'
const CONC = Math.max(1, Number(process.argv[3]) || 3)

async function chat(messages, maxTokens = 220, tries = 6) {
  const body = JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0, max_tokens: maxTokens, stream: false })
  let last
  for (let t = 0; t < tries; t += 1) {
    try {
      const r = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY }, body, signal: AbortSignal.timeout(240000) })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const j = await r.json()
      return j.choices[0].message.content.trim()
    } catch (e) { last = e; await new Promise((res) => setTimeout(res, 2000 + t * 4000)) }
  }
  throw last
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0
  async function worker() { while (i < items.length) { const k = i; i += 1; out[k] = await fn(items[k], k) } }
  await Promise.all(Array.from({ length: n }, worker))
  return out
}
function iso(raw) { const m = /(\d{4})\/(\d{2})\/(\d{2})/.exec(raw || ''); return m ? m[1] + '-' + m[2] + '-' + m[3] : '' }
function safe(id) { return String(id).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) }
function loadJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return dflt } }
function saveJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2)) }

const data = JSON.parse(fs.readFileSync(DATA, 'utf8'))
const byType = {}
for (const x of data) (byType[x.question_type] ||= []).push(x)
console.log('total questions', data.length, JSON.stringify(Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length]))))

if (STAGE === 'build') {
  let prev = loadJson(QF, [])
  const done = new Set(prev.map((q) => q.qid))
  if (!prev.length) rmSync(ROOT, { recursive: true, force: true })
  const todo = data.filter((x) => !done.has(x.question_id))
  console.log('build: already', done.size, 'todo', todo.length)
  const out = prev.slice()
  const t0 = Date.now()
  for (let k = 0; k < todo.length; k += 1) {
    const x = todo[k]
    const db = ROOT + '/' + safe(x.question_id)
    const store = new HippocampusStore(db)
    store.ensure()
    const sidToCard = {}
    for (let i = 0; i < x.haystack_sessions.length; i += 1) {
      const sess = x.haystack_sessions[i]
      const sid = x.haystack_session_ids[i]
      const date = x.haystack_dates[i]
      const cardId = 's' + i
      const body = [date, ''].concat(sess.map((m) => m.role + ': ' + m.content)).join('\n')
      store.put({ id: cardId, title: '会话记录 ' + date, body, tags: ['bench:lme', 'ws:bench'], source: 'self', source_type: 'experience', source_date: iso(date), weight: 1 })
      sidToCard[sid] = cardId
    }
    const r = recallByCue(store, x.question, { limit: LIMIT })
    const ids = (r.items || []).map((it) => it.id)
    const ansCards = [...new Set((x.answer_session_ids || []).map((s) => sidToCard[s]).filter(Boolean))]
    out.push({ qid: x.question_id, type: x.question_type, question: x.question, answer: x.answer, question_date: x.question_date, n_sessions: x.haystack_sessions.length, status: r.status, ids, ans_cards: ansCards, db })
    if ((k + 1) % 25 === 0 || k + 1 === todo.length) {
      out.sort((a, b) => a.qid.localeCompare(b.qid))
      saveJson(QF, out)
      const rate = (Date.now() - t0) / (k + 1)
      console.log('build', out.length + '/' + data.length, 'per', Math.round(rate) + 'ms', 'eta', Math.round((todo.length - k - 1) * rate / 60000) + 'min')
    }
  }
}

if (STAGE === 'answer') {
  const all = loadJson(QF, [])
  const prev = loadJson(AF, [])
  const done = new Set(prev.map((q) => q.qid))
  const todo = all.filter((q) => !done.has(q.qid))
  console.log('answer: total', all.length, 'already', done.size, 'todo', todo.length, 'conc', CONC)
  const t0 = Date.now()
  const SYS = 'You are a personal memory assistant. Below are memory records about the user, each with a date. Use them to answer the user question. You may reason over the records: combine facts across records, compare dates, and use the current date to compute relative times. If the question asks for a list, include every item you can find across the records. If the records contain nothing relevant, respond exactly: I do not know. Answer concisely.'
  const buildPrompt = (records, question, note) => {
    const ctx = records.length ? records.map((r, i) => '[' + (i + 1) + '] ' + (r.title || '') + '\n' + r.body).join('\n\n') : '(no memory records found)'
    return [SYS, '', note || '', 'MEMORY RECORDS:', ctx, '', 'Question: ' + question, 'Answer:'].join('\n')
  }
  const out = prev.slice()
  let n = 0
  await pool(todo, CONC, async (q) => {
    const store = new HippocampusStore(q.db)
    const records = q.status === 'not_found' ? [] : q.ids.slice(0, LIMIT).map((id) => { const c = store.get(id); return { title: c && c.title, body: c && c.body } })
    const pred = await chat([{ role: 'user', content: buildPrompt(records, q.question, 'Current date: ' + q.question_date) }])
    out.push({ ...q, pred })
    n += 1
    if (n % 10 === 0) {
      out.sort((a, b) => a.qid.localeCompare(b.qid))
      saveJson(AF, out)
      const rate = (Date.now() - t0) / n
      console.log('answer', out.length + '/' + all.length, 'per', Math.round(rate) + 'ms', 'eta', Math.round((todo.length - n) * rate / 60000) + 'min')
    }
  })
  out.sort((a, b) => a.qid.localeCompare(b.qid))
  saveJson(AF, out)
  console.log('answer done', out.length)
}

if (STAGE === 'judge') {
  const all = loadJson(AF, [])
  const prev = loadJson(JF, [])
  const done = new Set(prev.map((q) => q.qid))
  const todo = all.filter((q) => !done.has(q.qid))
  console.log('judge: total', all.length, 'already', done.size, 'todo', todo.length)
  const E = 'You are grading a memory question-answering system.\nQuestion: {Q}\nGold answer: {G}\nSystem answer: {P}\nDecide if the system answer is semantically correct given the gold answer. Accept paraphrases, different date formats, and lists that cover all gold items. Partial answers that miss key items are WRONG.\nReply with exactly one word: CORRECT or WRONG'
  const fill = (t, o) => t.replace('{Q}', o.Q).replace('{G}', o.G || '').replace('{P}', o.P)
  const verdict = (txt) => { const t = String(txt).toUpperCase(); if (/\bCORRECT\b/.test(t) && !/\bWRONG\b/.test(t)) return 'CORRECT'; if (/\bWRONG\b/.test(t)) return 'WRONG'; return 'UNKNOWN' }
  const out = prev.slice()
  let n = 0
  const t0 = Date.now()
  await pool(todo, CONC, async (q) => {
    const txt = await chat([{ role: 'user', content: fill(E, { Q: q.question, G: q.answer, P: q.pred }) }], 12)
    out.push({ ...q, verdict: verdict(txt), raw: txt })
    n += 1
    if (n % 20 === 0) { out.sort((a, b) => a.qid.localeCompare(b.qid)); saveJson(JF, out); console.log('judge', out.length + '/' + all.length) }
  })
  out.sort((a, b) => a.qid.localeCompare(b.qid))
  saveJson(JF, out)
  const byCat = {}; let ok = 0; let abstain = 0
  for (const q of out) { byCat[q.type] ||= { n: 0, ok: 0 }; byCat[q.type].n += 1; if (q.status === 'not_found') abstain += 1; if (q.verdict === 'CORRECT') { byCat[q.type].ok += 1; ok += 1 } }
  console.log('LongMemEval500 accuracy', ok + '/' + out.length, (100 * ok / out.length).toFixed(1) + '%', 'abstain', abstain)
  for (const t of Object.keys(byCat).sort()) console.log(' ', t, byCat[t].ok + '/' + byCat[t].n)
}
