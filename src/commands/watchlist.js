const sessionManager = require('../utils/session');

module.exports = async (ctx) => {
    const userId = ctx.from.id;
    const videos = await sessionManager.getVideos(userId);
    const currentVideoId = await sessionManager.getCurrentVideoId(userId);
    
    if (videos.length === 0) {
        await ctx.reply('Your watchlist is empty!!\n\n You can add videos to your watchlist by using the /save command.');
        return;
    }
    
    let message = 'Your Watchlist:\n\n';
    
    videos.forEach((video, index) => {
        const isActive = video.video_id === currentVideoId;
        const activeMarker = isActive ? '  (Current Active Video)' : '';
        const videoTitle = video.title || 'Untitled Video';
        const videoUrl = video.url || `https://www.youtube.com/watch?v=${video.video_id}`;
        const shortUrl = videoUrl.length > 50 
            ? videoUrl.substring(0, 47) + '...' 
            : videoUrl;
        
        message += `${index + 1}. ${videoTitle}${activeMarker}\n   ${shortUrl}\n\n`;
    });
    
    message += 'Use /switch <number> to change the active watchlist video.\n';
    message += 'Use /clear to remove videos from your watchlist.';
    
    await ctx.reply(message);
};