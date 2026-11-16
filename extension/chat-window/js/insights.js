const ChatWindowInsights = (() => {
  const {
    Api,
    Storage,
    state,
    setText,
    renderStructuredText,
    markSectionUnread,
    notifyUser,
  } = ChatWindowCore;
  let isRegenerating = false;
  let isSavingToWatchlist = false;
  let canSaveToWatchlist = true;
  const AUTO_BOOTSTRAP_COOLDOWN_MS = 90 * 1000;
  const LINK_STATUS_CACHE_MS = 10 * 1000;
  const TRANSCRIBE_KICKOFF_COOLDOWN_MS = 20 * 1000;
  const SUMMARY_KICKOFF_COOLDOWN_MS = 15 * 1000;
  const autoBootstrapAtByVideo = new Map();
  const transcriptReadyNotifiedAtByVideo = new Map();
  const transcribeKickoffAtByVideo = new Map();
  const summaryKickoffAtByVideo = new Map();
  const linkStatusCache = {
    deviceId: "",
    linked: null,
    checkedAt: 0,
  };

  function setTranscriptStatus(text) {
    setText("transcriptStatus", text || "");
  }

  function clampPercent(value, min = 0, max = 100) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  function estimateInsightsProgress(status, attempt = 1) {
    const safeAttempt = Math.max(1, Number(attempt || 1));
    const transcriptReady = !!(status?.transcriptReady || status?.done || status?.processing === false);

    if (transcriptReady) {
      // Transcript is ready; remaining time is mostly summarize/highlight generation.
      const summaryPct = clampPercent(86 + (safeAttempt - 1) * 2, 86, 98);
      const highlightsPct = clampPercent(summaryPct - 2, 84, 97);
      return { summaryPct, highlightsPct };
    }

    const transcriptPct = clampPercent(Number(status?.progress || 0) * 100, 0, 100);
    // While transcript is still running, show staged insight progress (up to mid-80s).
    const summaryPct = clampPercent(Math.max(10, transcriptPct * 0.85), 10, 85);
    const highlightsPct = clampPercent(summaryPct - 4, 8, 82);
    return { summaryPct, highlightsPct };
  }

  function applyInsightsProgressStatus(status, attempt = 1) {
    const { summaryPct, highlightsPct } = estimateInsightsProgress(status, attempt);
    setText("summaryStatus", `Generating summary... ${summaryPct}%`);
    setText("highlightsStatus", `Generating highlights... ${highlightsPct}%`);
  }

  function formatTranscribeProgress(status) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(status?.progress || 0) * 100)));
    if (status?.transcriptReady || status?.done || status?.processing === false) {
      return "Transcript status: 100% (full transcript prepared).";
    }
    return `Transcript status: ${pct}% (partial transcript can be used for chat).`;
  }

  async function applyTranscribeStatus(video, status) {
    if (!video?.videoId || !status) return;
    setTranscriptStatus(formatTranscribeProgress(status));
    if (!(status?.transcriptReady || status?.done || status?.processing === false)) return;

    const now = Date.now();
    const lastNotifiedAt = Number(transcriptReadyNotifiedAtByVideo.get(video.videoId) || 0);
    if (now - lastNotifiedAt <= 60 * 1000) return;

    transcriptReadyNotifiedAtByVideo.set(video.videoId, now);
    await notifyUser({
      title: "Transcript ready",
      message: `Full transcript is prepared for ${video.title || "this video"}.`,
      kind: "success",
      dedupeKey: `transcript-ready:${video.videoId}`,
    });
  }

  function shouldAutoBootstrap(videoId) {
    const id = String(videoId || "");
    if (!id) return false;
    const now = Date.now();
    const lastAt = Number(autoBootstrapAtByVideo.get(id) || 0);
    if (now - lastAt < AUTO_BOOTSTRAP_COOLDOWN_MS) return false;
    autoBootstrapAtByVideo.set(id, now);
    return true;
  }

  function shouldKickoffWithCooldown(cache, key, cooldownMs) {
    const id = String(key || "");
    if (!id) return false;
    const now = Date.now();
    const lastAt = Number(cache.get(id) || 0);
    if (now - lastAt < cooldownMs) return false;
    cache.set(id, now);
    return true;
  }

  async function requestSummaryInBackground(deviceId, video) {
    if (!video?.videoId || !video?.url) return false;
    if (!shouldKickoffWithCooldown(summaryKickoffAtByVideo, video.videoId, SUMMARY_KICKOFF_COOLDOWN_MS)) {
      return false;
    }
    Api.requestSummary(deviceId, video.videoId, video.url).catch(() => {});
    return true;
  }

  async function ensureInsightsPipelineStarted(video, { forceTranscribe = false, skipWatchUpdate = false } = {}) {
    if (!video?.videoId || !video?.url) return false;
    const deviceId = await Storage.getDeviceId();
    if (!skipWatchUpdate) {
      await Api.postWatchUpdate(deviceId, video);
    }

    let status = null;
    try {
      status = await Api.fetchTranscribeStatus(deviceId, video.videoId);
      await applyTranscribeStatus(video, status);
    } catch {
      status = null;
    }

    const transcriptReady = !!(status?.transcriptReady || status?.done || status?.processing === false);
    const processing = !!status?.processing;
    const progress = Number(status?.progress || 0);
    const shouldStartTranscribe =
      forceTranscribe ||
      !status ||
      (!transcriptReady && !processing && progress <= 0);

    if (
      shouldStartTranscribe &&
      shouldKickoffWithCooldown(transcribeKickoffAtByVideo, video.videoId, TRANSCRIBE_KICKOFF_COOLDOWN_MS)
    ) {
      try {
        const transcribe = await Api.requestTranscribe(deviceId, video.videoId, video.url);
        await applyTranscribeStatus(video, transcribe);
      } catch {
        // Keep polling loop alive even if kickoff fails once.
      }
    }

    await requestSummaryInBackground(deviceId, video);
    return true;
  }

  async function ensureInsightsBootstrap(video) {
    if (!video?.videoId || !video?.url || !shouldAutoBootstrap(video.videoId)) return false;
    return await ensureInsightsPipelineStarted(video);
  }

  function setRegenerateButtonBusy(busy) {
    const btn = document.getElementById("regenerateInsightsBtn");
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? "Regenerating..." : "Regenerate";
  }

  function setSaveButtonBusy(busy) {
    const btn = document.getElementById("saveToWatchlistBtn");
    if (!btn) return;
    if (busy) {
      btn.disabled = true;
      btn.textContent = "Saving...";
      return;
    }
    btn.disabled = !canSaveToWatchlist;
    btn.textContent = canSaveToWatchlist ? "Save to watchlist" : "Link Telegram to save";
    btn.title = canSaveToWatchlist
      ? ""
      : "Guest mode can use chat and insights, but watchlist save requires Telegram link.";
    setText(
      "guestModeHint",
      canSaveToWatchlist
        ? ""
        : "Guest mode active: chat + insights work. Link Telegram to enable watchlist save."
    );
  }

  async function refreshSaveAvailability(force = false) {
    const deviceId = await Storage.getDeviceId();
    const now = Date.now();
    const hasFreshCache =
      !force &&
      deviceId &&
      deviceId === linkStatusCache.deviceId &&
      typeof linkStatusCache.linked === "boolean" &&
      now - Number(linkStatusCache.checkedAt || 0) < LINK_STATUS_CACHE_MS;
    if (hasFreshCache) {
      canSaveToWatchlist = !!linkStatusCache.linked;
      setSaveButtonBusy(false);
      return canSaveToWatchlist;
    }

    try {
      const pair = await Api.fetchPairStatus(deviceId);
      const linked = !!pair?.linked;
      linkStatusCache.deviceId = deviceId;
      linkStatusCache.linked = linked;
      linkStatusCache.checkedAt = now;
      canSaveToWatchlist = linked;
    } catch {
      if (typeof linkStatusCache.linked === "boolean") {
        canSaveToWatchlist = !!linkStatusCache.linked;
      } else {
        canSaveToWatchlist = false;
      }
    }

    setSaveButtonBusy(false);
    return canSaveToWatchlist;
  }

  function clearInsightsUI() {
    setText("summaryText", "");
    setText("summaryStatus", "");
    setTranscriptStatus("");

    const hl = document.getElementById("highlightsList");
    if (hl) hl.innerHTML = "";

    setText("highlightsStatus", "");
  }

  function resetSummaryPolling() {
    if (state.summaryRetryTimer) {
      clearTimeout(state.summaryRetryTimer);
      state.summaryRetryTimer = null;
    }
  }

  function renderHighlights(videoUrl, highlights) {
    const root = document.getElementById("highlightsList");
    if (!root) return;

    root.innerHTML = "";

    if (!highlights || highlights.length === 0) {
      root.textContent = "No highlights yet.";
      return;
    }

    for (const h of highlights) {
      const start = Number(h.startSec ?? h.start ?? 0);
      const end = Number(h.endSec ?? h.end ?? 0);
      const link = `${videoUrl}&t=${Math.floor(start)}s`;

      const item = document.createElement("div");
      item.className = "topGap";

      const a = document.createElement("a");
      a.href = "#";
      a.textContent = `[${ChatWindowCore.fmtTime(start)}-${ChatWindowCore.fmtTime(end)}] ${h.title || "Highlight"}`;
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        if (!state.tabId) return;

        chrome.tabs.sendMessage(state.tabId, { type: "SEEK_TO", seconds: start }, (resp) => {
          if (chrome.runtime.lastError || !resp?.success) {
            chrome.tabs.update(state.tabId, { url: link });
          }
        });
      });

      const p = document.createElement("div");
      p.className = "muted topGap-xs";
      renderStructuredText(p, h.text || "");

      item.appendChild(a);
      if (h.text) item.appendChild(p);
      root.appendChild(item);
    }
  }

  function scheduleSummaryRetry(videoId, attempt = 1) {
    const maxAttempts = 20;
    const delayMs = 3000;
    if (attempt > maxAttempts) return;

    resetSummaryPolling();
    state.summaryRetryTimer = setTimeout(async () => {
      state.summaryRetryTimer = null;
      if (!state.currentVideo || state.currentVideo.videoId !== videoId) return;
      await loadSummaryAndHighlights(state.currentVideo, attempt + 1);
    }, delayMs);
  }

  async function syncTranscribeProgress(videoId) {
    const deviceId = await Storage.getDeviceId();
    return await Api.fetchTranscribeStatus(deviceId, videoId);
  }

  async function loadSummaryAndHighlights(video, attempt = 1, options = {}) {
    const allowBootstrap = options?.allowBootstrap !== false;
    if (!video?.videoId) {
      clearInsightsUI();
      return;
    }

    try {
      await refreshSaveAvailability(false);
      if (attempt > 1) {
        applyInsightsProgressStatus({ processing: true, transcriptReady: false, progress: 0 }, attempt);
      }
      if (attempt === 1) {
        setTranscriptStatus("Transcript status: 0% (checking...)");
      }

      setText("summaryText", "");
      const hl = document.getElementById("highlightsList");
      if (hl) hl.innerHTML = "";

      const deviceId = await Storage.getDeviceId();
      const data = await Api.fetchVideoSummary(deviceId, video.videoId);

      if (!data.summary && (!data.highlights || data.highlights.length === 0)) {
        if (attempt === 1 && allowBootstrap) {
          try {
            await ensureInsightsBootstrap(video);
          } catch {
            // Keep retry loop alive even if bootstrap call fails.
          }
        }
        try {
          const status = await syncTranscribeProgress(video.videoId);
          await applyTranscribeStatus(video, status);
          applyInsightsProgressStatus(status, attempt);
        } catch {
          // Ignore status polling failures and keep summary retry active.
          applyInsightsProgressStatus({ processing: false, transcriptReady: false, progress: 0 }, attempt);
        }
        scheduleSummaryRetry(video.videoId, attempt);
        return;
      }

      renderStructuredText(document.getElementById("summaryText"), data.summary || "No summary yet.");
      renderHighlights(video.url, data.highlights || []);
      setText("summaryStatus", "");
      setText("highlightsStatus", "");
      try {
        const status = await syncTranscribeProgress(video.videoId);
        await applyTranscribeStatus(video, status);
      } catch {
        setTranscriptStatus("Transcript status: Full transcript or latest draft is available.");
      }
      resetSummaryPolling();
      markSectionUnread("insights");
      await notifyUser({
        title: "Insights ready",
        message: `Summary and highlights are ready for ${video.title || "this video"}.`,
        kind: "success",
        dedupeKey: `insights-ready:${video.videoId}:${String(data.summary || "").length}:${(data.highlights || []).length}`,
      });
    } catch (e) {
      const msg = String(e.message || "");
      if (msg.includes("No summary available yet")) {
        applyInsightsProgressStatus({ processing: false, transcriptReady: true }, attempt);
        scheduleSummaryRetry(video.videoId, attempt);
        return;
      }

      setText("summaryStatus", `Failed to load: ${msg}`);
      setText("highlightsStatus", `Failed to load: ${msg}`);
    }
  }

  async function runVideoSync() {
    let video = state.currentVideo || (await ChatWindowVideo.getBoundTabVideo());
    // Try rebind to active YouTube tab when current binding is invalid
    if (!video) {
      const active = await ChatWindowVideo.getActiveYouTubeTab();
      if (active?.tab?.id) {
        state.tabId = active.tab.id;
        video = await ChatWindowVideo.getBoundTabVideo();
      }
    }
    if (!video) {
      setText("windowStatus", "No supported YouTube video detected.");
      clearInsightsUI();
      return;
    }
    
    state.currentVideo = video;
    ChatWindowVideo.renderVideo(video);
    await refreshSaveAvailability(false);

    try {
      setText("windowStatus", "");
      clearInsightsUI();
      setText("summaryStatus", "Processing summary...");
      setText("highlightsStatus", "Processing highlights...");
      resetSummaryPolling();

      const deviceId = await Storage.getDeviceId();
      await Api.postWatchUpdate(deviceId, video);

      let existingData;
      try {
        existingData = await Api.fetchVideoSummary(deviceId, video.videoId);
      } catch (e) {
        if (String(e.message || "").includes("404")) {
          existingData = { summary: null, highlights: [] };
        } else {
          throw e;
        }
      }

      if (!existingData.summary && (!existingData.highlights || existingData.highlights.length === 0)) {
        await ensureInsightsPipelineStarted(video, { skipWatchUpdate: true });
      }

      setText("summaryStatus", "Processing summary...");
      setText("highlightsStatus", "Processing highlights...");
      await loadSummaryAndHighlights(video, 1, { allowBootstrap: false });
    } catch (e) {
      const errorMsg = e.message || String(e);
      if (errorMsg.includes("Failed to fetch") || errorMsg.includes("NetworkError")) {
        setText("summaryStatus", "Cannot connect to backend server at http://localhost:3000");
        setText("highlightsStatus", "Cannot connect to backend server at http://localhost:3000");
      } else if (errorMsg.includes("401") || errorMsg.includes("not linked")) {
        setText("summaryStatus", "Device not linked for this action.");
        setText("highlightsStatus", "Device not linked for this action.");
      } else {
        setText("summaryStatus", `Failed to sync insights: ${errorMsg}`);
        setText("highlightsStatus", `Failed to sync insights: ${errorMsg}`);
      }
    }
  }

  async function regenerateInsights() {
    if (isRegenerating) return;
    let video = state.currentVideo || (await ChatWindowVideo.getBoundTabVideo());
    if (!video) {
      const active = await ChatWindowVideo.getActiveYouTubeTab();
      if (active?.tab?.id) {
        state.tabId = active.tab.id;
        video = await ChatWindowVideo.getBoundTabVideo();
      }
    }
    if (!video) {
      setText("windowStatus", "No supported YouTube video detected.");
      return;
    }

    isRegenerating = true;
    setRegenerateButtonBusy(true);
    state.currentVideo = video;

    try {
      setText("windowStatus", "");
      setText("summaryStatus", "Regenerating summary...");
      setText("highlightsStatus", "Regenerating highlights...");
      resetSummaryPolling();

      const deviceId = await Storage.getDeviceId();
      await Api.postWatchUpdate(deviceId, video);
      await ensureInsightsPipelineStarted(video, { forceTranscribe: true, skipWatchUpdate: true });
      await loadSummaryAndHighlights(video, 1, { allowBootstrap: false });
    } catch (e) {
      const msg = e.message || String(e);
      setText("summaryStatus", `Regenerate failed: ${msg}`);
      setText("highlightsStatus", `Regenerate failed: ${msg}`);
    } finally {
      isRegenerating = false;
      setRegenerateButtonBusy(false);
    }
  }

  async function saveToWatchlist() {
    if (isSavingToWatchlist) return;
    let video = state.currentVideo || (await ChatWindowVideo.getBoundTabVideo());
    if (!video) {
      const active = await ChatWindowVideo.getActiveYouTubeTab();
      if (active?.tab?.id) {
        state.tabId = active.tab.id;
        video = await ChatWindowVideo.getBoundTabVideo();
      }
    }
    if (!video?.videoId) {
      setText("windowStatus", "No supported YouTube video detected.");
      return;
    }

    isSavingToWatchlist = true;
    setSaveButtonBusy(true);
    state.currentVideo = video;

    try {
      const linked = await refreshSaveAvailability(true);
      if (!linked) {
        setText("windowStatus", "Link Telegram first to use Save to watchlist.");
        return;
      }
      setText("windowStatus", "Saving video to watchlist...");
      const deviceId = await Storage.getDeviceId();
      await Api.postWatchUpdate(deviceId, video);
      const result = await Api.saveVideoToWatchlist(deviceId, video.videoId);
      setText("windowStatus", result?.message || "Saved to watchlist.");
    } catch (e) {
      setText("windowStatus", `Save failed: ${e.message || String(e)}`);
    } finally {
      isSavingToWatchlist = false;
      setSaveButtonBusy(false);
    }
  }

  return {
    clearInsightsUI,
    resetSummaryPolling,
    loadSummaryAndHighlights,
    runVideoSync,
    regenerateInsights,
    saveToWatchlist,
    refreshSaveAvailability,
  };
})();
