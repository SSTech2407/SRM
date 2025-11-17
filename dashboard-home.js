document.addEventListener('DOMContentLoaded', () => {
  const markBtn = document.getElementById('markAttendanceBtn');
  const registerBtn = document.getElementById('openRegister');
  const applyBtn = document.getElementById('applyRange');
  const startEl = document.getElementById('rangeStart');
  const endEl = document.getElementById('rangeEnd');
  const thresholdEl = document.getElementById('threshold');
  const shortBody = document.getElementById('shortBody');
  const kpiStudents = document.getElementById('kpiStudents');
  const kpiToday = document.getElementById('kpiToday');
  const kpiShort = document.getElementById('kpiShort');
  const teacherSpan = document.getElementById('teacher-name');

  // Optional: populate teacher name from ?name= query
  try {
    const params = new URLSearchParams(window.location.search);
    const nm = params.get('name');
    if (nm && teacherSpan) teacherSpan.textContent = nm.trim();
  } catch (e) { }

  markBtn?.addEventListener('click', () => {
    window.open('attendance_app/scanner.html', '_blank', 'noopener');
  });
  registerBtn?.addEventListener('click', () => {
    window.open('attendance_app/scanner.html?mode=register', '_blank', 'noopener');
  });

  // Load real stats from local IndexedDB if available, fallback to mock
  async function refreshDashboard(){
    try{
      const to = new Date();
      const from = new Date(to.getFullYear(), to.getMonth() - 5, 1);
      const threshold = Number(thresholdEl?.value || 75);
      if (window.srmLocal){
        const stats = await window.srmLocal.dashboardStats(from, to, threshold);
        kpiStudents.textContent = stats.totalStudents;
        kpiToday.textContent = (stats.todayPresentPercent||0) + '%';
        if (homeChart){
          homeChart.data.labels = stats.labels;
          homeChart.data.datasets[0].data = stats.series;
          homeChart.update();
        }
        renderShortTable(stats.short);
        kpiShort.textContent = stats.shortCount;
        return;
      }
    }catch(err){ console.warn('local DB stats failed, using mock', err); }

    // MOCK fallback
    const students = Array.from({ length: 60 }).map((_, i) => ({
      id: 1000 + i,
      name: `Student ${i + 1}`,
      roll: `R-${(i + 1).toString().padStart(3, '0')}`,
      dept: ['BCA', 'BSc', 'BCom', 'BTech'][i % 4]
    }));
    kpiStudents.textContent = students.length;
    kpiToday.textContent = Math.round(70 + Math.random() * 30) + '%';
    const start = startEl.value ? parseMonth(startEl.value) : null;
    const end = endEl.value ? parseMonth(endEl.value) : null;
    const threshold = Number(thresholdEl.value || 75);
    const shortList = students.map(s => ({ ...s, pct: simulatePercent(s.id, start, end) }))
      .filter(s => s.pct < threshold)
      .sort((a, b) => a.pct - b.pct);
    renderShortTable(shortList);
    kpiShort.textContent = shortList.length;
  }

  // Chart init (guard if Chart missing)
  let homeChart = null;
  const canvas = document.getElementById('homeAttendanceChart');
  if (window.Chart && canvas) {
    const ctx = canvas.getContext('2d');
    homeChart = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [{ label: 'Avg Attendance', data: [], fill: true, backgroundColor: gradient(ctx), borderColor: '#7c3aed', tension: 0.36 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { suggestedMin: 30, suggestedMax: 100 } } }
    });
  }

  // Initialize default range (last 6 months)
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - 5, 1);
  startEl.value = toISOStringMonth(from);
  endEl.value = toISOStringMonth(to);
  applyRange();
  applyBtn?.addEventListener('click', applyRange);
  document.addEventListener('srm:data-changed', refreshDashboard);

  function applyRange() {
    const start = startEl.value ? parseMonth(startEl.value) : null;
    const end = endEl.value ? parseMonth(endEl.value) : null;
    const threshold = Number(thresholdEl.value || 75);
    const labels = monthsBetween(start, end);
    const series = labels.map((l, i) => Math.round(70 + Math.sin(i / 1.3) * 8 + Math.random() * 6));

    if (homeChart) {
      homeChart.data.labels = labels;
      homeChart.data.datasets[0].data = series;
      homeChart.update();
    }
    // After adjusting range, recompute from DB if available
    refreshDashboard();
  }

  function renderShortTable(list) {
    shortBody.innerHTML = '';
    if (!list.length) {
      shortBody.innerHTML = '<tr><td colspan="5" class="muted">No students below threshold for selected range.</td></tr>';
      return;
    }
    for (const s of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(s.name)}</td><td>${s.roll}</td><td>${s.dept}</td><td><strong>${s.pct}%</strong></td><td><button class="btn ghost" type="button">View</button></td>`;
      shortBody.appendChild(tr);
    }
  }

  // Helpers
  function parseMonth(val) { if (!val) return null; const [y, m] = val.split('-'); return new Date(Number(y), Number(m) - 1, 1); }
  function toISOStringMonth(d) { if (!d) return ''; return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function monthsBetween(s, e) { const out = []; if (!s || !e) return out; const d = new Date(s); while (d <= e) { out.push(d.toLocaleString('default', { month: 'short', year: 'numeric' })); d.setMonth(d.getMonth() + 1); if (out.length > 36) break; } return out; }
  function simulatePercent(id, s, e) { let base = (id % 97) / 97 * 30 + 65; if (s && e) { const days = Math.max(1, Math.round((e - s) / (1000 * 60 * 60 * 24))); base -= Math.min(20, Math.round(days / 7)); } return Math.max(10, Math.round(base)); }
  function gradient(ctx) { const g = ctx.createLinearGradient(0, 0, 0, 220); g.addColorStop(0, 'rgba(124,58,237,0.28)'); g.addColorStop(1, 'rgba(96,165,250,0.05)'); return g; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]); }
});
