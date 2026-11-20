# 回响 HuiXiang（`dsh-memory-huixiang`）

> 你的 AI 是不是每次开新对话就忘了你是谁？回响给它一块记得住你的记忆——存在你自己电脑里，不经过任何云端。

0.1 预览版 · MIT · 零依赖 · 一条命令装上

## 它解决什么

AI 聊天助手有个通病：聊完就忘。

今天告诉它你住哪、爱吃什么、上个月为什么难过，明天开个新对话，它一句都不记得——因为大多数助手只记得「当前这段对话」。

回响是给它装一块**在外面的记性**：

- 它会慢慢记住你说过的话、经历过的事、在意的东西；
- 这些存在你自己电脑上的一个文件夹里，**不上传、不联网**，你随时能打开看，也能删；
- 用得越久记得越准——留下的不只是事实，还有「为什么」。

## 它不是什么

- **不是云端服务**：没有账号、没有服务器；全库零网络请求，也不调用任何模型（没有 API key 照样跑）。
- **不会偷记聊天**：要显式让它记，它才记。
- **不是向量库**：不做 embedding，一条记忆就是磁盘上一个纯文本 `.md`，出问题时你拿记事本就能翻。
- **不是多用户服务**：一份库给一个 agent 用。

## 它是怎么做到的（想深究的看这节）

- 一条记忆 = 磁盘上一个纯文本 `.md`，带 frontmatter（来源、标签、重量、边界、有效期）。
- 每轮只往上下文里放「热的」：钉住的卡 + 热卡全文 + 「大概记得」便签 + 目录标题。冷的留在库里，给线索才翻。
- 记得住「为什么」：知识（明白了什么）/ 经历（碰上了什么）/ 归纳分开存；两条说法打架就并排放着，标冲突。
- 人格分两层：底色（不常动）+ 当前状态（会变，旧版本自动进历史）。

> 回响基于 **cyber-hippocampus（赛博海马体）** 改造：外文库、记忆重量、因果链这些骨架来自那个项目（MIT），召回、注入分层、人格分层、整理与写入闸是重写的。词表来源见 `NOTICE`。

## 十分钟装上

前提：Node >= 22、DSH >= 0.2.1-rc.2，并且知道要装进哪个 profile（`dsh profile list`，常见的是 `web`）。

**方式一（推荐，npm）**

```bash
dsh plugin --profile web add dsh-memory-huixiang
```

**方式二（源码）**

```bash
git clone https://github.com/JqandCl/dsh-memory-huixiang.git ~/.dsh/plugin-src/dsh-memory-huixiang
dsh plugin --profile web add link:~/.dsh/plugin-src/dsh-memory-huixiang
```

两条路**二选一**（都做会让 `--dump-config` 里出现两条同名 id，行为未定义）。装完重启 dsh。

首次启动会建一个空库：`$DSH_HOME/huixiang`（没有 `DSH_HOME` 就是 `~/.dsh/huixiang`）。
如果你以前用过 cyber-hippocampus，旧库在 `$DSH_HOME/cyber-hippocampus/`：只要新目录还不存在、旧目录里有卡，它会**继续用旧目录**，不会因为改名「记忆消失」。想搬到新目录，自己 `mv` 过去即可。

## 第一次验收

1. 让 agent 调 `hc_status`：应看到 `{ ok: true, dataDir: "…/huixiang", cards: 0 }`。`cards` 是 0 才对——仓库和 npm 包都不带任何作者数据。
2. 让它记一条：`hc_remember(body: "用户在测试回响，喜欢喝乌龙茶")`。
3. 再问：`hc_recall(cue: "我喜欢喝什么茶")`，应能翻回刚才那条。

## 它怎么工作

| 环节 | 做什么 | 落在哪 |
| --- | --- | --- |
| 写 | `hc_remember` 落一条卡，补边界、来源、标签；7 天内同一件事只补字段不新建 | `notes/<id>.md` |
| 存 | 艾宾浩斯式衰减：21 天掉一半，被想起变重，封顶 4；`pinned` 不衰减 | 卡里的 `weight` / `last_hit` |
| 取 | `hc_recall` 按线索召回：触发词、分词权重、实体闸；没记过就 `not_found`，不硬凑 | 只读 |
| 注入 | 每轮：钉住卡 + 热卡全文 + 便签 20 条 + 目录 130 条标题 + 因果链末 12 行 | 上下文 |
| 整理 | `hc_dream` 把同主题几件事归成一条 insight，保留来源；冲突并排不圆 | `ins-*` 卡 |
| 回查 | 原话只增不改地落 `stream.jsonl`；摘要记不清时 `hc_evidence` 按行号捞原句 | `stream.jsonl` |

## 工具

