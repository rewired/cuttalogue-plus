# ffprobe metadata extraction and ffmpeg thumbnail generation for imported
# assets. Both shell out synchronously and get offloaded to a thread so they
# don't block the event loop - there's no need for the job/SSE machinery here,
# a single ffprobe/ffmpeg call is over before a progress bar would matter.
#
# run_ffmpeg_with_progress, below, is the one genuinely long-running ffmpeg
# call (export encoding). It deliberately uses the same synchronous
# subprocess.Popen-in-a-thread approach as the rest of this file rather than
# asyncio.create_subprocess_exec: the latter requires the Proactor event loop
# on Windows and raises NotImplementedError on Selector - and in testing,
# some uvicorn --reload worker processes ended up on Selector regardless of
# an explicit WindowsProactorEventLoopPolicy set at startup. Plain
# subprocess.Popen has no such dependency, matching why FFprobe/thumbnails
# above were never affected by this in the first place.
import asyncio
import json
import subprocess
from pathlib import Path
from typing import Awaitable, Callable

from fastapi.concurrency import run_in_threadpool

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}
POINTCLOUD_EXTS = {".ply", ".splat"}
MODEL3D_EXTS = {".glb"}

# Shared shot lip-sync audio definition: export.py and comfy.py's
# Generate-time H3 reference audio both need the exact same selected format, and both need the output to last exactly `duration_seconds` even
# when the source track ends first (H3's own frame-grid overhang can push
# the required window past the end of the vocal take). One definition here
# rather than two slightly different ffmpeg invocations.
LIP_SYNC_CHANNELS = "1"

# Application-wide render-quality presets. The preset id is what settings.json
# persists; keeping the ffmpeg value here makes the UI choice and every audio
# render caller share one authoritative mapping.
DEFAULT_AUDIO_RENDER_PRESET = "mono-32000"
AUDIO_RENDER_SAMPLE_RATES = {
    "mono-32000": 32000,
    "mono-44100": 44100,
    "mono-48000": 48000,
}

DEFAULT_AUDIO_RENDER_FORMAT = "flac"
AUDIO_RENDER_FORMATS = {
    "flac": {"extension": ".flac", "codec": "flac", "bitsPerSample": None},
    "wav-16": {"extension": ".wav", "codec": "pcm_s16le", "bitsPerSample": 16},
    "wav-24": {"extension": ".wav", "codec": "pcm_s24le", "bitsPerSample": 24},
}


def normalize_audio_render_preset(value: object) -> str:
    return value if isinstance(value, str) and value in AUDIO_RENDER_SAMPLE_RATES else DEFAULT_AUDIO_RENDER_PRESET


def audio_render_sample_rate(preset: object) -> int:
    return AUDIO_RENDER_SAMPLE_RATES[normalize_audio_render_preset(preset)]


def normalize_audio_render_format(value: object) -> str:
    return value if isinstance(value, str) and value in AUDIO_RENDER_FORMATS else DEFAULT_AUDIO_RENDER_FORMAT


def audio_render_format_spec(render_format: object) -> dict:
    return AUDIO_RENDER_FORMATS[normalize_audio_render_format(render_format)]


def audio_snippet_cmd(
    source_path: Path,
    start_seconds: float,
    duration_seconds: float,
    output_path: Path,
    sample_rate: int = AUDIO_RENDER_SAMPLE_RATES[DEFAULT_AUDIO_RENDER_PRESET],
    render_format: str = DEFAULT_AUDIO_RENDER_FORMAT,
) -> list[str]:
    format_spec = audio_render_format_spec(render_format)
    return [
        "ffmpeg",
        "-y",
        "-ss",
        f"{start_seconds:.6f}",
        "-i",
        str(source_path),
        "-t",
        f"{duration_seconds:.6f}",
        # apad extends the stream with silence indefinitely; the -t above
        # then caps it at exactly duration_seconds regardless of whether the
        # source was long enough on its own - so the output is always
        # exactly duration_seconds long, silence-padded rather than failing
        # or looping when the source runs out first.
        "-af",
        "apad",
        "-ar",
        str(sample_rate),
        "-ac",
        LIP_SYNC_CHANNELS,
        "-c:a",
        format_spec["codec"],
        str(output_path),
    ]

EMPTY_METADATA = {
    "durationSeconds": None,
    "width": None,
    "height": None,
    "fps": None,
    "frameCount": None,
    "codec": None,
    "sampleRate": None,
    "channels": None,
}


