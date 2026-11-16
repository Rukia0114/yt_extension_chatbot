const express = require("express");
const healthRoutes = require("./routes/health");
const extRoutes = require("./routes/ext");
const { startBot } = require("./bot");

const PORT = Number(process.env.PORT || 3000);

async function startServer() {
  const app = express();
  app.use(express.json());

  app.use(healthRoutes);
  app.use("/api/ext", extRoutes);

  app.listen(PORT, async () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
    await startBot();
  });
}

module.exports = { startServer };