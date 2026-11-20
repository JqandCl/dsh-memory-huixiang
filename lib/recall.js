// 召回：不打分向量，只做「标签 + 词 + 重量」三样。
// 触发词门控取自 BV1S6xY65Eey 第四层：不是每轮都检索，是听到「还记得」才翻库。
import { readFileSync } from 'node:fs'
import { rankCards, tierOf, DEFAULT_HEAT, expiryMs } from './heat.js'
import { parseCue, describeCue, inWindow } from './parse.js'

export const TRIGGERS = ['还记得', '记不记得', '上次', '之前', '以前', '那天', '那会儿', '说过', '那个事', '后来']
// 实体槽词表：问句里出现这些词时，命中的卡必须真出现过该词，否则弃权。提到模块作用域，评测脚本也 import。
export const ENTITY_WORDS = ['公司', '学校', '小区', '型号', '车牌', '车', '身份证', '手机号', '月薪', '工资', '身高', '体重', '宠物']

const CJK = /[\u4e00-\u9fff]/
// 匹配噪声：这些词到处都是、又不是内容，算进查询只会稀释覆盖率，还会让无关问题命中。
// 只靠这几个词命中不算「记得」：库里名字类卡片太多，光「叫什么」能撞一排。
const GENERIC_NAME_TOKENS = new Set(['名字', '叫什么', '叫', '称呼', '谁'])
const MATCH_NOISE = new Set(['今天', '昨天', '明天', '现在', '最近', '上次', '之前', '以前', '时候',
  '什么', '怎么', '怎么样', '如何', '为什么', '可以', '需要', '一下', '这个', '那个', '哪些', '哪个',
  '知道', '告诉我', '一般', '通常', '还是', '就是', '不是', '有没有', '是不是'])
const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '在', '就', '也', '和', '个', '这', '那', '吗', '呢', '啊', '吧'])

// 虚字：一个两字词里全是这些字，就不算实词（挡掉「这张」「掉吧」「一下」这类噪声）。
const FUNC_CHARS = new Set([...'的了着过是在就也还又和跟把被给让吗呢吧啊呀哦嗯嘛啦咯喽哇呗这那哪个么些样啥谁怎一二三四五上下里外很太更最都才只张条件点些'])
// 句尾语气词：第二个字是它，这词基本是「…掉吧」「…了吗」这种尾巴，不算实词。
const END_PARTICLES = new Set([...'吧呢吗啊呀哦嗯嘛啦'])
const isNoiseBigram = (b) => (FUNC_CHARS.has(b[0]) && FUNC_CHARS.has(b[1])) || END_PARTICLES.has(b[1])

// 同义/近义口径：查询里出现左边，就同时补上右边的标准词，好跟卡片正文对上。
// 只收「本鲸真会这么说话」的短口语，别贪多——表越长越容易乱配。
const SYNONYMS = [
  [['删掉', '清了', '扔掉', '丢掉', '删了', '移走'], ['删除', 'trash']],
  [['删文件', '删除文件', '删掉文件', '清理文件'], ['删除', 'trash', '文件']],
  [['删东西', '删个东西', '删掉东西', '删除东西', '弄掉', '清掉'], ['删除', 'trash', '文件']],
  [['截图', '图片', '照片', '相片'], ['图片', '相册']],
  [['发个图'], ['图片', 'image']],
  [['点菜', '点餐', '吃饭', '晚饭', '午饭', '早饭', '饿了'], ['吃', '忌口']],
  [['备份'], ['backup', '备份']],
  [['重启', '开机'], ['重启', 'restart']],
  [['记性'], ['记忆', '卡片']],
  [['瞎编', '瞎说', '乱编', '编造', '瞎吹', '吹牛', '乱吹', '瞎扯'], ['虚报', '证据']],
  [['住的地方', '住处', '住在', '住哪', '家在哪', '居住'], ['住处', '地点']],
  [['城市', '哪个城市', '老家', '家乡', '地盘'], ['地点', '住处']],
  [['临江', '江南'], ['地点', '住处', '临江']],
  [['打字', '打好多字'], ['片段', '说话']],
  [['现在叫什么', '新名字', '改叫什么', '改名后'], ['改名']],
  [['熬夜', '晚睡', '睡得晚'], ['值班', '夜']],
  [['日记'], ['日记', '私人']],
  [['报备', '先说一声'], ['报备']],
  [['唱歌', '声音', '语音'], ['语音', '声音']],
  [['长什么样', '长啥样', '长相', '外观'], ['外貌', '设定']],
]

/** 把口语线索补上标准词，返回展开后的文本（原句保留）。 */
export function expandSynonyms(text) {
  const s = String(text || '')
  const extra = []
  for (const [from, to] of SYNONYMS) {
    if (from.some((w) => s.includes(w))) extra.push(...to)
  }
  return extra.length ? `${s} ${extra.join(' ')}` : s
}

/** 卡片的「钩子：…」那行只给人看，不参与打分（里面全是「这张、想起」这种通用词，会造假命中）。 */
export function stripHookLines(body) {
  return String(body || '')
    .split('\n')
    .filter((l) => !/^\s*钩子\s*[：:]/.test(l))
    .join('\n')
}

// ⭐ 2026-11-09 修：原来只做 2 字滑窗，会把「删文件」切成「删文/文件/件要/要注」，
// 噪声词把正确卡的分数稀释掉（验收第 2 题就答错）。改成「领域词表最长匹配 + 兜底二元组」。
const WORDS = ['删除', '删掉', '移走', '清理', '文件', '目录', '备份', '恢复', '还原', '记忆', '卡片',
  '整理', '分身', '派活', '视频', '字幕', '评论', '简介', '语音', '播报', '日记', '名字', '称呼',
  '吃饭', '点餐', '忌口', '油腻', '肥肉', '蛋白', '主人', '本鲸', '人格', '表情', '图片', '截图',
  '相册', '插件', '配置', '重启', '开机', '报备', '同意', '回声', '窗口', '上下文', '折叠', '召回',
  '标签', '原话', '证据', '冲突', '过期', '重复', '验收', '题库', '流程', '索引', '分层', '注入',
  '热记忆', '重量', '学习', '沙箱', '权限', '审批', '额度', '模型', '会话', '提醒', '闹钟', '记录',
  '错误', '报错', '测试', '验证', '结论', '来源', '更新', '版本', '安装', '卸载', '命令', '脚本',
  '代码', '接口', '手机', '屏幕', '电量', '充电', '值班', '加班', '上班', '下班', '项目', '计划',
  '目标', '复盘', '少吃', '多吃', '不能吃', '能吃', '名字', '叫什么', '遵守', '注意', '哪些']
