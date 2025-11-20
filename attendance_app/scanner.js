// attendance_app/scanner.js (patched)
// Robust scanner: loads embeddings + students, builds faceMatcher, marks attendance.
// - Uses absolute API_BASE so front-end can run on other port (e.g. 3000).
// - Uses safe canvas drawing (no faceapi.draw.clearCanvas dependency).
// - Filters invalid boxes to avoid Box.constructor errors.
// - Uses smaller TinyFaceDetector inputSize for performance and a throttled loop.

const API_BASE = (localStorage.getItem('SRM_API_BASE') || 'http://localhost:4000').replace(/\/$/, '') + '/api/v1';
const MODEL_URL = (localStorage.getItem('SRM_MODEL_URL') || 'http://localhost:4000/attendance_app/models').replace(/\/$/, '');

const video = document.getElementById('video');
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const registerBtn = document.getElementById('registerBtn'); // optional
// UI controls present in scanner.html
const classSelect = document.getElementById('classSelect');
const sectionSelect = document.getElementById('sectionSelect');
const loadEmbBtn = document.getElementById('loadEmbBtn');
const embCountSpan = document.getElementById('embCount');
const studentsListBody = document.getElementById('studentsList');
const submitBtn = document.getElementById('submitBtn');
const manualBtn = document.getElementById('manualBtn');
const sessionCount = document.getElementById('sessionCount');
const logEl = document.getElementById('log');

let stream = null;
let detectInterval = null;
let modelsLoaded = false;
let faceMatcher = null;
let labelToStudentId = new Map();
let recentMarks = {}; // debounce: label -> timestamp (ms)
let allStudents = []; // cache of all students
let sessionMarked = new Set(); // ids marked present in this session

// Image asset for present indicator. Ensure a file `present.png` exists in `attendance_app/`.
const PRESENT_IMG_PATH = 'present.png'; // Provide your supplied PNG at attendance_app/present.png

function setStatus(txt){
  console.log('[scanner]', txt);
  if (!logEl) return;
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `${time} - ${txt}\n` + logEl.textContent;
}

// Load face-api models (from MODEL_URL)
async function loadModels() {
  if (modelsLoaded) return;
  setStatus('Loading face-api models...');
  try{
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    modelsLoaded = true;
    setStatus('Models loaded.');
  }catch(e){
    console.error('loadModels failed', e);
    setStatus('Model load failed: ' + (e && e.message ? e.message : e));
    throw e;
  }
}

