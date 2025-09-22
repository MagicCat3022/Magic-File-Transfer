const path = require('path');
const fs = require('fs-extra');
const DataStore = require('./datastore');

const userIdAlphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fileIdAlphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let customAlphabetPromise = null;
async function loadCustomAlphabet() {
  if (!customAlphabetPromise) {
    customAlphabetPromise = import('nanoid').then((mod) => mod.customAlphabet);
  }
  return customAlphabetPromise;
}

class UploadManager {
  constructor({ rootDir, uploadDir, finalDir, statePath }) {
    this.rootDir = rootDir;
    this.uploadDir = uploadDir;
    this.finalDir = finalDir;
    this.store = new DataStore(statePath);
    this.ephemeral = new Map();
    this._createUserId = null;
    this._createFileId = null;
  }

  _now() {
    return new Date().toISOString();
  }

  _deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  _ensureUserRecord(state, userKey) {
    if (!state.users[userKey]) {
      state.users[userKey] = {
        key: userKey,
        createdAt: this._now(),
        uploads: {},
        history: [],
      };
    }
    const user = state.users[userKey];
    user.uploads = user.uploads || {};
    user.history = user.history || [];
    return user;
  }

  _ensureEphemeralUser(userKey) {
    if (!this.ephemeral.has(userKey)) {
      this.ephemeral.set(userKey, { uploads: new Map() });
    }
    return this.ephemeral.get(userKey);
  }

  async _ensureIdFactories() {
    if (!this._createUserId || !this._createFileId) {
      const customAlphabet = await loadCustomAlphabet();
      this._createUserId = customAlphabet(userIdAlphabet, 16);
      this._createFileId = customAlphabet(fileIdAlphabet, 20);
    }
  }

  async identifyUser(requestedKey) {
    await this._ensureIdFactories();
    if (requestedKey) {
      const exists = await this.store.readState((state) => state.users[requestedKey] ? true : false);
      if (exists) {
        this._ensureEphemeralUser(requestedKey);
        return { userKey: requestedKey, created: false };
      }
    }

    const result = await this.store.withState((state) => {
      let candidate = requestedKey;
      if (!candidate || state.users[candidate]) {
        do {
          candidate = this._createUserId();
        } while (state.users[candidate]);
      }
      if (!state.users[candidate]) {
        state.users[candidate] = {
          key: candidate,
          createdAt: this._now(),
          uploads: {},
          history: [],
        };
      }
      return { userKey: candidate, created: true };
    });

    this._ensureEphemeralUser(result.userKey);
    return result;
  }

  _decorateUpload(upload) {
    const clone = this._deepClone(upload);
    const missing = this._missingChunks(clone);
    clone.missingChunks = missing;
    clone.receivedCount = clone.totalChunks - missing.length;
    return clone;
  }

  _missingChunks(upload) {
    const missing = [];
    const received = upload.receivedChunks || {};
    for (let i = 0; i < upload.totalChunks; i += 1) {
      if (!received[i]) {
        missing.push(i);
      }
    }
    return missing;
  }

  async getUserSnapshot(userKey) {
    const persistentUser = await this.store.readState((state) => {
      const user = state.users[userKey];
      return user ? this._deepClone(user) : null;
    });

    if (!persistentUser && !this.ephemeral.has(userKey)) {
      return null;
    }

    const active = [];
    const paused = [];
    const history = persistentUser ? (persistentUser.history || []) : [];

    if (persistentUser) {
      const uploads = persistentUser.uploads || {};
      Object.values(uploads).forEach((upload) => {
        const decorated = this._decorateUpload(upload);
        if (decorated.status === 'paused') {
          paused.push(decorated);
        } else {
          active.push(decorated);
        }
      });
    }

    const ephemeralUser = this.ephemeral.get(userKey);
    if (ephemeralUser) {
      for (const upload of ephemeralUser.uploads.values()) {
        const decorated = this._decorateUpload(upload);
        if (decorated.status === 'paused') {
          paused.push(decorated);
        } else {
          active.push(decorated);
        }
      }
    }

    return { active, paused, history };
  }

