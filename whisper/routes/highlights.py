# whisper/routes/highlights.py
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from models import YouTubeReq
from services.youtube import extract_video_id
from services.shared import (
    get_cached_highlights,
    get_transcript_data,
    cache_highlights_data,
    save_highlights_to_db,
    get_transcribe_status,
)
from services.highlights import build_highlights_from_segments_llm

router = APIRouter()

@router.post("/highlights/youtube")
async def highlights_youtube(body: YouTubeReq):
    url = (body.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="Missing url")

    video_id = (body.video_id or "").strip() or extract_video_id(url)

    # 1) Redis cache
    cached = get_cached_highlights(video_id)
    if cached:
        transcript, segments = get_transcript_data(video_id)
        return JSONResponse({
            "video_id": video_id,
            "url": url,
            "highlights": cached.get("highlights", []),
            "transcript": transcript or "",
            "segments": segments,
        })

    # 2) Get transcript from DB
    transcribe_status = get_transcribe_status(video_id) or {}
    if transcribe_status.get("status") in {"queued", "processing"} and not transcribe_status.get("done"):
        raise HTTPException(status_code=409, detail="Transcript is still processing. Try again shortly.")

    transcript, segments = get_transcript_data(video_id)
    if not transcript or not transcript.strip():
        raise HTTPException(status_code=404, detail="Transcript not ready. Call /transcribe/youtube first.")

    # 3) Generate highlights
    highlights = build_highlights_from_segments_llm(segments)

    # 4) Cache and save
    cache_highlights_data(video_id, highlights, transcript, segments)
    save_highlights_to_db(video_id, highlights)

    return JSONResponse({
        "video_id": video_id,
        "url": url,
        "highlights": highlights,
        "transcript": transcript,
        "segments": segments,
    })