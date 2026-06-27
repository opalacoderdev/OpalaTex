import json
import os
import subprocess
import sys

def test_view_editor_script(tmp_path):
    # Setup mock editor state
    state_dir = tmp_path / ".opalatex"
    state_dir.mkdir()
    state_file = state_dir / "_editor_state.json"
    
    mock_state = {
        "current_file": "src/main.py",
        "editor_content": "def greet():\n    print('Hello World')\n",
        "selected_text": "print('Hello World')"
    }
    
    with open(state_file, "w", encoding="utf-8") as f:
        json.dump(mock_state, f)
        
    script_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "skills", "view-editor", "scripts", "run_view_editor.py"
    )
    
    # Run the run_view_editor.py script as a subprocess
    result = subprocess.run(
        [sys.executable, script_path, "--project-path", str(tmp_path)],
        capture_output=True,
        text=True,
        check=True
    )
    
    output = result.stdout
    assert "src/main.py" in output
    assert "print('Hello World')" in output
    assert "def greet():" in output
