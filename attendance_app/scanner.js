// scanner.js - initial scaffold (manual + queue + API hooks)
(() => {
    const API_BASE = '/api/v1';
    const video = document.getElementById('video');
    const overlay = document.getElementById('overlay');
    const logEl = document.getElementById('log');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const syncBtn = document.getElementById('syncBtn');
    const loadEmbBtn = document.getElementById('loadEmbBtn');
    const classSelect = document.getElementById('classSelect');
    const sectionSelect = document.getElementById('sectionSelect');

    let stream = null;

    function log(msg) {
        logEl.textContent = new Date().toLocaleTimeString() + ' — ' + msg + '\n' + logEl.textContent;
    }

    startBtn.addEventListener('click', async () => {
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
            video.srcObject = stream;
            await video.play();
            log('Camera started');
        } catch (e) {
            log('Camera error: ' + e.message);
        }
    });

    stopBtn.addEventListener('click', () => {
        if (stream) stream.getTracks().forEach(t => t.stop());
        video.srcObject = null;
        log('Camera stopped');
    });

    // load embeddings (calls backend) - placeholder: fills class select
    loadEmbBtn.addEventListener('click', async () => {
        try {
            // fetch classes or embeddings - simple example to fill select
            // real: GET /api/v1/embeddings?class=X
            log('Fetching embeddings (placeholder)...');
            // Example: add two classes
            classSelect.innerHTML = `<option value="">Select class</option><option value="X-A">X-A</option><option value="X-B">X-B</option>`;
            sectionSelect.innerHTML = `<option value="">Select section</option><option value="A">A</option><option value="B">B</option>`;
            log('Loaded sample class list');
        } catch (err) {
            log('Failed fetching embeddings');
        }
    });

    // Sync queue (send queued attendance to backend)
    syncBtn.addEventListener('click', async () => {
        try {
            const items = await window.srmDB.getAll();
            if (!items.length) { log('No queued records to sync'); return; }
            log('Syncing ' + items.length + ' records...');
            const token = localStorage.getItem('token') || ''; // if auth present
            const res = await fetch(API_BASE + '/attendance/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ records: items })
            });
            if (res.ok) {
                await window.srmDB.clear();
                log('Synced successfully');
                // notify opener (main dashboard) if present
                if (window.opener) window.opener.postMessage({ type: 'attendance_synced', count: items.length }, location.origin);
            } else {
                const txt = await res.text();
                log('Sync failed: ' + txt);
            }
        } catch (e) {
            log('Sync error: ' + e.message);
        }
    });

    // Example function to mark attendance (manual testing)
    window.markAttendanceLocally = async function (student_id, status = 'present') {
        const rec = {
            student_id,
            status,
            method: 'manual',
            confidence: null,
            date: (new Date()).toISOString().slice(0, 10),
            timestamp: new Date().toISOString()
        };
        // try online first (if backend available)
        try {
            if (!navigator.onLine) throw new Error('offline');
            const token = localStorage.getItem('token') || '';
            const r = await fetch(API_BASE + '/attendance/mark', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify(rec)
            });
            if (!r.ok) throw new Error('server');
            log('Marked online: ' + student_id);
        } catch (err) {
            await window.srmDB.add(rec);
            log('Queued locally: ' + student_id);
        }
    };

    // simple message to console for testing
    log('Scanner loaded — ready');
})();
