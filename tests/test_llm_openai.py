import litellm
import sys
import logging

litellm.set_verbose = True
logging.basicConfig(level=logging.DEBUG)

try:
    response = litellm.completion(
        model="ollama/gpt-oss:latest",
        messages=[{"role": "user", "content": "oi"}],
        api_base="http://localhost:11434/v1"
    )
    print("SUCCESS")
except Exception as e:
    print(f"ERROR: {e}")
