from pricing.core import calc_total


def summary(items, tax_rate=0.0):
    total = calc_total(items, tax_rate)
    return f"{len(items)} items, total {total:.2f}"
