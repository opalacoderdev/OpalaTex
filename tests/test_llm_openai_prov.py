import litellm
import sys
import logging

litellm.set_verbose = True
logging.basicConfig(level=logging.DEBUG)

try:
    response = litellm.completion(
        model="openai/gpt-oss:latest",
        messages=[{"role": "user", "content": "oi"}],
        api_base="http://localhost:11434/v1",
        api_key="ollama"
    )
    print("SUCCESS")
except Exception as e:
    print(f"ERROR: {e}")
