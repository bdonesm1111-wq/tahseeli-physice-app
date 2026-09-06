const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
  secret: 'physics-secret-key-2026',
  resave: false,
  saveUninitialized: true
}));

const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error(err.message);
  else console.log('Connected to SQLite database.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    class_name TEXT NOT NULL,
    pin TEXT DEFAULT '1234'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    max_score REAL DEFAULT 100
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER,
    test_id INTEGER,
    score REAL,
    UNIQUE(student_id, test_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id INTEGER,
    question_text TEXT,
    option_a TEXT,
    option_b TEXT,
    option_c TEXT,
    option_d TEXT,
    correct_option TEXT
  )`);
});

const isAdmin = (req) => req.session && req.session.isAdmin;

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === 'admin123') {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'كلمة المرور خاطئة' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth-check', (req, res) => {
  res.json({ isAdmin: !!isAdmin(req) });
});

app.get('/api/data', (req, res) => {
  db.all('SELECT id, name, class_name FROM students', [], (err, students) => {
    db.all('SELECT * FROM tests', [], (err, tests) => {
      db.all('SELECT * FROM scores', [], (err, scores) => {
        const leaderboard = students.map(st => {
          const stScores = scores.filter(s => s.student_id === st.id);
          const scoresMap = {};
          let total = 0;
          stScores.forEach(s => {
            scoresMap[s.test_id] = s.score;
            total += s.score;
          });
          const count = stScores.length;
          const avg = count > 0 ? (total / count).toFixed(1) : 0;
          return { ...st, scoresMap, total, avg: parseFloat(avg) };
        });

        res.json({
          totalStudents: students.length,
          totalTests: tests.length,
          tests,
          leaderboard
        });
      });
    });
  });
});

app.post('/api/students/bulk', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'غير مصرح' });
  const { class_name, students } = req.body;
  const stmt = db.prepare('INSERT INTO students (name, class_name, pin) VALUES (?, ?, ?)');
  students.forEach(st => stmt.run(st.name, class_name, st.pin));
  stmt.finalize();
  res.json({ success: true });
});

app.post('/api/students/verify-pin', (req, res) => {
  const { student_id, pin } = req.body;
  db.get('SELECT pin FROM students WHERE id = ?', [student_id], (err, row) => {
    if (row && row.pin.trim() === pin.trim()) {
      res.json({ valid: true });
    } else {
      res.json({ valid: false });
    }
  });
});

app.post('/api/tests/full', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'غير مصرح' });
  const { name, max_score, questions } = req.body;

  db.run('INSERT INTO tests (name, max_score) VALUES (?, ?)', [name, max_score || 100], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    const testId = this.lastID;

    if (questions && questions.length > 0) {
      const stmt = db.prepare('INSERT INTO questions (test_id, question_text, option_a, option_b, option_c, option_d, correct_option) VALUES (?, ?, ?, ?, ?, ?, ?)');
      questions.forEach(q => {
        stmt.run(testId, q.text, q.a, q.b, q.c, q.d, q.correct);
      });
      stmt.finalize();
    }
    res.json({ success: true, testId });
  });
});

app.delete('/api/tests/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'غير مصرح' });
  const testId = req.params.id;

  db.run('DELETE FROM tests WHERE id = ?', [testId], (err) => {
    db.run('DELETE FROM questions WHERE id = ?', [testId], (err) => {
      db.run('DELETE FROM scores WHERE id = ?', [testId], (err) => {
        res.json({ success: true });
      });
    });
  });
});

app.get('/api/tests/:id/questions', (req, res) => {
  db.all('SELECT id, question_text, option_a, option_b, option_c, option_d FROM questions WHERE test_id = ?', [req.params.id], (err, questions) => {
    res.json({ questions: questions || [] });
  });
});

app.post('/api/tests/:id/submit', (req, res) => {
  const testId = req.params.id;
  const { student_id, answers } = req.body;

  db.all('SELECT id, correct_option FROM questions WHERE test_id = ?', [testId], (err, questions) => {
    if (!questions || questions.length === 0) return res.status(400).json({ error: 'لا يوجد أسئلة لهذا الاختبار' });

    let correctCount = 0;
    questions.forEach(q => {
      if (answers[q.id] === q.correct_option) correctCount++;
    });

    const score = Math.round((correctCount / questions.length) * 100);

    db.run(`INSERT INTO scores (student_id, test_id, score) VALUES (?, ?, ?)
            ON CONFLICT(student_id, test_id) DO UPDATE SET score = excluded.score`,
      [student_id, testId, score],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, score, total: 100 });
      });
  });
});

app.post('/api/scores', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'غير مصرح' });
  const { student_id, test_id, score } = req.body;
  
  if (score === '' || score === null) {
    db.run('DELETE FROM scores WHERE student_id = ? AND test_id = ?', [student_id, test_id], () => res.json({ success: true }));
  } else {
    db.run(`INSERT INTO scores (student_id, test_id, score) VALUES (?, ?, ?)
            ON CONFLICT(student_id, test_id) DO UPDATE SET score = excluded.score`,
      [student_id, test_id, parseFloat(score)],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
  }
});

app.post('/api/scores/bulk-import', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'غير مصرح' });
  const { test_id, rows } = req.body;

  db.all('SELECT id, name FROM students', [], (err, students) => {
    let matched = 0;
    const stmt = db.prepare(`INSERT INTO scores (student_id, test_id, score) VALUES (?, ?, ?)
      ON CONFLICT(student_id, test_id) DO UPDATE SET score = excluded.score`);

    rows.forEach(r => {
      const st = students.find(s => s.name.trim() === r.name.trim());
      if (st && !isNaN(parseFloat(r.score))) {
        stmt.run(st.id, test_id, parseFloat(r.score));
        matched++;
      }
    });

    stmt.finalize();
    res.json({ success: true, matched });
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
