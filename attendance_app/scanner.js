// attendance_app/scanner.js
// Robust scanner: loads embeddings + students, builds faceMatcher, marks attendance.
// Expects endpoints:
// GET  /api/v1/embeddings       -> [{ student_id, roll, name, embedding }]
// GET  /api/v1/students         -> [{ id, roll, name, ... }]
// POST /api/v1/attendance/mark  -> { student_id, date, status, method, confidence }

const video = document.getElementById('video');
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const registerBtn = document.getElementById('registerBtn'); // optional
const statusEl = document.getElementById('status');

let stream = null;
let detectInterval = null;
let modelsLoaded = false;
let faceMatcher = null;
let labelToStudentId = new Map();
let recentMarks = {}; // debounce: label -> timestamp (ms)

function setStatus(txt){
  if (statusEl) statusEl.innerText = txt;
  console.log(txt);
}

// Load face-api models
async function loadModels() {
  if (modelsLoaded) return;
  setStatus('Loading face-api models...');
  const base = '/attendance_app/models';
  await faceapi.nets.tinyFaceDetector.loadFromUri(base);
  await faceapi.nets.faceLandmark68Net.loadFromUri(base);
  await faceapi.nets.faceRecognitionNet.loadFromUri(base);
  modelsLoaded = true;
  setStatus('Models loaded.');
}

// Fetch embeddings from server
async function fetchEmbeddings() {
  setStatus('Fetching embeddings from server...');
  try {
    const resp = await fetch('/api/v1/embeddings');
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${t}`);
    }
    const arr = await resp.json();
    if (!Array.isArray(arr)) throw new Error('Embeddings endpoint did not return array');
    setStatus(`Embeddings count: ${arr.length}`);
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
    const resp = await fetch('/api/v1/students');
    if (!resp.ok) { throw new Error('Failed to fetch students: ' + resp.status); }
    const arr = await resp.json();
    const map = new Map();
    for (const s of arr) {
      const roll = s.roll || s.roll_number || s.rollno || s.roll_no || null;
      const key = String(roll ?? s.id);
      map.set(key, s.id);
    }
    setStatus(`Students loaded: ${arr.length}`);
    return map;
  } catch (err) {
    console.error('fetchStudentsMap error', err);
    setStatus('Students load error: ' + err.message);
    return new Map();
  }
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
    const resp = await fetch('/api/v1/attendance/sync', {
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
  // avoid duplicates within 45 seconds
  const now = Date.now();
  if (recentMarks[label] && (now - recentMarks[label] < 45*1000)) return;
  recentMarks[label] = now;

  // resolve student_id from label -> studentId map
  let studentId = labelToStudentId.get(label);
  if (!studentId) {
    // try common numeric label vs string
    studentId = labelToStudentId.get(String(label));
  }

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
      // can't resolve id -> queue roll-based entry so admin can reconcile
      queueAttendance({ roll_number: label, ...payload, synced: false });
      setStatus(`Matched label ${label} but student id not resolved. Queued.`);
      return;
    }

    const resp = await fetch('/api/v1/attendance/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (resp.ok) {
      setStatus(`Attendance marked for ${label}`);
    } else {
      const txt = await resp.text();
      setStatus(`Attendance API error: ${resp.status} ${txt}`);
      // fallback to local queue
      queueAttendance({ student_id: studentId, ...payload, synced: false });
    }
  } catch (err) {
    console.error('markAttendanceForLabel error', err);
    queueAttendance({ student_id: studentId, ...payload, synced: false });
  }
}

// Main start function
async function startCameraAndDetect() {
  await loadModels();
  const embeddings = await fetchEmbeddings();
  const studentsMap = await fetchStudentsMap();
  // fill global map label->studentId using studentsMap (roll->id)
  labelToStudentId = studentsMap;

  buildFaceMatcher(embeddings, 0.55);

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width:720, height:560 }});
    video.srcObject = stream;
    await video.play();
    setStatus('Camera started');

    // create overlay
    let overlay = document.getElementById('overlay');
    if (!overlay) {
      overlay = faceapi.createCanvasFromMedia(video);
      overlay.id = 'overlay';
      overlay.style.position = 'absolute';
      overlay.style.left = video.offsetLeft + 'px';
      overlay.style.top  = video.offsetTop + 'px';
      document.body.appendChild(overlay);
    }
    faceapi.matchDimensions(overlay, { width: video.videoWidth, height: video.videoHeight });

    detectInterval = setInterval(async () => {
      try {
        if (!modelsLoaded) return;
        const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
        if (!detections || detections.length === 0) {
          setStatus('Detected faces: 0');
          const ctx = overlay.getContext('2d'); ctx.clearRect(0,0,overlay.width, overlay.height);
          return;
        }

        const resized = faceapi.resizeResults(detections, { width: video.videoWidth, height: video.videoHeight });
        faceapi.draw.clearCanvas(overlay);
        faceapi.draw.drawDetections(overlay, resized);

        if (!faceMatcher) {
          setStatus(`Detected faces: ${resized.length} — matcher not ready`);
          return;
        }

        for (const det of resized) {
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
    }, 800);

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

// expose sync to console button (optional)
window.syncOfflineQueue = syncOfflineQueue;
