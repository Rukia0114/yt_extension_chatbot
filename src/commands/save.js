const { saveCurrentVideoForUser } = require("../services/watchlistSave");

module.exports = async (ctx) => {
  const userId = ctx.from.id;
  const result = await saveCurrentVideoForUser(userId, {
    username: ctx.from.username,
    first_name: ctx.from.first_name,
    last_name: ctx.from.last_name,
    language_code: ctx.from.language_code,
  });

  if (!result.ok) {
    await ctx.reply(
      result.error === "No current video to save."
        ? "No current video to save.\n\nSync with a YouTube video from extension or paste a YouTube link, then run /save."
        : result.error
    );
    return;
  }

  await ctx.reply(result.message);
};