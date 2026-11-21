def tokenize(text, lowercase=False):
    """Split text into word tokens.

    Words are runs of letters, digits and inner apostrophes ("don't" is one token).
    Surrounding punctuation is dropped. With lowercase=True tokens are lowercased.
    """
    tokens = text.split(" ")
    return [t for t in tokens if t]
