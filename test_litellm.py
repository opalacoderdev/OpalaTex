import litellm
import sys

# Drop unsupported params silently
litellm.drop_params = True

try:
    print(f"Testing litellm connection to {sys.argv[1]}")
    resp = litellm.completion(
        model=sys.argv[1],
        messages=[{"role": "user", "content": "hello"}],
    )
    print("Success:", resp)
except Exception as e:
    import traceback
    traceback.print_exc()
