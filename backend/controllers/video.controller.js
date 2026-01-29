const mongoose = require("mongoose");

exports.streamVideo = async (req, res) => {
  const bucket = req.app.locals.videosBucket;
  if (!bucket) return res.status(500).json({ error: "Videos bucket not initialized" });

  const { fileId } = req.params;
  let objectId;
  try {
    objectId = new mongoose.Types.ObjectId(fileId);
  } catch {
    return res.status(400).json({ error: "Invalid fileId" });
  }

  const files = await bucket.find({ _id: objectId }).limit(1).toArray();
  if (!files.length) return res.sendStatus(404);
  const file = files[0];

  const totalSize = Number(file.length);
  const filename = String(file.filename || `video-${fileId}`);
  const safeFilename = filename.replace(/["\r\n]/g, "");
  res.setHeader("Content-Type", file.contentType || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${safeFilename}"`);
  res.setHeader("Accept-Ranges", "bytes");

  const range = req.headers.range;
  if (range && Number.isFinite(totalSize)) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(String(range));
    if (!match) {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${totalSize}`);
      return res.end();
    }

    const start = Number(match[1]);
    const endRequested = match[2] ? Number(match[2]) : totalSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(endRequested) || start >= totalSize) {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${totalSize}`);
      return res.end();
    }

    const end = Math.min(endRequested, totalSize - 1);
    if (end < start) {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${totalSize}`);
      return res.end();
    }

    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
    res.setHeader("Content-Length", String(end - start + 1));

    const downloadStream = bucket.openDownloadStream(objectId, { start, end: end + 1 });
    downloadStream.on("error", (err) => {
      if (!res.headersSent) res.status(500);
      res.end(err?.message || "Stream error");
    });
    return downloadStream.pipe(res);
  }

  if (Number.isFinite(totalSize)) res.setHeader("Content-Length", String(totalSize));

  const downloadStream = bucket.openDownloadStream(objectId);
  downloadStream.on("error", (err) => {
    if (!res.headersSent) res.status(500);
    res.end(err?.message || "Stream error");
  });
  return downloadStream.pipe(res);
};
