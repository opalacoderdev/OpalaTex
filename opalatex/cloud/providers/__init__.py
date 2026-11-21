"""Cloud storage backends implementing `opalatex.cloud.base.CloudStorageProvider`.

Modules here are imported lazily by `opalatex.cloud.registry`, so a backend with
an unmet optional dependency never breaks application start-up.
"""
