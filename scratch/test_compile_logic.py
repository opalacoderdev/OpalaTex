import os
import sys

sys.path.insert(0, os.path.abspath('.'))

from opalatex.latex_compiler import determine_main_file_for_compilation, compile_latex

project_dir = os.path.abspath("test_latex_dir2")
os.makedirs(project_dir, exist_ok=True)
with open(f"{project_dir}/A.tex", "w") as f: f.write("\\documentclass{article}\n\\begin{document}\n\\input{B.tex}\n\\end{document}")
with open(f"{project_dir}/B.tex", "w") as f: f.write("I am B")
with open(f"{project_dir}/C.tex", "w") as f: f.write("\\documentclass{article}\n\\begin{document}\nI am C\n\\end{document}")

content = "\\documentclass{article}\n\\begin{document}\nI am C\n\\end{document}"
full_path = f"{project_dir}/C.tex"
project_path = project_dir

# From ide_server.py
main_file = "A.tex" # simulated

main_file = determine_main_file_for_compilation(full_path, content, project_path, main_file)
print("Resolved main_file:", main_file)

# What if tectonic is not installed? Let's check the parameters to compile_latex.
res = compile_latex(content, full_path, main_file, project_path)
print("Compile result:", res)
