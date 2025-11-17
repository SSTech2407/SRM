// scanner.js — multi-face optimized (1..10) + batching + queue
(() => {
  const BASE = (localStorage.getItem('SRM_API_BASE') || 'http://localhost:4000').replace(/\/$/, '');
  const API_BASE = BASE + '/api/v1'; // <<-- change this if backend is on other host/port
  const MAX_FACES = 10;            // maximum faces to process per frame (configurable)
  const SCAN_INTERVAL_MS = 300;    // how often we run recognition (throttle)
  const DISTANCE_THRESHOLD = 0.45; // matching threshold (tune 0.38..0.55)
  const MODEL_URL = './models';    // local folder with face-api models

  // DOM
  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay'); // canvas
  const logEl = document.getElementById('log');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const syncBtn = document.getElementById('syncBtn');
  const loadEmbBtn = document.getElementById('loadEmbBtn');
  const registerBtn = document.getElementById('registerFaceBtn'); // optional (older UI)
  const captureBtn = document.getElementById('captureBtn'); // register-mode capture
  const classSelect = document.getElementById('classSelect');
  const sectionSelect = document.getElementById('sectionSelect');

  if (!video || !overlay || !startBtn || !stopBtn || !syncBtn || !loadEmbBtn) {
    console.warn('scanner.js: missing expected DOM elements — check scanner.html IDs');
  }

  // Small safe IndexedDB fallback if window.srmDB not present.
  const fakeDB = {
    _q: [],
    add: async (r) => { fakeDB._q.push(r); return true; },
    getAll: async () => fakeDB._q.slice(),
    clear: async () => { fakeDB._q.length = 0; return true; }
  };
  window.srmDB = window.srmDB || fakeDB;

  let stream = null;
  let detectionsInterval = null;
  let faceMatcher = null; // face-api.FaceMatcher
  let labeledDescriptors = []; // [{label: student_id, descriptors: [Float32Array, ...]}]
  let isModelsLoaded = false;
  let lastScan = 0;

  function log(msg) {
    const time = new Date().toLocaleTimeString();
    if (logEl) logEl.textContent = `${time} — ${msg}\n` + logEl.textContent;
    else console.log(time, msg);
  }

  // --- Load models --
  async function loadModels() {
    try {
      log('Loading face-api models...');
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
      await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
      isModelsLoaded = true;
      log('Models loaded.');
    } catch (e) {
      log('Model load error: ' + e.message);
      throw e;
    }
  }

  // --- Load embeddings from backend (or sample) ---
  async function loadEmbeddings() {
    try {
      log('Fetching embeddings from server...');
      // Ideally filter by class/section query params
      const res = await fetch(`${API_BASE}/embeddings`);
      if (!res.ok) throw new Error('Failed to fetch embeddings: ' + res.status);
      const data = await res.json(); // expected [{ student_id, embedding: [..], name, roll }]
      labeledDescriptors = data.map(rec => {
        // ensure descriptor is Float32Array
        const descriptors = [ new Float32Array(rec.embedding) ];
        return new faceapi.LabeledFaceDescriptors(String(rec.student_id), descriptors);
      });
      faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, DISTANCE_THRESHOLD);
      log(`Loaded ${labeledDescriptors.length} student embeddings.`);
      // fill class/section selects if server returned metadata (optional)
      if (classSelect && sectionSelect) {
        // no-op here (server-side may return lists)
      }
    } catch (err) {
      log('Embeddings load error: ' + (err.message || err));
    }
  }

  // --- camera control ---
  startBtn && startBtn.addEventListener('click', async () => {
    try {
      if (!isModelsLoaded) await loadModels();
      await loadEmbeddings(); // warm embeddings
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream;
      await video.play();
      log('Camera started');
      startDetectionLoop();
    } catch (e) {
      log('Camera error: ' + e.message);
    }
  });

  stopBtn && stopBtn.addEventListener('click', () => {
    stopDetectionLoop();
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      video.srcObject = null;
      stream = null;
    }
    clearOverlay();
    log('Camera stopped');
  });

  // manual load embeddings (button)
  loadEmbBtn && loadEmbBtn.addEventListener('click', async ()=> {
    try {
      if (!isModelsLoaded) await loadModels();
      await loadEmbeddings();
    } catch(e){ log('Load embeddings failed: ' + e.message); }
  });

  // sync queued records
  syncBtn && syncBtn.addEventListener('click', async ()=> {
    try {
      const items = await window.srmDB.getAll();
      if (!items.length) { log('No queued records to sync'); return; }
      log('Syncing ' + items.length + ' records...');
      const res = await fetch(API_BASE + '/attendance/sync', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ records: items })
      });
      if (res.ok) {
        await window.srmDB.clear();
        log('Synced successfully');
        if (window.opener) window.opener.postMessage({ type: 'attendance_synced', count: items.length }, location.origin);
      } else {
        const txt = await res.text();
        log('Sync failed: ' + txt);
      }
    } catch (e) {
      log('Sync error: ' + e.message);
    }
  });

  // optional Register Face button (admin uses to register descriptor for a given student_id query param)
  registerBtn && registerBtn.addEventListener('click', async ()=> {
    try {
      const params = new URLSearchParams(location.search);
      const student_id = params.get('student_id') || prompt('Enter student id to register face:');
      if (!student_id) return alert('student id required');
      const det = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
      if (!det) { alert('No face detected, try again'); return; }
      const descriptor = Array.from(det.descriptor);
      const res = await fetch(API_BASE + '/face/register', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ student_id: Number(student_id), embedding: descriptor })
      });
      if (res.ok) {
        log('Face registered for student ' + student_id);
        // reload embeddings to include new face
        await loadEmbeddings();
      } else {
        const txt = await res.text();
        log('Register failed: ' + txt);
      }
    } catch (e) { log('Register error: ' + e.message); }
  });

  // --- Register mode: capture face snapshot and send to backend ---
  (function initRegisterMode(){
    try{
      const params = new URLSearchParams(location.search);
      const mode = params.get('mode');
      const studentId = params.get('studentId') || params.get('student_id');
      if (mode !== 'register') return;
      if (captureBtn) captureBtn.style.display = '';
      // auto-start camera in register mode
      startBtn?.click();
      if (captureBtn){
        captureBtn.addEventListener('click', async ()=>{
          try{
            if (!video || video.readyState < 2) { log('Video not ready'); return; }
            const cv = document.createElement('canvas');
            cv.width = video.videoWidth || 640; cv.height = video.videoHeight || 480;
            const ctx = cv.getContext('2d'); ctx.drawImage(video, 0, 0, cv.width, cv.height);
            const dataUrl = cv.toDataURL('image/jpeg', 0.9);
            if (studentId){
              // send to backend for persistence
              try{
                const res = await fetch(`${API_BASE}/students/${encodeURIComponent(studentId)}/face-preview`, {
                  method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ dataUrl })
                });
                if (!res.ok) { const t = await res.text(); throw new Error(t||res.statusText); }
              }catch(e){ log('Save preview (server) failed: ' + e.message); }
              // also write to opener's localStorage for immediate UI update
              try{ localStorage.setItem(`srm:facePreview:${studentId}`, dataUrl); }catch(_){ }
              if (window.opener){
                window.opener.postMessage({ type:'face_registered', studentId: Number(studentId), dataUrl }, '*');
              }
              log('Face snapshot captured and sent.');
            } else {
              log('Captured preview (no studentId in URL)');
            }
          }catch(e){ log('Capture failed: ' + e.message); }
        });
      }
    }catch(e){ /* ignore */ }
  })();

  // --- Detection loop ---
  function startDetectionLoop() {
    if (detectionsInterval) return;
    const canvas = overlay;
    const displaySize = { width: video.videoWidth || 640, height: video.videoHeight || 480 };
    canvas.width = displaySize.width;
    canvas.height = displaySize.height;
    faceapi.matchDimensions(canvas, displaySize);

    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });

    log('Starting multi-face detection (max ' + MAX_FACES + ')');
    detectionsInterval = setInterval(async () => {
      const now = Date.now();
      if (now - lastScan < SCAN_INTERVAL_MS) return;
      lastScan = now;
      if (!isModelsLoaded || !faceMatcher) {
        // try to fetch if not ready
        if (!isModelsLoaded) await loadModels();
        if (!faceMatcher) await loadEmbeddings();
        return;
      }
      try {
        const detections = await faceapi.detectAllFaces(video, options).withFaceLandmarks().withFaceDescriptors();
        if (!detections || !detections.length) {
          clearOverlay();
          return;
        }
        // limit to MAX_FACES (take largest faces first to prefer nearer faces)
        detections.sort((a,b) => (b.detection.box.width * b.detection.box.height) - (a.detection.box.width * a.detection.box.height));
        const toProcess = detections.slice(0, MAX_FACES);
        const results = toProcess.map(det => {
          const best = faceMatcher.findBestMatch(det.descriptor);
          return { det, best }; // best.toString() contains label and distance
        });

        // draw boxes
        drawDetections(results);

        // build attendance records for matched faces (exclude 'unknown')
        const records = [];
        for (const r of results) {
          const label = r.best.label; // student_id or 'unknown'
          const distance = r.best.distance;
          if (label && label !== 'unknown') {
            records.push({
              student_id: Number(label),
              status: 'present',
              method: 'face',
              confidence: Math.round((1 - distance) * 10000) / 100, // approx confidence %
              date: (new Date()).toISOString().slice(0,10),
              timestamp: new Date().toISOString()
            });
          }
        }

        if (records.length) {
          // batch send (try online -> fallback to queue)
          try {
            const res = await fetch(API_BASE + '/attendance/sync', {
              method: 'POST',
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({ records })
            });
            if (res.ok) {
              log(`Marked ${records.length} students online.`);
              // notify opener to refresh dashboard
              if (window.opener) window.opener.postMessage({ type: 'attendance_marked', count: records.length }, location.origin);
            } else {
              throw new Error('server');
            }
          } catch (err) {
            // offline or server error -> add each to local queue
            for (const rec of records) await window.srmDB.add(rec);
            log(`Queued ${records.length} records locally (offline).`);
          }
        } else {
          log(`Detected ${detections.length} faces — none matched known students.`);
        }

      } catch (e) {
        log('Detection error: ' + e.message);
      }
    }, SCAN_INTERVAL_MS);
  }

  function stopDetectionLoop() {
    if (detectionsInterval) { clearInterval(detectionsInterval); detectionsInterval = null; }
  }

  // --- Drawing helpers ---
  function clearOverlay() {
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }

  function drawDetections(results) {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0,0,overlay.width, overlay.height);
    ctx.lineWidth = 2;
    ctx.font = '14px Inter, Arial';
    for (const r of results) {
      const box = r.det.detection.box;
      // scale if necessary (faceapi matchedDimensions used)
      ctx.strokeStyle = r.best.label === 'unknown' ? 'rgba(255,0,0,0.6)' : 'rgba(34,197,94,0.9)';
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      const label = r.best.label === 'unknown' ? 'Unknown' : `ID:${r.best.label} (${(1 - r.best.distance).toFixed(2)})`;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(box.x, box.y - 20, Math.max(120, ctx.measureText(label).width + 10), 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, box.x + 6, box.y - 6);
    }
    // show count
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(6, overlay.height - 30, 180, 26);
    ctx.fillStyle = '#fff';
    ctx.fillText(`Detected: ${results.length} (showing up to ${MAX_FACES})`, 12, overlay.height - 10);
  }

  // --- cleanup when page unloaded
  window.addEventListener('beforeunload', () => {
    stopDetectionLoop();
    if (stream) stream.getTracks().forEach(t => t.stop());
  });

  // initial log
  log('Scanner ready — models not yet loaded. Click Start Camera.');

})();
