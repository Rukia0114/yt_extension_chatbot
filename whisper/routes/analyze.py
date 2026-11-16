import os
import tempfile
import shutil
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from models import YouTubeReq
from services.youtube import ensure_tools, download_audio, extract_video_id
from services.whisper import transcribe_file
from services.highlights import build_highlights_from_segments_llm
from services.cache import get_redis, cache_get_json
from services.shared import (
    get_cached_summary,
    get_cached_highlights,
    get_transcript_data,
    generate_summary, 
    cache_summary_data,
    cache_highlights_data,
    get_transcribe_status,
)
from db import save_transcript, update_metadata
from config import VIDEO_DIR

router = APIRouter()

@router.post("/analyze/youtube")
async def analyze_youtube(body: YouTubeReq):
    url = (body.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="Missing url")

    video_id = (body.video_id or "").strip() or extract_video_id(url)
    r = get_redis()

    # 1) Redis cache (full check)
    cached_summary = get_cached_summary(video_id)
    cached_highlights = get_cached_highlights(video_id)
    cached_transcript = cache_get_json(r, f"transcript:{video_id}")
    cached_segments = cache_get_json(r, f"segments:{video_id}")

    if cached_summary and cached_highlights and cached_transcript and cached_segments:
        return JSONResponse({
            "video_id": video_id,
            "url": url,
            "summary": cached_summary.get("summary"),
            "highlights": cached_highlights.get("highlights", []),
            "transcript": cached_transcript.get("text", ""),
            "segments": cached_segments.get("segments", []),
        })

    # 2) Get transcript from DB
    transcribe_status = get_transcribe_status(video_id) or {}
    if transcribe_status.get("status") in {"queued", "processing"} and not transcribe_status.get("done"):
        raise HTTPException(status_code=409, detail="Transcript is still processing. Try again shortly.")

    transcript, segments = get_transcript_data(video_id)

    # 3) If missing, download + transcribe
    if not transcript:
        ensure_tools()
        os.makedirs(VIDEO_DIR, exist_ok=True)
        work_dir = tempfile.mkdtemp(prefix="yt_", dir=VIDEO_DIR)
        try:
            audio_path = download_audio(url, work_dir)
            text, meta = transcribe_file(audio_path)
            transcript = text
            segments = meta.get("segments", [])
            save_transcript(video_id, url, transcript, meta)
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    if not transcript or not transcript.strip():
        raise HTTPException(status_code=404, detail="No transcript available for this video")

    # 4) Generate highlights + summary
    highlights = build_highlights_from_segments_llm(segments)
    summary = generate_summary(url, transcript)

    # 5) Save to DB
    update_metadata(video_id, {"summary": summary, "highlights": highlights})

    # 6) Cache everything
    cache_summary_data(video_id, summary, transcript, segments)
    cache_highlights_data(video_id, highlights, transcript, segments)

    return JSONResponse({
        "video_id": video_id,
        "url": url,
        "summary": summary,
        "highlights": highlights,
        "transcript": transcript,
        "segments": segments,
    })