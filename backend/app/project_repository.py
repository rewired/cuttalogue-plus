"""Transport-neutral, path-confined read access to CUTTAlogue projects."""
import hashlib
import json
import os
import re
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path

PROJECT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


class ProjectNotFoundError(LookupError):
    pass


class InvalidProjectError(ValueError):
    pass


class RevisionConflictError(RuntimeError):
    def __init__(self, expected_revision: str, current_revision: str):
        self.expected_revision = expected_revision
        self.current_revision = current_revision
        super().__init__(f"revision conflict: expected {expected_revision}, current {current_revision}")


_LOCKS_GUARD = threading.Lock()
_PROJECT_LOCKS: dict[Path, threading.RLock] = {}


def _project_lock(path: Path) -> threading.RLock:
    with _LOCKS_GUARD:
        return _PROJECT_LOCKS.setdefault(path, threading.RLock())


@contextmanager
def _repository_write_lock(project_file: Path):
    lock_file = project_file.with_name(".project.lock")
    with _project_lock(project_file):
        with lock_file.open("a+b") as stream:
            stream.seek(0, os.SEEK_END)
            if stream.tell() == 0:
                stream.write(b"\0")
                stream.flush()
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                deadline = time.monotonic() + 10
                while True:
                    try:
                        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError as error:
                        if time.monotonic() >= deadline:
                            raise InvalidProjectError("project write lock timed out") from error
                        time.sleep(0.05)
                try:
                    yield
                finally:
                    stream.seek(0)
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


class ProjectRepository:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def _file(self, project_id: str) -> Path:
        if not isinstance(project_id, str) or not PROJECT_ID_PATTERN.fullmatch(project_id):
            raise InvalidProjectError("invalid project id")
        candidate = (self.root / project_id / "project.json").resolve()
        if self.root not in candidate.parents:
            raise InvalidProjectError("project path escapes repository")
        return candidate

    def directory(self, project_id: str) -> Path:
        """Return the confined project directory for service-owned artifacts."""
        return self._file(project_id).parent

    def read(self, project_id: str) -> dict:
        file = self._file(project_id)
        if not file.exists():
            raise ProjectNotFoundError("project not found")
        try:
            raw = file.read_bytes()
            project = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise InvalidProjectError("project file is invalid") from error
        if not isinstance(project, dict):
            raise InvalidProjectError("project root must be an object")
        return {
            "id": project_id,
            "revision": hashlib.sha256(raw).hexdigest(),
            "updatedAt": file.stat().st_mtime,
            "project": project,
        }

    def write(self, project_id: str, project: dict, expected_revision: str) -> dict:
        if not isinstance(project, dict):
            raise InvalidProjectError("project root must be an object")
        if not isinstance(expected_revision, str) or not expected_revision:
            raise InvalidProjectError("expected revision is required")
        file = self._file(project_id)
        if not file.exists():
            raise ProjectNotFoundError("project not found")
        with _repository_write_lock(file):
            current = self.read(project_id)
            if current["revision"] != expected_revision:
                raise RevisionConflictError(expected_revision, current["revision"])
            timestamp_ms = int(time.time() * 1000)
            previous_saved_at = project.get("savedAt")
            if isinstance(previous_saved_at, (int, float)) and not isinstance(previous_saved_at, bool):
                if timestamp_ms <= previous_saved_at:
                    timestamp_ms = int(previous_saved_at) + 1
            project["savedAt"] = timestamp_ms
            try:
                encoded = json.dumps(project, indent=2, ensure_ascii=False, allow_nan=False).encode("utf-8")
            except (TypeError, ValueError) as error:
                raise InvalidProjectError("project contains non-JSON data") from error
            descriptor, temporary_name = tempfile.mkstemp(prefix=".project-", suffix=".tmp", dir=file.parent)
            temporary = Path(temporary_name)
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, file)
            except Exception:
                temporary.unlink(missing_ok=True)
                raise
            return self.read(project_id)

    def list(self) -> list[dict]:
        if not self.root.exists():
            return []
        projects = []
        for entry in self.root.iterdir():
            if not entry.is_dir() or not PROJECT_ID_PATTERN.fullmatch(entry.name):
                continue
            try:
                record = self.read(entry.name)
            except (ProjectNotFoundError, InvalidProjectError):
                continue
            data = record["project"]
            projects.append({
                "id": record["id"],
                "name": data.get("name") or "",
                "shotCount": len(data.get("shots") or []),
                "updatedAt": record["updatedAt"],
                "revision": record["revision"],
            })
        return sorted(projects, key=lambda item: item["updatedAt"], reverse=True)
