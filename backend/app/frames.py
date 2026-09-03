# FPS / H3 17n+5 frame math - a direct Python port of js/frameMath.js. Kept in
# sync deliberately: the backend must recompute the render duration itself
# rather than trust a client-supplied number, since that duration drives the
# ffmpeg -t argument for lip-sync export.
import math


def fps(video: dict) -> float:
    return video["fpsNumerator"] / video["fpsDenominator"]


def desired_frames(duration_seconds: float, fps_value: float) -> int:
    return max(1, math.ceil(duration_seconds * fps_value))


def render_frames_for(desired: int) -> int:
    return desired + (H3_REMAINDER - desired % H3_STRIDE) % H3_STRIDE


def frame_calc(duration_seconds: float, video: dict) -> dict:
    fps_value = fps(video)
    cut_frames = desired_frames(duration_seconds, fps_value)
    h3_desired_frames = desired_frames(duration_seconds, H3_FPS)
    render_frames = render_frames_for(h3_desired_frames)
    overhang_frames = render_frames - h3_desired_frames
    overhang_seconds = max(0, render_frames / H3_FPS - duration_seconds)
    return {
        "cutFrames": cut_frames,
        "renderFrames": render_frames,
        "overhangFrames": overhang_frames,
        "renderFps": H3_FPS,
        "overhangSeconds": overhang_seconds,
    }


def frame_rule_label() -> str:
    return "17n+5"

# MiniMax H3's own frame-count grid - fixed to the model itself (see upstream
# comfy_extras/nodes_minimax_h3.py: FPS=24, align_frame_count() requires
# n % 17 == 5). A project can use its editorial timeline fps, while H3
# generation always uses 24 fps internally. Both paths share the same lattice.
H3_FPS = 24
H3_STRIDE = 17
H3_REMAINDER = 5
H3_MIN_FRAMES = 5


def h3_frame_count(duration_seconds: float) -> int:
    # A requested duration is a lower bound: never choose a legal H3 frame
    # count that ends before the editorial cut. ``round`` was subtly wrong
    # whenever the requested duration sat just above an already-legal frame
    # count (for example 22.1 frames could round back to legal frame 22).
    desired = max(H3_MIN_FRAMES, math.ceil(duration_seconds * H3_FPS))
    return render_frames_for(desired)
