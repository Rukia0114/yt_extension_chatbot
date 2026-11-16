# services/llm.py
import json
import urllib.request
from fastapi import HTTPException
from config import LLM_BASE_URL, LLM_MODEL

def lmstudio_chat(messages: list, temperature: float = 0.3, timeout_sec: int = 180) -> str:
    if not LLM_BASE_URL:
        raise HTTPException(status_code=500, detail="LLM_BASE_URL is not set")

    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }

    req = urllib.request.Request(
        f"{LLM_BASE_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
        return (
            data.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        ) or ""
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM call failed: {e}")