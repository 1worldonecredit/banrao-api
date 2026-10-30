require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Pool } = require('pg'); // <-- ต้องมีแค่บรรทัดเดียวในไฟล์
const cron = require('node-cron');

const app = express();

const bcrypt = require('bcrypt');
// เปิดใช้งาน CORS เพื่อให้ Frontend (พอร์ต 5173) เรียกใช้งานได้

// ตั้งค่า Secret Key สำหรับสร้าง Token (ในระบบจริงควรเก็บไว้ในไฟล์ .env)
const JWT_SECRET = process.env.JWT_SECRET || 'mySuperSecretKeyForBookingApp2026';
app.use(cors());

// ขยายขีดจำกัดให้รองรับรูปภาพสลิป
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const port = process.env.PORT || 5000;

// 🌟 สร้าง Connection Pool สำหรับ PostgreSQL (ต้องมีแค่ชุดเดียวในไฟล์)
const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // จำเป็นสำหรับการเชื่อมต่อฐานข้อมูลบน Cloud เช่น Neon
    }
});


// API สำหรับขอค่ารัศมีการแสดงผลตามพิกัดปัจจุบัน
app.post('/api/get-display-radius', async (req, res) => {
    const { lat, lng } = req.body;
    try {
        // ใช้ SQL หาระยะทางจากจุดศูนย์กลางที่ Admin ตั้งไว้ 
        // เช็คว่าผู้ใช้อยู่ในระยะ zone_coverage_km หรือไม่ และดึงค่า display_radius_km ออกมา
        const query = `
            SELECT display_radius_km 
            FROM service_zones 
            WHERE is_default = FALSE 
            AND (6371 * acos(cos(radians($1)) * cos(radians(center_lat)) * cos(radians(center_lng) - radians($2)) + sin(radians($1)) * sin(radians(center_lat)))) <= zone_coverage_km
            ORDER BY zone_coverage_km ASC 
            LIMIT 1;
        `;
        const result = await pgPool.query(query, [lat, lng]);

        if (result.rows.length > 0) {
            // เจอโซนที่ Admin กำหนดไว้
            res.json({ success: true, radius: result.rows[0].display_radius_km });
        } else {
            // ไม่อยู่ในโซนใดๆ เลย ให้ดึงค่า Default
            const defaultZone = await pgPool.query("SELECT display_radius_km FROM service_zones WHERE is_default = TRUE LIMIT 1");
            res.json({ success: true, radius: defaultZone.rows[0].display_radius_km || 50 });
        }
    } catch (err) {
        console.error("Error getting radius:", err.message);
        res.status(500).json({ success: false, radius: 50 }); // กันเหนียวกรณีเซิร์ฟเวอร์รวน
    }
});
// ==========================================
// API สำหรับบันทึกพิกัดแผนที่ (วางไว้รวมกับ Route อื่นๆ)
// ==========================================
app.post('/api/save-location', async (req, res) => {
    try {
        // รับค่าที่หน้าบ้าน (React) ส่งมา
        const { user_id, label, latitude, longitude } = req.body;
        
        // บันทึกลงตาราง user_addresses
        // 🌟 สังเกตว่าใช้ pgPool.query ตามชื่อตัวแปรในไฟล์ของคุณ
        const newLocation = await pgPool.query(
            "INSERT INTO user_addresses (user_id, label, latitude, longitude) VALUES ($1, $2, $3, $4) RETURNING *",
            [user_id, label, latitude, longitude]
        );

        // ส่งผลลัพธ์กลับไปบอกหน้าบ้าน
        res.json({ success: true, data: newLocation.rows[0] });
    } catch (err) {
        console.error("Error saving location:", err.message);
        res.status(500).json({ success: false, error: "Database Error" });
    }
});
// ---------------------------------------------------------
// 0. ตั้งค่า CORS (จำกัดโดเมนที่อนุญาตให้เข้าถึง API)
// ---------------------------------------------------------
const allowedOrigins = [
  'https://banrao.life',             // โดเมนหลัก
  'https://supper.banrao.life', 
  'https://api.banrao.life',
  'https://emp.banrao.life',
   // โดเมนหลัก (มี www)
 'http://localhost:5173',
  'http://localhost:5174'       // สำหรับทดสอบ Frontend (อื่นๆ)
];


