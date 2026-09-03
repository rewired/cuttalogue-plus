# Whole-project export: per-shot folders, shot.json manifest, copied assets,
# prompt/notes, optional per-shot mix.flac snippet, the full mix track
# copied once to the export root, aggregate progress, and cancellation
# (checked between shots and mid-encode via media.py's should_cancel).
import asyncio
import json
import logging
import shutil
import traceback
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import JSONResponse

from . import audio, frames, jobs, media
from .projects import project_dir

logger = logging.getLogger("cuttalogue.export")

router = APIRouter()


def _load_project(project_id: str) -> tuple[dict, Path]:
    directory = project_dir(project_id)
    project_file = directory / "project.json"
    if not project_file.exists():
        raise HTTPException(status_code=404, detail="project not found")
    data = json.loads(project_file.read_text(encoding="utf-8"))
    return data, directory


def _error_message(exc: Exception) -> str:
    # str(exc) is empty for some exceptions (bare AssertionError, etc.) - repr()
    # always includes the exception type, so the client never sees a blank
    # "job failed" with no clue what happened.
    return str(exc) or repr(exc)


@router.post("/api/projects/{project_id}/export")
async def export_project(project_id: str, options: dict = Body(default={})):
    include_mix = bool(options.get("includeMixSnippet"))
    data, directory = _load_project(project_id)

    shots = data.get("shots", [])
    if not shots:
        raise HTTPException(status_code=400, detail="project has no shots to export")

    vocal_path = audio.require_track(data, directory, "vocal")
    # Full-mix copy (below) is best-effort - a project without a mix track
    # still exports fine. The per-shot mix.flac snippet is opt-in, so *that*
    # still errors like before when requested without a mix uploaded.
    mix_path = audio.optional_track(data, directory, "mix")
    if include_mix and mix_path is None:
        raise HTTPException(status_code=400, detail="no mix track uploaded for this project yet")

    assets_by_id = {a["id"]: a for a in data.get("assets", [])}
    video = data["video"]
    frame_rule_label = frames.frame_rule_label()
    fps_value = frames.fps(video)
    shot_count = len(shots)

    export_dir = directory / "export"
    job = jobs.create_job()

    def should_cancel() -> bool:
        return job.cancel_requested

    async def run():
        current_shot_dir: Path | None = None
        try:
            if export_dir.exists():
                shutil.rmtree(export_dir)
            export_dir.mkdir(parents=True)
            (export_dir / "project.json").write_text(json.dumps(data, indent=2), encoding="utf-8")

            if mix_path is not None:
                await jobs.emit(
                    job,
                    {
                        "status": "running",
                        "phase": "mix",
                        "shotCount": shot_count,
                        "message": "Copying full mix",
                        "progressFraction": 0.0,
                    },
                )
                shutil.copyfile(mix_path, export_dir / f"mix{mix_path.suffix}")

            for index, shot in enumerate(shots):
                if should_cancel():
                    await jobs.emit(
                        job, {"status": "cancelled", "shot": index, "shotCount": shot_count, "message": "Cancelled"}
                    )
                    return

                shot_id = shot["id"]
                shot_dir = export_dir / f"shot-{shot_id:03d}"
                current_shot_dir = shot_dir
                shot_dir.mkdir(parents=True, exist_ok=True)

                cut_duration = shot["endSeconds"] - shot["startSeconds"]
                calc = frames.frame_calc(cut_duration, video)
                render_duration = calc["renderFrames"] / calc["renderFps"]
                base_progress = index / shot_count

                async def on_progress(fraction: float) -> None:
                    await jobs.emit(
                        job,
                        {
                            "status": "running",
                            "phase": "audio",
                            "shot": index + 1,
                            "shotCount": shot_count,
                            "message": f"Shot {shot_id}: encoding lip_sync.flac",
                            "itemProgress": fraction,
                            "progressFraction": base_progress + fraction / shot_count,
                        },
                    )

                await media.run_ffmpeg_with_progress(
                    media.audio_snippet_cmd(vocal_path, shot["startSeconds"], render_duration, shot_dir / "lip_sync.flac"),
                    render_duration,
                    on_progress,
                    should_cancel=should_cancel,
                )

                if include_mix:

                    async def on_mix_progress(fraction: float) -> None:
                        await jobs.emit(
                            job,
                            {
                                "status": "running",
                                "phase": "audio",
                                "shot": index + 1,
                                "shotCount": shot_count,
                                "message": f"Shot {shot_id}: encoding mix.flac",
                                "itemProgress": fraction,
                                "progressFraction": base_progress + fraction / shot_count,
                            },
                        )

                    await media.run_ffmpeg_with_progress(
                        media.audio_snippet_cmd(mix_path, shot["startSeconds"], render_duration, shot_dir / "mix.flac"),
                        render_duration,
                        on_mix_progress,
                        should_cancel=should_cancel,
                    )

                asset_relative_paths: list[str] = []
                asset_ids = shot.get("assetIds") or []
                if asset_ids:
                    await jobs.emit(
                        job,
                        {
                            "status": "running",
                            "phase": "assets",
                            "shot": index + 1,
                            "shotCount": shot_count,
                            "message": f"Shot {shot_id}: copying assets",
                            "itemProgress": 0.0,
                            "progressFraction": base_progress,
                        },
                    )
                    assets_dest = shot_dir / "assets"
                    assets_dest.mkdir(exist_ok=True)
                    for asset_id in asset_ids:
                        asset = assets_by_id.get(asset_id)
                        if not asset:
                            continue
                        src = directory / asset["relativePath"]
                        if not src.exists():
                            continue
                        dest = assets_dest / src.name
                        shutil.copyfile(src, dest)
                        asset_relative_paths.append(f"assets/{src.name}")

                manifest = {
                    "shot": shot_id,
                    "seed": shot.get("seed"),
                    "startSeconds": shot["startSeconds"],
                    "endSeconds": shot["endSeconds"],
                    "cutDurationSeconds": cut_duration,
                    "fps": fps_value,
                    "cutFrames": calc["cutFrames"],
                    "renderFps": calc["renderFps"],
                    "frameRule": frame_rule_label,
                    "renderFrames": calc["renderFrames"],
                    "renderDurationSeconds": render_duration,
                    "overhangFrames": calc["overhangFrames"],
                    "assets": asset_relative_paths,
                }
                (shot_dir / "shot.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
                (shot_dir / "prompt.txt").write_text(shot.get("prompt") or "", encoding="utf-8")
                (shot_dir / "notes.md").write_text(shot.get("notes") or "", encoding="utf-8")
                current_shot_dir = None

                await jobs.emit(
                    job,
                    {
                        "status": "running",
                        "phase": "manifest",
                        "shot": index + 1,
                        "shotCount": shot_count,
                        "message": f"Shot {shot_id}: done",
                        "itemProgress": 1.0,
                        "progressFraction": (index + 1) / shot_count,
                    },
                )

            job.result = {"exportPath": str(export_dir), "shotCount": shot_count}
            await jobs.emit(
                job,
                {"status": "done", "phase": "complete", "message": "Export complete", "progressFraction": 1.0, "result": job.result},
            )
        except media.FFmpegCancelled:
            if current_shot_dir is not None and current_shot_dir.exists():
                shutil.rmtree(current_shot_dir, ignore_errors=True)
            await jobs.emit(job, {"status": "cancelled", "message": "Cancelled"})
        except Exception as exc:  # noqa: BLE001 - reported to the client as a job error, not raised
            logger.error("project export failed: %s", traceback.format_exc())
            if current_shot_dir is not None and current_shot_dir.exists():
                shutil.rmtree(current_shot_dir, ignore_errors=True)
            job.error = _error_message(exc)
            await jobs.emit(job, {"status": "error", "message": job.error})
        finally:
            await jobs.close(job)

    asyncio.create_task(run())
    return JSONResponse(status_code=202, content={"jobId": job.id, "shotCount": shot_count})
