const express = require("express");
const multer = require("multer");
const path = require("path");
const controller = require("../controllers/upload.controller");

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, "..", "temp") });

// Some setups hit the mount path without a trailing slash.
router.get("", controller.listUploads);
router.get("/", controller.listUploads);
router.post("/delete", express.json(), controller.deleteUploads);
router.get("/:uploadId/video", controller.getUploadVideo);
router.get("/:uploadId", controller.getUploadStatus);
router.delete("/:uploadId", controller.deleteUpload);
router.post("/init", controller.initUpload);
router.post("/chunk", upload.single("chunk"), controller.uploadChunk);
router.post("/complete", controller.completeUpload);

module.exports = router;
