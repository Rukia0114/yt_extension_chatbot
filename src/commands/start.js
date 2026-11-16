const db = require('../services/database');
const pairing = require("../services/pairing");


module.exports = async (ctx) => {
    const user = ctx.from;
    const userId = user.id;

    // Create/update user in database
    await db.createOrUpdateUser(userId, {
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        language_code: user.language_code,
    });

    // Parse /start payload: "/start pair_abcdef12"
    const text = ctx.message?.text || "";
    const payload = text.split(" ")[1];

    if (payload && payload.startsWith("pair_")) {
        const code = payload.slice("pair_".length);
    
        try {
          const deviceId = await pairing.confirmPair(code, userId);
          await ctx.reply(
            `Linked successfully!\n\n` +
            `You can go back to the Chrome extension now.\n` +
            `Device: ${deviceId}`
          );
        } catch (e) {
          await ctx.reply(`Link failed: ${e.message}\n\nPlease try linking again from the extension.`);
        }
        return;
      }

    const name = user.first_name || user.username || user.last_name || 'User';

    const message = `Hi ${name}! Welcome to the Video Chatbot! \n` +
        `Please paste the video/youtube link you want to chat about!!!\n` +
        `Type /help to see all commands the bot have \n`;
    
    await ctx.reply(message);
};