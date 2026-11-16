import os
import shutil
import tempfile
from functools import lru_cache

from faster_whisper import WhisperModel
from config import (
    WHISPER_MODEL,
    WHISPER_DEVICE,
    WHISPER_COMPUTE,
    WHISPER_CHUNK_SECONDS,
    WHISPER_CHUNK_OVERLAP_SECONDS,
)
from services.youtube import probe_duration, split_audio_chunk

@lru_cache(maxsize=1)
def get_model():
    """Lazy load whisper model on first call"""
    print(f"Loading whisper model: {WHISPER_MODEL}", flush=True)
    return WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE)

def get_whisper_instance():
    """Get the model instance, loading it on first call"""
    return get_model()

def _normalize_text(text: str) -> str:
    return " ".join(str(text or "").split()).strip()

def _validate_audio_file(path: str):
    """Check if audio file is valid before transcription.
    
    Allow very small files (<2KB) as they may be legitimate edge cases
    at the end of videos. Only fail on clearly corrupt or empty files.
    """
    import subprocess
    
    # Quick size check - reject completely empty files
    try:
        if os.path.getsize(path) < 50:
            return False
    except Exception:
        return False
    
    # For small files, be lenient and allow them through
    # They might be valid edge cases at video end
    try:
        size = os.path.getsize(path)
        if size < 2000:  # Less than 2KB
            return True
    except Exception:
        pass
    
    # For larger files, do proper validation
    try:
        result = subprocess.run([
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ], capture_output=True, timeout=30)
        if result.returncode == 0:
            duration = float(result.stdout.decode().strip() or "0")
            return duration > 0.1  # Must be at least 0.1 seconds
    except Exception:
        pass
    
    return False

def _transcribe_single_file(path: str):
    import sys
    # Validate audio file before transcription
    if not os.path.exists(path):
        print(f"DEBUG transcribe: Audio file missing: {path}", file=sys.stderr, flush=True)
        raise ValueError(f"Audio file missing: {path}")
    
    size = os.path.getsize(path)
    print(f"DEBUG transcribe: Reading {path} ({size} bytes)", file=sys.stderr, flush=True)
    
    # Skip transcription for tiny files - they are too small to contain meaningful audio
    # and will cause whisper errors. These are typically edge cases at video end.
    if size < 2000:  # Less than 2KB = less than ~0.1s at standard encoding
        print(f"DEBUG transcribe: Skipping tiny file ({size} bytes) - not enough data", 
              file=sys.stderr, flush=True)
        return "", {
            "language": None,
            "duration": 0.0,
            "segments": []
        }
    
    # For larger files, do proper validation
    if not _validate_audio_file(path):
        print(f"DEBUG transcribe: Audio file invalid after validation: {path}", 
              file=sys.stderr, flush=True)
        raise ValueError(f"Invalid or empty audio file: {path}")
    
    model = get_whisper_instance()
    segments, info = model.transcribe(path)
    segs = [{"start": s.start, "end": s.end, "text": s.text} for s in segments]
    text = " ".join(_normalize_text(s["text"]) for s in segs if _normalize_text(s["text"])).strip()
    meta = {
        "language": getattr(info, "language", None),
        "duration": getattr(info, "duration", None),
        "segments": segs,
    }
    return text, meta

def _merge_chunk_segments(chunk_results, overlap_seconds: float):
    merged = []
    for index, chunk in enumerate(chunk_results):
        chunk_start = float(chunk["chunk_start"])
        overlap_cutoff = chunk_start + max(0.0, overlap_seconds)

        for seg in chunk["segments"]:
            start = float(seg.get("start", 0) or 0) + chunk_start
            end = float(seg.get("end", 0) or 0) + chunk_start
            text = _normalize_text(seg.get("text", ""))
            if not text:
                continue

            # Drop the duplicated leading overlap from later chunks.
            if index > 0 and end <= overlap_cutoff:
                continue

            merged.append({
                "start": start,
                "end": end,
                "text": text,
            })

    merged.sort(key=lambda s: (float(s.get("start", 0) or 0), float(s.get("end", 0) or 0)))
    return merged

def transcribe_file(path: str, progress_callback=None):
    chunk_seconds = max(5.0, float(WHISPER_CHUNK_SECONDS or 30))
    overlap_seconds = max(0.0, min(float(WHISPER_CHUNK_OVERLAP_SECONDS or 1), chunk_seconds / 3))
    duration = probe_duration(path)

    if duration <= 0 or duration <= chunk_seconds + overlap_seconds:
        text, meta = _transcribe_single_file(path)
        if progress_callback:
            progress_callback(text, meta, 1.0)
        return text, meta

    chunk_dir = tempfile.mkdtemp(prefix="whisper_chunks_", dir=os.path.dirname(path) or None)
    try:
        chunk_results = []
        chunk_start = 0.0
        step_seconds = max(1.0, chunk_seconds - overlap_seconds)

        while chunk_start < duration:
            chunk_duration = min(chunk_seconds, max(0.1, duration - chunk_start))
            chunk_name = f"chunk_{len(chunk_results):04d}.mp3"
            chunk_path = os.path.join(chunk_dir, chunk_name)
            split_audio_chunk(path, chunk_path, chunk_start, chunk_duration)

            _, chunk_meta = _transcribe_single_file(chunk_path)
            chunk_results.append({
                "chunk_start": chunk_start,
                "segments": chunk_meta.get("segments", []),
                "language": chunk_meta.get("language"),
            })

            if progress_callback:
                partial_segments = _merge_chunk_segments(chunk_results, overlap_seconds)
                partial_text = " ".join(seg["text"] for seg in partial_segments).strip()
                partial_language = next((chunk.get("language") for chunk in chunk_results if chunk.get("language")), None)
                partial_meta = {
                    "language": partial_language,
                    "duration": duration,
                    "segments": partial_segments,
                    "chunking": {
                        "enabled": True,
                        "chunkSeconds": chunk_seconds,
                        "overlapSeconds": overlap_seconds,
                        "chunkCount": len(chunk_results),
                    },
                }
                progress = min(0.99, chunk_start / duration + (chunk_duration / duration))
                progress_callback(partial_text, partial_meta, progress)

            chunk_start += step_seconds

        merged_segments = _merge_chunk_segments(chunk_results, overlap_seconds)
        transcript_text = " ".join(seg["text"] for seg in merged_segments).strip()
        language = next((chunk.get("language") for chunk in chunk_results if chunk.get("language")), None)

        meta = {
            "language": language,
            "duration": duration,
            "segments": merged_segments,
            "chunking": {
                "enabled": True,
                "chunkSeconds": chunk_seconds,
                "overlapSeconds": overlap_seconds,
                "chunkCount": len(chunk_results),
            },
        }
        return transcript_text, meta
    finally:
        shutil.rmtree(chunk_dir, ignore_errors=True)