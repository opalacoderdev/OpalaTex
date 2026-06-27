import litellm
import sys
import logging

litellm.set_verbose = True
logging.basicConfig(level=logging.DEBUG)

try:
    response = litellm.completion(
        model="ollama_chat/gpt-oss:latest",
        messages=[{"role": "user", "content": "oi"}]
    )
    print("SUCCESS")
    print(response)
except Exception as e:
    print(f"ERROR: {e}")
