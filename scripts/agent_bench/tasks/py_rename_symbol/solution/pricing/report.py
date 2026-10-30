from pricing.core import compute_total


def summary(items, tax_rate=0.0):
    total = compute_total(items, tax_rate)
    return f"{len(items)} items, total {total:.2f}"
