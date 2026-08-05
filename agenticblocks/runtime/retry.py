import asyncio
from functools import wraps
from typing import Callable, Type

def with_retry(
    max_attempts: int = 3,
    delay: float = 1.0,
    backoff: float = 2.0,
    exceptions: tuple[Type[Exception], ...] = (Exception,),
) -> Callable:
    def decorator(fn: Callable) -> Callable:
        @wraps(fn)
        async def wrapper(*args, **kwargs):
            attempt = 0
            current_delay = delay
            while True:
                try:
                    return await fn(*args, **kwargs)
                except exceptions as exc:
                    attempt += 1
                    if attempt >= max_attempts:
                        raise
                    await asyncio.sleep(current_delay)
                    current_delay *= backoff
        return wrapper
    return decorator
