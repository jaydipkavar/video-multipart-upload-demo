# Multipart Upload Demo (Frontend + Backend)

## Prereqs
- Node.js (recommended: latest LTS)
- Docker (recommended) or a local MongoDB install

## Quick start (MongoDB via Docker Compose)

### 1) Start MongoDB
This repo includes `docker-compose.yml` to run MongoDB.

If port `27017` is free:
```bash
docker compose up -d
```

If port `27017` is already in use (common), use another host port (example `27018`):
```bash
MONGO_HOST_PORT=27018 docker compose up -d
```

Check the port mapping:
```bash
docker compose ps
```
You should see something like `127.0.0.1:27018->27017/tcp` (or `27017->27017`).

### 2) Configure backend Mongo URI
Create `backend/.env` (copy from `backend/.env.example`) and set `MONGO_URI` to match your host port:

- If you used `27017`:
  - `MONGO_URI=mongodb://127.0.0.1:27017/multipart-demo`
- If you used `27018`:
  - `MONGO_URI=mongodb://127.0.0.1:27018/multipart-demo`

### 3) Install dependencies
From repo root:
```bash
npm run setup
```

### 4) Run frontend + backend
```bash
npm run dev
```

- Backend: `http://localhost:5000`
- Frontend: `http://localhost:5173`

## View data in MongoDB Compass
In Compass, create a new connection using the same URI from `backend/.env`:

Example (Docker on `27018`):
```text
mongodb://127.0.0.1:27018/multipart-demo?directConnection=true
```

After you upload once in the UI, look for:
- Database: `multipart-demo`
- Collection: `uploadsessions`

## Video storage (MongoDB)
This demo stores the final uploaded video in MongoDB using **GridFS**:
- GridFS collections: `videos.files` and `videos.chunks`
- Each upload session metadata: `uploadsessions`
- Stable video URL per upload: `GET /api/upload/:uploadId/video` (redirects to `GET /api/video/:fileId`)

## Delete uploads
- Delete one upload (and its GridFS video): `DELETE /api/upload/:uploadId`
- Delete multiple uploads: `POST /api/upload/delete` with JSON body `{ "uploadIds": ["..."] }`

## What “chunk upload” means (how it works)
Large files can be uploaded in smaller pieces (“chunks”) instead of one huge request.

This demo uses a simple 3-step flow:
1. **Init**: frontend tells the backend the file name + how many chunks it will send.
   - `POST /api/upload/init` → returns an `uploadId`
2. **Chunk upload**: frontend slices the file into fixed-size chunks and uploads them one by one.
   - `POST /api/upload/chunk` (multipart/form-data: `chunk`, `chunkIndex`, `uploadId`)
   - Backend writes each chunk to disk: `backend/uploads/chunks/<uploadId>/<chunkIndex>`
3. **Complete**: frontend tells backend to assemble chunks into the final file.
   - `POST /api/upload/complete`
   - Backend concatenates chunks in order and stores the final file in MongoDB GridFS (bucket: `videos`)
   - Backend streams the final file at: `http://localhost:5000/api/video/<fileId>`

Frontend settings:
- Chunk size is `5MB` (see `frontend/src/UploadVideo.jsx`).

Why chunking is useful:
- More reliable for large files (each request is smaller).
- You can track progress accurately and retry failed chunks.

## Troubleshooting
- “It looks like you are trying to access MongoDB over HTTP…”: don’t open `http://localhost:27017` in a browser; use a MongoDB URI (`mongodb://...`) in your app/Compass.
- Compass `ECONNREFUSED 127.0.0.1:27018`: MongoDB isn’t published on that port; re-check `docker compose ps` and ensure you started with `MONGO_HOST_PORT=27018`.
- Docker error “port is already allocated”: pick a different host port (example `MONGO_HOST_PORT=27018`), or stop the service already using `27017`.

## Notes
- Backend serves uploaded files under `http://localhost:5000/uploads/...`
- Frontend uses a Vite proxy for `/api` and `/uploads` by default.
