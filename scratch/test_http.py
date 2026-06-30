import requests
import json
import base64
import os

project_path = os.path.abspath("test_latex_dir3")
os.makedirs(project_path, exist_ok=True)
with open(f"{project_path}/A.tex", "w") as f: f.write("\\documentclass{article}\n\\begin{document}\n\\input{B.tex}\n\\end{document}")
with open(f"{project_path}/B.tex", "w") as f: f.write("I am B")
with open(f"{project_path}/C.tex", "w") as f: f.write("\\documentclass{article}\n\\begin{document}\nI am C\n\\end{document}")

# Let's insert a project in config
from opalatex.project import ProjectStore
from opalatex.config import DEFAULT_DB_PATH
store = ProjectStore(db_path=DEFAULT_DB_PATH)
# We won't insert, we will just use the API. The API guesses main file if not in store.
# Wait, if not in store, `main_file` will be guessed as A.tex maybe?

# Let's hit the API directly
url = "http://127.0.0.1:3000/api/latex/compile"

# Try to compile C.tex
data = {
    "content": "\\documentclass{article}\n\\begin{document}\nI am C\n\\end{document}",
    "filePath": "C.tex",
    "projectPath": project_path
}
res = requests.post(url, json=data)
print("Compile C.tex status:", res.status_code)
if res.status_code == 200:
    resp = res.json()
    print("Success:", resp.get("success"))
    print("Log:", resp.get("log")[:200])

