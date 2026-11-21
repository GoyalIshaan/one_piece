import bisect
from collections import Counter

def lis_length(xs):
    tails = []
    for x in xs:
        i = bisect.bisect_left(tails, x)
        if i == len(tails): tails.append(x)
        else: tails[i] = x
    return len(tails)

def count_inversions(xs):
    def sort(a):
        if len(a) <= 1: return a, 0
        m = len(a) // 2
        l, cl = sort(a[:m]); r, cr = sort(a[m:])
        out, c, i, j = [], cl + cr, 0, 0
        while i < len(l) and j < len(r):
            if r[j] < l[i]: out.append(r[j]); c += len(l) - i; j += 1
            else: out.append(l[i]); i += 1
        out += l[i:]; out += r[j:]
        return out, c
    return sort(list(xs))[1]

def top_k_frequent(words, k):
    c = Counter(words)
    return [w for w, _ in sorted(c.items(), key=lambda t: (-t[1], t[0]))[:k]]
