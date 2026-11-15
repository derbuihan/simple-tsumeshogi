# 収録解をたどり、攻方が初期に持っている必要がある最低限の持ち駒を求める（docs/minimal-hand.md 参照）
# 使い方（リポジトリ直下で）: python3 docs/minimal-hand/minhand.py
import collections, os, random, statistics, sys
D = '.cache/shogimate/public/data'
UNPROMOTE = {c: c for c in 'PLNSGBRK'}
def parse(sfen):
    board_s, turn, hand_s, _ = sfen.split()
    board = {}
    r = 0
    for row in board_s.split('/'):
        f = 9; prom = False
        for ch in row:
            if ch == '+': prom = True; continue
            if ch.isdigit(): f -= int(ch); continue
            board[(f, r)] = (('b' if ch.isupper() else 'w'), ch.upper(), prom); f -= 1; prom = False
        r += 1
    hands = {'b': collections.Counter(), 'w': collections.Counter()}
    num = ''
    if hand_s != '-':
        for ch in hand_s:
            if ch.isdigit(): num += ch; continue
            hands['b' if ch.isupper() else 'w'][ch.upper()] += int(num or 1); num = ''
    return board, turn, hands
def sq(s): return (int(s[0]), ord(s[1]) - 97)
def minimal_hand(sfen, moves):
    board, turn, hands = parse(sfen)
    attacker = turn
    need = collections.Counter()      # 初期に必要な枚数
    avail = collections.Counter()     # 手順中に取って手に入れた枚数
    color = turn
    for m in moves:
        if m[1] == '*':
            t = m[0]
            if color == attacker:
                if avail[t] > 0: avail[t] -= 1
                else: need[t] += 1
            board[sq(m[2:4])] = (color, t, False)
        else:
            fr, to = sq(m[0:2]), sq(m[2:4])
            cap = board.get(to)
            if cap and color == attacker: avail[cap[1]] += 1
            c, t, p = board.pop(fr)
            board[to] = (c, t, p or m.endswith('+'))
        color = 'w' if color == 'b' else 'b'
    return attacker, hands[attacker], need
random.seed(0)
print('手数   元の攻方持ち駒(平均)  最低限(平均)  最低限0枚  最低限1枚  2枚以上  減らせる問題の割合')
for b in ['mate3', 'mate5', 'mate7', 'mate9', 'mate11']:
    orig = []; mins = []; reducible = 0; n = 0
    for v in random.sample(sorted(os.listdir(f'{D}/{b}')), 20):
        for line in open(f'{D}/{b}/{v}'):
            sfen, mv = line.split(' moves ')
            att, h, need = minimal_hand(sfen, mv.split())
            assert all(need[t] <= h[t] for t in need), line
            o = sum(h.values()); k = sum(need.values())
            orig.append(o); mins.append(k); reducible += k < o; n += 1
    c = collections.Counter(min(k, 2) for k in mins)
    print(f'{b:6s}    {statistics.mean(orig):5.1f}            {statistics.mean(mins):4.2f}      {c[0]/n*100:5.1f}%   {c[1]/n*100:5.1f}%  {c[2]/n*100:5.1f}%     {reducible/n*100:5.1f}%')
