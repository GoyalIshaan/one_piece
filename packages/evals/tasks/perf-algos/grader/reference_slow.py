"""Three slow functions. Keep their exact behavior; make them fast."""


def lis_length(xs):
    """Length of the longest strictly increasing subsequence of xs."""
    if not xs:
        return 0
    best = [1] * len(xs)
    for i in range(len(xs)):
        for j in range(i):
            if xs[j] < xs[i] and best[j] + 1 > best[i]:
                best[i] = best[j] + 1
    return max(best)


def count_inversions(xs):
    """Number of pairs i < j with xs[i] > xs[j]."""
    count = 0
    for i in range(len(xs)):
        for j in range(i + 1, len(xs)):
            if xs[i] > xs[j]:
                count += 1
    return count


def top_k_frequent(words, k):
    """The k most frequent words, most frequent first; ties broken alphabetically.

    Words are compared exactly (case-sensitive). If there are fewer than k distinct
    words, all of them are returned.
    """
    distinct = []
    for w in words:
        if w not in distinct:
            distinct.append(w)
    counted = [(sum(1 for x in words if x == w), w) for w in distinct]
    counted.sort(key=lambda cw: (-cw[0], cw[1]))
    return [w for _, w in counted[:k]]
