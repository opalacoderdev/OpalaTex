import litellm
import sys
import logging

litellm.set_verbose = True
logging.basicConfig(level=logging.DEBUG)

try:
    response = litellm.completion(
        model="ollama_chat/gpt-oss",
        messages=[{"role": "user", "content": "oi"}],
        api_base="http://localhost:11434/v1"
    )
    print("SUCCESS")
    print(response.choices[0].message.content)
except Exception as e:
    print(f"ERROR: {e}")