const WORD_SET = new Set(WORDS)
const MAX_WORD = Math.max(...WORDS.map((w) => w.length))

/** token 的权重：单字最轻，词表里的长词最重。 */
export function tokenWeight(t) {
  if (!t) return 0
  if (/^[a-z0-9_]+$/.test(t)) return 1
  return t.length >= 3 ? 1.2 : t.length === 2 ? 0.8 : 0.35
}

/** 中文按「词表最长匹配」切，切不动的地方退回二元组；英文按词切。 */
export function tokenize(text) {
  const out = new Set()
  const s = String(text || '').toLowerCase()
  for (const word of s.match(/[a-z0-9_]{2,}/g) || []) out.add(word)
  const runs = s.match(/[\u4e00-\u9fff]+/g) || []
  for (const run of runs) {
    let i = 0
    while (i < run.length) {
      let hit = ''
      for (let L = Math.min(MAX_WORD, run.length - i); L >= 2; L -= 1) {
        const cand = run.slice(i, i + L)
        if (WORD_SET.has(cand)) { hit = cand; break }
      }
      if (hit) {
        if (!STOP.has(hit) && !isNoiseBigram(hit) && !MATCH_NOISE.has(hit)) out.add(hit)
        i += hit.length
        continue
      }
      const ch = run[i]
      if (!STOP.has(ch) && !FUNC_CHARS.has(ch)) out.add(ch)
      // 兜底二元组：两个都得是实字（「的规」这种虚字打头的假词会让无关卡够到阈值线，
      // 是「查到不该查的」主因）；叠字照收（谢谢/慢慢 是常用词）。
      if (i + 1 < run.length) {
        const bg = run.slice(i, i + 2)
        const solid = [...bg].every((ch) => !STOP.has(ch) && !FUNC_CHARS.has(ch))
        if (solid && !END_PARTICLES.has(bg[1]) && !WORD_SET.has(bg)) out.add(bg)
      }
      i += 1
    }
  }
  return out
}

export function shouldRecall(cue) {
  const s = String(cue || '')
  // 放宽：只要留得下成词（两个字的实词）就允许翻库。门槛原本是防「每轮自动检索」，
  // 但 hc_recall 是主动调用，没必要卡；「嗯」这种单字还挡着。
  return TRIGGERS.some((t) => s.includes(t)) || [...tokenize(s)].some((t) => t.length >= 2)
}

/** 死卡：被新卡接替，或过了有效期。审计要能翻到，检索默认不给。
 *  valid_until 写坏了（解析失败）视为「无有效期」：宁可多留一张，也不让卡因为日期格式错就永久失踪。 */
export function isDead(card, now = Date.now()) {
  if (card.superseded_by) return true
  const at = expiryMs(card.valid_until)
  return Boolean(at && at < now)
}

/** 返回 { status, items, reason }，status: matched | ambiguous | not_found */
// 实体槽（2026-11-15 主意识定版）：只用来在出口判「这个问题库里有没有对应记录」。
// 问句里出现这些词，而头名卡字面里一次都没出现 → 说明库里没有这类事实，别拿字面相近的卡凑答案。
export const ENTITY_SLOTS = [
  '表弟', '表哥', '堂弟', '堂哥', '舅舅', '奶奶', '爷爷', '外婆', '外公',
  // df>0 词全部留槽（2026-11-16 主意识定：判据看「头名卡字面」不看「库里有」）：同事/老师/手机/电脑/眼镜/体检
  '同事', '同学', '室友', '朋友', '邻居', '领导', '老板', '老师', '前任', '房东',
  '路由器', '手机', '电脑', '眼镜', '快递', '单号', '血压', '血糖', '体检', '体重', '身高',
  '工资', '月薪', '房租', '户型', '面积', '面馆', '车牌', '车', '身份证', '员工编号', '工号',
]

// 必填槽位表（E2，2026-11-20，来源 B27 BV1XPGF6XEtK / B28 BV1PU3b6pEVP 的「槽位」思路）：
// 按「问的是哪类东西」判，头名卡里必须真出现过对应词。跟 ENTITY_SLOTS（一个个具体名词）分工不同——
// 这里问法能写窄、need 能穷举，以后再添一类只改这张表，不动函数。
// 只收高精度的；写不窄的（「今天在云州吗」这种时间邻近）别硬塞，塞错会把真答案一起拦掉。
export const REQUIRED_SLOTS = [
  { id: '群', ask: /加群|几个群|群聊|群人数|进群|退群|群友/, need: ['群'] },
  { id: '家人', ask: /家里人|家人|父母|爸妈|爸爸|妈妈/, need: ['家里人', '家人', '父母', '爸妈', '爸爸', '妈妈'] },
  // 「住哪/住在哪」交给「住址」那条多义词（只在问住处时才算），这里只管「人现在在哪」这类。
  // 2026-11-20 复核补（QQ 分身挑出的硬伤）：ask 里原来有裸的「在哪里」，于是「记忆存在哪里」「日志在哪里看」
  // 「上次那个视频在哪里看到的」全被当成问人住哪，头名卡不含 住/城市 → not_found。改成必须带人称主语
  // （主人/本鲸/他/她/人家/人）或问「在哪儿 / 哪个城市 / 什么地方」；问东西放哪儿的交给普通召回。
  // 2026-11-20 P2 收窄：原来裸的「在哪儿 / 什么地方」会把「记忆存在什么地方」「上次那个视频在哪儿看的」
  // 也当成问人住哪，然后拿住址 need 去拦 → not_found。现在「哪儿/什么地方」必须挨着住址锚（住/家/老家/城市/地址）才算。
  { id: '位置', ask: /(?:主人|本鲸|他|她|人家|人)(?:现在)?在哪|(?:住|住在|家|老家|城市)(?:在)?哪(?:儿|里)?|哪个城市/, need: ['住', '城市', '地址', '老家', '在家', '所在'] },
  // 2026-11-20 修「主人今天在云州吗」误命中生日卡 birthday-card（正文「六月在云州出差」）：
  // 问的是此刻状态，库里只有历史事件。判据＝问句带当前时间词、问的是「在/去/到/回/待/忙/做/干」，
  // 头名卡就必须真出现过当前时间词；只有历史日期、没有「今天/现在」的卡不该拿来答「今天」。
  // 收窄理由：不带当前时间词的问法（住哪、生日几号）不触发；「今天天气」不在动词表里也不触发。
  // 2026-11-20 复核补（只读小弟 probe-slots）：ask 原来会把「主人现在在哪」也吃进来，和「位置」槽同时命中，
  // 两个槽的 need 取并集 → 问住址时反被要求卡里写「现在/今天」，把住址卡拦死。末尾加 (?!哪)：
  // 「现在在哪 / 今天在哪儿」是问位置，归「位置」槽；只留「今天在云州」这类陈述式问法。
  { id: '即时状态', ask: /(?:今天|现在|目前|这会儿|这两天|今儿)(?:还|也|人)?(?:在|去|到|回|待|忙|做|干)(?!哪)/, need: ['今天', '现在', '目前', '此刻', '这会儿', '今晚', '刚刚', '最近'] },
]

