"""Version Control System (VCS) strategies for OpalaTex."""

import os
import shutil
import subprocess
from abc import ABC, abstractmethod
from typing import List, Callable
from agenticblocks.core.function_block import as_tool

from . import terminal as T
from .subprocess_utils import utf8_text_kwargs
from .tools import AGENT_PROGRESS, _preview, get_project_path

# ─── Base Strategy ────────────────────────────────────────────────────────────

class VersionControlStrategy(ABC):
    def __init__(self, project_path: str):
        self.project_path = os.path.abspath(project_path)

    @abstractmethod
    def setup(self):
        """Initialize VCS environment (e.g. create shadow git, gitignore)."""
        pass

    @abstractmethod
    def pre_run(self, context_msg: str):
        """Called before the agent starts executing its plan."""
        pass

    @abstractmethod
    def post_run(self, success: bool, msg: str = ""):
        """Called after the agent finishes its execution."""
        pass

    @abstractmethod
    def get_tools(self) -> List[Callable]:
        """Return a list of git tools available to the agent."""
        pass

    @abstractmethod
    def manual_commit(self, message: str) -> tuple[bool, str]:
        """Manually commit changes to the VCS."""
        pass

    @abstractmethod
    def undo_last(self) -> tuple[bool, str]:
        """Undo the last change in the VCS."""
        pass

    @abstractmethod
    def list_checkpoints(self) -> tuple[bool, str]:
        """List all checkpoints."""
        pass

    @abstractmethod
    def restore_checkpoint(self, checkpoint_id: str) -> tuple[bool, str]:
        """Restore the project to a specific checkpoint."""
        pass

    @abstractmethod
    def remove_checkpoint(self, checkpoint_id: str) -> tuple[bool, str]:
        """Remove a specific checkpoint."""
        pass


# ─── Shadow Git Helper ────────────────────────────────────────────────────────

def _run_shadow_git(command: str, project_path: str | None = None) -> subprocess.CompletedProcess:
    """Run a Git command using the internal shadow git directory."""
    if project_path is None:
        project_path = get_project_path()
    shadow_dir = os.path.join(project_path, ".opalatex", ".shadowgit")
    full_cmd = f'git --git-dir="{shadow_dir}" --work-tree="{project_path}" {command}'
    return subprocess.run(
        full_cmd,
        shell=True,
        capture_output=True,
        **utf8_text_kwargs(),
        cwd=project_path
    )

def _init_shadow_git(project_path: str):
    """Initialize the shadow git repository if it doesn't exist."""
    shadow_base = os.path.join(project_path, ".opalatex")
    shadow_dir = os.path.join(shadow_base, ".shadowgit")
    old_shadow_dir = os.path.join(shadow_base, ".git")
    gitignore_path = os.path.join(shadow_base, ".gitignore")
    
    os.makedirs(shadow_base, exist_ok=True)

    # Migrate existing projects from .git to .shadowgit
    if os.path.exists(old_shadow_dir) and not os.path.exists(shadow_dir):
        shutil.move(old_shadow_dir, shadow_dir)

    if not os.path.exists(shadow_dir):
        # Init repo
        cmd = f'git --git-dir="{shadow_dir}" --work-tree="{project_path}" init'
        subprocess.run(cmd, shell=True, capture_output=True, cwd=project_path)
        
        # Configure excludes file
        if not os.path.exists(gitignore_path):
            with open(gitignore_path, "w", encoding="utf-8") as f:
                f.write(".env\nnode_modules/\n__pycache__/\n.venv/\n")
                
        cmd_exclude = f'git --git-dir="{shadow_dir}" --work-tree="{project_path}" config core.excludesFile "{gitignore_path}"'
        subprocess.run(cmd_exclude, shell=True, capture_output=True, cwd=project_path)
        
        # Initial commit
        _run_shadow_git("add .", project_path)
        _run_shadow_git("commit -m 'Initial checkpoint (Auto)'", project_path)

def _auto_checkpoint(message: str, project_path: str | None = None):
    """Automatically create a checkpoint in the shadow git."""
    _run_shadow_git("add .", project_path)
    res = _run_shadow_git(f"commit -m '{message}'", project_path)
    return res.returncode == 0


# ─── Agent Git Tools ──────────────────────────────────────────────────────────

@as_tool(name="git_status", description="Get the status of the internal version control. Shows modified/added files.")
def git_status() -> str:
    AGENT_PROGRESS.update("git_status")
    res = _run_shadow_git("status -s")
    return res.stdout if res.stdout.strip() else "Working tree clean."

@as_tool(name="git_diff", description="Get the diff of the internal version control to see exact code changes.")
def git_diff() -> str:
    AGENT_PROGRESS.update("git_diff")
    res = _run_shadow_git("diff")
    return res.stdout if res.stdout.strip() else "No changes."

