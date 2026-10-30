"""Pass when calc_total is gone everywhere and compute_total behaves the same."""
import os
import subprocess
import sys

work = sys.argv[1]
for dirpath, dirnames, filenames in os.walk(work):
    dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "__pycache__"]
    for name in filenames:
        if name.endswith(".py"):
            path = os.path.join(dirpath, name)
            with open(path, encoding="utf-8") as f:
                if "calc_total" in f.read():
                    sys.exit(f"calc_total still appears in {os.path.relpath(path, work)}")
sys.path.insert(0, work)
from pricing.core import compute_total  # noqa: E402
from pricing.report import summary  # noqa: E402

if compute_total([{"price": 10.0, "qty": 2}, {"price": 2.5, "qty": 4}], 0.1) != 33.0:
    sys.exit("compute_total returns a different value")
if summary([{"price": 1.0, "qty": 3}]) != "1 items, total 3.00":
    sys.exit("summary changed")
run = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                     cwd=work, capture_output=True, text=True)
if run.returncode != 0:
    sys.exit("the tests fail:\n" + run.stderr[-1500:])
run = subprocess.run([sys.executable, "app.py"], cwd=work, capture_output=True, text=True)
if run.returncode != 0:
    sys.exit("app.py fails:\n" + run.stderr[-1500:])
print("ok")
