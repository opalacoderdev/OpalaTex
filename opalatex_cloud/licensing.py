import os
import json
import uuid
import time
import base64
import itertools
import secrets

LICENSE_DIR = os.path.expanduser("~/.opalatex")
LICENSE_FILE = os.path.join(LICENSE_DIR, "license.dat")
OLD_LICENSE_FILE = os.path.join(LICENSE_DIR, "license.json")
XOR_KEY = b"OPALA_TRIAL_SECURITY_KEY_v1.0.0"


def generate_cloud_registration_key() -> str:
    """Generate a high-entropy Opala Cloud registration serial."""
    token = secrets.token_hex(16).upper()
    groups = "-".join(token[i:i + 4] for i in range(0, len(token), 4))
    return f"OPALA-{groups}"

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

def ensure_installation_serial() -> dict:
    """Create and persist a local installation serial if one does not exist."""
    data = _load_license_data()
    key = str(data.get("license_key", "")).strip()
    created = False
    if not key:
        key = generate_cloud_registration_key()
        data["license_key"] = key
        data["serial_created_at"] = time.time()
        data["machine_id"] = get_machine_id()
        data.setdefault("serial_source", "local_installation")
        _save_license_data(data)
        created = True
    return {"key": key, "created": created}

def check_license_status() -> dict:
    """Return local registration state without authorizing application use."""
    serial = ensure_installation_serial()
    data = _load_license_data()
    machine_id = get_machine_id()
    key = serial["key"]
    result = {
        "status": "REGISTERED" if key else "UNREGISTERED",
        "machine_id": machine_id,
        "serial_created": serial["created"],
        "serial_source": data.get("serial_source", "imported"),
    }
    if key:
        result["key"] = key
    return result

def activate_license(key: str) -> dict:
    key = key.strip()
    if not key.startswith("OPALA-"):
        return {"success": False, "message": "Invalid Cloud registration key."}

    # The desktop never decides whether a key is valid. A successful
    # authenticated request to OpalaWebPage is the source of truth.
    from .cloud_client import CloudAPIError, validate_license

    try:
        validate_license(key)
    except CloudAPIError as exc:
        return {"success": False, "message": str(exc)}

    data = _load_license_data()
    data["license_key"] = key
    data["activation_date"] = time.time()
    data["machine_id"] = get_machine_id()
    _save_license_data(data)
    return {"success": True, "message": "Cloud account registered successfully!"}