@as_tool(name="git_commit", description="Commit all current changes to the internal version control. Use this to save milestones.")
def git_commit(message: str) -> str:
    AGENT_PROGRESS.update("git_commit", _preview(message))
    _run_shadow_git("add .")
    res = _run_shadow_git(f'commit -m "{message}"')
    if res.returncode == 0:
        return f"Successfully committed: {message}"
    return f"Failed to commit or nothing to commit. Output: {res.stderr or res.stdout}"


# ─── Concrete Strategies ──────────────────────────────────────────────────────

class AutoGitStrategy(VersionControlStrategy):
    """Deterministic mode: Shadow Git initialized, pre/post checkpoints enforced, NO tools given to agent."""

    def setup(self):
        _init_shadow_git(self.project_path)

    def pre_run(self, context_msg: str):
        _auto_checkpoint("Pre-run checkpoint: Before executing plan", self.project_path)

    def post_run(self, success: bool, msg: str = ""):
        status = "Success" if success else "Failed"
        _auto_checkpoint(f"Post-run checkpoint: {status}. {msg}", self.project_path)

    def get_tools(self) -> List[Callable]:
        return []

    def manual_commit(self, message: str) -> tuple[bool, str]:
        _run_shadow_git("add .", self.project_path)
        res = _run_shadow_git(f"commit -m '{message}'", self.project_path)
        if res.returncode == 0:
            return True, "Committed."
        err_out = res.stderr or res.stdout
        if "nothing to commit" in err_out.lower():
            from .i18n import _
            return False, _("commit_nothing")
        return False, err_out

    def undo_last(self) -> tuple[bool, str]:
        res = _run_shadow_git("rev-parse HEAD~1", self.project_path)
        if res.returncode != 0:
            return False, "Cannot undo. No previous checkpoints."
        _run_shadow_git("reset --hard HEAD~1", self.project_path)
        _run_shadow_git("clean -fd", self.project_path)
        return True, "Last change undone."

    def list_checkpoints(self) -> tuple[bool, str]:
        res = _run_shadow_git("log --oneline", self.project_path)
        if res.returncode == 0:
            return True, res.stdout
        return False, res.stderr or res.stdout

    def restore_checkpoint(self, checkpoint_id: str) -> tuple[bool, str]:
        res = _run_shadow_git(f"reset --hard {checkpoint_id}", self.project_path)
        if res.returncode == 0:
            _run_shadow_git("clean -fd", self.project_path)
            return True, f"Restored to checkpoint {checkpoint_id}."
        return False, f"Failed to restore checkpoint {checkpoint_id}: {res.stderr}"

    def remove_checkpoint(self, checkpoint_id: str) -> tuple[bool, str]:
        res = _run_shadow_git(f"rebase --onto {checkpoint_id}^ {checkpoint_id} HEAD", self.project_path)
        if res.returncode == 0:
            return True, f"Checkpoint {checkpoint_id} removed successfully."
        _run_shadow_git("rebase --abort", self.project_path)
        return False, f"Failed to remove checkpoint {checkpoint_id} (likely conflicts). Stderr: {res.stderr}"


class HybridGitStrategy(VersionControlStrategy):
    """Hybrid mode: Shadow Git initialized, agent has tools, orchestrator ensures safety checkpoints."""

    def setup(self):
        _init_shadow_git(self.project_path)

    def pre_run(self, context_msg: str):
        _auto_checkpoint("Pre-run checkpoint: Before executing plan", self.project_path)

    def post_run(self, success: bool, msg: str = ""):
        status = "Success" if success else "Failed"
        _auto_checkpoint(f"Post-run checkpoint: {status}. {msg}", self.project_path)

    def get_tools(self) -> List[Callable]:
        return [git_status, git_diff, git_commit]

    def manual_commit(self, message: str) -> tuple[bool, str]:
        _run_shadow_git("add .", self.project_path)
        res = _run_shadow_git(f"commit -m '{message}'", self.project_path)
        if res.returncode == 0:
            return True, "Committed."
        err_out = res.stderr or res.stdout
        if "nothing to commit" in err_out.lower():
            from .i18n import _
            return False, _("commit_nothing")
        return False, err_out

    def undo_last(self) -> tuple[bool, str]:
        res = _run_shadow_git("rev-parse HEAD~1", self.project_path)
        if res.returncode != 0:
            return False, "Cannot undo. No previous checkpoints."
        _run_shadow_git("reset --hard HEAD~1", self.project_path)
        _run_shadow_git("clean -fd", self.project_path)
        return True, "Last change undone."

    def list_checkpoints(self) -> tuple[bool, str]:
        res = _run_shadow_git("log --oneline", self.project_path)
        if res.returncode == 0:
            return True, res.stdout
        return False, res.stderr or res.stdout

    def restore_checkpoint(self, checkpoint_id: str) -> tuple[bool, str]:
        res = _run_shadow_git(f"reset --hard {checkpoint_id}", self.project_path)
        if res.returncode == 0:
            _run_shadow_git("clean -fd", self.project_path)
            return True, f"Restored to checkpoint {checkpoint_id}."
        return False, f"Failed to restore checkpoint {checkpoint_id}: {res.stderr}"

    def remove_checkpoint(self, checkpoint_id: str) -> tuple[bool, str]:
        res = _run_shadow_git(f"rebase --onto {checkpoint_id}^ {checkpoint_id} HEAD", self.project_path)
        if res.returncode == 0:
            return True, f"Checkpoint {checkpoint_id} removed successfully."
        _run_shadow_git("rebase --abort", self.project_path)
        return False, f"Failed to remove checkpoint {checkpoint_id} (likely conflicts). Stderr: {res.stderr}"


