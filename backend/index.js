// backend/index.js - improved and more robust for embeddings & attendance
require('dotenv').config();
const path = require('path');
const express = require('express');
const app = express();
const cors = require('cors');
const mysql = require('mysql2/promise');

app.use(cors());
app.use(express.json({ limit: '50mb' })); // raise limit for embeddings / preview images
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve front-end static files (project root is parent of backend)
const staticRoot = path.join(__dirname, '..');
app.use(express.static(staticRoot));
app.get('/', (req, res) => res.sendFile(path.join(staticRoot, 'index.html')));

// Simple error handler for oversized payloads
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', message: 'Request body too large' });
  }
  next(err);
});

// DB pool - adapt env
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'srm',
  waitForConnections: true,
  connectionLimit: 10
});

// Create required tables if missing (idempotent)
async function ensureTables(){
  try{
    await pool.query(`CREATE TABLE IF NOT EXISTS students (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255),
      roll VARCHAR(100),
      section VARCHAR(50),
      department VARCHAR(255),
      course VARCHAR(255),
      phone VARCHAR(50),
      year INT,
      semester INT,
      email VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS attendance (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      date DATE NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'present',
      method VARCHAR(50),
      confidence DECIMAL(6,3) NULL,
      marked_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (student_id), INDEX (date)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS face_embeddings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      embedding LONGTEXT NOT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (student_id)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS student_faces (
      student_id INT NOT NULL PRIMARY KEY,
      data_url LONGTEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL
    )`);
  }catch(e){ console.warn('ensureTables warning:', e && e.message ? e.message : e); }
}
ensureTables().catch(()=>{ /* ignore startup errors */ });

// Simple auth middleware stub - replace with JWT verify in production
async function authMiddleware(req, res, next) {
  req.user = { id: 2, role: 'teacher', email: 'teacher@example.com' };
  return next();
}

// ----------------- Helper utilities -----------------
function tryParseEmbedding(raw) {
  // Accept Buffer, JSON string, plain array (already parsed)
  if (raw == null) return null;
  try {
    if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      // sometimes DB stores surrounding quotes or extra chars; attempt JSON.parse
      try {
        return JSON.parse(trimmed);
      } catch (e) {
        // fallback: try to coerce a bracketed list like [-0.1, 0.2, ...]
        const cleaned = trimmed.replace(/[^\d\.\-\s,eE\[\]]/g, '');
        try { return JSON.parse(cleaned); } catch (e2) { return null; }
      }
    }
    // if it's already an object/array
    if (Array.isArray(raw)) return raw;
    return null;
  } catch (err) {
    return null;
  }
}

// debug endpoint: reveal first embedding raw + parsed details
app.get('/api/v1/embeddings/debug', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT student_id, embedding FROM face_embeddings LIMIT 1');
    if (!rows || rows.length === 0) return res.json({ ok: false, msg: 'no embedding rows found' });
    const r = rows[0];
    let embRaw = r.embedding;
    let rawType = typeof embRaw;
    if (Buffer.isBuffer(embRaw)) {
      embRaw = embRaw.toString('utf8');
      rawType = 'buffer->utf8';
    }
    let parsed = null;
    try { parsed = JSON.parse(embRaw); } catch (e) { parsed = null; }
    return res.json({
      ok: true,
      student_id: r.student_id,
      rawSample: String(embRaw).slice(0, 400),
      rawType,
      parsedIsArray: Array.isArray(parsed),
      parsedLen: Array.isArray(parsed) ? parsed.length : null
    });
  } catch (err) {
    console.error('DEBUG /embeddings error:', err && err.stack ? err.stack : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : 'server error' });
  }
});

/**
 * GET /api/v1/embeddings
 * Returns embeddings in form: [{ student_id, roll, name, embedding: [numbers] }, ...]
 * - will skip invalid or unparsable embeddings
 * - optional query: ?limit=100
 * - optional query: ?minLen=128
 */
