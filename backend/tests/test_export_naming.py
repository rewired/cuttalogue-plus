"""Dependency-free checks for human-readable export directory names."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.export import _shot_audio_filename, _shot_directory_name  # noqa: E402


def check(shot: dict, expected: str) -> None:
    actual = _shot_directory_name(shot)
    if actual != expected:
        raise AssertionError(f"expected {expected!r}, got {actual!r}")
    print(f"ok - {actual}")


check({"id": 1, "name": "Sönke mag Bärbel"}, "shot-001_soenke-mag-baerbel")
check({"id": 2, "name": "Übergröße & Spaß"}, "shot-002_uebergroesse-spass")
check({"id": 3, "name": "Crème / Café!"}, "shot-003_creme-cafe")
check({"id": 7, "name": "François & Łódź"}, "shot-007_francois-lodz")
check({"id": 8, "name": "Søren & Œuvre"}, "shot-008_soren-oeuvre")
check({"id": 9, "name": "Rock'n'Roll / L'été"}, "shot-009_rocknroll-lete")
check({"id": 10, "name": "Cafe\u0301 déjà vu"}, "shot-010_cafe-deja-vu")
check({"id": 4, "name": "   "}, "shot-004")
check({"id": 5}, "shot-005")
check({"id": 6, "name": "?!"}, "shot-006")


def check_audio(shot: dict, kind: str, extension: str, expected: str) -> None:
    actual = _shot_audio_filename(shot, kind, extension)
    if actual != expected:
        raise AssertionError(f"expected {expected!r}, got {actual!r}")
    print(f"ok - {actual}")


check_audio(
    {"id": 1, "name": "Sönke mag Bärbel"},
    "lip_sync",
    ".flac",
    "shot-001_soenke-mag-baerbel-lip_sync.flac",
)
check_audio({"id": 4, "name": "   "}, "mix", ".wav", "shot-004-mix.wav")

print("\nAll export naming checks passed.")