class AgentDrivenGitStrategy(VersionControlStrategy):
    """Agent-driven mode: Orchestrator does nothing automatically. Agent gets tools and decides when to use them."""

    def setup(self):
        _init_shadow_git(self.project_path)

    def pre_run(self, context_msg: str):
        pass

    def post_run(self, success: bool, msg: str = ""):
        pass

    def get_tools(self) -> List[Callable]:
        return [git_status, git_diff, git_commit]

    def manual_commit(self, message: str) -> tuple[bool, str]:
        _run_shadow_git("add .", self.project_path)
        res = _run_shadow_git(f"commit -m '{message}'", self.project_path)
        if res.returncode == 0:
            return True, "Committed."
        err_out = res.stderr or res.stdout
        if "nothing to commit" in err_out.lower():
            from .i18n import _
            return False, _("commit_nothing")
        return False, err_out

    def undo_last(self) -> tuple[bool, str]:
        res = _run_shadow_git("rev-parse HEAD~1", self.project_path)
        if res.returncode != 0:
            return False, "Cannot undo. No previous checkpoints."
        _run_shadow_git("reset --hard HEAD~1", self.project_path)
        _run_shadow_git("clean -fd", self.project_path)
        return True, "Last change undone."

    def list_checkpoints(self) -> tuple[bool, str]:
        res = _run_shadow_git("log --oneline", self.project_path)
        if res.returncode == 0:
            return True, res.stdout
        return False, res.stderr or res.stdout

    def restore_checkpoint(self, checkpoint_id: str) -> tuple[bool, str]:
        res = _run_shadow_git(f"reset --hard {checkpoint_id}", self.project_path)
        if res.returncode == 0:
            _run_shadow_git("clean -fd", self.project_path)
            return True, f"Restored to checkpoint {checkpoint_id}."
        return False, f"Failed to restore checkpoint {checkpoint_id}: {res.stderr}"

    def remove_checkpoint(self, checkpoint_id: str) -> tuple[bool, str]:
        res = _run_shadow_git(f"rebase --onto {checkpoint_id}^ {checkpoint_id} HEAD", self.project_path)
        if res.returncode == 0:
            return True, f"Checkpoint {checkpoint_id} removed successfully."
        _run_shadow_git("rebase --abort", self.project_path)
        return False, f"Failed to remove checkpoint {checkpoint_id} (likely conflicts). Stderr: {res.stderr}"


class NoGitStrategy(VersionControlStrategy):
    """Null strategy: No version control at all."""
    
    def setup(self):
        pass

    def pre_run(self, context_msg: str):
        pass
        
    def post_run(self, success: bool, msg: str = ""):
        pass

    def get_tools(self) -> List[Callable]:
        return []

    def manual_commit(self, message: str) -> tuple[bool, str]:
        return False, "VCS is disabled."

    def undo_last(self) -> tuple[bool, str]:
        return False, "VCS is disabled."

    def list_checkpoints(self) -> tuple[bool, str]:
        return False, "VCS is disabled."

    def restore_checkpoint(self, checkpoint_id: str) -> tuple[bool, str]:
        return False, "VCS is disabled."

    def remove_checkpoint(self, checkpoint_id: str) -> tuple[bool, str]:
        return False, "VCS is disabled."


def get_vcs_strategy(strategy_name: str, project_path: str) -> VersionControlStrategy:
    """Factory method to get the selected strategy."""
    strategies = {
        "auto": AutoGitStrategy,
        "hybrid": HybridGitStrategy,
        "agent_driven": AgentDrivenGitStrategy,
        "none": NoGitStrategy
    }
    klass = strategies.get(strategy_name.lower(), HybridGitStrategy)
    return klass(project_path)
