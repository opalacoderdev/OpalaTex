def moving_average(values, window):
    """Average of each run of `window` consecutive values."""
    if window <= 0:
        raise ValueError("window must be positive")
    return [sum(values[i:i + window]) / window for i in range(len(values) - window)]
