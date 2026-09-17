# Per-shot video generation against a ComfyUI instance running on a RunPod
# Pod (Serverless is deferred - see comfy_workflow_template.py and
# settings.py for the seams left for it). Same job/SSE shape as describe.py/
# expand.py, but submit-then-poll instead of one long streamed request -
# generation can run for minutes, and short repeated /history polls avoid
# holding one httpx connection open that long. The backend never writes
# project.json (same convention as describe.py/assets.py) - it returns a
# descriptor and the frontend merges it into state as a new take, persisted
# through the normal Save path like everything else.
import asyncio
import json
import logging
import random
import shutil
import traceback
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import JSONResponse

from . import audio, frames, jobs, media, settings
from .comfy_workflow_template import build_workflow_payload
from .h3_preflight import error_message, inspect_generation
from .projects import project_dir

logger = logging.getLogger("cuttalogue.comfy")

router = APIRouter()

POLL_INTERVAL_SECONDS = 3
POLL_TIMEOUT_SECONDS = 600  # 10 minutes - generous, generation can be slow


class GenerationStartError(ValueError):
    pass


def _error_message(exc: Exception) -> str:
    return str(exc) or repr(exc)


def _load_project(project_id: str) -> tuple[dict, Path]:
    directory = project_dir(project_id)
    project_file = directory / "project.json"
    if not project_file.exists():
        raise HTTPException(status_code=404, detail="project not found")
    data = json.loads(project_file.read_text(encoding="utf-8"))
    return data, directory


async def _upload_input_file(client, base_url: str, path: Path) -> str:
    # ComfyUI's /upload/image endpoint just drops whatever bytes are posted
    # under the "image" form field into its own input folder, regardless of
    # actual media type - already relied on for the VHS Load Video (Upload)
    # node (see comfy_workflow_template.py's VHS_LoadVideo comment) and, per
    # the real LoadAudioUI node's implementation (folder_paths.
    # get_annotated_filepath against the input dir), true for audio too. One
    # upload helper for reference images, the extend-video source, and
    # generated lip-sync audio.
    with path.open("rb") as fh:
        files = {"image": (path.name, fh, "application/octet-stream")}
        res = await client.post(f"{base_url}/upload/image", files=files)
    if res.status_code != 200:
        raise RuntimeError(f"ComfyUI /upload/image returned HTTP {res.status_code}: {res.text[:300]}")
    body = res.json()
    return body.get("name") or path.name


async def _noop_progress(_fraction: float) -> None:
    return None


def _ensure_not_cancelled(job: jobs.Job) -> None:
    if job.cancel_requested:
        raise jobs.JobCancelled()


def _confined_project_file(directory: Path, relative_path: str) -> Path:
    if not isinstance(relative_path, str) or not relative_path:
        raise GenerationStartError("asset path is missing")
    root = directory.resolve()
    candidate = (root / relative_path).resolve()
    if root not in candidate.parents:
        raise GenerationStartError("asset path escapes the project directory")
    return candidate


async def _submit_and_poll(job: jobs.Job, base_url: str, workflow: dict) -> str:
    # Submits the built workflow graph, polls /history until it has an
    # output, returns the output video's ComfyUI-side filename.
    import httpx

    _ensure_not_cancelled(job)
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(f"{base_url}/prompt", json={"prompt": workflow})
        if res.status_code != 200:
            raise RuntimeError(f"ComfyUI /prompt returned HTTP {res.status_code}: {res.text[:300]}")
        prompt_id = res.json().get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI /prompt response had no prompt_id: {res.text[:300]}")

        await jobs.emit(job, {"status": "running", "phase": "queued", "message": "Queued on ComfyUI"})

        elapsed = 0
        while elapsed < POLL_TIMEOUT_SECONDS:
            _ensure_not_cancelled(job)
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
            _ensure_not_cancelled(job)
            elapsed += POLL_INTERVAL_SECONDS
            hist_res = await client.get(f"{base_url}/history/{prompt_id}")
            if hist_res.status_code != 200:
                continue  # transient - keep polling until POLL_TIMEOUT_SECONDS
            history = hist_res.json().get(prompt_id)
            if not history:
                await jobs.emit(job, {"status": "running", "phase": "generating", "message": f"Generating ({elapsed}s)"})
                continue

            status = history.get("status") or {}
            if status.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI reported an error: {json.dumps(status)[:500]}")

            outputs = history.get("outputs") or {}
            for node_output in outputs.values():
                for video in (node_output.get("videos") or node_output.get("gifs") or []):
                    filename = video.get("filename")
                    if filename:
                        return filename

            await jobs.emit(job, {"status": "running", "phase": "generating", "message": f"Generating ({elapsed}s)"})

    raise RuntimeError(f"Timed out after {POLL_TIMEOUT_SECONDS}s waiting for ComfyUI to finish")


