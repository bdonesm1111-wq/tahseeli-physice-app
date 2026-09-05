const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const db = new Database("data.sqlite");
db.pragma("foreign_keys = ON");

// 1. إنشاء الجداول في قاعدة البيانات
db.exec(`
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  class_name TEXT NOT NULL CHECK(class_name IN ('أ','ب','ج','د')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  max_score REAL NOT NULL DEFAULT 100,
  test_date TEXT DEFAULT CURRENT_DATE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  UNIQUE(student_id, test_id)
);
`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: "tahseeli-secret-key",
  resave: false,
  saveUninitialized: false
}));

const ADMIN_PASS = "admin123";

function checkAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: "غير مصرح" });
}

// 2. مسارات التحقق والأدمن
app.post("/api/login", (req, res) => {
  if (req.body.password === ADMIN_PASS) {
    req.session.isAdmin = true;
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: "كلمة المرور خاطئة" });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get("/api/auth-check", (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// 3. مسارات بيانات الطلاب والاختبارات
app.get("/api/data", (req, res) => {
  const students = db.prepare("SELECT * FROM students").all();
  const tests = db.prepare("SELECT * FROM tests ORDER BY id ASC").all();
  const scores = db.prepare("SELECT * FROM scores").all();

  const leaderboard = students.map(st => {
    const stScores = scores.filter(s => s.student_id === st.id);
    const count = stScores.length;
    const total = stScores.reduce((sum, s) => sum + s.score, 0);
    const avg = count > 0 ? (total / count) : 0;

    return {
      id: st.id,
      name: st.name,
      class_name: st.class_name,
      count,
      total: Number(total.toFixed(2)),
      avg: Number(avg.toFixed(2)),
      scoresMap: Object.fromEntries(stScores.map(s => [s.test_id, s.score]))
    };
  });

  res.json({ leaderboard, tests, totalStudents: students.length, totalTests: tests.length });
});

app.post("/api/students", checkAdmin, (req, res) => {
  const { name, class_name } = req.body;
  if (!name || !['أ','ب','ج','د'].includes(class_name)) return res.status(400).json({ error: "بيانات ناقصة" });
  db.prepare("INSERT INTO students (name, class_name) VALUES (?, ?)").run(name, class_name);
  res.json({ ok: true });
});

app.delete("/api/students/:id", checkAdmin, (req, res) => {
  db.prepare("DELETE FROM students WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/tests", checkAdmin, (req, res) => {
  const { name, max_score } = req.body;
  if (!name) return res.status(400).json({ error: "الاسم مطلوب" });
  db.prepare("INSERT INTO tests (name, max_score) VALUES (?, ?)").run(name, max_score || 100);
  res.json({ ok: true });
});

app.delete("/api/tests/:id", checkAdmin, (req, res) => {
  db.prepare("DELETE FROM tests WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/scores", checkAdmin, (req, res) => {
  const { student_id, test_id, score } = req.body;
  if (score === "" || score === null) {
    db.prepare("DELETE FROM scores WHERE student_id = ? AND test_id = ?").run(student_id, test_id);
  } else {
    db.prepare(`
      INSERT INTO scores (student_id, test_id, score) VALUES (?, ?, ?)
      ON CONFLICT(student_id, test_id) DO UPDATE SET score = excluded.score
    `).run(student_id, test_id, Number(score));
  }
  res.json({ ok: true });
});

// 4. توجيه الواجهة الرئيسية من المجلد الحالي مباشرة
app.use(express.static(__dirname));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 5. تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
