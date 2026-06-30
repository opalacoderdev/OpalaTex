import os
import time
import pytest
from opalatex.licensing import check_license_status, _save_license_data, _load_license_data

def test_check_license_status_trial(tmp_path, monkeypatch):
    # Mock LICENSE_FILE path to a temp file
    temp_license_file = os.path.join(tmp_path, "license.dat")
    monkeypatch.setattr("opalatex.licensing.LICENSE_FILE", temp_license_file)
    
    # Save a trial license that is active
    now = time.time()
    expires_at = now + 100000
    
    _save_license_data({
        "license_key": "OPALA-TRIAL-TEST",
        "is_trial": True,
        "expires_at": expires_at
    })
    
    status = check_license_status()
    assert status["status"] == "TRIAL_ACTIVE"
    assert status["days_left"] >= 0
    assert status["key"] == "OPALA-TRIAL-TEST"
    
    # Save a trial license that is expired
    expired_at = now - 100000
    _save_license_data({
        "license_key": "OPALA-TRIAL-TEST-EXPIRED",
        "is_trial": True,
        "expires_at": expired_at
    })
    
    status = check_license_status()
    assert status["status"] == "TRIAL_EXPIRED"
    assert status["days_left"] == 0
    assert status["key"] == "OPALA-TRIAL-TEST-EXPIRED"
    
    # Save a normal lifetime license
    _save_license_data({
        "license_key": "OPALA-LIFETIME-KEY"
    })
    
    status = check_license_status()
    assert status["status"] == "LICENSED"
    assert status["days_left"] == 0
    assert status["key"] == "OPALA-LIFETIME-KEY"
