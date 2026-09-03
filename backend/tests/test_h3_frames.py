"""Dependency-free contract checks for MiniMax H3 frame alignment.

Run with:
    backend/.venv/Scripts/python.exe backend/tests/test_h3_frames.py
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import frames  # noqa: E402


def check(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    print(f"ok - {label}")


def assert_h3_contract(duration_seconds: float, expected: int) -> None:
    actual = frames.h3_frame_count(duration_seconds)
    check(actual == expected, f"{duration_seconds:.12f}s maps to {expected} frames")
    check(actual % frames.H3_STRIDE == frames.H3_REMAINDER, f"{actual} is on the 17n+5 lattice")
    check(actual >= math.ceil(duration_seconds * frames.H3_FPS), f"{actual} never undershoots the requested duration")


# Minimum and exact legal boundary.
assert_h3_contract(0.0, 5)
assert_h3_contract(22 / frames.H3_FPS, 22)

# The regression boundary: just above legal frame 22 must advance to frame 39,
# never round backwards to a clip shorter than requested.
assert_h3_contract((22 + 1e-6) / frames.H3_FPS, 39)

# Ordinary fractional and exact upper lattice values.
assert_h3_contract(9.7, 243)
assert_h3_contract(362 / frames.H3_FPS, 362)

# Timeline/export math must enforce the same lattice even when an older project
# still contains a legacy configurable rule.
legacy_video = {
    "fpsNumerator": 25,
    "fpsDenominator": 1,
    "frameRule": {"stride": 8, "offset": 1},
}
legacy_calc = frames.frame_calc(1.0, legacy_video)
check(legacy_calc["cutFrames"] == 25, "timeline cut keeps its editorial frame count")
check(legacy_calc["renderFrames"] == 39, "timeline render advances to the next 17n+5 frame")
check(legacy_calc["renderFps"] == 24, "timeline render remains on H3's fixed 24 fps clock")
check(legacy_calc["renderFrames"] % 17 == 5, "timeline/export render count is H3 legal")
check(frames.frame_rule_label() == "17n+5", "export labels the canonical H3 rule")

print("\nAll H3 frame contract checks passed.")
