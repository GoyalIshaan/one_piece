"""Trusted probe run separately for the seed and submitted public entry point."""
from base64 import b64decode
from contextlib import redirect_stdout
from importlib.util import module_from_spec, spec_from_file_location
import itertools
import json
from pathlib import Path
from random import Random
from statistics import median
import sys
from time import perf_counter

FUNCTIONS = ("lis_length", "count_inversions", "top_k_frequent")
NUMBERS = (-2, -1, 0, 1, 2, 1.25, "NaN", "Infinity", "-Infinity")


class VaryingLength:
    def __init__(self, values):
        self.values, self.calls = values, 0

    def __bool__(self):
        return True

    def __len__(self):
        self.calls += 1
        return 2 if self.calls == 1 else 1

    def __getitem__(self, index):
        return self.values[index]


class ReverseList(list):
    def __iter__(self):
        return reversed(self)


class ComparisonMeta(type):
    def __eq__(self, other):
        raise RuntimeError("unexpected metaclass comparison")


class Comparable(metaclass=ComparisonMeta):
    def __lt__(self, other):
        return False

    def __gt__(self, other):
        return False


class Word(str):
    __hash__ = None


class SliceIndex:
    def __index__(self):
        return 2


FIXTURES = {
    "lis_length": {
        "none": lambda: (None,),
        "mapping": lambda: (dict(enumerate([2, 1])),),
        "varying_length": lambda: (VaryingLength([1, 2]),),
        "metaclass": lambda: ([Comparable(), Comparable()],),
    },
    "count_inversions": {
        "varying_length": lambda: (VaryingLength([2, 1]),),
        "reverse_iterator": lambda: (ReverseList([3, 1, 2]),),
        "metaclass": lambda: ([Comparable(), Comparable()],),
    },
    "top_k_frequent": {
        "iterator": lambda: (iter(["a", "b", "a"]), 2),
        "unhashable_word": lambda: ([Word("a"), Word("b"), Word("a")], 2),
        "none_slice": lambda: (["b", "a", "b"], None),
        "index_slice": lambda: (["b", "a", "b"], SliceIndex()),
    },
}


def arguments(example):
    name = example["function"]
    if "fixture" in example:
        return FIXTURES[name][example["fixture"]]()
    args = example["args"]
    if name == "top_k_frequent":
        return args
    return ([float(x) if isinstance(x, str) else x for x in args[0]],)


def cases(scope, challenge):
    if challenge is not None:
        yield challenge
        return
    rng = Random(742)
    numeric = [[rng.choice(NUMBERS) for _ in range(rng.randrange(40))] for _ in range(500)]
    numeric += [list(case) for case in itertools.product([0, 1, "NaN"], repeat=3)]
    for name in FUNCTIONS:
        if scope not in ("integrated", name):
            continue
        for fixture in FIXTURES[name]:
            yield {"function": name, "fixture": fixture}
        if name == "top_k_frequent":
            for _ in range(200):
                words = [rng.choice(["a", "A", "b", "ca", "q"]) for _ in range(rng.randrange(50))]
                yield {"function": name, "args": [words, rng.randrange(-4, 10)]}
        else:
            for values in numeric:
                yield {"function": name, "args": [values]}


def outcomes(module, scope, challenge):
    results = []
    for example in cases(scope, challenge):
        fn = getattr(module, example["function"])
        try:
            value = fn(*arguments(example))
        except Exception as exc:
            value = {"raises": type(exc).__name__}
        results.append([example, value])
    return results


def timings(module):
    rng = Random(99)
    data = [rng.randrange(10**6) for _ in range(2500)]
    words = [f"w{rng.randrange(500)}" for _ in range(10000)]
    results = {}
    for name, args in zip(FUNCTIONS, [(data,), (data,), (words, 10)]):
        fn = getattr(module, name)
        times = []
        for _ in range(3):
            start = perf_counter()
            fn(*args)
            times.append(perf_counter() - start)
        results[name] = median(times)
    return results


if __name__ == "__main__":
    mode, scope, payload = sys.argv[1:]
    settings = json.loads(b64decode(payload))
    entry = Path.cwd() / settings["entryPoint"]
    sys.path[:0] = [str(entry.parent), str(Path.cwd())]
    with redirect_stdout(sys.stderr):
        spec = spec_from_file_location(entry.stem, entry)
        candidate = module_from_spec(spec)
        sys.modules[spec.name] = candidate
        spec.loader.exec_module(candidate)
        result = timings(candidate) if mode == "benchmark" else outcomes(candidate, scope, settings["example"])
    print(json.dumps(result, allow_nan=False, separators=(",", ":")))
