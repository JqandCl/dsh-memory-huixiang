#!/usr/bin/env python3
"""生成命中门槛专用词表 lib/gate-words.txt（只喂 gateWords，不动打分用的 WORDS）。

用法：python3 scripts/gen-gate-words.py [--top 30000]
来源：jieba 的 dict.txt（pip install jieba 自带）。
规则：只留纯汉字词、长度 2~4；按词频降序取前 top 个；每行一个词。
"""
import argparse, os, sys

p = argparse.ArgumentParser()
p.add_argument('--top', type=int, default=30000)
a = p.parse_args()

try:
    import jieba
    src = os.path.join(os.path.dirname(jieba.__file__), 'dict.txt')
except Exception:
    src = '/opt/python/lib/python3.12/site-packages/jieba/dict.txt'
if not os.path.exists(src):
    sys.exit('找不到 jieba dict.txt: ' + src)

rows = []
for line in open(src, encoding='utf-8'):
    parts = line.split()
    if len(parts) < 2:
        continue
    w, f = parts[0], parts[1]
    if not (2 <= len(w) <= 4) or not all('\u4e00' <= ch <= '\u9fff' for ch in w):
        continue
    try:
        rows.append((int(f), w))
    except ValueError:
        continue
rows.sort(reverse=True)
words = [w for _, w in rows[:a.top]]
# 人工补词：jieba 不收、但我们库里确实在用的词（改这个文件要写理由）
extra = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'lib', 'gate-words-extra.txt')
if os.path.exists(extra):
    seen = set(words)
    for line in open(extra, encoding='utf-8'):
        w = line.strip()
        if w and not w.startswith('#') and w not in seen:
            words.append(w); seen.add(w)

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'lib', 'gate-words.txt')
with open(out, 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(words) + '\n')
print(f'{len(words)} words -> {out}')
