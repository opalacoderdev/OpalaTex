"""Pass when config.json holds exactly the requested changes."""
import json
import os
import sys

work = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "repo", "config.json"), encoding="utf-8") as f:
    expected = json.load(f)
expected["server"]["port"] = 9090
expected["features"].append("sync")
expected["log"]["level"] = "debug"
try:
    with open(os.path.join(work, "config.json"), encoding="utf-8") as f:
        got = json.load(f)
except json.JSONDecodeError as e:
    sys.exit(f"config.json is not valid JSON: {e}")
if got != expected:
    sys.exit(f"config.json differs from the expected settings:\n{json.dumps(got, indent=2)}")
print("ok")