/** 槽位 id → 同义词组：判「卡里有没有」时用这组词，不只认槽位名。 */
const SLOT_NEED = new Map(REQUIRED_SLOTS.map((s) => [s.id, s.need]))

/** 出口闸：answerable(cue, items)，items 传完整卡（store.get 的结果）。返回 { ok, hits, missing }。 */
const cardHay = (c) => `${c.title || ''} ${(c.aka || []).join(' ')} ${c.body || ''} ${(c.tags || []).join(' ')}`

const ENTITY_SYNONYMS = { 住址: ['住址', '住处', '地址'], 角色: ['角色'], 年龄: ['年龄', '岁'] }

/** 问句点名了哪些实体：两道实体表（ENTITY_WORDS 老词 + ENTITY_SLOTS 新槽）合并去重，
 *  再加上只在特定问法下才算的三个多义词。2026-11-19 统一：召回本体和兜底共用这一份。 */
export function askedEntitiesOf(cue) {
  const s = String(cue || '')
  const out = new Set()
  for (const w of ENTITY_WORDS) if (s.includes(w)) out.add(w)
  for (const w of ENTITY_SLOTS) if (s.includes(w)) out.add(w)
  for (const slot of REQUIRED_SLOTS) if (slot.ask.test(s)) out.add(slot.id)
  if (!s.includes('小区') && (s.includes('住址') || (s.includes('地址') && /住|家/.test(s)))) out.add('住址')
  if (s.includes('动漫') && s.includes('角色')) out.add('角色')
  if (s.includes('年龄') && /多少|多大/.test(s)) out.add('年龄')
  return [...out]
}

/** 统一实体闸：cue 点名的实体，这张卡字面里必须真出现过（同义词算）。
 *  没有点名实体 → ok；点名了但卡里缺 → { ok:false, missing }。 */
export function entityGate(cue, card) {
  const asked = askedEntitiesOf(cue)
  if (asked.length === 0) return { ok: true, hits: [], missing: [] }
  if (!card) return { ok: true, hits: asked, missing: [] }
  const hay = cardHay(card)
  const missing = asked.filter((w) => !(ENTITY_SYNONYMS[w] || SLOT_NEED.get(w) || [w]).some((x) => hay.includes(x)))
  return { ok: missing.length === 0, hits: asked, missing }
}

// 2026-11-20（E2）：answerable 跟 entityGate 原来各判一套（这里只看 ENTITY_SLOTS，那边两张表都看），
// 同一个问句两个答案——这是 11-19「指标绿≠行为对」的同型毛病。统一走 entityGate。
export function answerable(cue, items) {
  const top = items && items[0]
  const gate = entityGate(cue, top || null)
  return { ok: gate.ok, hits: gate.hits, missing: gate.missing || [] }
}

// 排序比较器（2026-11-16 抽出，方便单测直接验「全序」）：分数分档 → owner 优先 → 近被想起 → id。
// 分档用「绝对档位」而不是「两两差 <0.05 判并列」：近似相等不是等价关系（a~b、b~c 时 a~c 不一定成立），
// 拿它当并列键，同一批卡换比较顺序能排出互不相同的序。floor(score/0.05) 是全序，传递性成立。
// 跨档仍严格按分数排——别让它变成「凡主人的话都优先」。
const SCORE_TIE = 0.05
const sourceRank = (c) => (c.source === 'owner' ? 0 : 1)
const scoreTier = (c) => Math.floor((c.score || 0) / SCORE_TIE)
export function compareScored(a, b) {
  return (scoreTier(b) - scoreTier(a))
    || sourceRank(a) - sourceRank(b)
    || (b.last_hit || 0) - (a.last_hit || 0)
    || String(a.id).localeCompare(String(b.id))
}

// 确定度（抄 dsh-hippocampus 0.3.1 的输出层做法，2026-11-16）：只给 hc_recall 读，不进注入、不参与排序。
// 上游按「这条记多清」分三档；我们只有写入时间没有事件日，就用 source_date 优先、created 兜底，
// 且「记得清」要两样齐：日子够近 + 正文真有细节（≥80 字）——只有一句摘要的老卡不许装成记得清。
const CLARITY_CLEAR_DAYS = 7
const CLARITY_VAGUE_DAYS = 30
function clarityOf(card, now = Date.now()) {
  // 钉住的底线（本名/忌口/删规矩）不看日子：这些是主人亲口定死的，说「大概记得」反而失真。
  if (card.pinned === true) return '记得清'
  const stamp = Date.parse(card.source_date || card.created || '')
  if (!Number.isFinite(stamp)) return '只记得有这回事（日子没留）'
  const days = Math.max(0, (now - Math.min(stamp, now)) / 86400000)
  if (days <= CLARITY_CLEAR_DAYS && String(card.body || '').length >= 80) return '记得清'
  if (days <= CLARITY_VAGUE_DAYS) return '大概记得'
  return '只记得有这回事'
}

