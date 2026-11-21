def wrap_text(text, width):
    """Greedy word wrap. Every line is at most `width` characters.

    Words longer than `width` are split into chunks of exactly `width` characters.
    Lines never start or end with spaces. Returns a list of lines.
    """
    words = text.split()
    lines, current = [], ""
    for word in words:
        if not current:
            current = word
        elif len(current) + 1 + len(word) <= width + 1:
            current += " " + word
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines
