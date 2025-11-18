(function(){
  // Network-backed implementation of the previous local IndexedDB API
  const API_BASE = (window.SRM_API_BASE || localStorage.getItem('SRM_API_BASE') || 'http://localhost:4000');

  async function http(path, { method='GET', body, headers }={}){
    const res = await fetch(API_BASE + path, {
      method,
      headers: { 'Content-Type':'application/json', ...(headers||{}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit'
    });
    if (!res.ok){
      const t = await res.text().catch(()=> '');
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${t}`);
    }
    const ct = res.headers.get('content-type')||'';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // Compatibility no-op (kept for callers that expect it exists)
  async function openDB(){ return true; }

  async function addStudent(student){
    const clean = {
      name: (student.name||'').trim(),
      roll: (student.roll||'').trim(),
      section: (student.section||'').trim(),
      department: (student.department||'').trim(),
      course: (student.course||'').trim(),
      phone: (student.phone||'').trim(),
      year: student.year ? Number(student.year) : null,
      semester: student.semester ? Number(student.semester) : null,
      email: (student.email||'').trim()
    };
    try {
      const r = await http('/api/v1/students', { method:'POST', body: clean });
      return r.id;
    } catch (e) {
      // Handle duplicate roll conflict: fetch existing by roll and return its id
      if (/duplicate/i.test(e.message) && clean.roll) {
        try {
          const all = await listStudents();
          const existing = all.find(s => String(s.roll).trim() === clean.roll);
          if (existing) return existing.id;
        } catch(_) {}
      }
      throw e;
    }
  }

  // Save face preview image against a student id
  async function saveFacePreview(id, dataUrl){
    if (!id || !dataUrl) return false;
    try{
      await http(`/api/v1/students/${encodeURIComponent(id)}/face-preview`, { method:'POST', body:{ dataUrl } });
    } finally {
      try { localStorage.setItem(`srm:facePreview:${id}`, dataUrl); } catch(_){}
    }
    return true;
  }

  async function listStudents(){ return http('/api/v1/students'); }
  async function getStudent(id){ return http(`/api/v1/students/${Number(id)}`); }
  async function updateStudent(id, changes){ await http(`/api/v1/students/${Number(id)}`, { method:'PUT', body: changes }); return { id:Number(id), ...changes }; }
  async function deleteStudent(id, cascade=true){ await http(`/api/v1/students/${Number(id)}?cascade=${cascade!==false}`,{ method:'DELETE' }); return true; }

  function isoDate(d){ const dd = (d instanceof Date) ? d : new Date(d); return dd.toISOString().slice(0,10); }

  async function recordAttendance({ studentId, date=new Date(), present=true }){
    const payload = { student_id: Number(studentId), date: isoDate(date), status: present? 'present':'absent', method: 'manual' };
    await http('/api/v1/attendance/mark', { method:'POST', body: payload });
    return true;
  }

  async function dashboardStats(start, end, threshold=75){
    const s = isoDate(start), e = isoDate(end);
    return http(`/api/v1/stats/dashboard?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}&threshold=${encodeURIComponent(threshold)}`);
  }

  // The following are provided for compatibility but now rely on dashboardStats/listStudents
  async function totalStudents(){ const arr = await listStudents(); return arr.length; }
  async function getTodayPresent(){ const s = new Date(); const stats = await dashboardStats(new Date(s.getFullYear(), s.getMonth(), s.getDate()), s, 75); return Math.round((stats.todayPresentPercent/100) * (stats.totalStudents||0)); }
  async function monthlySeries(start, end){ const s = await dashboardStats(start,end,75); return { labels: s.labels||[], series: s.series||[] }; }
  async function shortList(start, end, threshold=75){ const s = await dashboardStats(start,end,threshold); return s.short||[]; }

  window.srmLocal = { openDB, addStudent, saveFacePreview, listStudents, getStudent, updateStudent, deleteStudent, recordAttendance, totalStudents, getTodayPresent, monthlySeries, shortList, dashboardStats };
})();
