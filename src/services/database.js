const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Test connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('PostgreSQL connection error:', err);
});

module.exports = {
  pool,
  
  // User operations
  async createOrUpdateUser(userId, userData) {
    const { username, first_name, last_name, language_code } = userData;
    await pool.query(
      `INSERT INTO users (user_id, username, first_name, last_name, language_code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         language_code = EXCLUDED.language_code,
         updated_at = NOW()`,
      [userId, username, first_name, last_name, language_code]
    );
  },
  
  async getUser(userId) {
    const result = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    return result.rows[0];
  },
  
  // Video operations
  async saveVideo(videoId, data) {
    const { url, title, description, duration, thumbnail_url, channel_name, channel_id, transcript, metadata } = data;
    await pool.query(
      `INSERT INTO videos (video_id, url, title, description, duration, thumbnail_url, channel_name, channel_id, transcript, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (video_id) DO UPDATE SET
         title = COALESCE(EXCLUDED.title, videos.title),
         description = COALESCE(EXCLUDED.description, videos.description),
         duration = COALESCE(EXCLUDED.duration, videos.duration),
         thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, videos.thumbnail_url),
         channel_name = COALESCE(EXCLUDED.channel_name, videos.channel_name),
         channel_id = COALESCE(EXCLUDED.channel_id, videos.channel_id),
         transcript = COALESCE(EXCLUDED.transcript, videos.transcript),
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [videoId, url, title, description, duration, thumbnail_url, channel_name, channel_id, transcript, JSON.stringify(metadata || {})]
    );
  },
  
  async getVideo(videoId) {
    const result = await pool.query('SELECT * FROM videos WHERE video_id = $1', [videoId]);
    return result.rows[0];
  },
  
  async videoExists(videoId) {
    const result = await pool.query('SELECT 1 FROM videos WHERE video_id = $1', [videoId]);
    return result.rows.length > 0;
  },
  
  // User watchlist operations
  async addToWatchlist(userId, videoId, setActive = true) {
    // First, set all user videos to inactive if setting active
    if (setActive) {
      await pool.query(
        'UPDATE user_videos SET is_active = false WHERE user_id = $1',
        [userId]
      );
    }
    
    // Add or update the video
    await pool.query(
      `INSERT INTO user_videos (user_id, video_id, is_active)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, video_id) DO UPDATE SET
         is_active = EXCLUDED.is_active,
         added_at = CASE WHEN user_videos.added_at IS NULL THEN NOW() ELSE user_videos.added_at END`,
      [userId, videoId, setActive]
    );
  },
  
  async getWatchlist(userId) {
    const result = await pool.query(
      `SELECT v.*, uv.added_at, uv.is_active
       FROM videos v
       JOIN user_videos uv ON v.video_id = uv.video_id
       WHERE uv.user_id = $1
       ORDER BY uv.added_at DESC`,
      [userId]
    );
    return result.rows;
  },
  
  async getActiveVideo(userId) {
    const result = await pool.query(
      `SELECT v.*, uv.added_at
       FROM videos v
       JOIN user_videos uv ON v.video_id = uv.video_id
       WHERE uv.user_id = $1 AND uv.is_active = true
       LIMIT 1`,
      [userId]
    );
    return result.rows[0] || null;
  },
  
  async setActiveVideo(userId, videoId) {
    // Set all to inactive first
    await pool.query(
      'UPDATE user_videos SET is_active = false WHERE user_id = $1',
      [userId]
    );
    
    // Set the selected one as active
    await pool.query(
      `UPDATE user_videos SET is_active = true
       WHERE user_id = $1 AND video_id = $2`,
      [userId, videoId]
    );
  },
  
  async removeFromWatchlist(userId, videoId) {
    await pool.query(
      'DELETE FROM user_videos WHERE user_id = $1 AND video_id = $2',
      [userId, videoId]
    );
  },
  
  async clearWatchlist(userId) {
    await pool.query(
      'DELETE FROM user_videos WHERE user_id = $1',
      [userId]
    );
  },
  
  // Conversation operations
  async saveConversation(userId, videoId, userMessage, botResponse) {
    await pool.query(
      `INSERT INTO conversations (user_id, video_id, message_text, bot_response)
       VALUES ($1, $2, $3, $4)`,
      [userId, videoId, userMessage, botResponse]
    );
  },
  
  async getConversationHistory(userId, videoId, limit = 20) {
    const result = await pool.query(
      `SELECT message_text, bot_response, created_at
       FROM conversations
       WHERE user_id = $1 AND video_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [userId, videoId, limit]
    );
    return result.rows.reverse(); // Return in chronological order
  },
  
  async getRecentConversations(userId, limit = 10) {
    const result = await pool.query(
      `SELECT c.*, v.title as video_title, v.url as video_url
       FROM conversations c
       JOIN videos v ON c.video_id = v.video_id
       WHERE c.user_id = $1
       ORDER BY c.created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  },
  
  // User settings
  async getSettings(userId) {
    const result = await pool.query('SELECT settings FROM users WHERE user_id = $1', [userId]);
    return result.rows[0]?.settings || {};
  },
  
  async updateSettings(userId, settings) {
    await pool.query(
      `INSERT INTO users (user_id, settings) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         settings = EXCLUDED.settings,
         updated_at = NOW()`,
      [userId, JSON.stringify(settings)]
    );
  },
  
async linkDeviceToUser(deviceId, userId) {
  await pool.query(
    `INSERT INTO extension_devices (device_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (device_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       updated_at = NOW()`,
    [deviceId, userId]
  );
},

async getUserIdByDeviceId(deviceId) {
  const result = await pool.query(
    `SELECT user_id FROM extension_devices WHERE device_id = $1 LIMIT 1`,
    [deviceId]
  );
  return result.rows[0]?.user_id ?? null;
},

async deleteUserConversations(userId, videoId) {
  await pool.query(
    "DELETE FROM conversations WHERE user_id = $1 AND video_id = $2",
    [userId, videoId]
  );
},

async deleteAllUserConversations(userId) {
  await pool.query("DELETE FROM conversations WHERE user_id = $1", [userId]);
},

async countVideoWatchers(videoId) {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS c FROM user_videos WHERE video_id = $1",
    [videoId]
  );
  return result.rows[0]?.c ?? 0;
},

async updateVideoMetadata(videoId, patch) {
  await pool.query(
    `UPDATE videos
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE video_id = $1`,
    [videoId, JSON.stringify(patch || {})]
  );
},

async updateVideoTranscript(videoId, transcript) {
  await pool.query(
    `UPDATE videos
     SET transcript = $2,
         updated_at = NOW()
     WHERE video_id = $1`,
    [videoId, transcript]
  );
},

async updateVideoTitle(videoId, title) {
  if (!title) return;
  await pool.query(
    `UPDATE videos
     SET title = COALESCE($2, title),
         updated_at = NOW()
     WHERE video_id = $1`,
    [videoId, title]
  );
},

async deleteVideo(videoId) {
  // Deletes transcript/metadata too because it deletes the row.
  // Only call this when countVideoWatchers(videoId) === 0.
  await pool.query("DELETE FROM videos WHERE video_id = $1", [videoId]);
},
  // Close connection (for graceful shutdown)
  async close() {
    await pool.end();
  },
};

