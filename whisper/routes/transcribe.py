import os
import tempfile
import shutil
from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import JSONResponse
from models import YouTubeReq
from services.youtube import ensure_tools, download_audio, extract_video_id
from services.whisper import transcribe_file
from db import save_transcript, get_transcript, get_segments
from config import VIDEO_DIR
from services.shared import get_transcribe_status, set_transcribe_status
from services.cache import get_redis, cache_get_json, cache_set_json

router = APIRouter()
ACTIVE_TRANSCRIBE_JOBS = set()

def _read_cached_progress(video_id: str):
    r = get_redis()
    transcript_cached = cache_get_json(r, f"transcript:{video_id}") if r else None
    segments_cached = cache_get_json(r, f"segments:{video_id}") if r else None
    status = get_transcribe_status(video_id) or {}
    return {
        "text": transcript_cached.get("text", "") if transcript_cached else "",
        "segments": segments_cached.get("segments", []) if segments_cached else [],
        "status": status,
    }

def _run_transcription_job(video_id: str, url: str):
    ensure_tools()
    os.makedirs(VIDEO_DIR, exist_ok=True)
    work_dir = tempfile.mkdtemp(prefix="yt_", dir=VIDEO_DIR)
    r = get_redis()

    def persist_partial(text: str, meta: dict, progress: float):
        if r:
            cache_set_json(r, f"transcript:{video_id}", {"text": text})
            cache_set_json(r, f"segments:{video_id}", {"segments": meta.get("segments", [])})
        save_transcript(video_id, url, text, meta)
        set_transcribe_status(video_id, {
            "status": "processing",
            "progress": round(float(progress or 0), 4),
            "done": False,
            "error": "",
        })

    try:
        set_transcribe_status(video_id, {
            "status": "queued",
            "progress": 0.0,
            "done": False,
            "error": "",
        })

        audio_path = download_audio(url, work_dir)
        text, meta = transcribe_file(audio_path, progress_callback=persist_partial)
        save_transcript(video_id, url, text, meta)

        if r:
            cache_set_json(r, f"transcript:{video_id}", {"text": text})
            cache_set_json(r, f"segments:{video_id}", {"segments": meta.get("segments", [])})

        set_transcribe_status(video_id, {
            "status": "completed",
            "progress": 1.0,
            "done": True,
            "error": "",
        })
    except Exception as e:
        set_transcribe_status(video_id, {
            "status": "error",
            "progress": 0.0,
            "done": False,
            "error": str(e),
        })
    finally:
        ACTIVE_TRANSCRIBE_JOBS.discard(video_id)
        shutil.rmtree(work_dir, ignore_errors=True)

@router.post("/transcribe/youtube")
async def transcribe_youtube(body: YouTubeReq, background_tasks: BackgroundTasks):
    url = (body.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="Missing url")

    video_id = (body.video_id or "").strip() or extract_video_id(url)
    status = get_transcribe_status(video_id) or {}
    cached = _read_cached_progress(video_id)
    persisted_text = get_transcript(video_id) or ""
    persisted_segments = get_segments(video_id)

    if persisted_text and not status:
        return JSONResponse({
            "video_id": video_id,
            "url": url,
            "text": persisted_text,
            "segments": persisted_segments,
            "progress": 1.0,
            "done": True,
        })

    if status.get("done"):
        return JSONResponse({
            "video_id": video_id,
            "url": url,
            "text": cached["text"] or persisted_text,
            "segments": cached["segments"] or persisted_segments,
            "progress": 1.0,
            "done": True,
        })

    if video_id not in ACTIVE_TRANSCRIBE_JOBS and status.get("status") not in {"queued", "processing"}:
        ACTIVE_TRANSCRIBE_JOBS.add(video_id)
        background_tasks.add_task(_run_transcription_job, video_id, url)
        status = {
            "status": "queued",
            "progress": 0.0,
            "done": False,
            "error": "",
        }

    return JSONResponse({
        "video_id": video_id,
        "url": url,
        "text": cached["text"],
        "segments": cached["segments"],
        "progress": float(status.get("progress", 0) or 0),
        "done": bool(status.get("done")),
        "status": status.get("status", "queued"),
        "error": status.get("error", ""),
    }, status_code=202 if not status.get("done") else 200)

@router.get("/transcribe/status/{video_id}")
async def transcribe_status(video_id: str):
    status = get_transcribe_status(video_id) or {}
    cached = _read_cached_progress(video_id)
    persisted_text = get_transcript(video_id) or ""
    persisted_segments = get_segments(video_id)
    return JSONResponse({
        "video_id": video_id,
        "text": cached["text"] or persisted_text,
        "segments": cached["segments"] or persisted_segments,
        "progress": 1.0 if persisted_text and not status else float(status.get("progress", 0) or 0),
        "done": bool(status.get("done")) or bool(persisted_text and not status),
        "status": status.get("status", "completed" if persisted_text and not status else ""),
        "error": status.get("error", ""),
    })