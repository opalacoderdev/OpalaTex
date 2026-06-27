import asyncio
import httpx

async def main():
    # Start the IDE server in a background task
    from opalatex.ide_server import start_gui_server
    
    # We will patch start_gui_server or run it directly on port 3005
    print("Starting GUI server on port 3005...")
    # Run the server startup in a separate thread/task
    
    # Set up project path
    project_path = "/home/gilzamir/projetos/OpalaTex"
    project_name = "bobenglish"
    
    # Make a run request
    url = "http://127.0.0.1:3005/api/opalatex/run"
    payload = {
        "command": "run",
        "agent": "chat_orchestrator",
        "prompt": "Olá",
        "project_name": project_name,
        "project_path": project_path,
        "model": "ollama/gemma4:latest", # or any dummy/mock model
    }
    
    # We'll start the server and wait 2 seconds
    server_task = asyncio.create_task(asyncio.to_thread(start_gui_server, "127.0.0.1", 3005))
    await asyncio.sleep(3)
    
    print("Sending request to /api/opalatex/run...")
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", url, json=payload) as response:
                print("Response status:", response.status_code)
                async for line in response.aiter_lines():
                    if line.strip():
                        print("STREAM LINE:", line)
    except Exception as e:
        print("Error during request:", e)
    finally:
        server_task.cancel()

try:
    asyncio.run(main())
except Exception as e:
    print("Finished:", e)
