(function(){
  const state = { all: [], filtered: [], embSet: new Set() };
  let bodyEl, searchEl;

  // Helpers to compute embedding from a data URL using face-api (loaded on index.html)
  const MODEL_URL = './attendance_app/models';
  let modelsLoaded = false;
  async function ensureModels(){
    if (modelsLoaded) return true;
    if (!window.faceapi) return false;
    try{
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
      await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
      modelsLoaded = true; return true;
    }catch(e){ console.warn('face-api load failed', e); return false; }
  }
  async function computeDescriptorFromDataUrl(dataUrl){
    if (!dataUrl) return null;
    if (!await ensureModels()) return null;
    const img = new Image();
    try {
      await new Promise((res, rej)=>{ img.onload=res; img.onerror=rej; img.src=dataUrl; });
      if (!img.naturalWidth || !img.naturalHeight){
        console.warn('[descriptor] image has zero dimensions');
        return null;
      }
      const options = new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.5, inputSize: 224 });
      // Try single face first
      let detFull = null;
      try {
        detFull = await faceapi.detectSingleFace(img, options).withFaceLandmarks().withFaceDescriptor();
      } catch (e) {
        console.warn('[descriptor] single face pipeline error, fallback to multi', e.message);
      }
      if (!detFull){
        // Fallback: detect all faces, choose the largest
        try {
          const all = await faceapi.detectAllFaces(img, options).withFaceLandmarks().withFaceDescriptors();
          if (all && all.length){
            all.sort((a,b)=> (b.detection.box.width*b.detection.box.height) - (a.detection.box.width*a.detection.box.height));
            detFull = all[0];
          }
        } catch(e){ console.warn('[descriptor] multi-face fallback failed', e.message); }
      }
      if (!detFull){
        console.warn('[descriptor] no face detected');
        return null;
      }
      if (!detFull.descriptor || detFull.descriptor.length !== 128){
        console.warn('[descriptor] invalid descriptor length', detFull.descriptor && detFull.descriptor.length);
        return null;
      }
      return Array.from(detFull.descriptor);
    } catch (e) {
      console.warn('descriptor compute failed (outer)', e);
      return null;
    }
  }

  document.addEventListener('DOMContentLoaded', async ()=>{
    bodyEl = document.getElementById('studentsBody');
    searchEl = document.getElementById('search');
    await load();
    bind();
  });

  function bind(){
    if (searchEl){
      searchEl.addEventListener('input', ()=>{
        const q = (searchEl.value||'').toLowerCase().trim();
        applyFilter(q);
        render();
      });
    }
    document.addEventListener('srm:data-changed', async ()=>{ await load(); });
  }

  async function load(){
    try{
      if (!window.srmLocal?.listStudents) return;
      state.all = await window.srmLocal.listStudents();
      // load embedding set once in background
      try{
        const base = (localStorage.getItem('SRM_API_BASE') || 'http://localhost:4000').replace(/\/$/, '') + '/api/v1/embeddings';
        const res = await fetch(base, { cache: 'no-store' });
        if (res.ok){
          const arr = await res.json();
          state.embSet = new Set(Array.isArray(arr) ? arr.map(x=> Number(x.student_id)) : []);
          console.info('[view-students] embeddings loaded:', state.embSet.size);
        } else {
          console.warn('[view-students] embeddings request failed', res.status);
        }
      }catch(e){ console.warn('[view-students] embeddings fetch error', e.message); }
      applyFilter((searchEl?.value||'').toLowerCase().trim());
      render();
    }catch(err){
      console.warn('Failed to load students from local DB', err);
    }
  }

  function applyFilter(q){
    if (!q){ state.filtered = state.all.slice(); return; }
    state.filtered = state.all.filter(s=>{
      const hay = [s.name,s.roll,s.section,s.course,s.semester]
        .map(x=> (x==null? '': String(x)).toLowerCase()).join(' ');
      return hay.includes(q);
    });
  }

  function td(txt){ const el = document.createElement('td'); el.textContent = txt==null? '': txt; return el; }

  function render(){
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    if (!state.filtered.length){
      const tr = document.createElement('tr');
      const tdEl = document.createElement('td');
      tdEl.colSpan = 6; tdEl.className = 'muted';
      tdEl.textContent = 'No students found.';
      tr.appendChild(tdEl); bodyEl.appendChild(tr); return;
    }
    for (const s of state.filtered){
      const tr = document.createElement('tr');
      tr.appendChild(td(s.name));
      tr.appendChild(td(s.roll));
      tr.appendChild(td(s.section));
      tr.appendChild(td(s.course));
      tr.appendChild(td(s.semester));
      const actions = document.createElement('td');
      actions.className = 'actions';
      actions.innerHTML = `
        <button class="action btn-view" title="View" data-id="${s.id}" aria-label="View">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="action btn-edit" title="Edit" data-id="${s.id}" aria-label="Edit">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button class="action btn-face" title="Register Face" data-id="${s.id}" aria-label="Register Face">
          <img src="face_scan.png" alt="Register Face" width="18" height="18" />
        </button>
        <button class="action btn-del" title="Delete" data-id="${s.id}" aria-label="Delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
        </button>`;
      // Show verified badge only if both preview exists and an embedding exists
      try{
        const hasPreview = Boolean(s.facePreviewData || localStorage.getItem(`srm:facePreview:${s.id}`));
        const hasEmbedding = state.embSet && state.embSet.has(Number(s.id));
        const hasFace = hasPreview && hasEmbedding;
        if (hasFace){
          const img = document.createElement('img');
          img.src = 'face_verified.png';
          img.alt = 'Face verified';
          img.width = 20; img.height = 20;
          img.title = 'Face registered';
          img.style.marginLeft = '8px'; img.style.verticalAlign = 'middle';
          img.className = 'face-verified';
          actions.appendChild(img);
        }
      }catch(e){ console.warn('failed to render verified badge', e); }
      tr.appendChild(actions);
      bodyEl.appendChild(tr);
    }
  }

  // event delegation for edit/delete
  document.addEventListener('click', async (e)=>{
    const btn = e.target.closest?.('.btn-view, .btn-edit, .btn-del, .btn-face, .modal-close, #modalCloseBtn, #studentModal .modal-backdrop');
    if (!btn) return;
    // handle modal close
    if (btn.classList.contains('modal-close') || btn.id === 'modalCloseBtn' || btn.classList.contains('modal-backdrop')){
      hideModal(); return;
    }
    const id = btn.getAttribute('data-id');
    if (!id) return;
    if (btn.classList.contains('btn-view')){
      try{
        const s = await window.srmLocal.getStudent(Number(id));
        if (!s){ alert('Student not found'); return; }
        showStudentModal(s);
      }catch(err){ console.error('view failed', err); }
      return;
    }
    if (btn.classList.contains('btn-face')){
      try{
        const s = await window.srmLocal.getStudent(Number(id));
        if (!s){ alert('Student not found'); return; }
        // Open in-page capture modal; on use, persist to backend
        window.SRMCapture?.open(async (dataUrl)=>{
          try{
            await window.srmLocal.saveFacePreview(Number(id), dataUrl);
            document.dispatchEvent(new CustomEvent('srm:data-changed', { detail:{ type:'student:update', id:Number(id) } }));
            if (window.notify?.success) window.notify.success('Face updated');
            // compute and register embedding as well
            try{
              const descriptor = await computeDescriptorFromDataUrl(dataUrl);
              if (descriptor){
                console.info('[face-register] descriptor length', descriptor.length);
                const API_BASE = (localStorage.getItem('SRM_API_BASE') || 'http://localhost:4000').replace(/\/$/, '') + '/api/v1';
                const resp = await fetch(API_BASE + '/face/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ student_id: Number(id), embedding: descriptor }) });
                console.info('[face-register] POST /face/register status', resp.status);
                if (resp.ok){
                  // refresh embeddings set immediately so badge appears
                  try {
                    const embRes = await fetch(API_BASE + '/embeddings', { cache:'no-store' });
                    if (embRes.ok){
                      const arr2 = await embRes.json();
                      state.embSet = new Set(Array.isArray(arr2)? arr2.map(x=> Number(x.student_id)) : []);
                      console.info('[face-register] embeddings refreshed size', state.embSet.size);
                      render();
                    }
                  } catch(_){}
                }
              } else {
                console.warn('[face-register] no face detected in capture');
              }
            }catch(e){ console.warn('embedding save failed', e); }
          }catch(e){
            console.error('save face failed', e);
            if (window.notify?.error) window.notify.error('Failed to save face');
          }
        });
      }catch(err){
        console.error('open face capture failed', err); if (window.notify?.error) window.notify.error('Could not open face registration');
      }
      return;
    }
    if (btn.classList.contains('btn-del')){
      if (!confirm('Delete this student? This will remove their attendance logs as well.')) return;
      try{
        await window.srmLocal.deleteStudent(Number(id), true);
        document.dispatchEvent(new CustomEvent('srm:data-changed', { detail:{ type:'student:delete', id:Number(id) } }));
        await load();
      }catch(err){
        console.error('delete failed', err); alert('Delete failed');
      }
      return;
    }
    if (btn.classList.contains('btn-edit')){
      try{
        const s = await window.srmLocal.getStudent(Number(id));
        if (!s){ alert('Student not found'); return; }
        const name = prompt('Name:', s.name ?? '');
        if (name === null) return; // cancelled
        const roll = prompt('Roll:', s.roll ?? ''); if (roll === null) return;
        const section = prompt('Section:', s.section ?? ''); if (section === null) return;
        const department = prompt('Department:', s.department ?? ''); if (department === null) return;
        const course = prompt('Course:', s.course ?? ''); if (course === null) return;
        const phone = prompt('Phone:', s.phone ?? ''); if (phone === null) return;
        const year = prompt('Year:', s.year ?? ''); if (year === null) return;
        const email = prompt('Email:', s.email ?? ''); if (email === null) return;
        await window.srmLocal.updateStudent(Number(id), { name, roll, section, department, course, phone, year: year? Number(year): null, email });
        document.dispatchEvent(new CustomEvent('srm:data-changed', { detail:{ type:'student:update', id:Number(id) } }));
        await load();
      }catch(err){
        console.error('update failed', err); alert('Update failed');
      }
    }
  });

  // Modal helpers
  function showStudentModal(s){
    const modal = document.getElementById('studentModal');
    const body = document.getElementById('studentModalBody');
    if (!modal || !body) return;
    const preview = localStorage.getItem(`srm:facePreview:${s.id}`) || s.facePreviewData || '';
    const faceBlock = preview
      ? `<img class="sv-face" src="${preview}" alt="Face preview"/>`
      : `<div class="sv-face placeholder"><span class="badge warn">Face not registered</span></div>`;
    body.innerHTML = `
      <div class="student-view">
        <div class="sv-face-wrap">
          <div class="sv-card-head">Face</div>
          ${faceBlock}
          ${preview ? '' : '<div class="sv-card-note">Register a face from the list to show here.</div>'}
        </div>
        <div>
          <div class="sv-row"><strong>Name:</strong> <span>${escapeHTML(s.name||'')}</span></div>
          <div class="sv-row"><strong>Roll:</strong> <span>${escapeHTML(s.roll||'')}</span></div>
          <div class="sv-row"><strong>Section:</strong> <span>${escapeHTML(s.section||'')}</span></div>
          <div class="sv-row"><strong>Course:</strong> <span>${escapeHTML(s.course||'')}</span></div>
          <div class="sv-row"><strong>Semester:</strong> <span>${s.semester ?? ''}</span></div>
          <div class="sv-row"><strong>Department:</strong> <span>${escapeHTML(s.department||'')}</span></div>
          <div class="sv-row"><strong>Phone:</strong> <span>${escapeHTML(s.phone||'')}</span></div>
          <div class="sv-row"><strong>Year:</strong> <span>${s.year ?? ''}</span></div>
          <div class="sv-row"><strong>Email:</strong> <span>${escapeHTML(s.email||'')}</span></div>
        </div>
      </div>`;
    modal.hidden = false;
    // trigger entrance animation
    requestAnimationFrame(()=> modal.classList.add('open'));
    // enable ESC to close
    const onKey = (ev)=>{ if (ev.key === 'Escape'){ hideModal(); } };
    document.addEventListener('keydown', onKey, { once: true });
  }

  function hideModal(){
    const modal = document.getElementById('studentModal');
    if (!modal) return;
    modal.classList.remove('open');
    // allow transition to play before hiding
    setTimeout(()=>{ modal.hidden = true; }, 120);
  }

  function escapeHTML(str){
    return String(str).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }
})();
