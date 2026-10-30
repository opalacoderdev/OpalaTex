def compute_total(items, tax_rate=0.0):
    """Sum of price * quantity for every item, plus tax."""
    subtotal = sum(item["price"] * item["qty"] for item in items)
    return round(subtotal * (1 + tax_rate), 2)
