const ChatWindowVideo = (() => {
  const {
    Api,
    Storage,
    state,
    setText,
    setLink,
    parseYouTubeVideoId,
  } = ChatWindowCore;

  function renderVideo(video) {
    if (!video) {
      setText("videoTitle", "No active YouTube video");
      setText("videoMeta", "");
      setLink("videoUrl", "", "");
      return;
    }

    setText("videoTitle", video.title || "(no title)");
    setText("videoMeta", `videoId: ${video.videoId}`);
    setLink("videoUrl", video.url, video.url);
  }

  async function getActiveYouTubeTab() {
    try {
      const win = await chrome.windows.getLastFocused({
        populate: true,
        windowTypes: ["normal"],
      });
  
      const tab = win?.tabs?.find((item) => item.active);
      const videoId = parseYouTubeVideoId(tab?.url || "");
      if (tab?.id && videoId) {
        return { tab, videoId };
      }
    } catch {
      // ignore and continue to broader fallback
    }
  
    try {
      const wins = await chrome.windows.getAll({
        populate: true,
        windowTypes: ["normal"],
      });
  
      for (const win of wins) {
        const tab = win.tabs?.find((item) => item.active);
        const videoId = parseYouTubeVideoId(tab?.url || "");
        if (tab?.id && videoId) {
          return { tab, videoId };
        }
      }
    } catch {
      // ignore
    }
  
    return null;
  }

  async function getBoundTabVideo() {
    if (!state.tabId) return null;

    let tab;
    try {
      tab = await chrome.tabs.get(state.tabId);
    } catch {
      return null;
    }

    const fallbackVideoId = parseYouTubeVideoId(tab?.url || "");
    if (!tab?.id || !fallbackVideoId) return null;

    const fromContent = await new Promise((resolve) => {
      chrome.tabs.sendMessage(state.tabId, { type: "GET_WATCH_STATE" }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(resp || null);
      });
    });

    if (fromContent?.provider === "youtube" && fromContent?.videoId && fromContent?.url) {
      return fromContent;
    }

    return {
      provider: "youtube",
      videoId: fallbackVideoId,
      url: tab.url,
      title: tab.title || "",
      currentTime: 0,
      duration: 0,
      paused: true,
    };
  }

  async function syncWatchState(video) {
    const deviceId = await Storage.getDeviceId();
    await Api.postWatchUpdate(deviceId, video);
  }

  async function focusBoundTab() {
    if (!state.tabId) return;

    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (!tab?.windowId) return;
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(state.tabId, { active: true });
    } catch (e) {
      setText("windowStatus", `Cannot focus tab: ${e.message}`);
    }
  }

  return {
    renderVideo,
    getActiveYouTubeTab,
    getBoundTabVideo,
    syncWatchState,
    focusBoundTab,
  };
})();