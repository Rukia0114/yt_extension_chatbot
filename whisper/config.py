import os

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_CHUNK_SECONDS = float(os.getenv("WHISPER_CHUNK_SECONDS", "30"))
WHISPER_CHUNK_OVERLAP_SECONDS = float(os.getenv("WHISPER_CHUNK_OVERLAP_SECONDS", "1"))

DATABASE_URL = os.getenv("DATABASE_URL", "")
VIDEO_DIR = os.getenv("VIDEO_DIR", "/tmp/video")

LLM_BASE_URL = os.getenv("LLM_BASE_URL", "")
LLM_MODEL = os.getenv("LLM_MODEL", "openai/gpt-oss-20b")