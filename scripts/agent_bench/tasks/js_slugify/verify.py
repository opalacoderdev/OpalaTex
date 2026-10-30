"""Pass when slugify behaves as asked on cases the agent did not see."""
import json
import os
import subprocess
import sys

work = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "repo", "test", "strings.test.js"), encoding="utf-8") as f:
    original_tests = f.read()
with open(os.path.join(work, "test", "strings.test.js"), encoding="utf-8") as f:
    if f.read() != original_tests:
        sys.exit("test/strings.test.js was modified")
cases = {
    "Introdução à Atenção!": "introducao-a-atencao",
    "  Hello,   World  ": "hello-world",
    "Ação & Reação 2024": "acao-reacao-2024",
    "---já---": "ja",
    "ABC": "abc",
}
module = os.path.join(work, "src", "strings.js").replace("\\", "/")
script = (
    f"import {{ slugify, capitalize }} from 'file://{module}';"
    f"const cases = {json.dumps(cases)};"
    "const bad = Object.entries(cases).filter(([i, o]) => slugify(i) !== o).map(([i, o]) => `${i} -> ${slugify(i)} (expected ${o})`);"
    "if (capitalize('a') !== 'A') bad.push('capitalize changed');"
    "if (bad.length) { console.error(bad.join('\\n')); process.exit(1); }"
)
run = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True)
if run.returncode != 0:
    sys.exit("slugify is wrong:\n" + (run.stderr or run.stdout)[-1500:])
print("ok")