def guess_asset_type(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in POINTCLOUD_EXTS:
        return "pointcloud"
    if ext in MODEL3D_EXTS:
        return "model3d"
    return "other"


def _probe_sync(path: Path) -> dict:
    proc = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


async def probe(path: Path) -> dict:
    return await run_in_threadpool(_probe_sync, path)


def _parse_fps(rate: str | None) -> float | None:
    if not rate or rate == "0/0":
        return None
    num, _, den = rate.partition("/")
    try:
        num_f, den_f = float(num), float(den or 1)
        return round(num_f / den_f, 3) if den_f else None
    except ValueError:
        return None


def _parse_frame_count(video: dict | None, duration: float | None, fps_value: float | None) -> int | None:
    # ffprobe's nb_frames is often "N/A" for formats without an index (e.g.
    # freshly-written mp4s) - fall back to duration * fps rather than paying
    # for a slow -count_frames re-decode just to get an exact number.
    raw = video.get("nb_frames") if video else None
    if raw not in (None, "N/A"):
        try:
            return int(raw)
        except ValueError:
            pass
    if duration and fps_value:
        return round(duration * fps_value)
    return None


def extract_metadata(probe_data: dict) -> dict:
    fmt = probe_data.get("format", {})
    streams = probe_data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = fmt.get("duration")
    duration_seconds = float(duration) if duration else None
    fps_value = _parse_fps(video.get("r_frame_rate")) if video else None
    sample_rate = audio.get("sample_rate") if audio else None
    return {
        "durationSeconds": duration_seconds,
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "fps": fps_value,
        "frameCount": _parse_frame_count(video, duration_seconds, fps_value),
        "codec": (video or audio or {}).get("codec_name"),
        "sampleRate": int(sample_rate) if sample_rate else None,
        "channels": audio.get("channels") if audio else None,
    }


def _thumbnail_sync(src: Path, dest: Path, asset_type: str, duration: float | None) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if asset_type == "image":
        cmd = ["ffmpeg", "-y", "-i", str(src), "-vf", "scale=320:-1", "-frames:v", "1", str(dest)]
    elif asset_type == "video":
        seek = min(1.0, duration / 2) if duration else 0
        cmd = ["ffmpeg", "-y", "-ss", str(seek), "-i", str(src), "-vf", "scale=320:-1", "-frames:v", "1", str(dest)]
    else:
        return False
    result = subprocess.run(cmd, capture_output=True)
    return result.returncode == 0 and dest.exists()


async def generate_thumbnail(src: Path, dest: Path, asset_type: str, duration: float | None) -> bool:
    return await run_in_threadpool(_thumbnail_sync, src, dest, asset_type, duration)


class FFmpegError(RuntimeError):
    pass


class FFmpegCancelled(Exception):
    pass


def _run_ffmpeg_sync(
    full_cmd: list[str],
    expected_duration_seconds: float,
    report_progress: Callable[[float], None],
    should_cancel: Callable[[], bool] | None,
) -> tuple[bool, int, bytes]:
    proc = subprocess.Popen(full_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    cancelled = False
    try:
        for raw_line in proc.stdout:
            if should_cancel and should_cancel():
                cancelled = True
                proc.terminate()
                break
            line = raw_line.decode(errors="ignore").strip()
            if line.startswith("out_time_ms="):
                try:
                    out_time_ms = int(line.split("=", 1)[1])
                except ValueError:
                    continue
                if expected_duration_seconds > 0:
                    fraction = (out_time_ms / 1_000_000) / expected_duration_seconds
                    report_progress(min(1.0, max(0.0, fraction)))
            elif line == "progress=end":
                break
    finally:
        proc.stdout.close()

    proc.wait()

    # A forcefully terminated process's stderr pipe has been observed, on
    # Windows, to not signal EOF for a long time (roughly the remainder of
    # what would have been the full run) even though proc.wait() above
    # already confirms the process is gone - reading it here would stall a
    # cancellation for no reason, since stderr's only consumer is the error
    # message below, which a cancellation never needs.
    if cancelled:
        proc.stderr.close()
        return True, proc.returncode, b""

    stderr_bytes = proc.stderr.read()
    proc.stderr.close()
    return False, proc.returncode, stderr_bytes


async def run_ffmpeg_with_progress(
    cmd: list[str],
    expected_duration_seconds: float,
    on_progress: Callable[[float], Awaitable[None]],
    should_cancel: Callable[[], bool] | None = None,
) -> None:
    # -progress pipe:1 makes ffmpeg emit machine-readable key=value lines
    # (out_time_ms=..., progress=continue|end) on stdout as it works, instead
    # of only human-readable stats on stderr - that's what turns this into a
    # real progress fraction rather than a spinner. should_cancel is polled
    # between lines so a cancelled batch export can kill an in-flight encode
    # instead of waiting for it to finish first.
    full_cmd = [*cmd, "-progress", "pipe:1", "-nostats"]
    loop = asyncio.get_running_loop()

    def report_progress(fraction: float) -> None:
        # Called from the worker thread - hop back onto the event loop thread
        # before touching any asyncio object (Queue, Task, etc. aren't
        # thread-safe to use directly from here).
        loop.call_soon_threadsafe(asyncio.ensure_future, on_progress(fraction))

    cancelled, returncode, stderr_bytes = await run_in_threadpool(
        _run_ffmpeg_sync, full_cmd, expected_duration_seconds, report_progress, should_cancel
    )

    if cancelled:
        raise FFmpegCancelled()

    if returncode != 0:
        raise FFmpegError(stderr_bytes.decode(errors="ignore")[-2000:])
