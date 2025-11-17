document.addEventListener('DOMContentLoaded', ()=>{
  const form = document.querySelector('#add-student-panel form');
  const regBtn = document.getElementById('faceRegisterBtn');
  const faceImg = document.getElementById('facePreviewImg');
  const faceHidden = document.getElementById('facePreviewData');
  const defaultFaceSrc = faceImg ? faceImg.getAttribute('src') || '' : '';
  if (form){
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const fd = new FormData(form);
      const student = Object.fromEntries(fd.entries());
      try{
        const newId = await window.srmLocal.addStudent(student);
        // if a face snapshot was captured earlier, persist it now for the real ID
        if (newId && faceHidden && faceHidden.value) {
          try {
            await window.srmLocal.saveFacePreview(newId, faceHidden.value);
            try { localStorage.setItem(`srm:facePreview:${newId}`, faceHidden.value); } catch(_){ }
          } catch(_){}
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
        alert(msg.includes('HTTP') ? `Failed to add student: ${msg}` : `Failed to add student`);
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
