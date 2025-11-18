document.addEventListener('DOMContentLoaded', ()=>{
  const form = document.querySelector('#add-student-panel form');
  const regBtn = document.getElementById('faceRegisterBtn');
  const faceImg = document.getElementById('facePreviewImg');
  const faceHidden = document.getElementById('facePreviewData');
  const defaultFaceSrc = faceImg ? faceImg.getAttribute('src') || '' : '';

  // Lightweight face-api loader for embedding extraction on Add Student page
  const MODEL_URL = './attendance_app/models';
  let modelsLoaded = false;
  const API_BASE = (localStorage.getItem('SRM_API_BASE') || 'http://localhost:4000').replace(/\/$/, '') + '/api/v1';
  const EMB_Q_KEY = 'srm:embQueue';
  async function ensureModels(){
    if (modelsLoaded) return true;
    if (!window.faceapi) return false;
    try{
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
      await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
      modelsLoaded = true;
      return true;
    }catch(e){ console.warn('face-api model load failed', e); return false; }
  }
  async function computeDescriptorFromDataUrl(dataUrl){
    if (!dataUrl) return null;
    if (!await ensureModels()) return null;
    const img = new Image(); img.crossOrigin='anonymous';
    try {
      await new Promise((res, rej)=>{ img.onload=res; img.onerror=rej; img.src=dataUrl; });
      if (!img.naturalWidth || !img.naturalHeight){ console.warn('[descriptor:add] zero-dimension image'); return null; }
      const options = new faceapi.TinyFaceDetectorOptions({ scoreThreshold:0.5, inputSize:224 });
      let detFull = null;
      try { detFull = await faceapi.detectSingleFace(img, options).withFaceLandmarks().withFaceDescriptor(); }
      catch(e){ console.warn('[descriptor:add] single face pipeline error', e.message); }
      if (!detFull){
        try {
          const all = await faceapi.detectAllFaces(img, options).withFaceLandmarks().withFaceDescriptors();
          if (all && all.length){
            all.sort((a,b)=> (b.detection.box.width*b.detection.box.height)-(a.detection.box.width*a.detection.box.height));
            detFull = all[0];
          }
        } catch(e){ console.warn('[descriptor:add] multi-face fallback error', e.message); }
      }
      if (!detFull){ console.warn('[descriptor:add] no face detected'); return null; }
      if (!detFull.descriptor || detFull.descriptor.length !== 128){ console.warn('[descriptor:add] invalid descriptor length'); return null; }
      return Array.from(detFull.descriptor);
    } catch(e){ console.warn('descriptor compute failed (outer add)', e); return null; }
  }

  function readEmbQueue(){
    try{ const j = localStorage.getItem(EMB_Q_KEY); return Array.isArray(JSON.parse(j)) ? JSON.parse(j) : []; }catch(_){ return []; }
  }
  function writeEmbQueue(arr){ try{ localStorage.setItem(EMB_Q_KEY, JSON.stringify(arr||[])); }catch(_){ } }
  async function trySyncEmbQueue(){
    const q = readEmbQueue(); if (!q.length) return;
    const remain = [];
    for (const item of q){
      try{
        const res = await fetch(API_BASE + '/face/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(item) });
        if (!res.ok) throw new Error('HTTP '+res.status);
      }catch(e){ remain.push(item); }
    }
    writeEmbQueue(remain);
    if (q.length && !remain.length) { window.notify?.success?.('Queued face embeddings synced'); }
  }
  async function postEmbedding(studentId, descriptor){
    if (!descriptor) return false;
    try{
      const res = await fetch(API_BASE + '/face/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ student_id: Number(studentId), embedding: descriptor }) });
      if (res.ok) { return true; }
      throw new Error('HTTP '+res.status);
    }catch(e){
      const q = readEmbQueue(); q.push({ student_id: Number(studentId), embedding: descriptor }); writeEmbQueue(q);
      window.notify?.warn?.('Backend offline — face will sync when online');
      return false;
    }
  }
  if (form){
    // try syncing any queued embeddings on load
    trySyncEmbQueue();
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const fd = new FormData(form);
      const student = Object.fromEntries(fd.entries());
      try{
        const newId = await window.srmLocal.addStudent(student);
        const isDuplicate = !newId || Number.isNaN(Number(newId)) ? false : false; // placeholder if needed later
        // if a face snapshot was captured earlier, persist it now for the real ID
        if (newId && faceHidden && faceHidden.value) {
          try {
            await window.srmLocal.saveFacePreview(newId, faceHidden.value);
            try { localStorage.setItem(`srm:facePreview:${newId}`, faceHidden.value); } catch(_){ }
          } catch(_){}
          // also compute and register face embedding
          try{
            const descriptor = await computeDescriptorFromDataUrl(faceHidden.value);
            await postEmbedding(Number(newId), descriptor);
          }catch(err){ console.warn('register embedding failed', err); }
        }
        form.reset();
        if (faceImg) faceImg.src = defaultFaceSrc;
        document.dispatchEvent(new CustomEvent('srm:data-changed', { detail:{ type:'student:add' } }));
        if (window.notify && typeof window.notify.fullSuccess === 'function') {
          window.notify.fullSuccess('Congratulations! \n\n Student added successfully.', () => {
            // optional: navigate to list
            // location.hash = '#students';
          });
        }
      }catch(err){
        console.error('addStudent failed', err);
        const msg = (err && err.message) ? String(err.message) : 'Failed to add student';
        if (/409|duplicate/i.test(msg)) {
          window.notify?.warn?.('Roll number already exists. Using existing record; register face via View Students.');
        } else {
          alert(msg.includes('HTTP') ? `Failed to add student: ${msg}` : `Failed to add student`);
        }
      }
    });

    form.addEventListener('reset', ()=>{
      // clear preview and any stored marker
      if (faceImg) faceImg.src = defaultFaceSrc;
      if (faceHidden) faceHidden.value = '';
    });
  }

  // Face capture modal implementation
  (function setupCapture(){
    const capModal = document.getElementById('capModal');
    if (!capModal) return;
    const capVideo = document.getElementById('capVideo');
    const capPreview = document.getElementById('capPreview');
    const btnCapture = document.getElementById('capCapture');
    const btnRetake = document.getElementById('capRetake');
    const btnUse = document.getElementById('capUse');
    const btnCancel = document.getElementById('capCancel');
    const btnClose = document.getElementById('capClose');
    let stream = null;
    let onUseCb = null;
    function setState(mode){
      if (mode === 'live'){
        capVideo.style.display = 'block';
        capPreview.style.display = 'none';
        btnCapture.hidden = false; btnRetake.hidden = true; btnUse.hidden = true;
      } else {
        capVideo.style.display = 'none';
        capPreview.style.display = 'block';
        btnCapture.hidden = true; btnRetake.hidden = false; btnUse.hidden = false;
      }
    }
    async function start(){
      try{
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio:false });
        capVideo.srcObject = stream; await capVideo.play();
        setState('live');
      }catch(e){
        console.error('camera error', e);
        window.notify?.error?.('Camera not available');
      }
    }
    function stop(){
      try{ if (stream){ stream.getTracks().forEach(t=> t.stop()); stream = null; } }catch(_){ }
      capVideo.srcObject = null;
    }
    function open(onUse){
      onUseCb = typeof onUse === 'function' ? onUse : null;
      capModal.hidden = false;
      requestAnimationFrame(()=> capModal.classList.add('open'));
      start();
    }
    function close(){
      capModal.classList.remove('open');
      setTimeout(()=> capModal.hidden = true, 140);
      stop();
    }
    btnCancel?.addEventListener('click', close);
    btnClose?.addEventListener('click', close);
    capModal.addEventListener('click', (e)=>{ if (e.target === capModal || e.target.classList.contains('cap-backdrop')) close(); });
    btnCapture?.addEventListener('click', ()=>{
      try{
        const cv = document.createElement('canvas');
        cv.width = capVideo.videoWidth || 640; cv.height = capVideo.videoHeight || 480;
        cv.getContext('2d').drawImage(capVideo, 0, 0, cv.width, cv.height);
        const dataUrl = cv.toDataURL('image/jpeg', 0.9);
        capPreview.src = dataUrl; setState('preview');
      }catch(e){ window.notify?.warn?.('Capture failed. Try again.'); }
    });
    btnRetake?.addEventListener('click', ()=> setState('live'));
    btnUse?.addEventListener('click', ()=>{
      const dataUrl = capPreview.getAttribute('src') || '';
      if (onUseCb && dataUrl) onUseCb(dataUrl);
      close();
    });

    // Expose global helper
    window.SRMCapture = { open, close };
  })();

  if (regBtn && form){
    regBtn.addEventListener('click', ()=>{
      const fd = new FormData(form);
      const student = Object.fromEntries(fd.entries());
      const name = (student.name||'').trim();
      const roll = (student.roll||'').trim();
      if (!name || !roll){ alert('Please enter at least Name and Roll before registering face.'); return; }
      window.SRMCapture?.open((dataUrl)=>{
        if (faceImg) faceImg.src = dataUrl;
        if (faceHidden) faceHidden.value = dataUrl;
      });
    });
  }

  // Home tab: use the same capture modal to register a face for an existing student
  const homeRegBtn = document.getElementById('openRegister');
  if (homeRegBtn){
    homeRegBtn.addEventListener('click', ()=>{
      const sid = prompt('Enter Student ID to register face for:');
      if (!sid) return;
      const studentId = Number(sid);
      if (!studentId || Number.isNaN(studentId)) { alert('Please enter a valid numeric Student ID.'); return; }
      window.SRMCapture?.open(async (dataUrl)=>{
        try{
          await window.srmLocal.saveFacePreview(studentId, dataUrl);
          try { localStorage.setItem(`srm:facePreview:${studentId}`, dataUrl); } catch(_){ }
          const descriptor = await computeDescriptorFromDataUrl(dataUrl);
          await postEmbedding(studentId, descriptor);
          document.dispatchEvent(new CustomEvent('srm:data-changed', { detail:{ type:'student:update', id: studentId } }));
          window.notify?.success?.('Face registered for student #' + studentId);
        }catch(e){
          console.error('Home register failed', e);
          window.notify?.error?.('Failed to register face');
        }
      });
    });
  }

  // also handle postMessage from scanner
  window.addEventListener('message', (ev)=>{
    const data = ev.data || {};
    if (data && data.type === 'face_registered'){
      if (String(data.studentId||'') && data.dataUrl){
        if (faceImg) faceImg.src = data.dataUrl;
        if (faceHidden) faceHidden.value = data.dataUrl;
      }
    }
  });
});
