const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

const rawDbPassword = process.env.DB_PASSWORD ?? '';
// Treat common placeholder values as an empty local MySQL password.
// If your MySQL root account has a password, put the real password in .env.
const dbPassword = /^(YES|NO|your_mysql_password|change_me|password)$/i.test(rawDbPassword.trim()) ? '' : rawDbPassword;
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: dbPassword,
    database: process.env.DB_NAME || 'lms_db',
    waitForConnections: true,
    connectionLimit: 15
});

const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, 'avatar-' + Date.now() + path.extname(file.originalname).toLowerCase())
});

const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /jpeg|jpg|png|webp/;
        if (allowed.test(file.mimetype) && allowed.test(path.extname(file.originalname).toLowerCase())) {
            return cb(null, true);
        }
        cb(new Error('Strict: Only JPG/PNG images under 2MB are allowed!'));
    }
});

const pendingStudents = {};

// Production-safe schema self-healing for existing installations.
async function ensureProductionSchema() {
    const statements = [
        `CREATE TABLE IF NOT EXISTS admin_profiles (id INT AUTO_INCREMENT PRIMARY KEY, admin_id VARCHAR(50) UNIQUE NOT NULL, name VARCHAR(100) NOT NULL, password VARCHAR(255) NOT NULL, plain_password VARCHAR(100) NULL, face_image VARCHAR(255) DEFAULT 'default.png', face_descriptor LONGTEXT NULL, is_biometric_active TINYINT(1) DEFAULT 1, last_login DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS lms_activities (id INT AUTO_INCREMENT PRIMARY KEY, actor_type VARCHAR(30), actor_name VARCHAR(100), action_type VARCHAR(60), details TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS library_attendance (id INT AUTO_INCREMENT PRIMARY KEY, student_id VARCHAR(50) NOT NULL, entry_time DATETIME NOT NULL, exit_time DATETIME NULL, duration_minutes INT DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS grievance_chat (id INT AUTO_INCREMENT PRIMARY KEY, student_id VARCHAR(50) NOT NULL, sender_role VARCHAR(30), sender_name VARCHAR(100), message TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS membership_offers (id INT AUTO_INCREMENT PRIMARY KEY, offer_name VARCHAR(150) NOT NULL, duration_type VARCHAR(50), days INT NOT NULL, price DECIMAL(10,2) NOT NULL, festival_tag VARCHAR(100), expire_at DATETIME NULL, is_active TINYINT(1) DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS fee_payments (id INT AUTO_INCREMENT PRIMARY KEY, student_id VARCHAR(50) NOT NULL, fee_type VARCHAR(150) NOT NULL, amount DECIMAL(10,2) NOT NULL, utr_number VARCHAR(100) UNIQUE NOT NULL, payment_status VARCHAR(30) DEFAULT 'VERIFIED', transaction_id INT NULL, book_id VARCHAR(50) NULL, days_late INT DEFAULT 0, payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, details_json LONGTEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS student_fines (id INT AUTO_INCREMENT PRIMARY KEY, student_id VARCHAR(50) NOT NULL, fine_type VARCHAR(150) NOT NULL, amount DECIMAL(10,2) NOT NULL, reason VARCHAR(255) NOT NULL, book_id VARCHAR(50) NULL, transaction_id INT NULL, status VARCHAR(20) DEFAULT 'UNPAID', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, paid_at DATETIME NULL, payment_id INT NULL)`,
        `ALTER TABLE students ADD COLUMN face_image VARCHAR(255) DEFAULT 'default.png'`,
        `ALTER TABLE students ADD COLUMN face_descriptor LONGTEXT NULL`,
        `ALTER TABLE students ADD COLUMN is_face_allowed TINYINT(1) DEFAULT 1`,
        `ALTER TABLE book_transactions ADD COLUMN borrow_days INT DEFAULT 7`,
        `ALTER TABLE book_transactions ADD COLUMN expected_return DATETIME NULL`,
        `ALTER TABLE book_transactions MODIFY is_fine_paid TINYINT(1) DEFAULT 0`,
        `ALTER TABLE notices ADD COLUMN recipient_student_id VARCHAR(50) NULL`,
        `ALTER TABLE notices ADD COLUMN notice_type VARCHAR(50) DEFAULT 'GENERAL'`,
        `ALTER TABLE fee_payments ADD COLUMN transaction_id INT NULL`,
        `ALTER TABLE fee_payments ADD COLUMN book_id VARCHAR(50) NULL`,
        `ALTER TABLE fee_payments ADD COLUMN days_late INT DEFAULT 0`,
        `ALTER TABLE fee_payments ADD COLUMN details_json LONGTEXT NULL`,
        `ALTER TABLE admin_profiles ADD COLUMN face_descriptor LONGTEXT NULL`
    ];
    for (const sql of statements) {
        try { await db.query(sql); } catch (e) {
            if (!/Duplicate column name|Duplicate key name|already exists/i.test(e.message)) console.warn('Schema migration:', e.message);
        }
    }
}


async function logActivity(actorType, actorName, actionType, details) {
    try {
        await db.query(
            'INSERT INTO lms_activities (actor_type, actor_name, action_type, details) VALUES (?, ?, ?, ?)',
            [actorType, actorName, actionType, details]
        );
    } catch (e) {
        console.error('Activity log error:', e.message);
    }
}

function parseDescriptor(value) {
    try {
        const d = typeof value === 'string' ? JSON.parse(value) : value;
        if (!Array.isArray(d) || d.length < 64) return null;
        return d.map(Number).filter(Number.isFinite);
    } catch (_) { return null; }
}

function faceDistance(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return Math.sqrt(sum);
}

function normalizeDescriptor(value) {
    const d = parseDescriptor(value);
    if (!d) return null;
    const norm = Math.sqrt(d.reduce((s, x) => s + x*x, 0)) || 1;
    return d.map(x => x / norm);
}

const FACE_MATCH_THRESHOLD = 0.48;
const FACE_MATCH_MARGIN = 0.055;

