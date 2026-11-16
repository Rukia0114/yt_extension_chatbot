globalThis.Storage = (() => {
    async function getDeviceId() {
      const { deviceId } = await chrome.storage.local.get(["deviceId"]);
      if (deviceId) return deviceId;
      const newId = crypto.randomUUID();
      await chrome.storage.local.set({ deviceId: newId });
      return newId;
    }
  
    async function resetDeviceId() {
      const newId = crypto.randomUUID();
      await chrome.storage.local.set({ deviceId: newId });
      return newId;
    }

    async function clearLocalData() {
        await chrome.storage.local.clear();
    }
    return { getDeviceId, resetDeviceId, clearLocalData };
  })();