const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

module.exports = {
  redis,
  
  // Session management (TTL: 1 hour)
  async setSession(userId, data, ttl = 3600) {
    await redis.setex(`session:${userId}`, ttl, JSON.stringify(data));
  },
  
  async getSession(userId) {
    const data = await redis.get(`session:${userId}`);
    return data ? JSON.parse(data) : null;
  },
  
  async updateSession(userId, updates) {
    const session = await this.getSession(userId) || {};
    Object.assign(session, updates);
    await this.setSession(userId, session);
  },
  
  async deleteSession(userId) {
    await redis.del(`session:${userId}`);
  },
  
  async extendSession(userId, ttl = 3600) {
    await redis.expire(`session:${userId}`, ttl);
  },
  
  // Cache video metadata (TTL: 24 hours)
  async cacheVideo(videoId, data, ttl = 86400) {
    await redis.setex(`video:${videoId}`, ttl, JSON.stringify(data));
  },
  
  async getCachedVideo(videoId) {
    const data = await redis.get(`video:${videoId}`);
    return data ? JSON.parse(data) : null;
  },
  
  async invalidateVideoCache(videoId) {
    await redis.del(`video:${videoId}`);
  },
  
  // Conversation context (last N messages for LLM)
  async addToContext(userId, videoId, message, response) {
    const key = `context:${userId}:${videoId}`;
    const contextItem = {
      message,
      response,
      timestamp: Date.now(),
    };
    await redis.lpush(key, JSON.stringify(contextItem));
    await redis.ltrim(key, 0, 39); // Keep last 40 messages
    await redis.expire(key, 7200); // Expire after 2 hours
  },
  
  async getContext(userId, videoId) {
    const key = `context:${userId}:${videoId}`;
    const data = await redis.lrange(key, 0, -1);
    return data.map(item => JSON.parse(item)).reverse(); // Return in chronological order
  },
  
  async clearContext(userId, videoId) {
    const key = `context:${userId}:${videoId}`;
    await redis.del(key);
  },

  async clearAllContext(userId) {
    const pattern = `context:${userId}:*`;
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = String(nextCursor || "0");
      if (Array.isArray(keys) && keys.length) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  },
  
  // Rate limiting
  async checkRateLimit(userId, limit = 20, window = 60) {
    const key = `ratelimit:${userId}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, window);
    }
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetIn: await redis.ttl(key),
    };
  },
  
  // Temporary data storage
  async setTemp(userId, key, data, ttl = 300) {
    await redis.setex(`temp:${userId}:${key}`, ttl, JSON.stringify(data));
  },
  
  async getTemp(userId, key) {
    const data = await redis.get(`temp:${userId}:${key}`);
    return data ? JSON.parse(data) : null;
  },
  
  async deleteTemp(userId, key) {
    await redis.del(`temp:${userId}:${key}`);
  },
  
  // Close connection
  async close() {
    await redis.quit();
  },
};