function fineForTransaction(tx) {
    if (!tx || tx.is_fine_paid) return { amount: 0, daysLate: 0, type: null };
    if (tx.status === 'ISSUED' && tx.expected_return) {
        const diff = new Date() - new Date(tx.expected_return);
        if (diff > 0) {
            const days = Math.ceil(diff / 86400000);
            return { amount: days * 3, daysLate: days, type: 'Late Return Book Fine' };
        }
    }
    const amount = Number(tx.fine_amount || 0);
    return { amount, daysLate: 0, type: amount > 0 ? 'Book Physical Damage Fine' : null };
}

// -------------------------------------------------------------
// 1. AUTHENTICATION & MULTI-ADMIN
// -------------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
    try {
        const { role, username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Please enter both Username/ID and Password.' });
        }

        if (role === 'admin') {
            const [admins] = await db.query('SELECT * FROM admin_profiles WHERE admin_id = ?', [username]);
            if (admins.length === 0) {
                if (username === 'admin' && password === 'admin123') {
                    await logActivity('ADMIN', 'Master Administrator', 'LOGIN', 'Default Admin logged in');
                    return res.json({ role: 'admin', name: 'Master Administrator', redirect: '/admin.html' });
                }
                return res.status(401).json({ error: 'Invalid Admin Credentials!' });
            }
            const admin = admins[0];
            const match = await bcrypt.compare(password, admin.password);
            if (!match && admin.plain_password !== password) {
                return res.status(401).json({ error: 'Invalid Admin Password!' });
            }
            await db.query('UPDATE admin_profiles SET last_login = NOW() WHERE id = ?', [admin.id]);
            await logActivity('ADMIN', admin.name, 'LOGIN', `Admin ${admin.admin_id} authenticated`);
            return res.json({ role: 'admin', name: admin.name, redirect: '/admin.html' });
        }

        const [rows] = await db.query('SELECT * FROM students WHERE student_id = ?', [username]);
        if (rows.length === 0) return res.status(404).json({ error: 'Student ID does not exist!' });

        const student = rows[0];
        const match = await bcrypt.compare(password, student.password);
        if (!match && student.plain_password !== password) {
            return res.status(401).json({ error: 'Incorrect Password!' });
        }

        await logActivity('STUDENT', student.name, 'LOGIN', `Student ${student.student_id} logged in`);

        res.json({
            role: 'student',
            student_id: student.student_id,
            name: student.name,
            email: student.email,
            mobile: student.mobile,
            address: student.address,
            plain_password: student.plain_password,
            membership_months: student.membership_months,
            membership_expiry: student.membership_expiry,
            profile_pic: student.profile_pic,
            redirect: '/student.html'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/pure-face-scan', async (req, res) => {
    try {
        const { role, live_face, live_descriptor, liveness_token } = req.body;
        if (!live_face || !live_face.startsWith('data:image') || !live_descriptor) {
            return res.status(400).json({ error: 'Biometric data incomplete. Keep your face clearly visible and try again.' });
        }
        const live = normalizeDescriptor(live_descriptor);
        if (!live) return res.status(400).json({ error: 'Invalid face biometric descriptor.' });
        if (!liveness_token || liveness_token !== 'LMS-LIVE-FACE-V2') {
            return res.status(400).json({ error: 'Live-camera verification failed. Please scan your live face again.' });
        }

        let people = [];
        if (role === 'admin') {
            const [admins] = await db.query('SELECT * FROM admin_profiles WHERE is_biometric_active = 1 AND face_descriptor IS NOT NULL AND face_descriptor <> ""');
            people = admins.map(x => ({...x, kind:'admin'}));
        } else {
            const [students] = await db.query('SELECT * FROM students WHERE is_face_allowed = 1 AND face_descriptor IS NOT NULL AND face_descriptor <> ""');
            people = students.map(x => ({...x, kind:'student'}));
        }
        if (!people.length) return res.status(404).json({ error: 'No enrolled biometric profile found. Please enroll/re-enroll the face first.' });

        const matches = people.map(p => ({ person:p, distance:faceDistance(live, normalizeDescriptor(p.face_descriptor)) }))
            .filter(x => Number.isFinite(x.distance)).sort((a,b)=>a.distance-b.distance);
        const best = matches[0];
        const second = matches[1];
        if (!best || best.distance > FACE_MATCH_THRESHOLD || (second && (second.distance - best.distance) < FACE_MATCH_MARGIN)) {
            return res.status(401).json({ error: 'Biometric Mismatch! This face is not uniquely matched to a registered account.' });
        }

        const p = best.person;
        if (p.kind === 'admin') {
            await db.query('UPDATE admin_profiles SET last_login = NOW() WHERE id = ?', [p.id]);
            await logActivity('ADMIN', p.name, 'BIOMETRIC_LOGIN', `Admin ${p.admin_id} verified by strict face descriptor`);
            return res.json({ role:'admin', name:p.name, admin_id:p.admin_id, redirect:'/admin.html' });
        }
        await logActivity('STUDENT', p.name, 'BIOMETRIC_LOGIN', `Student ${p.student_id} verified by strict face descriptor`);
        return res.json({ role:'student', student_id:p.student_id, name:p.name, email:p.email, mobile:p.mobile, address:p.address, membership_months:p.membership_months, membership_expiry:p.membership_expiry, profile_pic:p.profile_pic, redirect:'/student.html' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// -------------------------------------------------------------
// 2. ADMIN REGISTRY & EDIT
// -------------------------------------------------------------
app.get('/api/admin/profiles', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, admin_id, name, face_image, face_descriptor, is_biometric_active, last_login, created_at FROM admin_profiles ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/profiles', async (req, res) => {
    try {
        const { admin_id, name, password, face_image, face_descriptor } = req.body;
        if (!admin_id || !name || !password || !face_image) {
            return res.status(400).json({ error: 'All fields are required!' });
        }

        let faceFile = 'default.png';
        if (face_image.startsWith('data:image')) {
            const base64Data = face_image.replace(/^data:image\/\w+;base64,/, '');
            const filename = `admin-face-${Date.now()}-${admin_id}.png`;
            fs.writeFileSync(path.join(uploadDir, filename), base64Data, 'base64');
            faceFile = filename;
        }

        const hashed = await bcrypt.hash(password, 10);
        await db.query(`
            INSERT INTO admin_profiles (admin_id, name, password, plain_password, face_image, face_descriptor, is_biometric_active)
            VALUES (?, ?, ?, ?, ?, ?, 1)
        `, [admin_id, name, hashed, password, faceFile, JSON.stringify(face_descriptor || [])]);

        await logActivity('ADMIN', name, 'REGISTER_ADMIN', `Enrolled Admin: ${name} (${admin_id})`);
        res.json({ success: true, message: `Admin ${name} registered successfully!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/profiles/:id', async (req, res) => {
    try {
        const { admin_id, name, password } = req.body;
        const [existing] = await db.query('SELECT * FROM admin_profiles WHERE id = ?', [req.params.id]);
        if (existing.length === 0) return res.status(404).json({ error: 'Admin profile not found' });

        let hashed = existing[0].password;
        let plain = existing[0].plain_password;
        if (password && password.trim() !== '') {
            plain = password.trim();
            hashed = await bcrypt.hash(plain, 10);
        }

        await db.query(
            'UPDATE admin_profiles SET admin_id = ?, name = ?, password = ?, plain_password = ? WHERE id = ?',
            [admin_id, name, hashed, plain, req.params.id]
        );
        await logActivity('ADMIN', 'Master Administrator', 'UPDATE_ADMIN', `Updated Admin details for ${name}`);
        res.json({ success: true, message: 'Admin details updated successfully!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/profiles/:id', async (req, res) => {
    try {
        const [adm] = await db.query('SELECT name, admin_id FROM admin_profiles WHERE id = ?', [req.params.id]);
        await db.query('DELETE FROM admin_profiles WHERE id = ?', [req.params.id]);
        if (adm[0]) {
            await logActivity('ADMIN', 'Master Administrator', 'DELETE_ADMIN', `Deleted Admin ${adm[0].name}`);
        }
        res.json({ success: true, message: 'Admin profile deleted!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/profiles/toggle/:id', async (req, res) => {
    try {
        const { allow } = req.body;
        await db.query('UPDATE admin_profiles SET is_biometric_active = ? WHERE id = ?', [allow ? 1 : 0, req.params.id]);
        res.json({ success: true, message: `Biometric access set to ${allow ? 'ALLOWED' : 'BLOCKED'}!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------------------------------------------
// 3. BOOK RETURN & FIXED DAMAGE LOGIC (NO AUTOMATIC DAMAGE FINE)
// -------------------------------------------------------------
app.post('/api/books/return', async (req, res) => {
    try {
        const { transaction_id, book_id } = req.body;
        const [tx] = await db.query('SELECT * FROM book_transactions WHERE id = ?', [transaction_id]);
        if (tx.length === 0) return res.status(404).json({ error: 'Transaction not found' });

        const transaction = tx[0];
        let fine = 0;
        let lateDays = 0;
        
        // Late Return Fine: ₹3 per day
        if (transaction.expected_return) {
            const diffTime = new Date() - new Date(transaction.expected_return);
            if (diffTime > 0) {
                lateDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                fine = lateDays * 3;
            }
        }

        // Damage fine is 0 by default on student return
        await db.query(`
            UPDATE book_transactions 
            SET status = "RETURNED", return_date = NOW(), fine_amount = ?, is_fine_paid = ? 
            WHERE id = ?
        `, [fine, fine > 0 ? 0 : 1, transaction_id]);

        await db.query('UPDATE books SET available_copies = available_copies + 1 WHERE book_id = ?', [book_id]);

        if (fine > 0) {
            const [b] = await db.query('SELECT title FROM books WHERE book_id = ?', [book_id]);
            const bTitle = b[0] ? b[0].title : book_id;
            const detailedNotice = `Fine Breakdown for Book "${bTitle}" (${book_id}):\n• Overdue Delay: ${lateDays} days × ₹3/day = ₹${fine}\n• Physical Damage Fine: ₹0\n• Total Amount Due: ₹${fine}. Please pay in Fees section.`;
            await db.query('INSERT INTO notices (title, message, recipient_student_id, notice_type) VALUES (?, ?, ?, ?)', [`FINE NOTICE for ${transaction.student_id}`, detailedNotice, transaction.student_id, 'FEE']);
        }

        await logActivity('STUDENT', transaction.student_id, 'RETURN_BOOK', `Returned book ${book_id}. Overdue Fine: ₹${fine}`);

        // FIFO Auto-Dispatch
        const [waiting] = await db.query('SELECT * FROM book_transactions WHERE book_id = ? AND status = "WAITING" ORDER BY id ASC LIMIT 1', [book_id]);
        if (waiting.length > 0) {
            const wDays = waiting[0].borrow_days || 7;
            await db.query(`
                UPDATE book_transactions 
                SET status = "ISSUED", issue_date = NOW(), expected_return = DATE_ADD(NOW(), INTERVAL ? DAY) 
                WHERE id = ?
            `, [wDays, waiting[0].id]);
            await db.query('UPDATE books SET available_copies = available_copies - 1 WHERE book_id = ?', [book_id]);
            await logActivity('SYSTEM', 'FIFO Engine', 'FIFO_DISPATCH', `Assigned returned book ${book_id} to waiting student ${waiting[0].student_id}`);
        }

        res.json({ success: true, message: `Book returned successfully! Total late fine: ₹${fine}`, fine });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin Inspection: Apply a damage fine to a book transaction.
// The fine is also mirrored into the student's targeted notice + payment QR feed.
app.post('/api/admin/apply-damage-fine', async (req, res) => {
    try {
        const { transaction_id, damage_amount, reason } = req.body;
        const fine = Number(damage_amount);
        if (!transaction_id || !Number.isFinite(fine) || fine <= 0) return res.status(400).json({ error: 'Valid transaction and fine amount are required.' });
        const [rows] = await db.query(`SELECT bt.*, b.title AS book_title FROM book_transactions bt LEFT JOIN books b ON bt.book_id=b.book_id WHERE bt.id=?`, [transaction_id]);
        if (!rows.length) return res.status(404).json({ error: 'Book transaction not found.' });
        const tx = rows[0];
        const fineReason = String(reason || 'Book damaged / physical damage').trim();
        const [ins] = await db.query(`INSERT INTO student_fines (student_id,fine_type,amount,reason,book_id,transaction_id) VALUES (?,?,?,?,?,?)`, [tx.student_id, 'Book Physical Damage Fine', fine, fineReason, tx.book_id, transaction_id]);
        const noticeTitle = `FINE NOTICE • ${tx.student_id} • ₹${fine}`;
        const noticeMsg = `Admin applied a book damage fine.\nStudent: ${tx.student_id}\nBook: ${tx.book_title || tx.book_id} (${tx.book_id})\nReason: ${fineReason}\nFine Added: ₹${fine}\n\nOpen Pay Fees to scan the student-specific UPI QR and submit the UTR.`;
        await db.query('INSERT INTO notices (title,message,recipient_student_id,notice_type) VALUES (?,?,?,?)', [noticeTitle, noticeMsg, tx.student_id, 'FEE']);
        await logActivity('ADMIN', 'Master Administrator', 'ADD_FINE', `Added ₹${fine} damage fine to ${tx.student_id} for ${tx.book_id}. ${fineReason}`);
        res.json({ success: true, fine_id: ins.insertId, transaction_id, message: `Damage fine of ₹${fine} applied to ${tx.student_id}. Notice and payment QR updated.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin can add any manual student fine, even when there is no book transaction.
app.post('/api/admin/add-student-fine', async (req, res) => {
    try {
        const { student_id, fine_type, amount, reason, book_id } = req.body;
        const fine = Number(amount);
        if (!student_id || !Number.isFinite(fine) || fine <= 0 || !reason) return res.status(400).json({ error: 'Student, valid amount and reason are required.' });
        const [students] = await db.query('SELECT student_id, name FROM students WHERE student_id=?', [student_id]);
        if (!students.length) return res.status(404).json({ error: 'Student not found.' });
        const type = String(fine_type || 'Library Fine').trim();
        const cleanReason = String(reason).trim();
        const [ins] = await db.query(`INSERT INTO student_fines (student_id,fine_type,amount,reason,book_id) VALUES (?,?,?,?,?)`, [student_id, type, fine, cleanReason, book_id || null]);
        const noticeTitle = `FINE NOTICE • ${student_id} • ₹${fine}`;
        const noticeMsg = `New library fine added by Admin.\nFine Type: ${type}\nReason: ${cleanReason}${book_id ? `\nBook ID: ${book_id}` : ''}\nAmount Due: ₹${fine}\n\nThis fine is now visible only to ${student_id} in Fees & Fine Notices and Pay Fees. The QR amount is linked to this exact fine.`;
        await db.query('INSERT INTO notices (title,message,recipient_student_id,notice_type) VALUES (?,?,?,?)', [noticeTitle, noticeMsg, student_id, 'FEE']);
        await logActivity('ADMIN', 'Master Administrator', 'ADD_FINE', `Added ${type} ₹${fine} to ${student_id}. ${cleanReason}`);
        res.json({ success: true, fine_id: ins.insertId, message: `₹${fine} ${type} added to ${students[0].name} (${student_id}). Targeted notice + QR created.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// -------------------------------------------------------------
// 4. "CLEAR ALL" BULK DELETION ENDPOINTS
// -------------------------------------------------------------
// Clear All Grievance Chat
app.delete('/api/chat/messages/all', async (req, res) => {
    try {
        const student_id = req.query.student_id;
        if (student_id) {
            await db.query('DELETE FROM grievance_chat WHERE student_id = ?', [student_id]);
        } else {
            await db.query('DELETE FROM grievance_chat');
        }
        await logActivity('ADMIN', 'Master Administrator', 'CLEAR_CHAT', 'Cleared entire grievance desk conversation history');
        res.json({ success: true, message: 'All chat messages cleared!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Clear All LMS Activity Logs
app.delete('/api/admin/activities/all', async (req, res) => {
    try {
        await db.query('DELETE FROM lms_activities');
        res.json({ success: true, message: 'All LMS activity logs wiped successfully!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Clear All Notices
app.delete('/api/notices/all', async (req, res) => {
    try {
        await db.query('DELETE FROM notices');
        await logActivity('ADMIN', 'Master Administrator', 'CLEAR_NOTICES', 'Cleared all notice board broadcasts');
        res.json({ success: true, message: 'All broadcast notices deleted!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Clear All Attendance for Student
app.delete('/api/attendance/history/all/:student_id', async (req, res) => {
    try {
        await db.query('DELETE FROM library_attendance WHERE student_id = ?', [req.params.student_id]);
        res.json({ success: true, message: 'Your attendance history has been cleared!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Clear All Student Activity Records
app.delete('/api/student/my-activities/all/:student_id', async (req, res) => {
    try {
        await db.query('DELETE FROM book_transactions WHERE student_id = ? AND status = "RETURNED"', [req.params.student_id]);
        res.json({ success: true, message: 'All completed personal activity records cleared!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------------------------------------------
// 5. GRIEVANCE CHAT, ATTENDANCE, BOOKS, FEES & OFFERS
// -------------------------------------------------------------
app.get('/api/chat/messages', async (req, res) => {
    try {
        const student_id = req.query.student_id;
        let query = 'SELECT * FROM grievance_chat ORDER BY id ASC';
        let params = [];
        if (student_id) {
            query = 'SELECT * FROM grievance_chat WHERE student_id = ? ORDER BY id ASC';
            params = [student_id];
        }
        const [rows] = await db.query(query, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat/send', async (req, res) => {
    try {
        const { student_id, sender_role, sender_name, message } = req.body;
        if (!student_id || !message) return res.status(400).json({ error: 'Message cannot be empty!' });

        await db.query(`
            INSERT INTO grievance_chat (student_id, sender_role, sender_name, message) 
            VALUES (?, ?, ?, ?)
        `, [student_id, sender_role || 'STUDENT', sender_name || student_id, message]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/chat/messages/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM grievance_chat WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Message deleted!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/attendance/punch', async (req, res) => {
    try {
        const { student_id } = req.body;
        const [active] = await db.query(
            'SELECT * FROM library_attendance WHERE student_id = ? AND exit_time IS NULL ORDER BY id DESC LIMIT 1',
            [student_id]
        );

        if (active.length > 0) {
            const entryTime = new Date(active[0].entry_time);
            const exitTime = new Date();
            const durationMinutes = Math.max(1, Math.round((exitTime - entryTime) / (1000 * 60)));

            await db.query('UPDATE library_attendance SET exit_time = NOW(), duration_minutes = ? WHERE id = ?', [durationMinutes, active[0].id]);
            const hours = Math.floor(durationMinutes / 60);
            const mins = durationMinutes % 60;
            await logActivity('STUDENT', student_id, 'ATTENDANCE_EXIT', `Exited library. Duration: ${hours}h ${mins}m`);
            return res.json({ action: 'EXIT', event: 'EXIT', message: `Exit Recorded! Duration: ${hours}h ${mins}m.` });
        } else {
            await db.query('INSERT INTO library_attendance (student_id, entry_time) VALUES (?, NOW())', [student_id]);
            await logActivity('STUDENT', student_id, 'ATTENDANCE_ENTRY', `Checked into library`);
            return res.json({ action: 'ENTRY', event: 'ENTRY', message: 'Entry Recorded! Welcome to the Library.' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/attendance/history/:student_id', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM library_attendance WHERE student_id = ? ORDER BY id DESC LIMIT 50', [req.params.student_id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/attendance/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM library_attendance WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Attendance log deleted!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/books', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM books ORDER BY id DESC');
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/add-book', async (req, res) => {
    try {
        const { book_id, title, author, category, total_copies } = req.body;
        let cover_url = 'https://images.unsplash.com/photo-1543002588-bfa74002ed7e?w=300';
        try {
            const apiRes = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=1`);
            const data = await apiRes.json();
            if (data.docs && data.docs[0] && data.docs[0].cover_i) {
                cover_url = `https://covers.openlibrary.org/b/id/${data.docs[0].cover_i}-M.jpg`;
            }
        } catch (e) {}

        const copies = parseInt(total_copies) || 1;
        await db.query(
            'INSERT INTO books (book_id, title, author, category, cover_image, total_copies, available_copies) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [book_id, title, author, category || 'Programming & Systems', cover_url, copies, copies]
        );
        await logActivity('ADMIN', 'Master Administrator', 'ADD_BOOK', `Added "${title}" (${book_id})`);
        res.json({ success: true, message: 'Book Added Successfully' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/books/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM books WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/books/issue', async (req, res) => {
    try {
        const { student_id, book_id, borrow_days } = req.body;
        const days = parseInt(borrow_days) || 7;
        const [book] = await db.query('SELECT * FROM books WHERE book_id = ?', [book_id]);
        if (book.length === 0) return res.status(404).json({ error: 'Book not found!' });

        if (book[0].available_copies > 0) {
            await db.query('UPDATE books SET available_copies = available_copies - 1 WHERE book_id = ?', [book_id]);
            await db.query(`
                INSERT INTO book_transactions (student_id, book_id, status, issue_date, borrow_days, expected_return) 
                VALUES (?, ?, "ISSUED", NOW(), ?, DATE_ADD(NOW(), INTERVAL ? DAY))
            `, [student_id, book_id, days, days]);
            await logActivity('STUDENT', student_id, 'ISSUE_BOOK', `Issued "${book[0].title}" for ${days} days`);
            return res.json({ success: true, message: `Book issued for ${days} days!` });
        } else {
            await db.query('INSERT INTO book_transactions (student_id, book_id, status, borrow_days) VALUES (?, ?, "WAITING", ?)', [student_id, book_id, days]);
            return res.json({ success: true, message: '0 Copies available! Enqueued in FIFO Queue.' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/student/my-books/:student_id', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT bt.*, b.title, b.author, b.cover_image, b.category
            FROM book_transactions bt
            LEFT JOIN books b ON bt.book_id = b.book_id
            WHERE bt.student_id = ? ORDER BY bt.id DESC
        `, [req.params.student_id]);

        const mapped = rows.map(tx => {
            let fine = 0;
            if (tx.status === 'ISSUED' && tx.expected_return && !tx.is_fine_paid) {
                const diffTime = new Date() - new Date(tx.expected_return);
                if (diffTime > 0) fine = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) * 3;
            } else if (!tx.is_fine_paid) {
                fine = parseFloat(tx.fine_amount) || 0;
            }
            return { ...tx, calculated_fine: fine };
        });
        res.json(mapped);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/student/my-activities/:student_id', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT bt.*, b.title AS book_title 
            FROM book_transactions bt
            LEFT JOIN books b ON bt.book_id = b.book_id
            WHERE bt.student_id = ?
            ORDER BY bt.id DESC
        `, [req.params.student_id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/transactions/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM book_transactions WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Record deleted!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/fifo-lifo', async (req, res) => {
    try {
        const [fifoRows] = await db.query(`
            SELECT bt.id, bt.student_id, bt.book_id, bt.created_at, s.name AS student_name, b.title AS book_title, b.available_copies
            FROM book_transactions bt
            LEFT JOIN students s ON bt.student_id = s.student_id
            LEFT JOIN books b ON bt.book_id = b.book_id
            WHERE bt.status = 'WAITING'
            ORDER BY bt.id ASC
        `);

        const [lifoRows] = await db.query(`
            SELECT bt.id, bt.student_id, bt.book_id, bt.fine_amount, bt.status, bt.expected_return, bt.created_at,
                   s.name AS student_name, b.title AS book_title
            FROM book_transactions bt
            LEFT JOIN students s ON bt.student_id = s.student_id
            LEFT JOIN books b ON bt.book_id = b.book_id
            WHERE bt.is_fine_paid = 0 AND (bt.status = 'DAMAGE_FINE' OR bt.expected_return < NOW())
            ORDER BY bt.id DESC
        `);

        res.json({ fifo: fifoRows, lifo: lifoRows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/fifo/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM book_transactions WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Queue item removed!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/activities', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM lms_activities ORDER BY id DESC LIMIT 100');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/activities/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM lms_activities WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Activity deleted!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/fine-targets', async (req,res)=>{
    try{
        const [students]=await db.query('SELECT student_id,name FROM students ORDER BY name');
        const [transactions]=await db.query(`SELECT bt.id,bt.student_id,bt.book_id,bt.status,bt.issue_date,bt.expected_return,b.title AS book_title FROM book_transactions bt LEFT JOIN books b ON bt.book_id=b.book_id WHERE bt.status IN ('ISSUED','RETURNED','DAMAGE_FINE') ORDER BY bt.id DESC`);
        res.json({students,transactions});
    }catch(err){res.status(500).json({error:err.message});}
});

app.get('/api/admin/fees-overview', async (req, res) => {
    try {
        const [students] = await db.query('SELECT student_id, name, mobile, email FROM students ORDER BY name');
        const [transactions] = await db.query('SELECT bt.*, b.title AS book_title FROM book_transactions bt LEFT JOIN books b ON bt.book_id=b.book_id');
        const [manualFines] = await db.query('SELECT * FROM student_fines WHERE status="UNPAID" ORDER BY id DESC');
        const [payments] = await db.query('SELECT * FROM fee_payments WHERE payment_status="VERIFIED" ORDER BY id DESC');
        const feeData = students.map(s => {
            const txItems = transactions.filter(t => t.student_id === s.student_id).map(t => ({...t, fine: fineForTransaction(t)})).filter(t => t.fine.amount > 0).map(t => ({transaction_id:t.id, book_id:t.book_id, book_title:t.book_title, amount:t.fine.amount, days_late:t.fine.daysLate, type:t.fine.type, source:'BOOK_TRANSACTION'}));
            const manualItems = manualFines.filter(f => f.student_id === s.student_id).map(f => ({fine_id:f.id, transaction_id:f.transaction_id, book_id:f.book_id, book_title:null, amount:Number(f.amount), days_late:0, type:f.fine_type, reason:f.reason, source:'MANUAL_FINE'}));
            const unpaidItems = [...txItems, ...manualItems];
            const totalUnpaid = unpaidItems.reduce((n,t)=>n+Number(t.amount||0),0);
            const stuPayments = payments.filter(p => p.student_id === s.student_id);
            return {...s, total_unpaid: totalUnpaid, total_paid: stuPayments.reduce((n,p)=>n+Number(p.amount||0),0), recent_utr: stuPayments[0]?.utr_number || 'None', unpaid_items: unpaidItems};
        });
        res.json({ feeData, recentPayments: payments.slice(0,20) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/send-all-pending-fee-notices', async (req,res)=>{
    try {
        const [students] = await db.query('SELECT student_id, name FROM students');
        const [txs] = await db.query('SELECT bt.*, b.title AS book_title FROM book_transactions bt LEFT JOIN books b ON bt.book_id=b.book_id');
        let sent=0;
        for (const s of students) {
            const items=txs.filter(t=>t.student_id===s.student_id).map(t=>({...t,f:fineForTransaction(t)})).filter(t=>t.f.amount>0);
            if (!items.length) continue;
            const total=items.reduce((n,t)=>n+t.f.amount,0);
            const breakdown=items.map((t,i)=>`${i+1}. ${t.book_title||t.book_id} | ${t.f.type}${t.f.daysLate?` | ${t.f.daysLate} days late`:''} | ₹${t.f.amount}`).join('\n');
            await db.query('INSERT INTO notices (title,message,recipient_student_id,notice_type) VALUES (?,?,?,?)',[`FEE ALERT for ${s.student_id}`,`Outstanding amount: ₹${total}\n${breakdown}\nPlease clear the pending amount in Pay Fees.`,s.student_id,'FEE']);
            sent++;
        }
        res.json({success:true,message:`Pending due notices sent to ${sent} student(s).`});
    } catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/admin/send-detailed-fee-notice', async (req, res) => {
    try {
        const { student_id } = req.body;
        const [txs] = await db.query(`SELECT bt.*, b.title AS book_title FROM book_transactions bt LEFT JOIN books b ON bt.book_id=b.book_id WHERE bt.student_id = ? AND bt.is_fine_paid = 0`, [student_id]);
        const [manualFines] = await db.query(`SELECT * FROM student_fines WHERE student_id=? AND status='UNPAID' ORDER BY id DESC`, [student_id]);
        let totalFine = 0, breakdown = [];
        txs.forEach(t => { const f=fineForTransaction(t); if(f.amount>0){ totalFine += f.amount; breakdown.push(`• ${t.book_title||t.book_id} — ${f.type}${f.daysLate?` (${f.daysLate} days late)`:''} = ₹${f.amount}`); } });
        manualFines.forEach(f => { totalFine += Number(f.amount); breakdown.push(`• ${f.fine_type} — ${f.reason} = ₹${f.amount}`); });
        if (!totalFine) return res.json({ success:true, message:`Student ${student_id} has ₹0 outstanding fines!` });
        const detailedMsg = `Official Outstanding Fine Breakdown (Total: ₹${totalFine}):\n${breakdown.join('\n')}\n\nPlease clear the selected fine through Pay Fees. The QR amount is linked to the outstanding item.`;
        await db.query('INSERT INTO notices (title,message,recipient_student_id,notice_type) VALUES (?,?,?,?)', [`FEE ALERT for ${student_id}`, detailedMsg, student_id, 'FEE']);
        res.json({ success:true, message:`Itemized fine notice delivered to ${student_id}!` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/membership/offers', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM membership_offers WHERE is_active = 1 ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/membership/offers', async (req, res) => {
    try {
        const { offer_name, duration_type, days, price, festival_tag, expire_at } = req.body;
        await db.query(
            'INSERT INTO membership_offers (offer_name, duration_type, days, price, festival_tag, expire_at) VALUES (?, ?, ?, ?, ?, ?)',
            [offer_name, duration_type, days, price, festival_tag || 'Special', expire_at || null]
        );
        res.json({ success: true, message: 'Festival Offer plan activated!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/membership/offers/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM membership_offers WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/notices', async (req, res) => {
    try {
        const studentId = req.query.student_id;
        const [rows] = studentId
            ? await db.query('SELECT * FROM notices WHERE recipient_student_id = ? OR recipient_student_id IS NULL ORDER BY id DESC', [studentId])
            : await db.query('SELECT * FROM notices ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/notices', async (req, res) => {
    try {
        const { title, message } = req.body;
        if (!title || !message) return res.status(400).json({ error: 'Title and message required!' });
        await db.query('INSERT INTO notices (title, message) VALUES (?, ?)', [title, message]);
        res.json({ success: true, message: 'Notice broadcasted successfully!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/notices/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM notices WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// STUDENTS
app.post('/api/admin/send-student-otp', async (req, res) => {
    try {
        const { student_id, name, email, mobile, address, password, membership_months, face_image, face_descriptor } = req.body;
        if (!student_id || !name || !email || !mobile || !password) {
            return res.status(400).json({ error: 'All fields are required!' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const months = parseInt(membership_months) || 6;
        pendingStudents[student_id] = { student_id, name, email, mobile, address, password, membership_months: months, face_image, face_descriptor, otp };

        res.json({ success: true, otp, message: 'OTP Generated successfully!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/verify-and-add-student', async (req, res) => {
    try {
        const { student_id, entered_otp } = req.body;
        const pending = pendingStudents[student_id];
        if (!pending || pending.otp !== entered_otp.trim()) {
            return res.status(400).json({ error: 'Invalid or Expired OTP!' });
        }

        let faceFile = 'default.png';
        if (pending.face_image && pending.face_image.startsWith('data:image')) {
            const base64Data = pending.face_image.replace(/^data:image\/\w+;base64,/, '');
            const filename = `face-${Date.now()}-${pending.student_id}.png`;
            fs.writeFileSync(path.join(uploadDir, filename), base64Data, 'base64');
            faceFile = filename;
        }

        const hashed = await bcrypt.hash(pending.password, 10);
        await db.query(`
            INSERT INTO students 
            (student_id, name, email, mobile, address, membership_months, membership_expiry, password, plain_password, profile_pic, face_image, face_descriptor, is_face_allowed, is_verified)
            VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MONTH), ?, ?, ?, ?, ?, 1, 1)
        `, [pending.student_id, pending.name, pending.email, pending.mobile, pending.address || '', pending.membership_months, pending.membership_months, hashed, pending.password, faceFile, faceFile, JSON.stringify(pending.face_descriptor || [])]);

        delete pendingStudents[student_id];
        res.json({ success: true, message: `Student (${pending.name}) registered!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/students', async (req, res) => {
    const [rows] = await db.query('SELECT * FROM students ORDER BY id DESC');
    res.json(rows);
});

app.put('/api/admin/students/:id', async (req, res) => {
    try {
        const { name, email, mobile, address, password } = req.body;
        const [existing] = await db.query('SELECT * FROM students WHERE id = ?', [req.params.id]);
        if (existing.length === 0) return res.status(404).json({ error: 'Student not found' });

        let hashed = existing[0].password;
        let plain = existing[0].plain_password;
        if (password && password.trim() !== '') {
            plain = password.trim();
            hashed = await bcrypt.hash(plain, 10);
        }

        await db.query(
            'UPDATE students SET name = ?, email = ?, mobile = ?, address = ?, password = ?, plain_password = ? WHERE id = ?',
            [name, email, mobile, address, hashed, plain, req.params.id]
        );
        res.json({ success: true, message: 'Student updated successfully!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/students/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM students WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/admin/students/:student_id/face-descriptor', async (req,res)=>{
    try{ const d=normalizeDescriptor(req.body.face_descriptor); if(!d) return res.status(400).json({error:'Invalid descriptor'}); await db.query('UPDATE students SET face_descriptor=? WHERE student_id=?',[JSON.stringify(d),req.params.student_id]); res.json({success:true}); }
    catch(err){res.status(500).json({error:err.message});}
});
app.put('/api/admin/profiles/:id/face-descriptor', async (req,res)=>{
    try{ const d=normalizeDescriptor(req.body.face_descriptor); if(!d) return res.status(400).json({error:'Invalid descriptor'}); await db.query('UPDATE admin_profiles SET face_descriptor=? WHERE id=?',[JSON.stringify(d),req.params.id]); res.json({success:true}); }
    catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/admin/toggle-biometric', async (req, res) => {
    try {
        const { student_id, allow } = req.body;
        await db.query('UPDATE students SET is_face_allowed = ? WHERE student_id = ?', [allow ? 1 : 0, student_id]);
        res.json({ success: true, message: `Biometric login ${allow ? 'ALLOWED' : 'BLOCKED'} for ${student_id}!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/student/profile/:student_id', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM students WHERE student_id = ?', [req.params.student_id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Student not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/student/upload-photo', (req, res) => {
    upload.single('profile_pic')(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'Please select an image file!' });

        try {
            await db.query('UPDATE students SET profile_pic = ? WHERE student_id = ?', [req.file.filename, req.body.student_id]);
            res.json({ success: true, filename: req.file.filename, message: 'Profile photo updated!' });
        } catch (dbErr) {
            res.status(500).json({ error: dbErr.message });
        }
    });
});

app.post('/api/student/change-password', async (req, res) => {
    try {
        const { student_id, current_password, new_password } = req.body;
        const [rows] = await db.query('SELECT * FROM students WHERE student_id = ?', [student_id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Student not found!' });

        const student = rows[0];
        const match = await bcrypt.compare(current_password, student.password);
        if (!match && student.plain_password !== current_password) {
            return res.status(400).json({ error: 'Current password does not match!' });
        }

        const hashed = await bcrypt.hash(new_password, 10);
        await db.query('UPDATE students SET password = ?, plain_password = ? WHERE student_id = ?', [hashed, new_password, student_id]);
        res.json({ success: true, message: 'Password updated successfully!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/student/outstanding-fees/:student_id', async (req,res)=>{
    try{
        const studentId=req.params.student_id;
        const [txs]=await db.query('SELECT bt.*, b.title AS book_title FROM book_transactions bt LEFT JOIN books b ON bt.book_id=b.book_id WHERE bt.student_id=?',[studentId]);
        const [manualFines]=await db.query(`SELECT * FROM student_fines WHERE student_id=? AND status='UNPAID' ORDER BY id DESC`,[studentId]);
        const items=txs.map(t=>{const f=fineForTransaction(t); return f.amount>0?{transaction_id:t.id,fine_id:null,book_id:t.book_id,book_title:t.book_title,fee_type:f.type,amount:f.amount,days_late:f.daysLate,expected_return:t.expected_return,issue_date:t.issue_date,status:t.status}:null}).filter(Boolean);
        manualFines.forEach(f=>items.push({transaction_id:null,fine_id:f.id,book_id:f.book_id,book_title:null,fee_type:f.fine_type,amount:Number(f.amount),days_late:0,expected_return:null,issue_date:f.created_at,status:'UNPAID',reason:f.reason}));
        res.json(items);
    }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/payments/submit-utr', async (req, res) => {
    try {
        const { student_id, fee_type, amount, utr_number, transaction_id, fine_id, membership } = req.body;
        const paidAmount=Number(amount);
        if (!student_id || !utr_number || !/^\d{8,20}$/.test(String(utr_number).trim()) || !Number.isFinite(paidAmount) || paidAmount<=0) return res.status(400).json({ error: 'Enter a valid amount and UTR/reference number.' });
        let tx=null, fine=null, details={fee_type};
        if (fine_id) {
            const [rows]=await db.query(`SELECT * FROM student_fines WHERE id=? AND student_id=? AND status='UNPAID'`,[fine_id,student_id]);
            if(!rows.length) return res.status(404).json({error:'Fine item not found or already cleared.'});
            const f=rows[0];
            if(paidAmount!==Number(f.amount)) return res.status(400).json({error:`Please pay the exact outstanding amount ₹${f.amount}.`});
            details={fee_type:f.fine_type,reason:f.reason,book_id:f.book_id,amount:Number(f.amount),fine_id:f.id};
        } else if (transaction_id) {
            const [rows]=await db.query('SELECT bt.*, b.title AS book_title FROM book_transactions bt LEFT JOIN books b ON bt.book_id=b.book_id WHERE bt.id=? AND bt.student_id=?',[transaction_id,student_id]);
            if (!rows.length) return res.status(404).json({error:'Fine item not found for this student.'});
            tx=rows[0]; fine=fineForTransaction(tx);
            if (!fine.amount) return res.status(400).json({error:'This fine is already cleared.'});
            if (paidAmount !== Number(fine.amount)) return res.status(400).json({error:`Please pay the exact outstanding amount ₹${fine.amount}.`});
            details={fee_type:fine.type,book_title:tx.book_title,book_id:tx.book_id,issue_date:tx.issue_date,expected_return:tx.expected_return,days_late:fine.daysLate,transaction_id:tx.id};
        } else if (!membership) {
            return res.status(400).json({error:'Select an outstanding fee item or membership payment.'});
        }
        const [insertRes]=await db.query("INSERT INTO fee_payments (student_id,fee_type,amount,utr_number,payment_status,transaction_id,book_id,days_late,details_json) VALUES (?,?,?,?,'VERIFIED',?,?,?,?)", [student_id,fee_type,paidAmount,utr_number.trim(),transaction_id||null,tx?.book_id||details.book_id||null,details.days_late||fine?.daysLate||0,JSON.stringify(details)]);
        if (transaction_id) await db.query('UPDATE book_transactions SET is_fine_paid=1 WHERE id=?',[transaction_id]);
        if (fine_id) await db.query("UPDATE student_fines SET status='PAID', paid_at=NOW(), payment_id=? WHERE id=?",[insertRes.insertId,fine_id]);
        const [paymentRows] = await db.query('SELECT payment_date FROM fee_payments WHERE id=? LIMIT 1',[insertRes.insertId]);
        const paymentDate = paymentRows[0]?.payment_date;
        const paymentDateIso = paymentDate instanceof Date ? paymentDate.toISOString() : String(paymentDate || new Date().toISOString());
        await logActivity('STUDENT', student_id, 'FEE_PAYMENT', `Paid ₹${paidAmount} for ${fee_type}. UTR ${utr_number.trim()}`);
        res.json({success:true,receipt_id:insertRes.insertId,message:'Payment verified! Outstanding item cleared.',details,payment_date:paymentDateIso});
    } catch(err){ if(err.code==='ER_DUP_ENTRY') return res.status(400).json({error:'UTR already exists!'}); res.status(500).json({error:err.message}); }
});

app.get('/api/payments/receipts/:student_id', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM fee_payments WHERE student_id = ? ORDER BY id DESC', [req.params.student_id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function getLanUrl(port) {
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of (nets[name] || [])) {
            if (net.family === 'IPv4' && !net.internal) return `http://${net.address}:${port}`;
        }
    }
    return `http://localhost:${port}`;
}

ensureProductionSchema().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        const local = `http://localhost:${PORT}`;
        const loopback = `http://127.0.0.1:${PORT}`;
        const lan = getLanUrl(PORT);
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║  📚 LIBRARY MANAGEMENT SYSTEM — SERVER READY              ║');
        console.log('╠════════════════════════════════════════════════════════════╣');
        console.log(`║  🌐 Local:    ${local.padEnd(41)}║`);
        console.log(`║  🔗 Terminal: ${loopback.padEnd(41)}║`);
        console.log(`║  📱 Network:  ${lan.padEnd(41)}║`);
        console.log('║  ↳ VS Code Port Forwarding also works on this port.      ║');
        console.log('║  🗄️  MySQL:     ' + `${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 3306}`.padEnd(41) + '║');
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log('');
    });
}).catch(err => {
    console.error('Startup schema error:', err.message);
    if (err.code === 'ER_ACCESS_DENIED_ERROR') {
        console.error('➡️  MySQL login failed. Check DB_USER/DB_PASSWORD in .env.');
        console.error('➡️  If your local root account has NO password, use: DB_PASSWORD=');
    }
    process.exit(1);
});