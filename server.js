const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.use(session({
  secret: 'physics-secret-key-2026',
  resave: false,
  saveUninitialized: true
}));

const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error('Database error:', err.message);
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
    image_url TEXT,
    option_a TEXT,
    option_b TEXT,
    option_c TEXT,
    option_d TEXT,
    correct_option TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS student_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER,
    test_id INTEGER,
    question_id INTEGER,
    chosen_option TEXT,
    is_correct INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS site_stats (
    id INTEGER PRIMARY KEY,
    visits INTEGER DEFAULT 0
  )`);

  db.run(`INSERT OR IGNORE INTO site_stats (id, visits) VALUES (1, 0)`);
});

const isAdmin = (req) => req.session && req.session.isAdmin;

app.post('/api/login', (req, res) => {
  if (req.body.password === 'admin123') {
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
  db.run('UPDATE site_stats SET visits = visits + 1 WHERE id = 1');
  
  db.get('SELECT visits FROM site_stats WHERE id = 1', [], (err, stat) => {
    db.all('SELECT id, name, class_name FROM students', [], (err, students = []) => {
      db.all('SELECT * FROM tests', [], (err, tests = []) => {
        db.all('SELECT * FROM scores', [], (err, scores = []) => {
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
            visits: stat ? stat.visits : 1,
            tests,
            leaderboard
          });
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

app.delete('/api/students/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'غير مصرح' });
  const studentId = req.params.id;
  db.run('DELETE FROM students WHERE id = ?', [studentId], () => {
    db.run('DELETE FROM scores WHERE student_id = ?', [studentId], () => {
      res.json({ success: true });
    });
  });
});

app.post('/api/students/verify-pin', (req, res) => {
  const { student_id, pin } = req.body;
  db.get('SELECT pin FROM students WHERE id = ?', [student_id], (err, row) => {
    if (row && String(row.pin).trim() === String(pin).trim()) {
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
      const stmt = db.prepare('INSERT INTO questions (test_id, question_text, image_url, option_a, option_b, option_c, option_d, correct_option) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      questions.forEach(q => {
        stmt.run(testId, q.text, q.image_url || '', q.a, q.b, q.c, q.d, q.correct);
      });
      stmt.finalize();
    }
    res.json({ success: true, testId });
  });
});

app.delete('/api/tests/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'غير مصرح' });
  const testId = req.params.id;
  db.run('DELETE FROM tests WHERE id = ?', [testId], () => {
    db.run('DELETE FROM questions WHERE id = ?', [testId], () => {
      db.run('DELETE FROM scores WHERE id = ?', [testId], () => {
        res.json({ success: true });
      });
    });
  });
});

app.get('/api/tests/:id/questions', (req, res) => {
  db.all('SELECT id, question_text, image_url, option_a, option_b, option_c, option_d FROM questions WHERE test_id = ?', [req.params.id], (err, questions) => {
    res.json({ questions: questions || [] });
  });
});

app.post('/api/tests/:id/submit', (req, res) => {
  const testId = req.params.id;
  const { student_id, answers } = req.body;

  db.all('SELECT id, correct_option FROM questions WHERE test_id = ?', [testId], (err, questions) => {
    if (!questions || questions.length === 0) return res.status(400).json({ error: 'لا يوجد أسئلة' });

    let correctCount = 0;
    const stmt = db.prepare('INSERT INTO student_answers (student_id, test_id, question_id, chosen_option, is_correct) VALUES (?, ?, ?, ?, ?)');

    questions.forEach(q => {
      const chosen = answers ? answers[q.id] : null;
      const isCorrect = chosen === q.correct_option ? 1 : 0;
      if (isCorrect) correctCount++;
      stmt.run(student_id, testId, q.id, chosen || '', isCorrect);
    });
    stmt.finalize();

    const score = Math.round((correctCount / questions.length) * 100);

    db.run(`INSERT INTO scores (student_id, test_id, score) VALUES (?, ?, ?)
            ON CONFLICT(student_id, test_id) DO UPDATE SET score = excluded.score`,
      [student_id, testId, score],
      (err) => {
        res.json({ success: true, score, total: 100 });
      });
  });
});

app.get('/api/tests/:id/analytics', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'غير مصرح' });
  const testId = req.params.id;

  db.all('SELECT id, question_text FROM questions WHERE test_id = ?', [testId], (err, questions = []) => {
    db.all('SELECT question_id, is_correct FROM student_answers WHERE test_id = ?', [testId], (err, answers = []) => {
      db.get('SELECT COUNT(DISTINCT student_id) as totalSubs FROM student_answers WHERE test_id = ?', [testId], (err, subRow) => {
        const result = questions.map(q => {
          const qAnswers = answers.filter(a => a.question_id === q.id);
          const correct = qAnswers.filter(a => a.is_correct === 1).length;
          return {
            question_text: q.question_text,
            total: qAnswers.length,
            correct
          };
        });

        res.json({
          totalSubmissions: subRow ? subRow.totalSubs : 0,
          questions: result
        });
      });
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
      () => res.json({ success: true }));
  }
});

app.post('/api/scores/bulk-import', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'غير مصرح' });
  const { test_id, rows } = req.body;

  db.all('SELECT id, name FROM students', [], (err, students = []) => {
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
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
