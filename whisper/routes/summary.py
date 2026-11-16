# whisper/routes/summary.py
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from models import YouTubeReq
from services.youtube import extract_video_id
from services.shared import (
    get_cached_summary,
    get_transcript_data,
    generate_summary,
    cache_summary_data,
    save_summary_to_db,
    get_transcribe_status,
)

router = APIRouter()

@router.post("/summary/youtube")
async def summarize_youtube(body: YouTubeReq):
    url = (body.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="Missing url")

    video_id = (body.video_id or "").strip() or extract_video_id(url)

    # 1) Redis cache
    cached = get_cached_summary(video_id)
    if cached:
        transcript, segments = get_transcript_data(video_id)
        return JSONResponse({
            "video_id": video_id,
            "url": url,
            "summary": cached.get("summary"),
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

    # 3) Generate summary
    summary = generate_summary(url, transcript)

    # 4) Cache and save
    cache_summary_data(video_id, summary, transcript, segments)
    save_summary_to_db(video_id, summary)

    return JSONResponse({
        "video_id": video_id,
        "url": url,
        "summary": summary,
        "transcript": transcript,
        "segments": segments,
    })