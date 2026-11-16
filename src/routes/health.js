const express = require("express");
const router = express.Router();

router.get("/health", (_, res) => res.status(200).send("ok"));

module.exports = router;