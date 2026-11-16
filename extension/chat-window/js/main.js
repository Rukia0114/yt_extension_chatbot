const ChatWindowMain = (() => {
  const {
    state,
    setText,
    setBadge,
    setChatEnabled,
    getTabIdFromQuery,
    clearAllSectionUnread,
  } = ChatWindowCore;

  async function syncBindingFromActiveTab() {
    if (!state.followActiveTab) return false;

    const active = await ChatWindowVideo.getActiveYouTubeTab();
    if (!active?.tab?.id) return false;

    const changed = state.tabId !== active.tab.id;
    state.tabId = active.tab.id;

    if (changed) {
      setText("windowStatus", "Bound to active YouTube tab.");
    }

    return true;
  }

  async function refreshWindowState() {
    // In side panel mode, always prefer the current active YouTube tab.
    await syncBindingFromActiveTab();

    let video = await ChatWindowVideo.getBoundTabVideo();

    // If current binding is invalid, try one more active-tab bind.
    if (!video) {
      const rebound = await syncBindingFromActiveTab();
      if (rebound) {
        video = await ChatWindowVideo.getBoundTabVideo();
      }
    }

    const previousVideoId = state.currentVideo?.videoId || null;
    state.currentVideo = video;
    ChatWindowVideo.renderVideo(video);

    if (!video) {
      ChatWindowInsights.resetSummaryPolling();
      setBadge("badge-bad", "No YouTube Tab");
      setText("windowStatus", "Open a YouTube video tab, then press Refresh.");
      setText("chatStatus", "");
      setChatEnabled(false);
      ChatWindowChat.resetEphemeralMessages();
      ChatWindowInsights.clearInsightsUI();
      ChatWindowChat.clearChat("This window works only with a YouTube watch tab.");
      return;
    }

    setBadge("badge-ok", "Bound");
    setText("windowStatus", "");
    setChatEnabled(true);

    try {
      await ChatWindowVideo.syncWatchState(video);
    } catch (e) {
      setText("windowStatus", `Sync warning: ${e.message}`);
    }

    if (previousVideoId !== video.videoId) {
      ChatWindowInsights.resetSummaryPolling();
      state.pendingJobs = [];
      state.serverItems = [];
      clearAllSectionUnread();
      ChatWindowChat.resetEphemeralMessages();
      ChatWindowInsights.clearInsightsUI();
      ChatWindowChat.clearChat("Loading conversation for this video...");
    }

    await Promise.all([
      ChatWindowInsights.loadSummaryAndHighlights(video, 1),
      ChatWindowChat.loadChatForCurrentVideo(),
      ChatWindowChat.pollProactiveForCurrentVideo(),
      ChatWindowChat.loadChatModeForCurrentVideo(),
      ChatWindowChat.loadProactiveModeSetting(),
    ]);
  }

  async function refreshAll() {
    await ChatWindowConnection.refreshConnectionState();
    await refreshWindowState();
  }

  function wireHandlers() {
    document.getElementById("refreshBtn")?.addEventListener("click", async () => {
      await refreshWindowState();
    });

    document.getElementById("refreshConnectionBtn")?.addEventListener("click", async () => {
      await refreshAll();
    });

    document.getElementById("syncBtn")?.addEventListener("click", async () => {
      await refreshWindowState();
      await ChatWindowInsights.runVideoSync();
    });

    document.getElementById("regenerateInsightsBtn")?.addEventListener("click", async () => {
      await refreshWindowState();
      await ChatWindowInsights.regenerateInsights();
    });

    document.getElementById("saveToWatchlistBtn")?.addEventListener("click", async () => {
      await refreshWindowState();
      await ChatWindowInsights.saveToWatchlist();
    });

    document.getElementById("focusTabBtn")?.addEventListener("click", async () => {
      await ChatWindowVideo.focusBoundTab();
    });

    document.getElementById("openBotBtn")?.addEventListener("click", async () => {
      await ChatWindowConnection.openBot();
    });

    document.getElementById("linkBtn")?.addEventListener("click", async () => {
      await ChatWindowConnection.generateLink();
    });

    document.getElementById("resetDeviceBtn")?.addEventListener("click", async () => {
      await ChatWindowConnection.resetDevice();
    });

    document.getElementById("clearLocalBtn")?.addEventListener("click", async () => {
      await ChatWindowConnection.clearLocalData();
    });

    document.getElementById("chatSendBtn")?.addEventListener("click", async () => {
      await refreshWindowState();
      await ChatWindowChat.sendMessage();
    });

    document.getElementById("chatInput")?.addEventListener("input", () => {
      ChatWindowChat.autoResizeInput();
    });



    document.getElementById("chatInput")?.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        await refreshWindowState();
        await ChatWindowChat.sendMessage();
      }
    });

    document.getElementById("clearChatBtn")?.addEventListener("click", async () => {
      await ChatWindowChat.clearCurrentVideoHistory();
    });
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      const previousVideoId = state.currentVideo?.videoId || null;

      await syncBindingFromActiveTab();
      const nextVideo = await ChatWindowVideo.getBoundTabVideo();
      const nextVideoId = nextVideo?.videoId || null;

      if (state.followActiveTab && state.tabId && state.currentVideo?.videoId !== nextVideoId) {
        state.currentVideo = nextVideo;
        await refreshWindowState();
        return;
      }

      if (previousVideoId !== nextVideoId) {
        state.currentVideo = nextVideo;
        await refreshWindowState();
        return;
      }

      if (!nextVideo && previousVideoId) {
        state.currentVideo = null;
        await refreshWindowState();
      }
    }, 2500);
  }

  function startProactivePolling() {
    if (state.proactivePollTimer) clearInterval(state.proactivePollTimer);
    state.proactivePollTimer = setInterval(async () => {
      await ChatWindowChat.pollProactiveForCurrentVideo();
    }, 2000);
  }

  async function init() {
    state.tabId = getTabIdFromQuery();
    state.followActiveTab = !state.tabId;

    ChatWindowTabs.wireTabs("chat");
    wireHandlers();
    ChatWindowChat.autoResizeInput();
    ChatWindowChat.wireChatModeControl();
    ChatWindowChat.wireProactiveModeControl();
    await ChatWindowChat.loadProactiveModeSetting();

    if (state.followActiveTab) {
      await syncBindingFromActiveTab();
    }

    if (!state.tabId) {
      setBadge("badge-bad", "No YouTube Tab");
      setText("windowStatus", "Open a YouTube video tab, then press Refresh.");
      setChatEnabled(false);
      ChatWindowInsights.clearInsightsUI();
      ChatWindowChat.clearChat("This window works only with a YouTube watch tab.");
      await ChatWindowConnection.refreshConnectionState();
      startPolling();
      startProactivePolling();
      return;
    }

    setBadge("badge-idle", "Checking...");
    await refreshAll();
    startPolling();
    startProactivePolling();
  }

  window.addEventListener("beforeunload", () => {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.proactivePollTimer) clearInterval(state.proactivePollTimer);
    ChatWindowInsights.resetSummaryPolling();
  });

  

  return {
    init,
    refreshAll,
    refreshWindowState,
  };
})();

(async () => {
  await ChatWindowMain.init();
})();