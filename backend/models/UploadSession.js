const mongoose = require("mongoose");

const uploadSessionSchema = new mongoose.Schema({
  uploadId: String,
  originalFileName: String,
  storedFileName: String,
  gridfsFileId: mongoose.Schema.Types.ObjectId,
  fileSize: Number,
  mimeType: String,
  totalChunks: Number,
  uploadedChunks: [Number],
  status: {
    type: String,
    default: "UPLOADING",
  },
}, { timestamps: true });

module.exports = mongoose.model("UploadSession", uploadSessionSchema);
