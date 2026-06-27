"""Multi-language code symbol index with SQLite persistence.

Uses tree-sitter-language-pack as the primary extraction engine — supports
any language with a tree-sitter grammar (300+ languages, including future ones
as new grammars are published). Falls back to regex patterns for languages
whose grammar hasn't been downloaded yet.

The index persists to SQLite inside the project's .opalatex/ directory and
is rebuilt incrementally on file mtime changes. Every write_file / edit_file
call triggers a single-file reindex so the index stays fresh within a cycle.

Usage (singleton — same pattern as AGENT_PROGRESS):
    from .code_index import CODE_INDEX
    CODE_INDEX.set_project(path)     # called once by the orchestrator
    CODE_INDEX.build()               # incremental full scan
    CODE_INDEX.rebuild_file(path)    # called by edit_file / write_file
    symbols  = CODE_INDEX.search("authenticate")
    callers  = CODE_INDEX.find_callers("login")
    snapshot = CODE_INDEX.project_snapshot()
"""

from __future__ import annotations

import ast
import os
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Symbol:
    name: str
    kind: str          # function | class | method | interface | enum | const | type | module
    file: str          # relative to project root
    line: int          # 1-based
    signature: str
    exported: bool
    calls: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Language detection — extension → tree-sitter language name
# ---------------------------------------------------------------------------

_EXT_TO_LANG: dict[str, str] = {
    ".py": "python", ".pyw": "python",
    ".ts": "typescript", ".tsx": "tsx",
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".jsx": "javascript",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".c": "c", ".h": "c",
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".kt": "kotlin", ".kts": "kotlin",
    ".swift": "swift",
    ".zig": "zig",
    ".lua": "lua",
    ".scala": "scala",
    ".ex": "elixir", ".exs": "elixir",
    ".hs": "haskell",
    ".ml": "ocaml", ".mli": "ocaml",
    ".clj": "clojure", ".cljs": "clojure",
    ".elm": "elm",
    ".erl": "erlang", ".hrl": "erlang",
    ".dart": "dart",
    ".r": "r", ".R": "r",
    ".jl": "julia",
    ".nim": "nim",
    ".v": "v",
    ".odin": "odin",
    ".gleam": "gleam",
    ".zig": "zig",
    ".sol": "solidity",
    ".proto": "proto",
    ".graphql": "graphql", ".gql": "graphql",
    ".vue": "vue",
    ".svelte": "svelte",
    ".css": "css", ".scss": "scss", ".less": "less",
    ".html": "html", ".htm": "html",
    ".sh": "bash", ".bash": "bash",
    ".sql": "sql",
    ".tf": "terraform", ".hcl": "hcl",
    ".yaml": "yaml", ".yml": "yaml",
    ".toml": "toml",
    ".json": "json",
    ".md": "markdown",
}

# Kinds that contain callable code — used to infer exported status
_CALLABLE_KINDS = {"function", "method"}

# tree-sitter node kind → our Symbol kind
_TS_KIND_MAP: dict[str, str] = {
    "function_definition": "function",
    "function_declaration": "function",
    "method_definition": "method",
    "method_declaration": "method",
    "class_definition": "class",
    "class_declaration": "class",
    "struct_item": "class",
    "struct_declaration": "class",
    "impl_item": "class",
    "interface_declaration": "interface",
    "interface_definition": "interface",
    "trait_item": "interface",
    "enum_item": "enum",
    "enum_declaration": "enum",
    "const_item": "const",
    "const_declaration": "const",
    "variable_declaration": "const",
    "type_alias_declaration": "type",
    "type_item": "type",
    "type_definition": "type",
    "module_declaration": "module",
    "mod_item": "module",
    "fn_item": "function",
    "function_item": "function",
    "arrow_function": "function",
    "lexical_declaration": "const",
}

# Node kinds that carry a symbol name in a child identifier
_NAME_BEARING_KINDS = set(_TS_KIND_MAP.keys())

# Node kinds that represent call sites
_CALL_KINDS = {"call", "call_expression", "method_call", "function_call",
               "invocation_expression", "call_statement"}

_SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    ".mypy_cache", "dist", "build", "target", ".opalatex",
    ".next", ".nuxt", "coverage", ".tox",
}

