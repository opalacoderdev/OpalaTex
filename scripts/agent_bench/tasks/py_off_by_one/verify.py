"""Pass when moving_average is fixed and the visible tests were left alone."""
import os
import sys

work = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "repo", "test_stats.py"), encoding="utf-8") as f:
    original_tests = f.read()
with open(os.path.join(work, "test_stats.py"), encoding="utf-8") as f:
    if f.read() != original_tests:
        sys.exit("test_stats.py was modified")
sys.path.insert(0, work)
from stats import moving_average  # noqa: E402

cases = [(([1, 2, 3, 4, 5], 3), [2.0, 3.0, 4.0]), (([2, 4], 2), [3.0]), (([1], 2), []), (([1, 1, 1, 1], 1), [1.0] * 4)]
for args, expected in cases:
    got = moving_average(*args)
    if got != expected:
        sys.exit(f"moving_average{args} returned {got}, expected {expected}")
try:
    moving_average([1], 0)
    sys.exit("window 0 no longer raises ValueError")
except ValueError:
    pass
print("ok")
