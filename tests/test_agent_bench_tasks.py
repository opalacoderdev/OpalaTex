"""The agent benchmark's tasks stay solvable and unsolved (scripts/agent_bench)."""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_every_benchmark_task_fails_unsolved_and_passes_with_its_solution():
    run = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "agent_bench", "run.py"), "--self-check"],
        capture_output=True, text=True, timeout=300,
    )
    assert run.returncode == 0, run.stdout + run.stderr
    assert "FAIL" not in run.stdout
