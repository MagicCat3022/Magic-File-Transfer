const path = require('path');
const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const UploadManager = require('./src/uploadManager');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const FINAL_DIR = path.join(DATA_DIR, 'files');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

const manager = new UploadManager({
  rootDir: ROOT,
  uploadDir: UPLOAD_DIR,
  finalDir: FINAL_DIR,
  statePath: STATE_PATH,
});

fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(FINAL_DIR);

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
});

const probeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  req.startTime = Date.now();
  next();
});

app.use(express.static(path.join(ROOT, 'public')));

// --- New: idempotent create by client-supplied uploadId (RESTful) ---
app.put('/api/uploads/:uploadId', async (req, res, next) => {
  try {
    const { userKey, fileName, fileSize, chunkSize, persist = true, totalChunks } = req.body || {};
    if (!userKey || !fileName || !Number.isFinite(fileSize) || !Number.isFinite(chunkSize)) {
      const error = new Error('missing_or_invalid_fields');
      error.statusCode = 400;
      throw error;
    }
    const upload = await manager.ensureUpload(req.params.uploadId, {
      userKey,
      fileName,
      fileSize: Number(fileSize),
      chunkSize: Number(chunkSize),
      totalChunks: Number.isFinite(totalChunks) ? Number(totalChunks) : Math.ceil(fileSize / chunkSize),
      persist: persist !== false && persist !== 'false',
    });
    res.json({ upload });
  } catch (err) { next(err); }
});

// --- New: probe which chunks exist by scanning filesystem (stateless resume) ---
app.get('/api/uploads/:uploadId/chunks', async (req, res, next) => {
  try {
    const info = await manager.inspectChunks(req.params.uploadId);
    res.json(info);
  } catch (err) { next(err); }
});

// --- New: lookup by (userKey, fileName, fileSize) to find active/paused ---
app.get('/api/uploads/lookup', async (req, res, next) => {
  try {
    const { userKey, fileName } = req.query || {};
    const fileSize = Number(req.query?.fileSize);
    if (!userKey || !fileName || !Number.isFinite(fileSize)) {
      const error = new Error('missing_or_invalid_fields');
      error.statusCode = 400;
      throw error;
    }
    const match = await manager.lookupUpload(userKey, fileName, fileSize);
    res.json({ match });
  } catch (err) { next(err); }
});

app.post('/api/users/identify', async (req, res, next) => {
  try {
    const requestedKey = req.body?.userKey || req.query?.userKey;
    const result = await manager.identifyUser(requestedKey);
    const snapshot = (await manager.getUserSnapshot(result.userKey)) || { active: [], paused: [], history: [] };
    res.json({ userKey: result.userKey, created: result.created, uploads: snapshot });
  } catch (err) {
    next(err);
  }
});