// 顺链一带一（2026-11-16，A10①；形抄 dsh-hippocampus 0.3.1 的 edges/hop，判据用我们自己的真边）：
// 只走三种真边——显式 links、接替链、归纳卡的 sourceIds。不走「同标签 / 同一轮写过」：那是共现，不是因果。
// 带回来只有 id+标题+为什么，不展开全文、不加热、不计入 matched/覆盖——联想不许冒充命中。
export function hopNeighbors(store, card, all = null) {
  const seen = new Set([card.id])
  const out = []
  const add = (id, why) => {
    if (!id || out.length >= 3) return
    const key = String(id).trim()
    if (!key || seen.has(key)) return
    seen.add(key)
    const c = store.get(key)
    if (!c) return
    out.push({ id: c.id, title: c.title || String(c.body || '').split('\n')[0].slice(0, 30), why })
  }
  for (const id of card.links || []) add(id, '明确关联')
  for (const id of String(card.supersedes || '').split(',')) add(id, '这张接替了它')
  for (const id of String(card.superseded_by || '').split(',')) add(id, '它接替了这张')
  if (Array.isArray(card.sourceIds)) for (const id of card.sourceIds) add(id, '这张归纳自它')
  // 反方向也算一跳：问「后来怎样」时，把把它当来源/关联的下文带出来。
  for (const c of all || store.all()) {
    if (out.length >= 3) break
    if (c.id === card.id) continue
    if ((c.links || []).includes(card.id)) add(c.id, '它把这张当关联')
    else if ((c.sourceIds || []).includes(card.id)) add(c.id, '它由这张归纳')
  }
  return out
}

