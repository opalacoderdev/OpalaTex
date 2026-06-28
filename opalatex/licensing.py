import os
import json
import uuid
import time
from datetime import datetime, timedelta

LICENSE_DIR = os.path.expanduser("~/.opalatex")
LICENSE_FILE = os.path.join(LICENSE_DIR, "license.json")
TRIAL_DAYS = 14

def get_machine_id() -> str:
    """Returns a basic machine ID (based on MAC address)."""
    return str(uuid.getnode())

def _load_license_data() -> dict:
    if not os.path.exists(LICENSE_FILE):
        return {}
    try:
        with open(LICENSE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_license_data(data: dict):
    os.makedirs(LICENSE_DIR, exist_ok=True)
    with open(LICENSE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f)

def check_license_status() -> dict:
    """
    Returns the current license status.
    Format: {"status": "TRIAL_ACTIVE" | "TRIAL_EXPIRED" | "LICENSED", "days_left": int, "machine_id": str}
    """
    data = _load_license_data()
    machine_id = get_machine_id()
    
    # If a license key exists (and is 'valid' according to our basic check)
    if data.get("license_key"):
        return {
            "status": "LICENSED",
            "days_left": 0,
            "machine_id": machine_id
        }
    
    # Trial logic
    now = time.time()
    if "trial_start" not in data:
        data["trial_start"] = now
        _save_license_data(data)
    
    trial_start = data["trial_start"]
    elapsed_days = (now - trial_start) / (60 * 60 * 24)
    days_left = max(0, TRIAL_DAYS - int(elapsed_days))
    
    if elapsed_days >= TRIAL_DAYS:
        return {
            "status": "TRIAL_EXPIRED",
            "days_left": 0,
            "machine_id": machine_id
        }
    
    return {
        "status": "TRIAL_ACTIVE",
        "days_left": days_left,
        "machine_id": machine_id
    }

def activate_license(key: str) -> dict:
    """
    Validates the key (mock implementation).
    In a real scenario, this would make an HTTP request to LemonSqueezy/Gumroad.
    """
    key = key.strip()
    if key.startswith("OPALA-"):
        # Valid mock key
        data = _load_license_data()
        data["license_key"] = key
        data["activation_date"] = time.time()
        data["machine_id"] = get_machine_id()
        _save_license_data(data)
        return {"success": True, "message": "License activated successfully!"}
    else:
        return {"success": False, "message": "Invalid license key. Keys must start with 'OPALA-' for this mock implementation."}
