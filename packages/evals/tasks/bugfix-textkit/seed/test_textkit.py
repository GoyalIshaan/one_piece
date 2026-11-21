from textkit import top_words, word_frequencies, wrap_text

assert wrap_text("", 10) == []
assert top_words("b a b", 1)[0][0] == "b"
print("ok")
