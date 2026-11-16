globalThis.Api = (() => {
    const BACKEND_URL = "http://localhost:3000";
  
    let _cachedConfig = null;
    let _cachedAt = 0;
  
    async function getBackend() {
      return BACKEND_URL;
    }
  
    async function fetchExtConfig(force = false) {
      const now = Date.now();
      const cacheMs = 60_000;
  
      if (!force && _cachedConfig && now - _cachedAt < cacheMs) {
        return _cachedConfig;
      }
  
      const backend = await getBackend();
      const resp = await fetch(`${backend}/api/ext/config`, { method: "GET" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  
      _cachedConfig = {
        botUsername: String(data.botUsername || "").trim().replace(/^@/, ""),
      };
      _cachedAt = now;
      return _cachedConfig;
    }
  
    async function fetchHealth() {
      const backend = await getBackend();
      const resp = await fetch(`${backend}/health`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return true;
    }
  
    async function fetchPairStatus(deviceId) {
      const backend = await getBackend();
      const resp = await fetch(`${backend}/api/ext/pair/status?deviceId=${encodeURIComponent(deviceId)}`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      return data;
    }
  
    async function startPair(deviceId) {
      const backend = await getBackend();
      const resp = await fetch(`${backend}/api/ext/pair/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || "Failed");
      return data;
    }

    
  
    async function postWatchUpdate(deviceId, payload) {
      const backend = await getBackend();
      const resp = await fetch(`${backend}/api/ext/events/watch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, ...payload }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
    }
  
    async function requestSummary(deviceId, videoId, url) {
      const backend = await getBackend();
      const resp = await fetch(
        `${backend}/api/ext/video/${encodeURIComponent(videoId)}/summary?deviceId=${encodeURIComponent(deviceId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        }
      );
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      return true;
    }

    async function saveVideoToWatchlist(deviceId, videoId) {
      const backend = await getBackend();
      const resp = await fetch(
        `${backend}/api/ext/video/${encodeURIComponent(videoId)}/save?deviceId=${encodeURIComponent(deviceId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      return data;
    }
  
    async function fetchVideoSummary(deviceId, videoId) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/video/${encodeURIComponent(videoId)}?deviceId=${encodeURIComponent(deviceId)}`
        );
        const data = await resp.json().catch(() => ({}));
        
        // Handle 404 as "no data yet" - return empty data instead of throwing
        if (resp.status === 404) {
          return { summary: null, highlights: [], videoId };
        }
        
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
      }

    async function requestTranscribe(deviceId, videoId, url) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/video/${encodeURIComponent(videoId)}/transcribe?deviceId=${encodeURIComponent(deviceId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          }
        );
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${resp.status}`);
        }
        return await resp.json().catch(() => ({}));
      }

      async function fetchTranscribeStatus(deviceId, videoId) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/video/${encodeURIComponent(videoId)}/transcribe/status?deviceId=${encodeURIComponent(deviceId)}`
        );
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
      }

      async function sendChatMessage(deviceId, videoId, message) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/chat/send?deviceId=${encodeURIComponent(deviceId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId, message }),
          }
        );
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
      }

      async function sendChatMessageStream(deviceId, videoId, message, handlers = {}) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/chat/send/stream?deviceId=${encodeURIComponent(deviceId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId, message }),
          }
        );

        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${resp.status}`);
        }
        if (!resp.body) return { reply: "", mode: "" };

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalData = { reply: "", mode: "" };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          while (true) {
            const newlineIdx = buffer.indexOf("\n");
            if (newlineIdx === -1) break;
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;

            let parsed;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }

            if (parsed.type === "chunk" && typeof handlers.onChunk === "function") {
              await handlers.onChunk(String(parsed.delta || ""));
            } else if (parsed.type === "done") {
              finalData = {
                reply: String(parsed.reply || ""),
                mode: String(parsed.mode || ""),
              };
            } else if (parsed.type === "error") {
              throw new Error(parsed.error || "Stream failed");
            }
          }
        }

        return finalData;
      }
      
      async function fetchChatHistory(deviceId, videoId, limit = 40) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/chat/history?deviceId=${encodeURIComponent(deviceId)}&videoId=${encodeURIComponent(videoId)}&limit=${limit}`
        );
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
      }

      async function clearChatHistory(deviceId, videoId) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/chat/history?deviceId=${encodeURIComponent(deviceId)}&videoId=${encodeURIComponent(videoId)}`,
          { method: "DELETE" }
        );
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
      }

      async function fetchChatMode(deviceId, videoId) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/chat/mode?deviceId=${encodeURIComponent(deviceId)}&videoId=${encodeURIComponent(videoId)}`
        );
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
      }

      async function saveChatMode(deviceId, videoId, mode) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/chat/mode?deviceId=${encodeURIComponent(deviceId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId, mode }),
          }
        );
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
      }

      async function pollProactiveMessages(deviceId, videoId) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/proactive/poll?deviceId=${encodeURIComponent(deviceId)}&videoId=${encodeURIComponent(videoId)}`
        );
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
      }

      async function sendProactiveFeedback(deviceId, payload) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/proactive/feedback?deviceId=${encodeURIComponent(deviceId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload || {}),
          }
        );
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
      }

      async function fetchProactiveSettings(deviceId) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/proactive/settings?deviceId=${encodeURIComponent(deviceId)}`
        );
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
      }

      async function saveProactiveSettings(deviceId, mode) {
        const backend = await getBackend();
        const resp = await fetch(
          `${backend}/api/ext/proactive/settings?deviceId=${encodeURIComponent(deviceId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode }),
          }
        );
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
      }
  
    return {
      getBackend,
      fetchExtConfig,
      fetchHealth,
      fetchPairStatus,
      startPair,
      postWatchUpdate,
      requestSummary,
      saveVideoToWatchlist,
      fetchVideoSummary,
      requestTranscribe,
      fetchTranscribeStatus,
      sendChatMessage,
      sendChatMessageStream,
      fetchChatHistory,
      clearChatHistory,
      fetchChatMode,
      saveChatMode,
      pollProactiveMessages,
      sendProactiveFeedback,
      fetchProactiveSettings,
      saveProactiveSettings,
    };
  })();