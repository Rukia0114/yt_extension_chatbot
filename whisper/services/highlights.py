from typing import List, Dict, Any
import json
import re

from services.llm import lmstudio_chat

def _segments_to_prompt(segments: List[Dict[str, Any]], max_segments: int = 200) -> str:
    """
    Convert segments into a compact prompt (time + text).
    To avoid huge prompts, we limit to max_segments (earliest segments).
    """
    parts = []
    for s in segments[:max_segments]:
        start = float(s.get("start", 0) or 0)
        end = float(s.get("end", 0) or 0)
        text = str(s.get("text", "") or "").strip().replace("\n", " ")
        if not text:
            continue
        parts.append(f"[{start:.1f}-{end:.1f}] {text}")
    return "\n".join(parts)

def _fallback_highlights(segments: List[Dict[str, Any]], max_highlights: int = 5) -> List[Dict[str, Any]]:
    if not segments:
        return []
    n = len(segments)
    idxs = [0, n // 4, n // 2, (3 * n) // 4, n - 1]
    seen = set()
    out = []
    for i in idxs:
        s = segments[i]
        start = float(s.get("start", 0) or 0)
        if int(start) in seen:
            continue
        seen.add(int(start))
        out.append({
            "startSec": start,
            "endSec": float(s.get("end", 0) or 0),
            "title": "Highlight",
            "text": str(s.get("text", "") or "").strip(),
        })
        if len(out) >= max_highlights:
            break
    return out

def _parse_json_array(raw: str):
    # Try direct JSON
    try:
        return json.loads(raw)
    except Exception:
        pass

    # Try extract JSON array from text
    m = re.search(r"\[[\s\S]*\]", raw)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None

def build_highlights_from_segments_llm(
    segments: List[Dict[str, Any]],
    max_highlights: int = 5
) -> List[Dict[str, Any]]:
    if not segments:
        return []

    prompt = _segments_to_prompt(segments, max_segments=200)

    raw = lmstudio_chat(
        [
            {"role": "system", "content": "You pick meaningful video highlights with timestamps."},
            {
                "role": "user",
                "content": (
                    "Given the list of transcript segments with timestamps, select the top highlights.\n\n"
                    "Return ONLY valid JSON array. Each item must be:\n"
                    "{\"startSec\": number, \"endSec\": number, \"title\": string, \"text\": string}\n\n"
                    f"Limit to {max_highlights} items.\n\n"
                    "Segments:\n"
                    f"{prompt}\n"
                ),
            },
        ],
        temperature=0.0,
        timeout_sec=180,
    ).strip()

    parsed = _parse_json_array(raw)
    if not isinstance(parsed, list):
        return _fallback_highlights(segments, max_highlights)

    out = []
    for h in parsed:
        try:
            out.append({
                "startSec": float(h.get("startSec", 0) or 0),
                "endSec": float(h.get("endSec", 0) or 0),
                "title": str(h.get("title", "Highlight") or "Highlight"),
                "text": str(h.get("text", "") or ""),
            })
        except Exception:
            continue

    return out[:max_highlights] if out else _fallback_highlights(segments, max_highlights)