// ==========================================
// สร้าง Route ทดสอบ 
// ==========================================

app.get('/api/test', async (req, res) => {
    try {
        const result = await pgPool.query('SELECT NOW()');
        res.json({ message: "เชื่อมต่อฐานข้อมูลสำเร็จ!", time: result.rows[0].now });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "การเชื่อมต่อฐานข้อมูลผิดพลาด" });
    }
});


// ตัวอย่าง API ดึงข้อมูลเมนู (Node.js / Express)
app.get('/api/sys-menus', async (req, res) => {
    try {
        // ดึงเฉพาะเมนูที่เปิดใช้งาน เรียงตามลำดับ
        const query = `
            SELECT * FROM sys_menus 
            WHERE is_active = true 
            ORDER BY parent_id ASC NULLS FIRST, sort_order ASC
        `;
        const result = await db.query(query); // ปรับใช้ตาม Database Client ของคุณ
        
        res.status(200).json(result.rows);
    } catch (error) {
        console.error("Error fetching menus:", error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// ==========================================
// API สำหรับระบบเลือกพื้นที่ (Dropdown)
// ==========================================

// 1. ดึงรายชื่อประเทศทั้งหมด
app.get('/api/countries', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sys_countries WHERE is_active = true ORDER BY country_name_th ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลประเทศ' });
    }
});

// 2. ดึงรายชื่อจังหวัดตามรหัสประเทศ (เช่น /api/provinces?country_id=1)
app.get('/api/provinces', async (req, res) => {
    const { country_id } = req.query;
    if (!country_id) return res.status(400).json({ error: 'กรุณาระบุ country_id' });

    try {
        const result = await pool.query(
            'SELECT * FROM sys_provinces WHERE country_id = $1 ORDER BY province_name_th ASC',
            [country_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลจังหวัด' });
    }
});

// 3. ดึงรายชื่ออำเภอตามรหัสจังหวัด (เช่น /api/amphures?province_id=10)
app.get('/api/amphures', async (req, res) => {
    const { province_id } = req.query;
    if (!province_id) return res.status(400).json({ error: 'กรุณาระบุ province_id' });

    try {
        const result = await pool.query(
            'SELECT * FROM sys_amphures WHERE province_id = $1 ORDER BY amphure_name_th ASC',
            [province_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลอำเภอ' });
    }
});

// 4. ดึงรายชื่อตำบลและรหัสไปรษณีย์ตามรหัสอำเภอ (เช่น /api/tambons?amphure_id=1001)
app.get('/api/tambons', async (req, res) => {
    const { amphure_id } = req.query;
    if (!amphure_id) return res.status(400).json({ error: 'กรุณาระบุ amphure_id' });

    try {
        const result = await pool.query(
            'SELECT * FROM sys_tambons WHERE amphure_id = $1 ORDER BY tambon_name_th ASC',
            [amphure_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลตำบล' });
    }
});

// ==========================================
// API สำหรับจัดการเมนูระบบ (Menu Management)
// ==========================================

// 1. ดึงข้อมูลเมนูทั้งหมด (GET)
app.get('/api/menus', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sys_menus ORDER BY parent_id NULLS FIRST, sort_order ASC, id ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "ไม่สามารถดึงข้อมูลได้" });
  }
});

// 2. สร้างเมนูใหม่ (POST)
app.post('/api/menus', async (req, res) => {
  try {
    const { name, path, component, icon, parentId, useBadge } = req.body;
    const result = await pool.query(
      `INSERT INTO sys_menus (menu_name, path, component, icon, parent_id, sort_order) 
       VALUES ($1, $2, $3, $4, $5, 0) RETURNING *`,
      [name, path || null, component || null, icon || null, parentId || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "บันทึกไม่ได้" });
  }
});

// 3. แก้ไขข้อมูลเมนู (PUT)
app.put('/api/menus/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, path, component, icon, parentId, useBadge } = req.body;
    const result = await pool.query(
      `UPDATE sys_menus SET menu_name = $1, path = $2, component = $3, icon = $4, parent_id = $5 
       WHERE id = $6 RETURNING *`,
      [name, path || null, component || null, icon || null, parentId || null, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "อัปเดตไม่ได้" });
  }
});

// 4. ลบเมนู (DELETE)
app.delete('/api/menus/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM sys_menus WHERE parent_id = $1', [id]); // ลบลูกก่อน
    await pool.query('DELETE FROM sys_menus WHERE id = $1', [id]); // ลบแม่
    res.json({ message: "ลบสำเร็จ" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "ลบไม่ได้" });
  }
});


