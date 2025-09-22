const fileInput = document.getElementById('fileInput');
const chunkSizeSelect = document.getElementById('chunkSize');
const startBtn = document.getElementById('startBtn');
const persistToggle = document.getElementById('persistToggle');
const packetSizeLabel = document.getElementById('packetSizeLabel');
const userKeyLabel = document.getElementById('userKey');
const logView = document.getElementById('log');
const activeContainer = document.getElementById('activeUploads');
const pausedContainer = document.getElementById('pausedUploads');
const historyContainer = document.getElementById('history');
const clearLogBtn = document.getElementById('clearLog');
const clearHistoryBtn = document.getElementById('clearHistory');
const autoChunkBtn = document.getElementById('autoChunk');
const autoChunkHint = document.getElementById('autoChunkHint');

let userKey = null;
let uploadsSnapshot = { active: [], paused: [], history: [] };
const uploadTasks = new Map();

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return '0 B';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatPercent(upload) {
  if (!upload.totalChunks) return '0%';
  const percent = (upload.receivedCount / upload.totalChunks) * 100;
  return `${percent.toFixed(percent === 100 ? 0 : 1)}%`;
}

function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  logView.textContent += `\n[${timestamp}] ${message}`;
  logView.scrollTop = logView.scrollHeight;
}

function setSnapshot(snapshot) {
  uploadsSnapshot = {
    active: snapshot?.active ?? [],
    paused: snapshot?.paused ?? [],
    history: snapshot?.history ?? [],
  };
  render();
}

function updateSnapshotWithUpload(upload) {
  if (!upload) return;
  const filtered = (items) => items.filter((item) => item.id !== upload.id);
  uploadsSnapshot.active = filtered(uploadsSnapshot.active);
  uploadsSnapshot.paused = filtered(uploadsSnapshot.paused);

  if (upload.status === 'active') {
    uploadsSnapshot.active.push(upload);
  } else if (upload.status === 'paused') {
    uploadsSnapshot.paused.push(upload);
  }
  render();
}

function renderList(container, uploads) {
  if (!uploads.length) {
    container.innerHTML = `<small>${container.dataset.emptyText}</small>`;
    return;
  }

  container.innerHTML = uploads
    .map((upload) => {
      const percent = formatPercent(upload);
      const missing = upload.missingChunks?.length ?? 0;
      const chunkCount = `${upload.receivedCount}/${upload.totalChunks} packets`;
      const actions = [];
      if (upload.status === 'active') {
        actions.push(`<button data-upload-action="pause" data-upload-id="${upload.id}" class="secondary">Pause</button>`);
        actions.push(`<button data-upload-action="cancel" data-upload-id="${upload.id}" class="secondary">Cancel</button>`);
      } else if (upload.status === 'paused') {
        actions.push(`<button data-upload-action="resume" data-upload-id="${upload.id}" class="secondary">Resume</button>`);
        const forgetAction = upload.persist ? 'cancel' : 'forget';
        const label = upload.persist ? 'Cancel' : 'Forget';
        actions.push(`<button data-upload-action="${forgetAction}" data-upload-id="${upload.id}" class="secondary">${label}</button>`);
      }

      return `
        <div class="upload-item" data-upload-id="${upload.id}">
          <h3>${upload.fileName}</h3>
          <div class="upload-meta">
            <span>${formatBytes(upload.fileSize)}</span>
            <span>${chunkCount}</span>
            <span>${missing} packets remaining</span>
            <span>${upload.persist ? 'Persistent' : 'Ephemeral'}</span>
          </div>
          <progress value="${upload.receivedCount}" max="${upload.totalChunks}"></progress>
          <div class="upload-meta">
            <span>${percent}</span>
            <span>Last updated ${new Date(upload.updatedAt).toLocaleTimeString()}</span>
          </div>
          <div class="control-row" style="margin-top:0.5rem">${actions.join('')}</div>
        </div>
      `;
    })
    .join('\n');
}

