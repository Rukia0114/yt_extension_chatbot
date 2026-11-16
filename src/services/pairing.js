const crypto = require("crypto");
const { redis } = require("./redis");     // exports.redis is the ioredis client
const db = require("./database");

function makeCode() {
  // 8 hex chars, short and URL-safe
  return crypto.randomBytes(4).toString("hex");
}

function isValidDeviceId(deviceId) {
  // if you use crypto.randomUUID() in the extension, this matches it
  return typeof deviceId === "string" && /^[0-9a-f-]{16,64}$/i.test(deviceId);
}

module.exports = {
  isValidDeviceId,

  async startPair(deviceId, ttlSec = 600) {
    if (!isValidDeviceId(deviceId)) throw new Error("Invalid deviceId");
    const code = makeCode();

    await redis.setex(
      `pair:${code}`,
      ttlSec,
      JSON.stringify({ deviceId, createdAt: Date.now() })
    );

    return code;
  },

  async confirmPair(code, telegramUserId) {
    if (!code || typeof code !== "string") throw new Error("Missing code");
    if (!telegramUserId) throw new Error("Missing telegramUserId");

    const raw = await redis.get(`pair:${code}`);
    if (!raw) throw new Error("Pair code expired or invalid");

    const { deviceId } = JSON.parse(raw);
    if (!deviceId) throw new Error("Pair data invalid");

    await db.linkDeviceToUser(deviceId, telegramUserId);

    await redis.del(`pair:${code}`);
    return deviceId;
  },

  async isLinked(deviceId) {
    if (!isValidDeviceId(deviceId)) return false;
    const userId = await db.getUserIdByDeviceId(deviceId);
    return !!userId;
  }
};