// backend/index.js - minimal endpoints for attendance module
require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const mysql = require('mysql2/promise');

app.use(cors());
app.use(express.json());

// DB pool - adapt env
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'srm',
  waitForConnections: true,
  connectionLimit: 10
});

// Simple auth middleware stub - replace with JWT verify
async function authMiddleware(req, res, next){
  // Example: if Authorization: Bearer <token> present, decode and attach user
  // For now, attach a dummy teacher user (id=2, role='teacher')
  req.user = { id: 2, role: 'teacher', email: 'teacher@example.com' };
  return next();
}

/**
 * GET /api/v1/embeddings?class=&section=
 * Returns embeddings allowed for caller (for now returns empty or sample)
 */
app.get('/api/v1/embeddings', authMiddleware, async (req, res) => {
  try{
    const cls = req.query.class || null;
    // TODO: fetch embeddings from DB table face_embeddings joined with students
    // Example response shape:
    // [{ student_id:123, embedding:[0.001, 0.002, ...], name:'A B', roll:'R-001' }, ...]
    const [rows] = await pool.query('SELECT fe.student_id, fe.embedding, s.first_name, s.last_name, s.roll FROM face_embeddings fe JOIN students s ON fe.student_id = s.id LIMIT 200');
    const out = rows.map(r => ({ student_id: r.student_id, embedding: JSON.parse(r.embedding), name: (r.first_name||'') + ' ' + (r.last_name||''), roll: r.roll }));
    res.json(out);
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * POST /api/v1/attendance/mark
 * Save single attendance record
 */
app.post('/api/v1/attendance/mark', authMiddleware, async (req, res) => {
  try{
    const { student_id, date, status='present', method='face_scan', confidence=null } = req.body;
    if(!student_id) return res.status(400).json({ error: 'student_id required' });
    const d = date || new Date().toISOString().slice(0,10);
    await pool.query('INSERT INTO attendance (student_id,date,status,method,confidence,marked_by) VALUES (?,?,?,?,?,?)',
      [student_id, d, status, method, confidence, req.user.id]);
    return res.json({ success: true });
  }catch(err){
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

/**
 * POST /api/v1/attendance/sync
 * Bulk insert multiple records (array of objects)
 */
app.post('/api/v1/attendance/sync', authMiddleware, async (req, res) => {
  try{
    const records = req.body.records;
    if(!Array.isArray(records) || !records.length) return res.status(400).json({ error: 'no records' });
    const vals = records.map(r => [r.student_id, r.date||new Date().toISOString().slice(0,10), r.status||'present', r.method||'manual', r.confidence||null, req.user.id]);
    await pool.query('INSERT INTO attendance (student_id,date,status,method,confidence,marked_by) VALUES ?', [vals]);
    return res.json({ success: true, inserted: vals.length });
  }catch(err){
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

/**
 * POST /api/v1/face/register
 * Accept embedding array and store
 */
app.post('/api/v1/face/register', authMiddleware, async (req, res) => {
  try{
    const { student_id, embedding } = req.body;
    if(!student_id || !Array.isArray(embedding)) return res.status(400).json({ error:'invalid' });
    await pool.query('INSERT INTO face_embeddings (student_id, embedding, created_by) VALUES (?, ?, ?)', [student_id, JSON.stringify(embedding), req.user.id]);
    return res.json({ success:true });
  }catch(err){
    console.error(err);
    return res.status(500).json({ error:'server error' });
  }
});

// start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, ()=> console.log('Attendance backend listening on', PORT));
