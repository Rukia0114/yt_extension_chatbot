from fastapi import FastAPI
from routes.health import router as health_router
from routes.transcribe import router as transcribe_router
from routes.summary import router as summary_router
from routes.highlights import router as highlights_router
from routes.analyze import router as analyze_router

app = FastAPI()
app.include_router(health_router)
app.include_router(transcribe_router)
app.include_router(summary_router)
app.include_router(highlights_router)
app.include_router(analyze_router)