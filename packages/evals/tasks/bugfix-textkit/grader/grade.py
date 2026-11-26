"""Hidden grader for bugfix-textkit: fail-to-pass and pass-to-pass tests. Usage: grade.py <workspace> <hidden_dir>"""
import json, os, subprocess, sys, textwrap

ws = os.path.abspath(sys.argv[1])
code = textwrap.dedent(r'''
import json, sys
results = {}
def check(name, fn):
    try:
        fn(); results[name] = True
    except Exception as e:
        results[name] = False
from textkit import tokenize, word_frequencies, top_words, wrap_text
def eq(a, b):
    assert a == b, (a, b)
# fail-to-pass: issue 1
check("f2p_tokenize_punct", lambda: eq(tokenize("Hello, world! Don't stop.", lowercase=True), ["hello", "world", "don't", "stop"]))
check("f2p_tokenize_whitespace", lambda: eq(tokenize("a\tb\nc  d"), ["a", "b", "c", "d"]))
check("f2p_tokenize_keepcase", lambda: eq(tokenize("Hi THERE"), ["Hi", "THERE"]))
check("f2p_tokenize_quotes", lambda: eq(tokenize("'quoted' (x2) rock'n'roll"), ["quoted", "x2", "rock'n'roll"]))
check("f2p_tokenize_underscores", lambda: eq(tokenize("_Hello_ world_again __", lowercase=True), ["hello", "world", "again"]))
check("f2p_tokenize_unicode", lambda: eq(tokenize("CAFÉ 東京 ９", lowercase=True), ["café", "東京", "９"]))
# fail-to-pass: issue 2
check("f2p_freq_ignorecase", lambda: eq(word_frequencies("The cat. the CAT!"), {"the": 2, "cat": 2}))
check("f2p_freq_keepcase", lambda: eq(word_frequencies("The the", ignore_case=False), {"The": 1, "the": 1}))
check("f2p_top_words", lambda: eq(top_words("b B a A a c", 2), [("a", 3), ("b", 2)]))
check("f2p_freq_boundaries", lambda: eq(word_frequencies("_CAFÉ_ café 東京_東京"), {"café": 2, "東京": 2}))
# fail-to-pass: issue 3
def w1():
    for width in range(3, 20):
        for line in wrap_text("the quick brown fox jumps over the lazy dog again and again", width):
            assert len(line) <= width, (width, line)
check("f2p_wrap_width", w1)
check("f2p_wrap_long_word", lambda: eq(wrap_text("abcdefghij xy", 4), ["abcd", "efgh", "ij", "xy"]))
check("f2p_wrap_exact", lambda: eq(wrap_text("aa bb cc", 5), ["aa bb", "cc"]))
# pass-to-pass
check("p2p_wrap_empty", lambda: eq(wrap_text("", 10), []))
check("p2p_wrap_simple", lambda: eq(wrap_text("one two three", 100), ["one two three"]))
check("p2p_top_ties", lambda: eq([w for w, _ in top_words("y x y x z", 3)], ["x", "y", "z"]))
check("p2p_tokenize_plain", lambda: eq(tokenize("plain words here"), ["plain", "words", "here"]))
print(json.dumps(results))
''')
try:
    r = subprocess.run([sys.executable, "-c", code], cwd=ws, capture_output=True, text=True, timeout=60)
    res = json.loads(r.stdout.strip().splitlines()[-1])
except Exception as e:
    print(json.dumps({"score": 0, "passed": False, "details": f"tests crashed: {e}"})); sys.exit(0)
f2p = [k for k in res if k.startswith("f2p")]; p2p = [k for k in res if k.startswith("p2p")]
f2p_ok = sum(res[k] for k in f2p); p2p_ok = sum(res[k] for k in p2p)
score = (f2p_ok / len(f2p)) * (1.0 if p2p_ok == len(p2p) else 0.5)
failed = [k for k, v in res.items() if not v]
print(json.dumps({"score": round(score, 4), "passed": score == 1.0, "raw": {"f2p": f"{f2p_ok}/{len(f2p)}", "p2p": f"{p2p_ok}/{len(p2p)}"}, "details": f"fail-to-pass {f2p_ok}/{len(f2p)}, pass-to-pass {p2p_ok}/{len(p2p)}" + (f"; failing: {', '.join(failed)}" if failed else "")}))