# File extensions we index (keys of _EXT_TO_LANG)
_INDEXED_EXTS = set(_EXT_TO_LANG.keys())


# ---------------------------------------------------------------------------
# Regex fallback patterns (for languages without a downloadable grammar)
# ---------------------------------------------------------------------------

@dataclass
class _RegexPattern:
    regex: re.Pattern
    name_group: int
    kind: str
    exported_prefix: tuple[str, ...]


_GENERIC_PATTERNS: list[_RegexPattern] = [
    _RegexPattern(
        re.compile(r"^(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)"),
        1, "function", ("pub ",)),
    _RegexPattern(
        re.compile(r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)"),
        1, "function", ("export ",)),
    _RegexPattern(
        re.compile(r"^(?:async\s+)?def\s+(\w+)"),
        1, "function", ()),
    _RegexPattern(
        re.compile(r"^(?:export\s+)?(?:abstract\s+|sealed\s+|data\s+)?class\s+(\w+)"),
        1, "class", ("export ", "public ")),
    _RegexPattern(
        re.compile(r"^(?:export\s+)?interface\s+(\w+)"),
        1, "interface", ("export ", "public ")),
    _RegexPattern(
        re.compile(r"^(?:pub\s+)?(?:struct|enum|trait|type)\s+(\w+)"),
        1, "class", ("pub ",)),
    _RegexPattern(
        re.compile(r"^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)"),
        1, "function", ()),
]

_CALL_RE = re.compile(r"\b(\w+)\s*\(")


# ---------------------------------------------------------------------------
# Extraction: tree-sitter path
# ---------------------------------------------------------------------------

def _lang_name(ext: str) -> Optional[str]:
    return _EXT_TO_LANG.get(ext.lower())


def _get_ts_parser(lang: str):
    """Return a tree-sitter Parser for *lang*, or None if unavailable."""
    try:
        import tree_sitter_language_pack as lp
        return lp.get_parser(lang)
    except Exception:
        return None


def _walk_ts(node, src_bytes: bytes, rel_path: str, symbols: list[Symbol]) -> None:
    """Recursively walk a tree-sitter node tree and collect symbols."""
    kind_name = node.kind()
    ts_kind = _TS_KIND_MAP.get(kind_name)

    if ts_kind:
        # Find the identifier child that carries the name
        name: Optional[str] = None
        for i in range(node.child_count()):
            child = node.child(i)
            if child.kind() in ("identifier", "name", "property_identifier",
                                 "field_identifier", "type_identifier"):
                name = src_bytes[child.start_byte():child.end_byte()].decode("utf-8", errors="replace")
                break
        if name and len(name) >= 2:
            sig_end = min(node.end_byte(), node.start_byte() + 200)
            sig = src_bytes[node.start_byte():sig_end].decode("utf-8", errors="replace")
            sig = sig.replace("\n", " ").strip()[:120]
            line = node.start_position().row + 1  # 0-based → 1-based
            exported = not name.startswith("_")

            # Collect call names within this node
            calls = _collect_calls_ts(node, src_bytes, name)

            symbols.append(Symbol(
                name=name,
                kind=ts_kind,
                file=rel_path,
                line=line,
                signature=sig,
                exported=exported,
                calls=calls,
            ))
            # Don't recurse into children of a found definition (avoids double-counting)
            return

    for i in range(node.child_count()):
        _walk_ts(node.child(i), src_bytes, rel_path, symbols)


def _collect_calls_ts(node, src_bytes: bytes, self_name: str) -> list[str]:
    """Collect the names of all call-site identifiers within *node*."""
    calls: list[str] = []
    _collect_calls_ts_inner(node, src_bytes, calls)
    return sorted(set(calls) - {self_name})


def _collect_calls_ts_inner(node, src_bytes: bytes, out: list[str]) -> None:
    if node.kind() in _CALL_KINDS:
        # First named child of a call is usually the function/method name
        for i in range(node.child_count()):
            child = node.child(i)
            ck = child.kind()
            if ck in ("identifier", "field_expression", "member_expression",
                       "scoped_identifier", "attribute"):
                # For member/field access, take the last identifier
                raw = src_bytes[child.start_byte():child.end_byte()].decode("utf-8", errors="replace")
                # Use only the last segment (method name)
                callee = raw.split(".")[-1].split("::")[-1]
                if len(callee) >= 2:
                    out.append(callee)
                break
    for i in range(node.child_count()):
        _collect_calls_ts_inner(node.child(i), src_bytes, out)


