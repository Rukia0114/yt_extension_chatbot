const redis = require('../services/redis');
const db = require('../services/database');

const sessionManager = {
  async init(userId) {
    let session = await redis.getSession(userId);
    if (!session) {
      session = {
        currentVideoId: null,
        currentVideoSource: null,
        tempData: {},
        lastActivity: Date.now(),
      };
      await redis.setSession(userId, session);
    }
    if (!Object.prototype.hasOwnProperty.call(session, "currentVideoSource")) {
      session.currentVideoSource = null;
      await redis.setSession(userId, session);
    }
    return session;
  },
  
  async get(userId) {
    const session = await this.init(userId);
    // Update last activity
    session.lastActivity = Date.now();
    await redis.updateSession(userId, { lastActivity: session.lastActivity });
    return session;
  },
  
  async addVideoLink(userId, videoUrl, userData = null, videoData = null) {
    // Extract video ID from URL
    const videoIdMatch = videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (!videoIdMatch) return null;
  
    const videoId = videoIdMatch[1];
  
    // Create/update user first if userData is provided
    if (userData) {
      await db.createOrUpdateUser(userId, userData);
    } else {
      // Try to get user, if not exists, create with minimal data
      const existingUser = await db.getUser(userId);
      if (!existingUser) {
        await db.createOrUpdateUser(userId, {
          username: null,
          first_name: null,
          last_name: null,
          language_code: null,
        });
      }
    }
  
    // Ensure video exists in database
    const existingVideo = await db.videoExists(videoId);
    if (!existingVideo) {
      // Create video with minimal data (you can fetch full metadata later)
      await db.saveVideo(videoId, {
        url: videoUrl,
        title: videoData?.title || null,
        description: null,
        duration: null,
        thumbnail_url: null,
        channel_name: null,
        channel_id: null,
        transcript: null,
        metadata: {},
      });
    } else if (videoData?.title) {
      await db.updateVideoTitle(videoId, videoData.title);
    }
  
    const session = await this.get(userId);
    session.currentVideoId = videoId;
    session.currentVideoSource = "watchlist";
  
    // clear unsaved current video after saving
    if (session.tempData) session.tempData.currentVideo = null;
  
    await redis.setSession(userId, session);
    await db.addToWatchlist(userId, videoId, true);
    session.currentVideoId = videoId;
    await redis.setSession(userId, session);
    return videoId;
  },
  
  async getCurrentVideoId(userId) {
    const session = await this.get(userId);
    return session.currentVideoId;
  },
  
  async setCurrentVideo(userId, videoId) {
    const session = await this.get(userId);
    session.currentVideoId = videoId;
    session.currentVideoSource = "watchlist";
    await redis.setSession(userId, session);
    await db.setActiveVideo(userId, videoId);
    return videoId;
  },
  
  async removeVideo(userId, videoId) {
    await db.removeFromWatchlist(userId, videoId);
    const session = await this.get(userId);
    if (session.currentVideoId === videoId) {
      session.currentVideoId = null;
      if (session.currentVideoSource === "watchlist") {
        session.currentVideoSource = session.tempData?.currentVideo?.videoId ? "session" : null;
      }
      await redis.setSession(userId, session);
    }
  },
  
  async clear(userId) {
    await db.clearWatchlist(userId);
    await redis.deleteSession(userId);
    await redis.clearAllContext(userId);
  },
  
  async addMessage(userId, message) {
    // Store in Redis context if there's an active video
    const session = await this.get(userId);
    if (session.currentVideoId) {
      // This will be used when bot responds
      await redis.setTemp(userId, 'last_message', message, 300);
    }
  },
  
  async getMessages(userId) {
    // Get from database conversations
    const session = await this.get(userId);
    if (session.currentVideoId) {
      return await db.getConversationHistory(userId, session.currentVideoId);
    }
    return [];
  },
  async getVideos(userId) {
    return await db.getWatchlist(userId);
  },
  
  async getCurrentVideoIndex(userId) {
    const videos = await db.getWatchlist(userId);
    const currentVideoId = await this.getCurrentVideoId(userId);
    
    if (!currentVideoId) return null;
    
    const index = videos.findIndex(v => v.video_id === currentVideoId);
    return index >= 0 ? index : null;
  },
  
  async getCurrentVideo(userId) {
    const session = await this.get(userId);
    if (session.currentVideoId) {
      // Try cache first
      let video = await redis.getCachedVideo(session.currentVideoId);
      if (!video) {
        // Get from database
        video = await db.getVideo(session.currentVideoId);
        if (video) {
          // Cache it
          await redis.cacheVideo(session.currentVideoId, video);
        }
      }
      return video;
    }
    return null;
  },

  async setTempCurrentVideo(userId, payload) {
    const session = await this.get(userId);
    session.tempData = session.tempData || {};
    session.currentVideoSource = "session";

    session.tempData.currentVideo = {
      provider: payload.provider || "youtube",
      videoId: payload.videoId,
      url: payload.url,
      title: payload.title || null,
      currentTime: Number(payload.currentTime || 0),
      duration: Number(payload.duration || 0),
      paused: !!payload.paused,
      at: Date.now(),
    };

    await redis.setSession(userId, session);
    return session.tempData.currentVideo;
  },

  async getCurrentVideoSource(userId) {
    const session = await this.get(userId);
    const hasWatchlistVideo = !!session.currentVideoId;
    const hasTempVideo = !!session.tempData?.currentVideo?.videoId && !!session.tempData?.currentVideo?.url;

    if (session.currentVideoSource === "session" && hasTempVideo) return "session";
    if (session.currentVideoSource === "watchlist" && hasWatchlistVideo) return "watchlist";
    if (hasWatchlistVideo) return "watchlist";
    if (hasTempVideo) return "session";
    return null;
  },

  async getAvailableVideoSources(userId) {
    const session = await this.get(userId);
    return {
      active: await this.getCurrentVideoSource(userId),
      hasWatchlist: !!session.currentVideoId,
      hasSession: !!session.tempData?.currentVideo?.videoId && !!session.tempData?.currentVideo?.url,
      watchlistVideoId: session.currentVideoId || null,
      sessionVideoId: session.tempData?.currentVideo?.videoId || null,
    };
  },

  async switchCurrentVideoSource(userId, source) {
    const normalized = String(source || "").trim().toLowerCase();
    if (!["watchlist", "session"].includes(normalized)) {
      return { ok: false, error: "Unknown source. Use watchlist or session." };
    }

    const session = await this.get(userId);
    const hasWatchlistVideo = !!session.currentVideoId;
    const hasTempVideo = !!session.tempData?.currentVideo?.videoId && !!session.tempData?.currentVideo?.url;

    if (normalized === "watchlist" && !hasWatchlistVideo) {
      return { ok: false, error: "No saved watchlist video is available to switch to." };
    }
    if (normalized === "session" && !hasTempVideo) {
      return { ok: false, error: "No temporary synced or pasted video is available to switch to." };
    }

    session.currentVideoSource = normalized;
    await redis.setSession(userId, session);
    return { ok: true, source: normalized };
  },

  async getCurrentVideo(userId) {
    const source = await this.getCurrentVideoSource(userId);
    const session = await this.get(userId);

    if (source === "watchlist" && session.currentVideoId) {
      let video = await redis.getCachedVideo(session.currentVideoId);
      if (!video) {
        video = await db.getVideo(session.currentVideoId);
        if (video) await redis.cacheVideo(session.currentVideoId, video);
      }
      return video;
    }

    const v = session.tempData?.currentVideo;
    if (v?.videoId && v?.url) {
      return {
        video_id: v.videoId,
        url: v.url,
        title: v.title,
        transcript: null,
        metadata: {
          source: "session",
          lastWatch: {
            currentTime: v.currentTime,
            duration: v.duration,
            paused: v.paused,
            at: new Date(v.at).toISOString(),
          },
        },
      };
    }

    return null;
  },


};



module.exports = sessionManager;