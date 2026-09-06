const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const db = new Database("data.sqlite");
db.pragma("foreign_keys = ON");

// إنشاء الجداول (الطلاب، الاختبارات، الأسئلة، والدرجات)
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
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL CHECK(correct_option IN ('A','B','C','D'))
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

// جلب البيانات العامة وجدول الصدارة
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

// استيراد أسماء الطالبات دفعة واحدة
app.post("/api/students/bulk", checkAdmin, (req, res) => {
  const { class_name, names } = req.body;
  if (!['أ','ب','ج','د'].includes(class_name) || !Array.isArray(names)) {
    return res.status(400).json({ error: "بيانات غير صالحة" });
  }

  const insert = db.prepare("INSERT INTO students (name, class_name) VALUES (?, ?)");
  const insertMany = db.transaction((studentList) => {
    for (const name of studentList) {
      if (name && name.trim()) insert.run(name.trim(), class_name);
    }
  });

  insertMany(names);
  res.json({ ok: true, count: names.length });
});

// إضافة اختبار جديد مع أسئلته
app.post("/api/tests/full", checkAdmin, (req, res) => {
  const { name, max_score, questions } = req.body;
  if (!name) return res.status(400).json({ error: "اسم الاختبار مطلوب" });

  const insertTest = db.prepare("INSERT INTO tests (name, max_score) VALUES (?, ?)");
  const insertQuestion = db.prepare(`
    INSERT INTO questions (test_id, question_text, option_a, option_b, option_c, option_d, correct_option)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const createFullTest = db.transaction(() => {
    const info = insertTest.run(name, max_score || 100);
    const testId = info.lastInsertRowid;

    if (Array.isArray(questions)) {
      for (const q of questions) {
        insertQuestion.run(testId, q.text, q.a, q.b, q.c, q.d, q.correct);
      }
    }
    return testId;
  });

  const testId = createFullTest();
  res.json({ ok: true, testId });
});

// استيراد درجات من Google Forms (الاسم + الدرجة)
app.post("/api/scores/bulk-import", checkAdmin, (req, res) => {
  const { test_id, rows } = req.body; // rows = [{ name: '...', score: 90 }]
  if (!test_id || !Array.isArray(rows)) return res.status(400).json({ error: "بيانات غير مكتمة" });

  const students = db.prepare("SELECT * FROM students").all();
  const insertScore = db.prepare(`
    INSERT INTO scores (student_id, test_id, score) VALUES (?, ?, ?)
    ON CONFLICT(student_id, test_id) DO UPDATE SET score = excluded.score
  `);

  let matched = 0;
  const processScores = db.transaction(() => {
    for (const r of rows) {
      const student = students.find(s => s.name.trim() === r.name.trim());
      if (student && r.score !== "" && !isNaN(r.score)) {
        insertScore.run(student.id, test_id, Number(r.score));
        matched++;
      }
    }
  });

  processScores();
  res.json({ ok: true, matched });
});

// جلب أسئلة اختبار معين للطالبة
app.get("/api/tests/:id/questions", (req, res) => {
  const questions = db.prepare(`
    SELECT id, question_text, option_a, option_b, option_c, option_d 
    FROM questions WHERE test_id = ?
  `).all(req.params.id);
  res.json({ questions });
});

// تقديم الطالبة للاختبار والتصحيح التلقائي
app.post("/api/tests/:id/submit", (req, res) => {
  const { student_id, answers } = req.body; // answers = { question_id: 'A' }
  const testId = req.params.id;

  const test = db.prepare("SELECT * FROM tests WHERE id = ?").get(testId);
  if (!test) return res.status(404).json({ error: "الاختبار غير موجود" });

  // التأكد من عدم الحل المسبق
  const existingScore = db.prepare("SELECT * FROM scores WHERE student_id = ? AND test_id = ?").get(student_id, testId);
  if (existingScore) return res.status(400).json({ error: "لقد قمتِ بحل هذا الاختبار من قبل!" });

  const questions = db.prepare("SELECT * FROM questions WHERE test_id = ?").all(testId);
  if (questions.length === 0) return res.status(400).json({ error: "لا توجد أسئلة لهذا الاختبار" });

  let correctCount = 0;
  for (const q of questions) {
    if (answers[q.id] && answers[q.id] === q.correct_option) {
      correctCount++;
    }
  }

  const scorePerQuestion = test.max_score / questions.length;
  const finalScore = Number((correctCount * scorePerQuestion).toFixed(2));

  db.prepare(`
    INSERT INTO scores (student_id, test_id, score) VALUES (?, ?, ?)
  `).run(student_id, testId, finalScore);

  res.json({ ok: true, score: finalScore, total: test.max_score, correctCount, totalQuestions: questions.length });
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

app.use(express.static(__dirname));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
