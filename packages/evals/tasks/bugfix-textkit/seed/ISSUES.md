# Open issues

1. **tokenize ignores punctuation and `lowercase`.** `tokenize("Hello, world! Don't stop.", lowercase=True)`
   should return `["hello", "world", "don't", "stop"]`. Today punctuation sticks to words, newlines and
   tabs are not separators, and `lowercase` does nothing.
2. **word_frequencies is case-sensitive.** With the default `ignore_case=True`, "The" and "the" must be
   counted as the same word (reported lowercased). With `ignore_case=False` case must be preserved.
3. **wrap_text overflows.** Lines can be one character longer than `width`, and words longer than `width`
   are not split. See the docstring for the intended behavior.

Fix all three without changing anything else that already works.