app.get('/api/uploads', async (req, res, next) => {
  try {
    const userKey = req.query.userKey;
    if (!userKey) {
      const error = new Error('missing_user_key');
      error.statusCode = 400;
      throw error;
    }
    const snapshot = await manager.getUserSnapshot(userKey);
    if (!snapshot) {
      const error = new Error('user_not_found');
      error.statusCode = 404;
      throw error;
    }
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

app.get('/api/uploads/:uploadId', async (req, res, next) => {
  try {
    const userKey = req.query.userKey;
    if (!userKey) {
      const error = new Error('missing_user_key');
      error.statusCode = 400;
      throw error;
    }
    const uploadResult = await manager.getUpload(userKey, req.params.uploadId);
    if (!uploadResult) {
      const error = new Error('upload_not_found');
      error.statusCode = 404;
      throw error;
    }
    res.json({ upload: uploadResult.upload, location: uploadResult.location });
  } catch (err) {
    next(err);
  }
});

app.post('/api/uploads', async (req, res, next) => {
  try {
    const { userKey, fileName, fileSize, chunkSize, persist = true } = req.body || {};
    if (!userKey || !fileName) {
      const error = new Error('missing_fields');
      error.statusCode = 400;
      throw error;
    }
    const size = Number(fileSize);
    const chunk = Number(chunkSize);
    if (!Number.isFinite(size) || !Number.isFinite(chunk) || size <= 0 || chunk <= 0) {
      const error = new Error('invalid_sizes');
      error.statusCode = 400;
      throw error;
    }
    const upload = await manager.createUpload(userKey, {
      fileName,
      fileSize: size,
      chunkSize: chunk,
      persist: persist !== false && persist !== 'false',
    });
    res.json({ upload });
  } catch (err) {
    next(err);
  }
});

app.post('/api/uploads/:uploadId/chunk', chunkUpload.single('chunk'), async (req, res, next) => {
  try {
    const uploadId = req.params.uploadId;
    const { userKey, chunkIndex } = req.body || {};
    if (!userKey) {
      const error = new Error('missing_user_key');
      error.statusCode = 400;
      throw error;
    }
    if (!req.file) {
      const error = new Error('missing_chunk');
      error.statusCode = 400;
      throw error;
    }
    const index = parseInteger(chunkIndex, 'chunk_index');
    const chunkDir = await ensureChunkDirectory(uploadId);
    const chunkPath = path.join(chunkDir, `${index}.part`);

    const exists = await fs.pathExists(chunkPath);
    if (!exists) {
      await fs.writeFile(chunkPath, req.file.buffer);
    }

    const record = await manager.recordChunk(userKey, uploadId, index);

    if (record.completed) {
      const finalizedUpload = record.upload;
      await manager.assembleFile(finalizedUpload);
      await manager.finalizeUpload(userKey, uploadId);
      const snapshot = await manager.getUserSnapshot(userKey);
      res.json({ status: 'completed', upload: finalizedUpload, uploads: snapshot });
      return;
    }

    res.json({ status: 'ok', upload: record.upload });
  } catch (err) {
    next(err);
  }
});

app.post('/api/uploads/:uploadId/state', async (req, res, next) => {
  try {
    const { action, userKey } = req.body || {};
    if (!userKey || !action) {
      const error = new Error('missing_fields');
      error.statusCode = 400;
      throw error;
    }
    let response;
    if (action === 'pause') {
      response = await manager.updateStatus(userKey, req.params.uploadId, 'paused');
    } else if (action === 'resume') {
      response = await manager.updateStatus(userKey, req.params.uploadId, 'active');
    } else if (action === 'cancel') {
      response = await manager.cancelUpload(userKey, req.params.uploadId); // marks cancelled in history
      await fs.remove(path.join(UPLOAD_DIR, req.params.uploadId));         // idempotent purge of chunks
    } else if (action === 'forget') {
      response = await manager.forgetUpload(userKey, req.params.uploadId); // no history entry
      await fs.remove(path.join(UPLOAD_DIR, req.params.uploadId));
    } else {
      const error = new Error('invalid_action');
      error.statusCode = 400;
      throw error;
    }
    const snapshot = await manager.getUserSnapshot(userKey);
    res.json({ upload: response, uploads: snapshot });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/uploads/history', async (req, res, next) => {
  try {
    const userKey = req.body?.userKey || req.query?.userKey;
    if (!userKey) {
      const error = new Error('missing_user_key');
      error.statusCode = 400;
      throw error;
    }
    await manager.clearHistory(userKey);
    const snapshot = await manager.getUserSnapshot(userKey);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

app.post('/api/network/probe', probeUpload.single('sample'), async (req, res, next) => {
  try {
    if (!req.file) {
      const error = new Error('missing_sample');
      error.statusCode = 400;
      throw error;
    }
    const elapsedMs = Date.now() - req.startTime;
    res.json({ bytes: req.file.buffer.length, elapsedMs });
  } catch (err) {
    next(err);
  }
});

function sanitizeError(err) {
  return {
    message: err.message,
    details: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    statusCode: err.statusCode || 500,
  };
}

app.use((err, req, res, next) => {
  const error = sanitizeError(err);
  if (process.env.NODE_ENV !== 'production') {
    console.error(err);
  }
  res.status(error.statusCode || 500).json({ error: error.message, details: error.details });
});

app.listen(PORT, () => {
  console.log(`Magic File Transfer Node server listening on http://localhost:${PORT}`);
});
