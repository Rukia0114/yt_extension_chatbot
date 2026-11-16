const ChatWindowConnection = (() => {
  const {
    Api,
    Storage,
    $,
    setText,
    setLink,
    setLinkedPill,
  } = ChatWindowCore;

  async function refreshConnectionState() {
    try {
      const backend = await Api.getBackend();
      setText("backendValue", backend);
    } catch (e) {
      setText("backendValue", `(failed to load: ${e.message})`);
    }

    try {
      const cfg = await Api.fetchExtConfig();
      setText("botUsernameValue", cfg.botUsername ? `@${cfg.botUsername}` : "(not set on server)");
    } catch (e) {
      setText("botUsernameValue", `(failed to load: ${e.message})`);
    }

    const deviceId = await Storage.getDeviceId();
    setText("deviceId", deviceId);

    try {
      const data = await Api.fetchPairStatus(deviceId);
      setLinkedPill(!!data.linked);
    } catch {
      const pill = $("linkedPill");
      if (pill) {
        pill.textContent = "Unknown";
        pill.className = "pill pill-unknown";
      }
    }
  }

  async function openBot() {
    try {
      const cfg = await Api.fetchExtConfig();
      if (!cfg.botUsername) {
        setText("connectionStatus", "Server TELEGRAM_BOT_USERNAME is missing.");
        return;
      }
      await chrome.tabs.create({ url: `https://t.me/${cfg.botUsername}` });
    } catch (e) {
      setText("connectionStatus", `Error: ${e.message}`);
    }
  }

  async function generateLink() {
    try {
      setText("connectionStatus", "Generating link...");
      setText("code", "");
      setLink("tgLink", "", "");

      const deviceId = await Storage.getDeviceId();
      const data = await Api.startPair(deviceId);

      setText("code", `Code: ${data.code}`);
      setLink("tgLink", "Open Telegram and press Start to link", data.botLink);
      setText("connectionStatus", "After linking in Telegram, click Refresh.");
      await refreshConnectionState();
    } catch (e) {
      setText("connectionStatus", `Error: ${e.message}`);
    }
  }

  async function resetDevice() {
    const newId = await Storage.resetDeviceId();
    setText("deviceId", newId);
    setText("connectionStatus", "Device reset on this browser. Generate a new link to pair again.");
    setText("code", "");
    setLink("tgLink", "", "");
    await refreshConnectionState();
  }

  async function clearLocalData() {
    await Storage.clearLocalData();
    setText("connectionStatus", "Local extension data cleared.");
    setText("code", "");
    setLink("tgLink", "", "");
    await refreshConnectionState();
  }

  return {
    refreshConnectionState,
    openBot,
    generateLink,
    resetDevice,
    clearLocalData,
  };
})();