function renderHistory(history) {
  if (!history.length) {
    historyContainer.innerHTML = `<small>${historyContainer.dataset.emptyText}</small>`;
    return;
  }

  historyContainer.innerHTML = history
    .map((entry) => {
      const completed = new Date(entry.completedAt);
      const chunkInfo = `${formatBytes(entry.chunkSize)} packets × ${entry.totalChunks}`;
      return `
        <div class="history-item">
          <div>
            <strong>${entry.fileName}</strong><br />
            <small>${formatBytes(entry.fileSize)} • ${chunkInfo} • ${entry.persist ? 'Persistent' : 'Ephemeral'}</small>
          </div>
          <div><small>${completed.toLocaleString()}</small></div>
        </div>
      `;
    })
    .join('\n');
}

function render() {
  renderList(activeContainer, uploadsSnapshot.active);
  renderList(pausedContainer, uploadsSnapshot.paused);
  renderHistory(uploadsSnapshot.history);
}

async function identifyUser() {
  const storedKey = localStorage.getItem('mft.userKey');
  const response = await fetch('/api/users/identify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userKey: storedKey }),
  });
  if (!response.ok) {
    throw new Error('Unable to reach server');
  }
  const data = await response.json();
  userKey = data.userKey;
  localStorage.setItem('mft.userKey', userKey);
  userKeyLabel.textContent = userKey;
  setSnapshot(data.uploads);
  log(`Signed in with user key ${userKey}.`);
}

function updatePacketLabel() {
  const size = Number(chunkSizeSelect.value);
  packetSizeLabel.textContent = formatBytes(size);
}

class UploadTask {
  constructor(file, uploadMeta, options) {
    this.file = file;
    this.meta = uploadMeta;
    this.userKey = options.userKey;
    this.chunkSize = options.chunkSize;
    this.persist = options.persist;
    this.queue = uploadMeta.missingChunks ? uploadMeta.missingChunks.slice() : [];
    this.queue.sort((a, b) => a - b);
    this.paused = false;
    this.cancelled = false;
    this.currentController = null;
    this.resumeResolver = null;
    this.loopPromise = null;
  }

  start() {
    if (this.loopPromise) return this.loopPromise;
    this.loopPromise = this.processQueue();
    return this.loopPromise;
  }

  pause() {
    this.paused = true;
    if (this.currentController) {
      this.currentController.abort();
    }
  }

  cancel() {
    this.cancelled = true;
    this.pause();
    if (this.resumeResolver) {
      this.resumeResolver();
      this.resumeResolver = null;
    }
  }

  resume(upload) {
    if (upload) {
      this.meta = upload;
      this.queue = upload.missingChunks ? upload.missingChunks.slice().sort((a, b) => a - b) : [];
    }
    this.paused = false;
    if (this.resumeResolver) {
      this.resumeResolver();
      this.resumeResolver = null;
    }
    if (!this.loopPromise) {
      this.start();
    }
  }

  async processQueue() {
    while (!this.cancelled) {
      if (this.paused) {
        await new Promise((resolve) => {
          this.resumeResolver = resolve;
        });
        this.resumeResolver = null;
        if (this.cancelled) break;
        if (this.paused) continue;
      }

      const nextIndex = this.queue.shift();
      if (nextIndex === undefined) {
        break;
      }

      try {
        const status = await this.uploadChunk(nextIndex);
        if (status === 'completed') {
          this.cancelled = true;
          uploadTasks.delete(this.meta.id);
          break;
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          this.queue.unshift(nextIndex);
          continue;
        }
        log(`[${this.file.name}] chunk ${nextIndex} failed: ${error.message}`);
        this.queue.unshift(nextIndex);
        this.pause();
        if (this.persist) {
          try {
            await postUploadAction(this.meta.id, 'pause');
          } catch (actionError) {
            log(`Failed to notify pause: ${actionError.message}`);
          }
          log(`[${this.file.name}] paused due to network error.`);
        } else {
          try {
            await postUploadAction(this.meta.id, 'forget');
          } catch (actionError) {
            log(`Failed to discard upload: ${actionError.message}`);
          }
          uploadTasks.delete(this.meta.id);
          log(`[${this.file.name}] upload cancelled (non-persistent).`);
          this.cancelled = true;
        }
      }
    }
  }