// Safe embeddings endpoint — tolerant to varying students schema
app.get('/api/v1/embeddings', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit || 200));
    // Select fe.* + all student columns so we don't reference non-existent columns in SQL
    const [rows] = await pool.query(
      'SELECT fe.student_id, fe.embedding, s.* FROM face_embeddings fe LEFT JOIN students s ON fe.student_id = s.id LIMIT ?',
      [limit]
    );

    const out = [];
    for (const r of rows) {
      try {
        // parse the embedding robustly
        let parsed = r.embedding;
        if (Buffer.isBuffer(parsed)) parsed = parsed.toString('utf8');
        if (typeof parsed === 'string') {
          parsed = parsed.trim();
          if (!parsed) continue;
          parsed = JSON.parse(parsed);
        }
        if (!Array.isArray(parsed)) continue;

        // choose a roll-like field from available columns (safe)
        const roll = r.roll || r.roll_number || r.rollno || r.roll_no || r.rollNumber || r.rollNum || null;
        const name = r.name || r.full_name || r.first_name || r.username || null;

        // ensure it contains numbers
        const numbersOk = parsed.every(v => typeof v === 'number' || (!Number.isNaN(Number(v)) && isFinite(Number(v))));
        if (!numbersOk) continue;

        // enforce descriptor length (128 by default)
        if (parsed.length < 120) {
          // skip unexpectedly short embeddings (log for debugging)
          console.warn('Skipping embedding for student', r.student_id, 'length', parsed.length);
          continue;
        }

        out.push({ student_id: r.student_id, roll, name, embedding: parsed });
      } catch (parseErr) {
        console.warn('Skipping invalid embedding row for student', r.student_id, parseErr && parseErr.message);
        // continue to next row
      }
    }

    return res.json(out);
  } catch (err) {
    console.error('GET /api/v1/embeddings failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server_error', message: err && err.message ? err.message : 'embedding fetch error' });
  }
});


