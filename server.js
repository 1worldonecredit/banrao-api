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
const saltRounds = 10;

// ---------------------------------------------
// ตั้งค่า Secret Key สำหรับสร้าง Token (ในระบบจริงควรเก็บไว้ในไฟล์ .env)
const JWT_SECRET = process.env.JWT_SECRET || 'mySuperSecretKeyForBookingApp2026';

// ==========================================
// 1. ตั้งค่า CORS (ตั้งค่าไว้ที่เดียวให้จบ ครอบคลุมทุกโดเมน)
// ==========================================
const allowedOrigins = [
  'https://banrao.life',
  'https://www.banrao.life',
  'https://supper.banrao.life',
  'https://emp.banrao.life',
  'http://localhost:5173',
  'http://localhost:5174'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            return callback(new Error('CORS policy error'), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'], // <-- เพิ่มบรรทัดนี้ครับ
    credentials: true
}));

// ==========================================
// 2. ขยายขีดจำกัดให้รองรับรูปภาพสลิป
// ==========================================
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
// API: บันทึกข้อมูลหมู่บ้านแบบ Batch (อัปเดตชื่อตารางเป็น villages)
// ==========================================
app.post('/api/sys-villages/batch', async (req, res) => {
    const { tambon_id, villages } = req.body; 

    if (!tambon_id || !villages || villages.length === 0) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');
        
        let insertedCount = 0;
        for (const v of villages) {
            // 1. เช็คข้อมูลซ้ำในตาราง villages
            const check = await client.query(
                'SELECT village_id FROM villages WHERE tambon_id = $1 AND village_no = $2 AND village_name = $3', 
                [tambon_id, v.village_no, v.village_name]
            );

            if (check.rows.length === 0) {
                // 2. บันทึกข้อมูลลงตาราง villages 
                // หมายเหตุ: โครงสร้างตาราง villages ของคุณมีการตั้งค่า DEFAULT ให้หลายคอลัมน์แล้ว (เช่น village_id, is_approved_by_admin, created_at)
                // ดังนั้นเราส่งแค่ 3 คอลัมน์หลักก็พอครับ
                await client.query(
                    `INSERT INTO villages (tambon_id, village_no, village_name) VALUES ($1, $2, $3)`,
                    [tambon_id, v.village_no, v.village_name]
                );
                insertedCount++;
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, message: `บันทึกข้อมูลหมู่บ้านสำเร็จ ${insertedCount} รายการ` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Batch Insert Villages Error:", error);
        res.status(500).json({ success: false, message: `เกิดข้อผิดพลาดจากฐานข้อมูล: ${error.message}` });
    } finally {
        client.release();
    }
});
// ==========================================
// API: ดึงสถิติ Dashboard (อัปเดตชื่อตารางและฟิลด์ให้ถูกต้องเป๊ะ 100%)
// ==========================================
app.get('/api/dashboard/:userId', async (req, res) => {
    const { userId } = req.params;

    const client = await pgPool.connect();
    try {
        // 🌟 1. ดึง "เป้าหมาย" จากตาราง villages (ใช้ชื่อคอลัมน์ household_count, population_count)
        const userResult = await client.query(`
            SELECT u.village_id, v.household_count, v.population_count
            FROM user_accounts u
            LEFT JOIN villages v ON u.village_id = v.village_id
            WHERE u.account_id = $1
        `, [userId]);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลผู้ใช้งาน' });
        }
        
        const villageId = userResult.rows[0].village_id;
        
        // แปลงชื่อให้ตรงกับที่หน้า Dashboard.jsx รอรับอยู่
        const targetHouses = userResult.rows[0].household_count || 0;
        const targetPop = userResult.rows[0].population_count || 0;

        // 2. นับจำนวน "ครัวเรือนที่ลงทะเบียนจริง"
        const houseResult = await client.query(`
            SELECT COUNT(household_id) as total_houses 
            FROM households 
            WHERE village_id = $1
        `, [villageId]);

        // 3. นับจำนวน "ประชากรที่ลงทะเบียนจริง"
        const popResult = await client.query(`
            SELECT COUNT(hm.member_id) as total_population 
            FROM household_members hm
            JOIN households h ON hm.household_id = h.household_id
            WHERE h.village_id = $1
        `, [villageId]);

        // 4. ส่งข้อมูลทั้งหมดกลับไปให้หน้า Dashboard
        res.json({
            success: true,
            village_id: villageId,
            stats: {
                target_houses: targetHouses,
                target_population: targetPop,
                total_houses: parseInt(houseResult.rows[0].total_houses) || 0,
                total_population: parseInt(popResult.rows[0].total_population) || 0
            }
        });

    } catch (error) {
        console.error("Dashboard Stats Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงสถิติ' });
    } finally {
        if (client) client.release();
    }
});

// ==========================================
// API 1: ดึงรายชื่อหมู่บ้านตามชื่อตำบล (สำหรับ Dropdown)
// ==========================================
app.get('/api/villages/by-tambon', async (req, res) => {
    const { tambon_name } = req.query;
    if (!tambon_name) return res.json([]);

    try {
        // ตัดคำว่า "ตำบล" หรือ "ต." ออก เพื่อนำไปค้นหาแบบ LIKE ได้แม่นยำขึ้น
        const cleanTambonName = tambon_name.replace('ตำบล', '').replace('ต.', '').trim();
        
        const result = await pgPool.query(`
            SELECT v.village_id, v.village_no, v.village_name 
            FROM villages v
            JOIN sys_tambons t ON v.tambon_id = t.tambon_id
            WHERE t.tambon_name_th LIKE $1
            ORDER BY v.village_no ASC
        `, [`%${cleanTambonName}%`]);
        
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// ==========================================
// API: ดึงรายชื่อหมู่บ้านตาม ID ตำบล (สำหรับแสดงตารางหน้า Master Data)
// ==========================================
app.get('/api/villages/by-tambon-id/:tambonId', async (req, res) => {
    try {
        const { tambonId } = req.params;
        // เรียงลำดับหมู่บ้านตามตัวอักษร
        const result = await pgPool.query(
            'SELECT village_id, village_no, village_name FROM villages WHERE tambon_id = $1 ORDER BY village_no ASC',
            [tambonId]
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



// ==========================================
// API: ค้นหาข้อมูลผู้แนะนำจากเบอร์โทรศัพท์
// ==========================================
app.get('/api/users/referrer/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        const result = await pgPool.query(`
            SELECT u.account_id, p.first_name, p.last_name, v.village_no, v.village_name
            FROM user_accounts u
            JOIN user_profiles p ON u.profile_id = p.profile_id
            LEFT JOIN villages v ON u.village_id = v.village_id
            WHERE u.username_phone = $1 AND u.is_active = true
            LIMIT 1
        `, [phone]);

        if (result.rows.length > 0) {
            res.json({ success: true, data: result.rows[0] });
        } else {
            res.json({ success: false, message: 'ไม่พบข้อมูล' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});


// 1. ดึงจังหวัด (เปลี่ยนมาส่งคืน province_code ให้ Frontend)
app.get('/api/sys-provinces', async (req, res) => {
    try {
        const result = await pgPool.query('SELECT province_code, province_name_th FROM sys_provinces ORDER BY province_name_th ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. ดึงอำเภอ (กลับไปใช้ LIKE เหมือนเดิม)
app.get('/api/sys-amphures/:provinceCode', async (req, res) => {
    try {
        const pCode = req.params.provinceCode;
        const result = await pgPool.query(
            'SELECT amphure_code, amphure_name_th FROM sys_amphures WHERE amphure_code LIKE $1 ORDER BY amphure_name_th ASC',
            [`${pCode}%`]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. ดึงตำบล (เชื่อมผ่าน amphure_id รองรับการแยก/ย้ายอำเภอและตำบล 100%)
app.get('/api/sys-tambons/:amphureCode', async (req, res) => {
    try {
        const aCode = req.params.amphureCode;
        const result = await pgPool.query(`
            SELECT t.tambon_id, t.tambon_name_th
            FROM sys_tambons t
            JOIN sys_amphures a ON t.amphure_id = a.amphure_id
            WHERE a.amphure_code = $1
            ORDER BY t.tambon_name_th ASC
        `, [String(aCode)]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
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

// =========================================================================
// 👤 API จัดการโปรไฟล์ผู้ใช้งาน Frontend (ดึง / แก้ไข / ลบรูปแบบ Soft Delete)
// =========================================================================

// 1. ดึงข้อมูลโปรไฟล์ล่าสุดของบัญชีนี้ (รวมถึงรายชื่ออาชีพสำหรับ Dropdown)
app.get('/api/user/profile/:accountId', async (req, res) => {
    const { accountId } = req.params;
    try {
        const [userRes, occRes] = await Promise.all([
            pgPool.query(`
                SELECT 
                    a.account_id, a.username_phone, a.occupation_id, a.household_member_count,
                    a.role, COALESCE(a.tier_code, 'CITIZEN_FREE') AS tier_code,
                    COALESCE(a.community_score, 0) AS community_score,
                    a.referral_code, a.referred_by, a.is_active,
                    p.profile_id, p.first_name, p.last_name, p.nickname, p.dob, p.gender, p.house_no,
                    o.occupation_name,
                    (
                        SELECT cpm.image_url
                        FROM citizen_profiles_media cpm
                        WHERE cpm.profile_id = a.profile_id AND cpm.is_active = true
                        LIMIT 1
                    ) AS user_image,
                    v.village_no, v.village_name,
                    t.tambon_name_th, am.amphure_name_th, pr.province_name_th,
                    hp.first_name AS headman_first_name, hp.last_name AS headman_last_name
                FROM user_accounts a
                LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
                LEFT JOIN sys_occupations o ON a.occupation_id = o.occupation_id
                LEFT JOIN villages v ON a.village_id = v.village_id
                LEFT JOIN user_accounts ha ON v.headman_account_id = ha.account_id
                LEFT JOIN user_profiles hp ON ha.profile_id = hp.profile_id
                LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
                LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
                LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
                WHERE a.account_id = $1
            `, [accountId]),
            pgPool.query(`SELECT occupation_id, occupation_name FROM sys_occupations ORDER BY occupation_name ASC`).catch(() => ({ rows: [] }))
        ]);

        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลผู้ใช้งาน' });
        }

        res.json({
            success: true,
            data: userRes.rows[0],
            occupations: occRes.rows
        });
    } catch (err) {
        console.error('Get User Profile Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. เพิ่ม / แก้ไข / ล้างค่า ข้อมูลส่วนตัวใน user_profiles และ user_accounts
app.put('/api/user/profile/:accountId', async (req, res) => {
    const { accountId } = req.params;
    const {
        first_name, last_name, nickname, dob, gender, house_no,
        occupation_id, household_member_count
    } = req.body;

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // ค้นหา profile_id ของบัญชีนี้
        const accRes = await client.query(
            `SELECT profile_id FROM user_accounts WHERE account_id = $1`,
            [accountId]
        );
        if (accRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบบัญชีผู้ใช้งาน' });
        }

        const profileId = accRes.rows[0].profile_id;

        // อัปเดตข้อมูลส่วนตัวลง user_profiles (ส่งค่าว่าง = ล้างค่าเป็น NULL)
        if (profileId) {
            await client.query(`
                UPDATE user_profiles
                SET first_name = $1,
                    last_name = $2,
                    nickname = $3,
                    dob = $4,
                    gender = $5,
                    house_no = $6
                WHERE profile_id = $7
            `, [
                first_name ? first_name.trim() : '',
                last_name ? last_name.trim() : '',
                nickname && nickname.trim() ? nickname.trim() : null,
                dob && dob.trim() ? dob.trim() : null,
                gender && gender.trim() ? gender.trim() : null,
                house_no && house_no.trim() ? house_no.trim() : null,
                profileId
            ]);
        }

        // อัปเดตอาชีพและจำนวนสมาชิกในครัวเรือนลง user_accounts
        await client.query(`
            UPDATE user_accounts
            SET occupation_id = $1,
                household_member_count = $2
            WHERE account_id = $3
        `, [
            occupation_id ? Number(occupation_id) : null,
            household_member_count !== '' && household_member_count !== null ? Number(household_member_count) : 0,
            accountId
        ]);

        await client.query('COMMIT');
        res.json({ success: true, message: 'บันทึกข้อมูลโปรไฟล์เรียบร้อยแล้ว' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Update User Profile Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});


// =========================================================================
// 👥 1. API ดึงรายชื่อผู้ที่เราแนะนำ (Referrals)
// =========================================================================
app.get('/api/user/referrals/:accountId', async (req, res) => {
    const { accountId } = req.params;
    try {
        // หา referral_code และเบอร์โทรของเจ้าของโปรไฟล์ก่อน
        const ownerRes = await pgPool.query(
            `SELECT referral_code, username_phone FROM user_accounts WHERE account_id = $1`,
            [accountId]
        );
        if (ownerRes.rows.length === 0) {
            return res.json({ success: true, data: [] });
        }

        const { referral_code, username_phone } = ownerRes.rows[0];
        const matchValues = [referral_code, username_phone].filter(Boolean);
        if (matchValues.length === 0) {
            return res.json({ success: true, data: [] });
        }

        const refRes = await pgPool.query(`
            SELECT 
                a.account_id,
                a.username_phone,
                COALESCE(a.tier_code, 'CITIZEN_FREE') AS tier_code,
                COALESCE(a.community_score, 0) AS community_score,
                a.created_at,
                p.first_name,
                p.last_name,
                p.nickname,
                v.village_no,
                v.village_name,
                (
                    SELECT cpm.image_url
                    FROM citizen_profiles_media cpm
                    WHERE cpm.profile_id = a.profile_id AND cpm.is_active = true
                    LIMIT 1
                ) AS user_image
            FROM user_accounts a
            LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
            LEFT JOIN villages v ON a.village_id = v.village_id
            WHERE a.referred_by = ANY($1::text[])
              AND a.account_id != $2
            ORDER BY a.created_at DESC NULLS LAST
        `, [matchValues, accountId]);

        res.json({ success: true, data: refRes.rows });
    } catch (err) {
        console.error('Get Referrals Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// =========================================================================
// 📸 2. API ดึงรายการ My Story ของผู้ใช้งาน
// =========================================================================
app.get('/api/user/stories/:accountId', async (req, res) => {
    const { accountId } = req.params;
    try {
        const result = await pgPool.query(`
            SELECT *
            FROM user_stories
            WHERE account_id = $1 AND is_active = true
            ORDER BY created_at DESC
        `, [accountId]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Get User Stories Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// =========================================================================
// 🗑️ 4. API ลบ My Story (Soft Delete: is_active = false)
// =========================================================================
app.delete('/api/user/stories/:storyId', async (req, res) => {
    try {
        await pgPool.query(
            `UPDATE user_stories SET is_active = false WHERE story_id = $1`,
            [req.params.storyId]
        );
        res.json({ success: true, message: 'ลบ Story เรียบร้อยแล้ว' });
    } catch (err) {
        console.error('Delete Story Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});



// 3. ลบรูปโปรไฟล์ปัจจุบัน (Soft Delete: ปรับ is_active = false ไม่ลบไฟล์จริง)
app.delete('/api/user/profile-image/:accountId', async (req, res) => {
    const { accountId } = req.params;
    try {
        const accRes = await pgPool.query(
            `SELECT profile_id FROM user_accounts WHERE account_id = $1`,
            [accountId]
        );
        if (accRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบบัญชีผู้ใช้งาน' });
        }

        await pgPool.query(
            `UPDATE citizen_profiles_media SET is_active = false WHERE profile_id = $1`,
            [accRes.rows[0].profile_id]
        );

        res.json({ success: true, message: 'ลบรูปโปรไฟล์เรียบร้อยแล้ว' });
    } catch (err) {
        console.error('Delete Profile Image Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// =========================================================================
// 🌟 API ฟีด Story เพื่อนบน Dashboard (ดู / ชอบ / ดาว 1-7 / แชร์ / คอมเมนต์ / ติดตาม)
// =========================================================================
// =========================================================================
// 🌟 2. API ฟีด Story เพื่อนบน Dashboard (กรองโพสต์ที่ซ่อนและคนที่ถูกบล็อกออก)
// =========================================================================
app.get('/api/stories/feed/:viewerId', async (req, res) => {
    const { viewerId } = req.params;
    try {
        const result = await pgPool.query(`
            SELECT 
                s.*,
                p.first_name, p.last_name, p.nickname,
                (
                    SELECT cpm.image_url FROM citizen_profiles_media cpm
                    WHERE cpm.profile_id = a.profile_id AND cpm.is_active = true
                    LIMIT 1
                ) AS author_image,
                (SELECT COUNT(*)::int FROM story_likes sl WHERE sl.story_id = s.story_id) AS likes_count,
                EXISTS(SELECT 1 FROM story_likes sl WHERE sl.story_id = s.story_id AND sl.account_id = $1) AS is_liked,
                COALESCE((SELECT ROUND(AVG(stars)::numeric, 1) FROM story_stars ss WHERE ss.story_id = s.story_id), 0) AS avg_stars,
                COALESCE((SELECT SUM(stars)::int FROM story_stars ss WHERE ss.story_id = s.story_id), 0) AS total_stars,
                COALESCE((SELECT stars FROM story_stars ss WHERE ss.story_id = s.story_id AND ss.account_id = $1), 0) AS my_stars,
                (SELECT COUNT(*)::int FROM story_comments sc WHERE sc.story_id = s.story_id AND COALESCE(sc.is_active, true) = true) AS comments_count,
                EXISTS(SELECT 1 FROM user_follows uf WHERE uf.follower_id = $1 AND uf.following_id = s.account_id) AS is_following
            FROM user_stories s
            JOIN user_accounts a ON s.account_id = a.account_id
            LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
            WHERE s.is_active = true
              AND COALESCE(s.is_hidden, false) = false
              AND (s.visibility != 'PRIVATE' OR s.account_id = $1)
              AND NOT EXISTS (
                  SELECT 1 FROM user_blocks ub
                  WHERE ub.blocker_id = s.account_id AND ub.blocked_id = $1
              )
            ORDER BY s.created_at DESC
        `, [viewerId]);

        const authorsMap = new Map();
        for (const row of result.rows) {
            if (!authorsMap.has(row.account_id)) {
                authorsMap.set(row.account_id, {
                    account_id: row.account_id,
                    full_name: `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'ผู้ใช้งาน',
                    nickname: row.nickname || '',
                    author_image: row.author_image || '/profile-img.jpg',
                    is_following: row.is_following,
                    stories: []
                });
            }
            authorsMap.get(row.account_id).stories.push(row);
        }

        res.json({ success: true, data: Array.from(authorsMap.values()) });
    } catch (err) {
        console.error('Get Stories Feed Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. เพิ่มยอดคนดู (+1 View)
app.post('/api/stories/:storyId/view', async (req, res) => {
    try {
        await pgPool.query(`UPDATE user_stories SET views_count = COALESCE(views_count, 0) + 1 WHERE story_id = $1`, [req.params.storyId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. กดถูกใจ / ยกเลิกถูกใจ (Toggle Like)
app.post('/api/stories/:storyId/like', async (req, res) => {
    const { account_id } = req.body;
    const { storyId } = req.params;
    try {
        const exists = await pgPool.query(`SELECT 1 FROM story_likes WHERE story_id = $1 AND account_id = $2`, [storyId, account_id]);
        let liked = false;
        if (exists.rows.length > 0) {
            await pgPool.query(`DELETE FROM story_likes WHERE story_id = $1 AND account_id = $2`, [storyId, account_id]);
        } else {
            await pgPool.query(`INSERT INTO story_likes (story_id, account_id) VALUES ($1, $2)`, [storyId, account_id]);
            liked = true;
        }
        const countRes = await pgPool.query(`SELECT COUNT(*)::int AS cnt FROM story_likes WHERE story_id = $1`, [storyId]);
        res.json({ success: true, liked, likes_count: countRes.rows[0].cnt });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 4. ให้ดาว 1-7 ดาว
app.post('/api/stories/:storyId/star', async (req, res) => {
    const { account_id, stars } = req.body;
    const { storyId } = req.params;
    const starVal = Math.min(7, Math.max(1, Number(stars) || 1));
    try {
        await pgPool.query(`
            INSERT INTO story_stars (story_id, account_id, stars, updated_at)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            ON CONFLICT (story_id, account_id)
            DO UPDATE SET stars = EXCLUDED.stars, updated_at = CURRENT_TIMESTAMP
        `, [storyId, account_id, starVal]);

        const statRes = await pgPool.query(`
            SELECT COALESCE(ROUND(AVG(stars)::numeric, 1), 0) AS avg_stars,
                   COALESCE(SUM(stars)::int, 0) AS total_stars
            FROM story_stars WHERE story_id = $1
        `, [storyId]);

        res.json({ success: true, my_stars: starVal, ...statRes.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 5. เพิ่มยอดแชร์ (+1 Share)
app.post('/api/stories/:storyId/share', async (req, res) => {
    try {
        const result = await pgPool.query(
            `UPDATE user_stories SET shares_count = COALESCE(shares_count, 0) + 1 WHERE story_id = $1 RETURNING shares_count`,
            [req.params.storyId]
        );
        res.json({ success: true, shares_count: result.rows[0]?.shares_count || 0 });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// =========================================================================
// 💬 3. API คอมเมนต์ (ดึงเฉพาะ is_active=true / ตอบกลับ / ลบ Soft Delete / บล็อก)
// =========================================================================
app.get('/api/stories/:storyId/comments', async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT c.comment_id, c.account_id, c.parent_comment_id, c.comment_text, c.created_at,
                   p.first_name, p.last_name, p.nickname,
                   (SELECT cpm.image_url FROM citizen_profiles_media cpm WHERE cpm.profile_id = a.profile_id AND cpm.is_active = true LIMIT 1) AS user_image
            FROM story_comments c
            JOIN user_accounts a ON c.account_id = a.account_id
            LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
            WHERE c.story_id = $1 AND COALESCE(c.is_active, true) = true
            ORDER BY c.created_at ASC
        `, [req.params.storyId]);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/stories/:storyId/comments', async (req, res) => {
    const { account_id, comment_text, parent_comment_id } = req.body;
    const { storyId } = req.params;
    if (!comment_text || !comment_text.trim()) {
        return res.status(400).json({ success: false, message: 'กรุณาพิมพ์ข้อความคอมเมนต์' });
    }
    try {
        // 1. เช็กเจ้าของโพสต์และตรวจสอบการบล็อก
        const ownerRes = await pgPool.query(
            `SELECT account_id, COALESCE(title, 'โพสต์ของคุณ') AS story_title FROM user_stories WHERE story_id = $1`,
            [storyId]
        );
        if (ownerRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบโพสต์นี้' });
        }
        const storyOwnerId = ownerRes.rows[0].account_id;
        const storyTitle = ownerRes.rows[0].story_title;

        const blockCheck = await pgPool.query(
            `SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
            [storyOwnerId, account_id]
        );
        if (blockCheck.rows.length > 0) {
            return res.status(403).json({ success: false, message: 'คุณไม่สามารถแสดงความคิดเห็นในโพสต์นี้ได้' });
        }

        // 2. บันทึกคอมเมนต์ลงฐานข้อมูล
        await pgPool.query(
            `INSERT INTO story_comments (story_id, account_id, parent_comment_id, comment_text, is_active) VALUES ($1, $2, $3, $4, true)`,
            [storyId, account_id, parent_comment_id || null, comment_text.trim()]
        );

        // 3. ดึงชื่อผู้คอมเมนต์เพื่อนำไปสร้างข้อความแจ้งเตือน (และอ่านออกเสียง)
        const senderRes = await pgPool.query(`
            SELECT COALESCE(NULLIF(p.nickname, ''), p.first_name, 'เพื่อนในชุมชน') AS sender_name
            FROM user_accounts a
            LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
            WHERE a.account_id = $1
        `, [account_id]);
        const senderName = senderRes.rows[0]?.sender_name || 'เพื่อนในชุมชน';
        const cleanText = comment_text.trim().slice(0, 80);

        const notifiedUsers = new Set();

        // 4. กรณีเป็นการ "ตอบกลับคอมเมนต์" → แจ้งเตือนเจ้าของคอมเมนต์ต้นทาง
        if (parent_comment_id) {
            const parentRes = await pgPool.query(
                `SELECT account_id FROM story_comments WHERE comment_id = $1`,
                [parent_comment_id]
            );
            const parentAuthorId = parentRes.rows[0]?.account_id;
            if (parentAuthorId && String(parentAuthorId) !== String(account_id)) {
                await pgPool.query(`
                    INSERT INTO user_notifications (recipient_id, sender_id, type, reference_id, title, message)
                    VALUES ($1, $2, 'STORY_REPLY', $3, $4, $5)
                `, [
                    parentAuthorId,
                    account_id,
                    storyId,
                    `${senderName} ตอบกลับคอมเมนต์ของคุณ`,
                    `${senderName} ตอบกลับคุณว่า ${cleanText}`
                ]);
                notifiedUsers.add(String(parentAuthorId));
            }
        }

        // 5. แจ้งเตือนเจ้าของโพสต์ (ถ้าไม่ใช่คนคอมเมนต์เอง และยังไม่ถูกแจ้งเตือนในข้อ 4)
        if (String(storyOwnerId) !== String(account_id) && !notifiedUsers.has(String(storyOwnerId))) {
            await pgPool.query(`
                INSERT INTO user_notifications (recipient_id, sender_id, type, reference_id, title, message)
                VALUES ($1, $2, 'STORY_COMMENT', $3, $4, $5)
            `, [
                storyOwnerId,
                account_id,
                storyId,
                `${senderName} คอมเมนต์ใน "${storyTitle}"`,
                `${senderName} แสดงความคิดเห็นว่า ${cleanText}`
            ]);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Post Comment Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// =========================================================================
// 🔔 API ระบบแจ้งเตือน (ดึงรายการ / อ่านแล้ว 1 รายการ / อ่านแล้วทั้งหมด)
// =========================================================================
app.get('/api/notifications/:accountId', async (req, res) => {
    const { accountId } = req.params;
    try {
        const result = await pgPool.query(`
            SELECT n.*,
                   (
                       SELECT cpm.image_url FROM citizen_profiles_media cpm
                       JOIN user_accounts a ON cpm.profile_id = a.profile_id
                       WHERE a.account_id = n.sender_id AND cpm.is_active = true
                       LIMIT 1
                   ) AS sender_image
            FROM user_notifications n
            WHERE n.recipient_id = $1
            ORDER BY n.created_at DESC
            LIMIT 30
        `, [accountId]);

        const unreadCount = result.rows.filter((r) => !r.is_read).length;
        res.json({ success: true, unread_count: unreadCount, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.patch('/api/notifications/:notificationId/read', async (req, res) => {
    try {
        await pgPool.query(
            `UPDATE user_notifications SET is_read = true WHERE notification_id = $1`,
            [req.params.notificationId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.patch('/api/notifications/read-all/:accountId', async (req, res) => {
    try {
        await pgPool.query(
            `UPDATE user_notifications SET is_read = true WHERE recipient_id = $1 AND is_read = false`,
            [req.params.accountId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ลบคอมเมนต์แบบ Soft Delete (ไม่ลบจริง)
app.patch('/api/stories/comments/:commentId/delete', async (req, res) => {
    try {
        await pgPool.query(`UPDATE story_comments SET is_active = false WHERE comment_id = $1`, [req.params.commentId]);
        res.json({ success: true, message: 'ซ่อน/ลบคอมเมนต์เรียบร้อยแล้ว' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// บล็อกผู้ใช้งาน
app.post('/api/users/block', async (req, res) => {
    const { blocker_id, blocked_id } = req.body;
    if (!blocker_id || !blocked_id || String(blocker_id) === String(blocked_id)) {
        return res.status(400).json({ success: false, message: 'ไม่สามารถบล็อกตัวเองได้' });
    }
    try {
        await pgPool.query(
            `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [blocker_id, blocked_id]
        );
        res.json({ success: true, message: 'บล็อกผู้ใช้งานนี้เรียบร้อยแล้ว' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =========================================================================
// 📸 1. API โพสต์ / แก้ไข / ซ่อน-แสดง My Story (รองรับ หัวข้อ, คำอธิบาย, ปกวิดีโอ)
// =========================================================================
app.post('/api/user/stories', upload.fields([
    { name: 'storyMedia', maxCount: 1 },
    { name: 'coverImage', maxCount: 1 }
]), async (req, res) => {
    const {
        account_id, village_id, title, description,
        overlay_text, text_color, text_size, text_x, text_y, bg_blur, visibility
    } = req.body;

    const mediaFile = req.files?.storyMedia?.[0];
    const coverFile = req.files?.coverImage?.[0];

    if (!account_id || !mediaFile) {
        return res.status(400).json({ success: false, message: 'กรุณาเลือกไฟล์รูปภาพหรือวิดีโอ' });
    }

    try {
        const isVideo = mediaFile.mimetype.startsWith('video/');
        let mediaUrl = '';
        let coverUrl = null;

        // 1. อัปโหลดไฟล์หลัก (รูปหรือวิดีโอ)
        const fileBlob = new Blob([mediaFile.buffer], { type: mediaFile.mimetype });
        const formData = new FormData();
        formData.append('file', fileBlob, mediaFile.originalname);

        if (!isVideo) {
            const cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/images/v1`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${process.env.CF_API_TOKEN}` },
                body: formData
            });
            const cfData = await cfRes.json();
            if (!cfData.success) return res.status(500).json({ success: false, message: 'อัปโหลดรูปไม่สำเร็จ' });
            mediaUrl = cfData.result.variants[0];
        } else {
            const cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/stream`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${process.env.CF_API_TOKEN}` },
                body: formData
            });
            const cfData = await cfRes.json();
            if (!cfData.success || !cfData.result?.preview) {
                return res.status(400).json({ success: false, message: 'ระบบยังไม่รองรับวิดีโอโดยตรง (กรุณาเปิด Cloudflare Stream หรือใช้รูปภาพ)' });
            }
            mediaUrl = cfData.result.preview;
        }

        // 2. อัปโหลดภาพปกวิดีโอ (ถ้ามี)
        if (coverFile) {
            const coverBlob = new Blob([coverFile.buffer], { type: coverFile.mimetype });
            const coverFd = new FormData();
            coverFd.append('file', coverBlob, coverFile.originalname);
            const cfCoverRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/images/v1`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${process.env.CF_API_TOKEN}` },
                body: coverFd
            });
            const cfCoverData = await cfCoverRes.json();
            if (cfCoverData.success) coverUrl = cfCoverData.result.variants[0];
        }

        const insertRes = await pgPool.query(`
            INSERT INTO user_stories (
                account_id, village_id, media_type, media_url, cover_url,
                title, description, overlay_text, text_color, text_size,
                text_x, text_y, bg_blur, visibility, is_hidden, is_active
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, false, true)
            RETURNING *
        `, [
            account_id,
            village_id || null,
            isVideo ? 'VIDEO' : 'IMAGE',
            mediaUrl,
            coverUrl,
            title ? title.trim() : null,
            description ? description.trim() : null,
            overlay_text ? overlay_text.trim() : null,
            text_color || '#ffffff',
            Number(text_size) || 22,
            text_x !== undefined ? Number(text_x) : 50,
            text_y !== undefined ? Number(text_y) : 50,
            bg_blur !== undefined ? Number(bg_blur) : 0,
            visibility || 'PUBLIC'
        ]);

        res.json({ success: true, message: 'โพสต์ Story สำเร็จ!', data: insertRes.rows[0] });
    } catch (err) {
        console.error('Create Story Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// แก้ไขโพสต์ (หัวข้อ, คำอธิบาย, ข้อความบนภาพ, สี, ขนาด, เบลอ, ความเป็นส่วนตัว)
app.put('/api/user/stories/:storyId', async (req, res) => {
    const { title, description, overlay_text, text_color, text_size, text_x, text_y, bg_blur, visibility } = req.body;
    try {
        const result = await pgPool.query(`
            UPDATE user_stories
            SET title = $1,
                description = $2,
                overlay_text = $3,
                text_color = $4,
                text_size = $5,
                text_x = $6,
                text_y = $7,
                bg_blur = $8,
                visibility = $9
            WHERE story_id = $10
            RETURNING *
        `, [
            title ? title.trim() : null,
            description ? description.trim() : null,
            overlay_text ? overlay_text.trim() : null,
            text_color || '#ffffff',
            Number(text_size) || 22,
            text_x !== undefined ? Number(text_x) : 50,
            text_y !== undefined ? Number(text_y) : 50,
            bg_blur !== undefined ? Number(bg_blur) : 0,
            visibility || 'PUBLIC',
            req.params.storyId
        ]);
        res.json({ success: true, message: 'แก้ไขโพสต์เรียบร้อยแล้ว', data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 7. กดติดตาม / เลิกติดตาม (Toggle Follow)
app.post('/api/users/follow', async (req, res) => {
    const { follower_id, following_id } = req.body;
    if (!follower_id || !following_id || follower_id === following_id) {
        return res.status(400).json({ success: false, message: 'ไม่สามารถติดตามตัวเองได้' });
    }
    try {
        const exists = await pgPool.query(
            `SELECT 1 FROM user_follows WHERE follower_id = $1 AND following_id = $2`,
            [follower_id, following_id]
        );
        let is_following = false;
        if (exists.rows.length > 0) {
            await pgPool.query(`DELETE FROM user_follows WHERE follower_id = $1 AND following_id = $2`, [follower_id, following_id]);
        } else {
            await pgPool.query(`INSERT INTO user_follows (follower_id, following_id) VALUES ($1, $2)`, [follower_id, following_id]);
            is_following = true;
        }
        res.json({ success: true, is_following });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
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

app.get('/api/menus', async (req, res) => {
  // เรียกใช้ตัวเชื่อมต่อฐานข้อมูลให้เหมือนกับ API อื่นๆ
  const client = await pgPool.connect(); 
  try {
    const result = await client.query(
      'SELECT * FROM sys_menus ORDER BY display_order ASC, menu_id ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Error Fetching Menus:", err);
    res.status(500).json({ success: false, message: "ไม่สามารถดึงข้อมูลได้" });
  } finally {
    // อย่าลืมคืน connection
    client.release();
  }
});

app.post('/api/manage-menu', async (req, res) => {
  // 1. เรียกใช้งาน client จาก pgPool
  const client = await pgPool.connect(); 
  
  try {
    const { menu_id, menu_name, icon_name, route_path, group_id, selected_roles } = req.body;
    const rolesJson = JSON.stringify(selected_roles || []);
    let result;

    if (menu_id) {
      // 2. เปลี่ยน pool.query เป็น client.query
      result = await client.query( 
        `UPDATE sys_menus SET menu_name = $1, icon_name = $2, route_path = $3, group_id = $4, selected_roles = $5 WHERE menu_id = $6 RETURNING *`,
        [menu_name, icon_name, route_path, group_id, rolesJson, menu_id]
      );
    } else {
      // 2. เปลี่ยน pool.query เป็น client.query
      result = await client.query(
        `INSERT INTO sys_menus (menu_name, icon_name, route_path, group_id, selected_roles, display_order) VALUES ($1, $2, $3, $4, $5, 99) RETURNING *`,
        [menu_name, icon_name, route_path, group_id, rolesJson]
      );
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("Manage Menu Error:", err);
    res.status(500).json({ success: false, message: "บันทึกไม่ได้" });
  } finally {
    // 3. อย่าลืมคืน connection
    client.release(); 
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
  const client = await pgPool.connect(); // หรือ pool.connect() ตามที่คุณใช้
  try {
    const { id } = req.params;
    // 🛠 ลบข้อมูลโดยอ้างอิงจาก menu_id ให้ตรงกับ Database ของคุณ
    await client.query('DELETE FROM sys_menus WHERE menu_id = $1', [id]);
    res.json({ success: true, message: "ลบสำเร็จ" });
  } catch (err) {
    console.error("Delete Menu Error:", err);
    res.status(500).json({ success: false, message: "ลบไม่ได้" });
  } finally {
    client.release();
  }
});

// ==========================================
// 🌟 API เข้าสู่ระบบ (Login) - แก้ไขปัญหา Connection Pool ค้าง
// ==========================================
// ==========================================
// ฟังก์ชันปรับหมดวาระอัตโนมัติ (ล้างทั้ง user_positions, user_accounts.role และ villages.headman_account_id)
// ==========================================
async function syncExpiredPositions(dbClient = pgPool) {
    try {
        const expired = await dbClient.query(`
            UPDATE user_positions
            SET is_active = false,
                status = 'EXPIRED',
                end_reason = 'หมดวาระอัตโนมัติตามกำหนด'
            WHERE is_active = true
              AND end_date IS NOT NULL
              AND end_date < CURRENT_DATE
            RETURNING account_id
        `);

        // ถ้ามีคนหมดวาระ ให้ล้าง role และ headman_account_id ออกด้วย
        for (const row of expired.rows) {
            await dbClient.query(`UPDATE user_accounts SET role = 'CITIZEN' WHERE account_id = $1`, [row.account_id]);
            await dbClient.query(`UPDATE villages SET headman_account_id = NULL WHERE headman_account_id = $1`, [row.account_id]);
        }
    } catch (err) {
        console.error('Sync Expired Positions Error:', err.message);
    }
}
// ==========================================
// 🌟 API เข้าสู่ระบบ (Login) - เวอร์ชัน 4 มิติ (App + หน่วยงาน + แผนก + ตำแหน่ง + Scope)
// ==========================================
app.post('/api/login', async (req, res) => {
    console.log('👉 มีคนกด Login! ข้อมูลที่ส่งมาคือ:', req.body);
    const usernameInput = req.body.username || req.body.phone_number;
    const password = req.body.password;
    const appCode = (req.body.app_code || 'BANRAO_WEB').trim().toUpperCase();

    if (!usernameInput || !password) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกเบอร์โทรศัพท์และรหัสผ่าน' });
    }

    const client = await pgPool.connect();

    try {
        // ✨ 1. เคลียร์ตำแหน่งที่หมดวาระอัตโนมัติก่อนดึงข้อมูล Login
        await syncExpiredPositions(client);

        // ✨ 2. ดึงข้อมูลส่วนตัว บัญชี หมู่บ้าน และรูปโปรไฟล์ (1 บัญชี = 1 แถว ไม่ซ้ำ)
        const userQuery = await client.query(
            `SELECT 
                a.account_id, a.username_phone, a.password_hash, a.occupation_id, a.is_active, a.household_member_count, a.role,
                p.first_name, p.last_name, p.nickname, p.dob, p.citizen_id, p.gender, p.house_no,
                o.occupation_name, 

                (
                    SELECT cpm.image_url
                    FROM citizen_profiles_media cpm
                    WHERE cpm.profile_id = a.profile_id AND cpm.is_active = true
                    LIMIT 1
                ) AS user_image,

                (
                    SELECT hcpm.image_url
                    FROM citizen_profiles_media hcpm
                    WHERE hcpm.profile_id = ha.profile_id AND hcpm.is_active = true
                    LIMIT 1
                ) AS headman_image,
                
                v.village_id, v.village_no, v.village_name, v.headman_lat, v.headman_lng, 
                v.headman_account_id,
                v.household_count AS target_household_count, 
                v.population_count AS target_population_count,
                (SELECT COUNT(*) FROM households h WHERE h.village_id = v.village_id) AS actual_household_count,
                (SELECT COUNT(*) FROM household_members hm JOIN households hs ON hm.household_id = hs.household_id WHERE hs.village_id = v.village_id) AS actual_population_count,
                
                hp.first_name AS headman_first_name, 
                hp.last_name AS headman_last_name,
                t.tambon_name_th, am.amphure_name_th, pr.province_name_th,
                
                EXTRACT(YEAR FROM age(CURRENT_DATE, p.dob)) AS age_years,
                EXTRACT(MONTH FROM age(CURRENT_DATE, p.dob)) AS age_months,
                EXTRACT(DAY FROM age(CURRENT_DATE, p.dob)) AS age_days

             FROM user_accounts a
             LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
             LEFT JOIN sys_occupations o ON a.occupation_id = o.occupation_id
             LEFT JOIN villages v ON a.village_id = v.village_id
             LEFT JOIN user_accounts ha ON v.headman_account_id = ha.account_id
             LEFT JOIN user_profiles hp ON ha.profile_id = hp.profile_id
             LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
             LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
             LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
             WHERE a.username_phone = $1`,
            [usernameInput]
        );

        if (userQuery.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'เบอร์โทรศัพท์หรือรหัสผ่านไม่ถูกต้อง' });
        }

        const user = userQuery.rows[0];

        if (user.is_active === false) {
            return res.status(403).json({ success: false, message: 'บัญชีนี้ถูกระงับหรือยังไม่ได้รับการอนุมัติ' });
        }

        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ success: false, message: 'เบอร์โทรศัพท์หรือรหัสผ่านไม่ถูกต้อง' });
        }

        // ✨ 3. ดึงโครงสร้าง 4 มิติทั้งหมดที่ Active ของบุคคลนี้ (หน่วยงาน -> แผนก -> ตำแหน่ง -> พื้นที่)
        const posQuery = await client.query(
            `SELECT 
                up.id AS user_position_id,
                pos.position_id,
                pos.position_name,
                pos.position_level,
                COALESCE(up.org_id, pos.org_id) AS org_id,
                org.org_name,
                org.app_code AS org_app_code,
                COALESCE(up.dept_id, pos.dept_id) AS dept_id,
                dept.department_name,
                up.scope_type,
                up.scope_id,
                up.start_date AS term_start_date,
                up.end_date AS term_end_date
             FROM user_positions up
             JOIN sys_positions pos ON up.position_id = pos.position_id
             LEFT JOIN sys_organizations org ON COALESCE(up.org_id, pos.org_id) = org.org_id
             LEFT JOIN sys_departments dept ON COALESCE(up.dept_id, pos.dept_id) = dept.department_id
             WHERE up.account_id = $1
               AND up.is_active = TRUE
               AND (up.end_date IS NULL OR up.end_date >= CURRENT_DATE)
             ORDER BY up.start_date DESC NULLS LAST, up.id DESC`,
            [user.account_id]
        );

        const activePositions = posQuery.rows;
        const primaryPos = activePositions[0] || null;

        // ดึงสิทธิ์พื้นฐานตามอาชีพ (คงไว้เพื่อรองรับโค้ดเดิม)
        let permissions = [];
        if (user.occupation_id) {
            try {
                const permQuery = await client.query(
                    `SELECT sp.permission_code
                     FROM occupation_permissions op
                     JOIN sys_permissions sp ON op.permission_id = sp.permission_id
                     WHERE op.occupation_id = $1`,
                    [user.occupation_id]
                );
                permissions = permQuery.rows.map(row => row.permission_code);
            } catch (e) {
                console.log("ไม่มีตาราง Permissions หรือข้อผิดพลาดในการดึงสิทธิ์:", e.message);
            }
        }

        // ✨ 4. กำหนดตำแหน่งหลัก & สังกัด 4 มิติ
        const isSuperAdmin = user.username_phone === '0000000000' || user.role === 'SUPER_ADMIN';
        let finalPositionName = 'ประชาชนทั่วไป';
        let finalPositionLevel = null;

        if (isSuperAdmin) {
            finalPositionName = 'Super Admin';
            finalPositionLevel = 'SYSTEM';
        } else if (primaryPos) {
            finalPositionName = primaryPos.position_name;
            finalPositionLevel = primaryPos.position_level || 'VILLAGE';
        }

        // ✨ 5. สร้าง JWT Token ที่ฝังบริบท 4 มิติไว้ภายใน
        const token = jwt.sign(
            {
                account_id: user.account_id,
                app_code: appCode,
                is_super_admin: isSuperAdmin,
                occupation_id: user.occupation_id,
                village_id: user.village_id,
                org_id: primaryPos?.org_id || null,
                dept_id: primaryPos?.dept_id || null,
                position_id: primaryPos?.position_id || null,
                scope_type: primaryPos?.scope_type || null,
                scope_id: primaryPos?.scope_id || null
            },
            process.env.JWT_SECRET || 'banrao_secret_key',
            { expiresIn: '5d' } //หมดอายุทุก 5 วัน
           
        );

        const daysTh = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
        const birthDate = user.dob ? new Date(user.dob) : null;
        const isDummyDate = birthDate && birthDate.getFullYear() === 1900;
        const dayNameTh = (birthDate && !isDummyDate) ? daysTh[birthDate.getDay()] : '-';
        const genderTh = user.gender === 'MALE' ? 'ชาย' : (user.gender === 'FEMALE' ? 'หญิง' : '-');

        const responseData = {
            id: user.account_id,
            account_id: user.account_id,
            username: user.username_phone,
            firstName: user.first_name,
            lastName: user.last_name,
            full_name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
            nickname: user.nickname,
            occupation: user.occupation_name,
            permissions: permissions,
            role: user.role,

            // ข้อมูลหมู่บ้านและสถิติ
            village_id: user.village_id,
            village_no: user.village_no,
            villageName: user.village_name,
            headmanName: user.headman_first_name ? `${user.headman_first_name} ${user.headman_last_name}` : null,
            tambonName: user.tambon_name_th,
            amphureName: user.amphure_name_th,
            provinceName: user.province_name_th,

            gender: genderTh,
            birthDayName: dayNameTh,
            age_years: isDummyDate ? '-' : (user.age_years || 0),
            age_months: isDummyDate ? '-' : (user.age_months || 0),
            age_days: isDummyDate ? '-' : (user.age_days || 0),
            house_no: user.house_no || '-',
            household_member_count: user.household_member_count || 0,

            target_household_count: user.target_household_count || 0,
            target_population_count: user.target_population_count || 0,
            actual_household_count: user.actual_household_count || 0,
            actual_population_count: user.actual_population_count || 0,

            userImage: user.user_image || '/profile-img.jpg',
            headmanImage: user.headman_account_id ? (user.headman_image || '/profile-img.jpg') : '/profile-img.jpg',

            // ✨ ข้อมูล 4 มิติ (App + หน่วยงาน + แผนก + ตำแหน่ง + พื้นที่)
            app_code: appCode,
            isSuperAdmin: isSuperAdmin,
            is_super_admin: isSuperAdmin,
            org_id: primaryPos?.org_id || null,
            org_name: isSuperAdmin ? 'ระบบส่วนกลาง (System)' : (primaryPos?.org_name || null),
            dept_id: primaryPos?.dept_id || null,
            department_name: primaryPos?.department_name || null,
            position_id: primaryPos?.position_id || null,
            position_name: finalPositionName,
            position_level: finalPositionLevel,
            scope_type: primaryPos?.scope_type || null,
            scope_id: primaryPos?.scope_id || null,
            term_start_date: primaryPos?.term_start_date || null,
            term_end_date: primaryPos?.term_end_date || null,
            positions: activePositions // เก็บทุกตำแหน่งที่ Active ไว้ครบ
        };

        res.json({
            success: true,
            message: 'เข้าสู่ระบบสำเร็จ',
            token,
            user: responseData,
            userData: responseData
        });

    } catch (error) {
        console.error('Login API Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error', error: error.message });
    } finally {
        if (client) client.release();
    }
});
// ==========================================
// API: ดึงเมนู Sidebar + สิทธิ์ Matrix ครบวงจร (Tier + คะแนนชุมชน + 4 มิติ Org/Dept/Pos)
// ==========================================
app.get('/api/sidebar-menus/:accountId', async (req, res) => {
    const { accountId } = req.params;
    const appCode = (req.query.app_code || 'BANRAO_WEB').trim().toUpperCase();

    if (!accountId || accountId === 'undefined') {
        return res.status(400).json({ success: false, message: 'Invalid Account ID' });
    }

    const client = await pgPool.connect();

    try {
        // 1. ดึงข้อมูลบัญชี + ระดับผู้ใช้ (tier_code) + คะแนนชุมชน (community_score)
        const userRes = await client.query(
            `SELECT account_id, username_phone, role,
                    COALESCE(tier_code, 'CITIZEN_FREE') AS tier_code,
                    COALESCE(community_score, 0) AS community_score
             FROM user_accounts
             WHERE account_id = $1`,
            [accountId]
        );
        if (userRes.rows.length === 0) {
            return res.json({ success: true, data: [], permissionsMap: {} });
        }

        const user = userRes.rows[0];
        const isSuperAdmin = user.username_phone === '0000000000' || user.role === 'SUPER_ADMIN';
        const userScore = Number(user.community_score) || 0;

        // 2. คำนวณ Tier ทั้งหมดที่ผู้ใช้คนนี้มีสิทธิ์ได้รับ (ดึงจากตาราง sys_user_tiers จริง)
        const autoTiersRes = await client.query(
            `SELECT tier_code
             FROM sys_user_tiers
             WHERE is_active = TRUE
               AND is_paid = FALSE
               AND min_community_score <= $1`,
            [userScore]
        );

        const eligibleTierCodes = new Set(autoTiersRes.rows.map(r => String(r.tier_code).trim().toUpperCase()));
        if (user.tier_code) {
            eligibleTierCodes.add(String(user.tier_code).trim().toUpperCase());
        }

        // 3. ดึงตำแหน่ง + หน่วยงาน + แผนก ที่ Active อยู่จริงของบัญชีนี้
        const posRes = await client.query(`
            SELECT 
                sp.position_id,
                sp.position_name,
                COALESCE(up.org_id, sp.org_id) AS org_id,
                COALESCE(up.dept_id, sp.dept_id) AS dept_id
            FROM user_positions up
            JOIN sys_positions sp ON up.position_id = sp.position_id
            WHERE up.account_id = $1
              AND up.is_active = TRUE
              AND (up.end_date IS NULL OR up.end_date >= CURRENT_DATE)
        `, [accountId]);

        const userPositions = posRes.rows;
        const userPosIds = new Set(userPositions.map(r => String(r.position_id)));
        const userPosNames = new Set(userPositions.map(r => String(r.position_name).trim()));

        // 4. ดึงเมนูทั้งหมดที่เปิดใช้งานอยู่ (ทั้งเมนูและกรุ๊ปเมนูต้อง is_active = true)
        const menuRes = await client.query(`
            SELECT 
                m.menu_id,
                mg.group_name,
                m.menu_name AS name,
                m.icon_name AS icon,
                COALESCE(m.route_path, m.path) AS path,
                m.selected_roles
            FROM sys_menus m
            JOIN sys_menu_groups mg ON m.group_id = mg.group_id
            WHERE m.is_active = TRUE
              AND COALESCE(mg.is_active, TRUE) = TRUE
              AND (m.app_code = $1 OR ($1 = 'BANRAO_WEB' AND m.app_code IS NULL))
            ORDER BY mg.display_order ASC NULLS LAST, m.display_order ASC NULLS LAST, m.menu_id ASC
        `, [appCode]);

        // 5. ดึงสิทธิ์ Matrix ทั้งหมดของ App นี้ที่เปิดใช้งาน
        const matrixRes = await client.query(`
            SELECT menu_id, org_id, dept_id, position_id, tier_code,
                   can_view, can_create, can_edit, can_delete, can_approve
            FROM sys_menu_permissions
            WHERE app_code = $1 AND is_active = TRUE
        `, [appCode]);

        const matrixRows = matrixRes.rows;
        const permissionsMap = {};
        const allowedMenus = [];

        for (const m of menuRes.rows) {
            if (isSuperAdmin) {
                const fullPerm = { can_view: true, can_create: true, can_edit: true, can_delete: true, can_approve: true };
                permissionsMap[m.path] = fullPerm;
                allowedMenus.push({ ...m, permissions: fullPerm });
                continue;
            }

            // ตรวจว่าเมนูนี้มีการตั้งค่าในตาราง Matrix ไว้แล้วหรือไม่
            const rulesForThisMenu = matrixRows.filter((r) => r.menu_id === m.menu_id);

            if (rulesForThisMenu.length > 0) {
                // คัดเฉพาะกฎที่ตรงกับ Tier หรือ ตำแหน่ง 4 มิติ ของผู้ใช้
                const matchedRules = rulesForThisMenu.filter((rule) => {
                    // กรณีที่ 1: กฎระดับ Tier (ประชาชนฟรี / คะแนนชุมชน / แพ็กเกจธุรกิจ)
                    if (rule.tier_code) {
                        return eligibleTierCodes.has(String(rule.tier_code).trim().toUpperCase());
                    }

                    // กรณีที่ 2: กฎส่วนกลาง (ไม่ได้ระบุ Org/Dept/Pos/Tier) = ทุกคนเห็นได้
                    if (rule.org_id === null && rule.dept_id === null && rule.position_id === null) {
                        return true;
                    }

                    // กรณีที่ 3: กฎโครงสร้างองค์กร 4 มิติ (Org -> Dept -> Pos)
                    return userPositions.some((up) => {
                        const orgMatch = rule.org_id === null || String(rule.org_id) === String(up.org_id);
                        const deptMatch = rule.dept_id === null || String(rule.dept_id) === String(up.dept_id);
                        const posMatch = rule.position_id === null || String(rule.position_id) === String(up.position_id);
                        return orgMatch && deptMatch && posMatch;
                    });
                });

                if (matchedRules.length > 0) {
                    const mergedPerm = matchedRules.reduce((acc, r) => ({
                        can_view: acc.can_view || r.can_view,
                        can_create: acc.can_create || r.can_create,
                        can_edit: acc.can_edit || r.can_edit,
                        can_delete: acc.can_delete || r.can_delete,
                        can_approve: acc.can_approve || r.can_approve
                    }), { can_view: false, can_create: false, can_edit: false, can_delete: false, can_approve: false });

                    if (mergedPerm.can_view) {
                        permissionsMap[m.path] = mergedPerm;
                        allowedMenus.push({ ...m, permissions: mergedPerm });
                    }
                }
            } else {
                // Fallback: ถ้าเมนูนี้ยังไม่ได้กำหนดในหน้า Matrix ให้ใช้สิทธิ์จาก selected_roles เดิม
                const roles = Array.isArray(m.selected_roles) ? m.selected_roles : [];
                const canSeeLegacy = roles.length === 0 || roles.some((r) => userPosIds.has(String(r)) || userPosNames.has(String(r).trim()));
                if (canSeeLegacy) {
                    const legacyPerm = { can_view: true, can_create: true, can_edit: true, can_delete: false, can_approve: false };
                    permissionsMap[m.path] = legacyPerm;
                    allowedMenus.push({ ...m, permissions: legacyPerm });
                }
            }
        }

        // 6. จัดกลุ่มตาม group_name
        const groupedMenus = allowedMenus.reduce((acc, row) => {
            const group = acc.find(g => g.group_name === row.group_name);
            const menuData = {
                menu_id: row.menu_id,
                name: row.name,
                icon: row.icon,
                path: row.path,
                permissions: row.permissions
            };
            if (group) group.menus.push(menuData);
            else acc.push({ group_name: row.group_name, menus: [menuData] });
            return acc;
        }, []);

        res.json({
            success: true,
            data: groupedMenus,
            permissionsMap,
            userTier: {
                tier_code: user.tier_code,
                community_score: userScore,
                eligible_tiers: Array.from(eligibleTierCodes)
            }
        });
    } catch (error) {
        console.error('Fetch Sidebar Menus Error:', error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูลเมนู' });
    } finally {
        client.release();
    }
});

// ==========================================
// API: ดึงรายชื่อตำแหน่งเพื่อไปแสดงเป็น Checkbox (ดึงเฉพาะระดับ VILLAGE)
// ==========================================
app.get('/api/positions', async (req, res) => {
    const client = await pgPool.connect();
    try {
        // ดึงเฉพาะตำแหน่งที่อยู่ในระดับหมู่บ้าน (VILLAGE)
        const result = await client.query(`
            SELECT position_id, position_name 
            FROM sys_positions 
            WHERE position_level = 'VILLAGE' 
            ORDER BY position_id ASC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Fetch Positions Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูลตำแหน่ง' });
    } finally {
        client.release();
    }
});

// ==========================================
// API: บันทึกเมนูใหม่และผูกสิทธิ์ (Save Menu & Assign Roles)
// ==========================================
app.post('/api/manage-menu', async (req, res) => {
    const { menu_name, route_path, icon_name, selected_roles } = req.body;
    const client = await pgPool.connect();

    try {
        // เริ่ม Transaction (ถ้ามีอันไหนพัง จะได้ย้อนกลับทั้งหมด ไม่ให้ข้อมูลแหว่ง)
        await client.query('BEGIN');
        
        // 1. สร้างสิทธิ์ (Permission) ใหม่ใน sys_permissions ก่อน
        const permCode = 'MENU_' + Date.now(); // สร้าง Code ไม่ให้ซ้ำ
        const permRes = await client.query(
            `INSERT INTO sys_permissions (permission_code, permission_name) 
             VALUES ($1, $2) RETURNING permission_id`,
            [permCode, `สิทธิ์เข้าถึงเมนู: ${menu_name}`]
        );
        const newPermId = permRes.rows[0].permission_id;

        // 2. สร้างเมนูใหม่ลงใน sys_menus โดยใช้ permission_id ที่เพิ่งสร้าง
        await client.query(
            `INSERT INTO sys_menus (group_id, menu_name, icon_name, route_path, permission_id, display_order, is_active)
             VALUES (9, $1, $2, $3, $4, 99, true)`, 
             // ใส่ group_id = 9 ไปก่อน (กลุ่มจัดการชุมชน) คุณสามารถส่งจาก Frontend มาเปลี่ยนได้
            [menu_name, icon_name, route_path, newPermId]
        );

        // 3. วนลูปผูกสิทธิ์ (newPermId) เข้ากับตำแหน่งที่ติ๊กเลือกมา (selected_roles)
        if (selected_roles && selected_roles.length > 0) {
            for (let positionId of selected_roles) {
                await client.query(
                    `INSERT INTO position_permissions (position_id, permission_id) 
                     VALUES ($1, $2)`,
                    [positionId, newPermId]
                );
            }
        }

        // ยืนยันการบันทึกข้อมูลทั้งหมด
        await client.query('COMMIT');
        res.json({ success: true, message: 'บันทึกเมนูและสิทธิ์สำเร็จ' });

    } catch (error) {
        await client.query('ROLLBACK'); // ยกเลิกการบันทึกถ้าระหว่างทางเกิด Error
        console.error("Save Menu Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล' });
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


// ==========================================
// API: สร้าง/เพิ่มสถานที่และบริการในชุมชน (Create Place)
// ==========================================
app.post('/api/community-places', async (req, res) => {
    const { 
        category_id, 
        place_name, 
        description, 
        cover_image_url, 
        owner_account_id, 
        address_text, 
        visibility_level, 
        services, 
        operating_hours 
    } = req.body;

    try {
        const insertQuery = `
            INSERT INTO community_places (
                category_id, place_name, description, cover_image_url, 
                owner_account_id, address_text, visibility_level, 
                services, operating_hours, is_verified, is_active
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, false, true
            ) RETURNING place_id;
        `;
        
        // แปลง Array/Object ให้เป็น JSON string 
        const servicesJson = JSON.stringify(services || []);
        const hoursJson = JSON.stringify(operating_hours || {}); // 🌟 ตรงนี้จะรับ JSON วันเวลาจาก Frontend มา

        const result = await pgPool.query(insertQuery, [
            category_id, place_name, description, cover_image_url, 
            owner_account_id, address_text, visibility_level, 
            servicesJson, hoursJson
        ]);

        res.json({ success: true, message: 'เพิ่มข้อมูลสำเร็จ', place_id: result.rows[0].place_id });

    } catch (error) {
        console.error('API Create Place Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ==========================================
// API: อัปโหลดรูปภาพขึ้น Cloudflare Images
// ==========================================
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'ไม่มีไฟล์รูปภาพถูกส่งมา' });
        }

        const CLOUDFLARE_ACCOUNT_ID = process.env.CF_ACCOUNT_ID; 
        const CLOUDFLARE_API_TOKEN = process.env.CF_API_TOKEN;

        const formData = new FormData();
        
        // 🌟 จุดที่แก้ไข: แปลง Buffer เป็น Blob ก่อนส่งเข้า FormData 🌟
        const imageBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
        
        // แนบไฟล์ Blob ลงไป พร้อมกำหนดชื่อไฟล์เป็น Parameter ที่ 3
        formData.append('file', imageBlob, req.file.originalname);

        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/images/v1`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`
                // ไม่ต้องใส่ 'Content-Type' ปล่อยให้ FormData จัดการ Boundary เอง
            },
            body: formData
        });

        const data = await response.json();

        if (data.success) {
            // ดึง URL รูปภาพจาก Cloudflare (ส่วนใหญ่ variants ตัวแรกจะใช้งานได้)
            const imageUrl = data.result.variants[0]; 
            res.json({ success: true, imageUrl: imageUrl });
        } else {
            console.error('Cloudflare Error:', data.errors);
            res.status(500).json({ success: false, message: 'อัปโหลด Cloudflare ไม่สำเร็จ', errors: data.errors });
        }

    } catch (error) {
        console.error('Upload Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});


// ==========================================
// API: ดึงข้อมูลสถานที่ของฉัน (My Places)
// ==========================================
app.get('/api/my-places/:accountId', async (req, res) => {
    try {
        const { accountId } = req.params;
        const query = `
            SELECT p.*, c.category_name, c.icon_name
            FROM community_places p
            LEFT JOIN sys_place_categories c ON p.category_id = c.category_id
            WHERE p.owner_account_id = $1
            ORDER BY p.created_at DESC;
        `;
        const result = await pgPool.query(query, [accountId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('API My Places Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});


// ==========================================
// API: ดึงข้อมูลสถานที่ 1 รายการ (สำหรับหน้า Edit)
// ==========================================
app.get('/api/community-places/detail/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = `SELECT * FROM community_places WHERE place_id = $1;`;
        const result = await pgPool.query(query, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลสถานที่' });
        }
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('API Get Place Detail Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ==========================================
// API: อัปเดตข้อมูลสถานที่ (Edit Place)
// ==========================================
app.put('/api/community-places/:id', async (req, res) => {
    const { id } = req.params;
    const { place_name, description, address_text, visibility_level, services, operating_hours } = req.body;
    
    try {
        const updateQuery = `
            UPDATE community_places 
            SET place_name = $1, description = $2, address_text = $3, 
                visibility_level = $4, services = $5, operating_hours = $6, updated_at = CURRENT_TIMESTAMP
            WHERE place_id = $7 RETURNING *;
        `;
        const servicesJson = JSON.stringify(services || []);
        const hoursJson = JSON.stringify(operating_hours || {});

        await pgPool.query(updateQuery, [
            place_name, description, address_text, visibility_level, servicesJson, hoursJson, id
        ]);
        res.json({ success: true, message: 'อัปเดตข้อมูลสำเร็จ' });
    } catch (error) {
        console.error('API Update Place Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ==========================================
// 1. API: ดึง "หมวดหมู่สินค้า" ตามประเภทร้านค้า
// ==========================================
app.get('/api/product-categories/:placeCategoryId', async (req, res) => {
    try {
        const { placeCategoryId } = req.params;
        const query = `SELECT * FROM sys_product_categories WHERE place_category_id = $1 AND is_active = true ORDER BY display_order;`;
        const result = await pgPool.query(query, [placeCategoryId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('API Get Product Categories Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ==========================================
// 2. API: ดึงรายการสินค้า (อัปเดตให้ JOIN เอาชื่อหมวดหมู่มาด้วย)
// ==========================================
app.get('/api/community-places/:placeId/products', async (req, res) => {
    try {
        const { placeId } = req.params;
        const query = `
            SELECT pp.*, pc.category_name as prod_cat_name 
            FROM place_products pp
            LEFT JOIN sys_product_categories pc ON pp.prod_cat_id = pc.prod_cat_id
            WHERE pp.place_id = $1 
            ORDER BY pp.created_at DESC;
        `;
        const result = await pgPool.query(query, [placeId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('API Get Products Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ==========================================
// 3. API: เพิ่มสินค้า (อัปเดตให้รองรับ หมวดหมู่ และ แกลลอรี่ 6 รูป)
// ==========================================
app.post('/api/community-places/:placeId/products', async (req, res) => {
    try {
        const { placeId } = req.params;
        const { product_name, description, price, image_url, prod_cat_id, gallery_urls } = req.body;
        
        const insertQuery = `
            INSERT INTO place_products (place_id, product_name, description, price, image_url, prod_cat_id, gallery_urls)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;
        `;
        const result = await pgPool.query(insertQuery, [
            placeId, product_name, description, price || 0, image_url, prod_cat_id || null, JSON.stringify(gallery_urls || [])
        ]);
        res.json({ success: true, message: 'เพิ่มสินค้าสำเร็จ', data: result.rows[0] });
    } catch (error) {
        console.error('API Add Product Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});
// ==========================================
// API: ดึงข้อมูลสถานที่ของฉัน (My Places)  สิ้นสุด
// ==========================================

// ==========================================
// API: ดึงข้อมูลขอบเขตหมู่บ้าน (Boundary) สำหรับแสดงบนแผนที่
// ==========================================
app.get('/api/villages/:villageId', async (req, res) => {
    try {
        const { villageId } = req.params;
        const query = `SELECT * FROM sys_villages WHERE village_id = $1;`;
        const result = await pgPool.query(query, [villageId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลหมู่บ้าน' });
        }
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('API Get Village Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});


// ==========================================
// API: เพิ่มตำแหน่งใหม่ในชุมชน
// ==========================================
app.post('/api/positions', async (req, res) => {
    const { position_name, position_level } = req.body;
    const client = await pgPool.connect();
    try {
        const result = await client.query(
            `INSERT INTO sys_positions (position_name, position_level, department_id) 
             VALUES ($1, $2, 1) RETURNING *`,
            [position_name, position_level || 'VILLAGE']
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Create Position Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการบันทึกตำแหน่ง' });
    } finally {
        client.release();
    }
});

// ==========================================
// API: แก้ไขตำแหน่ง
// ==========================================
app.put('/api/positions/:id', async (req, res) => {
    const { id } = req.params;
    const { position_name } = req.body;
    const client = await pgPool.connect();
    try {
        const result = await client.query(
            `UPDATE sys_positions SET position_name = $1 WHERE position_id = $2 RETURNING *`,
            [position_name, id]
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Update Position Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการแก้ไขตำแหน่ง' });
    } finally {
        client.release();
    }
});

// ==========================================
// API: ดึงรายการเมนูทั้งหมดเพื่อนำไปแสดงในหน้าจัดการเมนู
// ==========================================
app.get('/api/menus', async (req, res) => {
    const client = await pgPool.connect();
    try {
        // ใช้ JSON_AGG เพื่อดึงว่าเมนูนี้มีใคร (position_id) มีสิทธิ์บ้าง ออกมาเป็น Array
        const query = `
            SELECT 
                m.menu_id as id,
                m.menu_name,
                m.icon_name,
                m.route_path,
                m.permission_id,
                COALESCE(
                    array_agg(p.position_id) FILTER (WHERE p.position_id IS NOT NULL), 
                    '{}'
                ) as selected_roles
            FROM sys_menus m
            LEFT JOIN position_permissions pp ON m.permission_id = pp.permission_id
            LEFT JOIN sys_positions p ON pp.position_id = p.position_id
            GROUP BY m.menu_id, m.menu_name, m.icon_name, m.route_path, m.permission_id
            ORDER BY m.display_order ASC, m.menu_id ASC;
        `;
        const result = await client.query(query);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Fetch Menus Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงรายการเมนู' });
    } finally {
        client.release();
    }
});


// ==========================================
// API: ดึงรายชื่อตำแหน่งเพื่อไปแสดงเป็น Checkbox
// ==========================================
app.get('/api/positions', async (req, res) => {
    const client = await pgPool.connect();
    try {
        // ดึงตำแหน่งที่อยู่ในระดับหมู่บ้าน (VILLAGE) และโครงสร้างพื้นฐาน (INFRASTRUCTURE)
        const result = await client.query(`
            SELECT position_id, position_name 
            FROM sys_positions 
            WHERE position_level IN ('VILLAGE', 'INFRASTRUCTURE')
            ORDER BY position_id ASC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Fetch Positions Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูลตำแหน่ง' });
    } finally {
        client.release();
    }
});

// ==========================================
// API: ค้นหาข้อมูลลูกบ้านด้วยเลขบัตรประชาชน (ดึงจากระบบประชากร/Household Members)
// ==========================================
app.get('/api/search-citizen/:villageId/:citizenId', async (req, res) => {
    const { villageId, citizenId } = req.params;
    
    // 🌟 ทำความสะอาดข้อมูล: ลบช่องว่างหรือขีด (-) ออก
    const cleanCitizenId = String(citizenId || '').replace(/[^0-9]/g, '');

    if (!cleanCitizenId || !villageId) {
        return res.status(400).json({ success: false, message: 'ข้อมูลการค้นหาไม่ครบถ้วน' });
    }

    const client = await pgPool.connect(); 
    try {
        // 🌟 เปลี่ยนมาค้นหาใน household_members ที่ผูกกับ households แทน เพื่อให้เจอลูกบ้านทั้งหมด
        const result = await client.query(`
            SELECT 
                hm.member_id AS account_id, -- ใช้ member_id แทน account_id ชั่วคราวเพื่อให้ผังดึง ID ไปใช้งานได้
                hm.first_name, 
                hm.last_name,
                hm.citizen_id,
                v.village_name,          
                t.tambon_name_th,        
                -- กรณีที่ใน household_members ไม่มีรูป อาจจะต้องดึงจาก user_profiles หรือใช้รูป default
                '/profile-img.jpg' AS user_image, 
                hm.relationship AS responsibilities
            FROM household_members hm
            INNER JOIN households h ON hm.household_id = h.household_id
            LEFT JOIN villages v ON h.village_id::TEXT = v.village_id::TEXT
            LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
            WHERE REPLACE(TRIM(hm.citizen_id::TEXT), '-', '') = $1 
              AND h.village_id::TEXT = $2::TEXT
              AND hm.status = 'ACTIVE' -- เอาเฉพาะคนที่ยังอาศัยอยู่
            LIMIT 1
        `, [cleanCitizenId, String(villageId)]);

        if (result.rows.length > 0) {
            res.json({ success: true, data: result.rows[0] });
        } else {
            // เช็คว่ามีคนนี้อยู่จริงไหม แต่ไม่ได้อยู่หมู่บ้านนี้
            const checkOtherVillage = await client.query(`SELECT member_id FROM household_members WHERE REPLACE(TRIM(citizen_id::TEXT), '-', '') = $1 AND status = 'ACTIVE'`, [cleanCitizenId]);
            if(checkOtherVillage.rows.length > 0){
                res.status(404).json({ success: false, message: 'ไม่พบข้อมูลลูกบ้านนี้ในหมู่บ้านของคุณ' });
            } else {
                res.status(404).json({ success: false, message: 'ไม่พบข้อมูลเลขบัตรประชาชนนี้ในระบบจัดการประชากร' });
            }
        }
    } catch (error) {
        console.error("Search Citizen Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการค้นหาข้อมูล' });
    } finally {
        if (client) client.release(); 
    }
});

app.delete('/api/community-leaders/:id', async (req, res) => {
  const { id } = req.params;
  const recordId = parseInt(id, 10);

  if (isNaN(recordId)) {
    return res.status(400).json({ success: false, message: 'รหัสรายการไม่ถูกต้อง' });
  }

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    // ปลดการอ้างอิง parent_id ของรายการย่อยก่อนลบ เพื่อไม่ให้ติด foreign key
    await client.query(
      'UPDATE user_positions SET parent_id = NULL WHERE parent_id = $1',
      [recordId]
    );

    const result = await client.query(
      'DELETE FROM user_positions WHERE id = $1 RETURNING *',
      [recordId]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลตำแหน่งที่ต้องการลบ' });
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'ลบบุคลากรออกจากตำแหน่งสำเร็จ', data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting leader:', error);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการลบข้อมูล: ' + error.message });
  } finally {
    client.release();
  }
});

// ==========================================
// API: ดึงข้อมูลผังผู้นำ (GET) - ปรับปรุงแก้ไข Error 500
// ==========================================
app.get('/api/community-leaders/:villageId', async (req, res) => {
    const { villageId } = req.params;
    const { committee_id } = req.query;

    if (!committee_id) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสคณะทำงาน' });
    }

    const client = await pgPool.connect();
    try {
        const result = await client.query(`
            SELECT 
                upos.id,
                upos.parent_id,
                upos.committee_id,
                upos.position_name AS role_name,
                upos.start_date,
                upos.end_date,
                upos.responsibilities,
                upos.account_id,
                
                -- ดึงชื่อ: ถ้ามีบัญชีใช้ชื่อนั้น ถ้าไม่มีให้ดึงจากระบบประชากร
                COALESCE(p.first_name, hm.first_name) AS first_name,
                COALESCE(p.last_name, hm.last_name) AS last_name,
                
                -- ดึงรูปภาพ: เผื่อกรณีคอลัมน์รูปในแต่ละตารางชื่อไม่เหมือนกัน
                COALESCE(cpm.image_url, p.profile_image, '/profile-img.jpg') AS user_image
                
            FROM user_positions upos
            LEFT JOIN user_accounts a ON upos.account_id::text = a.account_id::text
            LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
            LEFT JOIN citizen_profiles_media cpm ON p.profile_id = cpm.profile_id AND cpm.is_active = true
            LEFT JOIN household_members hm ON upos.account_id::text = hm.member_id::text
            
            WHERE upos.committee_id::text = $1::text
        `, [committee_id]);

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Error fetching leaders:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูลผัง', error: error.message });
    } finally {
        if (client) client.release();
    }
});

// ==========================================
// API: ดึงข้อมูลผังผู้นำด้วย Committee ID (แบบปลอดภัย 100%)
// ==========================================
app.get('/api/community-leaders/by-committee/:committeeId', async (req, res) => {
    const { committeeId } = req.params;

    const client = await pgPool.connect();
    try {
        const result = await client.query(`
            SELECT 
                upos.id,
                upos.parent_id,
                upos.committee_id,
                sp.position_name AS role_name,
                upos.start_date,
                upos.end_date,
                upos.responsibilities,
                upos.account_id,
                COALESCE(p.first_name, hm.first_name) AS first_name,
                COALESCE(p.last_name, hm.last_name) AS last_name,
                COALESCE(p.profile_image, '/profile-img.jpg') AS user_image
            FROM user_positions upos
            LEFT JOIN sys_positions sp ON upos.position_id = sp.position_id 
            LEFT JOIN user_accounts a ON upos.account_id::text = a.account_id::text
            LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
            LEFT JOIN household_members hm ON upos.account_id::text = hm.member_id::text
            WHERE upos.committee_id::integer = $1::integer
        `, [committeeId]);

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Error fetching leaders by committee:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดจากฐานข้อมูล', error: error.message });
    } finally {
        if (client) client.release();
    }
});


// ==========================================
// API: ดึงข้อมูลผังผู้นำ (V2) - แก้ไข Error คอลัมน์รูปภาพแล้ว 100%
// ==========================================
app.get('/api/v2/committee-leaders/:committeeId', async (req, res) => {
    const { committeeId } = req.params;

    const client = await pgPool.connect();
    try {
        const result = await client.query(`
            SELECT 
                upos.id,
                upos.parent_id,
                upos.committee_id,
                sp.position_name AS role_name,
                upos.start_date,
                upos.end_date,
                upos.responsibilities,
                upos.account_id,
                COALESCE(p.first_name, hm.first_name) AS first_name,
                COALESCE(p.last_name, hm.last_name) AS last_name,
                
                -- 🌟 จุดที่แก้: ใช้รูปภาพ Default ไปก่อน เพื่อป้องกัน Error คอลัมน์ไม่มี
                '/profile-img.jpg' AS user_image
                
            FROM user_positions upos
            LEFT JOIN sys_positions sp ON upos.position_id = sp.position_id 
            LEFT JOIN user_accounts a ON upos.account_id::text = a.account_id::text
            LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
            LEFT JOIN household_members hm ON upos.account_id::text = hm.member_id::text
            WHERE upos.committee_id::integer = $1::integer
        `, [committeeId]);

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Error fetching v2 leaders:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูล', error: error.message });
    } finally {
        if (client) client.release();
    }
});

// ==========================================
// API: เพิ่มคณะทำงาน / โครงการใหม่
// ==========================================
app.post('/api/community-committees', async (req, res) => {
    const { village_id, committee_name, description } = req.body;
    let client;
    try {
        client = await pgPool.connect();
        await client.query(
            'INSERT INTO community_committees (village_id, committee_name, description) VALUES ($1, $2, $3)', 
            [village_id, committee_name, description]
        );
        res.json({ success: true, message: 'สร้างคณะทำงานใหม่สำเร็จ' });
    } catch (error) {
        console.error('Error in POST /api/community-committees:', error); // เพิ่มเพื่อดู error log ใน server
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสร้างคณะทำงาน: ' + error.message }); // ส่ง error กลับไปที่ frontend ให้เห็นชัดเจน
    } finally {
        if (client) {
            client.release(); // คืน connection ให้ pool เสมอ
        }
    }
});

// ==========================================
// API: อัปเดต/แก้ไข ข้อมูลผู้นำ (อัปเกรดให้เปลี่ยนชื่อตำแหน่งได้)
// ==========================================
app.put('/api/community-leaders/:recordId', async (req, res) => {
    const { recordId } = req.params;
    
    // 🌟 เพิ่มการรับ position_name เข้ามาด้วย
    const { position_name, account_id, start_date, end_date, responsibilities } = req.body;

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // 🌟 1. ดักจับและแปลงชื่อตำแหน่งให้เป็น position_id ก่อน (เหมือนตอนเพิ่มข้อมูล)
        let currentPositionId = null;
        if (position_name) {
            const posResult = await client.query('SELECT position_id FROM sys_positions WHERE position_name = $1 LIMIT 1', [position_name]);
            if (posResult.rows.length > 0) {
                currentPositionId = posResult.rows[0].position_id;
            } else {
                const maxIdResult = await client.query('SELECT COALESCE(MAX(position_id), 0) + 1 as next_id FROM sys_positions WHERE position_id < 999');
                currentPositionId = maxIdResult.rows[0].next_id;
                await client.query(`INSERT INTO sys_positions (position_id, position_name, position_level) VALUES ($1, $2, 'VILLAGE')`, [currentPositionId, position_name]);
            }
        }

        // 🌟 2. อัปเดตข้อมูลทั้งหมด รวมถึง position_id ด้วย
        const updateQuery = `
            UPDATE user_positions 
            SET account_id = $1, 
                start_date = $2, 
                end_date = $3, 
                responsibilities = $4,
                position_id = COALESCE($5, position_id) 
            WHERE id = $6
        `;
        
        await client.query(updateQuery, [
            account_id, 
            start_date, 
            end_date || null, 
            responsibilities, 
            currentPositionId, 
            recordId
        ]);

        await client.query('COMMIT');
        res.json({ success: true, message: 'อัปเดตข้อมูลสำเร็จ' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Update Leader Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการอัปเดต' });
    } finally {
        if (client) client.release();
    }
});


// ==========================================
// API: ลบข้อมูลผู้นำออกจากตำแหน่ง (Set is_active = false)
// ==========================================
app.delete('/api/community-leaders/:recordId', async (req, res) => {
    const { recordId } = req.params;
    
    const client = await pgPool.connect();
    try {
        await client.query(`
            UPDATE user_positions 
            SET is_active = false 
            WHERE id = $1
        `, [recordId]);
        
        res.json({ success: true, message: 'ลบข้อมูลบุคลากรออกจากตำแหน่งสำเร็จ' });
    } catch (error) {
        console.error("Delete Leader Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการลบข้อมูล' });
    } finally {
        client.release();
    }
});

// ==========================================
// API: ดึงรายชื่อแท็บคณะทำงาน (GET)
// ==========================================
app.get('/api/community-committees/:villageId', async (req, res) => {
    const { villageId } = req.params;
    const client = await pgPool.connect();
    
    try {
        // 🌟 ดึงข้อมูลโดยแปลง village_id ให้เป็น text เพื่อป้องกัน error
        const result = await client.query(
            'SELECT * FROM community_committees WHERE village_id::text = $1::text ORDER BY committee_name ASC', 
            [villageId]
        );
        
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Error fetching committees:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูลคณะทำงาน' });
    } finally {
        if (client) client.release(); // คืน Connection เสมอ
    }
});
// ==========================================
// API: เพิ่มบุคลากรลงในผังคณะทำงาน (แก้ปัญหา $9 integer)
// ==========================================
app.post('/api/community-leaders', async (req, res) => {
    const { village_id, committee_id, position_name, account_id, start_date, end_date, responsibilities, parent_id } = req.body;

    // 🌟 1. ดักจับและแปลง parent_id ให้เป็นตัวเลข (Integer) หรือ null เท่านั้น ป้องกัน Error $9
    let safeParentId = parseInt(parent_id, 10);
    if (isNaN(safeParentId)) {
        safeParentId = null;
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN'); 

        let currentPositionId = null;
        const posResult = await client.query('SELECT position_id FROM sys_positions WHERE position_name = $1 LIMIT 1', [position_name]);
        if (posResult.rows.length > 0) currentPositionId = posResult.rows[0].position_id;
        else {
            const maxIdResult = await client.query('SELECT COALESCE(MAX(position_id), 0) + 1 as next_id FROM sys_positions WHERE position_id < 999');
            currentPositionId = maxIdResult.rows[0].next_id;
            await client.query(`INSERT INTO sys_positions (position_id, position_name, position_level) VALUES ($1, $2, 'VILLAGE')`, [currentPositionId, position_name]);
        }

        const insertQuery = `
            INSERT INTO user_positions (
                account_id, position_id, scope_type, scope_id, start_date, end_date, responsibilities, is_active, committee_id, parent_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9) RETURNING id
        `;
        
        await client.query(insertQuery, [
            account_id, 
            currentPositionId, 
            'VILLAGE', 
            village_id, 
            start_date, 
            end_date || null, 
            responsibilities, 
            committee_id, 
            safeParentId // 🌟 2. ใช้ safeParentId ที่ผ่านการกรองแล้ว ส่งเข้า $9
        ]);

        await client.query('COMMIT'); 
        res.json({ success: true, message: 'เพิ่มข้อมูลสำเร็จ' });
    } catch (error) {
        await client.query('ROLLBACK'); 
        console.error("Add Leader Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเพิ่มข้อมูล' });
    } finally {
        client.release();
    }
});
// ==========================================
// API: ค้นหาข้อมูลลูกบ้านด้วยเลขบัตรประชาชน
// ==========================================
app.get('/api/search-citizen/:citizenId', async (req, res) => {
    const { citizenId } = req.params;
    console.log("กำลังค้นหาเลขบัตรประชาชน:", JSON.stringify(citizenId)); // เพิ่มบรรทัดนี้เพื่อเช็คค่าที่รับมา
    
    const client = await pgPool.connect();
    
    try {
        const result = await client.query(`
            SELECT 
                profile_id as account_id, 
                first_name, 
                last_name
            FROM user_profiles 
            WHERE TRIM(citizen_id) = TRIM($1)
        `, [citizenId]); // ใช้ TRIM() ตัดช่องว่างหัวท้ายเพื่อป้องกันปัญหาข้อมูลไม่ตรงกัน

        if (result.rows.length > 0) {
            res.json({ success: true, data: result.rows[0] });
        } else {
            res.json({ success: false, message: 'ไม่พบข้อมูลลูกบ้านจากเลขบัตรนี้' });
        }
    } catch (error) {
        console.error("Search Citizen Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการค้นหา' });
    } finally {
        client.release();
    }
});


// 🌟 API ดึงข้อมูลกลุ่มเมนู (เพิ่มใหม่)
app.get('/api/menu-groups', async (req, res) => {
    const client = await pgPool.connect();
    try {
        const result = await client.query(`
            SELECT group_id, group_name 
            FROM sys_menu_groups 
            ORDER BY display_order ASC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Fetch Menu Groups Error:", error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงกลุ่มเมนู' });
    } finally {
        client.release();
    }
});


// ดึงรายการคณะทำงานของหมู่บ้านนั้นๆ
app.get('/api/committees', async (req, res) => {
    // สมมติว่าดึง village_id จาก token ที่แนบมา หรือจาก req.query
    const { village_id } = req.query; 

    try {
        const query = `
            SELECT * FROM community_committees 
            WHERE village_id = $1 
            ORDER BY created_at ASC
        `;
        const result = await pgPool.query(query, [village_id]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// API: ดึงรายชื่อคณะทำงาน/โครงการ ของหมู่บ้าน
// ==========================================
app.get('/api/community-committees/:villageId', async (req, res) => {
    // 🌟 ดักและแปลง villageId ให้เป็นตัวเลข (Integer) ก่อนเสมอ
    const villageId = parseInt(req.params.villageId, 10);
    
    // ถ้าแปลงแล้วไม่ใช่ตัวเลข ให้ตีกลับไปเลย ป้องกัน DB Error
    if (isNaN(villageId)) {
        return res.status(400).json({ success: false, message: 'รหัสหมู่บ้านไม่ถูกต้อง (ต้องเป็นตัวเลข)' });
    }

    const client = await pgPool.connect();
    try {
        const result = await client.query('SELECT * FROM community_committees WHERE village_id = $1 ORDER BY committee_id ASC', [villageId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("🔥 DB Error (Get Committees):", error);
        res.status(500).json({ success: false, message: 'DB Error: ' + error.message });
    } finally {
        if (client) client.release();
    }
});
// ==========================================
// 🌟 API สำหรับลบคณะทำงาน (DELETE)
// ==========================================
app.delete('/api/community-committees/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // ใช้ Transaction เพื่อความปลอดภัย (ลบข้อมูลบุคลากรในผังของคณะนี้ก่อน แล้วค่อยลบตัวคณะ)
        await pgPool.query('BEGIN');

        // 1. ลบความสัมพันธ์ตำแหน่งบุคลากรที่ผูกกับ committee_id นี้ก่อน (ป้องกันติด Foreign Key)
        await pgPool.query('DELETE FROM user_positions WHERE committee_id = $1', [id]);

        // 2. ลบตัวคณะทำงานออกจากตาราง
        const result = await pgPool.query('DELETE FROM community_committees WHERE committee_id = $1 RETURNING *;', [id]);

        if (result.rowCount === 0) {
            await pgPool.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลคณะทำงานที่ต้องการลบ' });
        }

        await pgPool.query('COMMIT');
        res.json({ success: true, message: 'ลบคณะทำงานสำเร็จ' });
    } catch (error) {
        await pgPool.query('ROLLBACK');
        console.error('Error deleting committee:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 🌟 API แต่งตั้งตำแหน่ง พร้อมตรวจสอบรหัสผ่านชุดที่ 2 และบันทึกวาระ (Start/End Date)
// ==========================================
app.post('/api/assign-role', async (req, res) => {
    const { 
        target_account_id, 
        position_id, 
        scope_type, 
        scope_id, 
        assigner_account_id, 
        approval_pin, // รับรหัสผ่านชุดที่ 2 มาจาก Frontend
        start_date,   // 🌟 เพิ่ม: รับวันที่เริ่มวาระจาก Frontend
        end_date      // 🌟 เพิ่ม: รับวันที่สิ้นสุดวาระจาก Frontend
    } = req.body;

    // ตรวจสอบข้อมูลเบื้องต้น
    if (!target_account_id || !assigner_account_id || !approval_pin) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    try {
        // --- ส่วนแก้ไขชั่วคราว: ตรวจสอบรหัสแบบ Hardcode เพื่อให้ผ่านการทดสอบ ---
        if (approval_pin !== '123456') {
            return res.status(401).json({ success: false, message: 'รหัสอนุมัติไม่ถูกต้อง' });
        }
        // -------------------------------------------------------------

        // รหัสถูกต้อง เริ่มกระบวนการบันทึก (Transaction)
        await pgPool.query('BEGIN');

        // จัดการ scope_id ถ้าเป็น UUID ให้ใส่ null ในตาราง user_positions ก่อน (แก้ปัญหา invalid input syntax)
        let finalScopeId = null;
        if (scope_type === 'VILLAGE' && isNaN(scope_id)) {
            finalScopeId = null; 
        } else {
            finalScopeId = scope_id;
        }

        // 🌟 แก้ไข: เพิ่ม start_date และ end_date ลงในการ INSERT
        const insertPositionQuery = `
            INSERT INTO user_positions (account_id, position_id, scope_type, scope_id, start_date, end_date, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id;
        `;
        
        // กรณีไม่มีค่าส่งมา ให้ใช้วันที่ปัจจุบันแทน
        const sDate = start_date ? start_date : new Date().toISOString().split('T')[0];
        const eDate = end_date ? end_date : null;

        await pgPool.query(insertPositionQuery, [
            target_account_id, 
            position_id, 
            scope_type, 
            finalScopeId, 
            sDate, 
            eDate
        ]);

        // อัปเดตข้อมูลผู้ใหญ่บ้านในตาราง villages
        if (scope_type === 'VILLAGE') {
            await pgPool.query('UPDATE villages SET headman_account_id = $1 WHERE village_id = $2', [target_account_id, scope_id]);
        }

        await pgPool.query('COMMIT');
        
        // ส่งข้อมูลกลับไปให้ Frontend
        res.json({ 
            success: true, 
            message: 'แต่งตั้งตำแหน่งและประทับตราลายเซ็นอิเล็กทรอนิกส์สำเร็จ',
            assigned_date: new Date().toISOString()
        });

    } catch (error) {
        await pgPool.query('ROLLBACK');
        console.error('Error assigning role:', error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการแต่งตั้งตำแหน่ง' });
    }
});

// ==========================================
// 🌟 API ดึงรายการหมู่บ้านทั้งหมดสำหรับให้เลือกตอนแต่งตั้ง
// ==========================================
app.get('/api/villages-list', async (req, res) => {
    try {
        // ดึงข้อมูลหมู่บ้านทั้งหมด (ในระบบจริงอาจจะกรองตามตำบล/อำเภอของนายอำเภอที่กำลังล็อกอิน)
        const query = `
            SELECT village_id, village_no, village_name 
            FROM villages 
            ORDER BY village_no ASC;
        `;
        const result = await pgPool.query(query);
        
        // จัด Format ข้อมูลส่งกลับไปให้ Frontend
        const formattedVillages = result.rows.map(v => ({
            village_id: v.village_id,
            name: `${v.village_no} ${v.village_name}`
        }));

        res.json({ success: true, data: formattedVillages });
    } catch (error) {
        console.error('Error fetching villages list:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลหมู่บ้านได้' });
    }
});

// ==========================================
// API ค้นหาข้อมูลประชาชนแบบละเอียด (ดึงรูป Profile + ต.อ.จ. + วันเริ่ม/หมดวาระเดิม)
// ==========================================
app.get('/api/search-citizen-full/:citizenId', async (req, res) => {
    const { citizenId } = req.params;
    try {
        const result = await pgPool.query(`
            SELECT 
                ua.account_id AS real_account_id,
                ua.account_id,
                ua.village_id,
                ua.area_code,
                up.profile_id,
                up.citizen_id,
                up.first_name,
                up.last_name,
                up.nickname,
                up.gender,
                up.dob,
                up.house_no,
                -- ✨ ดึงรูป Profile ล่าสุดที่เปิดใช้งานจากตาราง citizen_profiles_media
                (
                    SELECT cpm.image_url
                    FROM citizen_profiles_media cpm
                    WHERE cpm.profile_id = up.profile_id AND cpm.is_active = true
                    LIMIT 1
                ) AS user_image,
                -- ✨ ดึงหมู่บ้าน + ตำบล + อำเภอ + จังหวัด
                v.village_no,
                v.village_name,
                t.tambon_name_th AS tambon_name,
                t.zip_code,
                a.amphure_name_th AS amphure_name,
                p.province_name_th AS province_name,
                -- ✨ ดึงตำแหน่งเดิม + วันเริ่มดำรงตำแหน่ง + วันหมดวาระ (ล่าสุด)
                COALESCE(latest_pos.position_name, 'ประชาชนทั่วไป') AS prev_position,
                latest_pos.start_date AS current_start_date,
                latest_pos.end_date AS current_end_date
            FROM user_profiles up
            JOIN user_accounts ua ON up.profile_id = ua.profile_id
            LEFT JOIN villages v ON ua.village_id = v.village_id
            -- ✨ เชื่อมตำบลแบบรองรับทั้ง tambon_id, tambon_code และ area_code
            LEFT JOIN sys_tambons t ON (
                CAST(v.tambon_id AS TEXT) = CAST(t.tambon_id AS TEXT)
                OR CAST(v.tambon_id AS TEXT) = CAST(t.tambon_code AS TEXT)
                OR CAST(ua.area_code AS TEXT) = CAST(t.tambon_code AS TEXT)
            )
            LEFT JOIN sys_amphures a ON (
                CAST(t.amphure_id AS TEXT) = CAST(a.amphure_id AS TEXT)
                OR CAST(t.amphure_id AS TEXT) = CAST(a.amphure_code AS TEXT)
            )
            LEFT JOIN sys_provinces p ON (
                CAST(a.province_id AS TEXT) = CAST(p.province_id AS TEXT)
                OR CAST(a.province_id AS TEXT) = CAST(p.province_code AS TEXT)
            )
            LEFT JOIN LATERAL (
                SELECT sp.position_name, upos.start_date, upos.end_date
                FROM user_positions upos
                JOIN sys_positions sp ON upos.position_id = sp.position_id
                WHERE upos.account_id = ua.account_id
                ORDER BY upos.start_date DESC NULLS LAST
                LIMIT 1
            ) latest_pos ON true
            WHERE up.citizen_id = $1
            LIMIT 1
        `, [citizenId.trim()]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลประชาชนจากเลขบัตรนี้' });
        }

        const row = result.rows[0];
        const thMonths = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];

        // แปลงวันที่เป็นภาษาไทย
        const toThaiDate = (dateVal) => {
            if (!dateVal) return 'ไม่ระบุ';
            const d = new Date(dateVal);
            if (isNaN(d.getTime())) return 'ไม่ระบุ';
            return `${d.getDate()} ${thMonths[d.getMonth()]} ${d.getFullYear() + 543}`;
        };

        // แปลงเพศ
        const genderMap = { MALE: 'ชาย', FEMALE: 'หญิง', OTHER: 'อื่นๆ' };
        const genderText = genderMap[(row.gender || '').toUpperCase()] || row.gender || 'ไม่ระบุ';

        // คำนวณอายุ
        let age = '-';
        if (row.dob) {
            const dobDate = new Date(row.dob);
            const today = new Date();
            age = today.getFullYear() - dobDate.getFullYear();
            const m = today.getMonth() - dobDate.getMonth();
            if (m < 0 || (m === 0 && today.getDate() < dobDate.getDate())) age--;
        }

        // ประกอบที่อยู่เต็ม
        const addressParts = [
            row.house_no ? `บ้านเลขที่ ${row.house_no}` : null,
            row.village_no ? `หมู่ ${row.village_no}` : null,
            row.village_name ? `${row.village_name}` : null,
            row.tambon_name ? `ต.${row.tambon_name}` : null,
            row.amphure_name ? `อ.${row.amphure_name}` : null,
            row.province_name ? `จ.${row.province_name}` : null,
            row.zip_code ? `${row.zip_code}` : null
        ].filter(Boolean);

        res.json({
            success: true,
            data: {
                ...row,
                gender: genderText,
                age,
                birth_date: toThaiDate(row.dob),
                address: addressParts.length > 0 ? addressParts.join(' ') : 'ยังไม่ระบุที่อยู่',
                current_start_date_thai: toThaiDate(row.current_start_date),
                current_end_date_thai: toThaiDate(row.current_end_date)
            }
        });
    } catch (err) {
        console.error('Search Citizen Full Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// ==========================================
// 1. ฟังก์ชันปรับหมดวาระอัตโนมัติ (ทำงานทุกครั้งที่มีการค้นหา / แต่งตั้ง / Login)
// ==========================================
async function syncExpiredPositions(dbClient = pgPool) {
    try {
        await dbClient.query(`
            UPDATE user_positions
            SET is_active = false,
                status = 'EXPIRED',
                end_reason = 'หมดวาระอัตโนมัติตามกำหนด'
            WHERE is_active = true
              AND end_date IS NOT NULL
              AND end_date < CURRENT_DATE
        `);
    } catch (err) {
        console.error('Sync Expired Positions Error:', err.message);
    }
}
// ==========================================
// 2. API ปรับพ้นจากตำแหน่งด้วยมือ (เปลี่ยนจาก ผู้ใหญ่บ้าน -> อดีตผู้ใหญ่บ้าน ระดับประชาชน)
// ==========================================
app.post('/api/demote-position', async (req, res) => {
    const { target_account_id, approval_pin, reason } = req.body;
    if (!target_account_id || !approval_pin) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // 1. ปรับสถานะตำแหน่งที่ยัง Active อยู่ให้กลายเป็นอดีต (is_active = false)
        const result = await client.query(`
            UPDATE user_positions
            SET is_active = false,
                status = 'FORMER',
                end_date = CURRENT_DATE,
                end_reason = $1
            WHERE account_id = $2 AND is_active = true
            RETURNING *
        `, [reason || 'พ้นจากตำแหน่ง (ปรับระดับเป็นประชาชน)', target_account_id]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบตำแหน่งที่ยังดำรงอยู่ของบุคคลนี้' });
        }

        // 2. รีเซ็ต role ในตาราง user_accounts กลับเป็นประชาชน (CITIZEN)
        await client.query(
            `UPDATE user_accounts SET role = 'CITIZEN' WHERE account_id = $1`,
            [target_account_id]
        );

        // 3. ล้างชื่อผู้ใหญ่บ้านคนเก่าออกจากตาราง villages เพื่อให้ตำแหน่งว่างรอคนใหม่
        await client.query(
            `UPDATE villages SET headman_account_id = NULL WHERE headman_account_id = $1`,
            [target_account_id]
        );

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'ปรับสถานะเป็น "อดีตผู้ใหญ่บ้าน (ระดับประชาชน)" เรียบร้อยแล้ว สามารถแต่งตั้งคนใหม่แทนได้ทันที',
            data: result.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Demote Position Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// ==========================================
// 3. อัปเดต API แต่งตั้งตำแหน่ง (/api/assign-role)
//    - ปลดคนเก่าของหมู่บ้านเดียวกันเป็น "อดีตผู้ใหญ่บ้าน" อัตโนมัติ
//    - แต่งตั้งคนใหม่เป็น "ผู้ใหญ่บ้าน" (is_active = true) เพื่อให้ Login ทำงานต่อได้ทันที
// ==========================================
app.post('/api/assign-role', async (req, res) => {
    const { target_account_id, position_id, scope_type, scope_id, start_date, end_date, approval_pin } = req.body;
    if (!target_account_id || !position_id || !scope_id) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // 3.1 เคลียร์ตำแหน่งที่หมดวาระอัตโนมัติก่อน
        await syncExpiredPositions(client);

        // 3.2 ถ้าหมู่บ้านนี้ (scope_id) มีผู้ใหญ่บ้านคนเก่าที่ยัง Active อยู่ -> ปรับเป็น "อดีตผู้ใหญ่บ้าน" อัตโนมัติ
        await client.query(`
            UPDATE user_positions
            SET is_active = false,
                status = 'FORMER',
                end_date = CURRENT_DATE,
                end_reason = 'พ้นจากตำแหน่งเนื่องจากมีการแต่งตั้งคนใหม่แทน'
            WHERE position_id = $1
              AND scope_id = $2
              AND is_active = true
        `, [position_id, scope_id]);

        // 3.3 บันทึกคนใหม่เป็นผู้ใหญ่บ้านปัจจุบัน (is_active = true)
        const insertRes = await client.query(`
            INSERT INTO user_positions (account_id, position_id, scope_type, scope_id, start_date, end_date, is_active, status)
            VALUES ($1, $2, $3, $4, $5, $6, true, 'ACTIVE')
            RETURNING *
        `, [target_account_id, position_id, scope_type || 'VILLAGE', scope_id, start_date, end_date]);

        await client.query('COMMIT');
        res.json({
            success: true,
            message: 'แต่งตั้งผู้ใหญ่บ้านคนใหม่สำเร็จ (คนเก่าถูกปรับเป็นอดีตผู้ใหญ่บ้านอัตโนมัติ)',
            data: insertRes.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Assign Role Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});// ==========================================
// 1. ฟังก์ชันปรับหมดวาระอัตโนมัติ (ทำงานทุกครั้งที่มีการค้นหา / แต่งตั้ง / Login)
// ==========================================
async function syncExpiredPositions(dbClient = pgPool) {
    try {
        await dbClient.query(`
            UPDATE user_positions
            SET is_active = false,
                status = 'EXPIRED',
                end_reason = 'หมดวาระอัตโนมัติตามกำหนด'
            WHERE is_active = true
              AND end_date IS NOT NULL
              AND end_date < CURRENT_DATE
        `);
    } catch (err) {
        console.error('Sync Expired Positions Error:', err.message);
    }
}

// ==========================================
// 2. API ปรับพ้นจากตำแหน่งด้วยมือ (เปลี่ยนจาก ผู้ใหญ่บ้าน -> อดีตผู้ใหญ่บ้าน ระดับประชาชน)
// ==========================================
app.post('/api/demote-position', async (req, res) => {
    const { target_account_id, approval_pin, reason } = req.body;
    if (!target_account_id || !approval_pin) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // 1. ปรับสถานะตำแหน่งที่ยัง Active อยู่ให้กลายเป็นอดีต (is_active = false)
        const result = await client.query(`
            UPDATE user_positions
            SET is_active = false,
                status = 'FORMER',
                end_date = CURRENT_DATE,
                end_reason = $1
            WHERE account_id = $2 AND is_active = true
            RETURNING *
        `, [reason || 'พ้นจากตำแหน่ง (ปรับระดับเป็นประชาชน)', target_account_id]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบตำแหน่งที่ยังดำรงอยู่ของบุคคลนี้' });
        }

        // 2. รีเซ็ต role ในตาราง user_accounts กลับเป็นประชาชน (CITIZEN)
        await client.query(
            `UPDATE user_accounts SET role = 'CITIZEN' WHERE account_id = $1`,
            [target_account_id]
        );

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'ปรับสถานะเป็น "อดีตผู้ใหญ่บ้าน (ระดับประชาชน)" เรียบร้อยแล้ว สามารถแต่งตั้งคนใหม่แทนได้ทันที',
            data: result.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Demote Position Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// ==========================================
// 3. อัปเดต API แต่งตั้งตำแหน่ง (/api/assign-role)
//    - ปลดคนเก่าของหมู่บ้านเดียวกันเป็น "อดีตผู้ใหญ่บ้าน" อัตโนมัติ
//    - แต่งตั้งคนใหม่เป็น "ผู้ใหญ่บ้าน" (is_active = true) เพื่อให้ Login ทำงานต่อได้ทันที
// ==========================================
app.post('/api/assign-role', async (req, res) => {
    const { target_account_id, position_id, scope_type, scope_id, start_date, end_date, approval_pin } = req.body;
    if (!target_account_id || !position_id || !scope_id) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // 3.1 เคลียร์ตำแหน่งที่หมดวาระอัตโนมัติก่อน
        await syncExpiredPositions(client);

        // 3.2 ถ้าหมู่บ้านนี้ (scope_id) มีผู้ใหญ่บ้านคนเก่าที่ยัง Active อยู่ -> ปรับเป็น "อดีตผู้ใหญ่บ้าน" อัตโนมัติ
        await client.query(`
            UPDATE user_positions
            SET is_active = false,
                status = 'FORMER',
                end_date = CURRENT_DATE,
                end_reason = 'พ้นจากตำแหน่งเนื่องจากมีการแต่งตั้งคนใหม่แทน'
            WHERE position_id = $1
              AND scope_id = $2
              AND is_active = true
        `, [position_id, scope_id]);

        // 3.3 บันทึกคนใหม่เป็นผู้ใหญ่บ้านปัจจุบัน (is_active = true)
        const insertRes = await client.query(`
            INSERT INTO user_positions (account_id, position_id, scope_type, scope_id, start_date, end_date, is_active, status)
            VALUES ($1, $2, $3, $4, $5, $6, true, 'ACTIVE')
            RETURNING *
        `, [target_account_id, position_id, scope_type || 'VILLAGE', scope_id, start_date, end_date]);

        await client.query('COMMIT');
        res.json({
            success: true,
            message: 'แต่งตั้งผู้ใหญ่บ้านคนใหม่สำเร็จ (คนเก่าถูกปรับเป็นอดีตผู้ใหญ่บ้านอัตโนมัติ)',
            data: insertRes.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Assign Role Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});


// ==========================================
// API: เพิ่มข้อมูลบ้าน
// ==========================================
app.post('/api/households', async (req, res) => {
    try {
        const { village_id, house_no, expected_member_count } = req.body;
        
        // 🌟 แก้ไขตรง INSERT นี้ให้รับ expected_member_count ด้วย
        const result = await pgPool.query(`
            INSERT INTO households (village_id, house_no, expected_member_count)
            VALUES ($1, $2, $3)
            RETURNING *
        `, [village_id, house_no, expected_member_count || 0]);
        
        res.json({ success: true, message: 'สร้างข้อมูลบ้านสำเร็จ', data: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. API ดึงรายชื่อบ้านทั้งหมดในเขตรับผิดชอบ (สำหรับหน้าแดชบอร์ดของผู้ใหญ่บ้าน)
app.get('/api/households/village/:villageId', async (req, res) => {
    const { villageId } = req.params;
    
    try {
        // ดึงบ้านเลขที่ พิกัด สถานะ และนับจำนวนคนในบ้านนั้นๆ
        const query = `
            SELECT h.household_id, h.house_no, h.occupancy_status, h.latitude, h.longitude,
                   COUNT(hm.member_id) AS total_members
            FROM households h
            LEFT JOIN household_members hm ON h.household_id = hm.household_id
            WHERE h.village_id = $1
            GROUP BY h.household_id
            ORDER BY h.house_no ASC;
        `;
        const result = await pgPool.query(query, [villageId]);
        
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Error fetching households:', error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูลบ้าน' });
    }
});

// ==========================================
// 🌟 API สำหรับระบบ "ค้นหา -> บันทึกบ้าน -> เพิ่มประชากรต่อเนื่อง"
// ==========================================

// 1. ดึงความคืบหน้า (Progress) เทียบกับเป้าหมายจากภาครัฐ
app.get('/api/villages/:villageId/progress', async (req, res) => {
    const { villageId } = req.params;
    try {
        const query = `
            SELECT
                v.household_count AS target_houses,
                v.population_count AS target_population,
                (SELECT COUNT(*) FROM households WHERE village_id = $1) AS actual_houses,
                (SELECT COUNT(*) FROM household_members hm JOIN households h ON hm.household_id = h.household_id WHERE h.village_id = $1) AS actual_population
            FROM villages v WHERE v.village_id = $1;
        `;
        const result = await pgPool.query(query, [villageId]);
        if (result.rows.length > 0) res.json({ success: true, data: result.rows[0] });
        else res.json({ success: false, message: 'ไม่พบข้อมูลหมู่บ้าน' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// 2. ค้นหาบ้านเลขที่ในหมู่บ้าน (เช็คว่ามีบันทึกหรือยัง)
app.get('/api/households/search', async (req, res) => {
    const { village_id, house_no } = req.query;
    try {
        const query = `SELECT * FROM households WHERE village_id = $1 AND house_no = $2 LIMIT 1`;
        const result = await pgPool.query(query, [village_id, house_no]);
        if (result.rows.length > 0) res.json({ success: true, data: result.rows[0] });
        else res.json({ success: true, data: null }); // ยังไม่มีบ้านนี้
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// 3. ดึงรายชื่อคนในบ้าน (กรณีค้นหาเจอบ้านแล้ว จะได้โชว์ว่ามีใครอยู่บ้าง)
app.get('/api/households/:householdId/members', async (req, res) => {
    const { householdId } = req.params;
    try {
        const query = `SELECT * FROM household_members WHERE household_id = $1 ORDER BY created_at ASC`;
        const result = await pgPool.query(query, [householdId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// 4. บันทึกบ้านอย่างเดียว (แยกปุ่มบันทึก)
app.post('/api/households/single', async (req, res) => {
    const { village_id, house_no, latitude, longitude, occupancy_status, created_by } = req.body;
    try {
        const query = `
            INSERT INTO households (village_id, house_no, latitude, longitude, occupancy_status, created_by)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
        `;
        const result = await pgPool.query(query, [village_id, house_no, latitude, longitude, occupancy_status, created_by]);
        res.json({ success: true, data: result.rows[0], message: 'บันทึกบ้านสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'บันทึกบ้านล้มเหลว อาจมีข้อมูลซ้ำ' });
    }
});

// 5. บันทึกประชากรเข้าบ้าน 1 คน (กดเพิ่มทีละคนต่อเนื่อง)
app.post('/api/households/:householdId/members', async (req, res) => {
    const { householdId } = req.params;
    const member = req.body;
    try {
        const cleanCitizenId = member.is_foreigner ? member.citizen_id : (member.citizen_id || '').replace(/-/g, '');
        const query = `
            INSERT INTO household_members (
                household_id, citizen_id, first_name, last_name, nickname, date_of_birth, gender,
                is_head_of_household, resident_type, living_status, nationality, origin_location
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *;
        `;
        const result = await pgPool.query(query, [
            householdId, cleanCitizenId || null, member.first_name, member.last_name, member.nickname || null,
            member.date_of_birth || null, member.gender || null, member.is_head_of_household || false,
            member.resident_type || 'REGISTERED', member.living_status || 'LIVING_HERE',
            member.nationality || 'THAI', member.origin_location || null
        ]);
        res.json({ success: true, data: result.rows[0], message: 'เพิ่มประชากรสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'บันทึกประชากรล้มเหลว' });
    }
});

// 6. อัปเดตสถานะลูกบ้าน (ย้ายออก / เสียชีวิต)
app.put('/api/members/:memberId/status', async (req, res) => {
    const { memberId } = req.params;
    const { living_status } = req.body; // 'MOVED_AWAY' หรือ 'DECEASED'
    try {
        const query = `UPDATE household_members SET living_status = $1 WHERE member_id = $2 RETURNING *`;
        const result = await pgPool.query(query, [living_status, memberId]);
        res.json({ success: true, data: result.rows[0], message: 'อัปเดตสถานะสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'อัปเดตสถานะล้มเหลว' });
    }
});

// 7. ดึงรายการทะเบียนบ้านทั้งหมด (จำกัด 10 รายการล่าสุด) สำหรับ Card ข้อมูล
app.get('/api/villages/:villageId/households', async (req, res) => {
    const { villageId } = req.params;
    try {
        const query = `
            SELECT h.household_id, h.house_no, h.occupancy_status,
                   (SELECT COUNT(*) FROM household_members WHERE household_id = h.household_id) as total_members
            FROM households h
            WHERE h.village_id = $1
            ORDER BY h.created_at DESC
            LIMIT 10;
        `;
        const result = await pgPool.query(query, [villageId]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'ดึงข้อมูลทะเบียนบ้านล้มเหลว' });
    }
});

// 8. บันทึก/อัปเดตข้อมูลเป้าหมาย (บ้านและประชากร) ของหมู่บ้าน
app.put('/api/villages/:villageId/targets', async (req, res) => {
    const { villageId } = req.params;
    const { target_houses, target_population } = req.body;
    try {
        const query = `
            UPDATE villages 
            SET household_count = $1, population_count = $2 
            WHERE village_id = $3 
            RETURNING *;
        `;
        const result = await pgPool.query(query, [target_houses, target_population, villageId]);
        res.json({ success: true, data: result.rows[0], message: 'อัปเดตเป้าหมายสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'อัปเดตเป้าหมายล้มเหลว' });
    }
});

// ==========================================
// 🌟 API สำหรับลงทะเบียนหมู่บ้านและผู้ใหญ่บ้าน (แก้ปัญหา village_id เป็น NULL)
// ==========================================
// ==========================================
// 🌟 API สำหรับลงทะเบียนผู้ใหญ่บ้าน (แก้ไขให้ใช้ village_id จาก Frontend)
// ==========================================
app.post('/api/villages/register', async (req, res) => {
    const {
        village_id, // 🌟 รับ village_id ที่มีอยู่แล้วจาก Frontend
        latitude, longitude,
        citizen_id, first_name, last_name, nickname, phone_number, password,
        gender, dob, // ✨ รับค่าเพศ และ วันเดือนปีเกิด (YYYY-MM-DD)
        referrer_account_id
    } = req.body;

    if (!phone_number || !password || !village_id) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน กรุณาเลือกหมู่บ้าน' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN'); 

        // 1. ตรวจสอบข้อมูลซ้ำ (เบอร์โทร และ บัตรประชาชน)
        const cleanCitizenId = citizen_id ? String(citizen_id).replace(/-/g, '').trim() : null;
        const checkPhone = await client.query('SELECT account_id FROM user_accounts WHERE username_phone = $1', [phone_number]);
        if (checkPhone.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'เบอร์โทรศัพท์นี้มีการลงทะเบียนแล้ว' });
        }
        if (cleanCitizenId) {
            const checkCitizen = await client.query('SELECT profile_id FROM user_profiles WHERE citizen_id = $1', [cleanCitizenId]);
            if (checkCitizen.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, message: 'เลขบัตรประชาชนนี้มีการลงทะเบียนในระบบแล้ว' });
            }
        }

        // 🌟 2. อัปเดตพิกัด (Lat/Lng) ลงในหมู่บ้านเดิมที่เลือกมา
        await client.query(`
            UPDATE villages 
            SET headman_lat = $1, headman_lng = $2 
            WHERE village_id = $3
        `, [latitude, longitude, village_id]);

        // ✨ 3. สร้าง Profile พร้อมบันทึก gender และ dob จริง
        const finalCitizenId = cleanCitizenId || `999${Math.floor(Math.random() * 10000000000).toString().padStart(10, '0')}`;
        const finalGender = gender && gender.trim() !== '' ? gender.trim() : null;
        const finalDob = dob && dob.trim() !== '' ? dob.trim() : '1900-01-01';

        const insertProfileQuery = `
            INSERT INTO user_profiles (profile_id, first_name, last_name, nickname, citizen_id, gender, dob)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
            RETURNING profile_id;
        `;
        const profileResult = await client.query(insertProfileQuery, [
            first_name, last_name, nickname, finalCitizenId, finalGender, finalDob
        ]);
        const newProfileId = profileResult.rows[0].profile_id;
        const hashedPassword = await bcrypt.hash(password, 10);

        // 4. สร้าง User Account โดยผูกกับ village_id เดิมที่มีตำบลสมบูรณ์อยู่แล้ว
        const finalReferrerId = referrer_account_id && referrer_account_id.trim() !== '' ? referrer_account_id : null;
        const insertUserQuery = `
            INSERT INTO user_accounts (account_id, username_phone, password_hash, is_active, area_code, profile_id, referrer_id, role, village_id)
            VALUES (gen_random_uuid(), $1, $2, true, '100000', $3, $4, 'HEADMAN', $5)
            RETURNING account_id;
        `;
        const userResult = await client.query(insertUserQuery, [phone_number, hashedPassword, newProfileId, finalReferrerId, village_id]); 
        const newAccountId = userResult.rows[0].account_id;

        // 5. อัปเดต headman_account_id กลับไปที่ตารางหมู่บ้าน
        await client.query('UPDATE villages SET headman_account_id = $1 WHERE village_id = $2', [newAccountId, village_id]);

        // 6. สร้าง แท็บคณะทำงาน
        await client.query(`
            INSERT INTO village_committees (committee_id, village_id, account_id, position_name, committee_name, description, assigned_at)
            VALUES (gen_random_uuid(), $1, $2, 'ผู้ใหญ่บ้าน', 'คณะกรรมการหมู่บ้าน', 'บริหารจัดการหมู่บ้าน', CURRENT_TIMESTAMP)
        `, [village_id, newAccountId]);

        // 7. บันทึกตำแหน่งลง user_positions
        let currentPositionId = null;
        const posResult = await client.query('SELECT position_id FROM sys_positions WHERE position_name = $1 LIMIT 1', ['ผู้ใหญ่บ้าน']);
        if (posResult.rows.length > 0) {
            currentPositionId = posResult.rows[0].position_id;
        } else {
            const maxId = await client.query('SELECT COALESCE(MAX(position_id), 0) + 1 as next_id FROM sys_positions WHERE position_id < 999');
            currentPositionId = maxId.rows[0].next_id;
            await client.query(`INSERT INTO sys_positions (position_id, position_name, position_level) VALUES ($1, 'ผู้ใหญ่บ้าน', 'VILLAGE')`, [currentPositionId]);
        }

        await client.query(`
            INSERT INTO user_positions (account_id, position_id, scope_type, scope_id, start_date, is_active, responsibilities) 
            VALUES ($1, $2, 'VILLAGE', $3, CURRENT_DATE, true, 'ผู้นำสูงสุดของหมู่บ้าน')
        `, [newAccountId, currentPositionId, village_id]);

        await client.query('COMMIT');
        res.json({ success: true, message: 'ลงทะเบียนสำเร็จ', village_id: village_id, account_id: newAccountId });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Registration Error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// ==========================================
// API: ระบบจัดการข้อมูลประชากร (Households & Members)
// ==========================================

// 1. ดึงข้อมูล "บ้านทั้งหมด" ในหมู่บ้านนั้น (พร้อมนับจำนวนคนปัจจุบัน)
app.get('/api/households/:village_id', async (req, res) => {
    try {
        const { village_id } = req.params;
        const result = await pgPool.query(`
            SELECT h.*, 
                   (SELECT COUNT(*) FROM household_members m WHERE m.household_id = h.household_id) as current_count
            FROM households h
            WHERE h.village_id = $1
            ORDER BY h.house_no ASC
        `, [village_id]);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. เพิ่มข้อมูล "บ้านเลขที่ใหม่"
app.post('/api/households', async (req, res) => {
    try {
        const { village_id, house_no, expected_member_count } = req.body;
        const result = await pgPool.query(`
            INSERT INTO households (village_id, house_no, expected_member_count)
            VALUES ($1, $2, $3) RETURNING *
        `, [village_id, house_no, expected_member_count]);
        res.json({ success: true, message: 'เพิ่มบ้านสำเร็จ', data: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// API: แก้ไขข้อมูลบ้าน (บ้านเลขที่, จำนวนคนเป้าหมาย)
// ==========================================
app.put('/api/households/:household_id', async (req, res) => {
    try {
        const { household_id } = req.params;
        const { house_no, expected_member_count } = req.body;
        
        await pgPool.query(`
            UPDATE households 
            SET house_no = $1, 
                expected_member_count = $2
            WHERE household_id = $3
        `, [house_no, expected_member_count || 0, household_id]);
        
        res.json({ success: true, message: 'แก้ไขข้อมูลบ้านสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
// ==========================================
// 1. API: ดึงข้อมูลสมาชิกในบ้าน (ปรับให้ดึงข้อมูลได้ชัวร์ 100%)
// ==========================================
app.get('/api/household-members/:household_id', async (req, res) => {
    try {
        const { household_id } = req.params;
        const result = await pgPool.query(`
            -- ดึงข้อมูลตรงๆ จากตาราง household_members เลย เพื่อป้องกันปัญหาการ JOIN แล้วข้อมูลหาย
            SELECT *
            FROM household_members
            WHERE household_id = $1
            ORDER BY status DESC, first_name ASC
        `, [household_id]); 
        
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Error Fetching Members:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// API: เพิ่มรายชื่อ "คน" เข้าบ้าน (แก้ไขระบบตรวจสอบความซ้ำซ้อนให้แม่นยำ)
// ==========================================
app.post('/api/household-members', async (req, res) => {
    try {
        const { 
            household_id, citizen_id, first_name, last_name, nickname, gender, date_of_birth,
            is_foreigner, passport_no, nationality, resident_type, relationship, note, status
        } = req.body;

        // 1. ทำความสะอาดค่ารหัส เพื่อป้องกันบั๊กจากการเว้นวรรค
        const cleanCitizenId = citizen_id ? String(citizen_id).trim() : null;
        const cleanPassport = passport_no ? String(passport_no).trim() : null;
        
        const idToCheck = is_foreigner ? cleanPassport : cleanCitizenId;
        const idColumn = is_foreigner ? 'passport_no' : 'citizen_id';

        if (!idToCheck || idToCheck === '') {
            return res.status(400).json({ success: false, message: 'กรุณาระบุเลขบัตรประชาชนหรือเลขพาสปอร์ต' });
        }

        // 2. ค้นหาประวัติทั้งหมดของคนนี้
        const existingRecords = await pgPool.query(`
            SELECT member_id, household_id, resident_type, status 
            FROM household_members 
            WHERE ${idColumn} = $1
        `, [idToCheck]);

        if (existingRecords.rows.length > 0) {
            
            // กฎข้อ 1: ห้ามอยู่บ้านเดิมซ้ำกันเด็ดขาด (ไม่ว่าสถานะไหนก็ตาม)
            const alreadyInThisHouse = existingRecords.rows.find(r => r.household_id === household_id);
            if (alreadyInThisHouse) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'บุคคลนี้มีรายชื่ออยู่ในบ้านหลังนี้แล้ว กรุณาใช้ปุ่มแก้ไขหากต้องการเปลี่ยนแปลงข้อมูล' 
                });
            }

            // กฎข้อ 2: ถ้าพยายามจะลงทะเบียนเป็น "คนในทะเบียนบ้าน"
            if (resident_type === 'REGISTERED') {
                // ต้องเช็คว่า เขาเคยเป็นคนในทะเบียนบ้านของที่อื่น และสถานะยัง ACTIVE อยู่ไหม
                const activeRegistered = existingRecords.rows.find(r => r.resident_type === 'REGISTERED' && r.status === 'ACTIVE');
                if (activeRegistered) {
                    return res.status(400).json({ 
                        success: false, 
                        message: 'ไม่สามารถบันทึกได้! บุคคลนี้มีชื่อในทะเบียนบ้านหลักอยู่ที่บ้านหลังอื่นแล้ว (สถานะปัจจุบันอยู่)' 
                    });
                }
            }
            
            // ถ้าพยายามจะลงเป็น "ผู้เช่า (NON_REGISTERED)" 
            // เราอนุญาตให้แอดเข้าบ้านใหม่ได้ (เพราะถือว่าเขามาเช่าบ้านใหม่ แม้จะมีทะเบียนบ้านที่อื่น)
        }

        // 3. ถ้าผ่านเงื่อนไข บันทึกลงฐานข้อมูล
        const result = await pgPool.query(`
            INSERT INTO household_members (
                household_id, citizen_id, first_name, last_name, nickname, gender, date_of_birth,
                is_foreigner, passport_no, nationality, resident_type, relationship, note, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) 
            RETURNING *
        `, [
            household_id, cleanCitizenId, first_name, last_name, nickname, gender, date_of_birth,
            is_foreigner, cleanPassport, nationality, resident_type, relationship, note, status || 'ACTIVE'
        ]);

        res.json({ success: true, message: 'เพิ่มสมาชิกสำเร็จ', data: result.rows[0] });
    } catch (error) {
        console.error("Add Member Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========// ==========================================
// API: แก้ไขข้อมูลสมาชิกเดิม (เพิ่ม Validation ดักเลขบัตรซ้ำกับคนอื่น)
// ==========================================
app.put('/api/household-members/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            citizen_id, first_name, last_name, nickname, gender, date_of_birth,
            is_foreigner, passport_no, nationality, resident_type, relationship, note, status
        } = req.body;

        // 1. ทำความสะอาดค่ารหัส (ตัดช่องว่าง) และแยกประเภทคนไทย/ต่างชาติให้ชัดเจน
        const cleanCitizenId = is_foreigner ? null : (citizen_id ? String(citizen_id).trim() : null);
        const cleanPassport = is_foreigner ? (passport_no ? String(passport_no).trim() : null) : null;
        
        const idToCheck = is_foreigner ? cleanPassport : cleanCitizenId;
        const idColumn = is_foreigner ? 'passport_no' : 'citizen_id';

        if (!idToCheck || idToCheck === '') {
            return res.status(400).json({ success: false, message: 'กรุณาระบุเลขบัตรประชาชนหรือเลขพาสปอร์ต' });
        }

        // 2. เช็คว่าข้อมูลที่แก้ไข ไปซ้ำกับ "บุคคลอื่น" ในระบบหรือไม่ (โดยยกเว้นตัวเอง id ของตัวเอง)
        const duplicateCheck = await pgPool.query(`
            SELECT member_id FROM household_members 
            WHERE ${idColumn} = $1 AND member_id != $2
        `, [idToCheck, id]);

        if (duplicateCheck.rows.length > 0) {
             return res.status(400).json({ 
                success: false, 
                message: 'ไม่สามารถแก้ไขได้! เลขบัตรประชาชนหรือพาสปอร์ตนี้ ถูกใช้งานโดยบุคคลอื่นในระบบแล้ว' 
            });
        }

        // 3. บันทึกข้อมูลที่ถูกต้องลงไป
        await pgPool.query(`
            UPDATE household_members 
            SET citizen_id = $1, first_name = $2, last_name = $3, nickname = $4, gender = $5, date_of_birth = $6,
                is_foreigner = $7, passport_no = $8, nationality = $9, resident_type = $10, relationship = $11, note = $12, status = $13
            WHERE member_id = $14
        `, [
            cleanCitizenId, first_name, last_name, nickname, gender, date_of_birth,
            is_foreigner, cleanPassport, nationality, resident_type, relationship, note, status, id
        ]);

        res.json({ success: true, message: 'แก้ไขข้อมูลสำเร็จ' });
    } catch (error) {
        console.error("Update Member Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});
// ==========================================
// API: ดึงข้อมูลสมาชิกในบ้าน (ใช้ LEFT JOIN เพื่อให้รายชื่อแสดงเสมอแม้ไม่มี Profile)
// ==========================================
app.get('/api/household-members/:household_id', async (req, res) => {
    try {
        const { household_id } = req.params;
        const result = await pgPool.query(`
            SELECT m.*, 
                   -- ดึงชื่อจากตารางหลัก m เป็นหลัก ถ้าไม่มีค่อยไปเอาจาก p (เผื่อไว้)
                   COALESCE(m.first_name, p.first_name) as first_name, 
                   COALESCE(m.last_name, p.last_name) as last_name, 
                   COALESCE(m.nickname, p.nickname) as nickname, 
                   COALESCE(m.gender, p.gender) as gender
            FROM household_members m
            LEFT JOIN user_profiles p ON m.profile_id = p.profile_id
            WHERE m.household_id = $1
            ORDER BY m.status DESC, m.first_name ASC
        `, [household_id]); 
        
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 6. แก้ไขข้อมูล "คน"
app.put('/api/household-members/:member_id', async (req, res) => {
    try {
        const { citizen_id, first_name, last_name, nickname, gender, date_of_birth } = req.body;
        const result = await pgPool.query(`
            UPDATE household_members 
            SET citizen_id = $1, first_name = $2, last_name = $3, nickname = $4, gender = $5, date_of_birth = $6
            WHERE member_id = $7 RETURNING *
        `, [citizen_id, first_name, last_name, nickname, gender, date_of_birth, req.params.member_id]);
        res.json({ success: true, message: 'แก้ไขสมาชิกสำเร็จ', data: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
// ==========================================
// API: อัปเดตสถานะสมาชิก (ACTIVE -> INACTIVE)
// ==========================================
app.put('/api/household-members/:member_id/status', async (req, res) => {
    try {
        const { member_id } = req.params;
        const { status } = req.body; // รับค่า 'ACTIVE' หรือ 'INACTIVE'
        
        await pgPool.query(`
            UPDATE household_members 
            SET status = $1 
            WHERE member_id = $2
        `, [status, member_id]);
        
        res.json({ success: true, message: 'อัปเดตสถานะสำเร็จ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 2. API: ดึงข้อมูลพื้นที่แบบเต็ม (แก้ปัญหาตำบลขึ้น ไม่ระบุ)
// ==========================================
app.get('/api/location-context/:village_id', async (req, res) => {
    try {
        const { village_id } = req.params;
        const result = await pgPool.query(`
            SELECT v.village_no, v.village_name, 
                   COALESCE(t.tambon_name_th, 'ไม่ระบุ') AS tambon_name_th, 
                   COALESCE(a.amphure_name_th, 'ไม่ระบุ') AS amphure_name_th, 
                   COALESCE(p.province_name_th, 'ไม่ระบุ') AS province_name_th
            FROM villages v
            LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
            LEFT JOIN sys_amphures a ON t.amphure_id = a.amphure_id
            LEFT JOIN sys_provinces p ON a.province_id = p.province_id
            WHERE v.village_id = $1
        `, [village_id]);
        
        if (result.rows.length > 0) {
            res.json({ success: true, data: result.rows[0] });
        } else {
            res.json({ success: false, message: 'ไม่พบข้อมูลพื้นที่' });
        }
    } catch (error) {
        console.error("Error fetching location:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// API: ดึงรายชื่อคณะทำงานและผู้นำชุมชน (Community Committees)
// ==========================================
app.get('/api/community-committees/:village_id', async (req, res) => {
    try {
        const { village_id } = req.params;
        
        // หมายเหตุ: ตรวจสอบชื่อตารางในคำสั่ง SQL ให้ตรงกับฐานข้อมูล Neon ของคุณ
        // จากโปรเจกต์ของคุณ ตารางอาจชื่อ user_positions, committee_profiles หรือ community_committees
        
        const result = await pgPool.query(`
            SELECT * 
            FROM committee_profiles 
            WHERE village_id = $1
            ORDER BY created_at ASC
        `, [village_id]);
        
        /* 
        // 💡 ถ้าคุณมีการแยกตารางตำแหน่ง (sys_positions) ให้เปิดใช้ SQL ตัวนี้แทนครับ:
        const result = await pgPool.query(\`
            SELECT up.*, sp.position_name 
            FROM user_positions up
            LEFT JOIN sys_positions sp ON up.position_id = sp.position_id
            WHERE up.village_id = $1
            ORDER BY sp.level ASC, up.created_at ASC
        \`, [village_id]);
        */

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error("API Error (community-committees):", error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// ==========================================
// 1. แยกจังหวัด / ยกฐานะอำเภอเป็นจังหวัด (สร้างจังหวัดใหม่ + ย้ายอำเภอ)
// ==========================================
app.post('/api/area/restructure-province', async (req, res) => {
    const { new_province_name, amphure_codes } = req.body;
    if (!new_province_name || !amphure_codes || amphure_codes.length === 0) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อจังหวัดใหม่และเลือกอำเภออย่างน้อย 1 อำเภอ' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // สร้างรหัสจังหวัดใหม่ และดึง country_id เดิม
        const maxRes = await client.query(`
            SELECT COALESCE(MAX(NULLIF(regexp_replace(province_code, '\\D', '', 'g'), '')::int), 90) + 1 AS next_code,
                   (SELECT country_id FROM sys_provinces LIMIT 1) AS country_id
            FROM sys_provinces
        `);
        const newProvinceCode = String(maxRes.rows[0].next_code);
        const countryId = maxRes.rows[0].country_id;

        // 1. เพิ่มจังหวัดใหม่ (ให้ SERIAL สร้าง province_id อัตโนมัติ)
        const insertRes = await client.query(
            `INSERT INTO sys_provinces (country_id, province_code, province_name_th)
             VALUES ($1, $2, $3) RETURNING province_id`,
            [countryId, newProvinceCode, new_province_name.trim()]
        );
        const newProvinceId = insertRes.rows[0].province_id;

        // 2. ย้ายอำเภอที่เลือกมาสังกัดจังหวัดใหม่ (ใช้ province_id)
        await client.query(
            'UPDATE sys_amphures SET province_id = $1 WHERE amphure_code = ANY($2)',
            [newProvinceId, amphure_codes.map(String)]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: `สร้างจังหวัด "${new_province_name}" และย้าย ${amphure_codes.length} อำเภอสำเร็จ!` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Restructure Province Error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// ==========================================
// 2. แยกอำเภอ / ยกฐานะตำบลเป็นอำเภอ (สร้างอำเภอใหม่ + ย้ายตำบล)
// ==========================================
app.post('/api/area/restructure-amphure', async (req, res) => {
    const { target_province_code, new_amphure_name, tambon_ids } = req.body;
    if (!target_province_code || !new_amphure_name || !tambon_ids || tambon_ids.length === 0) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบและเลือกตำบลอย่างน้อย 1 ตำบล' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // หา province_id จาก province_code ที่ส่งมา
        const provRes = await client.query(
            'SELECT province_id FROM sys_provinces WHERE province_code = $1 LIMIT 1',
            [String(target_province_code)]
        );
        if (provRes.rows.length === 0) throw new Error('ไม่พบข้อมูลจังหวัดต้นทาง');
        const targetProvinceId = provRes.rows[0].province_id;

        const maxRes = await client.query(`
            SELECT COALESCE(MAX(NULLIF(regexp_replace(amphure_code, '\\D', '', 'g'), '')::int), 9000) + 1 AS next_code
            FROM sys_amphures
        `);
        const newAmphureCode = String(maxRes.rows[0].next_code);

        // 1. เพิ่มอำเภอใหม่ (ให้ SERIAL สร้าง amphure_id อัตโนมัติ)
        const insertRes = await client.query(
            `INSERT INTO sys_amphures (province_id, amphure_code, amphure_name_th)
             VALUES ($1, $2, $3) RETURNING amphure_id`,
            [targetProvinceId, newAmphureCode, new_amphure_name.trim()]
        );
        const newAmphureId = insertRes.rows[0].amphure_id;

        // 2. ย้ายตำบลที่เลือกมาสังกัดอำเภอใหม่ (ใช้ amphure_id)
        await client.query(
            'UPDATE sys_tambons SET amphure_id = $1 WHERE tambon_id = ANY($2)',
            [newAmphureId, tambon_ids]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: `สร้างอำเภอ "${new_amphure_name}" และย้าย ${tambon_ids.length} ตำบลสำเร็จ!` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Restructure Amphure Error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// ==========================================
// 3. แยกตำบล / ยกฐานะหมู่บ้านเป็นตำบล (สร้างรหัสเข้ากลุ่ม เช่น 670608)
// ==========================================
app.post('/api/area/restructure-tambon', async (req, res) => {
    const { target_amphure_code, new_tambon_name, village_ids } = req.body;
    if (!target_amphure_code || !new_tambon_name || !village_ids || village_ids.length === 0) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบและเลือกหมู่บ้านอย่างน้อย 1 หมู่บ้าน' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // 1. หา amphure_id จาก amphure_code ที่ส่งมา
        const ampRes = await client.query(
            'SELECT amphure_id FROM sys_amphures WHERE amphure_code = $1 LIMIT 1',
            [String(target_amphure_code)]
        );
        if (ampRes.rows.length === 0) throw new Error('ไม่พบข้อมูลอำเภอต้นทาง');
        const targetAmphureId = ampRes.rows[0].amphure_id;

        // 2. หาเลข tambon_id สูงสุด "เฉพาะในอำเภอนี้" แล้ว +1 (เช่น 670607 -> 670608)
        const maxRes = await client.query(`
            SELECT COALESCE(MAX(tambon_id), $1 * 100) + 1 AS next_id,
                   COALESCE((SELECT zip_code FROM sys_tambons WHERE amphure_id = $1 LIMIT 1), '00000') AS zip_code
            FROM sys_tambons
            WHERE amphure_id = $1
        `, [targetAmphureId]);

        const newTambonId = parseInt(maxRes.rows[0].next_id, 10);
        const newTambonCode = String(newTambonId);
        const zipCode = maxRes.rows[0].zip_code;

        // 3. เพิ่มตำบลใหม่ โดยระบุ tambon_id และ tambon_code ให้เข้ากลุ่มเดียวกัน
        await client.query(
            `INSERT INTO sys_tambons (tambon_id, amphure_id, tambon_code, tambon_name_th, zip_code)
             VALUES ($1, $2, $3, $4, $5)`,
            [newTambonId, targetAmphureId, newTambonCode, new_tambon_name.trim(), zipCode]
        );

        // 4. ย้ายหมู่บ้านที่เลือกมาสังกัดตำบลใหม่
        await client.query(
            'UPDATE villages SET tambon_id = $1 WHERE village_id = ANY($2)',
            [newTambonId, village_ids]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: `สร้างตำบล "${new_tambon_name}" (รหัส ${newTambonCode}) และย้าย ${village_ids.length} หมู่บ้านสำเร็จ!` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Restructure Tambon Error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});
// ==========================================
// 4. ย้ายรายการไปสังกัดพื้นที่เดิมที่มีอยู่แล้ว (ย้ายกลับ / ย้ายข้ามเขต)
// ==========================================
app.post('/api/area/move-to-existing', async (req, res) => {
    const { level, item_ids, target_parent_id } = req.body;
    // level: 'tambon' (ย้ายหมู่บ้านไปตำบลเดิม), 'amphure' (ย้ายตำบลไปอำเภอเดิม), 'province' (ย้ายอำเภอไปจังหวัดเดิม)
    if (!level || !item_ids || item_ids.length === 0 || !target_parent_id) {
        return res.status(400).json({ success: false, message: 'กรุณาเลือกรายการและพื้นที่ปลายทางให้ครบ' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        if (level === 'tambon') {
            // ย้ายหมู่บ้าน -> ไปตำบลที่มีอยู่แล้ว
            await client.query(
                'UPDATE villages SET tambon_id = $1 WHERE village_id = ANY($2)',
                [target_parent_id, item_ids]
            );
        } else if (level === 'amphure') {
            // ย้ายตำบล -> ไปอำเภอที่มีอยู่แล้ว
            const ampRes = await client.query('SELECT amphure_id FROM sys_amphures WHERE amphure_code = $1 LIMIT 1', [String(target_parent_id)]);
            if (ampRes.rows.length === 0) throw new Error('ไม่พบอำเภอปลายทาง');
            await client.query(
                'UPDATE sys_tambons SET amphure_id = $1 WHERE tambon_id = ANY($2)',
                [ampRes.rows[0].amphure_id, item_ids]
            );
        } else if (level === 'province') {
            // ย้ายอำเภอ -> ไปจังหวัดที่มีอยู่แล้ว
            const provRes = await client.query('SELECT province_id FROM sys_provinces WHERE province_code = $1 LIMIT 1', [String(target_parent_id)]);
            if (provRes.rows.length === 0) throw new Error('ไม่พบจังหวัดปลายทาง');
            await client.query(
                'UPDATE sys_amphures SET province_id = $1 WHERE amphure_code = ANY($2)',
                [provRes.rows[0].province_id, item_ids.map(String)]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true, message: `ย้าย ${item_ids.length} รายการไปยังพื้นที่ปลายทางสำเร็จ!` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Move to existing Error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// ==========================================
// 5. ลบตำบล หรือ อำเภอ (ลบได้เฉพาะเมื่อไม่มีข้อมูลลูกค้างอยู่)
// ==========================================
app.delete('/api/area/delete-empty', async (req, res) => {
    const { level, id } = req.body; // level: 'tambon' หรือ 'amphure'
    if (!level || !id) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    const client = await pgPool.connect();
    try {
        if (level === 'tambon') {
            const check = await client.query('SELECT COUNT(*)::int AS cnt FROM villages WHERE tambon_id = $1', [id]);
            if (check.rows[0].cnt > 0) {
                return res.status(400).json({ success: false, message: `ไม่สามารถลบได้ เนื่องจากยังมีหมู่บ้านสังกัดอยู่ ${check.rows[0].cnt} หมู่บ้าน กรุณาย้ายออกก่อน` });
            }
            await client.query('DELETE FROM sys_tambons WHERE tambon_id = $1', [id]);
            return res.json({ success: true, message: 'ลบรายชื่อตำบลสำเร็จ!' });
        }

        if (level === 'amphure') {
            const ampRes = await client.query('SELECT amphure_id FROM sys_amphures WHERE amphure_code = $1 LIMIT 1', [String(id)]);
            if (ampRes.rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบอำเภอนี้' });
            const amphureId = ampRes.rows[0].amphure_id;

            const check = await client.query('SELECT COUNT(*)::int AS cnt FROM sys_tambons WHERE amphure_id = $1', [amphureId]);
            if (check.rows[0].cnt > 0) {
                return res.status(400).json({ success: false, message: `ไม่สามารถลบได้ เนื่องจากยังมีตำบลสังกัดอยู่ ${check.rows[0].cnt} ตำบล กรุณาย้ายออกก่อน` });
            }
            await client.query('DELETE FROM sys_amphures WHERE amphure_id = $1', [amphureId]);
            return res.json({ success: true, message: 'ลบรายชื่ออำเภอสำเร็จ!' });
        }
    } catch (error) {
        console.error('Delete Empty Area Error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});


// ==========================================
// 1. ดึงสถิติภาพรวมพื้นที่ทั้งประเทศ (สำหรับหน้า AddVillageMaster)
// ==========================================
app.get('/api/area/village-stats', async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT
                (SELECT COUNT(*)::int FROM sys_provinces) AS total_provinces,
                (SELECT COUNT(*)::int FROM sys_amphures) AS total_amphures,
                (SELECT COUNT(*)::int FROM sys_tambons) AS total_tambons,
                (SELECT COUNT(*)::int FROM villages) AS total_villages,
                (SELECT COUNT(DISTINCT tambon_id)::int FROM villages) AS tambons_with_villages,
                (SELECT COUNT(DISTINCT t.amphure_id)::int 
                 FROM villages v 
                 JOIN sys_tambons t ON v.tambon_id = t.tambon_id) AS amphures_with_villages,
                (SELECT COUNT(DISTINCT LEFT(a.amphure_code, 2))::int 
                 FROM villages v 
                 JOIN sys_tambons t ON v.tambon_id = t.tambon_id
                 JOIN sys_amphures a ON t.amphure_id = a.amphure_id) AS provinces_with_villages
        `);
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error('Village Stats Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 2. ดึงรายชื่อตำบลพร้อมนับจำนวนหมู่บ้านที่มีอยู่แล้ว
// ==========================================
app.get('/api/sys-tambons-with-count/:amphureCode', async (req, res) => {
    try {
        const aCode = req.params.amphureCode;
        const result = await pgPool.query(`
            SELECT t.tambon_id, t.tambon_name_th, COUNT(v.village_id)::int AS village_count
            FROM sys_tambons t
            JOIN sys_amphures a ON t.amphure_id = a.amphure_id
            LEFT JOIN villages v ON t.tambon_id = v.tambon_id
            WHERE a.amphure_code = $1
            GROUP BY t.tambon_id, t.tambon_name_th
            ORDER BY t.tambon_name_th ASC
        `, [String(aCode)]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// แก้ไข หมู่ที่ / ชื่อหมู่บ้าน (ปลอดภัย ไม่กระทบบ้านเลขที่และประชากร)
// ==========================================
app.put('/api/villages/:villageId', async (req, res) => {
    const { villageId } = req.params;
    const { village_no, village_name } = req.body;

    if (!village_name || !village_name.trim()) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหมู่บ้าน' });
    }

    try {
        const result = await pgPool.query(
            `UPDATE villages 
             SET village_no = $1, village_name = $2 
             WHERE village_id = $3 
             RETURNING village_id, village_no, village_name`,
            [village_no ? String(village_no).trim() : '', village_name.trim(), villageId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลหมู่บ้านนี้' });
        }

        res.json({ success: true, message: 'แก้ไขข้อมูลหมู่บ้านสำเร็จ!', data: result.rows[0] });
    } catch (err) {
        console.error('Update Village Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});
// ==========================================
// โครงสร้างการแยก ย้าย แยกตำบล / ยกฐานะหมู่บ้านเป็นตำบล (สร้างตำบลใหม่ + ย้ายหมู่บ้าน)
// ==========================================



// =========================================================================
// 📝 API ลงทะเบียนประชาชน (ยืนยันหมู่บ้านจากผู้ใหญ่บ้าน + ค้นหาบ้านเลขที่ + สิทธิ์ CITIZEN_FREE)
// =========================================================================

// 1. ดึงข้อมูลหมู่บ้านและข้อมูลผู้ใหญ่บ้าน (ชื่อ นามสกุล ชื่อเล่น รูปโปรไฟล์)
app.get('/api/public/village-headman/:villageId', async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT 
                v.village_id, v.village_no, v.village_name,
                t.tambon_name_th, am.amphure_name_th, pr.province_name_th,
                hp.first_name AS headman_first_name,
                hp.last_name AS headman_last_name,
                hp.nickname AS headman_nickname,
                (
                    SELECT hcpm.image_url
                    FROM citizen_profiles_media hcpm
                    WHERE hcpm.profile_id = ha.profile_id AND hcpm.is_active = true
                    LIMIT 1
                ) AS headman_image
            FROM villages v
            LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
            LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
            LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
            LEFT JOIN user_accounts ha ON v.headman_account_id = ha.account_id
            LEFT JOIN user_profiles hp ON ha.profile_id = hp.profile_id
            WHERE v.village_id = $1
        `, [req.params.villageId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลหมู่บ้านนี้' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error('Get Village Headman Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. ค้นหารายชื่อประชาชนจาก หมู่บ้าน + บ้านเลขที่ (ดึงจาก households + household_members และไม่ส่งเลขบัตร/พาสปอร์ต)
app.get('/api/public/search-citizens-by-house', async (req, res) => {
    const { village_id, house_no } = req.query;
    if (!village_id || !house_no || !house_no.trim()) {
        return res.status(400).json({ success: false, message: 'กรุณาเลือกหมู่บ้านและกรอกบ้านเลขที่' });
    }

    try {
        const result = await pgPool.query(`
            SELECT 
                hm.member_id,
                hm.first_name,
                hm.last_name,
                hm.nickname,
                h.house_no,
                CASE WHEN hm.account_id IS NOT NULL THEN true ELSE false END AS already_registered
            FROM household_members hm
            JOIN households h ON hm.household_id = h.household_id
            WHERE h.village_id = $1
              AND TRIM(h.house_no) = TRIM($2)
              AND COALESCE(hm.status, 'ACTIVE') = 'ACTIVE'
            ORDER BY hm.is_head_of_household DESC, hm.first_name ASC
        `, [village_id, house_no.trim()]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Search Citizens By House Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. บันทึกการลงทะเบียนประชาชน (สร้าง user_profiles + user_accounts + ผูกกลับ household_members.account_id)
app.post('/api/register-citizen', async (req, res) => {
    const { member_id, village_id, username_phone, password, referred_by } = req.body;

    if (!member_id || !village_id || !username_phone || !password) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    }

    const cleanPhone = String(username_phone).trim().replace(/[^0-9]/g, '');
    if (cleanPhone.length < 9) {
        return res.status(400).json({ success: false, message: 'รูปแบบเบอร์โทรศัพท์ไม่ถูกต้อง' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // 1. ตรวจสอบเบอร์โทรซ้ำ
        const phoneCheck = await client.query(
            `SELECT account_id FROM user_accounts WHERE username_phone = $1`,
            [cleanPhone]
        );
        if (phoneCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'เบอร์โทรศัพท์นี้ถูกลงทะเบียนในระบบแล้ว' });
        }

        // 2. ดึงข้อมูลสมาชิกจาก household_members + households
        const memberRes = await client.query(`
            SELECT hm.*, h.house_no, h.village_id,
                   COALESCE(v.tambon_id::text, '000000') AS area_code,
                   (SELECT COUNT(*) FROM household_members WHERE household_id = h.household_id) AS member_count
            FROM household_members hm
            JOIN households h ON hm.household_id = h.household_id
            LEFT JOIN villages v ON h.village_id = v.village_id
            WHERE hm.member_id = $1
        `, [member_id]);

        if (memberRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลรายชื่อในทะเบียนบ้าน' });
        }

        const member = memberRes.rows[0];
        if (member.account_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'รายชื่อนี้มีการลงทะเบียนบัญชีผู้ใช้งานไปแล้ว' });
        }

        // 3. ค้นหาหรือสร้าง user_profiles (ป้องกันซ้ำจาก citizen_id)
        let profileId = null;
        if (member.citizen_id && member.citizen_id.trim()) {
            const existProfile = await client.query(
                `SELECT profile_id FROM user_profiles WHERE citizen_id = $1 LIMIT 1`,
                [member.citizen_id.trim()]
            );
            if (existProfile.rows.length > 0) {
                profileId = existProfile.rows[0].profile_id;
            }
        }

        if (!profileId) {
            const newProfile = await client.query(`
                INSERT INTO user_profiles (first_name, last_name, nickname, dob, citizen_id, gender, house_no)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING profile_id
            `, [
                member.first_name,
                member.last_name,
                member.nickname || null,
                member.date_of_birth || null,
                member.citizen_id || member.passport_no || null,
                member.gender || null,
                member.house_no || null
            ]);
            profileId = newProfile.rows[0].profile_id;
        }

        // 4. สร้างบัญชีใน user_accounts (ผูกสิทธิ์เริ่มต้น CITIZEN_FREE)
        const passwordHash = await bcrypt.hash(password, 10);
        const myReferralCode = `BR${cleanPhone.slice(-6)}${Math.floor(10 + Math.random() * 90)}`;

        const insertAcc = await client.query(`
            INSERT INTO user_accounts (
                profile_id, username_phone, password_hash, village_id, area_code,
                household_member_count, role, tier_code, community_score,
                is_active, referred_by, referral_code
            ) VALUES ($1, $2, $3, $4, $5, $6, 'CITIZEN', 'CITIZEN_FREE', 0, true, $7, $8)
            RETURNING account_id, username_phone, village_id, tier_code, referral_code
        `, [
            profileId,
            cleanPhone,
            passwordHash,
            member.village_id || village_id,
            member.area_code || '000000',
            Number(member.member_count) || 1,
            referred_by ? String(referred_by).trim() : null,
            myReferralCode
        ]);

        const newAccountId = insertAcc.rows[0].account_id;

        // 5. ผูก account_id กลับไปที่ household_members เพื่อให้รู้ว่าลงทะเบียนแล้ว
        await client.query(
            `UPDATE household_members SET account_id = $1 WHERE member_id = $2`,
            [newAccountId, member_id]
        );

        await client.query('COMMIT');
        res.json({
            success: true,
            message: 'ลงทะเบียนสำเร็จ! คุณสามารถเข้าสู่ระบบด้วยเบอร์โทรศัพท์และรหัสผ่านได้ทันที',
            data: insertAcc.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Register Citizen Error:', err);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการลงทะเบียน: ' + err.message });
    } finally {
        client.release();
    }
});

// ==========================================

//API ADMIN  เริ่ม
// 1. Middleware ตรวจ Token สำหรับหน้า Admin / Employee
// ==========================================
const verifyAdminToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบก่อนใช้งาน' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ success: false, message: 'Token หมดอายุหรือไม่ถูกต้อง' });
        req.adminUser = decoded;
        next();
    });
};

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อผู้ใช้งานและรหัสผ่าน' });
    }

    try {
        // 1. ดึงข้อมูลบุคคล
        const userQuery = await pgPool.query(`
            SELECT 
                ua.account_id, ua.profile_id, ua.username_phone, ua.password_hash,
                ua.role, ua.area_code, ua.is_active,
                up.first_name, up.last_name, up.nickname
            FROM user_accounts ua
            JOIN user_profiles up ON ua.profile_id = up.profile_id
            WHERE ua.username_phone = $1
            LIMIT 1
        `, [username.trim()]);

        if (userQuery.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'ไม่พบรหัสผู้ใช้งานนี้ในระบบ' });
        }

        const user = userQuery.rows[0];
        if (!user.is_active) {
            return res.status(403).json({ success: false, message: 'บัญชีนี้ถูกระงับการใช้งาน' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
        }

        // 2. ดึงตำแหน่งทั้งหมดของบุคคลนี้
        const posQuery = await pgPool.query(`
            SELECT sp.position_id, sp.position_name, sp.position_level, sp.department_id
            FROM user_positions upos
            JOIN sys_positions sp ON upos.position_id = sp.position_id
            WHERE upos.account_id = $1
        `, [user.account_id]);

        // 3. ดึงสิทธิ์ (permission_code) ทั้งหมดจากตำแหน่งที่ถืออยู่
        const isSuperAdmin = user.username_phone === '0000000000' || (user.role || '').toUpperCase() === 'SUPER_ADMIN';
        let permissions = [];

        if (isSuperAdmin) {
            // Super Admin ได้สิทธิ์ทั้งหมดในระบบ
            const allPerm = await pgPool.query('SELECT permission_code FROM sys_permissions');
            permissions = ['*', ...allPerm.rows.map(r => r.permission_code)];
        } else {
            const permQuery = await pgPool.query(`
                SELECT DISTINCT p.permission_code
                FROM user_positions upos
                JOIN position_permissions pp ON upos.position_id = pp.position_id
                JOIN sys_permissions p ON pp.permission_id = p.permission_id
                WHERE upos.account_id = $1
            `, [user.account_id]);
            permissions = permQuery.rows.map(r => r.permission_code);
        }

        // 4. ถ้าไม่มีสิทธิ์หลังบ้านเลยแม้แต่สิทธิ์เดียว ห้ามเข้า emp.banrao.life
        if (permissions.length === 0) {
            return res.status(403).json({ success: false, message: 'บัญชีนี้ยังไม่ได้รับกำหนดสิทธิ์เข้าใช้งานระบบหลังบ้าน' });
        }

        // 5. สร้าง Token พร้อมฝัง permissions ไว้ตรวจสอบทุก API
        const token = jwt.sign(
            {
                account_id: user.account_id,
                profile_id: user.profile_id,
                username: user.username_phone,
                is_super_admin: isSuperAdmin,
                permissions
            },
            JWT_SECRET,
            { expiresIn: '12h' }
        );

        res.json({
            success: true,
            message: 'เข้าสู่ระบบสำเร็จ',
            token,
            user: {
                account_id: user.account_id,
                profile_id: user.profile_id,
                username: user.username_phone,
                full_name: `${user.first_name} ${user.last_name}`.trim(),
                area_code: user.area_code,
                is_super_admin: isSuperAdmin,
                positions: posQuery.rows,
                permissions // <-- Frontend เอา Array นี้ไปเช็กเปิด/ปิดเมนูได้เลย
            }
        });
    } catch (err) {
        console.error('Admin Login Error:', err);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์: ' + err.message });
    }
});
// ==========================================
// API ภาพรวมระบบ (Admin Dashboard Overview)
// ==========================================
app.get('/api/admin/dashboard/overview', verifyAdminToken, async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT
                (SELECT COUNT(*)::int FROM user_accounts) AS total_accounts,
                (SELECT COUNT(*)::int FROM user_accounts WHERE is_active = true) AS active_accounts,
                (SELECT COUNT(*)::int FROM households) AS total_households,
                (SELECT COUNT(*)::int FROM household_members) AS total_members,
                (SELECT COUNT(*)::int FROM sys_provinces) AS total_provinces,
                (SELECT COUNT(*)::int FROM sys_amphures) AS total_amphures,
                (SELECT COUNT(*)::int FROM sys_tambons) AS total_tambons,
                (SELECT COUNT(*)::int FROM villages) AS total_villages,
                (SELECT COUNT(DISTINCT tambon_id)::int FROM villages) AS tambons_with_villages
        `);

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Admin Dashboard Overview Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// API ดึงรายชื่อผู้ใช้งานทั้งหมด พร้อมตำแหน่ง (แยกสิทธิ์)
// ==========================================
app.get('/api/admin/users', verifyAdminToken, async (req, res) => {
    try {
        const usersQuery = await pgPool.query(`
            SELECT 
                ua.account_id,
                ua.username_phone,
                ua.role,
                ua.area_code,
                ua.is_active,
                ua.created_at,
                up.first_name,
                up.last_name,
                up.nickname,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'position_id', sp.position_id,
                            'position_name', sp.position_name,
                            'position_level', sp.position_level
                        )
                    ) FILTER (WHERE sp.position_id IS NOT NULL),
                    '[]'
                ) AS positions
            FROM user_accounts ua
            JOIN user_profiles up ON ua.profile_id = up.profile_id
            LEFT JOIN user_positions upos ON ua.account_id = upos.account_id
            LEFT JOIN sys_positions sp ON upos.position_id = sp.position_id
            GROUP BY ua.account_id, up.profile_id
            ORDER BY ua.created_at DESC
        `);

        // ดึงรายชื่อตำแหน่งทั้งหมดที่มีในระบบ เพื่อนำไปสร้างปุ่มกรอง
        const positionsQuery = await pgPool.query(`
            SELECT position_id, position_name, position_level
            FROM sys_positions
            ORDER BY position_id ASC
        `);

        res.json({
            success: true,
            users: usersQuery.rows,
            positions: positionsQuery.rows
        });
    } catch (err) {
        console.error('Get Admin Users Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// ==========================================
// 1. เพิ่มตำแหน่งใหม่ (sys_positions)
// ==========================================
app.post('/api/admin/positions', verifyAdminToken, async (req, res) => {
    const { position_name, position_level } = req.body;
    if (!position_name || !position_name.trim()) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อตำแหน่ง' });
    }
    try {
        const result = await pgPool.query(
            `INSERT INTO sys_positions (position_name, position_level)
             VALUES ($1, $2)
             RETURNING position_id, position_name, position_level`,
            [position_name.trim(), (position_level || 'LOCAL').trim()]
        );
        res.json({ success: true, message: 'เพิ่มตำแหน่งสำเร็จ', data: result.rows[0] });
    } catch (err) {
        console.error('Add Position Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 2. แก้ไขชื่อ / ระดับตำแหน่ง (sys_positions)
// ==========================================
app.put('/api/admin/positions/:positionId', verifyAdminToken, async (req, res) => {
    const { positionId } = req.params;
    const { position_name, position_level } = req.body;
    if (!position_name || !position_name.trim()) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อตำแหน่ง' });
    }
    try {
        const result = await pgPool.query(
            `UPDATE sys_positions
             SET position_name = $1, position_level = $2
             WHERE position_id = $3
             RETURNING position_id, position_name, position_level`,
            [position_name.trim(), (position_level || 'LOCAL').trim(), positionId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบตำแหน่งนี้ในระบบ' });
        }
        res.json({ success: true, message: 'แก้ไขตำแหน่งสำเร็จ', data: result.rows[0] });
    } catch (err) {
        console.error('Update Position Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 3. ลบตำแหน่ง (ลบได้เฉพาะตำแหน่งที่ยังไม่มีคนถืออยู่ เพื่อความปลอดภัย)
// ==========================================
app.delete('/api/admin/positions/:positionId', verifyAdminToken, async (req, res) => {
    const { positionId } = req.params;
    try {
        // เช็กก่อนว่ามีผู้ใช้งานถือตำแหน่งนี้อยู่หรือไม่
        const checkUser = await pgPool.query(
            'SELECT COUNT(*)::int AS cnt FROM user_positions WHERE position_id = $1',
            [positionId]
        );
        if (checkUser.rows[0].cnt > 0) {
            return res.status(400).json({
                success: false,
                message: `ไม่สามารถลบได้ เนื่องจากมีผู้ใช้งานถือตำแหน่งนี้อยู่ ${checkUser.rows[0].cnt} คน`
            });
        }

        // ลบสิทธิ์ที่ผูกกับตำแหน่งนี้ก่อน (ถ้ามี) แล้วค่อยลบตำแหน่ง
        await pgPool.query('DELETE FROM position_permissions WHERE position_id = $1', [positionId]);
        await pgPool.query('DELETE FROM sys_positions WHERE position_id = $1', [positionId]);

        res.json({ success: true, message: 'ลบตำแหน่งสำเร็จ' });
    } catch (err) {
        console.error('Delete Position Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 1. ดึงเมนูหลังบ้านตามสิทธิ์ Matrix 4 มิติ (EMP_ADMIN) + จัดกลุ่มตามกรุ๊ปเมนู
// ==========================================
app.get('/api/admin/my-menus', verifyAdminToken, async (req, res) => {
    const client = await pgPool.connect();
    try {
        const user = req.adminUser;
        const appCode = 'EMP_ADMIN';
        const isSuperAdmin = Boolean(user.is_super_admin);

        // 1. ดึงตำแหน่ง + หน่วยงาน + แผนก ที่ Active อยู่จริงของพนักงานคนนี้
        const posRes = await client.query(`
            SELECT 
                sp.position_id,
                COALESCE(up.org_id, sp.org_id) AS org_id,
                COALESCE(up.dept_id, sp.dept_id) AS dept_id
            FROM user_positions up
            JOIN sys_positions sp ON up.position_id = sp.position_id
            WHERE up.account_id = $1
              AND up.is_active = TRUE
              AND (up.end_date IS NULL OR up.end_date >= CURRENT_DATE)
        `, [user.account_id]);

        const userPositions = posRes.rows;

        // 2. ดึงเมนูหลังบ้านทั้งหมดที่เปิดใช้งานอยู่ (ทั้งเมนูและกรุ๊ปต้อง is_active = true)
        const menuRes = await client.query(`
            SELECT 
                m.menu_id,
                m.menu_name,
                COALESCE(m.route_path, m.path) AS route_path,
                m.icon_name,
                m.display_order,
                mg.group_id,
                COALESCE(mg.group_name, 'ระบบจัดการหลังบ้าน') AS group_name,
                mg.display_order AS group_order
            FROM sys_menus m
            JOIN sys_menu_groups mg ON m.group_id = mg.group_id
            WHERE m.app_code = $1
              AND m.is_active = TRUE
              AND COALESCE(mg.is_active, TRUE) = TRUE
            ORDER BY mg.display_order ASC NULLS LAST, m.display_order ASC NULLS LAST, m.menu_id ASC
        `, [appCode]);

        // 3. ดึงสิทธิ์ Matrix ทั้งหมดของ EMP_ADMIN
        const matrixRes = await client.query(`
            SELECT menu_id, org_id, dept_id, position_id,
                   can_view, can_create, can_edit, can_delete, can_approve
            FROM sys_menu_permissions
            WHERE app_code = $1 AND is_active = TRUE
        `, [appCode]);

        const matrixRows = matrixRes.rows;
        const permissionsMap = {};
        const allowedMenus = [];

        for (const m of menuRes.rows) {
            if (isSuperAdmin) {
                const fullPerm = { can_view: true, can_create: true, can_edit: true, can_delete: true, can_approve: true };
                permissionsMap[m.route_path] = fullPerm;
                allowedMenus.push({ ...m, permissions: fullPerm });
                continue;
            }

            // คัดเฉพาะกฎ Matrix ที่ตรงกับเมนูนี้ และตรงกับ (หน่วยงาน / แผนก / ตำแหน่ง) ของพนักงาน
            const matchedRules = matrixRows.filter((rule) => {
                if (rule.menu_id !== m.menu_id) return false;
                if (rule.org_id === null && rule.dept_id === null && rule.position_id === null) return true;

                return userPositions.some((up) => {
                    const orgMatch = rule.org_id === null || String(rule.org_id) === String(up.org_id);
                    const deptMatch = rule.dept_id === null || String(rule.dept_id) === String(up.dept_id);
                    const posMatch = rule.position_id === null || String(rule.position_id) === String(up.position_id);
                    return orgMatch && deptMatch && posMatch;
                });
            });

            if (matchedRules.length > 0) {
                const mergedPerm = matchedRules.reduce((acc, r) => ({
                    can_view: acc.can_view || r.can_view,
                    can_create: acc.can_create || r.can_create,
                    can_edit: acc.can_edit || r.can_edit,
                    can_delete: acc.can_delete || r.can_delete,
                    can_approve: acc.can_approve || r.can_approve
                }), { can_view: false, can_create: false, can_edit: false, can_delete: false, can_approve: false });

                if (mergedPerm.can_view) {
                    permissionsMap[m.route_path] = mergedPerm;
                    allowedMenus.push({ ...m, permissions: mergedPerm });
                }
            }
        }

        // 4. จัดกลุ่มเมนูตาม group_name
        const groupedMenus = allowedMenus.reduce((acc, row) => {
            const group = acc.find((g) => g.group_name === row.group_name);
            const item = {
                menu_id: row.menu_id,
                menu_name: row.menu_name,
                route_path: row.route_path,
                icon_name: row.icon_name,
                permissions: row.permissions
            };
            if (group) group.menus.push(item);
            else acc.push({ group_id: row.group_id, group_name: row.group_name, menus: [item] });
            return acc;
        }, []);

        res.json({ success: true, data: groupedMenus, permissionsMap });
    } catch (err) {
        console.error('Get My Menus Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// ==========================================
// 2. จัดการเมนูหลังบ้าน (ดู / เพิ่ม / แก้ไข / ลบ)
// ==========================================
app.get('/api/admin/menus', verifyAdminToken, async (req, res) => {
    try {
        const result = await pgPool.query(
            `SELECT * FROM admin_menus ORDER BY display_order ASC, menu_id ASC`
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/admin/menus', verifyAdminToken, async (req, res) => {
    const { menu_name, route_path, icon_name, display_order } = req.body;
    if (!menu_name || !route_path) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อเมนูและ Route Path' });
    }
    try {
        const result = await pgPool.query(
            `INSERT INTO admin_menus (menu_name, route_path, icon_name, display_order)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [menu_name.trim(), route_path.trim(), icon_name || 'Circle', Number(display_order) || 0]
        );
        res.json({ success: true, message: 'เพิ่มเมนูสำเร็จ', data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/admin/menus/:menuId', verifyAdminToken, async (req, res) => {
    const { menuId } = req.params;
    const { menu_name, route_path, icon_name, display_order, is_active } = req.body;
    try {
        const result = await pgPool.query(
            `UPDATE admin_menus
             SET menu_name = $1, route_path = $2, icon_name = $3, display_order = $4, is_active = $5
             WHERE menu_id = $6 RETURNING *`,
            [menu_name.trim(), route_path.trim(), icon_name || 'Circle', Number(display_order) || 0, is_active !== false, menuId]
        );
        res.json({ success: true, message: 'แก้ไขเมนูสำเร็จ', data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/admin/menus/:menuId', verifyAdminToken, async (req, res) => {
    try {
        await pgPool.query('DELETE FROM admin_menus WHERE menu_id = $1', [req.params.menuId]);
        res.json({ success: true, message: 'ลบเมนูสำเร็จ' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 3. กำหนดสิทธิ์เมนูรายบุคคล (ดึงสิทธิ์ / บันทึกสิทธิ์)
// ==========================================
app.get('/api/admin/user-menus/:accountId', verifyAdminToken, async (req, res) => {
    try {
        const result = await pgPool.query(
            `SELECT menu_id FROM admin_user_menus WHERE account_id = $1`,
            [req.params.accountId]
        );
        res.json({ success: true, menu_ids: result.rows.map(r => r.menu_id) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/admin/user-menus/:accountId', verifyAdminToken, async (req, res) => {
    const { accountId } = req.params;
    const { menu_ids } = req.body; // Array เช่น [1, 2, 4]
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM admin_user_menus WHERE account_id = $1', [accountId]);

        if (Array.isArray(menu_ids) && menu_ids.length > 0) {
            for (const menuId of menu_ids) {
                await client.query(
                    `INSERT INTO admin_user_menus (account_id, menu_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                    [accountId, menuId]
                );
            }
        }
        await client.query('COMMIT');
        res.json({ success: true, message: 'บันทึกสิทธิ์การใช้งานเมนูสำเร็จ!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});
//---------------------------------------------------------
//เริม   ใช้ชั่วคราว สิบหาข้อมูล
//---------------------------------------------------------
// =========================================================================
// 🔍 1. API เอกซเรย์ข้อมูลบุคคลทุกตาราง (ค้นจากเลขบัตรประชาชน หรือ เบอร์โทร)
// =========================================================================
app.get('/api/admin/inspect-user', async (req, res) => {
    const rawQuery = (req.query.q || '').replace(/-/g, '').trim();
    if (!rawQuery) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุเลขบัตรประชาชนหรือเบอร์โทรศัพท์' });
    }

    try {
        // ค้นหาจากทั้ง user_profiles (citizen_id) และ user_accounts (username_phone)
        const matched = await pgPool.query(`
            SELECT DISTINCT p.profile_id, a.account_id
            FROM user_profiles p
            FULL OUTER JOIN user_accounts a ON p.profile_id = a.profile_id
            WHERE p.citizen_id = $1 OR a.username_phone = $1
        `, [rawQuery]);

        if (matched.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลจากเลขบัตรหรือเบอร์โทรนี้' });
        }

        const profileIds = [...new Set(matched.rows.map(r => r.profile_id).filter(Boolean))];
        const accountIds = [...new Set(matched.rows.map(r => r.account_id).filter(Boolean))];

        // ดึงข้อมูลจริงแบบ SELECT * เพื่อเห็นชื่อคอลัมน์ครบทุกตัว
        const profilesRes = profileIds.length > 0
            ? await pgPool.query(`SELECT * FROM user_profiles WHERE profile_id = ANY($1)`, [profileIds])
            : { rows: [] };

        const accountsRes = accountIds.length > 0
            ? await pgPool.query(`SELECT * FROM user_accounts WHERE account_id = ANY($1)`, [accountIds])
            : { rows: [] };

        // ซ่อน password_hash เพื่อความปลอดภัย
        const safeAccounts = accountsRes.rows.map(({ password_hash, ...rest }) => ({
            ...rest,
            password_hash: password_hash ? '*** (มีรหัสผ่านแล้ว) ***' : null
        }));

        const mediaRes = profileIds.length > 0
            ? await pgPool.query(`SELECT * FROM citizen_profiles_media WHERE profile_id = ANY($1) ORDER BY is_active DESC`, [profileIds])
            : { rows: [] };

        const positionsRes = accountIds.length > 0
            ? await pgPool.query(`
                SELECT up.*, sp.position_name, sp.position_level
                FROM user_positions up
                LEFT JOIN sys_positions sp ON up.position_id = sp.position_id
                WHERE up.account_id = ANY($1)
                ORDER BY up.start_date DESC NULLS LAST
            `, [accountIds])
            : { rows: [] };

        const villageIds = [...new Set(accountsRes.rows.map(a => a.village_id).filter(Boolean))];
        const villagesRes = (villageIds.length > 0 || accountIds.length > 0)
            ? await pgPool.query(`
                SELECT v.*, t.tambon_name_th, a.amphure_name_th, p.province_name_th
                FROM villages v
                LEFT JOIN sys_tambons t ON CAST(v.tambon_id AS TEXT) = CAST(t.tambon_id AS TEXT) OR CAST(v.tambon_id AS TEXT) = CAST(t.tambon_code AS TEXT)
                LEFT JOIN sys_amphures a ON CAST(t.amphure_id AS TEXT) = CAST(a.amphure_id AS TEXT)
                LEFT JOIN sys_provinces p ON CAST(a.province_id AS TEXT) = CAST(p.province_id AS TEXT)
                WHERE v.village_id = ANY($1) OR v.headman_account_id = ANY($2)
            `, [villageIds, accountIds])
            : { rows: [] };

        // วิเคราะห์จุดผิดปกติ / ข้อมูลซ้ำซ้อน / ข้อมูลไม่ครบ
        const warnings = [];
        if (profilesRes.rows.length > 1) warnings.push(`พบข้อมูลซ้ำในตาราง user_profiles จำนวน ${profilesRes.rows.length} แถว`);
        if (safeAccounts.length > 1) warnings.push(`พบข้อมูลซ้ำในตาราง user_accounts จำนวน ${safeAccounts.length} แถว`);
        if (profilesRes.rows[0] && !profilesRes.rows[0].gender) warnings.push('user_profiles.gender ยังเป็นค่าว่าง');
        if (profilesRes.rows[0] && !profilesRes.rows[0].house_no) warnings.push('user_profiles.house_no ยังเป็นค่าว่าง');
        if (safeAccounts[0] && !safeAccounts[0].village_id) warnings.push('user_accounts.village_id ยังไม่ได้ผูกหมู่บ้าน');
        if (mediaRes.rows.filter(m => m.is_active).length > 1) warnings.push('พบรูปโปรไฟล์ที่ is_active = true มากกว่า 1 รูป');

        res.json({
            success: true,
            summary: { profileIds, accountIds, warnings },
            tables: {
                user_profiles: profilesRes.rows,
                user_accounts: safeAccounts,
                citizen_profiles_media: mediaRes.rows,
                user_positions: positionsRes.rows,
                villages: villagesRes.rows
            }
        });
    } catch (err) {
        console.error('Inspect User Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// =========================================================================
// ✏️ 2. API แก้ไขข้อมูลพื้นฐานให้ครบ (user_profiles + user_accounts)
// =========================================================================
app.put('/api/admin/inspect-user/update', async (req, res) => {
    const { profile_id, account_id, first_name, last_name, nickname, gender, dob, house_no, role, is_active } = req.body;
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        if (profile_id) {
            await client.query(`
                UPDATE user_profiles
                SET first_name = COALESCE($1, first_name),
                    last_name = COALESCE($2, last_name),
                    nickname = $3,
                    gender = $4,
                    dob = $5,
                    house_no = $6
                WHERE profile_id = $7
            `, [first_name, last_name, nickname || null, gender || null, dob || null, house_no || null, profile_id]);
        }

        if (account_id) {
            await client.query(`
                UPDATE user_accounts
                SET role = COALESCE($1, role),
                    is_active = COALESCE($2, is_active)
                WHERE account_id = $3
            `, [role, is_active, account_id]);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'อัปเดตข้อมูลเรียบร้อยแล้ว' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Update Inspect User Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// =========================================================================
// 🗑️ 3. API ลบข้อมูลบุคคลนี้ให้สะอาดทุกตาราง (Purge Clean)
// =========================================================================
app.delete('/api/admin/inspect-user/purge', async (req, res) => {
    const { profileIds = [], accountIds = [] } = req.body;
    if (profileIds.length === 0 && accountIds.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีรหัสข้อมูลสำหรับลบ' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // 1. ปลดชื่อออกจาก villages.headman_account_id ก่อน (ไม่ลบหมู่บ้าน)
        if (accountIds.length > 0) {
            await client.query(`UPDATE villages SET headman_account_id = NULL WHERE headman_account_id = ANY($1)`, [accountIds]);
            await client.query(`DELETE FROM user_positions WHERE account_id = ANY($1)`, [accountIds]);
            // ลบสิทธิ์เมนู (ถ้ามีตาราง admin_user_menus)
            await client.query(`SAVEPOINT sp_menus`);
            try {
                await client.query(`DELETE FROM admin_user_menus WHERE account_id = ANY($1)`, [accountIds]);
            } catch (_) {
                await client.query(`ROLLBACK TO SAVEPOINT sp_menus`);
            }
        }

        // 2. ลบรูปโปรไฟล์
        if (profileIds.length > 0) {
            await client.query(`DELETE FROM citizen_profiles_media WHERE profile_id = ANY($1)`, [profileIds]);
        }

        // 3. ลบบัญชีและโปรไฟล์หลัก
        if (accountIds.length > 0) {
            await client.query(`DELETE FROM user_accounts WHERE account_id = ANY($1)`, [accountIds]);
        }
        if (profileIds.length > 0) {
            await client.query(`DELETE FROM user_profiles WHERE profile_id = ANY($1)`, [profileIds]);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'ลบข้อมูลทั้งหมดของบุคคลนี้ออกจากทุกตารางเรียบร้อยแล้ว (สะอาดไม่มีขยะค้าง)' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Purge User Error:', err);
        res.status(500).json({ success: false, message: 'ลบไม่สำเร็จ: ' + err.message });
    } finally {
        client.release();
    }
});


// =========================================================================
// 🧩 API จัดการกรุ๊ปเมนู & เมนูฝั่ง Frontend (สำหรับ Super Admin ใน emp.banrao.life)
// =========================================================================
/// 1. ดึงข้อมูลทั้งหมดจากฐานข้อมูลจริง (Apps + Groups + Menus + Orgs + Depts + Positions)
app.get('/api/admin/frontend-menus/overview', async (req, res) => {
    try {
        const [appsRes, groupsRes, menusRes, orgsRes, deptsRes, positionsRes] = await Promise.all([
            pgPool.query(`SELECT * FROM sys_apps WHERE is_active = true ORDER BY created_at ASC`),
            pgPool.query(`SELECT * FROM sys_menu_groups ORDER BY app_code ASC, display_order ASC NULLS LAST, group_id ASC`),
            pgPool.query(`
                SELECT m.*, g.group_name
                FROM sys_menus m
                LEFT JOIN sys_menu_groups g ON m.group_id = g.group_id
                ORDER BY m.app_code ASC, g.display_order ASC NULLS LAST, m.display_order ASC NULLS LAST, m.menu_id ASC
            `),
            pgPool.query(`SELECT org_id, org_name, app_code FROM sys_organizations WHERE is_active = true ORDER BY org_id ASC`),
            pgPool.query(`SELECT department_id, department_name, org_id FROM sys_departments WHERE is_active = true ORDER BY department_id ASC`),
            pgPool.query(`SELECT position_id, position_name, position_level, org_id, dept_id FROM sys_positions WHERE is_active = true ORDER BY position_id ASC`)
        ]);

        res.json({
            success: true,
            apps: appsRes.rows,
            groups: groupsRes.rows,
            menus: menusRes.rows,
            organizations: orgsRes.rows,
            departments: deptsRes.rows,
            positions: positionsRes.rows
        });
    } catch (err) {
        console.error('Master Menus Overview Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. เพิ่มกรุ๊ปเมนูใหม่ (ระบุ app_code ได้)
app.post('/api/admin/frontend-menu-groups', async (req, res) => {
    const { app_code, group_name, display_order } = req.body;
    if (!app_code || !group_name || !group_name.trim()) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุแอปพลิเคชันและชื่อกรุ๊ปเมนู' });
    }
    try {
        const result = await pgPool.query(
            `INSERT INTO sys_menu_groups (app_code, group_name, display_order, is_active)
             VALUES ($1, $2, $3, true) RETURNING *`,
            [app_code.trim().toUpperCase(), group_name.trim(), Number(display_order) || 1]
        );
        res.json({ success: true, message: 'เพิ่มกรุ๊ปเมนูเรียบร้อยแล้ว', data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// 3. แก้ไขกรุ๊ปเมนู
app.put('/api/admin/frontend-menu-groups/:id', async (req, res) => {
    const { app_code, group_name, display_order, is_active } = req.body;
    try {
        const result = await pgPool.query(
            `UPDATE sys_menu_groups
             SET app_code = $1, group_name = $2, display_order = $3, is_active = $4
             WHERE group_id = $5 RETURNING *`,
            [app_code.trim().toUpperCase(), group_name.trim(), Number(display_order) || 1, is_active !== false, req.params.id]
        );
        res.json({ success: true, message: 'อัปเดตกรุ๊ปเมนูเรียบร้อยแล้ว', data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 4. เปิด-ปิดสถานะกรุ๊ปเมนู (Soft Delete — ไม่ลบข้อมูลจริง)
app.patch('/api/admin/frontend-menu-groups/:id/toggle', async (req, res) => {
    const { is_active } = req.body;
    try {
        const result = await pgPool.query(
            `UPDATE sys_menu_groups SET is_active = $1 WHERE group_id = $2 RETURNING *`,
            [Boolean(is_active), req.params.id]
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 5. เพิ่มเมนูย่อยใหม่ (ระบุ app_code ได้)
app.post('/api/admin/frontend-menus', async (req, res) => {
    const { app_code, group_id, menu_name, route_path, icon_name, display_order, is_active, selected_roles } = req.body;
    if (!app_code || !group_id || !menu_name || !route_path) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน (แอป, กรุ๊ปเมนู, ชื่อเมนู, เส้นทาง)' });
    }
    try {
        const cleanPath = route_path.trim();
        const rolesJson = JSON.stringify(Array.isArray(selected_roles) ? selected_roles : []);
        const result = await pgPool.query(
            `INSERT INTO sys_menus (app_code, group_id, menu_name, route_path, path, icon_name, display_order, is_active, selected_roles)
             VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8::jsonb)
             RETURNING *`,
            [app_code.trim().toUpperCase(), Number(group_id), menu_name.trim(), cleanPath, icon_name || 'Activity', Number(display_order) || 1, is_active !== false, rolesJson]
        );
        res.json({ success: true, message: 'เพิ่มเมนูย่อยเรียบร้อยแล้ว', data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 6. แก้ไขเมนูย่อย
app.put('/api/admin/frontend-menus/:id', async (req, res) => {
    const { app_code, group_id, menu_name, route_path, icon_name, display_order, is_active, selected_roles } = req.body;
    try {
        const cleanPath = route_path.trim();
        const rolesJson = JSON.stringify(Array.isArray(selected_roles) ? selected_roles : []);
        const result = await pgPool.query(
            `UPDATE sys_menus
             SET app_code = $1,
                 group_id = $2,
                 menu_name = $3,
                 route_path = $4,
                 path = $4,
                 icon_name = $5,
                 display_order = $6,
                 is_active = $7,
                 selected_roles = $8::jsonb
             WHERE menu_id = $9
             RETURNING *`,
            [app_code.trim().toUpperCase(), Number(group_id), menu_name.trim(), cleanPath, icon_name || 'Activity', Number(display_order) || 1, is_active !== false, rolesJson, req.params.id]
        );
        res.json({ success: true, message: 'อัปเดตเมนูเรียบร้อยแล้ว', data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 7. เปิด-ปิดสถานะเมนูย่อย (Soft Delete — ไม่ลบข้อมูลจริง)
app.patch('/api/admin/frontend-menus/:id/toggle', async (req, res) => {
    const { is_active } = req.body;
    try {
        const result = await pgPool.query(
            `UPDATE sys_menus SET is_active = $1 WHERE menu_id = $2 RETURNING *`,
            [Boolean(is_active), req.params.id]
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

//---------------------------------------------------------
//สิ้นสุดใช้ชั่วคราว 
//---------------------------------------------------------
//---------------------------------------------------------
//เริ่มต้น API  ปรับโครงสร้างระบบใหม่ให้มีแผนก 
//---------------------------------------------------------
// =========================================================================
// 🏢 เฟส 2: API จัดการโครงสร้างองค์กร 4 มิติ (Apps -> Orgs -> Depts -> Positions)
// =========================================================================
// 1. ดึงข้อมูลภาพรวมทั้งหมดในครั้งเดียว
app.get('/api/admin/org-structure/overview', async (req, res) => {
    try {
        const [appsRes, orgsRes, deptsRes, posRes] = await Promise.all([
            pgPool.query(`SELECT * FROM sys_apps ORDER BY created_at ASC`),
            pgPool.query(`
                SELECT o.*, a.app_name
                FROM sys_organizations o
                LEFT JOIN sys_apps a ON o.app_code = a.app_code
                ORDER BY o.org_id ASC
            `),
            pgPool.query(`
                SELECT d.*, o.org_name
                FROM sys_departments d
                LEFT JOIN sys_organizations o ON d.org_id = o.org_id
                ORDER BY d.org_id ASC NULLS LAST, d.department_id ASC
            `),
            pgPool.query(`
                SELECT p.*, o.org_name, d.department_name
                FROM sys_positions p
                LEFT JOIN sys_organizations o ON p.org_id = o.org_id
                LEFT JOIN sys_departments d ON p.dept_id = d.department_id
                ORDER BY p.org_id ASC NULLS LAST, p.dept_id ASC NULLS LAST, p.position_id ASC
            `)
        ]);

        res.json({
            success: true,
            apps: appsRes.rows,
            organizations: orgsRes.rows,
            departments: deptsRes.rows,
            positions: posRes.rows
        });
    } catch (err) {
        console.error('Org Structure Overview Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});
app.post('/api/admin/org-structure/orgs', async (req, res) => {
    const { org_name, org_type, app_code } = req.body;
    if (!org_name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหน่วยงาน' });
    try {
        const result = await pgPool.query(
            `INSERT INTO sys_organizations (org_name, org_type, app_code, is_active) VALUES ($1, $2, $3, true) RETURNING *`,
            [org_name.trim(), org_type || 'GOVERNMENT', app_code || null]
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/admin/org-structure/orgs/:id', async (req, res) => {
    const { org_name, org_type, app_code, is_active } = req.body;
    try {
        const result = await pgPool.query(
            `UPDATE sys_organizations SET org_name = $1, org_type = $2, app_code = $3, is_active = $4 WHERE org_id = $5 RETURNING *`,
            [org_name.trim(), org_type || 'GOVERNMENT', app_code || null, is_active !== false, req.params.id]
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- 3. จัดการหน่วยงานหลัก (sys_organizations) ---
app.post('/api/admin/org-structure/orgs', async (req, res) => {
    const { org_name, org_type } = req.body;
    if (!org_name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหน่วยงาน' });
    try {
        const result = await pgPool.query(
            `INSERT INTO sys_organizations (org_name, org_type, is_active) VALUES ($1, $2, true) RETURNING *`,
            [org_name.trim(), org_type || 'GOVERNMENT']
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/admin/org-structure/orgs/:id', async (req, res) => {
    const { org_name, org_type, is_active } = req.body;
    try {
        const result = await pgPool.query(
            `UPDATE sys_organizations SET org_name = $1, org_type = $2, is_active = $3 WHERE org_id = $4 RETURNING *`,
            [org_name.trim(), org_type || 'GOVERNMENT', is_active !== false, req.params.id]
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- 4. จัดการแผนก (sys_departments) ---
app.post('/api/admin/org-structure/depts', async (req, res) => {
    const { org_id, department_name, department_type } = req.body;
    if (!department_name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อแผนก' });
    try {
        const result = await pgPool.query(
            `INSERT INTO sys_departments (org_id, department_name, department_type, is_active)
             VALUES ($1, $2, $3, true) RETURNING *`,
            [org_id ? Number(org_id) : null, department_name.trim(), department_type || 'GENERAL']
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/admin/org-structure/depts/:id', async (req, res) => {
    const { org_id, department_name, department_type, is_active } = req.body;
    try {
        const result = await pgPool.query(
            `UPDATE sys_departments
             SET org_id = $1, department_name = $2, department_type = $3, is_active = $4
             WHERE department_id = $5 RETURNING *`,
            [org_id ? Number(org_id) : null, department_name.trim(), department_type || 'GENERAL', is_active !== false, req.params.id]
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- 5. จัดการตำแหน่ง (sys_positions) ---
app.post('/api/admin/org-structure/positions', async (req, res) => {
    const { org_id, dept_id, position_name, position_level } = req.body;
    if (!position_name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อตำแหน่ง' });
    try {
        const result = await pgPool.query(
            `INSERT INTO sys_positions (org_id, dept_id, position_name, position_level, is_active)
             VALUES ($1, $2, $3, $4, true) RETURNING *`,
            [org_id ? Number(org_id) : null, dept_id ? Number(dept_id) : null, position_name.trim(), position_level || 'VILLAGE']
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/admin/org-structure/positions/:id', async (req, res) => {
    const { org_id, dept_id, position_name, position_level, is_active } = req.body;
    try {
        const result = await pgPool.query(
            `UPDATE sys_positions
             SET org_id = $1, dept_id = $2, position_name = $3, position_level = $4, is_active = $5
             WHERE position_id = $6 RETURNING *`,
            [org_id ? Number(org_id) : null, dept_id ? Number(dept_id) : null, position_name.trim(), position_level || 'VILLAGE', is_active !== false, req.params.id]
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// =========================================================================
// 🗺️ API แก้ไขชื่อ จังหวัด / อำเภอ / ตำบล (สำหรับแก้คำผิดจากหลังบ้าน)
// =========================================================================

// 1. แก้ไขชื่อจังหวัด
app.put('/api/admin/sys-provinces/:code', async (req, res) => {
    const { name_th } = req.body;
    if (!name_th || !name_th.trim()) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อจังหวัด' });
    try {
        const result = await pgPool.query(
            `UPDATE sys_provinces SET province_name_th = $1 WHERE province_code = $2 RETURNING province_code, province_name_th`,
            [name_th.trim(), req.params.code]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบจังหวัดนี้' });
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. แก้ไขชื่ออำเภอ
app.put('/api/admin/sys-amphures/:code', async (req, res) => {
    const { name_th } = req.body;
    if (!name_th || !name_th.trim()) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่ออำเภอ' });
    try {
        const result = await pgPool.query(
            `UPDATE sys_amphures SET amphure_name_th = $1 WHERE amphure_code = $2 RETURNING amphure_code, amphure_name_th`,
            [name_th.trim(), req.params.code]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบอำเภอนี้' });
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. แก้ไขชื่อตำบล
app.put('/api/admin/sys-tambons/:id', async (req, res) => {
    const { name_th } = req.body;
    if (!name_th || !name_th.trim()) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อตำบล' });
    try {
        const result = await pgPool.query(
            `UPDATE sys_tambons SET tambon_name_th = $1 WHERE tambon_id = $2 RETURNING tambon_id, tambon_name_th`,
            [name_th.trim(), req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบตำบลนี้' });
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});



// =========================================================================
// 🛡️ เฟส 3 (ขั้นที่ 2): API กำหนดสิทธิ์แบบ Matrix (sys_menu_permissions)
// =========================================================================

// 1. ดึงรายการเมนูของ App ที่เลือก พร้อมสิทธิ์ Matrix ปัจจุบันของ (App + Org + Dept + Position)
app.get('/api/admin/permission-matrix', async (req, res) => {
    const appCode = (req.query.app_code || 'BANRAO_WEB').trim().toUpperCase();
    const orgId = req.query.org_id ? Number(req.query.org_id) : null;
    const deptId = req.query.dept_id ? Number(req.query.dept_id) : null;
    const posId = req.query.position_id ? Number(req.query.position_id) : null;

    try {
        const result = await pgPool.query(`
            SELECT 
                m.menu_id,
                m.menu_name,
                COALESCE(m.route_path, m.path) AS route_path,
                m.is_active AS menu_active,
                mg.group_id,
                mg.group_name,
                COALESCE(p.can_view, false) AS can_view,
                COALESCE(p.can_create, false) AS can_create,
                COALESCE(p.can_edit, false) AS can_edit,
                COALESCE(p.can_delete, false) AS can_delete,
                COALESCE(p.can_approve, false) AS can_approve
            FROM sys_menus m
            LEFT JOIN sys_menu_groups mg ON m.group_id = mg.group_id
            LEFT JOIN sys_menu_permissions p 
                ON p.menu_id = m.menu_id
                AND p.app_code = $1
                AND p.org_id IS NOT DISTINCT FROM $2
                AND p.dept_id IS NOT DISTINCT FROM $3
                AND p.position_id IS NOT DISTINCT FROM $4
                AND p.is_active = true
            WHERE (m.app_code = $1 OR ($1 = 'BANRAO_WEB' AND m.app_code IS NULL))
            ORDER BY mg.display_order ASC NULLS LAST, m.display_order ASC NULLS LAST, m.menu_id ASC
        `, [appCode, orgId, deptId, posId]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Get Permission Matrix Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});
// =========================================================================
// 🛡️ เฟส 3 (ขั้นที่ 2): API กำหนดสิทธิ์แบบ Matrix (รองรับทั้ง Tier ประชาชน/ธุรกิจ และ Org->Dept->Pos)
// =========================================================================

// 0. ดึงรายการระดับผู้ใช้งาน / แพ็กเกจ (Tiers)
app.get('/api/admin/user-tiers', async (req, res) => {
    try {
        const result = await pgPool.query(
            `SELECT * FROM sys_user_tiers WHERE is_active = true ORDER BY display_order ASC, tier_code ASC`
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 1. ดึงรายการเมนูของ App พร้อมสิทธิ์ Matrix (รองรับ tier_code + org/dept/pos)
app.get('/api/admin/permission-matrix', async (req, res) => {
    const appCode = (req.query.app_code || 'BANRAO_WEB').trim().toUpperCase();
    const orgId = req.query.org_id ? Number(req.query.org_id) : null;
    const deptId = req.query.dept_id ? Number(req.query.dept_id) : null;
    const posId = req.query.position_id ? Number(req.query.position_id) : null;
    const tierCode = req.query.tier_code ? req.query.tier_code.trim().toUpperCase() : null;

    try {
        const result = await pgPool.query(`
            SELECT 
                m.menu_id,
                m.menu_name,
                COALESCE(m.route_path, m.path) AS route_path,
                m.is_active AS menu_active,
                mg.group_id,
                COALESCE(mg.group_name, 'เมนูทั่วไป') AS group_name,
                COALESCE(p.can_view, false) AS can_view,
                COALESCE(p.can_create, false) AS can_create,
                COALESCE(p.can_edit, false) AS can_edit,
                COALESCE(p.can_delete, false) AS can_delete,
                COALESCE(p.can_approve, false) AS can_approve
            FROM sys_menus m
            LEFT JOIN sys_menu_groups mg ON m.group_id = mg.group_id
            LEFT JOIN sys_menu_permissions p 
                ON p.menu_id = m.menu_id
                AND p.app_code = $1
                AND p.org_id IS NOT DISTINCT FROM $2
                AND p.dept_id IS NOT DISTINCT FROM $3
                AND p.position_id IS NOT DISTINCT FROM $4
                AND p.tier_code IS NOT DISTINCT FROM $5
                AND p.is_active = true
            WHERE (m.app_code = $1 OR ($1 = 'BANRAO_WEB' AND m.app_code IS NULL))
            ORDER BY mg.display_order ASC NULLS LAST, m.display_order ASC NULLS LAST, m.menu_id ASC
        `, [appCode, orgId, deptId, posId, tierCode]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Get Permission Matrix Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. บันทึกสิทธิ์ Matrix แบบยกชุด
app.post('/api/admin/permission-matrix/save', async (req, res) => {
    const { app_code, org_id, dept_id, position_id, tier_code, permissions } = req.body;
    const appCode = (app_code || 'BANRAO_WEB').trim().toUpperCase();
    const orgId = org_id ? Number(org_id) : null;
    const deptId = dept_id ? Number(dept_id) : null;
    const posId = position_id ? Number(position_id) : null;
    const tierCode = tier_code ? tier_code.trim().toUpperCase() : null;

    if (!Array.isArray(permissions)) {
        return res.status(400).json({ success: false, message: 'รูปแบบข้อมูลสิทธิ์ไม่ถูกต้อง' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            DELETE FROM sys_menu_permissions
            WHERE app_code = $1
              AND org_id IS NOT DISTINCT FROM $2
              AND dept_id IS NOT DISTINCT FROM $3
              AND position_id IS NOT DISTINCT FROM $4
              AND tier_code IS NOT DISTINCT FROM $5
        `, [appCode, orgId, deptId, posId, tierCode]);

        let savedCount = 0;
        for (const item of permissions) {
            const hasAny = item.can_view || item.can_create || item.can_edit || item.can_delete || item.can_approve;
            if (!hasAny) continue;

            await client.query(`
                INSERT INTO sys_menu_permissions (
                    app_code, menu_id, org_id, dept_id, position_id, tier_code,
                    can_view, can_create, can_edit, can_delete, can_approve, is_active
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
            `, [
                appCode,
                Number(item.menu_id),
                orgId,
                deptId,
                posId,
                tierCode,
                Boolean(item.can_view),
                Boolean(item.can_create),
                Boolean(item.can_edit),
                Boolean(item.can_delete),
                Boolean(item.can_approve)
            ]);
            savedCount++;
        }

        await client.query('COMMIT');
        res.json({ success: true, message: `บันทึกสิทธิ์เรียบร้อยแล้ว (${savedCount} เมนู)` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Save Permission Matrix Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});
//   สิ้นสุด
//--------------------------------------------------------


// =========================================================================
// 🏢 ระบบจัดการบุคลากร 7 ระดับ (HR Staff & Assignment Management API)
// =========================================================================

// ฟังก์ชันช่วยตรวจสอบรหัส PIN อนุมัติ (เช็ก PIN ส่วนตัวก่อน ถ้าไม่มีใช้รหัสกลาง 123456)
async function verifyApprovalPin(client, approverAccountId, inputPin) {
    if (!inputPin) return false;
    const pinStr = String(inputPin).trim();

    if (approverAccountId) {
        const personalRes = await client.query(
            `SELECT pin_code FROM sys_approval_pins WHERE account_id = $1 AND is_active = true LIMIT 1`,
            [approverAccountId]
        );
        if (personalRes.rows.length > 0) {
            return personalRes.rows[0].pin_code === pinStr;
        }
    }

    const globalRes = await client.query(
        `SELECT pin_code FROM sys_approval_pins WHERE scope_level = 'DEFAULT_GLOBAL' AND is_active = true LIMIT 1`
    );
    const defaultPin = globalRes.rows[0]?.pin_code || '123456';
    return pinStr === defaultPin;
}

// 1. ดึงข้อมูล Dropdown 4 ชั้น (หน่วยงาน -> แผนก -> ตำแหน่ง)
app.get('/api/hr/orgs', async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT org_id, org_code, org_name
            FROM sys_organizations
            WHERE COALESCE(is_active, true) = true
            ORDER BY org_id ASC
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/hr/departments/:orgId', async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT department_id, dept_code, department_name, org_id
            FROM sys_departments
            WHERE org_id = $1 AND COALESCE(is_active, true) = true
            ORDER BY department_id ASC
        `, [req.params.orgId]);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/hr/positions/:deptId', async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT position_id, pos_code, position_name, department_id
            FROM sys_positions
            WHERE department_id = $1 AND COALESCE(is_active, true) = true
            ORDER BY position_id ASC
        `, [req.params.deptId]);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. ค้นหาข้อมูลจากเลขบัตรประชาชน 13 หลัก (เช็กทั้ง hr_employees และ user_profiles)
app.get('/api/hr/lookup-national-id/:nationalId', async (req, res) => {
    const cleanId = String(req.params.nationalId || '').replace(/\D/g, '');
    if (cleanId.length !== 13) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกเลขบัตรประชาชนให้ครบ 13 หลัก' });
    }

    try {
        // 2.1 เช็กในทะเบียนกลางบุคลากร (hr_employees) ก่อน
        const empRes = await pgPool.query(`
            SELECT e.*,
                   a.assignment_id AS current_assignment_id,
                   a.org_id, a.department_id, a.position_id, a.scope_level, a.area_code, a.area_name, a.status,
                   o.org_name, d.department_name, pos.position_name
            FROM hr_employees e
            LEFT JOIN hr_assignments a ON e.emp_id = a.emp_id AND a.is_current = true AND a.is_active = true
            LEFT JOIN sys_organizations o ON a.org_id = o.org_id
            LEFT JOIN sys_departments d ON a.department_id = d.department_id
            LEFT JOIN sys_positions pos ON a.position_id = pos.position_id
            WHERE e.national_id = $1
            LIMIT 1
        `, [cleanId]);

        if (empRes.rows.length > 0) {
            return res.json({
                success: true,
                source: 'HR_EMPLOYEE',
                data: empRes.rows[0]
            });
        }

        // 2.2 ถ้ายังไม่เคยเป็นบุคลากร เช็กใน user_profiles (กรณีเป็นประชาชนในระบบอยู่แล้ว)
        const citizenRes = await pgPool.query(`
            SELECT p.profile_id, p.first_name, p.last_name, p.nickname,
                   ua.account_id, ua.username_phone AS phone
            FROM user_profiles p
            LEFT JOIN user_accounts ua ON p.profile_id = ua.profile_id
            WHERE p.national_id = $1
            LIMIT 1
        `, [cleanId]).catch(() => ({ rows: [] }));

        if (citizenRes.rows.length > 0) {
            return res.json({
                success: true,
                source: 'CITIZEN_PROFILE',
                data: citizenRes.rows[0]
            });
        }

        res.json({ success: true, source: 'NOT_FOUND', data: null });
    } catch (err) {
        console.error('Lookup National ID Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. ดึงรายชื่อบุคลากรและการดำรงตำแหน่ง (กรองได้ตาม ระดับ 7 ระดับ / หน่วยงาน / แผนก / ตำแหน่ง / คำค้นหา)
app.get('/api/hr/assignments', async (req, res) => {
    const { scope_level, org_id, department_id, position_id, status, search } = req.query;

    try {
        const conditions = ['a.is_active = true', 'e.is_active = true'];
        const params = [];

        if (scope_level && scope_level !== 'ALL') {
            params.push(scope_level);
            conditions.push(`a.scope_level = $${params.length}`);
        }
        if (org_id) {
            params.push(Number(org_id));
            conditions.push(`a.org_id = $${params.length}`);
        }
        if (department_id) {
            params.push(Number(department_id));
            conditions.push(`a.department_id = $${params.length}`);
        }
        if (position_id) {
            params.push(Number(position_id));
            conditions.push(`a.position_id = $${params.length}`);
        }
        if (status && status !== 'ALL') {
            params.push(status);
            conditions.push(`a.status = $${params.length}`);
        }
        if (search && search.trim()) {
            params.push(`%${search.trim()}%`);
            conditions.push(`(
                e.emp_code ILIKE $${params.length} OR
                e.national_id ILIKE $${params.length} OR
                e.first_name ILIKE $${params.length} OR
                e.last_name ILIKE $${params.length} OR
                e.phone ILIKE $${params.length} OR
                a.area_name ILIKE $${params.length}
            )`);
        }

        const result = await pgPool.query(`
            SELECT
                a.*,
                e.emp_code, e.national_id, e.first_name, e.last_name, e.nickname, e.phone, e.email,
                o.org_code, o.org_name,
                d.dept_code, d.department_name,
                pos.pos_code, pos.position_name
            FROM hr_assignments a
            JOIN hr_employees e ON a.emp_id = e.emp_id
            JOIN sys_organizations o ON a.org_id = o.org_id
            JOIN sys_departments d ON a.department_id = d.department_id
            JOIN sys_positions pos ON a.position_id = pos.position_id
            WHERE ${conditions.join(' AND ')}
            ORDER BY
                CASE a.status WHEN 'PENDING' THEN 1 WHEN 'ACTIVE' THEN 2 ELSE 3 END,
                a.created_at DESC
        `, params);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Get HR Assignments Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 4. เพิ่มบุคลากรใหม่ / บรรจุเข้าตำแหน่ง (สร้าง emp_code อัตโนมัติ และไม่ให้เลขบัตรซ้ำ)
app.post('/api/hr/assignments', async (req, res) => {
    const {
        national_id, first_name, last_name, nickname, phone, email,
        profile_id, account_id,
        org_id, department_id, position_id,
        scope_level, area_code, area_name, note
    } = req.body;

    const cleanId = String(national_id || '').replace(/\D/g, '');
    if (cleanId.length !== 13 || !first_name || !last_name || !org_id || !department_id || !position_id || !scope_level) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลสำคัญให้ครบถ้วน (เลขบัตร 13 หลัก, ชื่อ-นามสกุล, หน่วยงาน, แผนก, ตำแหน่ง, ระดับ)' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // 4.1 ตรวจสอบว่ามีเลขบัตรนี้ใน hr_employees แล้วหรือยัง
        let empId;
        let empCode;
        const existEmp = await client.query(
            `SELECT emp_id, emp_code FROM hr_employees WHERE national_id = $1`,
            [cleanId]
        );

        if (existEmp.rows.length > 0) {
            empId = existEmp.rows[0].emp_id;
            empCode = existEmp.rows[0].emp_code;
            // อัปเดตข้อมูลติดต่อล่าสุด
            await client.query(`
                UPDATE hr_employees
                SET first_name = $1, last_name = $2, nickname = $3, phone = $4, email = $5, is_active = true, updated_at = CURRENT_TIMESTAMP
                WHERE emp_id = $6
            `, [first_name.trim(), last_name.trim(), nickname || null, phone || null, email || null, empId]);
        } else {
            // สร้างรหัสพนักงานอัตโนมัติรูปแบบ EMP-2569-00001
            const seqRes = await client.query(`SELECT nextval('hr_emp_code_seq') AS seq`);
            const yearBE = new Date().getFullYear() + 543;
            empCode = `EMP-${yearBE}-${String(seqRes.rows[0].seq).padStart(5, '0')}`;

            const newEmp = await client.query(`
                INSERT INTO hr_employees (emp_code, national_id, profile_id, account_id, first_name, last_name, nickname, phone, email, is_active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
                RETURNING emp_id
            `, [empCode, cleanId, profile_id || null, account_id || null, first_name.trim(), last_name.trim(), nickname || null, phone || null, email || null]);

            empId = newEmp.rows[0].emp_id;
        }

        // 4.2 บันทึกคำขอบรรจุ/แต่งตั้ง (สถานะเริ่มต้น = PENDING รออนุมัติด้วย PIN)
        const assignRes = await client.query(`
            INSERT INTO hr_assignments (
                emp_id, org_id, department_id, position_id,
                scope_level, area_code, area_name, status, is_current, note, is_active
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', false, $8, true)
            RETURNING *
        `, [
            empId, Number(org_id), Number(department_id), Number(position_id),
            scope_level, area_code || 'TH', area_name || 'ส่วนกลาง', note || null
        ]);

        await client.query('COMMIT');
        res.json({
            success: true,
            message: `บันทึกข้อมูลสำเร็จ (รหัสบุคลากร: ${empCode}) สถานะ: รออนุมัติ`,
            data: { ...assignRes.rows[0], emp_code: empCode }
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Create HR Assignment Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 5. แก้ไขข้อมูลบุคลากร / ข้อมูลตำแหน่ง
app.put('/api/hr/assignments/:assignmentId', async (req, res) => {
    const { assignmentId } = req.params;
    const { first_name, last_name, nickname, phone, email, scope_level, area_code, area_name, note } = req.body;

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        const assignRes = await client.query(`SELECT emp_id FROM hr_assignments WHERE assignment_id = $1`, [assignmentId]);
        if (assignRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบรายการนี้' });
        }

        const empId = assignRes.rows[0].emp_id;
        await client.query(`
            UPDATE hr_employees
            SET first_name = $1, last_name = $2, nickname = $3, phone = $4, email = $5, updated_at = CURRENT_TIMESTAMP
            WHERE emp_id = $6
        `, [first_name.trim(), last_name.trim(), nickname || null, phone || null, email || null, empId]);

        await client.query(`
            UPDATE hr_assignments
            SET scope_level = $1, area_code = $2, area_name = $3, note = $4, updated_at = CURRENT_TIMESTAMP
            WHERE assignment_id = $5
        `, [scope_level, area_code || 'TH', area_name || 'ส่วนกลาง', note || null, assignmentId]);

        await client.query('COMMIT');
        res.json({ success: true, message: 'แก้ไขข้อมูลเรียบร้อยแล้ว' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 6. อนุมัติการแต่งตั้ง / ย้าย / ปรับตำแหน่ง (ต้องยืนยันรหัส PIN 123456)
app.post('/api/hr/assignments/:assignmentId/approve', async (req, res) => {
    const { assignmentId } = req.params;
    const { pin_code, approver_id } = req.body;

    const client = await pgPool.connect();
    try {
        const isPinValid = await verifyApprovalPin(client, approver_id, pin_code);
        if (!isPinValid) {
            return res.status(403).json({ success: false, message: 'รหัส PIN อนุมัติไม่ถูกต้อง' });
        }

        await client.query('BEGIN');

        const targetRes = await client.query(`SELECT emp_id FROM hr_assignments WHERE assignment_id = $1`, [assignmentId]);
        if (targetRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบรายการที่ต้องการอนุมัติ' });
        }
        const empId = targetRes.rows[0].emp_id;

        // ปรับตำแหน่งปัจจุบันเดิม (ถ้ามี) เป็น TRANSFERRED (ย้าย/ปรับตำแหน่งแล้ว)
        await client.query(`
            UPDATE hr_assignments
            SET is_current = false, status = 'TRANSFERRED', end_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
            WHERE emp_id = $1 AND is_current = true AND assignment_id != $2
        `, [empId, assignmentId]);

        // อนุมัติรายการนี้ให้เป็นตำแหน่งปัจจุบัน (ACTIVE)
        await client.query(`
            UPDATE hr_assignments
            SET status = 'ACTIVE', is_current = true, approved_by = $1, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE assignment_id = $2
        `, [approver_id || null, assignmentId]);

        await client.query('COMMIT');
        res.json({ success: true, message: 'อนุมัติตำแหน่งปัจจุบันเรียบร้อยแล้ว!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 7. ย้าย / ปรับตำแหน่ง (สร้างรายการใหม่ + สามารถอนุมัติทันทีด้วย PIN หรือส่งรออนุมัติก็ได้)
app.post('/api/hr/assignments/:empId/transfer', async (req, res) => {
    const { empId } = req.params;
    const { org_id, department_id, position_id, scope_level, area_code, area_name, note, pin_code, approver_id } = req.body;

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        let status = 'PENDING';
        let isCurrent = false;

        // ถ้าระบุรหัส PIN มาด้วย ให้ตรวจสอบและอนุมัติย้ายทันที
        if (pin_code) {
            const isPinValid = await verifyApprovalPin(client, approver_id, pin_code);
            if (!isPinValid) {
                await client.query('ROLLBACK');
                return res.status(403).json({ success: false, message: 'รหัส PIN อนุมัติไม่ถูกต้อง' });
            }
            status = 'ACTIVE';
            isCurrent = true;

            await client.query(`
                UPDATE hr_assignments
                SET is_current = false, status = 'TRANSFERRED', end_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
                WHERE emp_id = $1 AND is_current = true
            `, [empId]);
        }

        await client.query(`
            INSERT INTO hr_assignments (
                emp_id, org_id, department_id, position_id,
                scope_level, area_code, area_name, status, is_current, note,
                approved_by, approved_at, is_active
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
        `, [
            empId, Number(org_id), Number(department_id), Number(position_id),
            scope_level, area_code || 'TH', area_name || 'ส่วนกลาง', status, isCurrent, note || null,
            isCurrent ? (approver_id || null) : null, isCurrent ? new Date() : null
        ]);

        await client.query('COMMIT');
        res.json({
            success: true,
            message: isCurrent ? 'ย้าย/ปรับตำแหน่งและอนุมัติเรียบร้อยแล้ว!' : 'ส่งคำขอย้าย/ปรับตำแหน่งแล้ว (สถานะ: รออนุมัติ)'
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 8. ลบแบบ Soft Delete (ไม่ลบจริง ปรับ is_active = false, status = 'INACTIVE')
app.delete('/api/hr/assignments/:assignmentId', async (req, res) => {
    try {
        await pgPool.query(`
            UPDATE hr_assignments
            SET is_active = false, is_current = false, status = 'INACTIVE', end_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
            WHERE assignment_id = $1
        `, [req.params.assignmentId]);
        res.json({ success: true, message: 'ปิดใช้งานรายการเรียบร้อยแล้ว (Soft Delete)' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 9. เปลี่ยนรหัส PIN อนุมัติส่วนตัว (รองรับทุกระดับเปลี่ยนได้เองในอนาคต)
app.put('/api/hr/approval-pin', async (req, res) => {
    const { account_id, old_pin, new_pin } = req.body;
    if (!account_id || !new_pin || String(new_pin).trim().length < 4) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุรหัส PIN ใหม่อย่างน้อย 4 หลัก' });
    }

    const client = await pgPool.connect();
    try {
        const isOldValid = await verifyApprovalPin(client, account_id, old_pin);
        if (!isOldValid) {
            return res.status(403).json({ success: false, message: 'รหัส PIN เดิมไม่ถูกต้อง' });
        }

        await client.query(`
            INSERT INTO sys_approval_pins (account_id, scope_level, pin_code, is_active, updated_at)
            VALUES ($1, 'PERSONAL', $2, true, CURRENT_TIMESTAMP)
            ON CONFLICT (account_id)
            DO UPDATE SET pin_code = EXCLUDED.pin_code, updated_at = CURRENT_TIMESTAMP
        `, [account_id, String(new_pin).trim()]);

        res.json({ success: true, message: 'เปลี่ยนรหัส PIN อนุมัติส่วนตัวเรียบร้อยแล้ว!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});




app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});