export function recallByCue(store, cue, opts = {}) {
  const now = opts.now ?? Date.now()
  const limit = opts.limit ?? 3
  const heat = opts.heat ?? store.heat ?? DEFAULT_HEAT
  const parsed = opts.parsed ?? parseCue(cue, now)
  // 拆出来的实词 + 原句的实词合起来用，别把「昨晚」这种时间词也算进匹配；口语先补标准词。
  const q = new Set([...parsed.keywords, ...tokenize(expandSynonyms(cue))])
  const queryHasWord = [...q].some((t) => tokenWeight(t) >= 0.8)
  if (q.size === 0) return { status: 'not_found', items: [], reason: '线索里没有可用的词' }

  // 弃权闸（11-14 评审第一名缺点）：问的事库里根本没记过时，别拿「主人」「名字」这类泛词凑答案。
  // 判据：查询里有实词，且这些实词**在所有活卡里都找不到**，同时查询里也没有任何「具体但见过」的词
  // （df 1~40%）——说明问的是一个具体对象，库里没有它。只命中泛词不算记得。
  const allCards = store.all()
  const liveCards = allCards.filter((c) => opts.includeSuperseded || !isDead(c, now))
  const df = new Map()
  for (const t of q) df.set(t, 0)
  for (const card of liveCards) {
    const hay = `${card.title || ''} ${(card.aka || []).join(' ')} ${card.body || ''} ${(card.tags || []).join(' ')}`.toLowerCase()
    for (const t of q) if (containsToken(hay, t)) df.set(t, (df.get(t) || 0) + 1)
  }
  // 疑问词本身不算「对象」：分词会把「开什么」切成「开什」，不能拿它证明库里记过。
  const QUESTION_CHARS = '什么哪怎多少为何如何是否样'
  const 非疑问 = [...q].filter((t) => ![...t].some((ch) => QUESTION_CHARS.includes(ch)))
  const strong = 非疑问.filter((t) => tokenWeight(t) >= 0.8)
  const absent = 非疑问.filter((t) => tokenWeight(t) > 0 && !df.get(t))
  const specificSeen = strong.some((t) => {
    const n = df.get(t) || 0
    return n > 0 && n <= Math.max(2, Math.floor(liveCards.length * 0.15))
  })
  if (absent.length > 0 && !specificSeen) {
    // 2026-11-19 统一：这条弃权也带 slotMiss，上层兜底会按实体闸过滤候选，不再把凑出来的卡递回去。
    return { status: 'not_found', items: [], slotMiss: true, reason: `库里没有「${absent.slice(0, 3).join('、')}」这类记录，不凑答案`, 拆解: describeCue(parsed) }
  }
  const scored = []
  for (const card of rankCards(allCards, now, heat)) {
    // 死卡默认不进召回结果（和热注入同一把尺子）；审计时 opts.includeSuperseded = true。
    if (!opts.includeSuperseded && isDead(card, now)) continue
    // ⭐ 2026-11-09 修：标签带作用域前缀（global:/ws:/sess:），原来拿整串比，
    // 「ws:删除」永远对不上查询里的「删除」⇒ 标签命中形同虚设。
    const tags = new Set()
    for (const raw of card.tags || []) {
      const t = String(raw).toLowerCase()
      tags.add(t)
      const i = t.indexOf(':')
      if (i >= 0 && i < t.length - 1) tags.add(t.slice(i + 1))
    }
    let tagHit = 0
    const tagHits = new Set()
    for (const t of q) if (tags.has(t)) { tagHit += 1; tagHits.add(t) }
    // 「钩子：」那行不参与打分，只给人看
    const titleTokens = tokenize(card.title || '')
    const body = tokenize(`${card.title || ''} ${(card.aka || []).join(' ')} ${stripHookLines(card.body)}`)
    // ⭐ 2026-11-09 修：按 token 权重算覆盖，并用 √查询总量 归一（原来除以 q.size，
    // 查询里噪声越多、正确卡分越低）。标题命中额外加分，长词比单字值钱。
    let overlap = 0
    let titleHit = 0
    let qWeight = 0
    let maxHit = 0
    const contentHits = new Set()
    for (const t of q) {
      const w = tokenWeight(t)
      qWeight += w
      if (body.has(t)) { overlap += w; if (w > maxHit) maxHit = w; if (w >= 0.8) contentHits.add(t) }
      if (titleTokens.has(t)) titleHit += w
    }
    // 只有「名字/叫什么」这类泛词命中 ⇒ 不当作记得（否则「我妹妹叫什么」会翻出主人本名）。
    // 标签命中也一样：卡带着 global:名字 这种泛标签，「我妹妹叫什么」照样会撞上，
    // 所以证据里至少要有一个非泛词才算数（正文词或标签词都行）。
    const evidence = [...contentHits, ...tagHits]
    if (evidence.length > 0 && evidence.every((t) => GENERIC_NAME_TOKENS.has(t))) continue
    // 没有任何字面证据就不进来：重量只该决定「先想起谁」，不该凭空想起。
    // ⭐ 2026-11-09 修：查询里有正常的词时，光撞单字不算证据（防「今天天气怎么样」乱翻卡）；
    // 但查询本身全是单字（「猫」「雨」）时，单字就是唯一证据，得让它能命中。
    if (tagHit === 0 && maxHit === 0) continue
    if (tagHit === 0 && queryHasWord && maxHit < 0.8) continue
    // 重量只当小加成（0.15）：防止「没有证据、只靠热」的卡片被翻出来。
    const coverage = overlap / Math.sqrt(Math.max(qWeight, 1))
    let score = tagHit * 3 + coverage * 2.5 + titleHit * 0.8 + Math.min(card.live_weight || 0, 2) * 0.15
    // 说得清「昨天」就按时间窗加分；说了「最近」就让排序往新的那边倾。
    if (inWindow(card, parsed)) score += 1.5
    if (parsed.wantLatest && overlap > 0) score += 0.3
    // 已经作废的旧说法压到后面去，但不能删：它还可能是「以前说过」的证据。
    // 过期或被新卡接替的旧说法：还能当「以前说过」的证据，但排到后面、也不进热记忆注入。
    const expiredAt = expiryMs(card.valid_until)
    const expired = Boolean(expiredAt && expiredAt < now) || Boolean(card.superseded_by)
    if (expired) score *= 0.35
    // 有词级证据（长问句里只撞上一个词）就别用 1.0 硬门槛，否则正常问句会空手。
    if (score >= (maxHit >= 0.8 ? 0.6 : 1)) scored.push({ ...card, score, tagHit, overlap, expired })
  }
  // 并列时要有确定顺序（2026-11-11 体检发现）：两张卡同分，结果会随文件读入顺序漂，
  // 同一句问话今天召回 A、明天召回 B。并列先看谁更近被想起，再按 id 定死。
  // 同分裁决（2026-11-16，做法取自 BV1qoHe6mEx6）：分不出高下时，主人亲口说的排前面。
  // 浮点分数几乎不会严格相等，按 0.05 一档算「同分」，否则这条等于没写。
  // ⚠️ 用「绝对档位」而不是「两两差 <0.05 判并列」（2026-11-16 只读复核）：近似相等不是等价关系，
  // a~b、b~c 成立时 a~c 不一定成立，拿它当并列键排出来的序会随比较顺序漂。
  // floor(score/0.05) 是全序，传递性成立，同一批卡不管怎么喂进来都排出同一个序。
  // 只动并列档，跨档仍严格按分数排——别让它变成「凡主人的话都优先」。
  scored.sort(compareScored)
  const parseLine = describeCue(parsed)

  if (scored.length === 0) {
    return { status: 'not_found', items: [], reason: '库里没有对得上的记录', 拆解: parseLine }
  }
  const top = scored[0]
  const second = scored[1]
  // 实体槽闸（11-14 复核第二名缺点的补丁）：问「公司/学校/小区/型号…」这类具体实体时，
  // 命中的卡里必须真的出现过这个词，否则还是拿「名字」「生日」凑答案。
  // 11-14 二审：地址/角色/专业是多义词（备份包地址、本鲸算什么角色），会误伤正常问句——
  // 词表砍到真·身份类实体；地址只在问住处时算，角色只在问「动漫角色」时算，年龄要求「多少/多大」。
  const cueText = String(cue || '')
  // 命中门槛（2026-11-15 主意识二审版）：不是数「命中几个词」，而是看提问的实词是不是一张卡全兜住。
  // coverage = |Q∩C|/|Q|，Q = 提问实词（去疑问词/泛词），C = 这张卡里的词；要求 coverage = 1.0，
  // 且命中的词里至少一个出现在这张卡的标题/标签里——防「表弟」刚好出现在生日卡正文里那种误命中。
  // 例外：线索里有强证据词（编号 / 长数字串 / 书名号引号点名的串）时，直接放行头名。
  // 短问句不放宽：句长/词数跟负样本几乎一样，按句长放行等于把负样本一起放回来（11-15 二审，别再做）。
  const strongEvidence = hasStrongEvidence(cueText)
  const cardHay = (c) => `${c.title || ''} ${(c.aka || []).join(' ')} ${c.body || ''} ${(c.tags || []).join(' ')}`.toLowerCase()
  const cardTitleOrTag = (c) => {
    const s = new Set(tokenize(c.title || ''))
    for (const raw of c.tags || []) {
      const t = String(raw).toLowerCase()
      s.add(t)
      const i = t.indexOf(':')
      if (i >= 0 && i < t.length - 1) s.add(t.slice(i + 1))
    }
    return s
  }
  // 命中门槛（coverage===1）实验版 2026-11-15：全量闸与「单字/别名/改述/时间窗」等产品语义天然冲突
  // （主意识 22:58 判：不过，回退）。只留 gateWords() 函数给下一版窄路用，选卡恢复成直接选头名。
  const chosen = top
  // 第二根轴搬进召回本体（2026-11-19）：实体槽闸原来只在 hc_recall 出口算，recallByCue 自己仍报
  // matched——评测要额外补一条规则、其他调用方也拿不到一致口径。问句点名某个实体、头名卡字面一次
  // 没出现时，这里直接弃权：状态、加热、评测三处就都对齐了。宽召回不变（不动普通问句）。
  const slotGate = entityGate(cueText, chosen)
  if (!slotGate.ok) {
    return { status: 'not_found', items: [], slotMiss: true, reason: `库里没有「${slotGate.missing.slice(0, 3).join('、')}」这类记录，不拿别的词凑答案`, 拆解: parseLine }
  }
  // 选中的卡可能不是头名：重排成 [选中的, 其余]
  const ordered = chosen === top ? scored : [chosen, ...scored.filter((c) => c.id !== chosen.id)]
  const secondPk = ordered[1]
  // 分数贴太近就交回给用户补线索，不瞎猜（记忆模型的「不对称」原则）。
  const ambiguous = Boolean(secondPk) && secondPk.score >= chosen.score * 0.85 && chosen.score < 4
  // 按条决定展开多少原文（2026-11-17，源自 HIVE-MEM 的按需展开）：头名给 140 字、其余 60 字，
  // 不再每张都吃 90 字——命中越靠后越可能是陪跑，不值得占上下文。
  const pickedRaw = ambiguous ? ordered.slice(0, 3) : ordered.slice(0, limit)
  const picked = pickedRaw.map((c, rank) => ({
    id: c.id,
    kind: c.kind,
    source: c.source,
    title: c.title || firstLine(c.body),
    excerpt: truncate(c.body, rank === 0 ? 140 : 60),
    score: Number(c.score.toFixed(2)),
    // 只有「有字面证据且分够」的才算被想起——低分误命中不该给卡片加权重。
    rehearsable: c.score >= 0.5 && (c.overlap || 0) > 0,
    tier: c.tier,
    quote: c.quote || '',
    superseded_by: c.superseded_by || '',
    conflict: c.conflict === true,
    expired: c.expired === true,
    valid_until: c.valid_until || '',
    确定度: clarityOf(c, now),
    顺链: hopNeighbors(store, c, allCards),
  }))
  return {
    status: ambiguous ? 'ambiguous' : 'matched',
    items: picked,
    reason: ambiguous ? '命中相近，请补一句是哪件事' : '',
    拆解: parseLine,
    parsed: { when: parsed.when, who: parsed.who, wantLatest: parsed.wantLatest, keywords: parsed.keywords },
  }
}

