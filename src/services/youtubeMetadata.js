async function fetchYouTubeMetadata(videoUrl) {
  const url = String(videoUrl || "").trim();
  if (!url) return null;

  try {
    const resp = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
    );
    if (!resp.ok) return null;

    const data = await resp.json().catch(() => ({}));
    const title = typeof data.title === "string" ? data.title.trim() : "";
    const channelName = typeof data.author_name === "string" ? data.author_name.trim() : "";
    const thumbnailUrl =
      typeof data.thumbnail_url === "string" ? data.thumbnail_url.trim() : "";

    return {
      title: title || null,
      channel_name: channelName || null,
      thumbnail_url: thumbnailUrl || null,
    };
  } catch {
    return null;
  }
}

module.exports = {
  fetchYouTubeMetadata,
};
