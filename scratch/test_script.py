import os
import sys

# add project root to path
sys.path.insert(0, os.path.abspath('.'))

from opalatex.latex_compiler import determine_main_file_for_compilation, is_independent, compile_latex

print("is independent?", is_independent("\\documentclass{article}\n\\begin{document}\nhello\n\\end{document}"))
print("is independent?", is_independent("%\\documentclass{article}\n\\begin{document}\nhello\n\\end{document}"))

project_dir = "test_latex_dir"
os.makedirs(project_dir, exist_ok=True)
with open(f"{project_dir}/A.tex", "w") as f: f.write("\\documentclass{article}\n\\begin{document}\n\\input{B.tex}\n\\end{document}")
with open(f"{project_dir}/B.tex", "w") as f: f.write("I am B")
with open(f"{project_dir}/C.tex", "w") as f: f.write("\\documentclass{article}\n\\begin{document}\nI am C\n\\end{document}")

print("main for C.tex with project main A.tex:")
with open(f"{project_dir}/C.tex", "r") as f: c_content = f.read()
print("-->", determine_main_file_for_compilation(f"{project_dir}/C.tex", c_content, project_dir, "A.tex"))

print("main for B.tex with project main A.tex:")
with open(f"{project_dir}/B.tex", "r") as f: b_content = f.read()
print("-->", determine_main_file_for_compilation(f"{project_dir}/B.tex", b_content, project_dir, "A.tex"))
