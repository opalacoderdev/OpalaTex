import pytest
import os
import json
from unittest.mock import AsyncMock
from opalatex.ide_server import AsyncHTTPServer

@pytest.mark.asyncio
async def test_file_delete_api(tmp_path):
    # Setup test file
    test_dir = tmp_path / "project"
    test_dir.mkdir()
    test_file = test_dir / "test.txt"
    test_file.write_text("hello world")
    
    server = AsyncHTTPServer()
    writer = AsyncMock()
    
    # 1. Test success deletion
    body_data = {
        "projectPath": str(test_dir),
        "filePath": "test.txt"
    }
    body_bytes = json.dumps(body_data).encode('utf-8')
    
    # We mock send_response
    responses = []
    def mock_send_response(w, status_code, body, content_type="text/plain"):
        responses.append((status_code, json.loads(body.decode('utf-8'))))
        
    server.send_response = mock_send_response
    
    await server.route_api("POST", "/api/file/delete", {}, {}, body_bytes, writer)
    
    assert len(responses) == 1
    assert responses[0][0] == 200
    assert responses[0][1] == {"success": True}
    assert not test_file.exists()
    
    # 2. Test delete nonexistent file
    responses.clear()
    await server.route_api("POST", "/api/file/delete", {}, {}, body_bytes, writer)
    assert len(responses) == 1
    assert responses[0][0] == 404
    assert "error" in responses[0][1]

    # 3. Test path traversal attempt
    test_file2 = tmp_path / "outside.txt"
    test_file2.write_text("secret")
    
    body_data_traversal = {
        "projectPath": str(test_dir),
        "filePath": "../outside.txt"
    }
    body_bytes_traversal = json.dumps(body_data_traversal).encode('utf-8')
    responses.clear()
    
    await server.route_api("POST", "/api/file/delete", {}, {}, body_bytes_traversal, writer)
    assert len(responses) == 1
    assert responses[0][0] == 403
    assert "error" in responses[0][1]
    assert test_file2.exists()
