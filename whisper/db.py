import json
import psycopg
from typing import Optional, List, Dict, Any
from config import DATABASE_URL

def save_transcript(video_id: str, url: str, transcript: str, meta: dict):
    if not DATABASE_URL:
        return
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO videos (video_id, url, transcript, metadata)
                VALUES (%s, %s, %s, %s::jsonb)
                ON CONFLICT (video_id) DO UPDATE SET
                  url = EXCLUDED.url,
                  transcript = EXCLUDED.transcript,
                  metadata = COALESCE(videos.metadata, '{}'::jsonb) || EXCLUDED.metadata,
                  updated_at = NOW()
                """,
                (video_id, url, transcript, json.dumps({"whisper": meta})),
            )
        conn.commit()

def update_metadata(video_id: str, patch: dict):
    if not DATABASE_URL:
        return
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE videos
                SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb,
                    updated_at = NOW()
                WHERE video_id = %s
                """,
                (json.dumps(patch or {}), video_id),
            )
        conn.commit()

def get_transcript(video_id: str) -> Optional[str]:
    if not DATABASE_URL:
        return None
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT transcript FROM videos WHERE video_id = %s LIMIT 1", (video_id,))
            row = cur.fetchone()
            return row[0] if row and row[0] else None

def get_segments(video_id: str) -> List[Dict[str, Any]]:
    if not DATABASE_URL:
        return []
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT metadata FROM videos WHERE video_id = %s LIMIT 1", (video_id,))
            row = cur.fetchone()
            if not row:
                return []
            meta = row[0] or {}
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except Exception:
                    meta = {}
            whisper_meta = meta.get("whisper") if isinstance(meta, dict) else None
            if isinstance(whisper_meta, dict) and isinstance(whisper_meta.get("segments"), list):
                return whisper_meta.get("segments")
            return []