import sqlite3
from typing import List, Dict, Any
from datetime import datetime, timezone
from .base import BaseRecallMemory

class SQLiteRecallMemory(BaseRecallMemory):
    """
    Recall Memory implementation using SQLite for rolling conversation history.
    
    If an in-memory database is desired, pass db_path=':memory:'.
    """
    
    def __init__(self, db_path: str = "recall.db"):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT,
                    role TEXT,
                    content TEXT
                )
            ''')
            # Create an index on content for faster LIKE queries
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_history_content 
                ON history (content)
            ''')
            conn.commit()

    def append_message(self, role: str, content: str) -> None:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            timestamp = datetime.now(timezone.utc).isoformat()
            cursor.execute(
                "INSERT INTO history (timestamp, role, content) VALUES (?, ?, ?)",
                (timestamp, role, content)
            )
            conn.commit()

    def search_keyword(self, keyword: str, limit: int = 10) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT timestamp, role, content FROM history WHERE content LIKE ? ORDER BY timestamp DESC LIMIT ?",
                (f"%{keyword}%", limit)
            )
            rows = cursor.fetchall()
            return [{"timestamp": r[0], "role": r[1], "content": r[2]} for r in rows]
