-- Users table
CREATE TABLE IF NOT EXISTS users (
    user_id BIGINT PRIMARY KEY,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    language_code VARCHAR(10),
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Videos table
CREATE TABLE IF NOT EXISTS videos (
    video_id VARCHAR(20) PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    description TEXT,
    duration INTEGER,
    thumbnail_url TEXT,
    channel_name VARCHAR(255),
    channel_id VARCHAR(255),
    transcript TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- User videos (watchlist)
CREATE TABLE IF NOT EXISTS user_videos (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    video_id VARCHAR(20) REFERENCES videos(video_id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT false,
    UNIQUE(user_id, video_id)
);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    video_id VARCHAR(20) REFERENCES videos(video_id) ON DELETE CASCADE,
    message_text TEXT NOT NULL,
    bot_response TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS extension_devices (
  device_id TEXT PRIMARY KEY,
  user_id   BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_user_videos_user ON user_videos(user_id);
CREATE INDEX IF NOT EXISTS idx_user_videos_active ON user_videos(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_video ON conversations(video_id);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extension_devices_user_id ON extension_devices(user_id);