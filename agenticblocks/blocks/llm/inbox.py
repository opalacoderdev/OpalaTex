"""Out-of-band messages delivered to an agent that is already running.

An agent loop normally sees one prompt per ``run`` call. A caller driving a live
conversation often needs to hand the loop something *while* it works: a
correction, an extra constraint, an answer the user only thought of after the
turn started. Mutating the history from outside is not a way to do that — the
loop may sit between an assistant tool call and its results, where an inserted
message produces a request no provider accepts.

``MessageInbox`` is the channel for it. Producers :meth:`submit` at any time,
from any thread; the agent loop :meth:`drain`\\ s at a boundary it chooses, where
its history is known to be well formed. Delivery is therefore *eventual, at the
next boundary*, never immediate — a caller that reports it as immediate is
describing something the loop does not promise.

Nothing is dropped silently. Submitting to a closed inbox raises, overflowing it
raises, and whatever is still pending when the run ends is returned by
:meth:`close` for the caller to deal with explicitly.
"""

import threading
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

DEFAULT_MAX_PENDING = 32

VALID_ROLES = ("user", "system")


class InboxError(RuntimeError):
    """Base class for inbox submission failures."""


class InboxClosedError(InboxError):
    """Raised when submitting to an inbox whose run has already ended."""


class InboxFullError(InboxError):
    """Raised when the pending queue is at ``max_pending``."""


@dataclass
class InboxItem:
    """One message waiting to be handed to a running agent."""

    content: str
    item_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    role: str = "user"
    attachments: List[dict] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    """Caller-owned bag carried through delivery untouched.

    The framework never reads it. A host uses it to correlate the delivered item
    with whatever it is tracking on its own side (a message id, a chat id).
    """


class MessageInbox:
    """A bounded, thread-safe queue of messages for a running agent.

    The inbox belongs to one run: create it before ``run``, attach it to the
    block, and :meth:`close` it when the run ends. Reusing one across runs would
    let a message typed for a finished turn arrive in an unrelated one.
    """

    def __init__(self, *, max_pending: int = DEFAULT_MAX_PENDING):
        if max_pending < 1:
            raise ValueError("max_pending must be at least 1")
        self._max_pending = max_pending
        self._items: List[InboxItem] = []
        self._closed = False
        self._lock = threading.Lock()

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def max_pending(self) -> int:
        return self._max_pending

    def submit(
        self,
        content: str,
        *,
        role: str = "user",
        attachments: Optional[List[dict]] = None,
        item_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> InboxItem:
        """Queue a message for the next delivery boundary.

        Raises :class:`InboxClosedError` when the run has ended and
        :class:`InboxFullError` when ``max_pending`` messages are already
        waiting — both are reported to the caller rather than being absorbed,
        because a queued message that never arrives is worse than a rejected one.
        """
        if role not in VALID_ROLES:
            raise ValueError(f"role must be one of {VALID_ROLES}; got {role!r}")
        text = (content or "").strip()
        if not text:
            raise ValueError("content must be a non-empty string")
        attachments = list(attachments or [])
        if attachments and role != "user":
            raise ValueError("attachments require role='user'")

        item = InboxItem(
            content=text,
            item_id=item_id or str(uuid.uuid4()),
            role=role,
            attachments=attachments,
            metadata=dict(metadata or {}),
        )
        with self._lock:
            if self._closed:
                raise InboxClosedError("the agent run this inbox belongs to has ended")
            if len(self._items) >= self._max_pending:
                raise InboxFullError(
                    f"{self._max_pending} messages are already waiting for delivery"
                )
            if any(existing.item_id == item.item_id for existing in self._items):
                raise ValueError(f"item_id {item.item_id!r} is already queued")
            self._items.append(item)
        return item

    def cancel(self, item_id: str) -> bool:
        """Drop a pending message. Returns False when it was already delivered."""
        with self._lock:
            for index, item in enumerate(self._items):
                if item.item_id == item_id:
                    del self._items[index]
                    return True
        return False

    def pending(self) -> List[InboxItem]:
        """Return the messages still waiting, oldest first."""
        with self._lock:
            return list(self._items)

    def drain(self) -> List[InboxItem]:
        """Atomically take every pending message, oldest first."""
        with self._lock:
            items = self._items
            self._items = []
        return items

    def close(self) -> List[InboxItem]:
        """Close the inbox and return whatever was never delivered.

        The leftovers are handed back instead of discarded: they are messages a
        user wrote and is entitled to an answer for, and only the caller knows
        where they should go now (usually the next turn).
        """
        with self._lock:
            self._closed = True
            items = self._items
            self._items = []
        return items

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)

    def __bool__(self) -> bool:
        return len(self) > 0
