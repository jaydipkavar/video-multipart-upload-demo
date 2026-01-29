const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const fs = require("fs-extra");
const dotenv = require("dotenv");

const uploadRoutes = require("./routes/upload.routes");
const videoRoutes = require("./routes/video.routes");

const app = express();
app.use(cors());
app.use(express.json());

dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = Number(process.env.PORT) || 5000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/multipart-demo";

const UPLOADS_DIR = path.join(__dirname, "uploads");
const TEMP_DIR = path.join(__dirname, "temp");

function redactMongoUri(uri) {
  try {
    return String(uri).replace(/\/\/([^@]+)@/g, "//***@");
  } catch {
    return "<invalid-mongo-uri>";
  }
}

mongoose.connection.on("connected", () => {
  const host = mongoose.connection.host;
  const port = mongoose.connection.port;
  const dbName = mongoose.connection.name;
  console.log(`[mongo] connected ${host}:${port}/${dbName}`);
});

mongoose.connection.on("error", (err) => {
  console.error("[mongo] error:", err?.message || err);
});

mongoose.connection.on("disconnected", () => {
  console.warn("[mongo] disconnected");
});

async function bootstrap() {
  await fs.ensureDir(UPLOADS_DIR);
  await fs.ensureDir(path.join(UPLOADS_DIR, "chunks"));
  await fs.ensureDir(path.join(UPLOADS_DIR, "videos"));
  await fs.ensureDir(TEMP_DIR);

  console.log("[mongo] connecting to", redactMongoUri(MONGO_URI));
  await mongoose.connect(MONGO_URI);

  app.locals.videosBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: "videos",
  });

  app.use("/uploads", express.static(UPLOADS_DIR));
  app.use("/api/upload", uploadRoutes);
  app.use("/api/video", videoRoutes);
  app.get("/api/health", (_req, res) => {
    const readyState = mongoose.connection.readyState;
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    res.json({ ok: true, mongoReadyState: readyState });
  });
  app.use("/api", (req, res) => {
    res.status(404).json({ error: "Not Found", path: req.originalUrl });
  });

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error("Failed to start server:", err);
  process.exitCode = 1;
});

process.on("SIGINT", async () => {
  try {
    await mongoose.disconnect();
  } finally {
    process.exit(0);
  }
});