// Fetch embeddings from server
async function fetchEmbeddings() {
  setStatus('Fetching embeddings from server...');
  try {
    const resp = await fetch(API_BASE + '/embeddings', { cache:'no-store' });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${t}`);
    }
    const arr = await resp.json();
    if (!Array.isArray(arr)) throw new Error('Embeddings endpoint did not return array');
    setStatus(`Embeddings count: ${arr.length}`);
    try{ if (embCountSpan) embCountSpan.textContent = `Embeddings: ${arr.length}`; }catch(_){ }
    return arr;
  } catch (err) {
    console.error('fetchEmbeddings error', err);
    setStatus('Embeddings load error: ' + err.message);
    return [];
  }
}

// Fetch students list and build roll -> id map
async function fetchStudentsMap() {
  setStatus('Fetching students list...');
  try {
    const resp = await fetch(API_BASE + '/students', { cache:'no-store' });
    if (!resp.ok) { throw new Error('Failed to fetch students: ' + resp.status); }
    const arr = await resp.json();
    allStudents = Array.isArray(arr) ? arr : [];
    const map = new Map();
    for (const s of arr) {
      const roll = s.roll || s.roll_number || s.rollno || s.roll_no || null;
      const key = String(roll ?? s.id);
      map.set(key, s.id);
    }
    setStatus(`Students loaded: ${arr.length}`);
    populateFiltersFromStudents(allStudents);
    return map;
  } catch (err) {
    console.error('fetchStudentsMap error', err);
    setStatus('Students load error: ' + err.message);
    allStudents = [];
    return new Map();
  }
}

function populateFiltersFromStudents(list){
  if (!Array.isArray(list)) return;
  if (classSelect){
    const vals = Array.from(new Set(list.map(s => String(s.semester||'').trim()).filter(v=> v && v !== 'null'))).sort((a,b)=> Number(a)-Number(b));
    classSelect.innerHTML = '<option value="">Select semester</option>' + vals.map(v=> `<option value="${v}">${v}</option>`).join('');
  }
  if (sectionSelect){
    const vals = Array.from(new Set(list.map(s => String(s.section||'').trim()).filter(Boolean))).sort();
    sectionSelect.innerHTML = '<option value="">Select section</option>' + vals.map(v=> `<option value="${v}">${v}</option>`).join('');
  }
}

async function renderStudentsForSelection(){
  if (!studentsListBody) return;
  if (!allStudents.length){ await fetchStudentsMap(); }
  const sem = (classSelect?.value||'').trim();
  const sec = (sectionSelect?.value||'').trim();
  const filtered = allStudents.filter(s => {
    if (sem && String(s.semester||'') !== sem) return false;
    if (sec && String(s.section||'') !== sec) return false;
    return true;
  });
  studentsListBody.innerHTML = '';
  if (!filtered.length){
    studentsListBody.innerHTML = '<tr><td colspan="6" class="muted">No students match current selection.</td></tr>';
    return;
  }
    for (const s of filtered){
      const tr = document.createElement('tr');
      const marked = sessionMarked.has(Number(s.id));
      // Always reserve icon space to prevent layout shift; hide when not marked.
      const presentIcon = `<img src="${PRESENT_IMG_PATH}" class="present-icon" alt="Present" onerror="this.onerror=null; this.src='../face_verified.png';" style="${marked? '' : 'visibility:hidden'}" />`;
      const nameCell = `<span class="present-name">${presentIcon}<span class="pn-text">${escapeHTML(s.name||'')}</span></span>`;
      tr.innerHTML = `
        <td>${nameCell}</td>
        <td>${escapeHTML(s.roll||'')}</td>
        <td class="col-section">${escapeHTML(s.section||'')}</td>
        <td class="col-semester">${escapeHTML(s.semester==null? '' : s.semester)}</td>
        <td class="col-status">${marked? '<span class="badge ok">Present</span>' : '<span class="badge">—</span>'}</td>
        <td class="col-action"><button class="btn small mark-btn" data-id="${s.id}">${marked? 'Unmark' : 'Mark Attendance'}</button></td>`;
      studentsListBody.appendChild(tr);
    }
}

document.addEventListener('click', async (ev)=>{
  const btn = ev.target.closest?.('.mark-btn');
  if (!btn) return;
  const id = Number(btn.getAttribute('data-id'));
  if (!id) return;
  if (sessionMarked.has(id)) sessionMarked.delete(id); else sessionMarked.add(id);
  updateSessionCount();
  renderStudentsForSelection();
});

function updateSessionCount(){ if (sessionCount) sessionCount.textContent = 'Marked: ' + sessionMarked.size; }

function escapeHTML(s){
  return String(s || '').replace(/[&<>"']/g, (c) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c];
  });
}

function buildFaceMatcher(embeddings, threshold = 0.55) {
  try {
    const labeled = embeddings.map(it => {
      if (!Array.isArray(it.embedding)) return null;
      const f32 = Float32Array.from(it.embedding);
      const label = it.roll ? String(it.roll) : `id_${it.student_id}`;
      return new faceapi.LabeledFaceDescriptors(label, [f32]);
    }).filter(Boolean);

    if (!labeled.length) {
      faceMatcher = null;
      setStatus('No student embeddings found. Matching disabled.');
      return;
    }
    faceMatcher = new faceapi.FaceMatcher(labeled, threshold);
    setStatus(`Face matcher ready (${labeled.length} labels)`);
  } catch (err) {
    console.error('buildFaceMatcher error', err);
    faceMatcher = null;
  }
}

// Local offline queue helpers (localStorage)
function queueAttendance(item) {
  const q = JSON.parse(localStorage.getItem('offline_attendance') || '[]');
  q.push(item);
  localStorage.setItem('offline_attendance', JSON.stringify(q));
}

async function syncOfflineQueue() {
  const q = JSON.parse(localStorage.getItem('offline_attendance') || '[]');
  if (!Array.isArray(q) || q.length === 0) return { synced: 0 };
  try {
    const resp = await fetch(API_BASE + '/attendance/sync', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ records: q })
    });
    if (!resp.ok) throw new Error('sync failed: '+resp.status);
    const jr = await resp.json();
    localStorage.setItem('offline_attendance', JSON.stringify([]));
    setStatus('Offline queue synced: ' + (jr.inserted ?? q.length));
    return jr;
  } catch (err) {
    console.error('syncOfflineQueue error', err);
    setStatus('Offline sync failed: ' + err.message);
    return { error: err.message };
  }
}

// Mark attendance (debounced per label)
async function markAttendanceForLabel(label, distance) {
  const now = Date.now();
  if (recentMarks[label] && (now - recentMarks[label] < 45*1000)) return;
  recentMarks[label] = now;

  let studentId = labelToStudentId.get(label);
  if (!studentId) studentId = labelToStudentId.get(String(label));

  const payload = {
    student_id: studentId || null,
    date: new Date().toISOString().slice(0,10),
    timestamp: new Date().toISOString(),
    status: 'present',
    method: 'face',
    confidence: +(1 - distance).toFixed(3)
  };

  try {
    if (!studentId) {
      queueAttendance({ roll_number: label, ...payload, synced: false });
      setStatus(`Matched label ${label} but student id not resolved. Queued.`);
      return;
    }

    const resp = await fetch(API_BASE + '/attendance/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (resp.ok) {
      setStatus(`Attendance marked for ${label}`);
      if (studentId){ sessionMarked.add(Number(studentId)); updateSessionCount(); renderStudentsForSelection(); }
    } else {
      const txt = await resp.text();
      setStatus(`Attendance API error: ${resp.status} ${txt}`);
      queueAttendance({ student_id: studentId, ...payload, synced: false });
    }
  } catch (err) {
    console.error('markAttendanceForLabel error', err);
    queueAttendance({ student_id: studentId, ...payload, synced: false });
  }
}

// --- patched detection/start/stop block ---
async function startCameraAndDetect() {
  await loadModels();
  const embeddings = await fetchEmbeddings();
  const studentsMap = await fetchStudentsMap();
  labelToStudentId = studentsMap;

  buildFaceMatcher(embeddings, 0.55);

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width:720, height:560 }});
    video.srcObject = stream;
    await video.play();
    // wait for video dimensions to be ready
    let tries = 0; while ((video.videoWidth === 0 || video.videoHeight === 0) && tries < 40){ await new Promise(r=> setTimeout(r,50)); tries++; }
    setStatus('Camera started');

    // create overlay (manual canvas fallback - avoid faceapi.draw.clearCanvas dependency)
    let overlay = document.getElementById('overlay');
    if (!overlay) {
      overlay = document.createElement('canvas');
      overlay.id = 'overlay';
      overlay.style.position = 'absolute';
      // place overlay as sibling inside video parent so CSS alignment works
      const parent = video.parentElement || document.body;
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      overlay.style.left = '0px'; overlay.style.top = '0px';
      overlay.style.pointerEvents = 'none';
      parent.appendChild(overlay);
    }

    function resizeOverlay() {
      overlay.width = video.videoWidth || video.clientWidth || 640;
      overlay.height = video.videoHeight || video.clientHeight || 480;
      overlay.style.width = (video.clientWidth || overlay.width) + 'px';
      overlay.style.height = (video.clientHeight || overlay.height) + 'px';
      overlay.style.left = (video.offsetLeft || 0) + 'px';
      overlay.style.top = (video.offsetTop || 0) + 'px';
    }
    resizeOverlay();

    const overlayCtx = overlay.getContext('2d');

    try { faceapi.matchDimensions(overlay, { width: video.videoWidth, height: video.videoHeight }); } catch(e){ /* ignore if not present */ }

    const TINY_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 128, scoreThreshold: 0.5 });

    if (detectInterval) clearInterval(detectInterval);
    detectInterval = setInterval(async () => {
      try {
        if (!modelsLoaded) return;
        if (!video || video.readyState < 2) { setStatus('Video not ready'); return; }

        resizeOverlay();

        const detections = await faceapi.detectAllFaces(video, TINY_OPTS).withFaceLandmarks().withFaceDescriptors();
        if (!detections || detections.length === 0) {
          overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
          setStatus('Detected faces: 0');
          return;
        }

        const resized = faceapi.resizeResults(detections, { width: overlay.width, height: overlay.height });

        const valid = resized.filter(det => {
          try {
            const box = det && det.detection && det.detection.box;
            if (!box) return false;
            const vals = [box.left, box.top, box.right, box.bottom];
            return vals.every(v => typeof v === 'number' && Number.isFinite(v));
          } catch (e) { return false; }
        });

        overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

        // draw bounding boxes
        for (const det of valid) {
          const b = det.detection.box;
          const x = b.left, y = b.top, w = b.width, h = b.height;
          overlayCtx.lineWidth = Math.max(2, Math.round(Math.min(overlay.width, overlay.height) / 200));
          overlayCtx.strokeStyle = '#00FF88';
          overlayCtx.strokeRect(x, y, w, h);
          overlayCtx.font = '14px Arial';
          overlayCtx.fillStyle = '#00FF88';
          const labelText = '';
          overlayCtx.fillText(labelText, Math.max(2, x + 4), Math.max(12, y + 14));
        }

        setStatus(`Detected faces: ${valid.length}`);

        if (!faceMatcher) { setStatus(`Detected faces: ${valid.length} — matcher not ready`); return; }

        for (const det of valid) {
          if (!det || !det.descriptor) continue;
          const best = faceMatcher.findBestMatch(det.descriptor);
          if (best && best.label && best.label !== 'unknown') {
            setStatus(`Match: ${best.label} (d=${best.distance.toFixed(3)})`);
            await markAttendanceForLabel(best.label, best.distance);
          } else {
            setStatus('No confident match for detected face.');
          }
        }
      } catch (err) {
        console.error('detection loop error', err);
      }
    }, 1000);

  } catch (err) {
    console.error('startCameraAndDetect error', err);
    setStatus('Camera error: ' + err.message);
  }
}

function stopCamera() {
  if (detectInterval) clearInterval(detectInterval);
  if (stream) stream.getTracks().forEach(t => t.stop());
  const overlay = document.getElementById('overlay'); if (overlay) overlay.remove();
  setStatus('Camera stopped');
}

// UI bindings
if (startBtn) startBtn.addEventListener('click', async () => { await startCameraAndDetect(); });
if (stopBtn) stopBtn.addEventListener('click', () => stopCamera());
if (registerBtn) registerBtn.addEventListener('click', () => alert('Use Register Face flow on Add Student page (if implemented).'));
if (loadEmbBtn) loadEmbBtn.addEventListener('click', ()=>{ renderStudentsForSelection(); });
if (classSelect) classSelect.addEventListener('change', ()=> renderStudentsForSelection());
if (sectionSelect) sectionSelect.addEventListener('change', ()=> renderStudentsForSelection());
if (submitBtn) submitBtn.addEventListener('click', async ()=>{
  if (!sessionMarked.size){ setStatus('Nothing to submit.'); return; }
  const arr = Array.from(sessionMarked).map(id=> ({ student_id: id, date: new Date().toISOString().slice(0,10), status: 'present', method: 'manual', confidence: null }));
  try{
    const resp = await fetch(API_BASE + '/attendance/sync', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ records: arr }) });
    if (resp.ok){ sessionMarked.clear(); updateSessionCount(); setStatus('Attendance submitted: '+arr.length); renderStudentsForSelection(); }
    else { const t = await resp.text(); setStatus('Submit failed: '+resp.status+' '+t); }
  }catch(e){ setStatus('Submit failed: '+e.message); }
});

// expose sync to console button (optional)
window.syncOfflineQueue = syncOfflineQueue;
