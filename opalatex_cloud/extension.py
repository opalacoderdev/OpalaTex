"""OpalaTexCloud concrete extension implementation."""

from __future__ import annotations

from typing import Any, Dict, List

# Core interface import
from opalatex.extensions import CloudExtensionInterface

from .cloud_client import (
    CLOUD_FLASH_MODEL_ALIAS,
    DEFAULT_CLOUD_MODEL_ALIAS,
    is_cloud_model_alias,
    normalize_cloud_model_alias,
    resolve_cloud_model_alias,
    get_balance,
    validate_license,
)
from .licensing import check_license_status, activate_license, ensure_installation_serial


class OpalaTexCloudExtension(CloudExtensionInterface):
    """OpalaTexCloud extension providing cloud model aliases and licensing."""

    name: str = "OpalaTexCloud"

    def is_cloud_model(self, model: str | None) -> bool:
        return is_cloud_model_alias(model)

    def normalize_cloud_model(self, model: str | None, default_alias: str | None = None) -> str:
        return normalize_cloud_model_alias(model, default_alias)

    def resolve_cloud_model(self, model: str | None) -> str:
        return resolve_cloud_model_alias(model)

    def get_cloud_models(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": DEFAULT_CLOUD_MODEL_ALIAS,
                "provider": "OpalaTex",
                "name": "OpalaTex Live",
                "api_key": "",
                "api_base": "",
            },
            {
                "id": CLOUD_FLASH_MODEL_ALIAS,
                "provider": "OpalaTex",
                "name": "OpalaTex Flash (4x credits)",
                "api_key": "",
                "api_base": "",
            },
        ]

    def get_cloud_client(self) -> Any:
        return {
            "get_balance": get_balance,
            "validate_license": validate_license,
        }

    def get_license_manager(self) -> Any:
        return {
            "check_license_status": check_license_status,
            "activate_license": activate_license,
            "ensure_installation_serial": ensure_installation_serial,
        }


_extension_instance = OpalaTexCloudExtension()


def get_extension() -> CloudExtensionInterface:
    """Entry point function called by OpalaTex ExtensionManager."""
    return _extension_instance
