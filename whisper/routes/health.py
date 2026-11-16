from fastapi import APIRouter
from config import WHISPER_MODEL

router = APIRouter()

@router.get("/health")
def health():
    return {"ok": True, "model": WHISPER_MODEL}