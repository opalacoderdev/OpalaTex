import os
from opalatex.licensing import (
    activate_license,
    check_license_status,
    ensure_installation_serial,
    generate_cloud_registration_key,
    _save_license_data,
    _load_license_data,
)

def test_check_license_status_is_registration_only(tmp_path, monkeypatch):
    temp_license_file = os.path.join(tmp_path, "license.dat")
    monkeypatch.setattr("opalatex.licensing.LICENSE_FILE", temp_license_file)
    monkeypatch.setattr("opalatex.licensing.generate_cloud_registration_key", lambda: "OPALA-LOCAL-FIRST-RUN")

    first_status = check_license_status()
    assert first_status["status"] == "REGISTERED"
    assert first_status["key"] == "OPALA-LOCAL-FIRST-RUN"
    assert first_status["serial_created"] is True

    second_status = check_license_status()
    assert second_status["key"] == "OPALA-LOCAL-FIRST-RUN"
    assert second_status["serial_created"] is False

    # Legacy trial metadata must not lock the open-source application.
    _save_license_data({"license_key": "OPALA-ACCOUNT", "is_trial": True, "expires_at": 0})

    status = check_license_status()
    assert status["status"] == "REGISTERED"
    assert status["key"] == "OPALA-ACCOUNT"
    assert "days_left" not in status


def test_generated_installation_serial_uses_opala_prefix_and_high_entropy_format():
    key = generate_cloud_registration_key()

    assert key.startswith("OPALA-")
    assert len(key.split("-")) == 9
    assert len(key.replace("OPALA-", "").replace("-", "")) == 32


def test_ensure_installation_serial_preserves_existing_key(tmp_path, monkeypatch):
    temp_license_file = os.path.join(tmp_path, "license.dat")
    monkeypatch.setattr("opalatex.licensing.LICENSE_FILE", temp_license_file)
    monkeypatch.setattr("opalatex.licensing.generate_cloud_registration_key", lambda: "OPALA-NEW-SHOULD-NOT-BE-USED")

    _save_license_data({"license_key": "OPALA-EXISTING"})

    result = ensure_installation_serial()

    assert result == {"key": "OPALA-EXISTING", "created": False}
    assert _load_license_data()["license_key"] == "OPALA-EXISTING"


def test_activate_license_requires_remote_validation(tmp_path, monkeypatch):
    temp_license_file = os.path.join(tmp_path, "license.dat")
    monkeypatch.setattr("opalatex.licensing.LICENSE_FILE", temp_license_file)
    validated = []
    monkeypatch.setattr("opalatex.cloud_client.validate_license", lambda key: validated.append(key) or {"balance": 0})

    result = activate_license("OPALA-SERVER-VALIDATED")

    assert result["success"] is True
    assert validated == ["OPALA-SERVER-VALIDATED"]
    assert _load_license_data()["license_key"] == "OPALA-SERVER-VALIDATED"


def test_activate_license_does_not_save_server_rejected_key(tmp_path, monkeypatch):
    from opalatex.cloud_client import CloudAPIError

    temp_license_file = os.path.join(tmp_path, "license.dat")
    monkeypatch.setattr("opalatex.licensing.LICENSE_FILE", temp_license_file)

    def reject(_key):
        raise CloudAPIError("Invalid license", 401)

    monkeypatch.setattr("opalatex.cloud_client.validate_license", reject)

    result = activate_license("OPALA-REJECTED")

    assert result == {"success": False, "message": "Invalid license"}
    assert _load_license_data() == {}