const ASCII_TOKEN = /^[a-z0-9_]+$/

/** 英文按词边界匹配（否则 'ai' 会撞上 'email' / 'main'）；中文照旧子串。
 *  2026-11-14 只读复核实测：子串匹配让 'ai' 同时命中两张无关卡，所以兜底/场合计数都走这里。 */
export function containsToken(hayLower, token) {
  const hay = String(hayLower || '')
  const t = String(token || '')
  if (!t) return false
  if (!ASCII_TOKEN.test(t)) return hay.includes(t)
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9_])${esc}([^a-z0-9_]|$)`).test(hay)
}

/** 命中门槛的「提问实词」口径（2026-11-15 主意识三审定，别改字面）：
 *  先按词表做最长匹配；剩下的连续未知串（既不是词典词、也不是虚词的那段）——
 *    总长 == 2 的串收进 Q（「表弟」「血压」「老周」这类的样子）；
 *    总长 >= 3 的串整段丢掉，**不再切 bigram**（「干活前要注意」整段 6 字，整段丢，
 *    「活前/前要/要注」自然不会冒出来——按长度看词必须在切 bigram 之前做）；
 *    单字串丢掉。
 *  英文/数字按词收。 */
/** gate 专用大词表（jieba top 3w + 人工补词，`scripts/gen-gate-words.py` 生成）。
 *  2026-11-15 主意识定的：只喂 gateWords，**不动** tokenize/WORDS（那两张是打分的）。 */
let GATE_WORDS = null
function gateDict() {
  if (GATE_WORDS) return GATE_WORDS
  const set = new Set(WORD_SET)
  try {
    if (process.env.GATE_SMALL === '1') throw new Error('GATE_SMALL')
    const raw = readFileSync(new URL('./gate-words.txt', import.meta.url), 'utf8')
    for (const w of raw.split('\n')) if (w.length >= 2) set.add(w)
  } catch { /* 词表丢了就退回小词表，行为不变 */ }
  GATE_WORDS = set
  return set
}
const GATE_MAX_WORD = 4
// gate 专用虚词/疑问词集合：只影响 gate 切分，**不改** tokenize 用的 FUNC_CHARS（那是打分的）
const GATE_FUNC = new Set([...FUNC_CHARS, ...'要得能会想怕该可别去来到前后里边中等人么'])
const GATE_STOP = new Set([...MATCH_NOISE, '那天', '这天', '过后', '以后',
  // 提问里的功能短语：不是实体，收进来只会把 coverage 拉低（2026-11-15 逐条跑出来的）
  '不能', '能不能', '要做', '的事', '谁挑', '那台', '我租', '两条', '改前', '来的', '挑的', '说的',
  '看的', '定的', '走的', '问的', '几个', '哪些', '什么', '怎么', '多少', '哪个',
  // 2026-11-15 主意识复跑定的七个通用词：不是实体，留着只拉低 coverage
  '注意', '遵守', '处理', '记得', '说过', '一般', '大概', '可以'])
const QCH = '什么哪怎几多少为何如何是否样个谁啥'

export function gateWords(text) {
  const s = String(text || '').toLowerCase()
  const DICT = gateDict()
  const out = new Set()
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w)
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    let i = 0
    while (i < run.length) {
      let hit = ''
      for (let L = Math.min(GATE_MAX_WORD, run.length - i); L >= 2; L -= 1) {
        const cand = run.slice(i, i + L)
        if (DICT.has(cand)) { hit = cand; break }
      }
      if (hit) {
        if (!STOP.has(hit) && !isNoiseBigram(hit) && !MATCH_NOISE.has(hit)) out.add(hit)
        i += hit.length
        continue
      }
      // 未知连续串：一直吞到「下一个词典词开头」或「碰到虚词/句尾语气词」
      let j = i + 1
      while (j < run.length) {
        if (STOP.has(run[j]) || GATE_FUNC.has(run[j]) || END_PARTICLES.has(run[j])) break
        let dictAt = false
        for (let L = Math.min(GATE_MAX_WORD, run.length - j); L >= 2; L -= 1) {
          if (DICT.has(run.slice(j, j + L))) { dictAt = true; break }
        }
        if (dictAt) break
        j += 1
      }
      const chunk = run.slice(i, j)
      // 长度 2 收下（表弟/血压/老周）；≥3 取前 2 字（老周住哪个区 → 老周）；单字丢
      if (chunk.length === 2) out.add(chunk)
      else if (chunk.length >= 3) out.add(chunk.slice(0, 2))
      i = j
    }
  }
  // 疑问词、纯时间词不当实词（否则覆盖永远到不了 1）
  return [...out].filter((t) => !GATE_STOP.has(t) && ![...t].some((ch) => QCH.includes(ch)))
}

/** 只留实词：两字以上（tokenWeight >= 0.8）。单字和虚字不当证据。 */
export function contentTokens(text) {
  return [...new Set([...tokenize(text)].filter((t) => tokenWeight(t) >= 0.8))]
}

// 强证据词（2026-11-15 主人 + 主意识定，只认三样，可正则判、不需要 NLP）：
//   ① 编号：BVxxxxxxxxxx / av123456
//   ② 连续 >=4 位数字（日期、号码、型号、月租都算）
//   ③ 书名号/引号里被点名的串（『』“”《》里长度 >=2）
// 人名地名**不**列：负样本里「表弟」「血压」df 只有 1~2，跟真专有名词分不开；
// 硬编码「owner 卡里的人名」抽出来又多是「主人」「大肥鱼」这类泛词，一样是噪声。
const STRONG_EVIDENCE = [
  /BV[0-9A-Za-z]{10}/i,
  /av\d+/i,
  /\d{4,}/,
  /[《》“『][^》”』]{2,}[》”』]/,
]

/** 线索里有没有强证据词——单个就算过命中门槛。 */
export function hasStrongEvidence(text) {
  const s = String(text || '')
  return STRONG_EVIDENCE.some((re) => re.test(s))
}

/** 召回兜底（2026-11-14 养鱼 23 条审片，BV1A6Wv6KEob；同日按只读复核收紧了证据门槛）：
 *  正常召回按「标题/标签/权重」打分，线索词只长在卡正文里时会被漏掉；not_found 时降级做两件事：
 *  ① 用实词扫全库正文；② 翻原话流水。
 *  只当「低置信线索」：不计权重、不算 recall use、不参与注入。
 *  复核后改了三处：只要实词（单字/虚字不算证据）；到处都有的词（df > 30%）先剔掉；
 *  命中的词要过半（kept>=3 时）才算线索，且 coverage 是词覆盖率不是「置信度」。 */
export function keywordFallback(store, cue, opts = {}) {
  const now = opts.now ?? Date.now()
  const limit = opts.limit ?? 3
  const tokens = contentTokens(cue).slice(0, 10)
  if (tokens.length === 0) return { items: [], stream: [], tokens: [] }
  const cards = store.all()
  const hayById = new Map()
  const df = new Map(tokens.map((t) => [t, 0]))
  for (const c of cards) {
    const hay = `${c.title || ''}\n${c.body || ''}\n${(c.tags || []).join(' ')}`.toLowerCase()
    hayById.set(c.id, hay)
    for (const t of tokens) if (containsToken(hay, t)) df.set(t, df.get(t) + 1)
  }
  // 判据是「罕见词」，不是「覆盖率」：库里绝大多数卡都没有的词才算线索。
  // 严格按覆盖率会要求命中一半词，可 recall 本来就看过正文，那样就永远轮不到兜底；
  // 全部词都算又会把「今天」「东西」这类噪声放进来（复核实测的原问题）。两头都不选，取稀有的那一侧。
  // 允许「卡库里没有、但原话流水里有」的词（df=0 也留着）：兜底真正补的是 recall 完全不看的 stream。
  const rare = tokens.filter((t) => cards.length < 20 || (df.get(t) || 0) / cards.length <= 0.15)
  if (rare.length === 0) return { items: [], stream: [], tokens: [] }
  const items = []
  for (const c of cards) {
    if (isDead(c, now) && !opts.includeSuperseded) continue
    const hay = hayById.get(c.id) || ''
    const hit = rare.filter((t) => containsToken(hay, t))
    if (hit.length === 0) continue
    items.push({
      from: 'card',
      cue: opts.cue || '',
      id: c.id,
      kind: c.kind,
      title: c.title || firstLine(c.body),
      excerpt: excerptAround(c.body, hit[0]),
      coverage: Number((hit.length / rare.length).toFixed(2)),
      matched: hit.slice(0, 6),
      // 同 isDead / 上面 :359 的口径：0 是「没写 / 读不懂」，不是「过期了」（2026-11-21 只读复核 #15）。
      expired: Boolean(c.valid_until && expiryMs(c.valid_until) > 0 && expiryMs(c.valid_until) < now) || Boolean(c.superseded_by),
      lowConfidence: true,
    })
  }
  items.sort((a, b) => b.coverage - a.coverage || String(a.id).localeCompare(String(b.id)))
  return { items: items.slice(0, limit), tokens: rare }
}

/** 把命中词前后的原文切出来，比整段正文省 token，也看得出「为什么算它」。 */
function excerptAround(text, token, width = 60) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  const i = s.toLowerCase().indexOf(String(token || '').toLowerCase())
  if (i < 0) return truncate(s, width * 2)
  const from = Math.max(0, i - width)
  const to = Math.min(s.length, i + width)
  return `${from > 0 ? '…' : ''}${s.slice(from, to)}${to < s.length ? '…' : ''}`
}

export function firstLine(body) {
  return String(body || '').split('\n').find((l) => l.trim())?.slice(0, 40) || '(无标题)'
}

export function truncate(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

/** 此刻该注入哪些：热的按重量取前 N，冷的绝不注入。 */
export function hotForInjection(store, opts = {}) {
  const now = opts.now ?? Date.now()
  const limit = opts.limit ?? 3
  const heat = opts.heat ?? store.heat ?? DEFAULT_HEAT
  // opts.cards：调用方已经扫过全库时直接复用，别为同一件事扫两遍（11-14 审查：每轮扫 2 次、250–550ms）。
  const ranked = rankCards(opts.cards ?? store.all(), now, heat)
  // 死卡可以留着当「以前说过」的证据，但不能当热卡塞进上下文（和召回用同一把尺子 isDead）。
  const live = ranked.filter((c) => !isDead(c, now))
  const hotAll = live.filter((c) => c.tier === 'hot')
  const pinnedHot = hotAll.filter((c) => c.pinned === true)
  const dynamicHot = hotAll.filter((c) => c.pinned !== true)
  // 两条约束要同时成立（2026-11-11 两轮复核都撞到过）：
  //  ① pinned 是「底线」，一张都不能少——它们不是候选，是必须带上的事实；
  //  ② 但 limit 个名额也不能被 pinned 全占光，否则「还热的记忆」冻结成三条底线。
  // 所以：pinned 全量注入，limit 只管动态热卡（总条数 = pins + limit，通常 3+3）。
  const pinnedAll = pinnedHot.slice().sort((a, b) => (b.live_weight ?? 0) - (a.live_weight ?? 0) || String(a.id).localeCompare(String(b.id)))
  // 轮换席（2026-11-14 独立审查 S1）：动态热卡常年被同几张占住，不在前 N 的卡拿不到注入
  // ⇒ 拿不到 text-use ⇒ 权重不动 ⇒ 永远排在外面（正反馈自锁）。现在固定前 limit-1 席，
  // 最后一席每 6 小时换一张，在「其余全部动态热卡」里轮转（不再只看第 3~12 名——真库 144 张因此一次也进不了上下文）。
  // 不落盘、不改权重，纯为了公平；同一个窗口内重复装配结果稳定。
  let dynamicPicked
  if (dynamicHot.length > limit && limit >= 2) {
    const head = dynamicHot.slice(0, limit - 1)
    const pool = dynamicHot.slice(limit - 1)
    const win = Math.floor(now / (6 * 3_600_000))
    // 轮转而不是随机抽：pool 有几张就几轮转完一轮，保证每张迟早进一次上下文（真库 17 张池 ≈ 4 天一轮）。
    const slot = ((win % pool.length) + pool.length) % pool.length
    dynamicPicked = [...head, pool[slot]]
  } else {
    dynamicPicked = dynamicHot.slice(0, limit)
  }
  const hot = [...pinnedAll, ...dynamicPicked]
  // 原来的 fallback 取 live 前几名，而那几名正好就是 hot 自己 ⇒ 去重后注入条数变少（经常只有 2 条）。
  const hotIds = new Set(hot.map((c) => c.id))
  const fallback = live.filter((c) => c.tier !== 'cold' && !hotIds.has(c.id)).slice(0, Math.max(0, limit - dynamicPicked.length))
  return [...new Set([...hot, ...fallback].map((c) => c.id))].map((id) => rankingsGet(ranked, id))
}

function rankingsGet(list, id) {
  return list.find((c) => c.id === id)
}

export { tierOf }
/** 「大概记得」便签 + 全量目录（主人 2026-11-14 定的双管齐下：记忆只留大概、但要能找）。
 * 便签只出标题级信息，按「最久没被想起」排在前面（last_hit 老/从没想起 → 先轮到），
 * 目录给全部活卡标题，让本鲸知道自己手里有什么，要细节再用 hc_recall 拉全文。 */
export function injectionBriefs(store, opts = {}) {
  const now = opts.now ?? Date.now()
  const limit = opts.limit ?? 20
  const heat = opts.heat ?? store.heat ?? DEFAULT_HEAT
  const ranked = rankCards(opts.cards ?? store.all(), now, heat)
  const live = ranked.filter((c) => !isDead(c, now))
  const pinnedIds = new Set(live.filter((c) => c.pinned === true).map((c) => c.id))
  // 已经在「还热的记忆」里出过全文的卡，便签区不再重复（省 token，也免得同一张卡两种写法打架）。
  const shownIds = new Set([...(opts.excludeIds || []), ...pinnedIds])
  const dynamic = live.filter((c) => !shownIds.has(c.id))
  const lastHit = (c) => {
    // last_hit 读回来是毫秒数字（store 的 parse），Date.parse(数字) 恒 NaN，
    // 排序会退化成纯重量序、轮换公平性失效（2026-11-21 B5）。老卡偶尔是 ISO 串，两种都认。
    const raw = c.last_hit
    const t = typeof raw === 'number' ? raw : Date.parse(raw || '')
    return Number.isFinite(t) ? t : 0
  }
  const ordered = dynamic
    .slice()
    .sort((a, b) => lastHit(a) - lastHit(b) || (b.live_weight ?? 0) - (a.live_weight ?? 0) || String(a.id).localeCompare(String(b.id)))
  // 便签不能只按 last_hit 取前 N：便签被端出来不会回写 last_hit，前 N 会永久冻住（11-14 分身模拟：30 天只轮到 21 张 / 池 124 张）。
  // 改成按时间窗口切片：每 6 小时整批后移 limit 张、环绕，池有多大都能转完（124 张×20 席 ≈ 37 小时一圈），零写盘、零额外记账。
  const n = Math.max(0, limit)
  let briefs = []
  if (ordered.length > 0 && n > 0) {
    if (ordered.length <= n) {
      briefs = ordered.slice()
    } else {
      const win = Math.floor(now / (6 * 3_600_000))
      const offset = (((win * n) % ordered.length) + ordered.length) % ordered.length
      for (let k = 0; k < n; k++) briefs.push(ordered[(offset + k) % ordered.length])
    }
  }
  // 目录上限：config.catalogLimit（默认 130，2026-11-19 主人定 A 案）。原来写死 200，实测 179 条就顶到 9000 字符预算的 98.7%。
  const CATALOG_MAX = Number.isSafeInteger(opts.catalogLimit) && opts.catalogLimit > 0 ? opts.catalogLimit : 130
  const byWeight = live
    .slice()
    .sort((a, b) => (b.live_weight ?? 0) - (a.live_weight ?? 0) || String(a.id).localeCompare(String(b.id)))
  const catalog = byWeight.slice(0, CATALOG_MAX).map((c) => ({ id: c.id, title: truncate(c.title || firstLine(c.body), 18), pinned: c.pinned === true }))
  // 库长大时目录只列前 catalogLimit 条（按重量），余下在注入里写「另有 N 条」，别把因果链挤光。
  return { briefs, catalog, catalogTotal: byWeight.length, liveCount: live.length }
}

