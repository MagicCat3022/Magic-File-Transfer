/* Reworked client script:
   - uploadOne(file, chunkSize, callbacks) now accepts callbacks and returns {upload_id}
   - upload workers honor pause via _abortMap and use AbortController per-chunk
   - uploadOne calls callbacks.onStarted/onProgress/onLog/onFinalize where appropriate
   - history list buttons (resume/pause/remove) are wired via delegation
   - Resume Last button will use selected file from file input to resume
*/
window.addEventListener('DOMContentLoaded', () => {
  const _finalizedSeen = new Set();
  const fileInput = document.getElementById('file');
  const startBtn = document.getElementById('start');
  const resumeBtn = document.getElementById('resume');
  const toggleStatsBtn = document.getElementById('toggleStatsBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');

  function log(msg){
    const div=document.getElementById('log');
    div.textContent += msg + "\n";
    div.scrollTop = div.scrollHeight;
    try{
      fetch('/session/log', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({log: msg})}).catch(()=>{});
    }catch(e){}
  }
  function fmtBytes(b){ const u=['B','KB','MB','GB','TB']; let i=0; let x=b; while(x>=1024 && i<u.length-1){ x/=1024; i++; } return x.toFixed(1)+' '+u[i]; }
  function renderStats(s, path){
    const d = document.getElementById('stats');
    d.style.display = 'block';
    const avg = s.avg_upload_bps ? (s.avg_upload_bps/1024/1024).toFixed(3) + " MiB/s" : "N/A";
    d.innerHTML = `
      <div style="font-size:.95rem;">
        <strong>Upload stats</strong><br/>
        bytes: ${s.bytes_received} (${fmtBytes(s.bytes_received)})<br/>
        upload active: ${s.upload_active_seconds}s &nbsp; downtime: ${s.downtime_seconds}s<br/>
        assembly: ${s.assembly_seconds}s<br/>
        avg: ${avg}<br/>
        peak conc: ${s.peak_concurrency || 0} &nbsp; avg conc: ${s.avg_concurrency ? s.avg_concurrency.toFixed(2) : 'N/A'}<br/>
        ${path ? `<a href="${path}" target="_blank">Download file</a>` : ''}
      </div>
    `;
    const det = document.getElementById('statsDetail');
    det.textContent = JSON.stringify(s, null, 2);
  }

  if(toggleStatsBtn){
    toggleStatsBtn.addEventListener('click', function(){
      const det = document.getElementById('statsDetail');
      if(!det) return;
      if(det.style.display === 'none' || det.style.display === ''){
        det.style.display = 'block';
        this.textContent = 'Hide Upload Stats';
      } else {
        det.style.display = 'none';
        this.textContent = 'Upload Stats';
      }
    });
  }

  let _livePoll = null;
  function startLivePoll(uploadId){
    stopLivePoll();
    _livePoll = setInterval(async ()=>{
      try{
        const r = await fetch(`/status/${uploadId}`);
        if(!r.ok) return;
        const body = await r.json();
        if(body.stats){
          renderStats(body.stats, null);
          document.getElementById('statsDetail').textContent = "Live:\n" + JSON.stringify(body.stats, null, 2);
        }
        if(body.finalized && !_finalizedSeen.has(uploadId)){
          _finalizedSeen.add(uploadId);
          log("✅ Server reports finalized.");
          stopLivePoll();
        }
      }catch(e){}
    }, 1000);
  }
  function stopLivePoll(){ if(_livePoll){ clearInterval(_livePoll); _livePoll = null; } }

  async function sha256(file){
    try{
      if(!window.crypto || !crypto.subtle || !crypto.subtle.digest) throw new Error("no webcrypto");
      const buf = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
      const view = new Uint8Array(hashBuffer);
      return Array.from(view).map(b=>b.toString(16).padStart(2,'0')).join('');
    }catch(e){
      log("⚠️ WebCrypto SHA-256 unavailable; proceeding without checksum (resumes use filename+size).");
      return "";
    }
  }

  /* In-memory abort/pause map */
  const _abortMap = new Map(); // uploadId -> {controllers: Map(idx->AbortController), paused:bool}

  async function uploadOne(file, chunkSize, callbacks = {}){
    callbacks = callbacks || {};
    const cb = (name, ...args)=>{ try{ if(typeof callbacks[name] === 'function') callbacks[name](...args); }catch(e){} };

    const checksum = await sha256(file);
    const totalChunks = Math.ceil(file.size / chunkSize);
    cb('onLog', `Preparing: ${file.name} (${fmtBytes(file.size)}), chunks=${totalChunks}, sha256=${checksum.slice(0,12)}…`);

    let res = await fetch('/initiate', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
      filename: file.name, size: file.size, chunk_size: chunkSize, checksum
    })});
    if(!res.ok){ cb('onLog', `Initiate failed: ${res.status}`); return null; }
    const init = await res.json();
    const id = init.upload_id;
    const have = new Set(init.received_indices || []);
    cb('onLog', `Upload ID: ${id}; already have ${have.size}/${totalChunks}`);
    cb('onStarted', id);

    // start live stats polling
    startLivePoll(id);

    // ensure abort entry exists
    const entry = _abortMap.get(id) || {controllers: new Map(), paused: false};
    _abortMap.set(id, entry);

    const parallel = navigator.hardwareConcurrency ? Math.min(6, navigator.hardwareConcurrency) : 4;
    let sent = have.size;
    let bytesSent = 0;
    for(const idx of have){
      const partSize = (idx === totalChunks - 1) ? (file.size - idx * chunkSize) : chunkSize;
      bytesSent += partSize;
    }

    function updateProgress(){
      const pct = Math.floor((sent/totalChunks)*100);
      document.getElementById('prog').value = pct; document.getElementById('stat').textContent = `${pct}% (${sent}/${totalChunks})`;
      document.getElementById('bytes').textContent = `${fmtBytes(bytesSent)} uploaded`;
      cb('onProgress', bytesSent, sent, totalChunks, id);
    }
    updateProgress();

    async function sendChunk(i){
      if(have.has(i)) return true;
      const start = i*chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const blob = file.slice(start, end);

      for(let attempt=1; attempt<=3; attempt++){
        // if paused, wait until resumed or break out
        while(entry.paused){
          await new Promise(r=>setTimeout(r, 250));
        }
        const ac = new AbortController();
        entry.controllers.set(i, ac);
        try{
          const r = await fetch(`/upload/${id}/${i}`, {method:'PUT', headers:{'Content-Type':'application/octet-stream'}, body: blob, signal: ac.signal});
          entry.controllers.delete(i);
          if(r.ok){
            sent++;
            have.add(i);
            bytesSent += blob.size;
            updateProgress();
            cb('onLog', `Chunk ${i} uploaded (${sent}/${totalChunks})`);
            return true;
          } else {
            cb('onLog', `Chunk ${i} failed (${r.status}), try ${attempt}`);
          }
        }catch(e){
          entry.controllers.delete(i);
          // if aborted by user pause, stop trying and return false to let re-queue later
          if(e && e.name === 'AbortError'){
            cb('onLog', `Chunk ${i} aborted (pause).`);
            return false;
          }
          cb('onLog', `Chunk ${i} error: ${e}. try ${attempt}`);
        }
        await new Promise(res=>setTimeout(res, 500*attempt));
      }
      return false;
    }

    // simple worker pool that respects pause
    let next = 0;
    while(next < totalChunks && have.has(next)) next++;
    const workers = new Array(parallel).fill(0).map(async ()=>{
      while(true){
        // respect pause at scheduling time
        while(entry.paused){
          await new Promise(r=>setTimeout(r, 250));
        }
        // find next missing index in a safe loop
        let i = -1;
        // atomically pick next
        while(next < totalChunks && have.has(next)) next++;
        if(next >= totalChunks) break;
        i = next; next++;
        const ok = await sendChunk(i);
        if(!ok){
          // if chunk failed due to pause, allow re-queue when resumed (it remains missing)
          if(entry.paused) {
            // step back so it will be retried
            have.delete(i);
          } else {
            // if permanent failure, leave missing for user to retry later
            have.delete(i);
          }
        } else {
          have.add(i);
        }
      }
    });
    await Promise.all(workers);

    if(sent === totalChunks){
      cb('onLog', "⚠️ All chunks uploaded. Server-side assembly is starting — file not ready yet.");
      cb('onLog', `Finalizing ${id}...`);
      showAssemblingHint(have.size, totalChunks);
      const fr = await fetch(`/finalize/${id}`, {method:'POST'});
      if(fr.ok){
        const body = await fr.json();
        cb('onLog', `✅ Finalized to ${body.path}`);
        if(body.stats) cb('onFinalize', body.path, body.stats, id);
        stopLivePoll();
      } else {
        cb('onLog', `Finalize failed: ${fr.status}`);
      }
    } else {
      const sr = await fetch(`/status/${id}`); const s = await sr.json();
      cb('onLog', `⚠️ Incomplete; missing ${s.missing.length} chunks.`);
      localStorage.setItem('lastUploadId', id);
    }
    return { upload_id: id };
  }

  function showAssemblingHint(received, total){
    const d = document.getElementById('stats');
    if(!d) return;
    d.style.display = 'block';
    d.innerHTML = `<div style="font-size:.95rem;"><strong>All chunks uploaded — server is assembling the file.</strong><br/>Received ${received}/${total} chunks. The file will be available after assembly completes.</div>`;
  }

  /* uploads container UI */
  const uploadsContainer = document.createElement('div');
  uploadsContainer.id = 'uploadsContainer';
  uploadsContainer.style.marginTop = '.75rem';
  document.querySelector('.card')?.after(uploadsContainer);

  function createFileCard(uploadId, filename, totalBytes){
    const c = document.createElement('div');
    c.className = 'file-card';
    c.dataset.uploadId = uploadId;
    c.style.border = '1px solid #eee';
    c.style.padding = '.5rem';
    c.style.marginBottom = '.5rem';
    c.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center">
        <div style="min-width:0">
          <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:420px">${filename}</div>
          <div style="font-size:.85rem; color:#666" id="meta-${uploadId}">0 B • 0%</div>
        </div>
        <div style="display:flex; gap:.4rem; align-items:center">
          <button data-action="pause" data-id="${uploadId}" class="btn small">Pause</button>
          <button data-action="resume" data-id="${uploadId}" class="btn small" style="display:none">Resume</button>
          <button data-action="details" data-id="${uploadId}" class="btn small">Details</button>
        </div>
      </div>
      <div style="margin-top:.5rem">
        <progress id="prog-${uploadId}" value="0" max="100" style="width:100%"></progress>
      </div>
      <pre id="log-${uploadId}" style="font-family:ui-monospace,monospace; font-size:.8rem; max-height:120px; overflow:auto; margin-top:.5rem; background:#fafafa; padding:.4rem; display:none"></pre>
    `;
    uploadsContainer.prepend(c);
    return c;
  }

  function updateFileProgress(uploadId, bytes, sentChunks, totalChunks){
    const meta = document.getElementById(`meta-${uploadId}`);
    const prog = document.getElementById(`prog-${uploadId}`);
    const pct = totalChunks ? Math.floor((sentChunks/totalChunks)*100) : 0;
    if(meta) meta.textContent = `${fmtBytes(bytes)} • ${pct}%`;
    if(prog) prog.value = pct;
  }

  function appendFileLog(uploadId, msg){
    const el = document.getElementById(`log-${uploadId}`);
    if(!el) return;
    el.style.display = 'block';
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
  }

  uploadsContainer.addEventListener('click', (ev)=>{
    const b = ev.target.closest('button');
    if(!b) return;
    const id = b.dataset.id;
    const act = b.dataset.action;
    const entry = _abortMap.get(id) || {controllers:new Map(), paused:false};
    if(act==='pause'){
      entry.paused = true;
      for(const ac of entry.controllers.values()) try{ ac.abort(); }catch(e){}
      _abortMap.set(id, entry);
      b.style.display = 'none';
      b.parentElement.querySelector('[data-action="resume"]').style.display = '';
      addOrUpdateHistory({upload_id:id, status:'paused'});
      appendFileLog(id, 'Paused by user.');
    } else if(act==='resume'){
      entry.paused = false;
      _abortMap.set(id, entry);
      b.style.display = 'none';
      b.parentElement.querySelector('[data-action="pause"]').style.display = '';
      addOrUpdateHistory({upload_id:id, status:'uploading'});
      appendFileLog(id, 'Resumed — select same file if needed and click Resume in file row.');
    } else if(act==='details'){
      const l = document.getElementById(`log-${id}`);
      if(l) l.style.display = l.style.display==='none' ? 'block' : 'none';
    }
  });

  async function uploadOneWithUI(file, chunkSize, callbacks = {}){
    const startedAt = Date.now();
    const idPlaceholder = 'pending-' + Math.random().toString(36).slice(2,9);
    const card = createFileCard(idPlaceholder, file.name, file.size);
    addOrUpdateHistory({upload_id:idPlaceholder, filename:file.name, size:file.size, chunk_size:chunkSize, total_chunks: Math.ceil(file.size/chunkSize), bytes_sent:0, status:'uploading', started_at: startedAt});

    // Provide callbacks that update UI
    const cb = {
      onStarted: (upload_id)=>{
        card.dataset.uploadId = upload_id;
        const progEl = document.getElementById(`prog-${idPlaceholder}`);
        if(progEl) progEl.id = `prog-${upload_id}`;
        const meta = document.getElementById(`meta-${idPlaceholder}`);
        if(meta) meta.id = `meta-${upload_id}`;
        const logEl = document.getElementById(`log-${idPlaceholder}`);
        if(logEl) logEl.id = `log-${upload_id}`;
        // replace the temporary placeholder history entry with the real upload id
        replaceHistoryId(idPlaceholder, upload_id, { filename:file.name, size:file.size, chunk_size:chunkSize, total_chunks: Math.ceil(file.size/chunkSize), status:'uploading', started_at: startedAt });
      },
      onProgress: (bytes, sentChunks, totalChunks, upload_id)=>{
        const uid = upload_id || idPlaceholder;
        updateFileProgress(uid, bytes, sentChunks, totalChunks);
        addOrUpdateHistory({upload_id: uid, bytes_sent: bytes});
      },
      onLog: (msg, ...rest)=>{
        const possibleId = rest.length ? rest[0] : null;
        appendFileLog(possibleId || idPlaceholder, msg);
      },
      onFinalize: (path, stats, upload_id)=>{
        const uid = upload_id || idPlaceholder;
        appendFileLog(uid, `Finalized: ${path}`);
        addOrUpdateHistory({upload_id: uid, status:'completed', finished_at: Date.now(), bytes_sent: file.size});
      }
    };

    try{
      const result = await uploadOne(file, chunkSize, cb);
      // ensure history maps the real id (uploadOne calls onStarted earlier)
      if(result && result.upload_id){
        addOrUpdateHistory({upload_id: result.upload_id});
        return result;
      }
    }catch(e){
      appendFileLog(idPlaceholder, `Upload error: ${e}`);
      addOrUpdateHistory({upload_id:idPlaceholder, status:'error'});
    }
  }

  if(startBtn){
    startBtn.addEventListener('click', async ()=>{
      const files = Array.from(fileInput.files || []);
      if(files.length === 0){ alert('Pick one or more files first'); return; }
      const chunkSize = Math.min(parseInt(document.getElementById('chunkSize').value || '2097152', 10), 67108864);
      for(const f of files){
        uploadOneWithUI(f, chunkSize);
        await new Promise(r=>setTimeout(r, 100));
      }
    });
  }

  if(resumeBtn){
    resumeBtn.addEventListener('click', async ()=>{
      // If user already selected a resume target (from history), use it.
      const resumeTarget = localStorage.getItem('mf_resume_upload_id');
      const chosenFile = (fileInput.files && fileInput.files[0]) || null;
      if(!resumeTarget){
        alert('Pick a history entry "Resume" first (it will mark which upload to resume), then select the original file and click Resume Last.');
        return;
      }
      if(!chosenFile){
        // prompt user to select the file
        alert('Select the original file to resume in the file picker, then click Resume Last again.');
        fileInput.focus();
        fileInput.click();
        return;
      }
      const chunkSize = Math.min(parseInt(document.getElementById('chunkSize').value || '2097152', 10), 67108864);
      await uploadOneWithUI(chosenFile, chunkSize);
      localStorage.removeItem('mf_resume_upload_id');
    });
  }

  if(clearHistoryBtn){
    clearHistoryBtn.addEventListener('click', ()=>{ if(confirm("Clear upload history?")) clearHistory(); });
  }

  const HISTORY_KEY = "mf_history_v1";
  function loadHistory(){ try{ return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch(e){ return []; } }
  function saveHistory(h){ try{ localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch(e){} }
  function fmtDate(ts){ return ts ? new Date(ts).toLocaleString() : "—"; }

  function renderHistory(){
    const list = document.getElementById('historyList');
    if(!list) return;
    list.innerHTML = "";
    const h = loadHistory();
    if(!h || h.length===0){ list.textContent = "No uploads yet."; return; }
    for(const e of h){
      const div = document.createElement('div');
      div.style.padding = ".35rem .5rem";
      div.style.borderBottom = "1px solid #eee";
      div.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:8px">
          <div style="min-width:0">
            <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:380px">${e.filename || e.upload_id}</div>
            <div style="font-size:.8rem; color:#666">${e.status || 'idle'} • ${e.bytes_sent? fmtBytes(e.bytes_sent) : '0 B'} • ${e.total_chunks || '?'} chunks</div>
            <div style="font-size:.75rem; color:#888">started: ${fmtDate(e.started_at)}</div>
          </div>
          <div style="display:flex; gap:.4rem; align-items:center">
            ${ e.finalized ? 
               `<button data-action="remove" data-id="${e.upload_id}" class="btn small">Remove</button>` :
               `<button data-action="pause" data-id="${e.upload_id}" class="btn small">Pause</button>
                <button data-action="resume" data-id="${e.upload_id}" class="btn small">Resume</button>
                <button data-action="remove" data-id="${e.upload_id}" class="btn small">Remove</button>`
            }
          </div>
        </div>
      `;
      list.appendChild(div);
    }
  }
  renderHistory();

   function addOrUpdateHistory(entry){
     const h = loadHistory();
     const i = h.findIndex(x=>x.upload_id===entry.upload_id);
     if(i>=0) h[i] = {...h[i], ...entry};
     else h.unshift(entry);
     saveHistory(h.slice(0,128));
     renderHistory();
   }

  // Replace a temporary/history entry id (eg. pending-...) with the real upload_id returned by server.
  // Merges fields from extra into the updated entry and preserves ordering.
  function replaceHistoryId(oldId, newId, extra = {}){
    if(!oldId || !newId || oldId === newId) return;
    const h = loadHistory();
    const i = h.findIndex(x => x.upload_id === oldId);
    if(i >= 0){
      const merged = {...h[i], ...extra, upload_id: newId};
      // remove old and insert merged at same position (or move to front)
      h.splice(i, 1);
      h.unshift(merged);
      saveHistory(h.slice(0,128));
      renderHistory();
    } else {
      // fallback to normal add if old wasn't found
      addOrUpdateHistory({...extra, upload_id: newId});
    }
  }

   function removeHistory(upload_id){
     const h = loadHistory().filter(x=>x.upload_id!==upload_id);
     saveHistory(h); renderHistory();
   }
   function clearHistory(){ localStorage.removeItem(HISTORY_KEY); renderHistory(); }

   window.addOrUpdateHistory = addOrUpdateHistory;
   window.removeHistory = removeHistory;
   window.clearHistory = clearHistory;
   window.loadHistory = loadHistory;
   window.saveHistory = saveHistory;

   // Delegate history list clicks (resume/pause/remove)
   const historyList = document.getElementById('historyList');
   if(historyList){
     historyList.addEventListener('click', (ev)=>{
       const b = ev.target.closest('button');
       if(!b) return;
       const id = b.dataset.id;
       const act = b.dataset.action;
       if(act === 'resume'){
         // mark resume target and prompt user to select file and click Resume Last
         localStorage.setItem('mf_resume_upload_id', id);
         log(`Resume target set: ${id}. Select the original file and click Resume Last.`);
         alert('Resume target selected. Now pick the original file in the file chooser and click "Resume Last".');
       } else if(act === 'pause'){
         // If there's an active upload instance, abort its controllers to pause immediately.
         const entry = _abortMap.get(id);
         if(entry){
           entry.paused = true;
           for(const ac of entry.controllers.values()) try{ ac.abort(); }catch(e){}
           _abortMap.set(id, entry);
           addOrUpdateHistory({upload_id:id, status:'paused'});
           log(`Paused active upload ${id}`);
         } else {
           // Not actively uploading in this tab: mark history as paused and set resume target.
           addOrUpdateHistory({upload_id:id, status:'paused'});
           localStorage.setItem('mf_resume_upload_id', id);
           log(`Marked upload ${id} as paused (not active in this tab). Use Resume Last to continue.`)
           alert('Upload marked paused. To resume, select the original file in the picker and click "Resume Last".');
         }
       } else if(act === 'remove'){
         if(confirm('Remove this history entry?')){
           removeHistory(id);
         }
       }
     });
   }
});