  async createUpload(userKey, { fileName, fileSize, chunkSize, persist }) {
    await this._ensureIdFactories();
    const totalChunks = Math.ceil(fileSize / chunkSize);
    const uploadId = this._createFileId();
    const now = this._now();
    const baseMetadata = {
      id: uploadId,
      userKey,
      fileName,
      fileSize,
      chunkSize,
      totalChunks,
      persist: persist !== false,
      status: 'active',
      receivedChunks: {},
      receivedCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    if (baseMetadata.persist) {
      await this.store.withState((state) => {
        const user = this._ensureUserRecord(state, userKey);
        user.uploads[uploadId] = baseMetadata;
        return null;
      });
    } else {
      const user = this._ensureEphemeralUser(userKey);
      user.uploads.set(uploadId, baseMetadata);
    }

    await fs.ensureDir(path.join(this.uploadDir, uploadId));
    return this._decorateUpload(baseMetadata);
  }

  async getUpload(userKey, uploadId) {
    const ephemeralUser = this.ephemeral.get(userKey);
    if (ephemeralUser && ephemeralUser.uploads.has(uploadId)) {
      const upload = ephemeralUser.uploads.get(uploadId);
      return { location: 'memory', upload: this._decorateUpload(upload) };
    }

    const exists = await this.store.readState((state) => {
      const user = state.users[userKey];
      if (!user) return null;
      const upload = user.uploads ? user.uploads[uploadId] : null;
      return upload ? this._decorateUpload(upload) : null;
    });

    if (!exists) {
      return null;
    }

    return { location: 'persistent', upload: exists };
  }

  async recordChunk(userKey, uploadId, chunkIndex) {
    const memoryUser = this.ephemeral.get(userKey);
    if (memoryUser && memoryUser.uploads.has(uploadId)) {
      const upload = memoryUser.uploads.get(uploadId);
      this._markChunk(upload, chunkIndex);
      const decorated = this._decorateUpload(upload);
      return { upload: decorated, completed: decorated.missingChunks.length === 0 };
    }

    return this.store.withState((state) => {
      const user = state.users[userKey];
      if (!user || !user.uploads || !user.uploads[uploadId]) {
        throw new Error('upload_not_found');
      }
      const upload = user.uploads[uploadId];
      this._markChunk(upload, chunkIndex);
      const decorated = this._decorateUpload(upload);
      return { upload: decorated, completed: decorated.missingChunks.length === 0 };
    });
  }

  _markChunk(upload, chunkIndex) {
    if (chunkIndex < 0 || chunkIndex >= upload.totalChunks) {
      throw new Error('chunk_out_of_range');
    }
    if (!upload.receivedChunks) {
      upload.receivedChunks = {};
    }
    if (!upload.receivedChunks[chunkIndex]) {
      upload.receivedChunks[chunkIndex] = true;
    }
    upload.receivedCount = Object.keys(upload.receivedChunks).length;
    upload.status = 'active';
    upload.updatedAt = this._now();
  }

  async updateStatus(userKey, uploadId, status) {
    const memoryUser = this.ephemeral.get(userKey);
    if (memoryUser && memoryUser.uploads.has(uploadId)) {
      const upload = memoryUser.uploads.get(uploadId);
      upload.status = status;
      upload.updatedAt = this._now();
      return this._decorateUpload(upload);
    }

    return this.store.withState((state) => {
      const user = state.users[userKey];
      if (!user || !user.uploads || !user.uploads[uploadId]) {
        throw new Error('upload_not_found');
      }
      const upload = user.uploads[uploadId];
      upload.status = status;
      upload.updatedAt = this._now();
      return this._decorateUpload(upload);
    });
  }

  async finalizeUpload(userKey, uploadId) {
    const memoryUser = this.ephemeral.get(userKey);
    if (memoryUser && memoryUser.uploads.has(uploadId)) {
      const upload = memoryUser.uploads.get(uploadId);
      upload.status = 'completed';
      upload.completedAt = this._now();
      memoryUser.uploads.delete(uploadId);
      await this.store.withState((state) => {
        const user = this._ensureUserRecord(state, userKey);
        user.history.unshift(this._toHistoryEntry(upload));
        if (user.history.length > 200) {
          user.history = user.history.slice(0, 200);
        }
        return null;
      });
      return this._decorateUpload(upload);
    }

    return this.store.withState((state) => {
      const user = state.users[userKey];
      if (!user || !user.uploads || !user.uploads[uploadId]) {
        throw new Error('upload_not_found');
      }
      const upload = user.uploads[uploadId];
      upload.status = 'completed';
      upload.completedAt = this._now();
      const decorated = this._decorateUpload(upload);
      user.history.unshift(this._toHistoryEntry(upload));
      if (user.history.length > 200) {
        user.history = user.history.slice(0, 200);
      }
      delete user.uploads[uploadId];
      return decorated;
    });
  }

  _toHistoryEntry(upload) {
    return {
      id: upload.id,
      fileName: upload.fileName,
      fileSize: upload.fileSize,
      completedAt: upload.completedAt || this._now(),
      chunkSize: upload.chunkSize,
      totalChunks: upload.totalChunks,
      persist: upload.persist !== false,
    };
  }

  async clearHistory(userKey) {
    return this.store.withState((state) => {
      const user = state.users[userKey];
      if (!user) {
        throw new Error('user_not_found');
      }
      user.history = [];
      return [];
    });
  }

  async removeUpload(userKey, uploadId, { forget = false } = {}) {
    const memoryUser = this.ephemeral.get(userKey);
    if (memoryUser && memoryUser.uploads.has(uploadId)) {
      const upload = memoryUser.uploads.get(uploadId);
      memoryUser.uploads.delete(uploadId);
      if (!forget) {
        await this.store.withState((state) => {
          const user = this._ensureUserRecord(state, userKey);
          user.history.unshift(this._toHistoryEntry(upload));
          if (user.history.length > 200) {
            user.history = user.history.slice(0, 200);
          }
          return null;
        });
      }
      return this._decorateUpload(upload);
    }

    return this.store.withState((state) => {
      const user = state.users[userKey];
      if (!user || !user.uploads || !user.uploads[uploadId]) {
        throw new Error('upload_not_found');
      }
      const upload = user.uploads[uploadId];
      const decorated = this._decorateUpload(upload);
      if (!forget) {
        user.history.unshift(this._toHistoryEntry(upload));
        if (user.history.length > 200) {
          user.history = user.history.slice(0, 200);
        }
      }
      delete user.uploads[uploadId];
      return decorated;
    });
  }

  async assembleFile(upload) {
    const safeName = this._safeFileName(upload.fileName);
    const finalPath = path.join(this.finalDir, `${upload.id}-${safeName}`);
    await fs.ensureDir(this.finalDir);
    const writeStream = fs.createWriteStream(finalPath);

    for (let i = 0; i < upload.totalChunks; i += 1) {
      const chunkPath = path.join(this.uploadDir, upload.id, `${i}.part`);
      const exists = await fs.pathExists(chunkPath);
      if (!exists) {
        writeStream.destroy();
        throw new Error(`missing_chunk_${i}`);
      }
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(chunkPath);
        readStream.on('error', reject);
        readStream.on('end', resolve);
        readStream.pipe(writeStream, { end: false });
      });
    }

    writeStream.end();
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    await fs.remove(path.join(this.uploadDir, upload.id));
    return finalPath;
  }

  _safeFileName(name) {
    return path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
  }
}

module.exports = UploadManager;
