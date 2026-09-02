"""Revision-guarded import of existing local files into project assets."""
import shutil
import uuid
from pathlib import Path

from .assets import _default_kind, _ingest_file
from .project_repository import ProjectRepository, RevisionConflictError
from .write_services import WriteValidationError


class AssetImportService:
    def __init__(self, repository: ProjectRepository):
        self.repository = repository

    async def import_asset(
        self, project_id: str, expected_revision: str, source_path: str,
        description: str = "", kind: str = "",
    ) -> dict:
        if not isinstance(source_path, str) or not source_path.strip():
            raise WriteValidationError("source path must be a non-empty string")
        if not isinstance(description, str):
            raise WriteValidationError("asset description must be a string")
        if not isinstance(kind, str):
            raise WriteValidationError("asset kind must be a string")

        source = Path(source_path).expanduser()
        if not source.is_absolute():
            raise WriteValidationError("source path must be absolute")
        try:
            source = source.resolve(strict=True)
        except OSError as error:
            raise WriteValidationError("source file does not exist") from error
        if not source.is_file():
            raise WriteValidationError("source path must identify a file")

        record = self.repository.read(project_id)
        if record["revision"] != expected_revision:
            raise RevisionConflictError(expected_revision, record["revision"])
        project = record["project"]
        assets = project.setdefault("assets", [])
        if not isinstance(assets, list) or not all(isinstance(asset, dict) for asset in assets):
            raise WriteValidationError("project assets must be an array of objects")
        existing_ids = {asset.get("id") for asset in assets}
        asset_id = uuid.uuid4().hex[:8]
        while asset_id in existing_ids:
            asset_id = uuid.uuid4().hex[:8]

        directory = self.repository.directory(project_id)
        asset_directory = directory / "assets" / asset_id
        try:
            descriptor = await _ingest_file(directory, asset_id, source, source.name)
            asset = {
                **descriptor,
                "tags": [],
                "description": description.strip(),
                "kind": kind.strip() or _default_kind(descriptor["type"]),
            }
            assets.append(asset)
            saved = self.repository.write(project_id, project, expected_revision)
        except (RevisionConflictError, WriteValidationError):
            shutil.rmtree(asset_directory, ignore_errors=True)
            raise
        except OSError as error:
            shutil.rmtree(asset_directory, ignore_errors=True)
            raise WriteValidationError("asset file could not be imported") from error
        except Exception:
            shutil.rmtree(asset_directory, ignore_errors=True)
            raise

        return {
            "projectId": project_id, "previousRevision": expected_revision,
            "revision": saved["revision"], "asset": asset,
        }
