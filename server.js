require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Pool } = require('pg'); // <-- ต้องมีแค่บรรทัดเดียวในไฟล์
const cron = require('node-cron');
const multer = require('multer');
// ตั้งค่าให้ multer เก็บไฟล์ไว้ในหน่วยความจำ (RAM) ก่อนส่งไป Cloudflare
const upload = multer({ storage: multer.memoryStorage() });

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

// ==========================================
// API: อัปโหลดรูป Profile
// ==========================================
app.post('/api/upload-profile', upload.single('profileImage'), async (req, res) => {
    const client = await pgPool.connect();
    
    try {
        // 1. ตรวจสอบว่ามีไฟล์และข้อมูลครบหรือไม่
        if (!req.file) {
            return res.status(400).json({ error: 'ไม่พบไฟล์รูปภาพ' });
        }

        const accountId = req.body.userId;
        if (!accountId) {
            return res.status(400).json({ error: 'ไม่พบรหัสผู้ใช้งาน' });
        }

        // 2. ค้นหารหัส profile_id จาก account_id
        const userResult = await client.query('SELECT profile_id FROM user_accounts WHERE account_id = $1', [accountId]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'ไม่พบผู้ใช้งานในระบบ' });
        }
        const profileId = userResult.rows[0].profile_id;

        // 3. เตรียมไฟล์เพื่อส่งไป Cloudflare Images
        // แปลงไฟล์เป็น Blob เพื่อให้ใช้งานกับ fetch ได้
        const fileBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
        const formData = new FormData();
        formData.append('file', fileBlob, req.file.originalname);

        console.log('กำลังส่งรูปขึ้น Cloudflare...');

        // ยิง API ไปที่ Cloudflare
        const cfResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/images/v1`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.CF_API_TOKEN}`
            },
            body: formData
        });

        const cfData = await cfResponse.json();

        if (!cfData.success) {
            console.error("Cloudflare Error:", cfData.errors);
            return res.status(500).json({ error: 'อัปโหลดขึ้น Cloudflare ไม่สำเร็จ' });
        }

        // Cloudflare จะคืนค่า variants ของรูปภาพกลับมา (ใช้ลิงก์แรก)
        const imageUrl = cfData.result.variants[0];
        console.log('อัปโหลดสำเร็จ Link:', imageUrl);

        // 4. บันทึก URL ลงในฐานข้อมูล Neon
        await client.query('BEGIN'); // เริ่มทำ Transaction

        // 4.1 เปลี่ยนสถานะรูปโปรไฟล์เก่า (ถ้ามี) ให้ปิดการใช้งาน (is_active = false)
        await client.query(
            'UPDATE citizen_profiles_media SET is_active = false WHERE profile_id = $1',
            [profileId]
        );

        // 4.2 เพิ่มรูปโปรไฟล์ใหม่เข้าไป (is_active = true)
        await client.query(
            'INSERT INTO citizen_profiles_media (profile_id, image_url, is_active) VALUES ($1, $2, true)',
            [profileId, imageUrl]
        );

        await client.query('COMMIT'); // ยืนยันการเปลี่ยนแปลงข้อมูล

        // 5. ส่งลิงก์รูปใหม่กลับไปให้หน้าเว็บ (Frontend) แสดงผลทันที
        res.json({ message: 'Upload successful', imageUrl: imageUrl });

    } catch (error) {
        await client.query('ROLLBACK'); // ยกเลิกการอัปเดต DB ถ้ามีอะไรพังกลางคัน
        console.error('Upload Profile Error:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
    } finally {
        client.release();
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
// ==========================================
// API: เข้าสู่ระบบ (Login) + ระบบ Fallback แบบปลอดภัย 100%
// ==========================================
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const userQuery = await pgPool.query(
            `SELECT a.account_id, a.username_phone, a.password_hash, a.occupation_id, a.is_active, a.household_member_count,
                    p.first_name, p.last_name, p.dob, p.gender, p.house_no, 
                    o.occupation_name, 
                    v.village_id, v.village_name, v.headman_lat, v.headman_lng, 
                    v.headman_account_id, -- 🌟 ดึงข้อมูลนี้มาเพื่อเช็คว่าเป็นผู้ใหญ่บ้านไหม
                    hp.first_name AS headman_first_name, 
                    hp.last_name AS headman_last_name,
                    t.tambon_name_th, am.amphure_name_th, pr.province_name_th,
                    
                    EXTRACT(YEAR FROM age(CURRENT_DATE, p.dob)) AS age_years,
                    EXTRACT(MONTH FROM age(CURRENT_DATE, p.dob)) AS age_months,
                    EXTRACT(DAY FROM age(CURRENT_DATE, p.dob)) AS age_days,
                    
                    cpm.image_url AS user_image,
                    hpm.image_url AS headman_image,

                    pos.position_name, 
                    pos.position_level

             FROM user_accounts a
             LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
             LEFT JOIN sys_occupations o ON a.occupation_id = o.occupation_id
             
             LEFT JOIN villages v ON a.village_id = v.village_id
             LEFT JOIN user_accounts ha ON v.headman_account_id = ha.account_id
             LEFT JOIN user_profiles hp ON ha.profile_id = hp.profile_id
             LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
             LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
             LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
             
             LEFT JOIN citizen_profiles_media cpm ON p.profile_id = cpm.profile_id AND cpm.is_active = true
             LEFT JOIN citizen_profiles_media hpm ON hp.profile_id = hpm.profile_id AND hpm.is_active = true
             
             LEFT JOIN user_positions up ON a.account_id = up.account_id AND up.is_active = TRUE AND (up.end_date IS NULL OR up.end_date >= CURRENT_DATE)
             LEFT JOIN sys_positions pos ON up.position_id = pos.position_id

             WHERE a.username_phone = $1`,
            [username]
        );

        if (userQuery.rows.length === 0) {
            return res.status(401).json({ message: 'เบอร์โทรศัพท์หรือรหัสผ่านไม่ถูกต้อง' });
        }

        const user = userQuery.rows[0];

        if (user.is_active === false) {
            return res.status(403).json({ message: 'บัญชีนี้ยังไม่ได้รับการอนุมัติ กรุณาติดต่อผู้ใหญ่บ้าน' });
        }

        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ message: 'เบอร์โทรศัพท์หรือรหัสผ่านไม่ถูกต้อง' });
        }

        let permissions = [];
        if (user.occupation_id) {
            const permQuery = await pgPool.query(
                `SELECT sp.permission_code
                 FROM occupation_permissions op
                 JOIN sys_permissions sp ON op.permission_id = sp.permission_id
                 WHERE op.occupation_id = $1`,
                [user.occupation_id]
            );
            permissions = permQuery.rows.map(row => row.permission_code);
        }

        const token = jwt.sign(
            { account_id: user.account_id, occupation_id: user.occupation_id, village_id: user.village_id },
            process.env.JWT_SECRET || 'banrao_secret_key',
            { expiresIn: '1d' }
        );

        const daysTh = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
        const birthDate = user.dob ? new Date(user.dob) : null;
        const dayNameTh = birthDate ? daysTh[birthDate.getDay()] : '-';
        const genderTh = user.gender === 'MALE' ? 'ชาย' : (user.gender === 'FEMALE' ? 'หญิง' : '-');

        // 🌟🌟 Fallback Logic ด้วย JavaScript 🌟🌟
        let finalPositionName = user.position_name;
        let finalPositionLevel = user.position_level;

        if (!finalPositionName) {
            // 1. ตรวจสอบว่าคนที่ล็อกอิน คือคนเดียวกับที่เป็นผู้ใหญ่บ้านของหมู่บ้านนี้หรือไม่?
            if (user.account_id && user.headman_account_id && user.account_id === user.headman_account_id) {
                finalPositionName = 'ผู้ใหญ่บ้าน';
                finalPositionLevel = 'VILLAGE';
            } 
            // 2. ถ้าไม่ใช่ เช็คจากชื่ออาชีพ (occupation_name)
            else if (user.occupation_name && user.occupation_name !== 'ประชาชนทั่วไป') {
                finalPositionName = user.occupation_name;
                if (finalPositionName.includes('นายอำเภอ')) finalPositionLevel = 'AMPHURE';
                else if (finalPositionName.includes('ผู้ใหญ่บ้าน') || finalPositionName.includes('อสม.')) finalPositionLevel = 'VILLAGE';
                else if (finalPositionName.includes('อบต.') || finalPositionName.includes('นายก')) finalPositionLevel = 'TAMBON';
            }
        }

        res.json({
            message: 'เข้าสู่ระบบสำเร็จ',
            token,
            user: {
                id: user.account_id,
                username: user.username_phone,
                firstName: user.first_name,
                lastName: user.last_name,
                occupation: user.occupation_name,
                permissions: permissions,
                villageName: user.village_name, 
                headmanName: user.headman_first_name ? `${user.headman_first_name} ${user.headman_last_name}` : null,
                tambonName: user.tambon_name_th,
                amphureName: user.amphure_name_th,
                provinceName: user.province_name_th,
                gender: genderTh,
                birthDayName: dayNameTh,
                age_years: user.age_years || 0,
                age_months: user.age_months || 0,
                age_days: user.age_days || 0,
                house_no: user.house_no || '-',
                household_member_count: user.household_member_count || 0,
                userImage: user.user_image || '/profile-img.jpg', 
                headmanImage: user.headman_image || 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&q=80',
                
                position_name: finalPositionName,
                position_level: finalPositionLevel
            }
        });

    } catch (error) {
        console.error('Login API Error:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});
// =========================================================

// ==========================================
// API: ดึงเมนู Sidebar ตามสิทธิ์ของผู้ใช้งาน (Dynamic Role-Based Menu)
// ==========================================
app.get('/api/sidebar-menus/:accountId', async (req, res) => {
    const { accountId } = req.params;
    const client = await pgPool.connect();

    try {
        // Query สุดฉลาด: หาว่าคนๆ นี้มีสิทธิ์อะไรบ้างในวันนี้ แล้วดึงเมนูที่ตรงกับสิทธิ์นั้นออกมา
        const query = `
            WITH UserPermissions AS (
                -- 1. ดึงสิทธิ์จาก 'ตำแหน่งทางการ' (user_positions) ที่ยังไม่หมดวาระ
                SELECT pp.permission_id
                FROM user_positions up
                JOIN position_permissions pp ON up.position_id = pp.position_id
                WHERE up.account_id = $1 
                  AND up.is_active = TRUE 
                  AND up.start_date <= CURRENT_DATE 
                  AND (up.end_date IS NULL OR up.end_date >= CURRENT_DATE)
                  
                -- หมายเหตุ: หากมีการผูกสิทธิ์จาก delegated_tasks สามารถนำมา UNION ต่อตรงนี้ได้เลย
            )
            SELECT 
                mg.group_name, 
                m.menu_name AS name, 
                m.icon_name AS icon, 
                m.route_path AS path
            FROM sys_menus m
            JOIN sys_menu_groups mg ON m.group_id = mg.group_id
            WHERE m.is_active = TRUE 
              -- เงื่อนไข: ถ้า permission_id เป็น NULL คือเมนูสาธารณะ หรือ ถ้ามีค่าต้องตรงกับสิทธิ์ที่คนๆ นี้มี
              AND (m.permission_id IS NULL OR m.permission_id IN (SELECT permission_id FROM UserPermissions))
            ORDER BY mg.display_order, m.display_order;
        `;

        const result = await client.query(query, [accountId]);

        // จัดกลุ่มข้อมูล (Group By) ให้เป็นรูปแบบ JSON ที่ Frontend ต้องการ
        const groupedMenus = result.rows.reduce((acc, row) => {
            // หาว่ากลุ่มนี้ (เช่น 'เมนูทั่วไป') ถูกสร้างไว้ใน array หรือยัง
            const group = acc.find(g => g.group_name === row.group_name);
            const menuData = { name: row.name, icon: row.icon, path: row.path };
            
            if (group) {
                group.menus.push(menuData); // ถ้ามีกลุ่มแล้ว จับเมนูยัดใส่ array
            } else {
                acc.push({ group_name: row.group_name, menus: [menuData] }); // ถ้ายังไม่มี สร้างกลุ่มใหม่
            }
            return acc;
        }, []);

        res.json({ success: true, data: groupedMenus });

    } catch (error) {
        console.error("Fetch Sidebar Menus Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูลเมนู' });
    } finally {
        client.release();
    }
});


// ==========================================
// API: ดึงข้อมูลสถานที่และบริการในชุมชน (Community Places)
// ==========================================
app.get('/api/community-places', async (req, res) => {
    try {
        const query = `
            SELECT 
                cp.place_id, 
                cp.place_name, 
                cp.description, 
                cp.cover_image_url, 
                cp.visibility_level, 
                cp.operating_hours, 
                cp.services, 
                cp.is_verified,
                cat.category_name,
                p.first_name AS owner_first_name, 
                p.last_name AS owner_last_name,
                cpm.image_url AS owner_image
            FROM community_places cp
            LEFT JOIN sys_place_categories cat ON cp.category_id = cat.category_id
            LEFT JOIN user_accounts a ON cp.owner_account_id = a.account_id
            LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
            LEFT JOIN citizen_profiles_media cpm ON p.profile_id = cpm.profile_id AND cpm.is_active = true
            WHERE cp.is_active = TRUE
            ORDER BY cp.created_at DESC
        `;
        
        const result = await pgPool.query(query);
        
        // จัด Format ข้อมูลให้ง่ายต่อการนำไปใช้งานใน React
        const places = result.rows.map(row => {
            // สมมติฐานให้เป็น true ก่อน (ถ้าต้องการเช็คเวลาจริง สามารถเพิ่มเงื่อนไขจาก operating_hours ได้)
            const isOpen = true; 
            
            return {
                id: row.place_id,
                name: row.place_name,
                category: row.category_name || 'สถานที่ทั่วไป',
                desc: row.description,
                img: row.cover_image_url || 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=600&q=80',
                isOpen: isOpen,
                visibility: row.visibility_level === 'PUBLIC' ? 'สาธารณะ' : 
                            row.visibility_level === 'PROVINCE' ? 'ระดับจังหวัด' :
                            row.visibility_level === 'AMPHURE' ? 'ระดับอำเภอ' :
                            row.visibility_level === 'TAMBON' ? 'ระดับตำบล' : 'ระดับหมู่บ้าน',
                services: row.services || [],
                isVerified: row.is_verified,
                owner: {
                    name: row.owner_first_name ? `${row.owner_first_name} ${row.owner_last_name}` : 'ผู้ใช้งาน',
                    img: row.owner_image || 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&q=80'
                }
            };
        });

        res.json({ success: true, places });

    } catch (error) {
        console.error('API Community Places Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});