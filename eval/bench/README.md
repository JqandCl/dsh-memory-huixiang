# eval/bench —— 公开题库跑分脚本

README 里「它跑过分」那节的 LongMemEval 数字，就是用这个脚本跑出来的。

## 跑 LongMemEval（oracle 版，500 题）

**1. 下题库**（约 15 MB，HuggingFace 上没扩展名，内容就是 JSON）：

```
https://hf-mirror.com/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_oracle
```

存成 `eval/bench/longmemeval_oracle.json`。

**2. 准备 key**：`export DEEPSEEK_API_KEY=sk-...`（要能调 deepseek-chat）

**3. 三阶段跑**（每阶段都能中断，结果增量落盘，重跑会接着来）：

```bash
node eval/bench/longmemeval.mjs build 3    # 每题建临时库 + 走召回
node eval/bench/longmemeval.mjs answer 3    # 把召回到的卡交给模型作答
node eval/bench/longmemeval.mjs judge 3     # 同一个模型判断对错
```

默认每题召回 5 张卡（跟 README 里 81.6% 那组同口径），要换用 `BENCH_LIMIT=3`。
输出在 `eval/bench/out/`。全量 500 题大约 5 分钟、几块钱（2026-11 的 deepseek 价格）。

## 它做了什么

- 每题一个独立临时库（`out/db/<question_id>`），haystack 里每段会话存成一张卡，正文＝日期 + 逐轮原话。
- `recallByCue(store, question, { limit })` 走回响真实的召回路径，不是另写一套。
- 召回到的卡全文 + `Current date: <题目的问题日期>` 一起交给 deepseek-chat。
- 判定用同一个模型：给问题、参考答案、系统答案，回 `CORRECT` 或 `WRONG`。

## 口径（报数字时必须连着这几条说）

- 用的是 **oracle 版**：每题只带 2~6 段候选材料，比完整版 LongMemEval 容易得多，**不能拿去和榜上的完整版数字比**。
- 答题与判分是**同一个模型**；单词判决，没有取多次多数。
- 题库是**英文**的。

## 还没整理成通用版的

LoCoMo（6 段对话 / 86 题）和中文自建题库的跑分脚本还在作者的私有工作区里，只留了笔记与原始判定结果。
需要的话照上面的结构改写即可：建库 → 召回 → 作答 → 判分，四步一样。
