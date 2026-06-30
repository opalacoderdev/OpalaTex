import os
import json
import uuid
import time
import base64
import itertools
import sqlite3
from datetime import datetime, timedelta

LICENSE_DIR = os.path.expanduser("~/.opalatex")
LICENSE_FILE = os.path.join(LICENSE_DIR, "license.dat")
OLD_LICENSE_FILE = os.path.join(LICENSE_DIR, "license.json")
TRIAL_DAYS = 14
XOR_KEY = b"OPALA_TRIAL_SECURITY_KEY_v1.0.0"

def get_machine_id() -> str:
    """Returns a basic machine ID (based on MAC address)."""
    return str(uuid.getnode())

def _encrypt(data_str: str) -> str:
    encoded = bytes(a ^ b for a, b in zip(data_str.encode('utf-8'), itertools.cycle(XOR_KEY)))
    return base64.b64encode(encoded).decode('utf-8')

def _decrypt(data_b64: str) -> str:
    try:
        decoded = base64.b64decode(data_b64.encode('utf-8'))
        return bytes(a ^ b for a, b in zip(decoded, itertools.cycle(XOR_KEY))).decode('utf-8')
    except Exception:
        return "{}"

def _load_license_data() -> dict:
    # Migrate old plaintext if exists
    if os.path.exists(OLD_LICENSE_FILE):
        try:
            with open(OLD_LICENSE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            _save_license_data(data)
            os.remove(OLD_LICENSE_FILE)
            return data
        except Exception:
            pass

    if not os.path.exists(LICENSE_FILE):
        return {}
    
    try:
        with open(LICENSE_FILE, "r", encoding="utf-8") as f:
            b64_content = f.read().strip()
            if not b64_content:
                return {}
            json_str = _decrypt(b64_content)
            return json.loads(json_str)
    except Exception:
        return {}

def _save_license_data(data: dict):
    os.makedirs(LICENSE_DIR, exist_ok=True)
    json_str = json.dumps(data)
    with open(LICENSE_FILE, "w", encoding="utf-8") as f:
        f.write(_encrypt(json_str))

def _get_oldest_project_timestamp() -> float:
    """Check projects database to find the oldest project created."""
    try:
        from opalatex.config import DEFAULT_DB_PATH
        if not os.path.exists(DEFAULT_DB_PATH):
            return time.time()
        
        conn = sqlite3.connect(DEFAULT_DB_PATH)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        cursor.execute("SELECT created_at FROM projects ORDER BY created_at ASC LIMIT 1")
        row = cursor.fetchone()
        conn.close()
        
        if row:
            created_str = row['created_at']
            # Format: 2026-06-27 20:34:32 or similar standard ISO
            # Fallback to general parsing
            dt = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
            return dt.timestamp()
    except Exception as e:
        print(f"Warning: Failed to fetch oldest project timestamp: {e}")
    
    return time.time()

def check_license_status() -> dict:
    """
    Returns the current license status.
    Format: {"status": "TRIAL_ACTIVE" | "TRIAL_EXPIRED" | "LICENSED", "days_left": int, "machine_id": str}
    """
    data = _load_license_data()
    machine_id = get_machine_id()
    
    # If a license key exists
    if data.get("license_key"):
        if data.get("is_trial"):
            expires_at = data.get("expires_at", 0)
            now = time.time()
            if now >= expires_at:
                return {
                    "status": "TRIAL_EXPIRED",
                    "days_left": 0,
                    "machine_id": machine_id,
                    "key": data.get("license_key")
                }
            else:
                days_left = max(0, int((expires_at - now) / (60 * 60 * 24)))
                return {
                    "status": "TRIAL_ACTIVE",
                    "days_left": days_left,
                    "machine_id": machine_id,
                    "key": data.get("license_key")
                }
        return {
            "status": "LICENSED",
            "days_left": 0,
            "machine_id": machine_id,
            "key": data.get("license_key")
        }
    
    now = time.time()
    
    # Security check: the trial_start cannot be NEWER than the oldest project's creation time!
    # If a user resets the trial_start, it will jump to `now`, but the oldest project will prove
    # they've been using it earlier.
    oldest_proj_ts = _get_oldest_project_timestamp()
    
    if "trial_start" not in data:
        data["trial_start"] = min(now, oldest_proj_ts)
        _save_license_data(data)
    
    # Take the oldest timestamp possible between saved trial and actual project history
    effective_trial_start = min(data["trial_start"], oldest_proj_ts)
    
    elapsed_days = (now - effective_trial_start) / (60 * 60 * 24)
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
    key = key.strip()
    if key.startswith("OPALA-"):
        data = _load_license_data()
        data["license_key"] = key
        data["activation_date"] = time.time()
        data["machine_id"] = get_machine_id()
        _save_license_data(data)
        return {"success": True, "message": "License activated successfully!"}
    else:
        return {"success": False, "message": "Invalid license key."}

