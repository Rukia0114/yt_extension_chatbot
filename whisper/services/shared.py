# whisper/services/summary.py
from typing import Optional, Tuple
from services.cache import get_redis, cache_get_json, cache_set_json
from db import get_transcript, get_segments, update_metadata
from services.llm import lmstudio_chat

def get_cached_summary(video_id: str) -> Optional[dict]:
    """Get summary from Redis cache."""
    r = get_redis()
    if not r:
        return None
    cached = cache_get_json(r, f"summary:{video_id}")
    return cached if cached and cached.get("summary") else None

def get_transcribe_status(video_id: str) -> Optional[dict]:
    r = get_redis()
    if not r:
        return None
    return cache_get_json(r, f"transcribe_status:{video_id}")

def set_transcribe_status(video_id: str, payload: dict):
    r = get_redis()
    if not r:
        return
    cache_set_json(r, f"transcribe_status:{video_id}", payload)

def get_cached_highlights(video_id: str) -> Optional[dict]:
    """Get highlights from Redis cache."""
    r = get_redis()
    if not r:
        return None
    cached = cache_get_json(r, f"highlights:{video_id}")
    return cached if cached and cached.get("highlights") else None

def get_transcript_data(video_id: str) -> Tuple[Optional[str], list]:
    """Get transcript and segments from DB."""
    transcript = get_transcript(video_id)
    segments = get_segments(video_id)
    return transcript, segments if isinstance(segments, list) else []

def generate_summary(url: str, transcript: str, temperature: float = 0.3) -> str:
    """Generate summary from transcript using LLM."""
    return lmstudio_chat(
        [
            {"role": "system", "content": "You summarize video transcripts clearly and concisely."},
            {
                "role": "user",
                "content":
                    f"Video: {url}\n\n"
                    f"Transcript:\n{transcript}\n\n"
                    "Return only a concise summary based on the transcript length and content. Do NOT include highlights.",
            },
        ],
        temperature=temperature,
        timeout_sec=180,
    ).strip()

def cache_summary_data(video_id: str, summary: str, transcript: str, segments: list):
    """Cache summary, transcript, and segments in Redis."""
    r = get_redis()
    if not r:
        return
    cache_set_json(r, f"summary:{video_id}", {"summary": summary})
    cache_set_json(r, f"transcript:{video_id}", {"text": transcript})
    cache_set_json(r, f"segments:{video_id}", {"segments": segments})

def cache_highlights_data(video_id: str, highlights: list, transcript: str, segments: list):
    """Cache highlights, transcript, and segments in Redis."""
    r = get_redis()
    if not r:
        return
    cache_set_json(r, f"highlights:{video_id}", {"highlights": highlights})
    cache_set_json(r, f"transcript:{video_id}", {"text": transcript})
    cache_set_json(r, f"segments:{video_id}", {"segments": segments})

def save_summary_to_db(video_id: str, summary: str):
    """Save summary to DB metadata."""
    update_metadata(video_id, {"summary": summary})

def save_highlights_to_db(video_id: str, highlights: list):
    """Save highlights to DB metadata."""
    update_metadata(video_id, {"highlights": highlights})