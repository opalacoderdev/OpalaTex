"""Plugin and extension architecture for OpalaTex.

This module provides an ExtensionManager that allows optional plugins (such as OpalaTexCloud)
to register cloud models, custom licensing, and cloud proxy endpoints without coupling
the core open-source application to remote cloud services.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


class CloudExtensionInterface:
    """Base class/interface for Cloud extensions."""

    name: str = "CloudExtension"

    def is_cloud_model(self, model: str | None) -> bool:
        from opalatex.cloud_client import is_cloud_model_alias
        return is_cloud_model_alias(model)

    def normalize_cloud_model(self, model: str | None, default_alias: str | None = None) -> str:
        from opalatex.cloud_client import normalize_cloud_model_alias
        return normalize_cloud_model_alias(model, default_alias)

    def resolve_cloud_model(self, model: str | None) -> str:
        from opalatex.cloud_client import resolve_cloud_model_alias
        return resolve_cloud_model_alias(model)

    def get_cloud_models(self) -> List[Dict[str, Any]]:
        return [
            {"id": "OpalaTexCloud", "provider": "OpalaTex", "name": "OpalaTex Live", "api_key": "", "api_base": ""},
            {"id": "OpalaTexCloudGemini35Flash", "provider": "OpalaTex", "name": "OpalaTex Flash (4x credits)", "api_key": "", "api_base": ""},
        ]

    def get_cloud_client(self) -> Any | None:
        return None

    def get_license_manager(self) -> Any | None:
        return None


class DefaultCommunityExtension(CloudExtensionInterface):
    """Default fallback extension when no cloud extension is installed (Community Mode)."""

    pass


class ExtensionManager:
    """Singleton registry for OpalaTex plugins and extensions."""

    _instance: ExtensionManager | None = None
    _cloud_extension: CloudExtensionInterface

    def __new__(cls) -> ExtensionManager:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._cloud_extension = DefaultCommunityExtension()
            cls._instance._discover_extensions()
        return cls._instance

    def _discover_extensions(self) -> None:
        """Attempt to auto-discover installed cloud extensions (e.g. opalatex_cloud)."""
        try:
            import importlib
            cloud_module = importlib.import_module("opalatex_cloud")
            if hasattr(cloud_module, "get_extension"):
                ext = cloud_module.get_extension()
                if isinstance(ext, CloudExtensionInterface):
                    self._cloud_extension = ext
                    logger.info("OpalaTexCloud extension successfully loaded.")
        except ImportError:
            logger.debug("No opalatex_cloud extension found. Running in Community mode.")
        except Exception as exc:
            logger.warning("Failed to load opalatex_cloud extension: %s", exc)

    def register_cloud_extension(self, extension: CloudExtensionInterface) -> None:
        """Manually register a Cloud extension implementation."""
        self._cloud_extension = extension
        logger.info("Registered Cloud extension: %s", extension.name)

    @property
    def cloud(self) -> CloudExtensionInterface:
        return self._cloud_extension

    @property
    def has_cloud(self) -> bool:
        return not isinstance(self._cloud_extension, DefaultCommunityExtension)


def get_extension_manager() -> ExtensionManager:
    """Return the global ExtensionManager instance."""
    return ExtensionManager()