  async uploadChunk(index) {
    const start = index * this.chunkSize;
    const end = Math.min(start + this.chunkSize, this.file.size);
    const blob = this.file.slice(start, end);

    const form = new FormData();
    form.append('userKey', this.userKey);
    form.append('chunkIndex', String(index));
    form.append('chunk', blob, `${this.file.name}.part`);

    this.currentController = new AbortController();
    const response = await fetch(`/api/uploads/${this.meta.id}/chunk`, {
      method: 'POST',
      body: form,
      signal: this.currentController.signal,
    });

    if (!response.ok) {
      throw new Error(`Server responded ${response.status}`);
    }

    const data = await response.json();
    if (data.status === 'completed') {
      if (data.uploads) {
        setSnapshot(data.uploads);
      }
      log(`[${this.file.name}] upload complete.`);
      return 'completed';
    }

    if (data.upload) {
      this.meta = data.upload;
      this.queue = data.upload.missingChunks.slice().sort((a, b) => a - b);
      updateSnapshotWithUpload(data.upload);
      log(`[${this.file.name}] ${formatPercent(data.upload)} complete.`);
    }

    return 'ok';
  }
}

async function postUploadAction(uploadId, action) {
  const response = await fetch(`/api/uploads/${uploadId}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userKey, action }),
  });
  if (!response.ok) {
    throw new Error(`Action ${action} failed`);
  }
  const data = await response.json();
  if (data.uploads) {
    setSnapshot(data.uploads);
  }
  return data;
}

async function startUploads() {
  if (!userKey) {
    log('Waiting for server connection. Please try again in a moment.');
    return;
  }

  const files = Array.from(fileInput.files || []);
  if (!files.length) {
    log('Select files to upload first.');
    return;
  }

  const chunkSize = Number(chunkSizeSelect.value);
  const persist = persistToggle.checked;

  for (const file of files) {
    const pausedMatch = uploadsSnapshot.paused.find((upload) => upload.fileName === file.name && upload.fileSize === file.size);
    if (pausedMatch) {
      try {
        const metaResponse = await fetch(`/api/uploads/${pausedMatch.id}?userKey=${encodeURIComponent(userKey)}`);
        if (!metaResponse.ok) {
          throw new Error('Failed to load paused upload metadata');
        }
        const metaData = await metaResponse.json();
        const uploadMeta = metaData.upload;
        if (!uploadMeta) {
          throw new Error('Upload metadata unavailable');
        }
        const task = new UploadTask(file, uploadMeta, {
          userKey,
          chunkSize: uploadMeta.chunkSize,
          persist: pausedMatch.persist,
        });
        uploadTasks.set(pausedMatch.id, task);
        const resumeData = await postUploadAction(pausedMatch.id, 'resume');
        if (resumeData.upload) {
          task.resume(resumeData.upload);
        }
        log(`Resuming ${file.name} (${formatBytes(file.size)}).`);
      } catch (error) {
        log(`Failed to resume ${file.name}: ${error.message}`);
      }
      continue;
    }

    try {
      const response = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userKey,
          fileName: file.name,
          fileSize: file.size,
          chunkSize,
          persist,
        }),
      });
      if (!response.ok) {
        throw new Error(`Failed to create upload (${response.status})`);
      }
      const data = await response.json();
      const upload = data.upload;
      updateSnapshotWithUpload(upload);
      const task = new UploadTask(file, upload, { userKey, chunkSize, persist });
      uploadTasks.set(upload.id, task);
      task.start();
      log(`Uploading ${file.name} (${formatBytes(file.size)}) with ${formatBytes(chunkSize)} packets.`);
    } catch (error) {
      log(`Failed to start upload for ${file.name}: ${error.message}`);
    }
  }

  fileInput.value = '';
}


async function clearHistory() {
  if (!userKey) return;
  const response = await fetch('/api/uploads/history', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userKey }),
  });
  if (!response.ok) {
    log('Failed to clear history.');
    return;
  }
  const data = await response.json();
  setSnapshot(data);
  log('Upload history cleared.');
}

function handleUploadButtonClick(event) {
  const action = event.target?.dataset?.uploadAction;
  const uploadId = event.target?.dataset?.uploadId;
  if (!action || !uploadId) return;
  event.preventDefault();

  const task = uploadTasks.get(uploadId);
  if (action === 'pause' && task) {
    task.pause();
  }
  if ((action === 'cancel' || action === 'forget') && task) {
    task.cancel();
    uploadTasks.delete(uploadId);
  }

  postUploadAction(uploadId, action)
    .then((data) => {
      const labelMap = {
        pause: 'Paused',
        resume: 'Resumed',
        cancel: 'Cancelled',
        forget: 'Forgot',
      };
      const targetName = data.upload?.fileName || uploadId;
      if (labelMap[action]) {
        log(`${labelMap[action]} ${targetName}.`);
      }
      if (action === 'resume') {
        const updated = data.upload;
        const resumeTask = uploadTasks.get(uploadId);
        if (resumeTask) {
          resumeTask.resume(updated);
        } else if (updated) {
          log(`Select the original file to resume upload ${updated.fileName}.`);
        }
      }
    })
    .catch((error) => {
      log(`Action ${action} failed: ${error.message}`);
    });
}

async function runAutoChunkSizing() {
  autoChunkBtn.disabled = true;
  autoChunkHint.textContent = 'Testing bandwidth…';
  try {
    const sampleSize = 512 * 1024;
    const buffer = new Uint8Array(sampleSize);
    const form = new FormData();
    form.append('sample', new Blob([buffer]), 'probe.bin');
    const response = await fetch('/api/network/probe', {
      method: 'POST',
      body: form,
    });
    if (!response.ok) {
      throw new Error(`Probe failed (${response.status})`);
    }
    const data = await response.json();
    const elapsed = data.elapsedMs ?? 0;
    const throughput = data.bytes && elapsed ? data.bytes / (elapsed / 1000) : 0;
    const targetSeconds = 4;
    const desiredSize = throughput * targetSeconds;
    const options = Array.from(chunkSizeSelect.options).map((opt) => Number(opt.value));
    const best = options.reduce((closest, size) => {
      if (!closest) return size;
      const diff = Math.abs(size - desiredSize);
      const closestDiff = Math.abs(closest - desiredSize);
      if (diff < closestDiff) return size;
      if (diff === closestDiff && size > closest) return size;
      return closest;
    }, options[0]);
    chunkSizeSelect.value = String(best);
    updatePacketLabel();
    log(`Auto selected ${formatBytes(best)} packets (~${formatBytes(throughput)}/s).`);
    autoChunkHint.textContent = `Recommended: ${formatBytes(best)}`;
  } catch (error) {
    autoChunkHint.textContent = 'Auto sizing unavailable';
    log(`Auto chunk sizing failed: ${error.message}`);
  } finally {
    autoChunkBtn.disabled = false;
  }
}

clearLogBtn.addEventListener('click', () => {
  logView.textContent = 'Ready.';
});

clearHistoryBtn.addEventListener('click', clearHistory);
startBtn.addEventListener('click', startUploads);
chunkSizeSelect.addEventListener('change', updatePacketLabel);
autoChunkBtn.addEventListener('click', runAutoChunkSizing);
document.addEventListener('click', handleUploadButtonClick);

identifyUser().catch((error) => {
  log(`Failed to initialise: ${error.message}`);
});
updatePacketLabel();