def _extract_ts(source: str, lang: str, rel_path: str) -> Optional[list[Symbol]]:
    """Extract symbols using tree-sitter. Returns None if unavailable."""
    parser = _get_ts_parser(lang)
    if parser is None:
        return None
    try:
        tree = parser.parse(source)
        root = tree.root_node()
        src_bytes = source.encode("utf-8", errors="replace")
        symbols: list[Symbol] = []
        _walk_ts(root, src_bytes, rel_path, symbols)
        return symbols
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Extraction: Python ast path (most accurate for call graphs)
# ---------------------------------------------------------------------------

def _extract_py_ast(source: str, rel_path: str) -> list[Symbol]:
    """Extract symbols from Python source using the stdlib ast module."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []

    symbols: list[Symbol] = []

    def _calls_in(node: ast.AST) -> list[str]:
        names: list[str] = []
        for child in ast.walk(node):
            if isinstance(child, ast.Call):
                if isinstance(child.func, ast.Name):
                    names.append(child.func.id)
                elif isinstance(child.func, ast.Attribute):
                    names.append(child.func.attr)
        return sorted(set(names))

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = [a.arg for a in node.args.args]
            sig = f"def {node.name}({', '.join(args)})"
            symbols.append(Symbol(
                name=node.name,
                kind="function",
                file=rel_path,
                line=node.lineno,
                signature=sig[:120],
                exported=not node.name.startswith("_"),
                calls=_calls_in(node),
            ))
        elif isinstance(node, ast.ClassDef):
            symbols.append(Symbol(
                name=node.name,
                kind="class",
                file=rel_path,
                line=node.lineno,
                signature=f"class {node.name}",
                exported=not node.name.startswith("_"),
                calls=[],
            ))

    return symbols


# ---------------------------------------------------------------------------
# Extraction: regex fallback
# ---------------------------------------------------------------------------

def _extract_regex(source: str, rel_path: str) -> list[Symbol]:
    """Generic regex extraction — works for any C/Python/Rust-style syntax."""
    symbols: list[Symbol] = []
    for i, line in enumerate(source.splitlines(), start=1):
        trimmed = line.strip()
        for pat in _GENERIC_PATTERNS:
            m = pat.regex.match(trimmed)
            if not m:
                continue
            name = m.group(pat.name_group)
            if not name or len(name) < 2:
                continue
            exported = any(trimmed.startswith(p) for p in pat.exported_prefix) if pat.exported_prefix else True
            calls = [c for c in _CALL_RE.findall(trimmed) if c != name and len(c) > 1]
            symbols.append(Symbol(
                name=name,
                kind=pat.kind,
                file=rel_path,
                line=i,
                signature=trimmed[:120],
                exported=exported,
                calls=sorted(set(calls)),
            ))
            break
    return symbols


# ---------------------------------------------------------------------------
# Unified extraction entry point
# ---------------------------------------------------------------------------

def _extract(source: str, ext: str, rel_path: str) -> list[Symbol]:
    """Extract symbols from source, choosing the best available strategy."""
    # Python: stdlib ast is more accurate than tree-sitter for call graphs
    if ext == ".py":
        syms = _extract_py_ast(source, rel_path)
        if syms:
            return syms

    # All other languages: try tree-sitter first
    lang = _lang_name(ext)
    if lang:
        syms = _extract_ts(source, lang, rel_path)
        if syms is not None:
            return syms

    # Fallback: generic regex
    return _extract_regex(source, rel_path)


# ---------------------------------------------------------------------------
# SQLite schema
# ---------------------------------------------------------------------------

_DDL = """
CREATE TABLE IF NOT EXISTS symbols (
    id        INTEGER PRIMARY KEY,
    name      TEXT    NOT NULL,
    kind      TEXT    NOT NULL,
    file      TEXT    NOT NULL,
    line      INTEGER NOT NULL,
    signature TEXT    NOT NULL,
    exported  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sym_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_sym_file ON symbols(file);

CREATE TABLE IF NOT EXISTS calls (
    caller_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    callee_name TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_name);

CREATE TABLE IF NOT EXISTS file_mtimes (
    path  TEXT PRIMARY KEY,
    mtime REAL NOT NULL
);
"""


def _open_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(_DDL)
    conn.commit()
    return conn


# ---------------------------------------------------------------------------
# CodeIndex
# ---------------------------------------------------------------------------

class CodeIndex:
    """Project-scoped symbol index backed by SQLite.

    Thread-safety: not thread-safe. The orchestrator runs a single async
    event loop — concurrent access is not expected.
    """

    def __init__(self) -> None:
        self._root: str = ""
        self._db_path: str = ""
        self._conn: Optional[sqlite3.Connection] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def set_project(self, root: str) -> None:
        """Point the index at *root*. Opens (or creates) the SQLite DB."""
        root = os.path.abspath(root)
        if root == self._root and self._conn is not None:
            return
        self._root = root
        db_dir = os.path.join(root, ".opalatex")
        os.makedirs(db_dir, exist_ok=True)
        self._db_path = os.path.join(db_dir, "code_index.sqlite")
        if self._conn:
            self._conn.close()
        self._conn = _open_db(self._db_path)

    def _conn_or_raise(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RuntimeError("CodeIndex: call set_project() before using the index.")
        return self._conn

    def close(self) -> None:
        """Close the SQLite connection to release file locks."""
        if self._conn:
            self._conn.close()
            self._conn = None
        self._root = ""
        self._db_path = ""

    # ------------------------------------------------------------------
    # Build / incremental update
    # ------------------------------------------------------------------

    def build(self) -> dict[str, int]:
        """Scan the project, index all changed files.

        Returns {"indexed": N, "skipped": M, "total": N+M}.
        """
        conn = self._conn_or_raise()
        root = Path(self._root)
        indexed = skipped = 0

        for p in sorted(root.rglob("*")):
            if not p.is_file():
                continue
            if any(part in _SKIP_DIRS or part.startswith(".") for part in p.parts):
                continue
            if p.suffix.lower() not in _INDEXED_EXTS:
                continue

            rel = str(p.relative_to(root))
            try:
                mtime = p.stat().st_mtime
            except OSError:
                continue

            row = conn.execute(
                "SELECT mtime FROM file_mtimes WHERE path = ?", (rel,)
            ).fetchone()

            if row and abs(row[0] - mtime) < 0.01:
                skipped += 1
                continue

            self._index_file(conn, p, rel)
            conn.execute(
                "INSERT OR REPLACE INTO file_mtimes(path, mtime) VALUES (?, ?)",
                (rel, mtime),
            )
            indexed += 1

        conn.commit()
        return {"indexed": indexed, "skipped": skipped, "total": indexed + skipped}

    def rebuild_file(self, abs_or_rel_path: str) -> None:
        """Re-index a single file after it has been written or edited."""
        if not self._root or self._conn is None:
            return
        conn = self._conn
        root = Path(self._root)
        p = Path(abs_or_rel_path)
        if not p.is_absolute():
            p = root / p
        if not p.exists():
            return

        try:
            rel = str(p.relative_to(root))
        except ValueError:
            return

        self._index_file(conn, p, rel)
        try:
            conn.execute(
                "INSERT OR REPLACE INTO file_mtimes(path, mtime) VALUES (?, ?)",
                (rel, p.stat().st_mtime),
            )
            conn.commit()
        except Exception:
            pass

    def _index_file(self, conn: sqlite3.Connection, p: Path, rel: str) -> None:
        """Delete old entries for *rel* and insert freshly extracted symbols."""
        try:
            source = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return

        ext = p.suffix.lower()
        symbols = _extract(source, ext, rel)

        conn.execute("DELETE FROM symbols WHERE file = ?", (rel,))
        for sym in symbols:
            cur = conn.execute(
                "INSERT INTO symbols(name, kind, file, line, signature, exported) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (sym.name, sym.kind, sym.file, sym.line, sym.signature, int(sym.exported)),
            )
            sym_id = cur.lastrowid
            for callee in sym.calls:
                conn.execute(
                    "INSERT INTO calls(caller_id, callee_name) VALUES (?, ?)",
                    (sym_id, callee),
                )

    # ------------------------------------------------------------------
    # Query helpers
    # ------------------------------------------------------------------

    def _row_to_symbol(self, conn: sqlite3.Connection, row: tuple) -> Symbol:
        sym_id, name, kind, file_, line, sig, exported = row
        calls = [r[0] for r in conn.execute(
            "SELECT callee_name FROM calls WHERE caller_id = ?", (sym_id,)
        )]
        return Symbol(name=name, kind=kind, file=file_, line=line,
                      signature=sig, exported=bool(exported), calls=calls)

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def search(self, query: str, limit: int = 10) -> list[Symbol]:
        """Search symbols by name: exact → prefix → substring."""
        conn = self._conn_or_raise()
        q = query.lower()
        seen: set[int] = set()
        results: list[Symbol] = []

        _BASE = ("SELECT id, name, kind, file, line, signature, exported "
                 "FROM symbols")

        def _fetch(sql: str, params: tuple) -> None:
            for row in conn.execute(sql, params):
                if row[0] in seen or len(results) >= limit:
                    return
                seen.add(row[0])
                results.append(self._row_to_symbol(conn, row))

        _fetch(f"{_BASE} WHERE lower(name) = ? LIMIT ?", (q, limit))
        if len(results) < limit:
            _fetch(f"{_BASE} WHERE lower(name) LIKE ? AND lower(name) != ? LIMIT ?",
                   (q + "%", q, limit - len(results)))
        if len(results) < limit:
            _fetch(f"{_BASE} WHERE lower(name) LIKE ? AND lower(name) NOT LIKE ? LIMIT ?",
                   ("%" + q + "%", q + "%", limit - len(results)))

        return results

    def find_callers(self, callee_name: str, limit: int = 20) -> list[Symbol]:
        """Return all symbols that call *callee_name* (reverse call graph)."""
        conn = self._conn_or_raise()
        sql = """
            SELECT DISTINCT s.id, s.name, s.kind, s.file, s.line, s.signature, s.exported
            FROM symbols s
            JOIN calls c ON c.caller_id = s.id
            WHERE lower(c.callee_name) = lower(?)
            LIMIT ?
        """
        return [self._row_to_symbol(conn, row)
                for row in conn.execute(sql, (callee_name, limit))]

    def symbols_in_file(self, rel_path: str) -> list[Symbol]:
        """Return all symbols defined in *rel_path* (relative to project root)."""
        conn = self._conn_or_raise()
        rows = conn.execute(
            "SELECT id, name, kind, file, line, signature, exported "
            "FROM symbols WHERE file = ? ORDER BY line",
            (rel_path,),
        ).fetchall()
        return [self._row_to_symbol(conn, row) for row in rows]

    # ------------------------------------------------------------------
    # Context helpers for oracle prompts
    # ------------------------------------------------------------------

    def project_snapshot(self, max_files: int = 100) -> str:
        """Return a symbol-enriched project snapshot for oracle prompts.

        Each indexed file is listed with its exported symbols so the planner
        can reference concrete function/class names instead of guessing.
        """
        conn = self._conn_or_raise()
        rows = conn.execute(
            "SELECT DISTINCT file FROM symbols ORDER BY file LIMIT ?", (max_files,)
        ).fetchall()

        if not rows:
            return "(index empty — run build() first)"

        parts: list[str] = []
        for (rel,) in rows:
            syms = conn.execute(
                "SELECT name, kind FROM symbols "
                "WHERE file = ? AND exported = 1 ORDER BY line",
                (rel,),
            ).fetchall()
            if syms:
                sym_str = ", ".join(f"{k} {n}" for n, k in syms[:12])
                if len(syms) > 12:
                    sym_str += f" (+{len(syms) - 12} more)"
                parts.append(f"{rel}  [{sym_str}]")
            else:
                parts.append(rel)

        n_sym = conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0]
        header = f"# Project index: {n_sym} symbols across {len(rows)} files\n"
        return header + "\n".join(parts)

    def stats(self) -> str:
        conn = self._conn_or_raise()
        n_sym = conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0]
        n_files = conn.execute("SELECT COUNT(DISTINCT file) FROM symbols").fetchone()[0]
        n_calls = conn.execute("SELECT COUNT(*) FROM calls").fetchone()[0]
        return f"{n_sym} symbols, {n_calls} call edges across {n_files} files"


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

CODE_INDEX = CodeIndex()
