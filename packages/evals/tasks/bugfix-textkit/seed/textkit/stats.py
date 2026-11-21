from .tokenize import tokenize


def word_frequencies(text, ignore_case=True):
    """Map each word to how often it appears."""
    counts = {}
    for token in tokenize(text):
        counts[token] = counts.get(token, 0) + 1
    return counts


def top_words(text, n, ignore_case=True):
    """The n most frequent words as (word, count), most frequent first, ties alphabetical."""
    freqs = word_frequencies(text, ignore_case=ignore_case)
    return sorted(freqs.items(), key=lambda kv: (-kv[1], kv[0]))[:n]