async def start_generation_job(data: dict, directory: Path, shot: dict, body: dict) -> dict:
    import httpx

    prompt_text = (body.get("prompt") or "").strip()
    if not prompt_text:
        raise GenerationStartError("no prompt given")
    requested_seed = body.get("seed")
    reference_asset_ids = body.get("referenceAssetIds") or []

    preflight = inspect_generation(data, shot, body)
    if not preflight["ok"]:
        raise GenerationStartError(error_message(preflight))

    app_settings = settings.load_settings()
    comfy = app_settings["providers"]["comfy"]
    audio_sample_rate = media.audio_render_sample_rate(app_settings["audio"]["renderQuality"])
    audio_render_format = media.normalize_audio_render_format(app_settings["audio"]["renderFormat"])
    audio_extension = media.audio_render_format_spec(audio_render_format)["extension"]
    base_url = (comfy["baseUrl"] or "").rstrip("/")
    if not base_url:
        raise GenerationStartError("ComfyUI provider not configured - set it up on the Setup page first")
    shot_id = shot["id"]

    # The H3 reference audio must come from the project's own stored vocal
    # track - never the full mix, never whatever audio happens to still be
    # baked into the workflow template from an earlier manual test. Resolved
    # synchronously so a missing vocal track fails cleanly before anything is
    # uploaded to ComfyUI, same as the prompt/base_url checks above.
    try:
        vocal_path = audio.require_track(data, directory, "vocal")
    except HTTPException as error:
        raise GenerationStartError(str(error.detail)) from error
    try:
        vocal_relative = vocal_path.resolve().relative_to(directory.resolve())
    except ValueError as error:
        raise GenerationStartError("audio path escapes the project directory") from error
    vocal_path = _confined_project_file(directory, str(vocal_relative))

    assets_by_id = {a["id"]: a for a in data.get("assets", [])}
    reference_paths = []
    for asset_id in reference_asset_ids:
        asset = assets_by_id.get(asset_id)
        if not asset:
            continue
        path = _confined_project_file(directory, asset.get("relativePath"))
        if not path.is_file():
            raise GenerationStartError(f"reference asset file is missing: {asset_id}")
        reference_paths.append(path)

    # H3's frame-count grid (see frames.h3_frame_count) is the same fixed
    # 17n+5 contract shown by the shot table and used by export.py. Generation
    # computes it independently at H3's 24 fps rather than trusting project
    # metadata supplied by a client, matching export.py's safety boundary and
    # export.py's own comment on this. The lip-sync reference audio must
    # cover this same render duration (which can run slightly past the
    # editorial cut via frame-grid overhang), not just the cut itself - see
    # media.audio_snippet_cmd below.
    cut_duration = shot["endSeconds"] - shot["startSeconds"]
    frame_count = frames.h3_frame_count(cut_duration)
    fps_value = frames.H3_FPS
    h3_duration = frame_count / fps_value

    # A blank/absent seed means "surprise me" - resolved once here so the
    # same concrete value goes into both the submitted workflow and the
    # take record the frontend ends up saving (see h3Compiler-adjacent
    # convention: never let the recorded fact diverge from what was
    # actually submitted).
    resolved_seed = requested_seed if isinstance(requested_seed, int) else random.randint(0, 2**32 - 1)

    take_id = uuid.uuid4().hex[:8]
    job = jobs.create_job()

    # Scratch location for the rendered lip-sync clip - scoped to this job id
    # (unique per generate call) so repeated/simultaneous generations for the
    # same shot never collide, and cleaned up once the job ends regardless of
    # outcome. Never touches the project's own stored vocal file or the
    # export/ directory.
    generation_dir = directory / "shots" / str(shot_id) / "generation" / job.id
    lip_sync_path = generation_dir / f"lip_sync{audio_extension}"

    async def run():
        try:
            _ensure_not_cancelled(job)
            generation_dir.mkdir(parents=True, exist_ok=True)
            await jobs.emit(job, {"status": "running", "phase": "audio", "message": "Preparing lip-sync audio"})
            await media.run_ffmpeg_with_progress(
                media.audio_snippet_cmd(
                    vocal_path,
                    shot["startSeconds"],
                    h3_duration,
                    lip_sync_path,
                    sample_rate=audio_sample_rate,
                    render_format=audio_render_format,
                ),
                h3_duration,
                _noop_progress,
            )

            _ensure_not_cancelled(job)
            await jobs.emit(job, {"status": "running", "phase": "uploading", "message": "Uploading references"})
            async with httpx.AsyncClient(timeout=60) as client:
                uploaded = [await _upload_input_file(client, base_url, p) for p in reference_paths]
                lip_sync_filename = await _upload_input_file(client, base_url, lip_sync_path)

            workflow = build_workflow_payload(
                prompt_text,
                uploaded,
                resolved_seed,
                frame_count=frame_count,
                fps=fps_value,
                lip_sync_filename=lip_sync_filename,
                lip_sync_duration=h3_duration,
            )

            await jobs.emit(job, {"status": "running", "phase": "submitting", "message": "Submitting to ComfyUI"})
            filename = await _submit_and_poll(job, base_url, workflow)

            _ensure_not_cancelled(job)
            await jobs.emit(job, {"status": "running", "phase": "downloading", "message": "Downloading result"})
            async with httpx.AsyncClient(timeout=120) as client:
                view_res = await client.get(f"{base_url}/view", params={"filename": filename, "type": "output"})
            _ensure_not_cancelled(job)
            if view_res.status_code != 200:
                raise RuntimeError(f"ComfyUI /view returned HTTP {view_res.status_code}")

            take_dir = directory / "shots" / str(shot_id) / "takes" / take_id
            take_dir.mkdir(parents=True, exist_ok=True)
            output_path = take_dir / "output.mp4"
            output_path.write_bytes(view_res.content)

            job.result = {
                "takeId": take_id,
                "relativePath": f"shots/{shot_id}/takes/{take_id}/output.mp4",
                "seed": resolved_seed,
            }
            await jobs.emit(job, {"status": "done", "phase": "complete", "message": "Done", "result": job.result})
        except jobs.JobCancelled:
            await jobs.emit(job, {"status": "cancelled", "message": "Cancelled"})
        except Exception as exc:  # noqa: BLE001 - reported to the client as a job error, not raised
            logger.error("generate failed for shot %s: %s", shot_id, traceback.format_exc())
            job.error = _error_message(exc)
            await jobs.emit(job, {"status": "error", "message": job.error})
        finally:
            shutil.rmtree(generation_dir, ignore_errors=True)
            await jobs.close(job)

    asyncio.create_task(run())
    return {"jobId": job.id, "takeId": take_id, "preflight": preflight}


@router.post("/api/projects/{project_id}/shots/{shot_id}/generate")
async def generate_take(project_id: str, shot_id: int, body: dict = Body(default={})):
    data, directory = _load_project(project_id)
    shot = next((s for s in data.get("shots", []) if s.get("id") == shot_id), None)
    if not shot:
        raise HTTPException(status_code=404, detail="shot not found")
    try:
        result = await start_generation_job(data, directory, shot, body)
    except GenerationStartError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return JSONResponse(status_code=202, content=result)