// Compatibility alias for older clients that post to /api/attendance
app.post('/api/attendance', authMiddleware, async (req, res) => {
  // If client posts single attendance object, forward to /api/v1/attendance/mark behavior
  try {
    const body = req.body || {};
    if (body && body.student_id) {
      // insert as single
      const { student_id, date, status = 'present', method = 'face_scan', confidence = null } = body;
      const d = date || new Date().toISOString().slice(0, 10);
      await pool.query('INSERT INTO attendance (student_id,date,status,method,confidence,marked_by) VALUES (?,?,?,?,?,?)',
        [student_id, d, status, method, confidence, req.user.id]);
      return res.json({ success: true });
    } else if (Array.isArray(body)) {
      // legacy: body is array of records
      const vals = body.map(r => [r.student_id, r.date || new Date().toISOString().slice(0,10), r.status || 'present', r.method || 'manual', r.confidence || null, req.user.id]);
      await pool.query('INSERT INTO attendance (student_id,date,status,method,confidence,marked_by) VALUES ?', [vals]);
      return res.json({ success: true, inserted: vals.length });
    } else {
      return res.status(400).json({ error: 'invalid_payload' });
    }
  } catch (err) {
    console.error('/api/attendance error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /api/v1/attendance/mark
 * Save single attendance record
 */
// POST /api/v1/attendance/mark  (robust)
app.post('/api/v1/attendance/mark', authMiddleware, async (req, res) => {
  try {
    console.info('[attendance/mark] payload:', req.body);

    const payload = req.body || {};
    // allow student_id or roll fallback (scanner might send label instead)
    let { student_id, date, status = 'present', method = 'face', confidence = null } = payload;

    // normalize
    student_id = student_id ? Number(student_id) : null;
    if (Number.isNaN(student_id)) student_id = null;
    date = date || new Date().toISOString().slice(0,10);

    // Basic validation
    if (!student_id) {
      // if scanner sent roll string label instead of id, return 400 so client can queue or reconcile
      return res.status(400).json({ error: 'invalid_payload', message: 'student_id required (numeric)' });
    }
    if (!['present','absent','late'].includes(String(status))) status = 'present';
    method = String(method || 'face').slice(0,50);

    // Optional: avoid duplicate mark for same student + date
    const [existing] = await pool.query('SELECT id FROM attendance WHERE student_id = ? AND date = ? LIMIT 1', [student_id, date]);
    if (Array.isArray(existing) && existing.length) {
      console.info('[attendance/mark] duplicate skip for', student_id, date);
      return res.status(409).json({ error: 'already_marked', message: 'Attendance already marked for this student on this date' });
    }

    // Try insert - use explicit column list matching common schema
    const sql = 'INSERT INTO attendance (student_id, date, status, method, confidence, marked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())';
    await pool.query(sql, [student_id, date, status, method, confidence, req.user?.id || null]);

    return res.json({ success: true, student_id, date });
  } catch (err) {
    // log full error server-side
    console.error('[attendance/mark] ERROR:', err && (err.stack || err.message || err));
    // return error message (useful during dev). In production you might hide stack.
    return res.status(500).json({ error: 'server_error', message: String(err && (err.sqlMessage || err.message || err)) });
  }
});


/**
 * POST /api/v1/attendance/sync
 * Bulk insert multiple records (array of objects)
 * Expected body: { records: [ { student_id, date, status, method, confidence }, ... ] }
 */
app.post('/api/v1/attendance/sync', authMiddleware, async (req, res) => {
  try {
    const records = req.body.records || req.body || [];
    const arr = Array.isArray(records) ? records : [];
    if (!arr.length) return res.status(400).json({ error: 'no_records' });
    const vals = arr.map(r => [r.student_id, r.date || new Date().toISOString().slice(0, 10), r.status || 'present', r.method || 'manual', r.confidence || null, req.user.id]);
    // Bulk insert
    await pool.query('INSERT INTO attendance (student_id,date,status,method,confidence,marked_by) VALUES ?', [vals]);
    return res.json({ success: true, inserted: vals.length });
  } catch (err) {
    console.error('POST /api/v1/attendance/sync failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /api/v1/face/register
 * Accept embedding array and store
 */
app.post('/api/v1/face/register', authMiddleware, async (req, res) => {
  try {
    const { student_id, embedding } = req.body;
    if (!student_id || !Array.isArray(embedding)) return res.status(400).json({ error: 'invalid_payload' });
    console.info('[face/register] student', student_id, 'descriptor length', embedding.length, 'sample', embedding.slice(0,5));
    await pool.query('INSERT INTO face_embeddings (student_id, embedding, created_by) VALUES (?, ?, ?)', [student_id, JSON.stringify(embedding), req.user.id]);
    // optional update student flags (if present)
    try {
      const cols = await getStudentColumns();
      const sets = [];
      const args = [];
      if (cols.has('face_registered')) { sets.push('face_registered=?'); args.push(1); }
      if (cols.has('updated_at')) { sets.push('updated_at=NOW()'); }
      if (sets.length) {
        await pool.query(`UPDATE students SET ${sets.join(', ')} WHERE id=?`, [...args, Number(student_id)]);
      }
    } catch (e) { console.warn('Optional update failed:', e && e.message ? e.message : e); }
    return res.json({ success: true });
  } catch (err) {
    console.error('POST /api/v1/face/register failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---------------- Students CRUD (unchanged logic) ----------------
const pickStudentFields = (b) => ({
  name: b.name ?? null,
  roll: b.roll ?? null,
  section: b.section ?? null,
  department: b.department ?? null,
  course: b.course ?? null,
  phone: b.phone ?? null,
  year: b.year ?? null,
  semester: b.semester ?? null,
  email: b.email ?? null
});

function normalizeStudent(r){
  const name = r.name || (r.first_name && r.last_name ? `${r.first_name} ${r.last_name}` : (r.first_name || r.last_name || ''));
  const roll = r.roll || r.roll_number || r.rollno || r.roll_no || '';
  const section = r.section || r.sec || '';
  const department = r.department || r.dept || '';
  const course = r.course || r.branch || '';
  const phone = r.phone || r.mobile || r.phone_number || '';
  const year = r.year || r.admission_year || null;
  const semester = r.semester || r.sem || null;
  const email = r.email || r.mail || '';
  return { id: r.id, name, roll, section, department, course, phone, year, semester, email, facePreviewData: r.facePreviewData || r.data_url || null };
}

let studentColsCache = null;
async function getStudentColumns(){
  if (studentColsCache) return studentColsCache;
  const [rows] = await pool.query('SHOW COLUMNS FROM students');
  const meta = new Map();
  for (const r of rows){
    meta.set(r.Field, { name: r.Field, type: String(r.Type||'').toLowerCase(), nullable: String(r.Null||'') !== 'NO', default: r.Default, extra: String(r.Extra||'').toLowerCase() });
  }
  studentColsCache = meta;
  return studentColsCache;
}

async function mapStudentToDbColumns(s){
  const cols = await getStudentColumns();
  const has = (k)=> cols.has(k);
  const out = {};
  if (has('name') && s.name != null) out.name = s.name;
  else {
    const nm = (s.name||'').trim();
    if (nm){
      const [first, ...rest] = nm.split(/\s+/);
      const last = rest.join(' ');
      if (has('first_name')) out.first_name = first;
      if (has('last_name')) out.last_name = last;
    }
  }
  const pick = (val, keys)=>{ for (const k of keys){ if (has(k) && val!=null) { out[k]=val; break; } } };
  pick(s.roll, ['roll','roll_no','rollno','roll_number']);
  pick(s.section, ['section','sec']);
  pick(s.department, ['department','dept']);
  pick(s.course, ['course','branch']);
  pick(s.phone, ['phone','mobile','phone_number']);
  pick(s.year, ['year','admission_year']);
  pick(s.semester, ['semester','sem']);
  pick(s.email, ['email','mail']);
  return out;
}

app.get('/api/v1/students', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT s.*, sf.data_url AS facePreviewData FROM students s LEFT JOIN student_faces sf ON sf.student_id = s.id ORDER BY s.id DESC`);
    res.json(rows.map(normalizeStudent));
  } catch (err) { console.error(err); res.status(500).json({ error: 'server error' }); }
});

app.get('/api/v1/students/:id', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT s.*, (SELECT data_url FROM student_faces WHERE student_id=s.id) AS facePreviewData FROM students s WHERE s.id=?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(normalizeStudent(rows[0]));
  } catch (err) { console.error(err); res.status(500).json({ error: 'server error' }); }
});

app.post('/api/v1/students', authMiddleware, async (req, res) => {
  try {
    const s = pickStudentFields(req.body);
    const mapped = await mapStudentToDbColumns(s);
    let keys = Object.keys(mapped);
    if (!keys.length) return res.status(400).json({ error:'no mappable fields' });

    // auto-fill not-null columns without defaults
    const cols = await getStudentColumns();
    for (const [name, meta] of cols.entries()){
      if (keys.includes(name)) continue;
      if (name === 'id') continue;
      if (meta.extra.includes('auto_increment')) continue;
      const hasDefault = meta.default != null || meta.nullable;
      if (!hasDefault){
        const t = meta.type;
        let v = null;
        if (/(int|decimal|numeric|float|double)/.test(t)) v = 0;
        else if (/date/.test(t)) v = new Date();
        else v = '';
        mapped[name] = v;
      }
    }
    keys = Object.keys(mapped);

    const placeholders = keys.map(()=> '?').join(',');
    const sql = `INSERT INTO students (${keys.join(',')}) VALUES (${placeholders})`;
    const [r] = await pool.query(sql, keys.map(k=> mapped[k]));
    res.json({ id: r.insertId, ...s });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY'){
      return res.status(409).json({ error: 'duplicate', message: err.sqlMessage });
    }
    if (err && err.code === 'ER_NO_DEFAULT_FOR_FIELD'){
      return res.status(400).json({ error: 'missing_required', message: err.sqlMessage });
    }
    console.error('POST /students failed:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/v1/students/:id/face-preview', authMiddleware, async (req, res)=>{
  try{
    await ensureTables();
    const id = Number(req.params.id);
    const { dataUrl } = req.body || {};
    if (!id || !dataUrl) return res.status(400).json({ error:'invalid' });
    await pool.query('INSERT INTO student_faces (student_id, data_url, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE data_url=VALUES(data_url), updated_at=NOW()', [id, dataUrl]);
    res.json({ success:true });
  }catch(err){ console.error(err); res.status(500).json({ error:'server error' }); }
});

app.post('/api/v1/students/import', authMiddleware, async (req,res)=>{
  try{
    const arr = Array.isArray(req.body?.students) ? req.body.students : [];
    if (!arr.length) return res.status(400).json({ error:'no students' });
    const values = arr.map(s=> [s.name||null,s.roll||null,s.section||null,s.department||null,s.course||null,s.phone||null,s.year||null,s.semester||null,s.email||null]);
    // if values is big, consider chunking; here we use multiple row insert
    const placeholders = values.map(()=> '(?,?,?,?,?,?,?,?,?)').join(',');
    await pool.query('INSERT INTO students (name, roll, section, department, course, phone, year, semester, email) VALUES ' + placeholders, values.flat());
    res.json({ success:true, inserted: values.length });
  }catch(err){ console.error(err); res.status(500).json({ error:'server error' }); }
});

app.get('/api/v1/students/export', authMiddleware, async (req,res)=>{
  try{
    const [rows] = await pool.query('SELECT id,name,roll,section,department,course,phone,year,semester,email FROM students ORDER BY id');
    const header = 'id,name,roll,section,department,course,phone,year,semester,email\n';
    const csv = header + rows.map(r=> [r.id,r.name,r.roll,r.section,r.department,r.course,r.phone,r.year,r.semester,r.email].map(v=>`"${(v??'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename="students.csv"');
    res.send(csv);
  }catch(err){ console.error(err); res.status(500).json({ error:'server error' }); }
});

app.put('/api/v1/students/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const s = pickStudentFields(req.body);
    const mapped = await mapStudentToDbColumns(s);
    const cols = await getStudentColumns();
    if (cols.has('updated_at')) mapped.updated_at = new Date();
    const keys = Object.keys(mapped);
    if (!keys.length) return res.status(400).json({ error:'no mappable fields' });
    const setClause = keys.map(k=> `${k}=?`).join(',');
    const sql = `UPDATE students SET ${setClause} WHERE id=?`;
    await pool.query(sql, [...keys.map(k=> mapped[k]), id]);
    res.json({ id, ...s });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server error' }); }
});

app.delete('/api/v1/students/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const cascade = String(req.query.cascade || 'true') !== 'false';
    if (cascade) {
      await pool.query('DELETE FROM attendance WHERE student_id=?', [id]);
      await pool.query('DELETE FROM face_embeddings WHERE student_id=?', [id]);
    }
    await pool.query('DELETE FROM students WHERE id=?', [id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server error' }); }
});

// ---------------- Dashboard stats ----------------
app.get('/api/v1/stats/dashboard', authMiddleware, async (req, res) => {
  try {
    const start = req.query.start;
    const end = req.query.end;
    const threshold = Number(req.query.threshold || 75);
    const [[ts]] = await pool.query('SELECT COUNT(*) AS c FROM students');
    const totalStudents = Number(ts.c || 0);
    const [[tp]] = await pool.query("SELECT COUNT(DISTINCT student_id) AS c FROM attendance WHERE date = CURDATE() AND status='present'");
    const todayPresentPercent = totalStudents ? Math.round((Number(tp.c || 0) / totalStudents) * 100) : 0;

    let labels = [], series = [];
    if (start && end) {
      const [rows] = await pool.query(
        "SELECT DATE_FORMAT(date,'%Y-%m') ym, SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) AS present, COUNT(*) AS total FROM attendance WHERE date BETWEEN ? AND ? GROUP BY ym ORDER BY ym",
        [start, end]
      );
      labels = rows.map(r => {
        const [y, m] = r.ym.split('-');
        return new Date(Number(y), Number(m) - 1, 1).toLocaleString('default', { month: 'short', year: 'numeric' });
      });
      series = rows.map(r => Math.round((Number(r.present) / Math.max(1, Number(r.total))) * 100));
    }

    const [agg] = await pool.query(
      "SELECT s.id AS id, SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) AS present, COUNT(a.id) AS total FROM students s JOIN attendance a ON a.student_id = s.id AND a.date BETWEEN ? AND ? GROUP BY s.id HAVING total > 0 AND (present/total)*100 < ? ORDER BY (present/total) ASC",
      [start || '1970-01-01', end || '2100-12-31', threshold]
    );
    let short = [];
    if (agg.length){
      const ids = agg.map(r=> r.id);
      const [rows] = await pool.query(`SELECT s.*, sf.data_url AS facePreviewData FROM students s LEFT JOIN student_faces sf ON sf.student_id=s.id WHERE s.id IN (${ids.map(()=> '?').join(',')})`, ids);
      const byId = new Map(rows.map(r=> [r.id, normalizeStudent(r)]));
      short = agg.map(r=> ({ id: r.id, name: byId.get(r.id)?.name || '', roll: byId.get(r.id)?.roll || '', dept: byId.get(r.id)?.course || byId.get(r.id)?.department || '', pct: Math.round((Number(r.present) / Math.max(1, Number(r.total))) * 100) }));
    }
    res.json({ totalStudents, todayPresentPercent, labels, series, shortCount: short.length, short });
  } catch (err) { console.error(err); res.status(500).json({ error: 'server error' }); }
});

// ---------------- Health (debug) ----------------
app.get('/api/v1/health', async (req, res) => {
  try {
    const [[v]] = await pool.query('SELECT VERSION() AS mysql_version');
    const [[db]] = await pool.query('SELECT DATABASE() AS db');
    let students = null;
    try{
      const [[cnt]] = await pool.query('SELECT COUNT(*) AS c FROM students');
      students = Number(cnt.c||0);
    }catch(err){ students = null; }
    res.json({ ok: true, db: db.db, mysql: v.mysql_version, students_count: students });
  } catch (err) {
    res.status(500).json({ ok:false, code: err.code, message: err.message });
  }
});

// start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log('Attendance backend listening on', PORT));