| 工具 | 作用 | 必填 | 常用可选 |
| --- | --- | --- | --- |
| `hc_remember` | 写一条长期记忆 | `body` | `title` `kind` `tags` `source` `source_type` `condition` `valid_until` `quote` `pinned` `links` `aka` `supersedes` `conflict` |
| `hc_recall` | 按线索翻库 / 按 id 取全文 | `cue` 或 `ids` | `limit` |
| `hc_status` | 库有多少卡、热的哪几条、笔记几条、因果链多长 | — | — |
| `hc_evidence` | 按关键词回查原话流水，返回行号、时间、原句 | `cue` | `limit` |
| `hc_persona` | 读/改人格底色与当前状态 | — | `base` `state` `note` |
| `hc_selfnote` | 写/读只给自己看的短笔记（上限 40 条） | — | `write` `last` |
| `hc_dream` | 把最近同主题的几件事归成一条 insight | — | `dryRun` `lookbackDays` |

## 配置

插件默认通过 `cordis.patch.yml` 注入三个配置（`chainTailLines: 12`、`hotLimit: 3`、`heat.floorFromWeight: 2.5`）。其余都可以省略，省略时的真默认值如下：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `chainTailLines` | `12` | 每轮注入因果链最后几行 |
| `hotLimit` | `3` | 注入几条热卡全文 |
| `briefLimit` | `20` | 「大概记得」便签条数 |
| `catalogLimit` | `130` | 「记忆目录」标题条数上限 |
| `compressionLog` | 空 | 折叠日志路径；留空走 `$DSH_HOME/notes/compression.log` |
| `healthScript` | 空 | 每日体检脚本；留空走 `$DSH_HOME/tools/hc-health.sh`（不存在就跳过） |
| `autoDream.enabled` | `true` | 原话攒够行数就自动整理一次 |
| `autoDream.everyLines` | `20` | 攒多少行触发 |
| `autoDream.cooldownMs` | `3600000` | 两次整理的最小间隔 |

记忆重量（`heat`）的全部默认值——注意第二条：`cordis.patch.yml` 会把 `floorFromWeight` 覆盖成 `2.5`，所以**装好之后实际生效的是 2.5**：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `halfLifeDays` | `21` | 21 天掉一半 |
| `initialWeight` | `1` | 新卡的重量 |
| `rehearseBoost` | `0.6` | 被想起一次加多少 |
| `maxWeight` | `4` | 封顶 |
| `hotAt` | `0.55` | 到这个数算热（会被注入） |
| `warmAt` | `0.18` | 到这个数算温（只在召回时出现） |
| `coldAfterDays` | `120` | 这么久没想起就冷存（仍然可搜） |
| `pinWeight` | `4` | `pinned` 卡的常温重量：不衰减、不看闲置 |
| `dedupeWindowMs` | `604800000`（7 天） | 写侧去重窗口 |
| `floorFromWeight` | `3.2`（被覆盖成 `2.5`） | 原始重量到这条线算「底线级」 |
| `floorWeight` | `0.5` | 底线级卡片的衰减地板 |

## 验证

以下命令**只在源码树里跑**——npm 包不带 `test/`、`demo/`、`eval/`（包只含 `index.js`、`lib/`、`cordis.patch.yml`、`README.md`、`NOTICE`、`LICENSE`）。

```bash
node --test                    # 206 个测试全过
node demo/simulate.mjs         # 10 项演示，用临时库，不碰真库
node eval/run.mjs --golden <你的题库.jsonl> --dir <你的库目录>
```

`eval/golden.jsonl` 里是**示例题库（假数据）**，直接跑对不上任何真库。要评测自己的库，照它的格式建一份：每行 `{ id, kind, query, expect }`，`kind` 取 `paraphrase` / `update` / `abstain`，`abstain` 题不写 `expect`。

## 三条设计取舍

1. **纯文本而不是数据库**：能 `tar` 走、能 `grep`、坏了一张卡能手改。代价是没有事务、没有并发保证（只有文件锁）。
2. **不做 embedding**：召回靠词面 + 标签 + 实体闸，确定、可解释、零依赖、零费用。代价是纯近义改写会漏。
3. **冷的绝不注入**：省 token 优先于「全知」。代价是它可能一时想不起来，除非你给线索。

## 已知短板

- 召回是词面驱动的：换个说法（「家在何方」对「住哪」）可能翻不到。
- 单机单进程假设：多进程靠 `O_EXCL` 文件锁，不是分布式锁。
- `stream.jsonl` 会存每一轮原话（单条截断 4000 字）。这是特性也是风险，见「隐私」。
- 206 个测试覆盖的是核心路径，不是全覆盖。

## 隐私

- 全部本地：`$DSH_HOME/huixiang`。全库零网络请求、不上传，也不调用模型。
- 建库时目录 `0700`、文件 `0600`（同机其他账户读不到）。
- `stream.jsonl` 是原话流水：只增不改。不想留就在关掉 agent 后删掉这个文件，库照常工作（只是没法回查原话）。
- 整个目录可以拷走换机器；`persona.json`、`notes/`、`chain.txt` 都在里面。

## 命名与版本

- 显示名：**回响**（HuiXiang）；npm 包名：`dsh-memory-huixiang`。
- 插件 id 仍是 `cyber-hippocampus`：用户配置里写的是 id，改它会让已有配置全部失效，所以只改显示名与包名。
- 0.1 预览版，配置与工具参数还可能变。

## License

MIT，见 `LICENSE`。`lib/gate-words.txt` 由 jieba 词频表生成，来源与许可证见 `NOTICE`。