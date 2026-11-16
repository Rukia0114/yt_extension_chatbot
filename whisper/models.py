from typing import Optional
from pydantic import BaseModel

class YouTubeReq(BaseModel):
    url: str
    video_id: Optional[str] = None