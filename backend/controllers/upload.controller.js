const fs = require("fs-extra");
const fsNative = require("fs");
const path = require("path");
const crypto = require("crypto");
const { finished } = require("stream/promises");
const mongoose = require("mongoose");
const UploadSession = require("../models/UploadSession");

const CHUNK_DIR = path.join(__dirname, "..", "uploads", "chunks");

function sanitizeFileName(fileName) {
  const base = path.basename(String(fileName || "upload"));
  return base
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

exports.getUploadStatus = async (req, res) => {
  const { uploadId } = req.params;
  const session = await UploadSession.findOne({ uploadId }).lean();
  if (!session) return res.sendStatus(404);
  const videoUrl =
    session.status === "COMPLETED" ? `/api/upload/${session.uploadId}/video` : "";
  return res.json({
    uploadId: session.uploadId,
    originalFileName: session.originalFileName,
    storedFileName: session.storedFileName,
    gridfsFileId: session.gridfsFileId,
    fileSize: session.fileSize,
    mimeType: session.mimeType,
    totalChunks: session.totalChunks,
    uploadedChunks: session.uploadedChunks,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    videoUrl,
  });
};

exports.initUpload = async (req, res) => {
  const { fileName, totalChunks, fileSize, mimeType } = req.body;
  if (!fileName || !Number.isFinite(Number(totalChunks)) || totalChunks <= 0) {
    return res.status(400).json({ error: "fileName and totalChunks required" });
  }

  const uploadId = crypto.randomUUID();
  const safeName = sanitizeFileName(fileName);
  const storedFileName = `${uploadId}-${safeName}`;

  await UploadSession.create({
    uploadId,
    originalFileName: fileName,
    storedFileName,
    fileSize: Number.isFinite(Number(fileSize)) ? Number(fileSize) : undefined,
    mimeType: mimeType ? String(mimeType) : undefined,
    totalChunks: Number(totalChunks),
    uploadedChunks: [],
  });

  await fs.ensureDir(path.join(CHUNK_DIR, uploadId));
  res.json({ uploadId, storedFileName });
};

exports.listUploads = async (req, res) => {
  const limitRaw = Number(req.query.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;

  const sessions = await UploadSession.find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  res.json({
    items: sessions.map((s) => ({
      uploadId: s.uploadId,
      originalFileName: s.originalFileName,
      storedFileName: s.storedFileName,
      gridfsFileId: s.gridfsFileId,
      fileSize: s.fileSize,
      mimeType: s.mimeType,
      totalChunks: s.totalChunks,
      uploadedChunks: s.uploadedChunks,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      videoUrl: s.status === "COMPLETED" ? `/api/upload/${s.uploadId}/video` : "",
    })),
  });
};

exports.getUploadVideo = async (req, res) => {
  const { uploadId } = req.params;
  const session = await UploadSession.findOne({ uploadId }).lean();
  if (!session) return res.sendStatus(404);
  if (session.status !== "COMPLETED") {
    return res.status(400).json({ error: "Upload not completed yet" });
  }
  if (session.gridfsFileId) {
    return res.redirect(302, `/api/video/${session.gridfsFileId}`);
  }
  // Backward compatibility for older uploads stored on disk (if present).
  return res.redirect(302, `/uploads/videos/${session.storedFileName}`);
};

async function deleteOneUpload({ uploadId, bucket }) {
  const session = await UploadSession.findOne({ uploadId });
  if (!session) return { uploadId, deleted: false, reason: "Not found" };

  if (session.gridfsFileId && bucket) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await bucket.delete(new mongoose.Types.ObjectId(session.gridfsFileId));
    } catch (e) {
      // ignore file-not-found; still delete the session doc
      if (!/File not found/i.test(String(e?.message || ""))) throw e;
    }
  }

  // Backward compatibility: clean disk file + chunks folder if present.
  if (session.storedFileName) {
    const oldVideoPath = path.join(__dirname, "..", "uploads", "videos", session.storedFileName);
    await fs.remove(oldVideoPath);
  }
  await fs.remove(path.join(CHUNK_DIR, uploadId));

  await UploadSession.deleteOne({ _id: session._id });
  return { uploadId, deleted: true };
}

