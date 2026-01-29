const express = require("express");
const controller = require("../controllers/video.controller");

const router = express.Router();

router.get("/:fileId", controller.streamVideo);

module.exports = router;

