# Application-level provider connections and audio-render quality. Per the
# product doc, these are scoped to the whole app, not a project, and stored in
# their own file next to (not inside) backend/data/projects/. Provider secrets
# are never echoed back to the client or written into project.json/export.
import json
from pathlib import Path

from fastapi import APIRouter, Body

from . import media

router = APIRouter()

SETTINGS_FILE = Path(__file__).resolve().parents[1] / "data" / "settings.json"

DEFAULT_PROVIDERS = {
    "ai": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": "",
        "defaultModel": "",
    },
    "comfy": {
        "baseUrl": "",
        "apiKey": "",
        # 'pod' (a persistent Pod's own HTTP API) is the only mode
        # implemented so far - RunPod Serverless (a different job-wrapper
        # API) is deliberately deferred, this field just reserves the shape.
        "mode": "pod",
    },
}

DEFAULT_AUDIO = {
    "renderQuality": media.DEFAULT_AUDIO_RENDER_PRESET,
    "renderFormat": media.DEFAULT_AUDIO_RENDER_FORMAT,
}


def load_settings() -> dict:
    if not SETTINGS_FILE.exists():
        return {"providers": {k: dict(v) for k, v in DEFAULT_PROVIDERS.items()}, "audio": dict(DEFAULT_AUDIO)}
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"providers": {k: dict(v) for k, v in DEFAULT_PROVIDERS.items()}, "audio": dict(DEFAULT_AUDIO)}
    # Pre-two-provider saves only have a flat "aiProvider" key - migrate it
    # into providers.ai on load rather than carrying a permanent compat shim.
    if "providers" not in data and "aiProvider" in data:
        data = {"providers": {"ai": data["aiProvider"]}}
    providers = {
        key: {**default, **(data.get("providers", {}).get(key) or {})}
        for key, default in DEFAULT_PROVIDERS.items()
    }
    incoming_audio = data.get("audio") or {}
    audio = {
        "renderQuality": media.normalize_audio_render_preset(incoming_audio.get("renderQuality")),
        "renderFormat": media.normalize_audio_render_format(incoming_audio.get("renderFormat")),
    }
    return {"providers": providers, "audio": audio}


def save_settings(data: dict) -> None:
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _public_view(data: dict) -> dict:
    providers = data["providers"]
    return {
        "audio": dict(data["audio"]),
        "providers": {
            "ai": {
                "baseUrl": providers["ai"]["baseUrl"],
                "defaultModel": providers["ai"]["defaultModel"],
                "hasApiKey": bool(providers["ai"]["apiKey"]),
            },
            "comfy": {
                "baseUrl": providers["comfy"]["baseUrl"],
                "mode": providers["comfy"]["mode"],
                "hasApiKey": bool(providers["comfy"]["apiKey"]),
            },
        }
    }


@router.get("/api/settings")
async def get_settings():
    return _public_view(load_settings())


@router.put("/api/settings")
async def put_settings(body: dict = Body(default={})):
    current = load_settings()
    incoming_providers = body.get("providers") or {}

    ai = current["providers"]["ai"]
    incoming_ai = incoming_providers.get("ai") or {}
    if "baseUrl" in incoming_ai:
        ai["baseUrl"] = (incoming_ai["baseUrl"] or "").strip() or DEFAULT_PROVIDERS["ai"]["baseUrl"]
    if "defaultModel" in incoming_ai:
        ai["defaultModel"] = (incoming_ai["defaultModel"] or "").strip()
    # An empty/absent apiKey means "leave the saved key alone" - the client
    # never gets the real key back to redisplay, so it can't round-trip one
    # the user didn't just type. Same rule for both providers below.
    if incoming_ai.get("apiKey"):
        ai["apiKey"] = incoming_ai["apiKey"].strip()

    comfy = current["providers"]["comfy"]
    incoming_comfy = incoming_providers.get("comfy") or {}
    if "baseUrl" in incoming_comfy:
        comfy["baseUrl"] = (incoming_comfy["baseUrl"] or "").strip()
    if "mode" in incoming_comfy:
        comfy["mode"] = (incoming_comfy["mode"] or "").strip() or DEFAULT_PROVIDERS["comfy"]["mode"]
    if incoming_comfy.get("apiKey"):
        comfy["apiKey"] = incoming_comfy["apiKey"].strip()

    incoming_audio = body.get("audio") or {}
    if "renderQuality" in incoming_audio:
        current["audio"]["renderQuality"] = media.normalize_audio_render_preset(incoming_audio["renderQuality"])
    if "renderFormat" in incoming_audio:
        current["audio"]["renderFormat"] = media.normalize_audio_render_format(incoming_audio["renderFormat"])

    save_settings(current)
    return _public_view(current)