exports.deleteUpload = async (req, res) => {
  const { uploadId } = req.params;
  const bucket = req.app.locals.videosBucket;
  try {
    const result = await deleteOneUpload({ uploadId, bucket });
    if (!result.deleted) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true, uploadId });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Delete failed" });
  }
};

exports.deleteUploads = async (req, res) => {
  const uploadIds = Array.isArray(req.body?.uploadIds) ? req.body.uploadIds : [];
  const ids = uploadIds.map((x) => String(x)).filter(Boolean).slice(0, 200);
  if (ids.length === 0) {
    return res.status(400).json({ error: "uploadIds required" });
  }

  const bucket = req.app.locals.videosBucket;
  const results = [];
  for (const uploadId of ids) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await deleteOneUpload({ uploadId, bucket }));
  }
  const deletedCount = results.filter((r) => r.deleted).length;
  return res.json({ ok: true, deletedCount, results });
};

async function pipeFileToWriteStream(filePath, writeStream) {
  return new Promise((resolve, reject) => {
    const readStream = fsNative.createReadStream(filePath);
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onData = (buf) => {
      if (!writeStream.write(buf)) readStream.pause();
    };
    const onDrain = () => {
      readStream.resume();
    };

    function cleanup() {
      readStream.off("error", onError);
      readStream.off("end", onEnd);
      readStream.off("data", onData);
      writeStream.off("error", onError);
      writeStream.off("drain", onDrain);
    }

    readStream.on("error", onError);
    readStream.on("end", onEnd);
    readStream.on("data", onData);
    writeStream.on("error", onError);
    writeStream.on("drain", onDrain);
  });
}

exports.uploadChunk = async (req, res) => {
  const { uploadId, chunkIndex } = req.body;
  if (!uploadId || chunkIndex === undefined) {
    return res.status(400).json({ error: "uploadId and chunkIndex required" });
  }
  if (!req.file?.path) {
    return res.status(400).json({ error: "chunk file required" });
  }

  const idx = Number(chunkIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    return res.status(400).json({ error: "chunkIndex must be an integer >= 0" });
  }

  const chunkPath = path.join(CHUNK_DIR, uploadId, String(idx));
  await fs.ensureDir(path.join(CHUNK_DIR, uploadId));
  await fs.move(req.file.path, chunkPath, { overwrite: true });

  await UploadSession.updateOne(
    { uploadId },
    { $addToSet: { uploadedChunks: idx } }
  );

  res.sendStatus(200);
};

exports.completeUpload = async (req, res) => {
  const { uploadId } = req.body;
  const session = await UploadSession.findOne({ uploadId });
  if (!session) return res.sendStatus(404);
  if (session.status === "COMPLETED") {
    return res.json({
      message: "Upload already completed",
      videoUrl: `/api/upload/${session.uploadId}/video`,
    });
  }

  const chunkFolder = path.join(CHUNK_DIR, uploadId);
  const bucket = req.app.locals.videosBucket;
  if (!bucket) {
    return res.status(500).json({ error: "Videos bucket not initialized" });
  }

  const chunks = (await fs.readdir(chunkFolder))
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b));
  if (chunks.length !== session.totalChunks) {
    return res.status(400).json({
      error: "Not all chunks uploaded yet",
      uploaded: chunks.length,
      expected: session.totalChunks,
    });
  }
  for (let i = 0; i < chunks.length; i++) {
    if (Number(chunks[i]) !== i) {
      return res.status(400).json({
        error: "Missing chunk index",
        missingIndex: i,
      });
    }
  }

  const uploadStream = bucket.openUploadStream(session.storedFileName, {
    contentType: session.mimeType || undefined,
    metadata: {
      uploadId: session.uploadId,
      originalFileName: session.originalFileName,
      fileSize: session.fileSize,
      mimeType: session.mimeType,
    },
  });
  const fileId = uploadStream.id;

  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    await pipeFileToWriteStream(path.join(chunkFolder, chunk), uploadStream);
  }

  uploadStream.end();
  await finished(uploadStream);

  await fs.remove(chunkFolder);

  session.status = "COMPLETED";
  session.gridfsFileId = fileId;
  await session.save();

  res.json({
    message: "Upload completed",
    videoUrl: `/api/upload/${session.uploadId}/video`,
  });
};
