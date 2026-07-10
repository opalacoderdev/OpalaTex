import json
import urllib.error
from unittest.mock import patch

import pytest

from opalatex.cloud_client import CloudAPIError, get_balance


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


def test_get_balance_uses_bearer_auth():
    captured = {}

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return FakeResponse({"balance": 42})

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = get_balance("OPALA-VALID")

    assert result == {"balance": 42}
    assert captured["request"].get_header("Authorization") == "Bearer OPALA-VALID"
    assert captured["request"].full_url.endswith("/api/get-balance")
    assert captured["timeout"] == 3


def test_http_rejection_becomes_cloud_api_error():
    error = urllib.error.HTTPError(
        "https://opalacoder.com/api/get-balance",
        401,
        "Unauthorized",
        {},
        None,
    )
    error.read = lambda: b'{"error":"Invalid license"}'

    with patch("urllib.request.urlopen", side_effect=error):
        with pytest.raises(CloudAPIError, match="Invalid license") as raised:
            get_balance("OPALA-INVALID")

    assert raised.value.status_code == 401
