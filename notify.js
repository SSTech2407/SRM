(function(){
  const rootId = 'toast-root';
  const overlayId = 'success-overlay';
  function ensureRoot(){
    let root = document.getElementById(rootId);
    if (!root){
      root = document.createElement('div');
      root.id = rootId;
      root.setAttribute('aria-live','polite');
      root.setAttribute('aria-atomic','true');
      document.body.appendChild(root);
    }
    return root;
  }
  function ensureOverlay(){
    let el = document.getElementById(overlayId);
    if (!el){
      el = document.createElement('div');
      el.id = overlayId;
      el.className = 'full-overlay';
      el.innerHTML = `
        <div class="fo-backdrop" aria-hidden="true"></div>
        <div class="fo-card" role="dialog" aria-modal="true" aria-labelledby="foTitle">
          <div class="fo-icon" aria-hidden="true">✓</div>
          <h2 id="foTitle" class="fo-title"></h2>
          <button id="foContinue" class="btn btn-primary fo-btn" type="button">Continue</button>
        </div>`;
      el.hidden = true;
      document.body.appendChild(el);
      // Close on Escape
      document.addEventListener('keydown', (e)=>{
        if (e.key === 'Escape' && !el.hidden) hideOverlay();
      });
      el.addEventListener('click', (e)=>{
        if (e.target === el || e.target.classList.contains('fo-backdrop')) hideOverlay();
      });
    }
    return el;
  }
  let onContinueCb = null;
  function showOverlay(message, onContinue){
    const el = ensureOverlay();
    const title = el.querySelector('#foTitle');
    const btn = el.querySelector('#foContinue');
    title.textContent = message || 'Success';
    onContinueCb = typeof onContinue === 'function' ? onContinue : null;
    btn.onclick = ()=>{ hideOverlay(); if (onContinueCb) onContinueCb(); };
    el.hidden = false;
    requestAnimationFrame(()=> el.classList.add('show'));
    btn.focus({ preventScroll: true });
  }
  function hideOverlay(){
    const el = document.getElementById(overlayId);
    if (!el) return;
    el.classList.remove('show');
    setTimeout(()=>{ el.hidden = true; }, 160);
  }
  function show(msg, type='info', timeout=2800){
    const root = ensureRoot();
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.role = 'status';
    el.innerHTML = `<span class="ico" aria-hidden="true"></span><div class="msg">${escapeHTML(String(msg))}</div>`;
    root.appendChild(el);
    requestAnimationFrame(()=> el.classList.add('show'));
    const t = setTimeout(()=> close(), timeout);
    function close(){
      clearTimeout(t);
      el.classList.remove('show');
      setTimeout(()=>{ el.remove(); }, 180);
    }
    el.addEventListener('click', close);
    return close;
  }
  function escapeHTML(str){
    return str.replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }
  window.notify = {
    success: (m)=> show(m,'success'),
    info: (m)=> show(m,'info'),
    warn: (m)=> show(m,'warn'),
    error: (m)=> show(m,'error',4200),
    fullSuccess: (m, onContinue)=> showOverlay(m, onContinue),
    closeFull: ()=> hideOverlay()
  };
})();
