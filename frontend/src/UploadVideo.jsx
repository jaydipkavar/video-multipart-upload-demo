import { useEffect, useMemo, useRef, useState } from "react";

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function nowTime() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

export default function UploadVideo() {
  const [chunkSizeMB, setChunkSizeMB] = useState(5);
  const [uploads, setUploads] = useState([]);
  const [pageError, setPageError] = useState("");
  const abortersRef = useRef(new Map());
  const uploadsRef = useRef(uploads);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [modal, setModal] = useState({ open: false, url: "", title: "" });
  const [selected, setSelected] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  const apiBase = useMemo(() => {
    const fromEnv = String(import.meta.env.VITE_API_BASE || "").trim();
    if (fromEnv) return fromEnv.replace(/\/+$/, "");
    // Fallback for dev if Vite proxy isn't configured/working.
    if (import.meta.env.DEV) return "http://localhost:5000";
    return "";
  }, []);

  const apiUrl = (p) => (apiBase ? `${apiBase}${p}` : p);

  const chunkSizeBytes = Math.max(1, Math.floor(Number(chunkSizeMB) || 1)) * 1024 * 1024;

  const anyUploading = uploads.some((u) => u.status === "uploading");
  const anyStartable = uploads.some((u) => u.status === "queued" || u.status === "error");

  const loadHistory = async () => {
    setHistoryError("");
    setHistoryLoading(true);
    try {
      const res = await fetch(apiUrl("/api/upload?limit=50"));
      if (!res.ok) throw new Error("Failed to load upload history");
      const body = await res.json();
      setHistory(Array.isArray(body?.items) ? body.items : []);
      setSelected((prev) => {
        const next = new Set();
        const allowed = new Set((body?.items || []).map((x) => x.uploadId));
        for (const id of prev) if (allowed.has(id)) next.add(id);
        return next;
      });
    } catch (e) {
      setHistoryError(e?.message || "Failed to load upload history");
    } finally {
      setHistoryLoading(false);
    }
  };

  const toggleSelected = (uploadId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uploadId)) next.delete(uploadId);
      else next.add(uploadId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const allIds = history.map((h) => h.uploadId);
      if (allIds.length === 0) return prev;
      const allSelected = allIds.every((id) => prev.has(id));
      return allSelected ? new Set() : new Set(allIds);
    });
  };

  const deleteSelected = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const ok = window.confirm(
      `Delete ${ids.length} upload(s)? This removes the video from MongoDB.`
    );
    if (!ok) return;

    setDeleting(true);
    setHistoryError("");
    try {
      const res = await fetch(apiUrl("/api/upload/delete"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadIds: ids }),
      });
      if (!res.ok) throw new Error("Delete failed");
      setSelected(new Set());
      await loadHistory();
    } catch (e) {
      setHistoryError(e?.message || "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const deleteOneFromHistory = async (uploadId) => {
    const ok = window.confirm("Delete this upload? This removes the video from MongoDB.");
    if (!ok) return;
    setDeleting(true);
    setHistoryError("");
    try {
      const res = await fetch(apiUrl(`/api/upload/${uploadId}`), { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(uploadId);
        return next;
      });
      await loadHistory();
    } catch (e) {
      setHistoryError(e?.message || "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateUpload = (id, patchOrUpdater) => {
    setUploads((prev) =>
      prev.map((u) => {
        if (u.id !== id) return u;
        if (typeof patchOrUpdater === "function") return patchOrUpdater(u);
        return { ...u, ...patchOrUpdater };
      })
    );
  };

  const addLog = (id, message) => {
    updateUpload(id, (u) => {
      const next = [...u.logs, `[${nowTime()}] ${message}`];
      return { ...u, logs: next.slice(-250) };
    });
  };

  const onPickFiles = (files) => {
    if (!files?.length) return;
    setPageError("");

    const next = Array.from(files).map((file) => ({
      id: makeId(),
      file,
      name: file.name,
      size: file.size,
      status: "queued", // queued | uploading | completed | error | canceled
      progress: 0,
      uploadedChunks: 0,
      totalChunks: Math.ceil(file.size / chunkSizeBytes),
      uploadId: "",
      videoUrl: "",
      error: "",
      showLogs: false,
      logs: [`[${nowTime()}] Ready to upload`],
    }));

    setUploads((prev) => [...next, ...prev]);
  };

  const cancelUpload = (id) => {
    const controller = abortersRef.current.get(id);
    if (controller) controller.abort();
    abortersRef.current.delete(id);
    updateUpload(id, { status: "canceled", error: "Canceled by user" });
  };

  const removeUpload = (id) => {
    if (abortersRef.current.get(id)) return;
    setUploads((prev) => prev.filter((u) => u.id !== id));
  };

  const uploadOne = async (id) => {
    const current = uploadsRef.current.find((u) => u.id === id);
    if (!current?.file) return;
    if (current.status === "uploading") return;

    const controller = new AbortController();
    abortersRef.current.set(id, controller);

    updateUpload(id, (u) => ({
      ...u,
      status: "uploading",
      progress: 0,
      uploadedChunks: 0,
      totalChunks: Math.ceil(u.file.size / chunkSizeBytes),
      uploadId: "",
      videoUrl: "",
      error: "",
    }));

    try {
      const totalChunks = Math.ceil(current.file.size / chunkSizeBytes);
      addLog(id, `Init upload (${totalChunks} chunks, ${formatBytes(chunkSizeBytes)} each)`);

      const initRes = await fetch(apiUrl("/api/upload/init"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: current.file.name,
          totalChunks,
          fileSize: current.file.size,
          mimeType: current.file.type,
        }),
        signal: controller.signal,
      });
      if (!initRes.ok) throw new Error("Failed to init upload");
      const { uploadId } = await initRes.json();
      updateUpload(id, { uploadId });
      addLog(id, `Upload session: ${uploadId}`);

      for (let i = 0; i < totalChunks; i++) {
        addLog(id, `Uploading chunk ${i + 1}/${totalChunks}`);
        const chunk = current.file.slice(i * chunkSizeBytes, (i + 1) * chunkSizeBytes);

        const formData = new FormData();
        formData.append("chunk", chunk);
        formData.append("chunkIndex", String(i));
        formData.append("uploadId", uploadId);

        const chunkRes = await fetch(apiUrl("/api/upload/chunk"), {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        if (!chunkRes.ok) throw new Error(`Failed to upload chunk ${i + 1}`);

        const uploadedChunks = i + 1;
        updateUpload(id, {
          uploadedChunks,
          progress: Math.round((uploadedChunks / totalChunks) * 100),
        });
        addLog(id, `Uploaded chunk ${i + 1}/${totalChunks}`);
      }

      addLog(id, "All chunks uploaded. Completing...");
      const completeRes = await fetch(apiUrl("/api/upload/complete"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId }),
        signal: controller.signal,
      });
      if (!completeRes.ok) throw new Error("Failed to complete upload");
      const completeBody = await completeRes.json();

      if (completeBody?.videoUrl) {
        const url = apiUrl(completeBody.videoUrl);
        updateUpload(id, { status: "completed", videoUrl: url, progress: 100 });
        addLog(id, "Completed");
        loadHistory();
      } else {
        throw new Error("Upload completed but no videoUrl returned");
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        updateUpload(id, (u) =>
          u.status === "canceled" ? u : { ...u, status: "canceled", error: "Canceled by user" }
        );
        addLog(id, "Canceled");
      } else {
        const msg = e?.message || "Upload failed";
        updateUpload(id, { status: "error", error: msg });
        addLog(id, `Error: ${msg}`);
      }
    } finally {
      abortersRef.current.delete(id);
    }
  };

  const uploadAll = async () => {
    setPageError("");
    const queue = uploadsRef.current.filter(
      (u) => u.status === "queued" || u.status === "error"
    );
    if (queue.length === 0) return;
    if (anyUploading) return;
    for (const u of queue) {
      // eslint-disable-next-line no-await-in-loop
      await uploadOne(u.id);
    }
  };

  return (
    <div>
      <div className="uHeader">
        <div className="uControls">
          <label className="uFile">
            <input
              type="file"
              accept="video/*"
              multiple
              disabled={anyUploading}
              onChange={(e) => {
                onPickFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <span>Select videos</span>
          </label>

          <label className="uChunk">
            <span className="muted">Chunk size (MB)</span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={chunkSizeMB}
              disabled={anyUploading}
              onChange={(e) => setChunkSizeMB(e.target.value)}
            />
          </label>

          <div className="uButtons">
            <button type="button" disabled={!uploads.length || anyUploading} onClick={() => setUploads([])}>
              Clear
            </button>
            <button
              type="button"
              className="primary"
              disabled={!anyStartable || anyUploading}
              onClick={uploadAll}
            >
              Upload
            </button>
          </div>
        </div>

        <div className="uSummary muted">
          <span>{uploads.length} file(s)</span>
          <span>•</span>
          <span>Chunk size: {formatBytes(chunkSizeBytes)}</span>
        </div>
      </div>

      {pageError ? <p className="error">{pageError}</p> : null}

      <div className="uploads">
        {uploads.length === 0 ? (
          <div className="uEmpty">
            <p className="muted">
              Choose one or more videos, then click <b>Upload</b> to start.
            </p>
          </div>
        ) : null}

        {uploads.map((u) => (
          <div key={u.id} className="uItem">
            <div className="uTop">
              <div className="uMeta">
                <div className="uName">{u.name}</div>
                <div className="uSub muted">
                  {formatBytes(u.size)} • {u.uploadedChunks}/{u.totalChunks} chunks
                </div>
              </div>

              <div className="uActions">
                {u.status === "uploading" ? (
                  <button type="button" onClick={() => cancelUpload(u.id)}>
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={anyUploading || u.status === "completed"}
                    onClick={() => uploadOne(u.id)}
                  >
                    {u.status === "error" ? "Retry" : "Upload"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={u.status === "uploading"}
                  onClick={() => removeUpload(u.id)}
                >
                  Remove
                </button>
                <button
                  type="button"
                  onClick={() => updateUpload(u.id, (prev) => ({ ...prev, showLogs: !prev.showLogs }))}
                >
                  {u.showLogs ? "Hide log" : "Show log"}
                </button>
              </div>
            </div>

            <div className="uProgress">
              <progress value={u.progress} max="100" style={{ width: "100%" }} />
              <div className="uProgressRow">
                <span className={`badge ${u.status}`}>{u.status}</span>
                <span>{u.progress}%</span>
              </div>
            </div>

            {u.error ? <p className="error">{u.error}</p> : null}

            {u.videoUrl ? (
              <UploadResult url={u.videoUrl} />
            ) : null}

            {u.showLogs ? (
              <pre className="uLog">{u.logs.join("\n")}</pre>
            ) : null}
          </div>
        ))}
      </div>

      <div className="historyHeader">
        <h2 style={{ margin: "18px 0 8px" }}>Uploads</h2>
        <div className="row">
          <button type="button" disabled={historyLoading} onClick={loadHistory}>
            {historyLoading ? "Refreshing..." : "Refresh"}
          </button>
          <button
            type="button"
            disabled={deleting || selected.size === 0}
            onClick={deleteSelected}
          >
            {deleting ? "Deleting..." : `Delete selected (${selected.size})`}
          </button>
        </div>
      </div>

      {historyError ? <p className="error">{historyError}</p> : null}

      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 44 }}>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={history.length > 0 && history.every((h) => selected.has(h.uploadId))}
                  onChange={toggleSelectAll}
                />
              </th>
              <th>Video name</th>
              <th>Size</th>
              <th>Status</th>
              <th>Uploaded at</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 ? (
              <tr>
                <td colSpan="6" className="muted">
                  No uploads yet.
                </td>
              </tr>
            ) : (
              history.map((h) => (
                <tr key={h.uploadId}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${h.originalFileName || h.uploadId}`}
                      checked={selected.has(h.uploadId)}
                      onChange={() => toggleSelected(h.uploadId)}
                    />
                  </td>
                  <td title={h.originalFileName}>{h.originalFileName}</td>
                  <td className="muted">{formatBytes(h.fileSize)}</td>
                  <td>
                    <span className={`badge ${String(h.status || "").toLowerCase()}`}>
                      {String(h.status || "").toLowerCase() || "-"}
                    </span>
                  </td>
                  <td className="muted">{formatDateTime(h.createdAt)}</td>
                  <td>
                    {h.videoUrl ? (
                      <HistoryActions
                        url={apiUrl(h.videoUrl)}
                        onView={() =>
                          setModal({
                            open: true,
                            url: apiUrl(h.videoUrl),
                            title: h.originalFileName || "Video",
                          })
                        }
                        onDelete={() => deleteOneFromHistory(h.uploadId)}
                      />
                    ) : (
                      <div className="historyActions">
                        <button
                          type="button"
                          disabled={deleting}
                          onClick={() => deleteOneFromHistory(h.uploadId)}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <VideoModal
        open={modal.open}
        url={modal.url}
        title={modal.title}
        onClose={() => setModal({ open: false, url: "", title: "" })}
      />
    </div>
  );
}

function UploadResult({ url }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ alignItems: "stretch" }}>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          style={{ display: "inline-flex", alignItems: "center" }}
        >
          Open
        </a>
      </div>
      <video className="video" controls src={url} />
    </div>
  );
}

function HistoryActions({ url, onView, onDelete }) {
  return (
    <div className="historyActions">
      <button type="button" className="primary" onClick={onView}>
        View
      </button>
      <a href={url} target="_blank" rel="noreferrer">
        Open
      </a>
      <button type="button" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

function VideoModal({ open, url, title, onClose }) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Video preview">
      <div className="modalCard">
        <div className="modalHeader">
          <div className="modalTitle" title={title}>
            {title}
          </div>
          <div className="modalActions">
            <a className="modalLink" href={url} target="_blank" rel="noreferrer">
              Open
            </a>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <video className="modalVideo" controls autoPlay src={url} />
      </div>
      <button type="button" className="modalBackdrop" aria-label="Close" onClick={onClose} />
    </div>
  );
}
