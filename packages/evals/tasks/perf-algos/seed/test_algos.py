from algos import count_inversions, lis_length, top_k_frequent

assert lis_length([]) == 0
assert lis_length([3, 1, 2, 5, 4]) == 3
assert count_inversions([3, 1, 2]) == 2
assert top_k_frequent(["b", "a", "b", "c", "a", "b"], 2) == ["b", "a"]
print("ok")