// ต้องมี import 2 ตัวนี้ด้านบนสุดของไฟล์ด้วยนะครับ (ถ้ายังไม่มี)
// const bcrypt = require('bcrypt');
// const jwt = require('jsonwebtoken');

// ==========================================
// API: เข้าสู่ระบบ (Login) อัปเดตตาม DB ใหม่
// ==========================================
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        // 1. ค้นหาผู้ใช้งาน โดย Join ตาราง accounts -> identities -> profiles
       const userQuery = await pgPool.query(
    `SELECT a.account_id, a.username_phone, a.password_hash, a.occupation_id, a.is_approved,
            p.first_name, p.last_name, o.occupation_name
     FROM user_accounts a
     JOIN user_identities i ON a.account_id = i.account_id
     JOIN user_profiles p ON a.account_id = p.account_id
     LEFT JOIN sys_occupations o ON a.occupation_id = o.occupation_id
     WHERE a.username_phone = $1`,
    [username]
);
        if (userQuery.rows.length === 0) {
            return res.status(401).json({ message: 'เบอร์โทรศัพท์หรือรหัสผ่านไม่ถูกต้อง' });
        }

        const user = userQuery.rows[0];

        // 2. เช็คสถานะว่าได้รับการอนุมัติจากผู้ใหญ่บ้านหรือยัง
        if (user.is_approved === false) {
            return res.status(403).json({ message: 'บัญชีนี้ยังไม่ได้รับการอนุมัติ กรุณาติดต่อผู้ใหญ่บ้าน' });
        }

        // 3. ตรวจสอบรหัสผ่าน (ใช้ bcrypt)
        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ message: 'เบอร์โทรศัพท์หรือรหัสผ่านไม่ถูกต้อง' });
        }

        // 4. ดึงสิทธิ์ (Permissions)
        const permQuery = await pgPool.query(
            `SELECT sp.permission_code
             FROM occupation_permissions op
             JOIN sys_permissions sp ON op.permission_id = sp.permission_id
             WHERE op.occupation_id = $1`,
            [user.occupation_id]
        );
        const permissions = permQuery.rows.map(row => row.permission_code);

        // 5. สร้าง Token
        const token = jwt.sign(
            { account_id: user.account_id, occupation_id: user.occupation_id },
            process.env.JWT_SECRET || 'banrao_secret_key',
            { expiresIn: '1d' }
        );

        res.json({
            message: 'เข้าสู่ระบบสำเร็จ',
            token,
            user: {
                id: user.account_id,
                username: user.username_phone,
                firstName: user.first_name,
                lastName: user.last_name,
                occupation: user.occupation_name,
                permissions: permissions
            }
        });

    } catch (error) {
        console.error('Login API Error:', error);
        // ส่งข้อความ Error กลับไปให้รู้ว่าพังที่บรรทัดไหน
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});
// =========================================================


app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});