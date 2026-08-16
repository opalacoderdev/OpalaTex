"""Token counting for assembled chat requests.

Blocks need to know how large a request is *before* sending it -- to decide when
to evict, and to let a host application show real context occupancy while tools
are still running, instead of waiting for the provider's `usage` on the next
response.
"""
import json
from typing import Any, Dict, List

import litellm


def count_message_tokens(model: str, messages: List[Dict[str, Any]]) -> int:
    """Return the token count of *messages* for *model*.

    Falls back to a coarse character estimate when the model has no registered
    tokenizer, so callers always get a usable number.
    """
    try:
        return litellm.token_counter(model=model, messages=messages)
    except Exception:
        return len(json.dumps(messages)) // 4
