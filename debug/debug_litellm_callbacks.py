import asyncio
import os
import litellm
from litellm.integrations.custom_logger import CustomLogger

class MyCustomHandler(CustomLogger):
    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        print("--- log_success_event triggered! ---")

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        print("--- async_log_success_event triggered! ---")

litellm.callbacks = [MyCustomHandler()]
# Set environment variables for debug logging
os.environ['LITELLM_LOG'] = 'DEBUG'

async def main():
    # We will use the same router setup as agenticblocks
    router = litellm.Router(
        model_list=[{
            "model_name": "openai/unsloth/gpt-oss-20b-GGUF:Q4_1",
            "litellm_params": {
                "model": "openai/unsloth/gpt-oss-20b-GGUF:Q4_1",
                "api_base": "http://localhost:8080/v1",
                "api_key": "test"
            },
        }]
    )
    print("Callbacks in litellm:", litellm.callbacks)
    try:
        # Call via router
        response = await router.acompletion(
            model="openai/unsloth/gpt-oss-20b-GGUF:Q4_1",
            messages=[{"role": "user", "content": "hello"}],
            api_base="http://localhost:8080/v1",
            api_key="test",
            mock_response="Hello back!"
        )
        print("Response received:", response)
    except Exception as e:
        print("Error during completion:", e)

asyncio.run(main())
