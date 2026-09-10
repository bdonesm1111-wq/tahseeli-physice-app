const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// إعدادات البرمجيات الوسيطة
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // مجلد الملفات الثابتة (index.html, quiz.html ..)

// ---------------------------------------------------------
// 1. الاتصال بقاعدة البيانات SQLite وإنشاء الجداول تلقائياً
// ---------------------------------------------------------
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error('خطأ في الاتصال بقاعدة البيانات:', err.message);
  } else {
    console.log('تم الاتصال بقاعدة البيانات SQLite بنجاح.');
  }
});

// إنشاء الجداول في حال عدم وجودها
db.serialize(() => {
  // جدول الطالبات
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      class_name TEXT NOT NULL
    )
  `);

  // جدول الاختبارات
  db.run(`
    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    )
  `);

  // جدول درجات الاختبارات الأصلية
  db.run(`
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      test_id INTEGER NOT NULL,
      score REAL NOT NULL,
      FOREIGN KEY (student_id) REFERENCES students (id),
      FOREIGN KEY (test_id) REFERENCES tests (id),
      UNIQUE(student_id, test_id)
    )
  `);

  // جدول سجل الخطط العلاجية (لتتبع الإتقان دون مساس بالدرجة الأصلية)
  db.run(`
    CREATE TABLE IF NOT EXISTS remediation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      test_id INTEGER NOT NULL,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students (id),
      FOREIGN KEY (test_id) REFERENCES tests (id)
    )
  `);
});

// ---------------------------------------------------------
// 2. مسارات العرض للوحة البيانات والمقارنة البيانية
// ---------------------------------------------------------

// مسار جلب جدول الدرجات الكلية وكشف الطالبات
app.get('/api/data', (req, res) => {
  db.all('SELECT * FROM tests ORDER BY id ASC', [], (err, tests) => {
    if (err) return res.status(500).json({ error: err.message });

    db.all('SELECT * FROM students ORDER BY name ASC', [], (err, students) => {
      if (err) return res.status(500).json({ error: err.message });

      db.all('SELECT * FROM scores', [], (err, scores) => {
        if (err) return res.status(500).json({ error: err.message });

        // تجهيز الخريطة البرمجية للدرجات
        const leaderboard = students.map(student => {
          let total = 0;
          const scoresMap = {};

          scores.filter(s => s.student_id === student.id).forEach(s => {
            scoresMap[s.test_id] = s.score;
            total += s.score;
          });

          return {
            id: student.id,
            name: student.name,
            class_name: student.class_name,
            scoresMap: scoresMap,
            total: total
          };
        });

        // ترتيب الطالبات حسب المجموع الكلي تنازلياً
        leaderboard.sort((a, b) => b.total - a.total);

        res.json({
          tests: tests,
          leaderboard: leaderboard
        });
      });
    });
  });
});

// مسار التحليل البياني ومقارنة وترتيب الفصول (يعمل مع Chart.js في الصفحة الرئيسية)
app.get('/api/analytics/classes', (req, res) => {
  const query = `
    SELECT 
      st.class_name, 
      COUNT(DISTINCT st.id) as student_count,
      COALESCE(AVG(sc.score), 0) as average_score
    FROM students st
    LEFT JOIN scores sc ON st.id = sc.student_id
    GROUP BY st.class_name
    ORDER BY average_score DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      console.error('خطأ في جلب تحليلات الفصول:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json({ classComparison: rows || [] });
  });
});

// ---------------------------------------------------------
// 3. مسارات إدخال البيانات ورصد الدرجات
// ---------------------------------------------------------

// إضافة طالبة جديدة
app.post('/api/students', (req, res) => {
  const { name, class_name } = req.body;
  if (!name || !class_name) {
    return res.status(400).json({ error: 'يرجى تقديم اسم الطالبة والفصل' });
  }

  const query = `INSERT INTO students (name, class_name) VALUES (?, ?)`;
  db.run(query, [name, class_name], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, name, class_name });
  });
});

// إضافة اختبار جديد
app.post('/api/tests', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم الاختبار مطلوب' });

  const query = `INSERT INTO tests (name) VALUES (?)`;
  db.run(query, [name], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, name });
  });
});

// رصد/تسجيل درجة طالبة في اختبار (الدرجة الأصلية)
app.post('/api/scores', (req, res) => {
  const { student_id, test_id, score } = req.body;
  if (student_id === undefined || test_id === undefined || score === undefined) {
    return res.status(400).json({ error: 'البيانات غير مكتملة' });
  }

  const query = `
    INSERT INTO scores (student_id, test_id, score)
    VALUES (?, ?, ?)
    ON CONFLICT(student_id, test_id) DO UPDATE SET score = excluded.score
  `;

  db.run(query, [student_id, test_id, score], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'تم رصد الدرجة بنجاح' });
  });
});

// ---------------------------------------------------------
// 4. مسار الخطة العلاجية (تسجيل الإتقان)
// ---------------------------------------------------------

// تسجيل إتقان الخطة العلاجية (دون المساس بالدرجة الأصلية)
app.post('/api/remediation/complete', (req, res) => {
  const { student_id, test_id } = req.body;
  
  if (!student_id || !test_id) {
    return res.status(400).json({ error: 'معرف الطالبة والاختبار مطلوبين' });
  }

  const query = `
    INSERT INTO remediation_logs (student_id, test_id)
    VALUES (?, ?)
  `;

  db.run(query, [student_id, test_id], function(err) {
    if (err) {
      console.error('خطأ في تسجيل الخطة العلاجية:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json({ 
      success: true, 
      message: 'تم إكمال الخطة العلاجية وإتقان المهارات بنجاح دون تعديل الدرجة الأصلية' 
    });
  });
});

// ---------------------------------------------------------
// 5. تشغيل الخادم
// ---------------------------------------------------------
app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`🚀 الخادم يعمل بنجاح على المنفذ: ${PORT}`);
  console.log(`http://localhost:${PORT}`);
  console.log(`=================================`);
});
