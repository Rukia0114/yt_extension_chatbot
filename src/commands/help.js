// for user to show all commands the bot have
module.exports = async (ctx) => {
    const message = `Here are the commands the bot have: \n` +
        `/start - Start the bot and enter the video/yt links you want to chat about\n` +
        `/help - Show all commands the bot have \n` +
        `/summary - Generate video summary \n` +
        `/watchlist - View your watchlist \n` +
        `/switch <number> - Switch to a saved watchlist video by its number \n` +
        `/highlight - View highlights of the video \n` +
        `/current - Show current video \n` +
        `/source - Switch current video source (watchlist or temporary video) \n` +
        `/save - Save current video to your watchlist \n` +
        `/recommendations - Get recommendations of similar videos \n` +
        `/question - Generate MC/TF question about the video \n` +
        `/clear - Clear current session and start new chat \n`;
    
    await ctx.reply(message);
};