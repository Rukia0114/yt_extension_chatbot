import os
import json
import redis

REDIS_URL = os.getenv("REDIS_URL", "")
REDIS_TTL = 86400  # 24h

def get_redis():
    if not REDIS_URL:
        return None
    try:
        r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
        r.ping()
        return r
    except Exception:
        return None

def cache_get_json(r, key):
    if not r:
        return None
    try:
        raw = r.get(key)
        return json.loads(raw) if raw else None
    except Exception:
        return None

def cache_set_json(r, key, value, ttl=REDIS_TTL):
    if not r:
        return
    try:
        r.setex(key, ttl, json.dumps(value))
    except Exception:
        pass