async def _test_ai(incoming: dict, current: dict) -> dict:
    import httpx

    base_url = (incoming.get("baseUrl") or current["baseUrl"] or "").rstrip("/")
    api_key = incoming.get("apiKey") or current["apiKey"]
    model = (incoming.get("defaultModel") or current["defaultModel"] or "").strip()

    if not base_url:
        return {"ok": False, "message": "No API base URL provided."}
    if not api_key:
        return {"ok": False, "message": "No API key provided."}

    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(f"{base_url}/models", headers=headers)
        if res.status_code != 200:
            return {"ok": False, "message": f"Provider returned HTTP {res.status_code} listing models."}
        models = sorted(m["id"] for m in (res.json() or {}).get("data") or [] if m.get("id"))
    except Exception as exc:  # noqa: BLE001 - reported to the client, not raised
        return {"ok": False, "message": str(exc) or repr(exc)}

    catalog_note = f"{len(models)} model(s) in catalog." if models else "Catalog empty."
    if not model:
        return {"ok": True, "message": f"Connected - {catalog_note} Set a default model to also verify it can generate.", "models": models}

    # Listing /models only proves the key is well-formed enough to browse the
    # public catalog - OpenRouter accepts that call for keys that then get
    # rejected on real chat/completions requests. Run an actual (tiny, cheap)
    # completion against the configured model so a bad key or bad model slug
    # shows up here instead of surprising the user later in [Describe image].
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            gen_res = await client.post(
                f"{base_url}/chat/completions",
                headers={**headers, "Content-Type": "application/json"},
                json={"model": model, "messages": [{"role": "user", "content": "Reply with just: OK"}], "max_tokens": 5},
            )
        if gen_res.status_code == 200:
            return {"ok": True, "message": f"Connected - {catalog_note} Generation check with \"{model}\" succeeded.", "models": models}
        detail = gen_res.text[:300]
        return {
            "ok": False,
            "message": f"Catalog lists {len(models)} models, but a real generation request with \"{model}\" failed: HTTP {gen_res.status_code} {detail}",
            "models": models,
        }
    except Exception as exc:  # noqa: BLE001 - reported to the client, not raised
        return {"ok": False, "message": f"Generation check with \"{model}\" failed: {exc}", "models": models}


async def _test_comfy(incoming: dict, current: dict) -> dict:
    import httpx

    base_url = (incoming.get("baseUrl") or current["baseUrl"] or "").rstrip("/")
    if not base_url:
        return {"ok": False, "message": "No ComfyUI base URL provided."}

    # No auth header sent yet - the Pod's authentication scheme (basic-auth
    # sidecar, SSH tunnel, or something else) hasn't been decided. A stored
    # apiKey is accepted here but deliberately unused until that's settled.
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(f"{base_url}/system_stats")
        if res.status_code != 200:
            return {"ok": False, "message": f"ComfyUI returned HTTP {res.status_code} for /system_stats."}
        return {"ok": True, "message": "Connected - ComfyUI responded to /system_stats."}
    except Exception as exc:  # noqa: BLE001 - reported to the client, not raised
        return {"ok": False, "message": str(exc) or repr(exc)}


@router.post("/api/settings/test")
async def test_settings(body: dict = Body(default={})):
    provider_key = body.get("provider")
    if provider_key not in ("ai", "comfy"):
        return {"ok": False, "message": "Unknown provider."}

    current = load_settings()["providers"][provider_key]
    incoming = {k: v for k, v in body.items() if k != "provider"}
    if provider_key == "ai":
        return await _test_ai(incoming, current)
    return await _test_comfy(incoming, current)
