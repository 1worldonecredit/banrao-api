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
  'https://chat.banrao.life',
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
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-account-id'],
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


// =========================================================================
// 🚀 ระบบ Presigned URL กลางสำหรับอัปโหลดตรงเข้า Cloudflare R2 (น้ำประปา + App Chat)
// =========================================================================
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let r2ClientInstance = null;
function getR2Client() {
    if (r2ClientInstance) return r2ClientInstance;
    const accountId = process.env.CF_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (!accountId || !accessKeyId || !secretAccessKey) {
        throw new Error('ยังไม่ได้ตั้งค่า CF_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY ใน Railway');
    }

    r2ClientInstance = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
        // สำคัญมาก: ป้องกัน AWS SDK รุ่นใหม่แนบ Checksum Header จนติด CORS บน Cloudflare R2
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED'
    });
    return r2ClientInstance;
}

const ALLOWED_R2_FOLDERS = new Set([
    'water/meters',
    'water/bills',
    'water/slips',
    'chat/images',
    'chat/files',
    'chat/voice'
]);

app.post('/api/media/presign', async (req, res) => {
    try {
        const decoded = verifyRequestJwt(req);
        const actorId = decoded?.account_id || req.headers['x-account-id'];
        if (!actorId) {
            return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบก่อนอัปโหลดไฟล์' });
        }

        const bucket = process.env.R2_BUCKET_NAME;
        const publicBaseUrl = String(process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
        if (!bucket || !publicBaseUrl) {
            return res.status(500).json({ success: false, message: 'ยังไม่ได้ตั้งค่า R2_BUCKET_NAME หรือ R2_PUBLIC_URL' });
        }

        const folder = ALLOWED_R2_FOLDERS.has(req.body?.folder) ? req.body.folder : 'water/bills';
        const contentType = String(req.body?.contentType || 'image/jpeg').trim();
        const extMap = {
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'audio/webm': 'webm',
            'audio/mp4': 'm4a',
            'application/pdf': 'pdf'
        };
        const ext = extMap[contentType.toLowerCase()] || 'jpg';
        const now = new Date();
        const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const rand = Math.random().toString(36).slice(2, 8);
        const prefix = String(req.body?.prefix || 'file').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30) || 'file';

        // จัดโครงสร้างโฟลเดอร์แยกตามเดือน เช่น water/bills/2026-11/meter-1764...jpg
        const objectKey = `${folder}/${ym}/${prefix}-${Date.now()}-${rand}.${ext}`;

        const client = getR2Client();
        const command = new PutObjectCommand({
            Bucket: bucket,
            Key: objectKey,
            ContentType: contentType
        });

        const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 });
        const publicUrl = `${publicBaseUrl}/${objectKey}`;

        res.json({
            success: true,
            uploadUrl,
            publicUrl,
            key: objectKey
        });
    } catch (err) {
        console.error('R2 Presign Error:', err);
        res.status(500).json({ success: false, message: 'สร้างลิงก์อัปโหลด R2 ไม่สำเร็จ: ' + err.message });
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
        const cleanTambonName = tambon_name.replace('ตำบล', '').replace('ต.', '').trim();

        const result = await pgPool.query(`
            SELECT
                v.village_id,
                v.village_no,
                v.village_name,
                v.headman_account_id,
                v.registration_status,
                v.registered_at,
                (
                    v.headman_account_id IS NOT NULL
                    OR UPPER(COALESCE(v.registration_status, '')) = 'REGISTERED'
                ) AS is_registered
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
        const result = await pgPool.query(`
            SELECT
                village_id,
                village_no,
                village_name,
                headman_account_id,
                registration_status,
                registered_at,
                (
                    headman_account_id IS NOT NULL
                    OR UPPER(COALESCE(registration_status, '')) = 'REGISTERED'
                ) AS is_registered
            FROM villages
            WHERE tambon_id = $1
            ORDER BY village_no ASC
        `, [tambonId]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// เส้น 1: แปลง ref จากลิงก์เชิญ -> เบอร์โทร + รูปโปรไฟล์ + ที่อยู่เต็มถึงจังหวัด
app.get('/api/referrers/resolve', async (req, res) => {
    const rawRef = String(req.query.ref || '').trim();
    if (!rawRef) {
        return res.status(400).json({ success: false, message: 'ไม่พบรหัสผู้แนะนำ' });
    }

    const client = await pgPool.connect();
    try {
        const digitsOnly = rawRef.replace(/\D/g, '');
        const r = await client.query(`
            SELECT
                ua.account_id,
                ua.username_phone,
                up.first_name,
                up.last_name,
                up.nickname,
                v.village_no,
                v.village_name,
                COALESCE(to_jsonb(v)->>'tambon_name', to_jsonb(v)->>'sub_district', st.tambon_name_th, '') AS sub_district,
                COALESCE(to_jsonb(v)->>'amphure_name', to_jsonb(v)->>'district', sa.amphure_name_th, '') AS district,
                COALESCE(to_jsonb(v)->>'province_name', to_jsonb(v)->>'province', sp.province_name_th, '') AS province,
                cpm.image_url AS profile_image
            FROM user_accounts ua
            LEFT JOIN user_profiles up
                ON up.profile_id::text = ua.profile_id::text
            LEFT JOIN villages v
                ON v.village_id::text = ua.village_id::text
            LEFT JOIN sys_tambons st
                ON st.tambon_id::text = (to_jsonb(v)->>'tambon_id')
            LEFT JOIN sys_amphures sa
                ON sa.amphure_id::text = COALESCE(to_jsonb(v)->>'amphure_id', st.amphure_id::text)
            LEFT JOIN sys_provinces sp
                ON sp.province_id::text = COALESCE(to_jsonb(v)->>'province_id', sa.province_id::text)
            LEFT JOIN LATERAL (
                SELECT image_url
                FROM citizen_profiles_media
                WHERE profile_id::text = ua.profile_id::text
                ORDER BY COALESCE(is_active, false) DESC, uploaded_at DESC NULLS LAST
                LIMIT 1
            ) cpm ON true
            WHERE ua.account_id::text = $1::text
               OR COALESCE(ua.referral_code::text, '') = $1::text
               OR ($2 <> '' AND regexp_replace(COALESCE(ua.username_phone::text, ''), '\\D', '', 'g') = $2)
            LIMIT 1
        `, [rawRef, digitsOnly]);

        if (r.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลผู้แนะนำ' });
        }

        const row = r.rows[0];
        const phone = String(row.username_phone || '').replace(/\D/g, '').slice(0, 10);

        return res.json({
            success: true,
            referrer_phone: phone,
            data: {
                account_id: row.account_id,
                first_name: row.first_name || '',
                last_name: row.last_name || '',
                nickname: row.nickname || '',
                profile_image: row.profile_image || '',
                village_no: row.village_no || '',
                village_name: row.village_name || '',
                sub_district: row.sub_district || '',
                district: row.district || '',
                province: row.province || ''
            }
        });
    } catch (err) {
        console.error('Resolve Referrer Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// เส้น 2: ค้นหาผู้แนะนำจากเบอร์โทร 10 หลัก -> ส่งรูปโปรไฟล์ + ที่อยู่เต็มถึงจังหวัด
app.get('/api/users/referrer/:phone', async (req, res) => {
    const cleanPhone = String(req.params.phone || '').replace(/\D/g, '');
    if (cleanPhone.length !== 10) {
        return res.status(400).json({ success: false, message: 'เบอร์โทรศัพท์ไม่ถูกต้อง' });
    }

    const client = await pgPool.connect();
    try {
        const r = await client.query(`
            SELECT
                ua.account_id,
                ua.username_phone,
                up.first_name,
                up.last_name,
                up.nickname,
                v.village_no,
                v.village_name,
                COALESCE(to_jsonb(v)->>'tambon_name', to_jsonb(v)->>'sub_district', st.tambon_name_th, '') AS sub_district,
                COALESCE(to_jsonb(v)->>'amphure_name', to_jsonb(v)->>'district', sa.amphure_name_th, '') AS district,
                COALESCE(to_jsonb(v)->>'province_name', to_jsonb(v)->>'province', sp.province_name_th, '') AS province,
                cpm.image_url AS profile_image
            FROM user_accounts ua
            LEFT JOIN user_profiles up
                ON up.profile_id::text = ua.profile_id::text
            LEFT JOIN villages v
                ON v.village_id::text = ua.village_id::text
            LEFT JOIN sys_tambons st
                ON st.tambon_id::text = (to_jsonb(v)->>'tambon_id')
            LEFT JOIN sys_amphures sa
                ON sa.amphure_id::text = COALESCE(to_jsonb(v)->>'amphure_id', st.amphure_id::text)
            LEFT JOIN sys_provinces sp
                ON sp.province_id::text = COALESCE(to_jsonb(v)->>'province_id', sa.province_id::text)
            LEFT JOIN LATERAL (
                SELECT image_url
                FROM citizen_profiles_media
                WHERE profile_id::text = ua.profile_id::text
                ORDER BY COALESCE(is_active, false) DESC, uploaded_at DESC NULLS LAST
                LIMIT 1
            ) cpm ON true
            WHERE regexp_replace(COALESCE(ua.username_phone::text, ''), '\\D', '', 'g') = $1
            LIMIT 1
        `, [cleanPhone]);

        if (r.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลเบอร์โทรศัพท์นี้' });
        }

        const row = r.rows[0];
        return res.json({
            success: true,
            data: {
                account_id: row.account_id,
                first_name: row.first_name || '',
                last_name: row.last_name || '',
                nickname: row.nickname || '',
                profile_image: row.profile_image || '',
                village_no: row.village_no || '',
                village_name: row.village_name || '',
                sub_district: row.sub_district || '',
                district: row.district || '',
                province: row.province || ''
            }
        });
    } catch (err) {
        console.error('Check Referrer Phone Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
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

        const accRes = await client.query(
            `SELECT profile_id FROM user_accounts WHERE account_id = $1`,
            [accountId]
        );
        if (accRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบบัญชีผู้ใช้งาน' });
        }

        const profileId = accRes.rows[0].profile_id;

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

        const safeMemberCount =
            household_member_count !== undefined &&
            household_member_count !== null &&
            household_member_count !== '' &&
            !Number.isNaN(Number(household_member_count))
                ? Number(household_member_count)
                : 0;

        await client.query(`
            UPDATE user_accounts
            SET occupation_id = $1,
                household_member_count = $2
            WHERE account_id = $3
        `, [
            occupation_id ? Number(occupation_id) : null,
            safeMemberCount,
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

app.get('/api/stories/feed/:viewerId', async (req, res) => {
    const { viewerId } = req.params;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);

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
            LIMIT $2 OFFSET $3
        `, [viewerId, limit, offset]);

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

    const toNum = (v, def) => (v !== undefined && v !== null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : def);

    try {
        const isVideo = mediaFile.mimetype.startsWith('video/');
        let mediaUrl = '';
        let coverUrl = null;

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
            toNum(text_size, 22),
            toNum(text_x, 50),
            toNum(text_y, 50),
            toNum(bg_blur, 0),
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
    const toNum = (v, def) => (v !== undefined && v !== null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : def);

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
            toNum(text_size, 22),
            toNum(text_x, 50),
            toNum(text_y, 50),
            toNum(bg_blur, 0),
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
    if (lat === undefined || lng === undefined || lat === '' || lng === '') {
        return res.json({ success: true, radius: 50 });
    }
    try {
        const query = `
            SELECT display_radius_km 
            FROM service_zones 
            WHERE is_default = FALSE 
            AND (6371 * acos(
                LEAST(1, GREATEST(-1,
                    cos(radians($1)) * cos(radians(center_lat)) * cos(radians(center_lng) - radians($2))
                    + sin(radians($1)) * sin(radians(center_lat))
                ))
            )) <= zone_coverage_km
            ORDER BY zone_coverage_km ASC 
            LIMIT 1;
        `;
        const result = await pgPool.query(query, [Number(lat), Number(lng)]);

        if (result.rows.length > 0) {
            res.json({ success: true, radius: result.rows[0].display_radius_km });
        } else {
            const defaultZone = await pgPool.query("SELECT display_radius_km FROM service_zones WHERE is_default = TRUE LIMIT 1");
            res.json({ success: true, radius: defaultZone.rows[0]?.display_radius_km || 50 });
        }
    } catch (err) {
        console.error("Error getting radius:", err.message);
        res.status(500).json({ success: false, radius: 50 });
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

app.get('/api/sys-menus', async (req, res) => {
    try {
        const query = `
            SELECT * FROM sys_menus 
            WHERE is_active = true 
            ORDER BY display_order ASC, menu_id ASC
        `;
        const result = await pgPool.query(query);
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
        const result = await pgPool.query('SELECT * FROM sys_countries WHERE is_active = true ORDER BY country_name_th ASC');
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
        const result = await pgPool.query(
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
        const result = await pgPool.query(
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
        const result = await pgPool.query(
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
        const { name, path, icon, group_id, selected_roles } = req.body;
        const result = await pgPool.query(
            `UPDATE sys_menus
             SET menu_name = COALESCE($1, menu_name),
                 route_path = COALESCE($2, route_path),
                 icon_name = COALESCE($3, icon_name),
                 group_id = COALESCE($4, group_id),
                 selected_roles = COALESCE($5, selected_roles)
             WHERE menu_id = $6
             RETURNING *`,
            [
                name || null,
                path || null,
                icon || null,
                group_id || null,
                selected_roles ? JSON.stringify(selected_roles) : null,
                id
            ]
        );
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "อัปเดตไม่ได้" });
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


// =========================================================================
// 🌟 ขั้นตอนที่ 3: ระบบตรวจตัวตน 6 มิติ (Zero-Trust) + กั้นเขต 80,000 หมู่บ้าน
// =========================================================================
const BANRAO_JWT_SECRET = process.env.JWT_SECRET || 'banrao_secret_key';

// 1. ปรับหมดวาระอัตโนมัติ (ปลอดภัย: ไม่ล้างสิทธิ์ตำแหน่งอื่นที่ยัง Active อยู่)
async function syncExpiredPositions(dbClient = pgPool) {
    try {
        const expired = await dbClient.query(`
            UPDATE user_positions
            SET is_active = false,
                status = 'EXPIRED',
                end_reason = 'หมดวาระอัตโนมัติตามกำหนด'
            WHERE is_active = true
              AND status = 'ACTIVE'
              AND end_date IS NOT NULL
              AND end_date < CURRENT_DATE
            RETURNING account_id, position_id, role_template_code
        `);

        const touchedAccounts = new Set();
        for (const row of expired.rows) {
            if (!row.account_id) continue;
            // ล้าง headman_account_id เฉพาะกรณีตำแหน่งที่หมดวาระคือผู้ใหญ่บ้านเท่านั้น
            if (row.role_template_code === 'VILLAGE_HEADMAN' || Number(row.position_id) === 6) {
                await dbClient.query(
                    `UPDATE villages SET headman_account_id = NULL WHERE headman_account_id = $1::uuid`,
                    [row.account_id]
                );
            }
            touchedAccounts.add(String(row.account_id));
        }

        for (const accId of touchedAccounts) {
            if (typeof syncUserAccountRoleFromPositions === 'function') {
                await syncUserAccountRoleFromPositions(dbClient, accId);
            }
        }
    } catch (err) {
        console.error('Sync Expired Positions Error:', err.message);
    }
}

// 2. เขียน Audit Log ทุกการ Login / การเข้าถึงที่ถูกปฏิเสธ / การพยายามข้ามหมู่บ้าน
async function writeAccessAuditLog(client, payload) {
    try {
        await client.query(`
            INSERT INTO sys_access_audit_logs (
                account_id, full_name, user_village_id, target_village_id,
                user_role, positions_text, referrer_info, account_status,
                action_name, request_path, access_result, deny_reason, ip_address
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `, [
            payload.account_id || null,
            payload.full_name || null,
            payload.user_village_id || null,
            payload.target_village_id || null,
            payload.user_role || null,
            payload.positions_text || null,
            payload.referrer_info || null,
            payload.account_status || null,
            payload.action_name || null,
            payload.request_path || null,
            payload.access_result || 'DENIED',
            payload.deny_reason || null,
            payload.ip_address || null
        ]);
    } catch (err) {
        console.error('Write Access Audit Log Error:', err.message);
    }
}
// 3. ถอดรหัสตัวตนจาก JWT Token (รองรับทั้ง BANRAO_JWT_SECRET และ JWT_SECRET เดิม)
function verifyRequestJwt(req) {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7).trim();
    try {
        return jwt.verify(token, BANRAO_JWT_SECRET);
    } catch (err) {
        if (typeof JWT_SECRET !== 'undefined' && JWT_SECRET !== BANRAO_JWT_SECRET) {
            try {
                return jwt.verify(token, JWT_SECRET);
            } catch (_) {
                return null;
            }
        }
        return null;
    }
}

// 4. ตรวจสอบ 6 มิติ + โมดูลที่หมู่บ้านนี้เปิดใช้งานจริง (รองรับ 80,000 หมู่บ้าน)
async function resolveUserSecurityContext(client, accountId) {
    if (!accountId || !isValidUuidV3(accountId)) {
        return { ok: false, code: 401, reason: 'ไม่พบข้อมูลยืนยันตัวตน กรุณาเข้าสู่ระบบใหม่' };
    }

    const accRes = await client.query(`
        SELECT
            a.account_id, a.profile_id, a.username_phone, a.is_active, a.role,
            COALESCE(a.tier_code, 'CITIZEN_FREE') AS tier_code,
            a.village_id, a.referrer_id, a.referred_by, a.referral_code,
            p.first_name, p.last_name, p.citizen_id, p.house_no,
            v.village_no, v.village_name, v.headman_account_id,
            t.tambon_name_th, am.amphure_name_th, pr.province_name_th,
            (
                SELECT cpm.image_url
                FROM citizen_profiles_media cpm
                WHERE cpm.profile_id = a.profile_id AND cpm.is_active = true
                LIMIT 1
            ) AS user_image
        FROM user_accounts a
        LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
        LEFT JOIN villages v ON a.village_id = v.village_id
        LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
        LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
        LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
        WHERE a.account_id = $1::uuid
        LIMIT 1
    `, [accountId]);

    if (accRes.rows.length === 0) {
        return { ok: false, code: 401, reason: 'ไม่พบบัญชีผู้ใช้งานนี้ในระบบ' };
    }

    const u = accRes.rows[0];
    const fullName = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.username_phone;
    const cleanCid = String(u.citizen_id || '').replace(/\D/g, '');
    const isSuperAdmin = u.username_phone === '0000000000' || String(u.role || '').toUpperCase() === 'SUPER_ADMIN';

    // ตรวจสถานะทะเบียนลูกบ้าน (household_members) — รองรับเลขประจำตัว >= 6 หลัก
    let householdStatus = 'UNLINKED';
    let houseNo = u.house_no || '';
    if (cleanCid.length >= 6 && u.village_id) {
        const hmRes = await client.query(`
            SELECT hm.status, to_jsonb(h) AS h_json
            FROM household_members hm
            JOIN households h ON hm.household_id::text = h.household_id::text
            WHERE h.village_id = $1::uuid
              AND REGEXP_REPLACE(COALESCE(hm.citizen_id::text, ''), '[^0-9]', '', 'g') = $2
            ORDER BY CASE WHEN hm.status = 'ACTIVE' THEN 0 ELSE 1 END, hm.member_id DESC
            LIMIT 1
        `, [u.village_id, cleanCid]).catch(() => ({ rows: [] }));

        if (hmRes.rows.length > 0) {
            householdStatus = String(hmRes.rows[0].status || 'ACTIVE').toUpperCase();
            const hj = hmRes.rows[0].h_json || {};
            houseNo = hj.house_no || hj.house_number || houseNo;
        }
    }

    // ตรวจว่าหมู่บ้านนี้มีระบบประปาหมู่บ้านเปิดใช้งานอยู่จริงหรือไม่ (แยกตาม village_id 100%)
    let villageHasWaterSystem = false;
    if (u.village_id) {
        const wcRes = await client.query(`
            SELECT 1 FROM community_committees
            WHERE village_id = $1::uuid
              AND COALESCE(is_active, true) = true
              AND (
                  committee_type_code = 'WATER'
                  OR committee_name LIKE '%ประปา%'
                  OR committee_name LIKE '%ปะปา%'
              )
            LIMIT 1
        `, [u.village_id]).catch(() => ({ rows: [] }));

        if (wcRes.rows.length > 0) {
            villageHasWaterSystem = true;
        } else {
            const wmVillageRes = await client.query(`
                SELECT 1 FROM water_meters
                WHERE village_id::text = $1::text AND is_active = true
                LIMIT 1
            `, [u.village_id]).catch(() => ({ rows: [] }));
            villageHasWaterSystem = wmVillageRes.rows.length > 0;
        }
    }

    // ตรวจว่าบ้านของบุคคลนี้มีการติดตั้งมิเตอร์น้ำประปาหมู่บ้าน (Active) อยู่จริงหรือไม่
    let hasWaterMeter = false;
    if (villageHasWaterSystem && cleanCid.length >= 6 && u.village_id) {
        const wmRes = await client.query(`
            SELECT 1
            FROM water_meters wm
            JOIN household_members hm ON wm.household_id::text = hm.household_id::text
            WHERE wm.village_id::text = $1::text
              AND wm.is_active = true
              AND hm.status = 'ACTIVE'
              AND REGEXP_REPLACE(COALESCE(hm.citizen_id::text, ''), '[^0-9]', '', 'g') = $2
            LIMIT 1
        `, [u.village_id, cleanCid]).catch(() => ({ rows: [] }));
        hasWaterMeter = wmRes.rows.length > 0;
    }

    const isAccountActive = u.is_active !== false;
    const isHouseholdActive = isSuperAdmin || householdStatus === 'UNLINKED' || householdStatus === 'ACTIVE';

    // ตรวจผู้แนะนำ (Referrer)
    let referrer = null;
    if (u.referrer_id || u.referred_by) {
        const refRes = await client.query(`
            SELECT ra.account_id, ra.username_phone, ra.is_active, rp.first_name, rp.last_name
            FROM user_accounts ra
            LEFT JOIN user_profiles rp ON ra.profile_id = rp.profile_id
            WHERE ($1::uuid IS NOT NULL AND ra.account_id = $1::uuid)
               OR ($2::text IS NOT NULL AND (ra.referral_code = $2::text OR ra.username_phone = $2::text))
            LIMIT 1
        `, [isValidUuidV3(u.referrer_id) ? u.referrer_id : null, u.referred_by || null]).catch(() => ({ rows: [] }));

        if (refRes.rows.length > 0) {
            const r = refRes.rows[0];
            referrer = {
                account_id: r.account_id,
                full_name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.username_phone,
                phone: r.username_phone || '-',
                is_active: r.is_active !== false
            };
        } else if (u.referred_by) {
            referrer = { account_id: null, full_name: String(u.referred_by), phone: '-', is_active: true };
        }
    }

    // ดึงเฉพาะตำแหน่งที่ "ผู้ใหญ่บ้านอนุมัติแล้ว (ACTIVE)" + "อยู่ในหมู่บ้านตัวเอง" + "ไม่หมดวาระ"
    const posRes = await client.query(`
        SELECT
            up.id AS user_position_id,
            up.committee_id,
            cc.committee_name,
            cc.committee_type_code,
            up.position_id,
            COALESCE(NULLIF(up.custom_position_title, ''), sp.position_name, 'กรรมการชุมชน') AS display_position_name,
            COALESCE(up.role_template_code, sp.role_template_code, 'COMMITTEE_GENERAL') AS role_template_code,
            rt.template_name_th,
            rt.account_role_level,
            up.start_date,
            up.end_date,
            up.approved_at
        FROM user_positions up
        LEFT JOIN sys_positions sp ON up.position_id = sp.position_id
        LEFT JOIN sys_role_templates rt ON COALESCE(up.role_template_code, sp.role_template_code) = rt.role_template_code
        LEFT JOIN community_committees cc ON up.committee_id = cc.committee_id
        WHERE up.account_id = $1::uuid
          AND up.is_active = true
          AND up.status = 'ACTIVE'
          AND (up.end_date IS NULL OR up.end_date >= CURRENT_DATE)
          AND ($2::uuid IS NULL OR up.village_id IS NULL OR up.village_id = $2::uuid)
        ORDER BY up.approved_at DESC NULLS LAST, up.id DESC
    `, [u.account_id, u.village_id || null]);

    const activePositions = posRes.rows || [];
    const roleTemplateSet = new Set(activePositions.map((p) => p.role_template_code).filter(Boolean));

    const isHeadman = Boolean(
        u.village_id && u.headman_account_id && String(u.headman_account_id) === String(u.account_id)
    );
    if (isSuperAdmin) roleTemplateSet.add('SUPER_ADMIN');
    if (isHeadman) roleTemplateSet.add('VILLAGE_HEADMAN');

    const roleUpper = String(u.role || 'CITIZEN').toUpperCase();
    if (roleUpper === 'HEADMAN') roleTemplateSet.add('VILLAGE_HEADMAN');
    if (roleUpper.includes('ADMIN') && !isSuperAdmin) roleTemplateSet.add('VILLAGE_ADMIN');

    const roleTemplates = Array.from(roleTemplateSet);
    const has = (...codes) => isSuperAdmin || codes.some((c) => roleTemplateSet.has(c));

    // กำหนดสิทธิ์การใช้งาน: โมดูลประปาจะใช้งานได้เฉพาะหมู่บ้านที่เปิดระบบประปาแล้วเท่านั้น
    const canOperate = isAccountActive && isHouseholdActive && (isSuperAdmin || Boolean(u.village_id));
    const canUseWaterModule = canOperate && (isSuperAdmin || villageHasWaterSystem);

    const permissions = {
        can_manage_village_core: canOperate && has('VILLAGE_HEADMAN', 'VILLAGE_ADMIN'),
        can_approve_committees: canOperate && has('VILLAGE_HEADMAN'),
        can_manage_water_users: canUseWaterModule && has('VILLAGE_HEADMAN', 'VILLAGE_ADMIN', 'WATER_PRESIDENT', 'WATER_TREASURER'),
        can_view_water_users: canUseWaterModule && has('VILLAGE_HEADMAN', 'VILLAGE_ADMIN', 'WATER_PRESIDENT', 'WATER_TREASURER'),
        can_record_water_bills: canUseWaterModule && has('VILLAGE_HEADMAN', 'VILLAGE_ADMIN', 'WATER_PRESIDENT', 'WATER_TREASURER', 'WATER_READER'),
        can_manage_water_settings: canUseWaterModule && has('VILLAGE_HEADMAN', 'VILLAGE_ADMIN', 'WATER_PRESIDENT', 'WATER_TREASURER'),
        can_approve_water_rates: canUseWaterModule && has('VILLAGE_HEADMAN', 'WATER_PRESIDENT'),
        can_view_my_water_bills: canUseWaterModule && (isSuperAdmin || hasWaterMeter),
        can_pay_water_bill: canUseWaterModule && (isSuperAdmin || hasWaterMeter || has('VILLAGE_HEADMAN', 'VILLAGE_ADMIN', 'WATER_PRESIDENT', 'WATER_TREASURER', 'WATER_READER')),
        can_manage_places: canOperate && (has('VILLAGE_HEADMAN', 'VILLAGE_ADMIN', 'PLACE_GOV_HEAD', 'PLACE_BIZ_OWNER') || ['BIZ_SHOP', 'BIZ_HOTEL'].includes(u.tier_code))
    };

    let displayPositionName = 'ประชาชนทั่วไป';
    if (isSuperAdmin) displayPositionName = 'Super Admin';
    else if (isHeadman) displayPositionName = 'ผู้ใหญ่บ้าน';
    else if (activePositions.length > 0) displayPositionName = activePositions[0].display_position_name;
    else if (roleUpper.includes('ADMIN')) displayPositionName = 'แอดมินหมู่บ้าน';

    const vName = u.village_name
        ? (u.village_name.startsWith('บ้าน') ? u.village_name : `บ้าน${u.village_name}`)
        : '';
    const villageFullAddress = [
        vName,
        u.village_no ? `หมู่ที่ ${u.village_no}` : '',
        u.tambon_name_th ? `ต.${u.tambon_name_th}` : '',
        u.amphure_name_th ? `อ.${u.amphure_name_th}` : '',
        u.province_name_th ? `จ.${u.province_name_th}` : ''
    ].filter(Boolean).join(' ');

    const ok = isAccountActive && isHouseholdActive && (isSuperAdmin || Boolean(u.village_id));
    const reason = !isAccountActive
        ? 'บัญชีของคุณถูกระงับการใช้งาน (INACTIVE)'
        : !isHouseholdActive
        ? `สถานะทะเบียนลูกบ้านของคุณไม่ปกติ (${householdStatus})`
        : (!isSuperAdmin && !u.village_id)
        ? 'บัญชียังไม่ได้ผูกสังกัดหมู่บ้าน'
        : null;

    return {
        ok,
        code: ok ? 200 : 403,
        reason,
        context: {
            account_id: String(u.account_id),
            username_phone: u.username_phone,
            full_name: fullName,
            user_image: u.user_image || '/profile-img.jpg',
            is_active: isAccountActive && isHouseholdActive,
            account_status: isAccountActive ? 'ACTIVE' : 'INACTIVE',
            household_status: householdStatus,
            village_modules: {
                water: villageHasWaterSystem
            },
            has_water_meter: hasWaterMeter,
            is_super_admin: isSuperAdmin,
            is_headman: isHeadman,
            role: u.role || 'CITIZEN',
            tier_code: u.tier_code,
            display_position_name: displayPositionName,
            role_templates: roleTemplates,
            positions: activePositions,
            village_id: u.village_id ? String(u.village_id) : null,
            village_name: u.village_name || '',
            village_no: u.village_no || '',
            village_full_address: villageFullAddress,
            house_no: houseNo || '-',
            referrer,
            permissions
        }
    };
}
// 5. Middleware กั้นเขตหมู่บ้าน (80,000 หมู่บ้านไม่ปนกัน 100%) + ตรวจสิทธิ์สด + บันทึก Audit Log
function requireVillageGuard(permissionKey, actionName) {
    return async (req, res, next) => {
        const decoded = verifyRequestJwt(req);
        const accountId = decoded?.account_id || req.headers['x-account-id'] || null;
        const requestedVillageId = req.params.villageId || req.body?.village_id || req.query?.village_id || null;
        const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '');

        const client = await pgPool.connect();
        try {
            const check = await resolveUserSecurityContext(client, accountId);
            const ctx = check.context || {};
            const posText = (ctx.positions || []).map((p) => `${p.display_position_name} [${p.role_template_code}]`).join(', ');
            const refText = ctx.referrer ? `${ctx.referrer.full_name} (${ctx.referrer.phone})` : 'ไม่มีผู้แนะนำ';

            if (!check.ok) {
                await writeAccessAuditLog(client, {
                    account_id: accountId,
                    full_name: ctx.full_name,
                    user_village_id: ctx.village_id,
                    target_village_id: requestedVillageId ? String(requestedVillageId) : null,
                    user_role: ctx.role,
                    positions_text: posText,
                    referrer_info: refText,
                    account_status: ctx.account_status || 'UNVERIFIED',
                    action_name: actionName,
                    request_path: req.originalUrl,
                    access_result: 'DENIED',
                    deny_reason: check.reason,
                    ip_address: ip
                });
                return res.status(check.code || 401).json({
                    success: false,
                    code: 'AUTH_OR_STATUS_INVALID',
                    message: check.reason,
                    security_context: ctx
                });
            }

            // กั้นเขตหมู่บ้านเด็ดขาด: ห้ามดูหรือแก้ไขหมู่บ้านอื่น (ยกเว้น Super Admin)
            if (!ctx.is_super_admin && requestedVillageId && String(requestedVillageId) !== String(ctx.village_id)) {
                const reason = 'ไม่อนุญาตให้เข้าถึงข้อมูลต่างหมู่บ้าน (หมู่บ้านใคร หมู่บ้านมัน)';
                await writeAccessAuditLog(client, {
                    account_id: ctx.account_id,
                    full_name: ctx.full_name,
                    user_village_id: ctx.village_id,
                    target_village_id: String(requestedVillageId),
                    user_role: ctx.role,
                    positions_text: posText,
                    referrer_info: refText,
                    account_status: ctx.account_status,
                    action_name: `CROSS_VILLAGE_${actionName}`,
                    request_path: req.originalUrl,
                    access_result: 'DENIED',
                    deny_reason: reason,
                    ip_address: ip
                });
                return res.status(403).json({
                    success: false,
                    code: 'CROSS_VILLAGE_FORBIDDEN',
                    message: reason,
                    security_context: ctx
                });
            }

            // ตรวจสิทธิ์ตามแม่แบบสิทธิ์ที่ได้รับอนุมัติ
            if (permissionKey && !ctx.permissions?.[permissionKey]) {
                const reason = `ตำแหน่งของคุณ (${ctx.display_position_name}) ยังไม่ได้รับสิทธิ์ใช้งานส่วนนี้`;
                await writeAccessAuditLog(client, {
                    account_id: ctx.account_id,
                    full_name: ctx.full_name,
                    user_village_id: ctx.village_id,
                    target_village_id: ctx.village_id,
                    user_role: ctx.role,
                    positions_text: posText,
                    referrer_info: refText,
                    account_status: ctx.account_status,
                    action_name: actionName,
                    request_path: req.originalUrl,
                    access_result: 'DENIED',
                    deny_reason: reason,
                    ip_address: ip
                });
                return res.status(403).json({
                    success: false,
                    code: 'PERMISSION_DENIED',
                    message: reason,
                    security_context: ctx
                });
            }

            // บังคับล็อก village_id และตัวตนเป็นของคน Login เสมอ (ป้องกันปลอมค่าใน Request)
            req.securityContext = ctx;
            if (!ctx.is_super_admin && ctx.village_id) {
                if (req.params.villageId) req.params.villageId = ctx.village_id;
                if (req.body && typeof req.body === 'object' && 'village_id' in req.body) req.body.village_id = ctx.village_id;
            }

            if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
                await writeAccessAuditLog(client, {
                    account_id: ctx.account_id,
                    full_name: ctx.full_name,
                    user_village_id: ctx.village_id,
                    target_village_id: ctx.village_id,
                    user_role: ctx.role,
                    positions_text: posText,
                    referrer_info: refText,
                    account_status: ctx.account_status,
                    action_name: actionName,
                    request_path: req.originalUrl,
                    access_result: 'ALLOWED',
                    deny_reason: null,
                    ip_address: ip
                });
            }

            next();
        } catch (err) {
            console.error('requireVillageGuard Error:', err);
            res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการตรวจสอบสิทธิ์' });
        } finally {
            client.release();
        }
    };
}


// ==========================================
// 🌟 API เข้าสู่ระบบ (Login) - ตรวจ 6 มิติ + กั้นเขต 80,000 หมู่บ้าน + เชื่อมสิทธิ์ที่อนุมัติแล้ว
// ==========================================
app.post('/api/login', async (req, res) => {
    const usernameInput = req.body.username || req.body.phone_number;
    const password = req.body.password;
    const appCode = (req.body.app_code || 'BANRAO_WEB').trim().toUpperCase();
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '');

    if (!usernameInput || !password) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกเบอร์โทรศัพท์และรหัสผ่าน' });
    }

    const client = await pgPool.connect();
    try {
        // 1. เคลียร์ตำแหน่งที่หมดวาระอัตโนมัติ
        await syncExpiredPositions(client);

        // 2. ดึงข้อมูลบัญชี โปรไฟล์ และหมู่บ้าน
        const userQuery = await client.query(`
            SELECT
                a.account_id, a.username_phone, a.password_hash, a.occupation_id,
                a.is_active, a.household_member_count, a.role,
                COALESCE(a.tier_code, 'CITIZEN_FREE') AS tier_code,
                p.first_name, p.last_name, p.nickname, p.dob, p.citizen_id, p.gender, p.house_no,
                o.occupation_name,
                (
                    SELECT cpm.image_url FROM citizen_profiles_media cpm
                    WHERE cpm.profile_id = a.profile_id AND cpm.is_active = true
                    LIMIT 1
                ) AS user_image,
                (
                    SELECT hcpm.image_url FROM citizen_profiles_media hcpm
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
            WHERE a.username_phone = $1
            LIMIT 1
        `, [usernameInput]);

        if (userQuery.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'เบอร์โทรศัพท์หรือรหัสผ่านไม่ถูกต้อง' });
        }

        const user = userQuery.rows[0];
        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ success: false, message: 'เบอร์โทรศัพท์หรือรหัสผ่านไม่ถูกต้อง' });
        }

        // 3. เชื่อมตำแหน่งที่ผู้ใหญ่บ้านอนุมัติไว้ล่วงหน้าจากเลขประจำตัว (เฉพาะหมู่บ้านเดียวกันเท่านั้น!)
        const cleanCid = String(user.citizen_id || '').replace(/\D/g, '');
        if (cleanCid.length >= 6 && user.village_id) {
            const linked = await client.query(`
                UPDATE user_positions
                SET account_id = $1::uuid
                WHERE account_id IS NULL
                  AND village_id = $2::uuid
                  AND REGEXP_REPLACE(COALESCE(citizen_id, ''), '[^0-9]', '', 'g') = $3
                  AND is_active = true
                RETURNING id
            `, [user.account_id, user.village_id, cleanCid]).catch(() => ({ rows: [] }));

            if (linked.rows.length > 0 && typeof syncUserAccountRoleFromPositions === 'function') {
                await syncUserAccountRoleFromPositions(client, user.account_id);
            }
        }

        // 4. ตรวจสอบ 6 มิติ (ตัวตน, Active, หมู่บ้าน, ผู้แนะนำ, ตำแหน่งที่อนุมัติแล้ว, สิทธิ์)
        const secCheck = await resolveUserSecurityContext(client, user.account_id);
        const sec = secCheck.context || {};

        if (!secCheck.ok) {
            await writeAccessAuditLog(client, {
                account_id: user.account_id,
                full_name: sec.full_name,
                user_village_id: sec.village_id,
                target_village_id: sec.village_id,
                user_role: sec.role,
                referrer_info: sec.referrer ? `${sec.referrer.full_name} (${sec.referrer.phone})` : 'ไม่มีผู้แนะนำ',
                account_status: sec.account_status,
                action_name: 'LOGIN',
                request_path: '/api/login',
                access_result: 'DENIED',
                deny_reason: secCheck.reason,
                ip_address: ip
            });
            return res.status(403).json({ success: false, message: secCheck.reason });
        }

        // 5. ดึงสิทธิ์อาชีพเดิม (คงไว้เพื่อรองรับหน้าเดิม)
        let occupationPermissions = [];
        if (user.occupation_id) {
            const permQuery = await client.query(`
                SELECT sp.permission_code
                FROM occupation_permissions op
                JOIN sys_permissions sp ON op.permission_id = sp.permission_id
                WHERE op.occupation_id = $1
            `, [user.occupation_id]).catch(() => ({ rows: [] }));
            occupationPermissions = permQuery.rows.map((r) => r.permission_code);
        }

        const primaryPos = sec.positions[0] || null;

        // 6. สร้าง JWT Token ที่ฝังบริบทหมู่บ้าน + แม่แบบสิทธิ์ที่อนุมัติแล้ว
        const token = jwt.sign(
            {
                account_id: user.account_id,
                app_code: appCode,
                is_super_admin: sec.is_super_admin,
                is_headman: sec.is_headman,
                village_id: sec.village_id,
                tier_code: sec.tier_code,
                role_templates: sec.role_templates,
                position_id: primaryPos?.position_id || null
            },
            BANRAO_JWT_SECRET,
            { expiresIn: '5d' }
        );

        // บันทึกประวัติ Login สำเร็จ
        await writeAccessAuditLog(client, {
            account_id: sec.account_id,
            full_name: sec.full_name,
            user_village_id: sec.village_id,
            target_village_id: sec.village_id,
            user_role: sec.role,
            positions_text: (sec.positions || []).map((p) => `${p.display_position_name} [${p.role_template_code}]`).join(', '),
            referrer_info: sec.referrer ? `${sec.referrer.full_name} (${sec.referrer.phone})` : 'ไม่มีผู้แนะนำ',
            account_status: sec.account_status,
            action_name: 'LOGIN',
            request_path: '/api/login',
            access_result: 'ALLOWED',
            deny_reason: null,
            ip_address: ip
        });

        const daysTh = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
        const birthDate = user.dob ? new Date(user.dob) : null;
        const isDummyDate = birthDate && birthDate.getFullYear() === 1900;
        const dayNameTh = (birthDate && !isDummyDate) ? daysTh[birthDate.getDay()] : '-';
        const genderTh = user.gender === 'MALE' ? 'ชาย' : (user.gender === 'FEMALE' ? 'หญิง' : '-');

        const responseData = {
            id: user.account_id,
            account_id: user.account_id,
            username: user.username_phone,
            username_phone: user.username_phone,
            firstName: user.first_name,
            lastName: user.last_name,
            full_name: sec.full_name,
            nickname: user.nickname,
            occupation: user.occupation_name,
            permissions: occupationPermissions,
            role: sec.role,
            tier_code: sec.tier_code,

            // หมู่บ้านและสถิติ
            village_id: sec.village_id,
            village_no: user.village_no,
            villageName: user.village_name,
            village_full_address: sec.village_full_address,
            headmanName: user.headman_first_name ? `${user.headman_first_name} ${user.headman_last_name}` : null,
            tambonName: user.tambon_name_th,
            amphureName: user.amphure_name_th,
            provinceName: user.province_name_th,

            gender: genderTh,
            birthDayName: dayNameTh,
            age_years: isDummyDate ? '-' : (user.age_years || 0),
            age_months: isDummyDate ? '-' : (user.age_months || 0),
            age_days: isDummyDate ? '-' : (user.age_days || 0),
            house_no: sec.house_no || '-',
            household_member_count: user.household_member_count || 0,
            target_household_count: user.target_household_count || 0,
            target_population_count: user.target_population_count || 0,
            actual_household_count: user.actual_household_count || 0,
            actual_population_count: user.actual_population_count || 0,

            userImage: sec.user_image,
            headmanImage: user.headman_account_id ? (user.headman_image || '/profile-img.jpg') : '/profile-img.jpg',

            // ข้อมูลตำแหน่งและสิทธิ์ 6 มิติ (เฉพาะที่อนุมัติแล้วเท่านั้น)
            app_code: appCode,
            isSuperAdmin: sec.is_super_admin,
            is_super_admin: sec.is_super_admin,
            is_headman: sec.is_headman,
            position_id: primaryPos?.position_id || null,
            position_name: sec.display_position_name,
            role_templates: sec.role_templates,
            positions: sec.positions,
            referrer: sec.referrer,
            security_permissions: sec.permissions
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
        client.release();
    }
});

// ==========================================
// 🌟 API ดึงเมนู Sidebar แบบ Dynamic ตามสิทธิ์จริง + โมดูลที่มีจริงในหมู่บ้านนั้น
// ==========================================
app.get('/api/sidebar-menus/:accountId', async (req, res) => {
    const decoded = verifyRequestJwt(req);
    const targetAccountId = decoded?.account_id || req.params.accountId;

    const client = await pgPool.connect();
    try {
        await syncExpiredPositions(client);

        const secCheck = await resolveUserSecurityContext(client, targetAccountId);
        if (!secCheck.ok) {
            return res.status(secCheck.code || 403).json({
                success: false,
                code: 'ACCOUNT_BLOCKED',
                message: secCheck.reason,
                data: []
            });
        }

        const ctx = secCheck.context;
        let menuRows = [];

        if (ctx.is_super_admin) {
            const mRes = await client.query(`
                SELECT
                    m.menu_id, m.group_id, COALESCE(g.group_name, 'เมนูระบบ') AS group_name,
                    COALESCE(g.display_order, 99) AS group_order,
                    m.menu_name, m.icon_name, COALESCE(m.route_path, m.path) AS route_path,
                    m.display_order,
                    true AS can_view, true AS can_create, true AS can_edit, true AS can_delete, true AS can_approve
                FROM sys_menus m
                LEFT JOIN sys_menu_groups g ON m.group_id = g.group_id
                WHERE m.is_active = true
                  AND COALESCE(m.app_code, 'BANRAO_WEB') = 'BANRAO_WEB'
                  AND COALESCE(m.group_id, 0) NOT IN (10, 11)
                ORDER BY group_order ASC, m.display_order ASC, m.menu_id ASC
            `);
            menuRows = mRes.rows;
        } else {
            const mRes = await client.query(`
                SELECT
                    m.menu_id,
                    m.group_id,
                    COALESCE(g.group_name, 'เมนูทั่วไป') AS group_name,
                    COALESCE(g.display_order, 99) AS group_order,
                    m.menu_name,
                    m.icon_name,
                    COALESCE(m.route_path, m.path) AS route_path,
                    m.display_order,
                    BOOL_OR(p.can_view) AS can_view,
                    BOOL_OR(p.can_create) AS can_create,
                    BOOL_OR(p.can_edit) AS can_edit,
                    BOOL_OR(p.can_delete) AS can_delete,
                    BOOL_OR(p.can_approve) AS can_approve
                FROM sys_menus m
                LEFT JOIN sys_menu_groups g ON m.group_id = g.group_id
                JOIN sys_menu_permissions p ON p.menu_id = m.menu_id AND p.is_active = true
                WHERE m.is_active = true
                  AND COALESCE(m.group_id, 0) NOT IN (10, 11)
                  AND p.can_view = true
                  AND (
                      (p.tier_code IS NOT NULL AND p.tier_code = $1)
                      OR (p.role_template_code IS NOT NULL AND p.role_template_code = ANY($2::text[]))
                  )
                GROUP BY m.menu_id, m.group_id, g.group_name, g.display_order, m.menu_name, m.icon_name, m.route_path, m.path, m.display_order
                ORDER BY group_order ASC, m.display_order ASC, m.menu_id ASC
            `, [ctx.tier_code, ctx.role_templates]);
            menuRows = mRes.rows;
        }

        const groupMap = new Map();
        const permissionsMap = {};
        const waterEnabled = Boolean(ctx.village_modules?.water);

        for (const r of menuRows) {
            if (!r.route_path) continue;

            // 1. ซ่อนเมนูระบบประปาทั้งหมด หากหมู่บ้านนี้ไม่ได้เปิด/สร้างผังประปาหมู่บ้าน
            if (
                !ctx.is_super_admin &&
                ['/water-users', '/water-billing', '/my-water-bills'].includes(r.route_path) &&
                !waterEnabled
            ) {
                continue;
            }

            // 2. ซ่อนเมนู "บิลล์ค่าน้ำ" หากบ้านของบุคคลนี้ไม่ได้ติดตั้งมิเตอร์น้ำ
            if (!ctx.is_super_admin && r.route_path === '/my-water-bills' && !ctx.has_water_meter) {
                continue;
            }

            // 3. ซ่อนเมนู "ลงทะเบียนหมู่บ้าน" หากบัญชีนี้สังกัดหมู่บ้านที่ลงทะเบียนแล้ว (ยกเว้น Super Admin)
            if (!ctx.is_super_admin && r.route_path === '/register-village' && ctx.village_id) {
                continue;
            }

            if (!groupMap.has(r.group_id)) {
                groupMap.set(r.group_id, {
                    group_id: r.group_id,
                    group_name: r.group_name,
                    menus: []
                });
            }
            groupMap.get(r.group_id).menus.push({
                menu_id: r.menu_id,
                name: r.menu_name,
                path: r.route_path,
                icon: r.icon_name
            });

            permissionsMap[r.route_path] = {
                can_view: Boolean(r.can_view),
                can_create: Boolean(r.can_create),
                can_edit: Boolean(r.can_edit),
                can_delete: Boolean(r.can_delete),
                can_approve: Boolean(r.can_approve)
            };
        }

        res.json({
            success: true,
            data: Array.from(groupMap.values()),
            permissionsMap,
            securityContext: ctx
        });
    } catch (err) {
        console.error('Get Sidebar Menus Error:', err);
        res.status(500).json({ success: false, message: err.message, data: [] });
    } finally {
        client.release();
    }
});

// API ตรวจสอบตัวตน 6 มิติ (ใช้กับตัวกั้นหน้าเว็บ VillageAccessGuard)
app.get('/api/auth/verify-context', async (req, res) => {
    const decoded = verifyRequestJwt(req);
    const accountId = decoded?.account_id || req.headers['x-account-id'] || null;
    const client = await pgPool.connect();
    try {
        await syncExpiredPositions(client);
        const check = await resolveUserSecurityContext(client, accountId);
        if (!check.ok) {
            return res.status(check.code || 401).json({
                success: false,
                message: check.reason,
                data: check.context || null
            });
        }
        res.json({ success: true, data: check.context });
    } catch (err) {
        console.error('Verify Context Error:', err);
        res.status(500).json({ success: false, message: err.message });
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
// API: ดึงข้อมูลสถานที่และบริการในชุมชน (Community Places)
// ==========================================
app.get('/api/community-places', async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);

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
                (
                    SELECT cpm.image_url
                    FROM citizen_profiles_media cpm
                    WHERE cpm.profile_id = p.profile_id AND cpm.is_active = true
                    LIMIT 1
                ) AS owner_image
            FROM community_places cp
            LEFT JOIN sys_place_categories cat ON cp.category_id = cat.category_id
            LEFT JOIN user_accounts a ON cp.owner_account_id = a.account_id
            LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
            WHERE cp.is_active = TRUE
            ORDER BY cp.created_at DESC
            LIMIT $1 OFFSET $2
        `;

        const result = await pgPool.query(query, [limit, offset]);

        const places = result.rows.map(row => ({
            id: row.place_id,
            name: row.place_name,
            category: row.category_name || 'สถานที่ทั่วไป',
            desc: row.description,
            img: row.cover_image_url || 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=600&q=80',
            isOpen: true,
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
        }));

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
        const query = `SELECT * FROM villages WHERE village_id::text = $1::text LIMIT 1;`;
        const result = await pgPool.query(query, [String(villageId)]);

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
// API: ค้นหาข้อมูลลูกบ้านด้วยเลขบัตรประชาชน (ดึงรูปโปรไฟล์จริง + วันเกิด/อายุ)
// ==========================================
app.get('/api/search-citizen/:villageId/:citizenId', async (req, res) => {
    const { villageId, citizenId } = req.params;
    const cleanCitizenId = String(citizenId || '').replace(/[^0-9]/g, '');

    if (!cleanCitizenId || !villageId) {
        return res.status(400).json({ success: false, message: 'ข้อมูลการค้นหาไม่ครบถ้วน' });
    }

    const client = await pgPool.connect();
    try {
        const result = await client.query(`
            SELECT 
                hm.member_id AS account_id,
                hm.first_name, 
                hm.last_name,
                hm.citizen_id,
                to_jsonb(hm) AS hm_json,
                v.village_name,
                t.tambon_name_th,
                am.amphure_name_th,
                pr.province_name_th,
                hm.relationship AS responsibilities
            FROM household_members hm
            INNER JOIN households h ON hm.household_id = h.household_id
            LEFT JOIN villages v ON h.village_id::TEXT = v.village_id::TEXT
            LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
            LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
            LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
            WHERE REGEXP_REPLACE(COALESCE(hm.citizen_id::TEXT, ''), '[^0-9]', '', 'g') = $1 
              AND h.village_id::TEXT = $2::TEXT
              AND hm.status = 'ACTIVE'
            LIMIT 1
        `, [cleanCitizenId, String(villageId)]);

        if (result.rows.length === 0) {
            const checkOtherVillage = await client.query(
                `SELECT member_id FROM household_members WHERE REGEXP_REPLACE(COALESCE(citizen_id::TEXT, ''), '[^0-9]', '', 'g') = $1 AND status = 'ACTIVE' LIMIT 1`,
                [cleanCitizenId]
            );
            if (checkOtherVillage.rows.length > 0) {
                return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลลูกบ้านนี้ในหมู่บ้านของคุณ' });
            }
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลเลขบัตรประชาชนนี้ในระบบจัดการประชากร' });
        }

        const row = result.rows[0];
        const hmJson = row.hm_json || {};

        const pRes = await client.query(`
            SELECT p.dob, p.gender,
                   (
                       SELECT cpm.image_url
                       FROM citizen_profiles_media cpm
                       WHERE cpm.profile_id = p.profile_id AND cpm.is_active = true
                       LIMIT 1
                   ) AS user_image
            FROM user_profiles p
            WHERE REGEXP_REPLACE(COALESCE(p.citizen_id::text, ''), '[^0-9]', '', 'g') = $1
            LIMIT 1
        `, [cleanCitizenId]).catch(() => ({ rows: [] }));

        const userImage = pRes.rows[0]?.user_image || null;
        const profileDob = pRes.rows[0]?.dob || null;
        const profileGender = pRes.rows[0]?.gender || null;

        res.json({
            success: true,
            data: {
                account_id: row.account_id,
                first_name: row.first_name,
                last_name: row.last_name,
                citizen_id: row.citizen_id,
                village_name: row.village_name,
                tambon_name_th: row.tambon_name_th,
                amphure_name_th: row.amphure_name_th,
                province_name_th: row.province_name_th,
                responsibilities: row.responsibilities,
                dob: profileDob || hmJson.dob || hmJson.birth_date || hmJson.date_of_birth || null,
                gender: profileGender || hmJson.gender || hmJson.sex || null,
                user_image: userImage || '/profile-img.jpg'
            }
        });
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
// API: ดึงข้อมูลผังผู้นำ (GET) - แก้คอลัมน์ position_name / profile_image แล้ว
// ==========================================
app.get('/api/community-leaders/:villageId', async (req, res) => {
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
                COALESCE(NULLIF(upos.custom_position_title, ''), sp.position_name, 'กรรมการชุมชน') AS role_name,
                upos.start_date,
                upos.end_date,
                upos.responsibilities,
                upos.account_id,
                COALESCE(p.first_name, hm.first_name) AS first_name,
                COALESCE(p.last_name, hm.last_name) AS last_name,
                COALESCE(
                    (
                        SELECT cpm.image_url
                        FROM citizen_profiles_media cpm
                        WHERE cpm.profile_id = p.profile_id AND cpm.is_active = true
                        LIMIT 1
                    ),
                    '/profile-img.jpg'
                ) AS user_image
            FROM user_positions upos
            LEFT JOIN sys_positions sp ON upos.position_id = sp.position_id
            LEFT JOIN user_accounts a ON upos.account_id::text = a.account_id::text
            LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
            LEFT JOIN household_members hm ON upos.account_id::text = hm.member_id::text
            WHERE upos.committee_id::text = $1::text
        `, [String(committee_id)]);

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
                COALESCE(NULLIF(upos.custom_position_title, ''), sp.position_name, 'กรรมการชุมชน') AS role_name,
                upos.start_date,
                upos.end_date,
                upos.responsibilities,
                upos.account_id,
                COALESCE(p.first_name, hm.first_name) AS first_name,
                COALESCE(p.last_name, hm.last_name) AS last_name,
                COALESCE(
                    (
                        SELECT cpm.image_url
                        FROM citizen_profiles_media cpm
                        WHERE cpm.profile_id = p.profile_id AND cpm.is_active = true
                        LIMIT 1
                    ),
                    '/profile-img.jpg'
                ) AS user_image
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
// API: ดึงข้อมูลผังผู้นำ (V2) - ดึงรูปโปรไฟล์จริงจาก citizen_profiles_media
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
                COALESCE(NULLIF(upos.custom_position_title, ''), sp.position_name, 'กรรมการชุมชน') AS role_name,
                upos.start_date,
                upos.end_date,
                upos.responsibilities,
                upos.account_id,
                COALESCE(p.first_name, hm.first_name) AS first_name,
                COALESCE(p.last_name, hm.last_name) AS last_name,
                hm.citizen_id,
                (
                    SELECT cpm.image_url
                    FROM citizen_profiles_media cpm
                    WHERE cpm.profile_id = a.profile_id AND cpm.is_active = true
                    LIMIT 1
                ) AS direct_image
            FROM user_positions upos
            LEFT JOIN sys_positions sp ON upos.position_id = sp.position_id 
            LEFT JOIN user_accounts a ON upos.account_id::text = a.account_id::text
            LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
            LEFT JOIN household_members hm ON upos.account_id::text = hm.member_id::text
            WHERE upos.committee_id::integer = $1::integer
        `, [committeeId]);

        const rowsWithImages = await Promise.all(result.rows.map(async (row) => {
            let finalImage = row.direct_image || null;

            if (!finalImage && row.citizen_id) {
                const cleanId = String(row.citizen_id).replace(/\D/g, '');
                if (cleanId.length >= 6) {
                    const imgRes = await client.query(`
                        SELECT cpm.image_url
                        FROM user_profiles p
                        JOIN citizen_profiles_media cpm ON cpm.profile_id = p.profile_id AND cpm.is_active = true
                        WHERE REGEXP_REPLACE(COALESCE(p.citizen_id::text, ''), '[^0-9]', '', 'g') = $1
                        LIMIT 1
                    `, [cleanId]).catch(() => ({ rows: [] }));
                    if (imgRes.rows.length > 0 && imgRes.rows[0].image_url) {
                        finalImage = imgRes.rows[0].image_url;
                    }
                }
            }

            return {
                ...row,
                user_image: finalImage || '/profile-img.jpg'
            };
        }));

        res.json({ success: true, data: rowsWithImages });
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
    const client = await pgPool.connect();

    try {
        await client.query('BEGIN');

        // 1. ลบความสัมพันธ์ตำแหน่งบุคลากรที่ผูกกับ committee_id นี้ก่อน (ป้องกันติด Foreign Key)
        await client.query('DELETE FROM user_positions WHERE committee_id = $1', [id]);

        // 2. ลบตัวคณะทำงานออกจากตาราง
        const result = await client.query(
            'DELETE FROM community_committees WHERE committee_id = $1 RETURNING *;',
            [id]
        );

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลคณะทำงานที่ต้องการลบ' });
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'ลบคณะทำงานสำเร็จ' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting committee:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});


// ==========================================
// 🌟 API แต่งตั้งตำแหน่ง (ปลดคนเก่าเป็นอดีตอัตโนมัติ + อัปเดตผู้ใหญ่บ้านในตาราง villages)
// ==========================================
app.post('/api/assign-role', async (req, res) => {
    const {
        target_account_id,
        position_id,
        scope_type,
        scope_id,
        approval_pin,
        start_date,
        end_date
    } = req.body;

    if (!target_account_id || !position_id || !scope_id) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    if (approval_pin !== undefined && approval_pin !== '123456') {
        return res.status(401).json({ success: false, message: 'รหัสอนุมัติไม่ถูกต้อง' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // 1. เคลียร์ตำแหน่งที่หมดวาระอัตโนมัติก่อน
        await syncExpiredPositions(client);

        const finalScopeType = scope_type || 'VILLAGE';
        const sDate = start_date || new Date().toISOString().split('T')[0];
        const eDate = end_date || null;

        // 2. ถ้าหมู่บ้านนี้มีคนครองตำแหน่งเดิมที่ยัง Active อยู่ -> ปรับเป็น FORMER อัตโนมัติ
        await client.query(`
            UPDATE user_positions
            SET is_active = false,
                status = 'FORMER',
                end_date = CURRENT_DATE,
                end_reason = 'พ้นจากตำแหน่งเนื่องจากมีการแต่งตั้งคนใหม่แทน'
            WHERE position_id = $1
              AND (scope_id::text = $2::text OR village_id::text = $2::text)
              AND is_active = true
        `, [position_id, String(scope_id)]);

        // 3. บันทึกคนใหม่เป็นผู้ดำรงตำแหน่งปัจจุบัน
        const insertRes = await client.query(`
            INSERT INTO user_positions (account_id, position_id, scope_type, scope_id, start_date, end_date, is_active, status)
            VALUES ($1, $2, $3, $4, $5, $6, true, 'ACTIVE')
            RETURNING *
        `, [target_account_id, position_id, finalScopeType, scope_id, sDate, eDate]);

        // 4. อัปเดตผู้ใหญ่บ้านปัจจุบันในตาราง villages
        if (finalScopeType === 'VILLAGE') {
            await client.query(
                'UPDATE villages SET headman_account_id = $1 WHERE village_id::text = $2::text',
                [target_account_id, String(scope_id)]
            );
        }

        await client.query('COMMIT');
        res.json({
            success: true,
            message: 'แต่งตั้งตำแหน่งสำเร็จ (คนเก่าถูกปรับเป็นอดีตอัตโนมัติ)',
            assigned_date: new Date().toISOString(),
            data: insertRes.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error assigning role:', error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการแต่งตั้งตำแหน่ง: ' + error.message });
    } finally {
        client.release();
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
// 🌟 API สำหรับลงทะเบียนผู้ใหญ่บ้าน (1 หมู่บ้าน ลงทะเบียนได้ 1 ครั้งเท่านั้น)
// ==========================================
app.post('/api/villages/register', async (req, res) => {
    const {
        village_id,
        latitude, longitude,
        citizen_id, first_name, last_name, nickname, phone_number, password,
        gender, dob,
        referrer_account_id
    } = req.body;

    if (!phone_number || !password || !village_id) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน กรุณาเลือกหมู่บ้าน' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // 🔒 0. ล็อกแถวหมู่บ้านและเช็กว่าลงทะเบียนไปแล้วหรือยัง (1 หมู่บ้าน 1 ครั้งเท่านั้น!)
        const checkVillage = await client.query(
            `SELECT village_id, village_no, village_name, headman_account_id
             FROM villages
             WHERE village_id = $1
             FOR UPDATE`,
            [village_id]
        );
        if (checkVillage.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลหมู่บ้านที่เลือกในระบบ' });
        }
        const vRow = checkVillage.rows[0];
        if (vRow.headman_account_id) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                code: 'VILLAGE_ALREADY_REGISTERED',
                message: `หมู่ที่ ${vRow.village_no || '-'} ${vRow.village_name || ''} ลงทะเบียนในระบบแล้ว ไม่สามารถลงทะเบียนซ้ำได้`
            });
        }

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

        // 2. อัปเดตพิกัด (Lat/Lng) ลงในหมู่บ้านเดิมที่เลือกมา
        await client.query(`
            UPDATE villages 
            SET headman_lat = $1, headman_lng = $2 
            WHERE village_id = $3
        `, [latitude, longitude, village_id]);

        // 3. สร้าง Profile พร้อมบันทึก gender และ dob จริง
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
        await client.query(`
    UPDATE villages
    SET headman_account_id = $1,
        registration_status = 'REGISTERED',
        registered_at = CURRENT_TIMESTAMP
    WHERE village_id = $2
`, [newAccountId, village_id]);

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

        // 2. ดึงเฉพาะตำแหน่งที่ยังเปิดใช้งานอยู่ (is_active = true)
        const posQuery = await pgPool.query(`
            SELECT sp.position_id, sp.position_name, sp.position_level, sp.dept_id AS department_id
            FROM user_positions upos
            JOIN sys_positions sp ON upos.position_id = sp.position_id
            WHERE upos.account_id = $1 AND COALESCE(upos.is_active, true) = true
        `, [user.account_id]);

        const activePositionIds = posQuery.rows.map(r => r.position_id);

        // 3. ดึงสิทธิ์ทั้งหมด (รองรับทั้ง Super Admin, ตารางเดิม position_permissions และตารางสิทธิ์เมนู sys_menu_permissions)
        const isSuperAdmin = user.username_phone === '0000000000' || (user.role || '').toUpperCase() === 'SUPER_ADMIN';
        let permissions = [];
        let adminMenuPermissions = [];

        if (isSuperAdmin) {
            const allPerm = await pgPool.query('SELECT permission_code FROM sys_permissions').catch(() => ({ rows: [] }));
            permissions = ['*', ...allPerm.rows.map(r => r.permission_code)];
        } else if (activePositionIds.length > 0) {
            // 3.1 สิทธิ์จากตารางเดิม
            const permQuery = await pgPool.query(`
                SELECT DISTINCT p.permission_code
                FROM position_permissions pp
                JOIN sys_permissions p ON pp.permission_id = p.permission_id
                WHERE pp.position_id = ANY($1::int[])
            `, [activePositionIds]).catch(() => ({ rows: [] }));
            permissions = permQuery.rows.map(r => r.permission_code);

            // 3.2 สิทธิ์รายเมนู (ดู / เพิ่ม / แก้ไข / ลบ / อนุมัติ) สำหรับ src/utils/permissions.js
            const menuPermQuery = await pgPool.query(`
                SELECT mp.menu_id, m.menu_path, m.menu_name,
                       BOOL_OR(COALESCE(mp.can_view, false)) AS can_view,
                       BOOL_OR(COALESCE(mp.can_create, false)) AS can_create,
                       BOOL_OR(COALESCE(mp.can_edit, false)) AS can_edit,
                       BOOL_OR(COALESCE(mp.can_delete, false)) AS can_delete,
                       BOOL_OR(COALESCE(mp.can_approve, false)) AS can_approve
                FROM sys_menu_permissions mp
                LEFT JOIN sys_menus m ON mp.menu_id = m.menu_id
                WHERE mp.position_id = ANY($1::int[])
                GROUP BY mp.menu_id, m.menu_path, m.menu_name
            `, [activePositionIds]).catch(() => ({ rows: [] }));
            adminMenuPermissions = menuPermQuery.rows;
        }

        // 4. อนุญาตให้เข้าหลังบ้านได้ถ้าเป็น Super Admin หรือมีตำแหน่งที่อนุมัติแล้ว (ACTIVE)
        const hasAdminAccess = isSuperAdmin || permissions.length > 0 || adminMenuPermissions.length > 0 || activePositionIds.length > 0;
        if (!hasAdminAccess) {
            return res.status(403).json({ success: false, message: 'บัญชีนี้ยังไม่ได้รับกำหนดสิทธิ์เข้าใช้งานระบบหลังบ้าน' });
        }

        // 5. สร้าง Token พร้อมฝัง permissions
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
                permissions,
                adminMenuPermissions // <-- ส่งให้ src/utils/permissions.js เช็กปุ่ม เพิ่ม/แก้ไข/ลบ ตั้งแต่ Login
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


// ฟังก์ชันช่วย Sync ตำแหน่งที่อนุมัติแล้วลงตาราง user_positions (เพื่อให้หน้าบ้านแสดงตำแหน่ง + หลังบ้าน Login ได้)
async function syncPositionToUserPositions(client, empId, positionId) {
    // หา account_id จาก hr_employees (ถ้ายังไม่มี ให้หาจากเบอร์โทรใน user_accounts)
    let empRes = await client.query(`SELECT account_id, phone FROM hr_employees WHERE emp_id = $1`, [empId]);
    if (empRes.rows.length === 0) return;

    let accountId = empRes.rows[0].account_id;
    const phone = empRes.rows[0].phone;

    if (!accountId && phone) {
        const cleanPhone = String(phone).replace(/\D/g, '');
        const uaRes = await client.query(`
            SELECT account_id, profile_id FROM user_accounts
            WHERE REGEXP_REPLACE(COALESCE(username_phone, ''), '[^0-9]', '', 'g') = $1
            LIMIT 1
        `, [cleanPhone]);
        if (uaRes.rows.length > 0) {
            accountId = uaRes.rows[0].account_id;
            await client.query(
                `UPDATE hr_employees SET account_id = $1, profile_id = COALESCE(profile_id, $2) WHERE emp_id = $3`,
                [accountId, uaRes.rows[0].profile_id, empId]
            );
        }
    }

    if (!accountId) return;

    // ปิดตำแหน่งเก่าทั้งหมดของบัญชีนี้ใน user_positions
    await client.query(`UPDATE user_positions SET is_active = false WHERE account_id = $1`, [accountId]);

    // ถ้ามี positionId ใหม่ ให้เปิดใช้งานใน user_positions
    if (positionId) {
        const existPos = await client.query(
            `SELECT 1 FROM user_positions WHERE account_id = $1 AND position_id = $2 LIMIT 1`,
            [accountId, Number(positionId)]
        );
        if (existPos.rows.length > 0) {
            await client.query(
                `UPDATE user_positions SET is_active = true WHERE account_id = $1 AND position_id = $2`,
                [accountId, Number(positionId)]
            );
        } else {
            await client.query(
                `INSERT INTO user_positions (account_id, position_id, is_active) VALUES ($1, $2, true)`,
                [accountId, Number(positionId)]
            );
        }
    }
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
            SELECT position_id, pos_code, position_name, dept_id AS department_id
            FROM sys_positions
            WHERE dept_id = $1 AND COALESCE(is_active, true) = true
            ORDER BY position_id ASC
        `, [req.params.deptId]);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// 2. ค้นหาข้อมูลจากเลขบัตรประชาชน 13 หลัก (พร้อมรูปโปรไฟล์ + ข้อมูลส่วนตัว + ประวัติตำแหน่งทั้งหมด)
app.get('/api/hr/lookup-national-id/:nationalId', async (req, res) => {
    const cleanId = String(req.params.nationalId || '').replace(/\D/g, '');
    if (cleanId.length !== 13) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกเลขบัตรประชาชนให้ครบ 13 หลัก' });
    }

    try {
        let source = 'NOT_FOUND';
        let baseData = null;
        let empId = null;
        let profileId = null;
        let accountId = null;

        // 2.1 เช็กใน hr_employees ก่อน
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
            WHERE REGEXP_REPLACE(COALESCE(e.national_id, ''), '[^0-9]', '', 'g') = $1
            LIMIT 1
        `, [cleanId]);

        if (empRes.rows.length > 0) {
            source = 'HR_EMPLOYEE';
            baseData = empRes.rows[0];
            empId = baseData.emp_id;
            profileId = baseData.profile_id;
            accountId = baseData.account_id;
        }

        // 2.2 ดึงข้อมูลเต็มจาก user_profiles (รูปโปรไฟล์, วันเกิด, เพศ, การศึกษา ฯลฯ)
        let profileRow = null;
        if (profileId) {
            const pRes = await pgPool.query(`
                SELECT p.*, ua.account_id, ua.username_phone AS account_phone, to_jsonb(ua) AS ua_json
                FROM user_profiles p
                LEFT JOIN user_accounts ua ON p.profile_id = ua.profile_id
                WHERE p.profile_id = $1 LIMIT 1
            `, [profileId]).catch(() => ({ rows: [] }));
            profileRow = pRes.rows[0] || null;
        }

        if (!profileRow) {
            const profileCols = ['national_id', 'id_card', 'id_card_number', 'citizen_id'];
            for (const col of profileCols) {
                const pRes = await pgPool.query(`
                    SELECT p.*, ua.account_id, ua.username_phone AS account_phone, to_jsonb(ua) AS ua_json
                    FROM user_profiles p
                    LEFT JOIN user_accounts ua ON p.profile_id = ua.profile_id
                    WHERE REGEXP_REPLACE(COALESCE(p.${col}::text, ''), '[^0-9]', '', 'g') = $1
                    LIMIT 1
                `, [cleanId]).catch(() => ({ rows: [] }));
                if (pRes.rows.length > 0) {
                    profileRow = pRes.rows[0];
                    break;
                }
            }
        }

        // ถ้ายังไม่เจอใน hr_employees แต่เจอใน user_profiles
        if (!baseData && profileRow) {
            source = 'CITIZEN_PROFILE';
            baseData = {
                profile_id: profileRow.profile_id,
                account_id: profileRow.account_id,
                first_name: profileRow.first_name,
                last_name: profileRow.last_name,
                nickname: profileRow.nickname,
                phone: profileRow.account_phone || profileRow.phone || ''
            };
        }

        // 2.3 เช็กสำรองใน household_members กรณีไม่เจอทั้ง 2 ตารางบน
        if (!baseData) {
            const hmCols = ['national_id', 'id_card', 'id_card_number', 'citizen_id'];
            for (const col of hmCols) {
                const hmRes = await pgPool.query(`
                    SELECT * FROM household_members
                    WHERE REGEXP_REPLACE(COALESCE(${col}::text, ''), '[^0-9]', '', 'g') = $1
                    LIMIT 1
                `, [cleanId]).catch(() => ({ rows: [] }));
                if (hmRes.rows.length > 0) {
                    source = 'CITIZEN_PROFILE';
                    const hm = hmRes.rows[0];
                    baseData = {
                        first_name: hm.first_name,
                        last_name: hm.last_name,
                        nickname: hm.nickname,
                        phone: hm.phone || ''
                    };
                    profileRow = hm;
                    break;
                }
            }
        }

        if (!baseData) {
            return res.json({ success: true, source: 'NOT_FOUND', data: null });
        }

        // 2.4 ดึงประวัติตำแหน่งงานทั้งหมด (ล่าสุด -> ที่ผ่านมา)
        let assignmentHistory = [];
        if (empId) {
            const histRes = await pgPool.query(`
                SELECT a.assignment_id, a.scope_level, a.area_code, a.area_name,
                       a.status, a.is_current, a.start_date, a.end_date, a.created_at, a.note,
                       o.org_code, o.org_name,
                       d.dept_code, d.department_name,
                       pos.pos_code, pos.position_name
                FROM hr_assignments a
                LEFT JOIN sys_organizations o ON a.org_id = o.org_id
                LEFT JOIN sys_departments d ON a.department_id = d.department_id
                LEFT JOIN sys_positions pos ON a.position_id = pos.position_id
                WHERE a.emp_id = $1 AND COALESCE(a.is_active, true) = true
                ORDER BY a.is_current DESC, COALESCE(a.start_date, a.created_at) DESC, a.assignment_id DESC
            `, [empId]).catch(() => ({ rows: [] }));
            assignmentHistory = histRes.rows;
        }

            // ฟังก์ชันช่วยหา URL รูปโปรไฟล์จากทุกชื่อคอลัมน์ที่เป็นไปได้
        const findAvatar = (obj) => {
            if (!obj || typeof obj !== 'object') return null;
            const preferred = [
                'profile_image_url', 'avatar_url', 'profile_image', 'profile_pic',
                'profile_picture', 'photo_url', 'image_url', 'picture_url', 'avatar', 'img_url'
            ];
            for (const key of preferred) {
                if (typeof obj[key] === 'string' && obj[key].trim()) return obj[key].trim();
            }
            for (const [k, v] of Object.entries(obj)) {
                if (/(avatar|image|photo|pic|img)/i.test(k) && typeof v === 'string' && v.trim()) {
                    return v.trim();
                }
            }
            return null;
        };

        const rawAvatar = findAvatar(profileRow) || findAvatar(profileRow?.ua_json);

        // รวมข้อมูลโปรไฟล์เต็ม
        const profileDetails = {
            avatar_url: rawAvatar,
            birth_date: profileRow?.birth_date || profileRow?.date_of_birth || profileRow?.dob || null,
            gender: profileRow?.gender || profileRow?.sex || null,
            education: profileRow?.education || profileRow?.education_level || null,
            phone: baseData.phone || profileRow?.account_phone || profileRow?.phone || null
        };

        res.json({
            success: true,
            source,
            data: {
                ...baseData,
                profile_details: profileDetails,
                assignment_history: assignmentHistory
            }
        });
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


// ฟังก์ชันช่วย Sync ชื่อ-นามสกุล-ชื่อเล่น กลับไปอัปเดตที่ต้นทาง (user_profiles และ household_members)
async function syncCitizenName({ profile_id, national_id, first_name, last_name, nickname, phone }) {
    const cleanId = String(national_id || '').replace(/\D/g, '');
    const idCols = ['national_id', 'id_card', 'id_card_number', 'citizen_id'];

    // 1. อัปเดตตาราง user_profiles
    if (profile_id) {
        await pgPool.query(`
            UPDATE user_profiles
            SET first_name = $1, last_name = $2, nickname = $3, updated_at = CURRENT_TIMESTAMP
            WHERE profile_id = $4
        `, [first_name, last_name, nickname || null, profile_id]).catch(() => {});
    } else if (cleanId.length === 13) {
        for (const col of idCols) {
            await pgPool.query(`
                UPDATE user_profiles
                SET first_name = $1, last_name = $2, nickname = $3, updated_at = CURRENT_TIMESTAMP
                WHERE REGEXP_REPLACE(COALESCE(${col}::text, ''), '[^0-9]', '', 'g') = $4
            `, [first_name, last_name, nickname || null, cleanId]).catch(() => {});
        }
    }

    // 2. อัปเดตตาราง household_members (หน้า manage-population)
    if (cleanId.length === 13) {
        for (const col of idCols) {
            await pgPool.query(`
                UPDATE household_members
                SET first_name = $1, last_name = $2, nickname = $3, phone = COALESCE($4, phone)
                WHERE REGEXP_REPLACE(COALESCE(${col}::text, ''), '[^0-9]', '', 'g') = $5
            `, [first_name, last_name, nickname || null, phone || null, cleanId]).catch(() => {});
        }
    }
}

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

        // Sync ชื่อกลับต้นทางหลัง COMMIT สำเร็จ
        await syncCitizenName({
            profile_id, national_id: cleanId,
            first_name: first_name.trim(), last_name: last_name.trim(), nickname, phone
        });

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

        const assignRes = await client.query(`
            SELECT a.emp_id, e.profile_id, e.national_id
            FROM hr_assignments a
            JOIN hr_employees e ON a.emp_id = e.emp_id
            WHERE a.assignment_id = $1
        `, [assignmentId]);

        if (assignRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบรายการนี้' });
        }

        const { emp_id: empId, profile_id: profileId, national_id: nationalId } = assignRes.rows[0];

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

        // Sync ชื่อกลับต้นทางหลัง COMMIT สำเร็จ
        await syncCitizenName({
            profile_id: profileId,
            national_id: nationalId,
            first_name: first_name.trim(),
            last_name: last_name.trim(),
            nickname,
            phone
        });

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

        const targetRes = await client.query(`SELECT emp_id , position_id FROM hr_assignments WHERE assignment_id = $1`, [assignmentId]);
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
        await syncPositionToUserPositions(client, empId, targetRes.rows[0].position_id);
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
            if (isCurrent) {
             await syncPositionToUserPositions(client, empId, position_id);
            }
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

// =========================================================================
// ดึงข้อมูลโปรไฟล์เต็มของผู้ใช้งานที่ Login เข้าระบบหลังบ้าน (emp.banrao.life/profile)
// =========================================================================
app.get('/api/admin/profile/:accountId', async (req, res) => {
    const { accountId } = req.params;
    try {
        // 1. ดึงข้อมูลบัญชี + โปรไฟล์ส่วนตัว + รูปโปรไฟล์จาก citizen_profiles_media
        const userRes = await pgPool.query(`
            SELECT
                ua.account_id, ua.profile_id, ua.username_phone, ua.role,
                ua.area_code, ua.is_active, ua.created_at AS join_date,
                to_jsonb(ua) AS ua_json,
                to_jsonb(up) AS up_json,
                up.first_name, up.last_name, up.nickname,
                (
                    SELECT cpm.image_url
                    FROM citizen_profiles_media cpm
                    WHERE cpm.profile_id = ua.profile_id AND cpm.is_active = true
                    LIMIT 1
                ) AS user_image
            FROM user_accounts ua
            LEFT JOIN user_profiles up ON ua.profile_id = up.profile_id
            WHERE ua.account_id = $1
            LIMIT 1
        `, [accountId]);

        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลผู้ใช้งาน' });
        }

        const u = userRes.rows[0];
        const upJson = u.up_json || {};
        const uaJson = u.ua_json || {};

        // ฟังก์ชันช่วยหา URL รูปโปรไฟล์สำรอง
        const findAvatar = (obj) => {
            if (!obj || typeof obj !== 'object') return null;
            const preferred = [
                'profile_image_url', 'avatar_url', 'profile_image', 'profile_pic',
                'profile_picture', 'photo_url', 'image_url', 'picture_url', 'avatar', 'img_url'
            ];
            for (const key of preferred) {
                if (typeof obj[key] === 'string' && obj[key].trim()) return obj[key].trim();
            }
            for (const [k, v] of Object.entries(obj)) {
                if (/(avatar|image|photo|pic|img)/i.test(k) && typeof v === 'string' && v.trim()) {
                    return v.trim();
                }
            }
            return null;
        };

        // 2. ดึงข้อมูลพนักงานจาก hr_employees
        const empRes = await pgPool.query(`
            SELECT * FROM hr_employees
            WHERE account_id = $1 OR profile_id = $2
            LIMIT 1
        `, [accountId, u.profile_id || null]).catch(() => ({ rows: [] }));
        const emp = empRes.rows[0] || null;

        // 3. ดึงประวัติตำแหน่งงานทั้งหมดจาก hr_assignments
        let assignments = [];
        if (emp?.emp_id) {
            const assignRes = await pgPool.query(`
                SELECT a.assignment_id, a.scope_level, a.area_code, a.area_name,
                       a.status, a.is_current, a.start_date, a.end_date, a.created_at, a.note,
                       o.org_code, o.org_name,
                       d.dept_code, d.department_name,
                       pos.pos_code, pos.position_name
                FROM hr_assignments a
                LEFT JOIN sys_organizations o ON a.org_id = o.org_id
                LEFT JOIN sys_departments d ON a.department_id = d.department_id
                LEFT JOIN sys_positions pos ON a.position_id = pos.position_id
                WHERE a.emp_id = $1 AND COALESCE(a.is_active, true) = true
                ORDER BY a.is_current DESC, COALESCE(a.start_date, a.created_at) DESC
            `, [emp.emp_id]).catch(() => ({ rows: [] }));
            assignments = assignRes.rows;
        }

        // 4. ดึงตำแหน่งสำรองจาก user_positions
        const activePosRes = await pgPool.query(`
            SELECT sp.position_id, sp.pos_code, sp.position_name, sp.position_level
            FROM user_positions upos
            JOIN sys_positions sp ON upos.position_id = sp.position_id
            WHERE upos.account_id = $1 AND COALESCE(upos.is_active, true) = true
        `, [accountId]).catch(() => ({ rows: [] }));

        const currentAssign = assignments.find((a) => a.is_current) || assignments[0] || null;
        const primaryPosition =
            currentAssign?.position_name ||
            activePosRes.rows[0]?.position_name ||
            (u.username_phone === '0000000000' ? 'Super Admin' : u.role || 'ผู้ใช้งานระบบ');

        res.json({
            success: true,
            data: {
                account_id: u.account_id,
                profile_id: u.profile_id,
                username: u.username_phone,
                emp_code: emp?.emp_code || null,
                national_id: emp?.national_id || upJson.national_id || upJson.id_card || upJson.id_card_number || null,
                first_name: emp?.first_name || u.first_name || '',
                last_name: emp?.last_name || u.last_name || '',
                nickname: emp?.nickname || u.nickname || '',
                role: primaryPosition,
                org_name: currentAssign?.org_name || null,
                department_name: currentAssign?.department_name || null,
                scope_level: currentAssign?.scope_level || null,
                area_code: currentAssign?.area_code || u.area_code || 'TH',
                area_name: currentAssign?.area_name || 'ส่วนกลาง',
                email: emp?.email || upJson.email || uaJson.email || '-',
                phone: emp?.phone || u.username_phone || '-',
                birth_date: upJson.birth_date || upJson.date_of_birth || upJson.dob || null,
                gender: upJson.gender || upJson.sex || '-',
                education: upJson.education || upJson.education_level || null,
                join_date: u.join_date || null,
                is_active: Boolean(u.is_active),
                avatar_url: u.user_image || findAvatar(upJson) || findAvatar(uaJson) || null,
                assignments
            }
        });
    } catch (err) {
        console.error('Get Admin Profile Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});



// =========================================================================
// ระบบจัดการผู้ใช้น้ำประปาหมู่บ้าน (Water Supply Management API)
// =========================================================================
// =========================================================================
// ระบบจัดการผู้ใช้น้ำประปาหมู่บ้าน (Water Supply Management API - รองรับ UUID 100%)
// =========================================================================

// 1. ดึงรายชื่อบ้านเลขที่ + สมาชิกในบ้าน + ที่อยู่ละเอียด + รูป + เบอร์โทร
app.get('/api/water/households/:villageId', async (req, res) => {
    const { villageId } = req.params;
    try {
        const result = await pgPool.query(`
            SELECT
                h.household_id,
                to_jsonb(h) AS h_json,
                v.village_no,
                v.village_name,
                t.tambon_name_th,
                am.amphure_name_th,
                pr.province_name_th,
                hm.member_id,
                hm.first_name,
                hm.last_name,
                hm.citizen_id,
                hm.relationship,
                to_jsonb(hm) AS hm_json,
                (
                    SELECT cpm.image_url
                    FROM user_profiles up
                    JOIN citizen_profiles_media cpm ON cpm.profile_id = up.profile_id AND cpm.is_active = true
                    WHERE REGEXP_REPLACE(
                        COALESCE(
                            to_jsonb(up)->>'national_id',
                            to_jsonb(up)->>'citizen_id',
                            to_jsonb(up)->>'id_card',
                            to_jsonb(up)->>'id_card_number',
                            ''
                        ), '[^0-9]', '', 'g'
                    ) = REGEXP_REPLACE(COALESCE(hm.citizen_id::text, ''), '[^0-9]', '', 'g')
                    AND COALESCE(hm.citizen_id::text, '') <> ''
                    LIMIT 1
                ) AS member_image,
                (
                    SELECT ua.username_phone
                    FROM user_profiles up
                    JOIN user_accounts ua ON ua.profile_id = up.profile_id
                    WHERE REGEXP_REPLACE(
                        COALESCE(
                            to_jsonb(up)->>'national_id',
                            to_jsonb(up)->>'citizen_id',
                            to_jsonb(up)->>'id_card',
                            to_jsonb(up)->>'id_card_number',
                            ''
                        ), '[^0-9]', '', 'g'
                    ) = REGEXP_REPLACE(COALESCE(hm.citizen_id::text, ''), '[^0-9]', '', 'g')
                    AND COALESCE(hm.citizen_id::text, '') <> ''
                    LIMIT 1
                ) AS account_phone
            FROM households h
            LEFT JOIN villages v ON h.village_id::text = v.village_id::text
            LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
            LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
            LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
            LEFT JOIN household_members hm ON hm.household_id::text = h.household_id::text AND hm.status = 'ACTIVE'
            WHERE h.village_id::text = $1::text
            ORDER BY hm.member_id ASC
        `, [String(villageId)]);

        // จัดกลุ่มสมาชิกเข้าตามบ้านเลขที่
        const houseMap = new Map();
        for (const row of result.rows) {
            const hJson = row.h_json || {};
            const hmJson = row.hm_json || {};
            const houseNo = hJson.house_no || hJson.house_number || hJson.address_no || String(row.household_id);

            if (!houseMap.has(row.household_id)) {
                const vName = row.village_name
                    ? (row.village_name.startsWith('บ้าน') ? row.village_name : `บ้าน${row.village_name}`)
                    : '';
                const fullAddress = `บ้านเลขที่ ${houseNo} หมู่ ${row.village_no || '-'} ${vName} ต.${row.tambon_name_th || '-'} อ.${row.amphure_name_th || '-'} จ.${row.province_name_th || '-'}`.trim();

                houseMap.set(row.household_id, {
                    household_id: row.household_id,
                    house_no: houseNo,
                    full_address: fullAddress,
                    members: []
                });
            }
            if (row.member_id) {
                const phone = hmJson.phone || hmJson.phone_number || hmJson.tel || row.account_phone || '';
                houseMap.get(row.household_id).members.push({
                    member_id: row.member_id,
                    first_name: row.first_name,
                    last_name: row.last_name,
                    full_name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
                    phone,
                    relationship: row.relationship || '',
                    member_image: row.member_image || '/profile-img.jpg'
                });
            }
        }

        // เรียงลำดับตามเลขที่บ้านแบบตัวเลข (เช่น 2 มาก่อน 10)
        const sortedHouses = Array.from(houseMap.values()).sort((a, b) =>
            String(a.house_no).localeCompare(String(b.house_no), 'th', { numeric: true })
        );

        res.json({ success: true, data: sortedHouses });
    } catch (err) {
        console.error('Get Water Households Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. ดึงรายชื่อผู้ใช้น้ำทั้งหมดในหมู่บ้าน (ใช้ได้ทั้งหน้าจัดการ และหน้าออกบิลค่าน้ำ)
app.get('/api/water/meters/:villageId', async (req, res) => {
    const { villageId } = req.params;
    try {
        const result = await pgPool.query(`
            SELECT
                wm.*,
                to_jsonb(h) AS h_json,
                to_jsonb(hm) AS hm_json,
                v.village_no,
                v.village_name,
                t.tambon_name_th,
                am.amphure_name_th,
                pr.province_name_th,
                hm.first_name,
                hm.last_name,
                hm.citizen_id,
                (
                    SELECT cpm.image_url
                    FROM user_profiles up
                    JOIN citizen_profiles_media cpm ON cpm.profile_id = up.profile_id AND cpm.is_active = true
                    WHERE REGEXP_REPLACE(
                        COALESCE(
                            to_jsonb(up)->>'national_id',
                            to_jsonb(up)->>'citizen_id',
                            to_jsonb(up)->>'id_card',
                            to_jsonb(up)->>'id_card_number',
                            ''
                        ), '[^0-9]', '', 'g'
                    ) = REGEXP_REPLACE(COALESCE(hm.citizen_id::text, ''), '[^0-9]', '', 'g')
                    AND COALESCE(hm.citizen_id::text, '') <> ''
                    LIMIT 1
                ) AS member_image,
                (
                    SELECT ua.username_phone
                    FROM user_profiles up
                    JOIN user_accounts ua ON ua.profile_id = up.profile_id
                    WHERE REGEXP_REPLACE(
                        COALESCE(
                            to_jsonb(up)->>'national_id',
                            to_jsonb(up)->>'citizen_id',
                            to_jsonb(up)->>'id_card',
                            to_jsonb(up)->>'id_card_number',
                            ''
                        ), '[^0-9]', '', 'g'
                    ) = REGEXP_REPLACE(COALESCE(hm.citizen_id::text, ''), '[^0-9]', '', 'g')
                    AND COALESCE(hm.citizen_id::text, '') <> ''
                    LIMIT 1
                ) AS account_phone
            FROM water_meters wm
            LEFT JOIN households h ON wm.household_id::text = h.household_id::text
            LEFT JOIN household_members hm ON wm.member_id::text = hm.member_id::text
            LEFT JOIN villages v ON wm.village_id::text = v.village_id::text
            LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
            LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
            LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
            WHERE wm.village_id::text = $1::text AND wm.is_active = true
            ORDER BY wm.meter_id DESC
        `, [String(villageId)]);

        const formatted = result.rows.map((r) => {
            const hJson = r.h_json || {};
            const hmJson = r.hm_json || {};
            const houseNo = hJson.house_no || hJson.house_number || hJson.address_no || '-';
            const phone = hmJson.phone || hmJson.phone_number || hmJson.tel || r.account_phone || '';
            const vName = r.village_name
                ? (r.village_name.startsWith('บ้าน') ? r.village_name : `บ้าน${r.village_name}`)
                : '';

            return {
                ...r,
                house_no: houseNo,
                phone,
                full_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
                full_address: `บ้านเลขที่ ${houseNo} หมู่ ${r.village_no || '-'} ${vName} ต.${r.tambon_name_th || '-'} อ.${r.amphure_name_th || '-'} จ.${r.province_name_th || '-'}`.trim(),
                member_image: r.member_image || '/profile-img.jpg'
            };
        });

        res.json({ success: true, data: formatted });
    } catch (err) {
        console.error('Get Water Meters Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. เพิ่มผู้ใช้น้ำประปาใหม่ (รองรับทั้ง UUID และตัวเลข)
app.post('/api/water/meters', async (req, res) => {
    const {
        village_id, household_id, member_id, meter_code, meter_photo_url,
        meter_status, payment_status, latitude, longitude, last_meter_reading, note, changed_by
    } = req.body;

    if (!village_id || !household_id || !member_id || !meter_code) {
        return res.status(400).json({ success: false, message: 'กรุณาเลือกบ้านเลขที่ ผู้ใช้น้ำ และกรอกเลขมิเตอร์ให้ครบถ้วน' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        const insertRes = await client.query(`
            INSERT INTO water_meters (
                village_id, household_id, member_id, meter_code, meter_photo_url,
                meter_status, payment_status, latitude, longitude, last_meter_reading, note
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
        `, [
            String(village_id), String(household_id), String(member_id), meter_code.trim(),
            meter_photo_url || null, meter_status || 'ACTIVE', payment_status || 'PAID',
            latitude || null, longitude || null, Number(last_meter_reading || 0), note || null
        ]);

        const newMeter = insertRes.rows[0];

        await client.query(`
            INSERT INTO water_meter_status_logs (meter_id, meter_status, payment_status, note, changed_by)
            VALUES ($1, $2, $3, $4, $5)
        `, [newMeter.meter_id, newMeter.meter_status, newMeter.payment_status, 'ลงทะเบียนผู้ใช้น้ำใหม่', changed_by || 'SYSTEM']);

        await client.query('COMMIT');
        res.json({ success: true, message: 'เพิ่มผู้ใช้น้ำประปาเรียบร้อยแล้ว', data: newMeter });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ success: false, message: 'เลขมิเตอร์นี้มีอยู่ในระบบแล้ว' });
        }
        console.error('Create Water Meter Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});
// 4. แก้ไขข้อมูลมิเตอร์ / อัปเดตสถานะ / พิกัด GPS
app.put('/api/water/meters/:meterId', async (req, res) => {
    const { meterId } = req.params;
    const {
        meter_code, meter_photo_url, meter_status, payment_status,
        latitude, longitude, last_meter_reading, note, changed_by
    } = req.body;

    const cleanMeterCode = String(meter_code || '').trim();
    if (!cleanMeterCode) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุเลขมิเตอร์น้ำ' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            UPDATE water_meters
            SET meter_code = $1, meter_photo_url = $2, meter_status = $3, payment_status = $4,
                latitude = $5, longitude = $6, last_meter_reading = $7, note = $8, updated_at = CURRENT_TIMESTAMP
            WHERE meter_id = $9
        `, [
            cleanMeterCode, meter_photo_url || null, meter_status || 'ACTIVE', payment_status || 'PAID',
            latitude || null, longitude || null, Number(last_meter_reading || 0), note || null, meterId
        ]);

        await client.query(`
            INSERT INTO water_meter_status_logs (meter_id, meter_status, payment_status, note, changed_by)
            VALUES ($1, $2, $3, $4, $5)
        `, [meterId, meter_status || 'ACTIVE', payment_status || 'PAID', note || 'อัปเดตข้อมูลมิเตอร์', changed_by || 'SYSTEM']);

        await client.query('COMMIT');
        res.json({ success: true, message: 'อัปเดตข้อมูลผู้ใช้น้ำเรียบร้อยแล้ว' });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ success: false, message: 'เลขมิเตอร์นี้มีอยู่ในระบบแล้ว' });
        }
        console.error('Update Water Meter Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 5. ลบผู้ใช้น้ำ (Soft Delete ไม่ลบประวัติจริง)
app.delete('/api/water/meters/:meterId', async (req, res) => {
    try {
        await pgPool.query(`UPDATE water_meters SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE meter_id = $1`, [req.params.meterId]);
        res.json({ success: true, message: 'ปิดใช้งานรายการผู้ใช้น้ำเรียบร้อยแล้ว' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =========================================================================
// ระบบจดมิเตอร์ ออกบิล ค่าจ้างคนจดมิเตอร์ รอบวันที่เก็บ และยอดค้างชำระย้อนหลัง
// =========================================================================
// =========================================================================
// Helper: ดึงข้อมูลหัวสลิปของหมู่บ้าน (ชื่อหมู่บ้าน + ที่อยู่เต็มถึงจังหวัด + ประธานกรรมการ)
// =========================================================================
async function getVillageSlipHeader(villageId, savedSettings = null) {
    let villageRow = null;
    try {
        const vRes = await pgPool.query(`
            SELECT
                v.village_no,
                v.village_name,
                t.tambon_name_th,
                am.amphure_name_th,
                pr.province_name_th
            FROM villages v
            LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
            LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
            LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
            WHERE v.village_id::text = $1::text
            LIMIT 1
        `, [String(villageId)]);
        villageRow = vRes.rows[0] || null;
    } catch (e) {
        console.error('Fetch village header error:', e.message);
    }

    // จัดรูปแบบชื่อหมู่บ้านไม่ให้ซ้ำคำว่า "บ้าน" (เช่น บ้านขมวด -> หมู่บ้านขมวด)
    const rawName = String(villageRow?.village_name || '').trim();
    let villageTitle = 'หมู่บ้านประปาชุมชน';
    if (rawName) {
        if (rawName.startsWith('หมู่บ้าน')) villageTitle = rawName;
        else if (rawName.startsWith('บ้าน')) villageTitle = `หมู่${rawName}`;
        else villageTitle = `หมู่บ้าน${rawName}`;
    }

    const addrParts = [];
    if (villageRow?.village_no) addrParts.push(`หมู่ที่ ${villageRow.village_no}`);
    if (villageRow?.tambon_name_th) addrParts.push(`ต.${villageRow.tambon_name_th}`);
    if (villageRow?.amphure_name_th) addrParts.push(`อ.${villageRow.amphure_name_th}`);
    if (villageRow?.province_name_th) addrParts.push(`จ.${villageRow.province_name_th}`);
    const villageFullAddress = addrParts.join(' ');

    // ดึงชื่อประธานกรรมการ (ใช้ค่าที่ตั้งไว้ก่อน ถ้าว่างให้ดึงอัตโนมัติจากผังคณะกรรมการน้ำประปาหมู่บ้าน)
    let presidentName = String(savedSettings?.president_name || '').trim();
    let presidentPosition = 'ประธานกรรมการน้ำประปาหมู่บ้าน';

    if (!presidentName) {
        try {
            const pRes = await pgPool.query(`
                SELECT
                    sp.position_name,
                    COALESCE(p.first_name, hm.first_name) AS first_name,
                    COALESCE(p.last_name, hm.last_name) AS last_name
                FROM user_positions upos
                JOIN community_committees cc ON upos.committee_id::text = cc.committee_id::text
                LEFT JOIN sys_positions sp ON upos.position_id = sp.position_id
                LEFT JOIN user_accounts a ON upos.account_id::text = a.account_id::text
                LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
                LEFT JOIN household_members hm ON upos.account_id::text = hm.member_id::text
                WHERE cc.village_id::text = $1::text
                  AND (
                      cc.committee_name LIKE '%น้ำ%'
                      OR cc.committee_name LIKE '%ประปา%'
                      OR cc.committee_name LIKE '%ปะปา%'
                  )
                  AND sp.position_name LIKE '%ประธาน%'
                ORDER BY upos.id ASC
                LIMIT 1
            `, [String(villageId)]);

            if (pRes.rows.length > 0) {
                const pr = pRes.rows[0];
                presidentName = `${pr.first_name || ''} ${pr.last_name || ''}`.trim();
                if (pr.position_name) presidentPosition = pr.position_name;
            }
        } catch (e) {
            console.error('Auto-fetch water president error:', e.message);
        }
    }

    return {
        village_name: rawName,
        village_no: villageRow?.village_no || '',
        tambon_name_th: villageRow?.tambon_name_th || '',
        amphure_name_th: villageRow?.amphure_name_th || '',
        province_name_th: villageRow?.province_name_th || '',
        village_title: villageTitle,
        village_full_address: villageFullAddress,
        president_name: presidentName,
        president_position: presidentPosition
    };
}

// 6. ดึงการตั้งค่าเรทค่าน้ำ ค่าจ้างคนจดมิเตอร์ รอบวันเก็บ/ครบกำหนด ประธานกรรมการ และบัญชีรับเงิน
app.get('/api/water/settings/:villageId', async (req, res) => {
    const { villageId } = req.params;
    try {
        const result = await pgPool.query(
            `SELECT * FROM water_settings WHERE village_id = $1 LIMIT 1`,
            [String(villageId)]
        );
        const settings = result.rows[0] || {
            village_id: String(villageId),
            unit_rate: 7,
            meter_fee: 10,
            reader_fee: 5,
            reading_day: 25,
            due_day: 5,
            due_next_month: true,
            bank_name: '',
            account_name: '',
            account_number: '',
            promptpay_id: '',
            president_name: ''
        };
        const villageInfo = await getVillageSlipHeader(villageId, settings);
        res.json({ success: true, data: settings, village_info: villageInfo });
    } catch (err) {
        console.error('Get Water Settings Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});
// 7. บันทึกการตั้งค่าทั่วไป (รอบวันเก็บ / หัวสลิป / บัญชีรับเงิน — ไม่แก้ราคาตรงนี้ ต้องผ่านรหัสประธาน)
app.put('/api/water/settings/:villageId', async (req, res) => {
    const { villageId } = req.params;
    const {
        reading_day, due_day, due_next_month,
        bank_name, account_name, account_number, promptpay_id, president_name, updated_by
    } = req.body;
    try {
        const result = await pgPool.query(`
            INSERT INTO water_settings (
                village_id, reading_day, due_day, due_next_month,
                bank_name, account_name, account_number, promptpay_id, president_name, updated_by, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
            ON CONFLICT (village_id) DO UPDATE SET
                reading_day = EXCLUDED.reading_day,
                due_day = EXCLUDED.due_day,
                due_next_month = EXCLUDED.due_next_month,
                bank_name = EXCLUDED.bank_name,
                account_name = EXCLUDED.account_name,
                account_number = EXCLUDED.account_number,
                promptpay_id = EXCLUDED.promptpay_id,
                president_name = EXCLUDED.president_name,
                updated_by = EXCLUDED.updated_by,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `, [
            String(villageId),
            Math.min(31, Math.max(1, Number(reading_day ?? 25))),
            Math.min(31, Math.max(1, Number(due_day ?? 5))),
            due_next_month !== undefined ? Boolean(due_next_month) : true,
            bank_name || '',
            account_name || '',
            account_number || '',
            String(promptpay_id || '').replace(/\D/g, ''),
            president_name || '',
            updated_by || 'ADMIN'
        ]);
        const villageInfo = await getVillageSlipHeader(villageId, result.rows[0]);
        res.json({
            success: true,
            message: 'บันทึกการตั้งค่ารอบเก็บเงินและบัญชีรับเงินเรียบร้อยแล้ว',
            data: result.rows[0],
            village_info: villageInfo
        });
    } catch (err) {
        console.error('Save Water Settings Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// =========================================================================
// ระบบตั้งราคาค่าน้ำ / ค่ารักษามิเตอร์ / ค่าเก็บ (ต้องใช้รหัสอนุมัติของประธานกรรมการทุกครั้ง)
// =========================================================================
const hashWaterApprovalPin = (pin) => {
    const cryptoMod = require('crypto');
    return cryptoMod.createHash('sha256').update(`banrao_water_pin::${String(pin || '').trim()}`).digest('hex');
};

// ตรวจสอบรหัสอนุมัติของประธาน (รองรับทั้งรหัสอนุมัติประธานที่ตั้งไว้ และรหัสผ่านบัญชีของประธานกรรมการ)
async function verifyWaterPresidentCode(client, villageId, inputCode, savedSettings) {
    const cleanCode = String(inputCode || '').trim();
    if (!cleanCode) return false;

    // 1. ตรวจกับรหัสอนุมัติประธาน (president_pin_hash) ใน water_settings
    if (savedSettings?.president_pin_hash) {
        if (hashWaterApprovalPin(cleanCode) === savedSettings.president_pin_hash) {
            return true;
        }
    }

    // 2. ตรวจสำรองกับรหัสผ่านบัญชี (user_accounts) ของประธานกรรมการในผังน้ำประปา
    try {
        const pRes = await client.query(`
            SELECT ua.password_hash, to_jsonb(ua) AS ua_json
            FROM user_positions upos
            JOIN community_committees cc ON upos.committee_id::text = cc.committee_id::text
            LEFT JOIN sys_positions sp ON upos.position_id = sp.position_id
            LEFT JOIN household_members hm ON upos.account_id::text = hm.member_id::text
            LEFT JOIN user_profiles up ON (
                REGEXP_REPLACE(
                    COALESCE(to_jsonb(up)->>'national_id', to_jsonb(up)->>'citizen_id', to_jsonb(up)->>'id_card', ''),
                    '[^0-9]', '', 'g'
                ) = REGEXP_REPLACE(COALESCE(hm.citizen_id::text, ''), '[^0-9]', '', 'g')
                AND COALESCE(hm.citizen_id::text, '') <> ''
            )
            LEFT JOIN user_accounts ua ON (
                ua.account_id::text = upos.account_id::text
                OR ua.profile_id = up.profile_id
            )
            WHERE cc.village_id::text = $1::text
              AND (cc.committee_name LIKE '%น้ำ%' OR cc.committee_name LIKE '%ประปา%' OR cc.committee_name LIKE '%ปะปา%')
              AND sp.position_name LIKE '%ประธาน%'
              AND ua.account_id IS NOT NULL
            LIMIT 1
        `, [String(villageId)]);

        if (pRes.rows.length > 0) {
            const row = pRes.rows[0];
            const uaJson = row.ua_json || {};
            if (uaJson.pin_code && String(uaJson.pin_code) === cleanCode) return true;
            if (row.password_hash && typeof bcrypt !== 'undefined') {
                const isMatch = await bcrypt.compare(cleanCode, row.password_hash).catch(() => false);
                if (isMatch) return true;
            }
        }
    } catch (e) {
        console.error('Verify president account password fallback error:', e.message);
    }

    return false;
}

// 12. ดึงข้อมูลราคาปัจจุบัน สถานะรหัสอนุมัติประธาน และประวัติการปรับราคา
app.get('/api/water/rates/:villageId', async (req, res) => {
    const { villageId } = req.params;
    try {
        const setRes = await pgPool.query(
            `SELECT * FROM water_settings WHERE village_id = $1 LIMIT 1`,
            [String(villageId)]
        );
        const settings = setRes.rows[0] || {
            village_id: String(villageId),
            unit_rate: 7,
            meter_fee: 10,
            reader_fee: 5,
            president_name: '',
            president_pin_hash: ''
        };
        const villageInfo = await getVillageSlipHeader(villageId, settings);
        const logsRes = await pgPool.query(`
            SELECT * FROM water_rate_change_logs
            WHERE village_id = $1
            ORDER BY created_at DESC
            LIMIT 30
        `, [String(villageId)]);

        res.json({
            success: true,
            data: {
                unit_rate: Number(settings.unit_rate ?? 7),
                meter_fee: Number(settings.meter_fee ?? 10),
                reader_fee: Number(settings.reader_fee ?? 5),
                has_president_pin: Boolean(settings.president_pin_hash),
                president_name: settings.president_name || villageInfo.president_name || '',
                village_title: villageInfo.village_title
            },
            logs: logsRes.rows
        });
    } catch (err) {
        console.error('Get Water Rates Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 13. ตั้ง / เปลี่ยนรหัสอนุมัติของประธานกรรมการ
app.post('/api/water/rates/:villageId/setup-pin', async (req, res) => {
    const { villageId } = req.params;
    const { old_pin, new_pin, updated_by } = req.body;

    if (!new_pin || String(new_pin).trim().length < 4) {
        return res.status(400).json({ success: false, message: 'กรุณากำหนดรหัสอนุมัติอย่างน้อย 4 ตัวอักษร/ตัวเลข' });
    }

    const client = await pgPool.connect();
    try {
        const setRes = await client.query(
            `SELECT * FROM water_settings WHERE village_id = $1 LIMIT 1`,
            [String(villageId)]
        );
        const existing = setRes.rows[0];

        // หากเคยตั้งรหัสไว้แล้ว ต้องยืนยันรหัสเดิมก่อนเปลี่ยน
        if (existing?.president_pin_hash) {
            const ok = await verifyWaterPresidentCode(client, villageId, old_pin, existing);
            if (!ok) {
                return res.status(403).json({ success: false, message: 'รหัสอนุมัติเดิมของประธานไม่ถูกต้อง' });
            }
        }

        const hashed = hashWaterApprovalPin(new_pin);
        await client.query(`
            INSERT INTO water_settings (village_id, president_pin_hash, updated_by, updated_at)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            ON CONFLICT (village_id) DO UPDATE SET
                president_pin_hash = EXCLUDED.president_pin_hash,
                updated_by = EXCLUDED.updated_by,
                updated_at = CURRENT_TIMESTAMP
        `, [String(villageId), hashed, updated_by || 'PRESIDENT']);

        res.json({ success: true, message: 'บันทึกรหัสอนุมัติของประธานกรรมการเรียบร้อยแล้ว' });
    } catch (err) {
        console.error('Setup President PIN Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 14. ปรับราคาค่าน้ำ / ค่ารักษามิเตอร์ / ค่าเก็บ (ต้องยืนยันรหัสของประธานทุกครั้ง + เก็บประวัติ)
app.put('/api/water/rates/:villageId', async (req, res) => {
    const { villageId } = req.params;
    const { unit_rate, meter_fee, reader_fee, approval_code, reason, changed_by } = req.body;

    if (!approval_code || !String(approval_code).trim()) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกรหัสอนุมัติของประธานกรรมการ' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        const setRes = await client.query(
            `SELECT * FROM water_settings WHERE village_id = $1 LIMIT 1`,
            [String(villageId)]
        );
        const existing = setRes.rows[0] || { unit_rate: 7, meter_fee: 10, reader_fee: 5, president_pin_hash: '' };

        const isApproved = await verifyWaterPresidentCode(client, villageId, approval_code, existing);
        if (!isApproved) {
            await client.query('ROLLBACK');
            return res.status(403).json({
                success: false,
                message: 'รหัสอนุมัติของประธานกรรมการไม่ถูกต้อง (ไม่อนุญาตให้เปลี่ยนแปลงราคา)'
            });
        }

        const villageInfo = await getVillageSlipHeader(villageId, existing);
        const presidentName = existing.president_name || villageInfo.president_name || 'ประธานกรรมการ';

        const newUnit = Number(unit_rate ?? existing.unit_rate ?? 7);
        const newMeter = Number(meter_fee ?? existing.meter_fee ?? 10);
        const newReader = Number(reader_fee ?? existing.reader_fee ?? 5);

        const updatedRes = await client.query(`
            INSERT INTO water_settings (
                village_id, unit_rate, meter_fee, reader_fee, updated_by, updated_at
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (village_id) DO UPDATE SET
                unit_rate = EXCLUDED.unit_rate,
                meter_fee = EXCLUDED.meter_fee,
                reader_fee = EXCLUDED.reader_fee,
                updated_by = EXCLUDED.updated_by,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `, [String(villageId), newUnit, newMeter, newReader, changed_by || presidentName]);

        await client.query(`
            INSERT INTO water_rate_change_logs (
                village_id, old_unit_rate, new_unit_rate,
                old_meter_fee, new_meter_fee,
                old_reader_fee, new_reader_fee,
                approved_by_president, changed_by, reason
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
            String(villageId),
            Number(existing.unit_rate ?? 7), newUnit,
            Number(existing.meter_fee ?? 10), newMeter,
            Number(existing.reader_fee ?? 5), newReader,
            presidentName,
            changed_by || 'ADMIN',
            reason || 'ปรับอัตราค่าน้ำประปาหมู่บ้าน'
        ]);

        await client.query('COMMIT');
        res.json({
            success: true,
            message: 'ประธานกรรมการอนุมัติการปรับราคาค่าน้ำเรียบร้อยแล้ว',
            data: updatedRes.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Update Water Rates Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});
// =========================================================================
// 🌟 ระบบเอกสารน้ำประปา V2: แยกใบแจ้งหนี้/ใบเสร็จ + Snapshot + ล็อกห้ามลบ + ยกเลิก (Void)
// =========================================================================

// ตัวช่วยดึงข้อมูล Snapshot ณ วันที่ออกเอกสาร/รับเงิน (เปลี่ยนกรรมการในอนาคต บิลเก่าไม่เปลี่ยนตาม)
async function buildWaterBillSnapshot(client, { villageId, meterId, householdId, memberId, readerAccountId, readerNameInput }) {
    const setRes = await client.query(
        `SELECT * FROM water_settings WHERE village_id::text = $1::text LIMIT 1`,
        [String(villageId)]
    ).catch(() => ({ rows: [] }));
    const settings = setRes.rows[0] || null;
    const header = typeof getVillageSlipHeader === 'function'
        ? await getVillageSlipHeader(villageId, settings).catch(() => null)
        : null;

    // ดึงชื่อผู้ใหญ่บ้าน / ประธานประปา / เหรัญญิก ณ ปัจจุบันเพื่อเก็บเป็น Snapshot
    const vRes = await client.query(`
        SELECT v.village_name, v.village_no, t.tambon_name_th, am.amphure_name_th, pr.province_name_th,
               COALESCE(hp.first_name || ' ' || hp.last_name, '') AS headman_name
        FROM villages v
        LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
        LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
        LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
        LEFT JOIN user_accounts ha ON v.headman_account_id = ha.account_id
        LEFT JOIN user_profiles hp ON ha.profile_id = hp.profile_id
        WHERE v.village_id::text = $1::text
        LIMIT 1
    `, [String(villageId)]).catch(() => ({ rows: [] }));
    const vRow = vRes.rows[0] || {};

    const waterOfficersRes = await client.query(`
        SELECT up.role_template_code,
               COALESCE(prof.first_name || ' ' || prof.last_name, hm.first_name || ' ' || hm.last_name, '') AS full_name
        FROM user_positions up
        LEFT JOIN user_accounts ua ON up.account_id = ua.account_id
        LEFT JOIN user_profiles prof ON ua.profile_id = prof.profile_id
        LEFT JOIN household_members hm ON up.member_id IS NOT NULL AND hm.member_id::text = up.member_id::text
        WHERE up.village_id::text = $1::text
          AND up.is_active = true
          AND up.status = 'ACTIVE'
          AND up.role_template_code IN ('WATER_PRESIDENT', 'WATER_TREASURER')
        ORDER BY up.approved_at DESC NULLS LAST, up.id DESC
    `, [String(villageId)]).catch(() => ({ rows: [] }));

    const activePresident = waterOfficersRes.rows.find((r) => r.role_template_code === 'WATER_PRESIDENT')?.full_name?.trim() || '';
    const activeTreasurer = waterOfficersRes.rows.find((r) => r.role_template_code === 'WATER_TREASURER')?.full_name?.trim() || '';

    const meterRes = await client.query(`
        SELECT wm.meter_code, to_jsonb(h) AS h_json, hm.first_name, hm.last_name
        FROM water_meters wm
        LEFT JOIN households h ON wm.household_id::text = h.household_id::text
        LEFT JOIN household_members hm ON wm.member_id::text = hm.member_id::text
        WHERE wm.meter_id = $1
        LIMIT 1
    `, [Number(meterId)]).catch(() => ({ rows: [] }));
    const mRow = meterRes.rows[0] || {};
    const hj = mRow.h_json || {};

    const vName = vRow.village_name
        ? (vRow.village_name.startsWith('บ้าน') ? vRow.village_name : `บ้าน${vRow.village_name}`)
        : (header?.village_title || '');
    const vFullAddr = header?.village_full_address || [
        vRow.village_no ? `หมู่ที่ ${vRow.village_no}` : '',
        vName,
        vRow.tambon_name_th ? `ต.${vRow.tambon_name_th}` : '',
        vRow.amphure_name_th ? `อ.${vRow.amphure_name_th}` : '',
        vRow.province_name_th ? `จ.${vRow.province_name_th}` : ''
    ].filter(Boolean).join(' ');

    return {
        snapshot_village_name: header?.village_title || vName || null,
        snapshot_village_address: vFullAddr || null,
        snapshot_headman_name: vRow.headman_name?.trim() || null,
        snapshot_president_name: (settings?.president_name || '').trim() || activePresident || header?.president_name || null,
        snapshot_treasurer_name: activeTreasurer || null,
        snapshot_reader_account_id: isValidUuidV3(readerAccountId) ? readerAccountId : null,
        snapshot_reader_name: (readerNameInput || '').trim() || null,
        snapshot_customer_name: `${mRow.first_name || ''} ${mRow.last_name || ''}`.trim() || null,
        snapshot_house_no: hj.house_no || hj.house_number || hj.address_no || null,
        snapshot_meter_no: mRow.meter_code || null
    };
}

// คำนวณสถานะมิเตอร์ใหม่ (นับเฉพาะบิลที่ยังไม่ถูกยกเลิก)
async function recalcMeterPaymentStatus(client, meterId) {
    const unpaidCheck = await client.query(`
        SELECT COUNT(*)::int AS cnt
        FROM water_bills
        WHERE meter_id = $1
          AND COALESCE(is_voided, false) = false
          AND payment_status <> 'PAID'
    `, [Number(meterId)]);
    const meterPayStatus = unpaidCheck.rows[0].cnt > 0 ? 'OVERDUE' : 'PAID';
    await client.query(
        `UPDATE water_meters SET payment_status = $1, updated_at = CURRENT_TIMESTAMP WHERE meter_id = $2`,
        [meterPayStatus, Number(meterId)]
    );
    return meterPayStatus;
}


// 8. ดึงรายการจดมิเตอร์และบิลประจำเดือนของหมู่บ้าน (ดึงเบอร์โทรจาก user_accounts/user_profiles + ชื่อผู้ใช้น้ำครบ 100%)
app.get('/api/water/bills/:villageId', async (req, res) => {
    const { villageId } = req.params;
    const billingMonth = req.query.month || new Date().toISOString().slice(0, 7);

    try {
        const setRes = await pgPool.query(
            `SELECT * FROM water_settings WHERE village_id::text = $1::text LIMIT 1`,
            [String(villageId)]
        );
        const settings = setRes.rows[0] || {
            unit_rate: 7, meter_fee: 10, reader_fee: 5,
            reading_day: 25, due_day: 5, due_next_month: true,
            bank_name: '', account_name: '', account_number: '', promptpay_id: '', president_name: ''
        };
        const villageInfo = typeof getVillageSlipHeader === 'function'
            ? await getVillageSlipHeader(villageId, settings)
            : { village_title: 'หมู่บ้านประปาชุมชน', village_full_address: '', president_name: settings.president_name || '' };

        const metersRes = await pgPool.query(`
            SELECT
                wm.meter_id,
                wm.meter_code,
                wm.household_id,
                wm.member_id,
                wm.meter_status,
                wm.last_meter_reading,
                to_jsonb(wm) AS wm_json,
                to_jsonb(h) AS h_json,
                hm.first_name,
                hm.last_name,
                to_jsonb(hm) AS hm_json,
                to_jsonb(up) AS up_json,
                ua.username_phone AS account_phone,
                v.village_no,
                v.village_name,
                t.tambon_name_th,
                am.amphure_name_th,
                pr.province_name_th,
                COALESCE(media.image_url, '/profile-img.jpg') AS member_image,
                wb.bill_id,
                wb.bill_no,
                wb.billing_month,
                wb.previous_reading,
                wb.current_reading,
                wb.units_used,
                wb.unit_rate,
                wb.meter_fee,
                COALESCE(wb.reader_fee, 0) AS reader_fee,
                wb.total_amount,
                wb.reading_date,
                wb.due_date,
                wb.reading_photo_url,
                wb.visit_status,
                wb.payment_status AS bill_payment_status,
                wb.payment_method,
                wb.slip_url,
                wb.note AS bill_note,
                wb.recorded_by,
                wb.paid_at,
                COALESCE(wb.document_stage, CASE WHEN wb.payment_status = 'PAID' THEN 'RECEIPT' ELSE 'INVOICE' END) AS document_stage,
                wb.receipt_no,
                wb.receipt_issued_at,
                COALESCE(wb.is_locked, wb.payment_status = 'PAID') AS is_locked,
                COALESCE(wb.is_voided, false) AS is_voided,
                wb.snapshot_village_name,
                wb.snapshot_village_address,
                wb.snapshot_headman_name,
                wb.snapshot_president_name,
                wb.snapshot_treasurer_name,
                wb.snapshot_reader_name,
                wb.snapshot_receiver_name,
                wb.snapshot_customer_name,
                wb.snapshot_house_no,
                wb.snapshot_meter_no
            FROM water_meters wm
            LEFT JOIN households h ON wm.household_id::text = h.household_id::text
            LEFT JOIN household_members hm ON wm.member_id::text = hm.member_id::text
            LEFT JOIN villages v ON wm.village_id::text = v.village_id::text
            LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
            LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
            LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
            LEFT JOIN LATERAL (
                SELECT p.* FROM user_profiles p
                WHERE COALESCE(hm.citizen_id::text, '') <> ''
                  AND REGEXP_REPLACE(COALESCE(p.citizen_id, ''), '[^0-9]', '', 'g') = REGEXP_REPLACE(COALESCE(hm.citizen_id::text, ''), '[^0-9]', '', 'g')
                LIMIT 1
            ) up ON true
            LEFT JOIN LATERAL (
                SELECT a.username_phone FROM user_accounts a
                WHERE a.profile_id = up.profile_id
                LIMIT 1
            ) ua ON true
            LEFT JOIN LATERAL (
                SELECT cpm.image_url FROM citizen_profiles_media cpm
                WHERE cpm.profile_id = up.profile_id AND cpm.is_active = true
                LIMIT 1
            ) media ON true
            LEFT JOIN water_bills wb
                ON wb.meter_id = wm.meter_id
               AND wb.billing_month = $2
               AND COALESCE(wb.is_voided, false) = false
            WHERE wm.village_id::text = $1::text
              AND wm.is_active = true
            ORDER BY COALESCE(to_jsonb(h)->>'house_no', to_jsonb(h)->>'house_number', ''), wm.meter_id ASC
        `, [String(villageId), billingMonth]);

        const arrearsRes = await pgPool.query(`
            SELECT bill_id, bill_no, meter_id, billing_month, total_amount
            FROM water_bills
            WHERE village_id::text = $1::text
              AND billing_month < $2
              AND COALESCE(is_voided, false) = false
              AND payment_status <> 'PAID'
            ORDER BY billing_month ASC
        `, [String(villageId), billingMonth]);

        const arrearsByMeter = {};
        for (const a of arrearsRes.rows) {
            if (!arrearsByMeter[a.meter_id]) arrearsByMeter[a.meter_id] = [];
            arrearsByMeter[a.meter_id].push(a);
        }

        const voidedRes = await pgPool.query(`
            SELECT
                wb.bill_id, wb.bill_no, wb.receipt_no, wb.billing_month, wb.total_amount,
                wb.units_used, wb.previous_reading, wb.current_reading,
                wb.voided_at, wb.voided_by_name, wb.void_reason,
                COALESCE(wb.snapshot_house_no, to_jsonb(h)->>'house_no', '-') AS house_no,
                COALESCE(wb.snapshot_meter_no, wm.meter_code, '-') AS meter_code,
                COALESCE(wb.snapshot_customer_name, hm.first_name || ' ' || hm.last_name, '-') AS full_name,
                COALESCE(wb.snapshot_reader_name, wb.recorded_by, '-') AS reader_name
            FROM water_bills wb
            LEFT JOIN water_meters wm ON wb.meter_id = wm.meter_id
            LEFT JOIN households h ON wb.household_id::text = h.household_id::text
            LEFT JOIN household_members hm ON wb.member_id::text = hm.member_id::text
            WHERE wb.village_id::text = $1::text
              AND wb.billing_month = $2
              AND COALESCE(wb.is_voided, false) = true
            ORDER BY wb.voided_at DESC NULLS LAST, wb.bill_id DESC
        `, [String(villageId), billingMonth]);

        const summary = {
            total_meters: metersRes.rows.length,
            recorded_count: 0,
            unrecorded_count: 0,
            paid_count: 0,
            unpaid_count: 0,
            not_found_count: 0,
            collected_total: 0,
            collected_cash: 0,
            collected_qr: 0,
            unpaid_amount: 0,
            total_arrears_previous: 0,
            total_reader_fee: 0,
            voided_count: voidedRes.rows.length
        };

        const data = metersRes.rows.map((r) => {
            const hj = r.h_json || {};
            const hmj = r.hm_json || {};
            const wmj = r.wm_json || {};
            const upj = r.up_json || {};
            const houseNo = r.snapshot_house_no || hj.house_no || hj.house_number || hj.address_no || '-';
            const vName = r.village_name
                ? (r.village_name.startsWith('บ้าน') ? r.village_name : `บ้าน${r.village_name}`)
                : '';
            const fullName =
                (r.snapshot_customer_name || '').trim() ||
                `${r.first_name || ''} ${r.last_name || ''}`.trim() ||
                `${upj.first_name || ''} ${upj.last_name || ''}`.trim() ||
                '-';
            const fullAddress = `บ้านเลขที่ ${houseNo} หมู่ ${r.village_no || '-'} ${vName} ต.${r.tambon_name_th || '-'} อ.${r.amphure_name_th || '-'} จ.${r.province_name_th || '-'}`.trim();
            const resolvedPhone =
                hmj.phone || hmj.phone_number || hmj.tel ||
                wmj.phone || wmj.contact_phone || wmj.phone_number ||
                upj.phone || upj.phone_number || upj.tel ||
                r.account_phone || '';

            const arrearsList = arrearsByMeter[r.meter_id] || [];
            const arrearsTotal = arrearsList.reduce((s, a) => s + Number(a.total_amount || 0), 0);
            summary.total_arrears_previous += arrearsTotal;

            if (r.bill_id) {
                summary.recorded_count += 1;
                summary.total_reader_fee += Number(r.reader_fee || 0);
                if (r.bill_payment_status === 'PAID') {
                    summary.paid_count += 1;
                    summary.collected_total += Number(r.total_amount || 0);
                    if (r.payment_method === 'CASH') summary.collected_cash += Number(r.total_amount || 0);
                    else summary.collected_qr += Number(r.total_amount || 0);
                } else {
                    summary.unpaid_count += 1;
                    summary.unpaid_amount += Number(r.total_amount || 0);
                    if (r.visit_status === 'NOT_FOUND') summary.not_found_count += 1;
                }
            } else {
                summary.unrecorded_count += 1;
            }

            return {
                ...r,
                house_no: houseNo,
                full_name: fullName,
                full_address: fullAddress,
                phone: resolvedPhone,
                latitude: wmj.latitude ?? wmj.lat ?? null,
                longitude: wmj.longitude ?? wmj.lng ?? null,
                arrears_list: arrearsList,
                arrears_total: arrearsTotal,
                grand_total_with_arrears: Number(r.total_amount || 0) + arrearsTotal
            };
        });

        res.json({
            success: true,
            settings,
            village_info: villageInfo,
            summary,
            data,
            voided_bills: voidedRes.rows
        });
    } catch (err) {
        console.error('Get Water Bills Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// 9. บันทึกการจดมิเตอร์ -> ออก "ใบแจ้งหนี้" (หรือ "ใบเสร็จรับเงิน" ทันทีถ้าจ่ายสด/QR) + เก็บ Snapshot (แก้พารามิเตอร์ไม่ซ้ำ 100%)
app.post('/api/water/bills', async (req, res) => {
    const {
        village_id, meter_id, household_id, member_id, billing_month,
        previous_reading, current_reading, unit_rate, meter_fee, reader_fee,
        reading_date, due_date, reading_photo_url, visit_status,
        payment_status, payment_method, slip_url, note, recorded_by
    } = req.body;

    if (!meter_id || !billing_month) {
        return res.status(400).json({ success: false, message: 'ข้อมูลมิเตอร์หรือรอบเดือนไม่ครบถ้วน' });
    }

    const prevNum = Number(previous_reading || 0);
    const currNum = Number(current_reading || 0);
    if (currNum < prevNum) {
        return res.status(400).json({ success: false, message: 'เลขมิเตอร์ครั้งนี้ต้องไม่น้อยกว่าเลขมิเตอร์เดือนก่อน' });
    }

    const decoded = verifyRequestJwt(req);
    const actorAccountId = decoded?.account_id || req.headers['x-account-id'] || null;

    const unitsUsed = Number((currNum - prevNum).toFixed(2));
    const rate = Number(unit_rate || 0);
    const fee = Number(meter_fee || 0);
    const rFee = Number(reader_fee || 0);
    const totalAmount = Number((unitsUsed * rate + fee + rFee).toFixed(2));
    const finalPaymentStatus = payment_status || 'UNPAID';
    const isPaidNow = finalPaymentStatus === 'PAID';
    const finalMethod = isPaidNow ? (payment_method || 'CASH') : 'NONE';
    const docStage = isPaidNow ? 'RECEIPT' : 'INVOICE';

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        const existingRes = await client.query(`
            SELECT * FROM water_bills
            WHERE meter_id = $1
              AND billing_month = $2
              AND COALESCE(is_voided, false) = false
            LIMIT 1
        `, [Number(meter_id), billing_month]);

        const existing = existingRes.rows[0] || null;

        if (existing && (existing.payment_status === 'PAID' || existing.is_locked || existing.receipt_no)) {
            await client.query('ROLLBACK');
            return res.status(403).json({
                success: false,
                code: 'BILL_LOCKED',
                message: `บิลเลขที่ ${existing.receipt_no || existing.bill_no} ชำระเงินและออกใบเสร็จรับเงินแล้ว ถูกล็อกห้ามแก้ไขหรือลบ หากข้อมูลผิดกรุณาใช้ปุ่ม "ยกเลิกเอกสาร" พร้อมระบุเหตุผล`
            });
        }

        const snap = await buildWaterBillSnapshot(client, {
            villageId: village_id,
            meterId: meter_id,
            householdId: household_id,
            memberId: member_id,
            readerAccountId: actorAccountId,
            readerNameInput: recorded_by || 'STAFF'
        });

        const paidAtVal = isPaidNow ? new Date() : null;
        const receiverAccountId = isPaidNow ? snap.snapshot_reader_account_id : null;
        const receiverName = isPaidNow ? snap.snapshot_reader_name : null;

        let savedBill;
        if (existing) {
            const updRes = await client.query(`
                UPDATE water_bills
                SET previous_reading = $1,
                    current_reading = $2,
                    units_used = $3,
                    unit_rate = $4,
                    meter_fee = $5,
                    reader_fee = $6,
                    total_amount = $7,
                    reading_date = $8,
                    due_date = $9,
                    reading_photo_url = COALESCE($10, reading_photo_url),
                    visit_status = $11,
                    payment_status = $12,
                    payment_method = $13,
                    slip_url = COALESCE($14, slip_url),
                    note = $15,
                    recorded_by = $16,
                    document_stage = $17,
                    is_locked = $18,
                    paid_at = $19,
                    receipt_issued_at = $20,
                    snapshot_village_name = COALESCE(snapshot_village_name, $21),
                    snapshot_village_address = COALESCE(snapshot_village_address, $22),
                    snapshot_headman_name = COALESCE(snapshot_headman_name, $23),
                    snapshot_president_name = COALESCE(snapshot_president_name, $24),
                    snapshot_treasurer_name = COALESCE(snapshot_treasurer_name, $25),
                    snapshot_reader_account_id = COALESCE($26::uuid, snapshot_reader_account_id),
                    snapshot_reader_name = COALESCE($27, snapshot_reader_name),
                    snapshot_receiver_account_id = COALESCE($28::uuid, snapshot_receiver_account_id),
                    snapshot_receiver_name = COALESCE($29, snapshot_receiver_name),
                    snapshot_customer_name = COALESCE(snapshot_customer_name, $30),
                    snapshot_house_no = COALESCE(snapshot_house_no, $31),
                    snapshot_meter_no = COALESCE(snapshot_meter_no, $32),
                    updated_at = CURRENT_TIMESTAMP
                WHERE bill_id = $33
                RETURNING *
            `, [
                prevNum, currNum, unitsUsed, rate, fee, rFee, totalAmount,
                reading_date || null, due_date || null, reading_photo_url || null,
                visit_status || 'NORMAL', finalPaymentStatus, finalMethod,
                slip_url || null, note || null, recorded_by || 'STAFF',
                docStage, isPaidNow, paidAtVal, paidAtVal,
                snap.snapshot_village_name, snap.snapshot_village_address,
                snap.snapshot_headman_name, snap.snapshot_president_name, snap.snapshot_treasurer_name,
                snap.snapshot_reader_account_id, snap.snapshot_reader_name,
                receiverAccountId, receiverName,
                snap.snapshot_customer_name, snap.snapshot_house_no, snap.snapshot_meter_no,
                existing.bill_id
            ]);
            savedBill = updRes.rows[0];
        } else {
            const voidCntRes = await client.query(
                `SELECT COUNT(*)::int AS cnt FROM water_bills WHERE meter_id = $1 AND billing_month = $2`,
                [Number(meter_id), billing_month]
            );
            const revNum = voidCntRes.rows[0].cnt;
            const baseBillNo = `WB-${String(billing_month).replace('-', '')}-${String(meter_id).padStart(4, '0')}`;
            const billNo = revNum > 0 ? `${baseBillNo}-R${revNum + 1}` : baseBillNo;

            const insRes = await client.query(`
                INSERT INTO water_bills (
                    bill_no, village_id, meter_id, household_id, member_id, billing_month,
                    previous_reading, current_reading, units_used, unit_rate, meter_fee, reader_fee, total_amount,
                    reading_date, due_date, reading_photo_url, visit_status, payment_status, payment_method,
                    slip_url, note, recorded_by,
                    document_stage, is_locked, is_voided,
                    paid_at, receipt_issued_at,
                    snapshot_village_name, snapshot_village_address,
                    snapshot_headman_name, snapshot_president_name, snapshot_treasurer_name,
                    snapshot_reader_account_id, snapshot_reader_name,
                    snapshot_receiver_account_id, snapshot_receiver_name,
                    snapshot_customer_name, snapshot_house_no, snapshot_meter_no
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12, $13,
                    $14, $15, $16, $17, $18, $19,
                    $20, $21, $22,
                    $23, $24, false,
                    $25, $26,
                    $27, $28,
                    $29, $30, $31,
                    $32::uuid, $33,
                    $34::uuid, $35,
                    $36, $37, $38
                )
                RETURNING *
            `, [
                billNo, String(village_id), Number(meter_id), String(household_id), String(member_id), billing_month,
                prevNum, currNum, unitsUsed, rate, fee, rFee, totalAmount,
                reading_date || null, due_date || null, reading_photo_url || null,
                visit_status || 'NORMAL', finalPaymentStatus, finalMethod,
                slip_url || null, note || null, recorded_by || 'STAFF',
                docStage, isPaidNow,
                paidAtVal, paidAtVal,
                snap.snapshot_village_name, snap.snapshot_village_address,
                snap.snapshot_headman_name, snap.snapshot_president_name, snap.snapshot_treasurer_name,
                snap.snapshot_reader_account_id, snap.snapshot_reader_name,
                receiverAccountId, receiverName,
                snap.snapshot_customer_name, snap.snapshot_house_no, snap.snapshot_meter_no
            ]);
            savedBill = insRes.rows[0];
        }

        if (isPaidNow && !savedBill.receipt_no) {
            const receiptNo = `REC-${String(billing_month).replace('-', '')}-${String(savedBill.bill_id).padStart(4, '0')}`;
            const recUpd = await client.query(
                `UPDATE water_bills SET receipt_no = $1, receipt_issued_at = COALESCE(receipt_issued_at, CURRENT_TIMESTAMP), document_stage = 'RECEIPT', is_locked = true WHERE bill_id = $2 RETURNING *`,
                [receiptNo, savedBill.bill_id]
            );
            savedBill = recUpd.rows[0];
        }

        const meterPayStatus = await recalcMeterPaymentStatus(client, meter_id);
        await client.query(
            `UPDATE water_meters SET last_meter_reading = $1, updated_at = CURRENT_TIMESTAMP WHERE meter_id = $2`,
            [currNum, Number(meter_id)]
        );

        await client.query(`
            INSERT INTO water_meter_status_logs (meter_id, meter_status, payment_status, note, changed_by)
            VALUES ($1, 'ACTIVE', $2, $3, $4)
        `, [
            Number(meter_id),
            meterPayStatus,
            isPaidNow
                ? `จดมิเตอร์และออกใบเสร็จรับเงิน ${savedBill.receipt_no} (${prevNum}→${currNum} = ${unitsUsed} หน่วย, รวม ${totalAmount} บ.)`
                : `จดมิเตอร์และออกใบแจ้งหนี้ ${savedBill.bill_no} (${prevNum}→${currNum} = ${unitsUsed} หน่วย, รวม ${totalAmount} บ., รอชำระ)`,
            recorded_by || 'STAFF'
        ]);

        await client.query('COMMIT');
        res.json({
            success: true,
            message: isPaidNow
                ? `รับชำระและออกใบเสร็จรับเงินเลขที่ ${savedBill.receipt_no} เรียบร้อยแล้ว`
                : `ออกใบแจ้งหนี้เลขที่ ${savedBill.bill_no} เรียบร้อยแล้ว (รอชำระเงิน)`,
            data: savedBill
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Save Water Bill Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 10.1 ลบใบแจ้งหนี้ (อนุญาตเฉพาะใบแจ้งหนี้ที่ยังไม่ชำระเท่านั้น — ใบเสร็จรับเงินห้ามลบเด็ดขาด!)
app.delete('/api/water/bills/:billId', async (req, res) => {
    const { billId } = req.params;
    const decoded = verifyRequestJwt(req);
    const actorAccountId = decoded?.account_id || req.headers['x-account-id'] || null;

    const client = await pgPool.connect();
    try {
        const secCheck = await resolveUserSecurityContext(client, actorAccountId);
        if (!secCheck.ok) {
            return res.status(401).json({ success: false, message: secCheck.reason || 'กรุณาเข้าสู่ระบบใหม่' });
        }
        const ctx = secCheck.context;
        const canDeleteInvoice =
            ctx.is_super_admin ||
            ctx.role_templates.some((r) => ['VILLAGE_HEADMAN', 'VILLAGE_ADMIN', 'WATER_PRESIDENT', 'WATER_TREASURER', 'WATER_READER'].includes(r));

        if (!canDeleteInvoice) {
            return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์ลบใบแจ้งหนี้' });
        }

        await client.query('BEGIN');
        const curRes = await client.query(`SELECT * FROM water_bills WHERE bill_id = $1 LIMIT 1`, [billId]);
        if (curRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบเอกสารบิลนี้' });
        }
        const bill = curRes.rows[0];

        if (!ctx.is_super_admin && String(bill.village_id) !== String(ctx.village_id)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, message: 'ไม่อนุญาตให้ลบข้อมูลข้ามหมู่บ้าน' });
        }

        // 🔒 กติกาห้ามลบเด็ดขาดสำหรับบิลที่ชำระแล้ว / มีใบเสร็จ / ถูกล็อก / ถูกยกเลิกแล้ว
        if (bill.payment_status === 'PAID' || bill.receipt_no || bill.is_locked || bill.is_voided) {
            await client.query('ROLLBACK');
            return res.status(403).json({
                success: false,
                code: 'DELETE_FORBIDDEN_LOCKED',
                message: 'ห้ามลบบิลหรือใบเสร็จรับเงินที่ชำระเงินแล้ว (ถูกล็อกทางบัญชี) กรุณาใช้ปุ่ม "ยกเลิกเอกสาร" พร้อมระบุเหตุผลแทน'
            });
        }

        await client.query(`DELETE FROM water_bills WHERE bill_id = $1`, [billId]);
        await recalcMeterPaymentStatus(client, bill.meter_id);

        await client.query(`
            INSERT INTO water_meter_status_logs (meter_id, meter_status, payment_status, note, changed_by)
            VALUES ($1, 'ACTIVE', 'OVERDUE', $2, $3)
        `, [bill.meter_id, `ลบใบแจ้งหนี้ที่ยังไม่ชำระ ${bill.bill_no}`, ctx.full_name]);

        await client.query('COMMIT');
        res.json({ success: true, message: `ลบใบแจ้งหนี้ ${bill.bill_no} เรียบร้อยแล้ว` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Delete Water Bill Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 10.2 ยกเลิกเอกสารพร้อมเหตุผล (Void) แทนการลบ -> เก็บประวัติถาวรในรายงาน (ต้องยืนยัน PIN ผู้ใหญ่บ้านหากเป็นใบเสร็จที่ชำระแล้ว)
app.post('/api/water/bills/:billId/void', async (req, res) => {
    const { billId } = req.params;
    const { void_reason, pin_code } = req.body;
    const decoded = verifyRequestJwt(req);
    const actorAccountId = decoded?.account_id || req.headers['x-account-id'] || null;

    if (!void_reason || String(void_reason).trim().length < 3) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผลในการยกเลิกเอกสารให้ชัดเจน' });
    }

    const client = await pgPool.connect();
    try {
        const secCheck = await resolveUserSecurityContext(client, actorAccountId);
        if (!secCheck.ok) {
            return res.status(401).json({ success: false, message: secCheck.reason || 'กรุณาเข้าสู่ระบบใหม่' });
        }
        const ctx = secCheck.context;
        const canVoid =
            ctx.is_super_admin ||
            ctx.role_templates.some((r) => ['VILLAGE_HEADMAN', 'WATER_PRESIDENT', 'WATER_TREASURER'].includes(r));

        if (!canVoid) {
            return res.status(403).json({
                success: false,
                message: 'เฉพาะผู้ใหญ่บ้าน ประธานประปา หรือเหรัญญิก เท่านั้นที่สามารถยกเลิกเอกสารใบเสร็จได้'
            });
        }

        await client.query('BEGIN');
        const curRes = await client.query(`SELECT * FROM water_bills WHERE bill_id = $1 LIMIT 1`, [billId]);
        if (curRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบเอกสารบิลนี้' });
        }
        const bill = curRes.rows[0];

        if (!ctx.is_super_admin && String(bill.village_id) !== String(ctx.village_id)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, message: 'ไม่อนุญาตให้ยกเลิกเอกสารข้ามหมู่บ้าน' });
        }
        if (bill.is_voided) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'เอกสารนี้ถูกยกเลิกไปแล้ว' });
        }

        // หากเป็นใบเสร็จที่ชำระเงินแล้ว ต้องยืนยันด้วยรหัส PIN ผู้ใหญ่บ้านเสมอ (ยกเว้น Super Admin)
        if ((bill.payment_status === 'PAID' || bill.receipt_no) && !ctx.is_super_admin) {
            const pinOk = await verifyVillageHeadmanPin(client, bill.village_id, pin_code);
            if (!pinOk) {
                await client.query('ROLLBACK');
                return res.status(403).json({ success: false, message: 'รหัส PIN อนุมัติของผู้ใหญ่บ้านไม่ถูกต้อง' });
            }
        }

        const voidRes = await client.query(`
            UPDATE water_bills
            SET is_voided = true,
                document_stage = 'VOIDED',
                is_locked = true,
                voided_at = CURRENT_TIMESTAMP,
                voided_by = $1::uuid,
                voided_by_name = $2,
                void_reason = $3,
                updated_at = CURRENT_TIMESTAMP
            WHERE bill_id = $4
            RETURNING *
        `, [ctx.account_id, ctx.full_name, String(void_reason).trim(), billId]);

        const meterPayStatus = await recalcMeterPaymentStatus(client, bill.meter_id);

        await client.query(`
            INSERT INTO water_meter_status_logs (meter_id, meter_status, payment_status, note, changed_by)
            VALUES ($1, 'ACTIVE', $2, $3, $4)
        `, [
            bill.meter_id,
            meterPayStatus,
            `ยกเลิกเอกสาร ${bill.receipt_no || bill.bill_no} (เหตุผล: ${String(void_reason).trim()})`,
            ctx.full_name
        ]);

        await client.query(`
            INSERT INTO sys_approval_logs (
                village_id, target_type, target_id, target_account_id,
                action_type, old_status, new_status, approved_by, note
            ) VALUES ($1::uuid, 'WATER_BILL', $2, NULL, 'VOID', $3, 'VOIDED', $4::uuid, $5)
        `, [
            bill.village_id,
            String(bill.bill_id),
            bill.document_stage || bill.payment_status,
            ctx.account_id,
            `ยกเลิกเอกสาร ${bill.receipt_no || bill.bill_no} เหตุผล: ${String(void_reason).trim()}`
        ]).catch(() => {});

        await client.query('COMMIT');
        res.json({
            success: true,
            message: `ยกเลิกเอกสาร ${bill.receipt_no || bill.bill_no} แล้ว (เก็บหลักฐานไว้ในรายงานถาวรและสามารถจดออกใบแจ้งหนี้ใหม่ได้)`,
            data: voidRes.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Void Water Bill Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 11. ดึงบิลค่าน้ำสำหรับเจ้าของบ้าน (ส่งชื่อผู้ใช้น้ำ + เบอร์โทร + Snapshot ครบถ้วน)
app.get('/api/water/my-bills/:accountId', async (req, res) => {
    const decoded = verifyRequestJwt(req);
    const accountId = decoded?.account_id || req.params.accountId;

    try {
        const userRes = await pgPool.query(`
            SELECT ua.account_id, ua.village_id, ua.username_phone, to_jsonb(up) AS up_json
            FROM user_accounts ua
            LEFT JOIN user_profiles up ON ua.profile_id = up.profile_id
            WHERE ua.account_id::text = $1::text
            LIMIT 1
        `, [String(accountId)]);

        if (userRes.rows.length === 0) {
            return res.json({ success: true, data: [], settings: null, village_info: null });
        }

        const upJson = userRes.rows[0].up_json || {};
        const cleanCid = String(
            upJson.national_id || upJson.citizen_id || upJson.id_card || upJson.id_card_number || ''
        ).replace(/\D/g, '');

        let householdIds = [];
        if (cleanCid.length === 13) {
            const hmRes = await pgPool.query(`
                SELECT DISTINCT household_id::text AS hid
                FROM household_members
                WHERE REGEXP_REPLACE(COALESCE(citizen_id::text, ''), '[^0-9]', '', 'g') = $1
                  AND status = 'ACTIVE'
            `, [cleanCid]);
            householdIds = hmRes.rows.map((r) => r.hid);
        }

        if (householdIds.length === 0) {
            return res.json({ success: true, data: [], settings: null, village_info: null });
        }

        const billsRes = await pgPool.query(`
            SELECT
                wb.*,
                COALESCE(wb.reader_fee, 0) AS reader_fee,
                COALESCE(wb.document_stage, CASE WHEN wb.payment_status = 'PAID' THEN 'RECEIPT' ELSE 'INVOICE' END) AS document_stage,
                COALESCE(wb.is_locked, wb.payment_status = 'PAID') AS is_locked,
                COALESCE(wb.is_voided, false) AS is_voided,
                wm.meter_code, wm.meter_status,
                to_jsonb(wm) AS wm_json,
                to_jsonb(h) AS h_json,
                hm.first_name, hm.last_name,
                to_jsonb(hm) AS hm_json,
                to_jsonb(up_m) AS up_json,
                ua_m.username_phone AS account_phone,
                v.village_no, v.village_name,
                t.tambon_name_th, am.amphure_name_th, pr.province_name_th
            FROM water_bills wb
            JOIN water_meters wm ON wb.meter_id = wm.meter_id
            LEFT JOIN households h ON wb.household_id::text = h.household_id::text
            LEFT JOIN household_members hm ON wb.member_id::text = hm.member_id::text
            LEFT JOIN LATERAL (
                SELECT p.* FROM user_profiles p
                WHERE COALESCE(hm.citizen_id::text, '') <> ''
                  AND REGEXP_REPLACE(COALESCE(p.citizen_id, ''), '[^0-9]', '', 'g') = REGEXP_REPLACE(COALESCE(hm.citizen_id::text, ''), '[^0-9]', '', 'g')
                LIMIT 1
            ) up_m ON true
            LEFT JOIN LATERAL (
                SELECT a.username_phone FROM user_accounts a
                WHERE a.profile_id = up_m.profile_id
                LIMIT 1
            ) ua_m ON true
            LEFT JOIN villages v ON wb.village_id::text = v.village_id::text
            LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
            LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
            LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
            WHERE wb.household_id::text = ANY($1::text[])
            ORDER BY wb.billing_month DESC, wb.is_voided ASC, wb.bill_id DESC
        `, [householdIds]);

        const villageId = billsRes.rows[0]?.village_id || userRes.rows[0].village_id;
        let settings = null;
        let villageInfo = null;
        if (villageId) {
            const setRes = await pgPool.query(`SELECT * FROM water_settings WHERE village_id::text = $1::text LIMIT 1`, [String(villageId)]);
            settings = setRes.rows[0] || null;
            villageInfo = typeof getVillageSlipHeader === 'function'
                ? await getVillageSlipHeader(villageId, settings)
                : null;
        }

        const formatted = billsRes.rows.map((r) => {
            const hJson = r.h_json || {};
            const hmj = r.hm_json || {};
            const wmj = r.wm_json || {};
            const upj = r.up_json || {};
            const houseNo = r.snapshot_house_no || hJson.house_no || hJson.house_number || hJson.address_no || '-';
            const vName = r.village_name
                ? (r.village_name.startsWith('บ้าน') ? r.village_name : `บ้าน${r.village_name}`)
                : '';
            const fullName =
                (r.snapshot_customer_name || '').trim() ||
                `${r.first_name || ''} ${r.last_name || ''}`.trim() ||
                `${upj.first_name || ''} ${upj.last_name || ''}`.trim() ||
                '-';
            const resolvedPhone =
                hmj.phone || hmj.phone_number || hmj.tel ||
                wmj.phone || wmj.contact_phone || wmj.phone_number ||
                upj.phone || upj.phone_number || upj.tel ||
                r.account_phone || '';

            return {
                ...r,
                house_no: houseNo,
                meter_code: r.snapshot_meter_no || r.meter_code,
                full_name: fullName,
                phone: resolvedPhone,
                full_address: `บ้านเลขที่ ${houseNo} หมู่ ${r.village_no || '-'} ${vName} ต.${r.tambon_name_th || '-'} อ.${r.amphure_name_th || '-'} จ.${r.province_name_th || '-'}`.trim()
            };
        });

        res.json({ success: true, settings, village_info: villageInfo, data: formatted });
    } catch (err) {
        console.error('Get My Water Bills Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// =========================================================================
// 🌟 V3.1: ระบบผลัดเปลี่ยนกรรมการ / ส่งมอบงาน (ปรับคนเดิมกลับเป็นประชาชน + เก็บประวัติถาวร)
// =========================================================================
app.post('/api/v3/committee-leaders/handover', async (req, res) => {
    const {
        village_id, approver_account_id, pin_code,
        outgoing_record_id,
        incoming_account_id, incoming_member_id, incoming_citizen_id, incoming_full_name,
        handover_reason, start_date, end_date
    } = req.body;

    if (!isValidUuidV3(village_id) || !isValidUuidV3(approver_account_id) || !outgoing_record_id) {
        return res.status(400).json({ success: false, message: 'ข้อมูลส่งมอบงานไม่ครบถ้วน' });
    }
    if (!pin_code) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกรหัส PIN อนุมัติของผู้ใหญ่บ้าน' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        const pinOk = await verifyVillageHeadmanPin(client, village_id, pin_code);
        if (!pinOk) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, message: 'รหัส PIN อนุมัติของผู้ใหญ่บ้านไม่ถูกต้อง' });
        }

        const outRes = await client.query(`
            SELECT up.*, cc.committee_name,
                   COALESCE(prof.first_name || ' ' || prof.last_name, hm.first_name || ' ' || hm.last_name, '') AS outgoing_name
            FROM user_positions up
            LEFT JOIN community_committees cc ON up.committee_id = cc.committee_id
            LEFT JOIN user_accounts ua ON up.account_id = ua.account_id
            LEFT JOIN user_profiles prof ON ua.profile_id = prof.profile_id
            LEFT JOIN household_members hm ON up.member_id IS NOT NULL AND hm.member_id::text = up.member_id::text
            WHERE up.id = $1 AND (up.village_id = $2::uuid OR up.village_id IS NULL)
            LIMIT 1
        `, [Number(outgoing_record_id), village_id]);

        if (outRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลตำแหน่งเดิมที่ต้องการส่งมอบ' });
        }
        const outRec = outRes.rows[0];

        // 1. ปิดวาระคนเดิม (ไม่ลบประวัติเก่าในระบบ — แค่ปิด active)
        await client.query(`
            UPDATE user_positions
            SET status = 'REVOKED',
                is_active = false,
                end_date = CURRENT_DATE,
                end_reason = $1
            WHERE id = $2
        `, [handover_reason || 'ส่งมอบงานและผลัดเปลี่ยนกรรมการ', outRec.id]);

        // ปรับสิทธิ์คนเดิมกลับเป็น CITIZEN อัตโนมัติหากไม่มีตำแหน่งอื่น
        const outShift = outRec.account_id
            ? await syncUserAccountRoleFromPositions(client, outRec.account_id)
            : { oldRole: null, newRole: 'CITIZEN' };

        // 2. แต่งตั้งคนใหม่มารับช่วงต่อในตำแหน่งและชุดสิทธิ์เดียวกัน (ถ้ามีการเลือกคนใหม่)
        let newRecord = null;
        let realIncomingAccountId = null;
        const hasIncoming = Boolean(incoming_account_id || incoming_member_id || incoming_citizen_id);

        if (hasIncoming) {
            realIncomingAccountId = await resolveRealUserAccountId(client, {
                accountId: incoming_account_id,
                citizenId: incoming_citizen_id
            });
            const cleanCid = String(incoming_citizen_id || '').replace(/\D/g, '') || null;

            const insRes = await client.query(`
                INSERT INTO user_positions (
                    village_id, committee_id, account_id, member_id, citizen_id,
                    position_id, custom_position_title, role_template_code,
                    scope_type, scope_id, start_date, end_date,
                    responsibilities, parent_id, assigned_by,
                    approved_by, approved_at, approval_note,
                    status, is_active
                ) VALUES (
                    $1::uuid, $2, $3::uuid, $4, $5,
                    $6, $7, $8,
                    'VILLAGE', $1::text, $9, $10,
                    $11, $12, $13::uuid,
                    $13::uuid, CURRENT_TIMESTAMP, $14,
                    'ACTIVE', true
                )
                RETURNING *
            `, [
                village_id,
                outRec.committee_id,
                realIncomingAccountId,
                incoming_member_id ? String(incoming_member_id) : null,
                cleanCid,
                outRec.position_id,
                outRec.custom_position_title,
                outRec.role_template_code,
                start_date || new Date().toISOString().split('T')[0],
                end_date || null,
                outRec.responsibilities || '',
                outRec.parent_id,
                approver_account_id,
                `รับมอบงานต่อจาก ${outRec.outgoing_name?.trim() || 'กรรมการเดิม'}`
            ]);
            newRecord = insRes.rows[0];

            // ย้ายลูกน้องในผังเดิมมาอยู่ใต้คนใหม่
            await client.query(
                `UPDATE user_positions SET parent_id = $1 WHERE parent_id = $2 AND is_active = true`,
                [newRecord.id, outRec.id]
            );

            if (realIncomingAccountId) {
                await syncUserAccountRoleFromPositions(client, realIncomingAccountId);
            }

            // หากเปลี่ยนตัวประธานประปา อัปเดตชื่อประธานสำหรับบิลอนาคต (บิลเก่าที่เก็บ Snapshot แล้วจะไม่เปลี่ยน!)
            if (outRec.role_template_code === 'WATER_PRESIDENT' && incoming_full_name) {
                await client.query(
                    `UPDATE water_settings SET president_name = $1, updated_at = CURRENT_TIMESTAMP WHERE village_id::text = $2::text`,
                    [incoming_full_name.trim(), String(village_id)]
                ).catch(() => {});
            }
        }

        // หาชื่อผู้อนุมัติ
        const apRes = await client.query(`
            SELECT COALESCE(p.first_name || ' ' || p.last_name, a.username_phone) AS full_name
            FROM user_accounts a
            LEFT JOIN user_profiles p ON a.profile_id = p.profile_id
            WHERE a.account_id = $1::uuid LIMIT 1
        `, [approver_account_id]);
        const approverName = apRes.rows[0]?.full_name || 'ผู้ใหญ่บ้าน';

        // 3. บันทึกประวัติส่งมอบงานถาวร (ตารางนี้มี Trigger ล็อกห้ามลบใน DB)
        await client.query(`
            INSERT INTO committee_handover_logs (
                village_id, committee_id, committee_name, position_record_id,
                role_template_code, position_title,
                outgoing_account_id, outgoing_full_name, outgoing_new_role,
                incoming_account_id, incoming_full_name,
                handover_reason, approved_by, approved_by_name
            ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8, $9, $10::uuid, $11, $12, $13::uuid, $14)
        `, [
            village_id,
            outRec.committee_id,
            outRec.committee_name || '',
            outRec.id,
            outRec.role_template_code,
            outRec.custom_position_title || outRec.role_template_code,
            outRec.account_id || null,
            outRec.outgoing_name?.trim() || '-',
            outShift.newRole || 'CITIZEN',
            realIncomingAccountId,
            (incoming_full_name || '').trim() || null,
            handover_reason || 'ครบวาระ / ส่งมอบงานให้กรรมการชุดใหม่',
            approver_account_id,
            approverName
        ]);

        await client.query('COMMIT');
        res.json({
            success: true,
            message: hasIncoming
                ? `ส่งมอบงานเรียบร้อยแล้ว: ปรับ ${outRec.outgoing_name?.trim() || 'คนเดิม'} เป็น ${outShift.newRole} และแต่งตั้ง ${incoming_full_name} รับช่วงต่อทันที (ประวัติและรายงานเก่ายังคงเดิม 100%)`
                : `ปรับสถานะ ${outRec.outgoing_name?.trim() || 'คนเดิม'} กลับเป็นประชาชน (${outShift.newRole}) และบันทึกประวัติส่งมอบงานเรียบร้อยแล้ว`,
            data: { outgoing_new_role: outShift.newRole, incoming_record: newRecord }
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('V3 Committee Handover Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// ดึงประวัติการผลัดเปลี่ยนกรรมการและส่งมอบงานของหมู่บ้าน (อ่านอย่างเดียว ห้ามลบ)
app.get('/api/v3/committee-handovers/:villageId', async (req, res) => {
    const { villageId } = req.params;
    if (!isValidUuidV3(villageId)) {
        return res.status(400).json({ success: false, message: 'รหัสหมู่บ้านไม่ถูกต้อง' });
    }
    try {
        const result = await pgPool.query(`
            SELECT * FROM committee_handover_logs
            WHERE village_id = $1::uuid
            ORDER BY handover_at DESC, handover_id DESC
            LIMIT 100
        `, [villageId]);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Get Committee Handovers Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// =========================================================================
// 🌟 V3: ระบบผังผู้นำชุมชน (80,000 หมู่บ้าน) + อนุมัติด้วย PIN ผู้ใหญ่บ้าน + ปรับสถานะอัตโนมัติ
// =========================================================================

const cryptoV3 = require('crypto');

const isValidUuidV3 = (val) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(val || '').trim());

const hashHeadmanPin = (villageId, pin) =>
    cryptoV3.createHash('sha256').update(`banrao_headman_pin::${String(villageId)}::${String(pin || '').trim()}`).digest('hex');

// แมปแม่แบบสิทธิ์กับ position_id มาตรฐานเดิม (เพื่อไม่ให้สร้างแถวซ้ำใน sys_positions)
const CANONICAL_POSITION_ID = {
    SUPER_ADMIN: 999,
    VILLAGE_HEADMAN: 6,
    VILLAGE_ADMIN: 1032,
    WATER_PRESIDENT: 25,
    WATER_TREASURER: 27,
    WATER_READER: 26,
    COMMITTEE_GENERAL: 14,
    PLACE_GOV_HEAD: 11,
    PLACE_BIZ_OWNER: 1018
};

// ลำดับขั้นของ role ใน user_accounts (สูงกว่าชนะ)
const ACCOUNT_ROLE_PRIORITY = {
    CITIZEN: 0,
    PLACE_MANAGER: 1,
    COMMITTEE: 2,
    VILLAGE_ADMIN: 3,
    HEADMAN: 4,
    SUPER_ADMIN: 5
};

// หา account_id จริงใน user_accounts จาก accountId / profileId / citizenId
async function resolveRealUserAccountId(client, { accountId, citizenId }) {
    if (isValidUuidV3(accountId)) {
        const direct = await client.query(
            `SELECT account_id FROM user_accounts WHERE account_id = $1::uuid LIMIT 1`,
            [accountId]
        );
        if (direct.rows.length > 0) return direct.rows[0].account_id;

        // กรณีค่าที่ส่งมาคือ profile_id
        const byProf = await client.query(
            `SELECT account_id FROM user_accounts WHERE profile_id = $1::uuid LIMIT 1`,
            [accountId]
        );
        if (byProf.rows.length > 0) return byProf.rows[0].account_id;
    }

    const cleanCid = String(citizenId || '').replace(/\D/g, '');
    if (cleanCid.length === 13) {
        const byCid = await client.query(`
            SELECT ua.account_id
            FROM user_accounts ua
            JOIN user_profiles up ON ua.profile_id = up.profile_id
            WHERE REGEXP_REPLACE(COALESCE(up.citizen_id, ''), '[^0-9]', '', 'g') = $1
            LIMIT 1
        `, [cleanCid]);
        if (byCid.rows.length > 0) return byCid.rows[0].account_id;
    }

    return null;
}

// คำนวณและอัปเดต user_accounts.role อัตโนมัติจากตำแหน่งที่ได้รับอนุมัติ (ACTIVE) ทั้งหมด
async function syncUserAccountRoleFromPositions(client, accountId) {
    if (!isValidUuidV3(accountId)) return { oldRole: null, newRole: null };

    const accRes = await client.query(
        `SELECT account_id, role, village_id FROM user_accounts WHERE account_id = $1::uuid LIMIT 1`,
        [accountId]
    );
    if (accRes.rows.length === 0) return { oldRole: null, newRole: null };

    const oldRole = String(accRes.rows[0].role || 'CITIZEN').toUpperCase();
    // ไม่ลดระดับ SUPER_ADMIN เด็ดขาด
    if (oldRole === 'SUPER_ADMIN') return { oldRole, newRole: oldRole };

    // เช็กว่าเป็นผู้ใหญ่บ้านประจำหมู่บ้านหรือไม่
    const headRes = await client.query(
        `SELECT village_id FROM villages WHERE headman_account_id = $1::uuid LIMIT 1`,
        [accountId]
    );
    if (headRes.rows.length > 0) {
        if (oldRole !== 'HEADMAN') {
            await client.query(`UPDATE user_accounts SET role = 'HEADMAN' WHERE account_id = $1::uuid`, [accountId]);
        }
        return { oldRole, newRole: 'HEADMAN' };
    }

    // ดึงตำแหน่งทั้งหมดที่ได้รับอนุมัติและยังไม่หมดวาระ
    const posRes = await client.query(`
        SELECT rt.account_role_level
        FROM user_positions up
        JOIN sys_role_templates rt ON up.role_template_code = rt.role_template_code
        WHERE up.account_id = $1::uuid
          AND up.status = 'ACTIVE'
          AND up.is_active = true
          AND (up.end_date IS NULL OR up.end_date >= CURRENT_DATE)
    `, [accountId]);

    let bestRole = 'CITIZEN';
    let bestScore = 0;
    for (const r of posRes.rows) {
        const lvl = String(r.account_role_level || 'CITIZEN').toUpperCase();
        const score = ACCOUNT_ROLE_PRIORITY[lvl] ?? 0;
        if (score > bestScore) {
            bestScore = score;
            bestRole = lvl;
        }
    }

    if (bestRole !== oldRole) {
        await client.query(`UPDATE user_accounts SET role = $1 WHERE account_id = $2::uuid`, [bestRole, accountId]);
    }
    return { oldRole, newRole: bestRole };
}

// ตรวจสอบรหัส PIN ผู้ใหญ่บ้านของหมู่บ้านนั้น (ใช้ตาราง sys_approval_pins)
async function verifyVillageHeadmanPin(client, villageId, inputPin) {
    const cleanPin = String(inputPin || '').trim();
    if (!cleanPin) return false;

    const pinRes = await client.query(`
        SELECT pin_id, pin_hash, pin_code
        FROM sys_approval_pins
        WHERE village_id = $1::uuid
          AND pin_purpose = 'HEADMAN_APPROVAL'
          AND is_active = true
        ORDER BY updated_at DESC
        LIMIT 1
    `, [villageId]);

    if (pinRes.rows.length > 0) {
        const row = pinRes.rows[0];
        if (row.pin_hash && row.pin_hash === hashHeadmanPin(villageId, cleanPin)) return true;
        if (!row.pin_hash && row.pin_code && row.pin_code !== 'HASHED' && row.pin_code === cleanPin) return true;
        return false;
    }

    // Fallback: ตรวจ PIN เดิมของ headman_account_id ที่ยังไม่ได้ระบุ village_id
    const vRes = await client.query(`SELECT headman_account_id FROM villages WHERE village_id = $1::uuid LIMIT 1`, [villageId]);
    const headmanId = vRes.rows[0]?.headman_account_id;
    if (headmanId) {
        const legacyRes = await client.query(`
            SELECT pin_code, pin_hash
            FROM sys_approval_pins
            WHERE account_id = $1::uuid AND is_active = true
            ORDER BY updated_at DESC
            LIMIT 1
        `, [headmanId]);
        if (legacyRes.rows.length > 0) {
            const row = legacyRes.rows[0];
            if (row.pin_hash && row.pin_hash === hashHeadmanPin(villageId, cleanPin)) return true;
            if (row.pin_code && row.pin_code !== 'HASHED' && row.pin_code === cleanPin) return true;
        }
    }

    return false;
}

// 1. ดึงแม่แบบสิทธิ์มาตรฐานสำหรับผูกกับตำแหน่งในผัง (ใช้เหมือนกันทั้ง 80,000 หมู่บ้าน)
app.get('/api/v3/role-templates', async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT role_template_code, template_name_th, category, account_role_level, description
            FROM sys_role_templates
            WHERE is_active = true AND role_template_code <> 'SUPER_ADMIN'
            ORDER BY display_order ASC
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Get Role Templates Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. ดึงรายชื่อคณะทำงานของหมู่บ้าน (รองรับ UUID 100% + นับจำนวนคนที่รออนุมัติในแต่ละผัง)
app.get('/api/v3/committees/:villageId', async (req, res) => {
    const { villageId } = req.params;
    if (!isValidUuidV3(villageId)) {
        return res.status(400).json({ success: false, message: 'รหัสหมู่บ้านไม่ถูกต้อง' });
    }
    try {
        const result = await pgPool.query(`
            SELECT
                cc.*,
                COALESCE(cnt.pending_count, 0)::int AS pending_count,
                COALESCE(cnt.active_count, 0)::int AS active_count
            FROM community_committees cc
            LEFT JOIN (
                SELECT
                    committee_id,
                    COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL' AND is_active = true) AS pending_count,
                    COUNT(*) FILTER (WHERE status = 'ACTIVE' AND is_active = true) AS active_count
                FROM user_positions
                GROUP BY committee_id
            ) cnt ON cnt.committee_id = cc.committee_id
            WHERE cc.village_id = $1::uuid
              AND COALESCE(cc.is_active, true) = true
            ORDER BY cc.committee_id ASC
        `, [villageId]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('V3 Get Committees Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. สร้างคณะทำงาน / ผังใหม่ (ตั้งชื่ออิสระ + เลือกประเภทงาน)
app.post('/api/v3/committees', async (req, res) => {
    const { village_id, committee_name, description, committee_type_code } = req.body;
    if (!isValidUuidV3(village_id) || !committee_name?.trim()) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุหมู่บ้านและชื่อคณะทำงาน' });
    }
    try {
        const result = await pgPool.query(`
            INSERT INTO community_committees (village_id, committee_name, description, committee_type_code, is_active)
            VALUES ($1::uuid, $2, $3, $4, true)
            RETURNING *
        `, [village_id, committee_name.trim(), description || '', committee_type_code || 'CUSTOM']);

        res.json({ success: true, message: 'สร้างผังคณะทำงานใหม่สำเร็จ', data: result.rows[0] });
    } catch (err) {
        console.error('V3 Create Committee Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 4. แก้ไขชื่อ / รายละเอียดผังคณะทำงาน (ล็อกขอบเขตหมู่บ้าน)
app.put('/api/v3/committees/:committeeId', async (req, res) => {
    const { committeeId } = req.params;
    const { village_id, committee_name, description, committee_type_code } = req.body;
    if (!committee_name?.trim()) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อคณะทำงาน' });
    }
    try {
        await pgPool.query(`
            UPDATE community_committees
            SET committee_name = $1,
                description = $2,
                committee_type_code = COALESCE($3, committee_type_code)
            WHERE committee_id = $4
              AND ($5::text IS NULL OR village_id::text = $5::text)
        `, [committee_name.trim(), description || '', committee_type_code || null, committeeId, village_id || null]);

        res.json({ success: true, message: 'แก้ไขข้อมูลผังสำเร็จ' });
    } catch (err) {
        console.error('V3 Update Committee Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 5. ลบผังคณะทำงาน (Soft Delete + ถอดถอนตำแหน่งในผัง + คำนวณสิทธิ์ใหม่)
app.delete('/api/v3/committees/:committeeId', async (req, res) => {
    const { committeeId } = req.params;
    const villageId = req.query.village_id || req.body?.village_id || null;
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        const affected = await client.query(
            `SELECT DISTINCT account_id FROM user_positions WHERE committee_id = $1 AND account_id IS NOT NULL`,
            [committeeId]
        );

        await client.query(`
            UPDATE user_positions
            SET status = 'REVOKED', is_active = false, end_date = CURRENT_DATE, end_reason = 'ยุบผังคณะทำงาน'
            WHERE committee_id = $1
        `, [committeeId]);

        await client.query(`
            UPDATE community_committees
            SET is_active = false
            WHERE committee_id = $1
              AND ($2::text IS NULL OR village_id::text = $2::text)
        `, [committeeId, villageId]);

        for (const r of affected.rows) {
            await syncUserAccountRoleFromPositions(client, r.account_id);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'ลบผังคณะทำงานและปรับสถานะบุคคลที่เกี่ยวข้องเรียบร้อยแล้ว' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('V3 Delete Committee Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 6. ดึงรายชื่อบุคคลในผัง (เชื่อมรูปโปรไฟล์จริง + สถานะบัญชีแอป รองรับทั้งข้อมูลเก่าและใหม่ 100%)
app.get('/api/v3/committees/:committeeId/leaders', async (req, res) => {
    const { committeeId } = req.params;
    const villageId = req.query.village_id && isValidUuidV3(req.query.village_id) ? req.query.village_id : null;
    try {
        const result = await pgPool.query(`
            SELECT
                up.id,
                up.id AS position_record_id,
                up.committee_id,
                up.village_id,
                up.parent_id,
                COALESCE(ua.account_id, up.account_id) AS account_id,
                COALESCE(up.member_id, hm.member_id::text) AS member_id,
                COALESCE(NULLIF(up.citizen_id, ''), prof.citizen_id, hm.citizen_id::text) AS citizen_id,
                up.position_id,
                COALESCE(NULLIF(up.custom_position_title, ''), sp.position_name, 'ตำแหน่งใหม่') AS role_name,
                COALESCE(up.role_template_code, sp.role_template_code, 'COMMITTEE_GENERAL') AS role_template_code,
                rt.template_name_th,
                rt.account_role_level,
                up.status,
                up.is_active,
                up.start_date,
                up.end_date,
                up.responsibilities,
                up.approved_by,
                up.approved_at,
                up.approval_note,
                COALESCE(prof.first_name, hm.first_name, '') AS first_name,
                COALESCE(prof.last_name, hm.last_name, '') AS last_name,
                COALESCE(prof.dob::text, hm.m_json->>'dob', hm.m_json->>'birth_date', hm.m_json->>'date_of_birth') AS dob,
                (ua.account_id IS NOT NULL) AS has_app_account,
                ua.role AS current_account_role,
                ua.is_active AS account_is_active,
                COALESCE(
                    NULLIF(media.image_url, ''),
                    NULLIF(hm.m_json->>'image_url', ''),
                    NULLIF(hm.m_json->>'photo_url', ''),
                    NULLIF(hm.m_json->>'profile_image', ''),
                    '/profile-img.jpg'
                ) AS user_image,
                COALESCE(ap_prof.first_name || ' ' || ap_prof.last_name, '') AS approver_name
            FROM user_positions up
            LEFT JOIN sys_positions sp ON up.position_id = sp.position_id
            LEFT JOIN sys_role_templates rt ON COALESCE(up.role_template_code, sp.role_template_code) = rt.role_template_code
            -- 1. หาในทะเบียนลูกบ้าน (household_members) ก่อน เพื่อดึง citizen_id ของข้อมูลเดิม
            LEFT JOIN LATERAL (
                SELECT m.member_id, m.first_name, m.last_name, m.citizen_id, to_jsonb(m) AS m_json
                FROM household_members m
                WHERE (up.member_id IS NOT NULL AND m.member_id::text = up.member_id::text)
                   OR (up.account_id IS NOT NULL AND m.member_id::text = up.account_id::text)
                   OR (
                        COALESCE(up.citizen_id, '') <> ''
                        AND REGEXP_REPLACE(COALESCE(m.citizen_id::text, ''), '[^0-9]', '', 'g') = REGEXP_REPLACE(up.citizen_id, '[^0-9]', '', 'g')
                   )
                LIMIT 1
            ) hm ON true
            -- 2. เช็กกรณี up.account_id เป็น user_accounts.account_id โดยตรง
            LEFT JOIN user_accounts ua_direct ON up.account_id = ua_direct.account_id
            -- 3. หา user_profiles จาก ua_direct / profile_id / citizen_id ของทั้ง up และ hm
            LEFT JOIN LATERAL (
                SELECT p.profile_id, p.first_name, p.last_name, p.dob, p.citizen_id
                FROM user_profiles p
                WHERE (ua_direct.profile_id IS NOT NULL AND p.profile_id = ua_direct.profile_id)
                   OR (up.account_id IS NOT NULL AND p.profile_id = up.account_id)
                   OR (
                        COALESCE(NULLIF(up.citizen_id, ''), hm.citizen_id::text, '') <> ''
                        AND REGEXP_REPLACE(COALESCE(p.citizen_id, ''), '[^0-9]', '', 'g') = REGEXP_REPLACE(COALESCE(NULLIF(up.citizen_id, ''), hm.citizen_id::text, ''), '[^0-9]', '', 'g')
                   )
                LIMIT 1
            ) prof ON true
            -- 4. หาบัญชี Login จริง (user_accounts) เพื่อดึงสถานะและสิทธิ์
            LEFT JOIN LATERAL (
                SELECT a.account_id, a.role, a.is_active
                FROM user_accounts a
                WHERE (ua_direct.account_id IS NOT NULL AND a.account_id = ua_direct.account_id)
                   OR (prof.profile_id IS NOT NULL AND a.profile_id = prof.profile_id)
                LIMIT 1
            ) ua ON true
            -- 5. ดึงรูปโปรไฟล์จริงจาก citizen_profiles_media
            LEFT JOIN LATERAL (
                SELECT cpm.image_url
                FROM citizen_profiles_media cpm
                WHERE cpm.profile_id = prof.profile_id AND cpm.is_active = true
                LIMIT 1
            ) media ON true
            LEFT JOIN user_accounts ap_ua ON up.approved_by = ap_ua.account_id
            LEFT JOIN user_profiles ap_prof ON ap_ua.profile_id = ap_prof.profile_id
            WHERE up.committee_id = $1
              AND up.is_active = true
              AND up.status IN ('PENDING_APPROVAL', 'ACTIVE')
              AND ($2::text IS NULL OR up.village_id IS NULL OR up.village_id::text = $2::text)
            ORDER BY up.id ASC
        `, [Number(committeeId), villageId]);

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('V3 Get Committee Leaders Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 7. ค้นหาลูกบ้านด้วยเลขบัตร 13 หลัก (กั้นเขตเฉพาะหมู่บ้านของตัวเอง 100%)
app.get('/api/v3/search-citizen/:villageId/:citizenId', async (req, res) => {
    const { villageId, citizenId } = req.params;
    const cleanCid = String(citizenId || '').replace(/\D/g, '');
    if (!isValidUuidV3(villageId) || cleanCid.length !== 13) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกเลขบัตรประชาชนให้ครบ 13 หลัก' });
    }

    try {
        const hmRes = await pgPool.query(`
            SELECT
                hm.member_id::text AS member_id,
                hm.first_name,
                hm.last_name,
                COALESCE(up.dob::text, to_jsonb(hm)->>'dob', to_jsonb(hm)->>'birth_date', to_jsonb(hm)->>'date_of_birth') AS dob,
                hm.citizen_id,
                hm.status AS member_status,
                v.village_name,
                v.village_no,
                t.tambon_name_th,
                am.amphure_name_th,
                pr.province_name_th,
                ua.account_id AS user_account_id,
                ua.role AS current_role,
                ua.is_active AS account_is_active,
                COALESCE(cpm.image_url, '/profile-img.jpg') AS user_image
            FROM household_members hm
            JOIN households h ON hm.household_id::text = h.household_id::text
            LEFT JOIN villages v ON h.village_id = v.village_id
            LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
            LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
            LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
            LEFT JOIN user_profiles up ON REGEXP_REPLACE(COALESCE(up.citizen_id, ''), '[^0-9]', '', 'g') = $2
            LEFT JOIN user_accounts ua ON ua.profile_id = up.profile_id AND ua.village_id = $1::uuid
            LEFT JOIN LATERAL (
                SELECT image_url FROM citizen_profiles_media
                WHERE profile_id = up.profile_id AND is_active = true
                LIMIT 1
            ) cpm ON true
            WHERE h.village_id = $1::uuid
              AND hm.status = 'ACTIVE'
              AND REGEXP_REPLACE(COALESCE(hm.citizen_id::text, ''), '[^0-9]', '', 'g') = $2
            LIMIT 1
        `, [villageId, cleanCid]);

        if (hmRes.rows.length > 0) {
            const r = hmRes.rows[0];
            return res.json({
                success: true,
                data: {
                    ...r,
                    citizen_id: cleanCid,
                    account_id: r.user_account_id || null,
                    has_app_account: Boolean(r.user_account_id)
                }
            });
        }

        const accRes = await pgPool.query(`
            SELECT
                ua.account_id AS user_account_id,
                ua.role AS current_role,
                ua.is_active AS account_is_active,
                up.first_name,
                up.last_name,
                up.dob,
                up.citizen_id,
                v.village_name,
                v.village_no,
                t.tambon_name_th,
                am.amphure_name_th,
                pr.province_name_th,
                COALESCE(cpm.image_url, '/profile-img.jpg') AS user_image
            FROM user_accounts ua
            JOIN user_profiles up ON ua.profile_id = up.profile_id
            LEFT JOIN villages v ON ua.village_id = v.village_id
            LEFT JOIN sys_tambons t ON v.tambon_id = t.tambon_id
            LEFT JOIN sys_amphures am ON t.amphure_id = am.amphure_id
            LEFT JOIN sys_provinces pr ON am.province_id = pr.province_id
            LEFT JOIN LATERAL (
                SELECT image_url FROM citizen_profiles_media
                WHERE profile_id = up.profile_id AND is_active = true
                LIMIT 1
            ) cpm ON true
            WHERE ua.village_id = $1::uuid
              AND ua.is_active = true
              AND REGEXP_REPLACE(COALESCE(up.citizen_id, ''), '[^0-9]', '', 'g') = $2
            LIMIT 1
        `, [villageId, cleanCid]);

        if (accRes.rows.length > 0) {
            const r = accRes.rows[0];
            return res.json({
                success: true,
                data: {
                    ...r,
                    member_id: null,
                    citizen_id: cleanCid,
                    account_id: r.user_account_id,
                    has_app_account: true
                }
            });
        }

        res.json({ success: false, message: 'ไม่พบข้อมูลลูกบ้านเลขบัตรนี้ในหมู่บ้านของคุณ (ห้ามดึงบุคคลข้ามหมู่บ้าน)' });
    } catch (err) {
        console.error('V3 Search Citizen Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 8. เพิ่มบุคลากรลงผัง (สถานะเริ่มต้น = PENDING_APPROVAL รอผู้ใหญ่บ้านอนุมัติด้วย PIN)
app.post('/api/v3/committee-leaders', async (req, res) => {
    const {
        village_id, committee_id, custom_position_title, role_template_code,
        account_id, member_id, citizen_id, start_date, end_date,
        responsibilities, parent_id, assigned_by
    } = req.body;

    if (!isValidUuidV3(village_id) || !committee_id || !custom_position_title?.trim() || !role_template_code) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อตำแหน่งและเลือกชุดสิทธิ์ระบบให้ครบถ้วน' });
    }

    const client = await pgPool.connect();
    try {
        const realAccountId = await resolveRealUserAccountId(client, { accountId: account_id, citizenId: citizen_id });
        const canonicalPosId = CANONICAL_POSITION_ID[role_template_code] || 14;
        const cleanCid = String(citizen_id || '').replace(/\D/g, '') || null;

        const insertRes = await client.query(`
            INSERT INTO user_positions (
                village_id, committee_id, account_id, member_id, citizen_id,
                position_id, custom_position_title, role_template_code,
                scope_type, scope_id, start_date, end_date,
                responsibilities, parent_id, assigned_by,
                status, is_active
            ) VALUES (
                $1::uuid, $2, $3::uuid, $4, $5,
                $6, $7, $8,
                'VILLAGE', $1::text, $9, $10,
                $11, $12, $13::uuid,
                'PENDING_APPROVAL', true
            )
            RETURNING *
        `, [
            village_id,
            Number(committee_id),
            realAccountId,
            member_id ? String(member_id) : null,
            cleanCid,
            canonicalPosId,
            custom_position_title.trim(),
            role_template_code,
            start_date || new Date().toISOString().split('T')[0],
            end_date || null,
            responsibilities || '',
            parent_id ? Number(parent_id) : null,
            isValidUuidV3(assigned_by) ? assigned_by : null
        ]);

        res.json({
            success: true,
            message: 'เพิ่มบุคลากรลงผังแล้ว (สถานะ: รอผู้ใหญ่บ้านอนุมัติด้วยรหัส PIN)',
            data: insertRes.rows[0]
        });
    } catch (err) {
        console.error('V3 Create Leader Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 9. แก้ไขข้อมูลบุคลากรในผัง (หากเปลี่ยนชุดสิทธิ์ จะกลับเป็น PENDING_APPROVAL เพื่อรอผู้ใหญ่บ้านอนุมัติใหม่)
app.put('/api/v3/committee-leaders/:recordId', async (req, res) => {
    const { recordId } = req.params;
    const {
        village_id, custom_position_title, role_template_code,
        start_date, end_date, responsibilities
    } = req.body;

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        const curRes = await client.query(`SELECT * FROM user_positions WHERE id = $1 LIMIT 1`, [recordId]);
        if (curRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลตำแหน่งนี้' });
        }
        const cur = curRes.rows[0];
        if (village_id && cur.village_id && String(cur.village_id) !== String(village_id)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, message: 'ไม่อนุญาตให้แก้ไขข้อมูลข้ามหมู่บ้าน' });
        }

        const nextTpl = role_template_code || cur.role_template_code || 'COMMITTEE_GENERAL';
        const roleChanged = nextTpl !== cur.role_template_code;
        const nextStatus = roleChanged ? 'PENDING_APPROVAL' : cur.status;
        const canonicalPosId = CANONICAL_POSITION_ID[nextTpl] || cur.position_id || 14;

        await client.query(`
            UPDATE user_positions
            SET custom_position_title = $1,
                role_template_code = $2,
                position_id = $3,
                start_date = $4,
                end_date = $5,
                responsibilities = $6,
                status = $7
            WHERE id = $8
        `, [
            custom_position_title?.trim() || cur.custom_position_title,
            nextTpl,
            canonicalPosId,
            start_date || cur.start_date,
            end_date || null,
            responsibilities ?? cur.responsibilities,
            nextStatus,
            recordId
        ]);

        if (roleChanged && cur.account_id) {
            await syncUserAccountRoleFromPositions(client, cur.account_id);
        }

        await client.query('COMMIT');
        res.json({
            success: true,
            message: roleChanged
                ? 'แก้ไขชุดสิทธิ์แล้ว กรุณาให้ผู้ใหญ่บ้านกดอนุมัติด้วย PIN อีกครั้ง'
                : 'อัปเดตข้อมูลเรียบร้อยแล้ว'
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('V3 Update Leader Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 10. เช็กสถานะรหัส PIN อนุมัติของผู้ใหญ่บ้านประจำหมู่บ้าน
app.get('/api/v3/headman-pin/:villageId', async (req, res) => {
    const { villageId } = req.params;
    if (!isValidUuidV3(villageId)) {
        return res.status(400).json({ success: false, message: 'รหัสหมู่บ้านไม่ถูกต้อง' });
    }
    try {
        const vRes = await pgPool.query(`
            SELECT v.village_id, v.village_name, v.headman_account_id,
                   COALESCE(up.first_name || ' ' || up.last_name, '') AS headman_name
            FROM villages v
            LEFT JOIN user_accounts ua ON v.headman_account_id = ua.account_id
            LEFT JOIN user_profiles up ON ua.profile_id = up.profile_id
            WHERE v.village_id = $1::uuid
            LIMIT 1
        `, [villageId]);

        const pinRes = await pgPool.query(`
            SELECT pin_id, updated_at
            FROM sys_approval_pins
            WHERE village_id = $1::uuid AND pin_purpose = 'HEADMAN_APPROVAL' AND is_active = true
            LIMIT 1
        `, [villageId]);

        res.json({
            success: true,
            data: {
                village_id: villageId,
                village_name: vRes.rows[0]?.village_name || '',
                headman_account_id: vRes.rows[0]?.headman_account_id || null,
                headman_name: vRes.rows[0]?.headman_name?.trim() || 'ผู้ใหญ่บ้าน',
                has_pin: pinRes.rows.length > 0
            }
        });
    } catch (err) {
        console.error('V3 Check Headman PIN Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 11. ตั้ง / เปลี่ยนรหัส PIN อนุมัติของผู้ใหญ่บ้าน (6 หลัก เก็บแบบ Hash ใน sys_approval_pins)
app.post('/api/v3/headman-pin/:villageId/setup', async (req, res) => {
    const { villageId } = req.params;
    const { account_id, old_pin, new_pin } = req.body;

    if (!isValidUuidV3(villageId) || !isValidUuidV3(account_id)) {
        return res.status(400).json({ success: false, message: 'ข้อมูลหมู่บ้านหรือผู้ใช้งานไม่ถูกต้อง' });
    }
    if (!new_pin || String(new_pin).trim().length < 4) {
        return res.status(400).json({ success: false, message: 'กรุณากำหนดรหัส PIN อย่างน้อย 4-6 หลัก' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // ตรวจสิทธิ์ผู้ตั้งรหัส (ต้องเป็นผู้ใหญ่บ้านของหมู่บ้านนี้ หรือ Super Admin / Admin Villages)
        const vRes = await client.query(`SELECT headman_account_id FROM villages WHERE village_id = $1::uuid LIMIT 1`, [villageId]);
        const accRes = await client.query(`SELECT role, village_id FROM user_accounts WHERE account_id = $1::uuid LIMIT 1`, [account_id]);
        const userRole = String(accRes.rows[0]?.role || '').toUpperCase();
        const isAllowed =
            String(vRes.rows[0]?.headman_account_id || '') === String(account_id) ||
            userRole === 'SUPER_ADMIN' ||
            userRole === 'HEADMAN' ||
            (String(accRes.rows[0]?.village_id || '') === String(villageId) && userRole.includes('ADMIN'));

        if (!isAllowed) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, message: 'เฉพาะผู้ใหญ่บ้านประจำหมู่บ้านเท่านั้นที่ตั้งรหัสอนุมัติได้' });
        }

        const existingRes = await client.query(`
            SELECT pin_id FROM sys_approval_pins
            WHERE village_id = $1::uuid AND pin_purpose = 'HEADMAN_APPROVAL' AND is_active = true
            LIMIT 1
        `, [villageId]);

        if (existingRes.rows.length > 0) {
            const okOld = await verifyVillageHeadmanPin(client, villageId, old_pin);
            if (!okOld) {
                await client.query('ROLLBACK');
                return res.status(403).json({ success: false, message: 'รหัส PIN เดิมไม่ถูกต้อง' });
            }
            await client.query(`
                UPDATE sys_approval_pins
                SET pin_hash = $1, pin_code = 'HASHED', account_id = $2::uuid, updated_at = CURRENT_TIMESTAMP
                WHERE pin_id = $3
            `, [hashHeadmanPin(villageId, new_pin), account_id, existingRes.rows[0].pin_id]);
        } else {
            await client.query(`
                INSERT INTO sys_approval_pins (account_id, village_id, scope_level, pin_purpose, pin_code, pin_hash, is_active)
                VALUES ($1::uuid, $2::uuid, 'VILLAGE', 'HEADMAN_APPROVAL', 'HASHED', $3, true)
            `, [account_id, villageId, hashHeadmanPin(villageId, new_pin)]);
        }

        // หาก villages.headman_account_id ยังว่าง ให้ผูกเป็นผู้ใหญ่บ้านคนนี้ด้วย
        if (!vRes.rows[0]?.headman_account_id) {
            await client.query(`UPDATE villages SET headman_account_id = $1::uuid WHERE village_id = $2::uuid`, [account_id, villageId]);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'บันทึกรหัส PIN อนุมัติของผู้ใหญ่บ้านเรียบร้อยแล้ว' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('V3 Setup Headman PIN Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 12. ผู้ใหญ่บ้านอนุมัติตำแหน่งด้วย PIN (รองรับทั้งอนุมัติรายคน และ อนุมัติทั้งผัง) -> ปรับสถานะประชาชนเป็นกรรมการทันที!
app.post('/api/v3/committee-leaders/approve', async (req, res) => {
    const { village_id, approver_account_id, pin_code, record_ids, committee_id, note } = req.body;

    if (!isValidUuidV3(village_id) || !isValidUuidV3(approver_account_id)) {
        return res.status(400).json({ success: false, message: 'ข้อมูลหมู่บ้านหรือผู้อนุมัติไม่ถูกต้อง' });
    }
    if (!pin_code) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกรหัส PIN อนุมัติของผู้ใหญ่บ้าน' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        // 1. ตรวจ PIN ผู้ใหญ่บ้าน
        const pinOk = await verifyVillageHeadmanPin(client, village_id, pin_code);
        if (!pinOk) {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, message: 'รหัส PIN อนุมัติของผู้ใหญ่บ้านไม่ถูกต้อง' });
        }

        // 2. ค้นหารายการที่รออนุมัติในหมู่บ้านนี้เท่านั้น
        let targetsRes;
        if (Array.isArray(record_ids) && record_ids.length > 0) {
            targetsRes = await client.query(`
                SELECT * FROM user_positions
                WHERE id = ANY($1::int[])
                  AND (village_id = $2::uuid OR village_id IS NULL)
                  AND is_active = true
            `, [record_ids.map(Number), village_id]);
        } else if (committee_id) {
            targetsRes = await client.query(`
                SELECT * FROM user_positions
                WHERE committee_id = $1
                  AND (village_id = $2::uuid OR village_id IS NULL)
                  AND status = 'PENDING_APPROVAL'
                  AND is_active = true
            `, [Number(committee_id), village_id]);
        } else {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'กรุณาระบุบุคคลหรือผังที่ต้องการอนุมัติ' });
        }

        if (targetsRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'ไม่พบรายการที่รออนุมัติ' });
        }

        let approvedCount = 0;
        for (const rec of targetsRes.rows) {
            // ผูกกับบัญชี Login จริงอัตโนมัติ (กรณีเพิ่งสมัครแอป)
            const realAccountId = await resolveRealUserAccountId(client, {
                accountId: rec.account_id,
                citizenId: rec.citizen_id
            });

            await client.query(`
                UPDATE user_positions
                SET status = 'ACTIVE',
                    is_active = true,
                    village_id = $1::uuid,
                    account_id = COALESCE($2::uuid, account_id),
                    approved_by = $3::uuid,
                    approved_at = CURRENT_TIMESTAMP,
                    approval_note = $4
                WHERE id = $5
            `, [village_id, realAccountId, approver_account_id, note || 'อนุมัติแต่งตั้งตำแหน่งโดยผู้ใหญ่บ้าน', rec.id]);

            // ปรับบทบาทใน user_accounts จาก CITIZEN -> COMMITTEE / VILLAGE_ADMIN / PLACE_MANAGER
            const roleShift = realAccountId
                ? await syncUserAccountRoleFromPositions(client, realAccountId)
                : { oldRole: 'NO_ACCOUNT', newRole: 'PENDING_REGISTER' };

            // บันทึกประวัติการอนุมัติลง sys_approval_logs
            await client.query(`
                INSERT INTO sys_approval_logs (
                    village_id, target_type, target_id, target_account_id,
                    action_type, old_status, new_status, old_role, new_role, approved_by, note
                ) VALUES ($1::uuid, 'USER_POSITION', $2, $3::uuid, 'APPROVE', $4, 'ACTIVE', $5, $6, $7::uuid, $8)
            `, [
                village_id,
                String(rec.id),
                realAccountId,
                rec.status,
                roleShift.oldRole,
                roleShift.newRole,
                approver_account_id,
                note || `อนุมัติตำแหน่ง ${rec.custom_position_title || rec.role_template_code}`
            ]);

            approvedCount += 1;
        }

        await client.query('COMMIT');
        res.json({
            success: true,
            message: `ผู้ใหญ่บ้านอนุมัติตำแหน่งสำเร็จ ${approvedCount} รายการ และปรับสิทธิ์การใช้งานเรียบร้อยแล้ว`
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('V3 Approve Leaders Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// 13. ผู้ใหญ่บ้านถอดถอน / ยกเลิกตำแหน่งด้วย PIN -> ลดสิทธิ์กลับเป็น CITIZEN อัตโนมัติหากไม่มีตำแหน่งอื่น
app.post('/api/v3/committee-leaders/revoke', async (req, res) => {
    const { village_id, approver_account_id, pin_code, record_id, reason } = req.body;

    if (!isValidUuidV3(village_id) || !isValidUuidV3(approver_account_id) || !record_id) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        const recRes = await client.query(
            `SELECT * FROM user_positions WHERE id = $1 AND (village_id = $2::uuid OR village_id IS NULL) LIMIT 1`,
            [Number(record_id), village_id]
        );
        if (recRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลตำแหน่งในหมู่บ้านนี้' });
        }
        const rec = recRes.rows[0];

        // หากรายการได้รับอนุมัติ (ACTIVE) แล้ว ต้องยืนยันรหัส PIN ผู้ใหญ่บ้านก่อนถอดถอน
        if (rec.status === 'ACTIVE') {
            const pinOk = await verifyVillageHeadmanPin(client, village_id, pin_code);
            if (!pinOk) {
                await client.query('ROLLBACK');
                return res.status(403).json({ success: false, message: 'รหัส PIN อนุมัติของผู้ใหญ่บ้านไม่ถูกต้อง' });
            }
        }

        await client.query(`
            UPDATE user_positions
            SET status = 'REVOKED',
                is_active = false,
                end_date = CURRENT_DATE,
                end_reason = $1
            WHERE id = $2
        `, [reason || 'พ้นจากตำแหน่ง/ถอดถอนโดยผู้ใหญ่บ้าน', rec.id]);

        const roleShift = rec.account_id
            ? await syncUserAccountRoleFromPositions(client, rec.account_id)
            : { oldRole: null, newRole: null };

        await client.query(`
            INSERT INTO sys_approval_logs (
                village_id, target_type, target_id, target_account_id,
                action_type, old_status, new_status, old_role, new_role, approved_by, note
            ) VALUES ($1::uuid, 'USER_POSITION', $2, $3::uuid, 'REVOKE', $4, 'REVOKED', $5, $6, $7::uuid, $8)
        `, [
            village_id,
            String(rec.id),
            rec.account_id,
            rec.status,
            roleShift.oldRole,
            roleShift.newRole,
            approver_account_id,
            reason || `ถอดถอนจากตำแหน่ง ${rec.custom_position_title || rec.role_template_code}`
        ]);

        await client.query('COMMIT');
        res.json({
            success: true,
            message: roleShift.newRole === 'CITIZEN'
                ? 'ถอดถอนออกจากตำแหน่งแล้ว และปรับสถานะกลับเป็นประชาชนทั่วไป (CITIZEN) เรียบร้อย'
                : 'ถอดถอนออกจากตำแหน่งเรียบร้อยแล้ว'
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('V3 Revoke Leader Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// =========================================================================
// 1. API ตรวจสอบความพร้อมของหมู่บ้าน 5 ข้อ (ครบ 100% จึงปลดล็อก Copy Link)
// =========================================================================
app.get('/api/villages/:villageId/registration-readiness', async (req, res) => {
    const { villageId } = req.params;
    const client = await pgPool.connect();

    try {
        const vRes = await client.query(`
            SELECT
                v.*,
                to_jsonb(v) AS v_json,
                ua.account_id AS headman_acc_id,
                ua.username_phone AS headman_phone,
                ua.profile_id AS headman_profile_id,
                to_jsonb(ua) AS ua_json,
                to_jsonb(up) AS up_json
            FROM villages v
            LEFT JOIN user_accounts ua
                ON ua.account_id::text = v.headman_account_id::text
                OR (ua.village_id::text = v.village_id::text AND UPPER(COALESCE(ua.role::text, '')) = 'HEADMAN')
            LEFT JOIN user_profiles up
                ON up.profile_id::text = ua.profile_id::text
            WHERE v.village_id::text = $1::text
            ORDER BY (ua.account_id::text = v.headman_account_id::text) DESC NULLS LAST
            LIMIT 1
        `, [String(villageId)]);

        if (vRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลหมู่บ้าน' });
        }

        const row = vRes.rows[0];
        const vJson = row.v_json || {};
        const uaJson = row.ua_json || {};
        const upJson = row.up_json || {};
        const targetProfileId = upJson.profile_id || row.headman_profile_id || null;

        // ข้อ 1: รูปโปรไฟล์ผู้ใหญ่บ้าน
        let avatarUrl =
            upJson.image_url ||
            upJson.user_image ||
            upJson.avatar_url ||
            upJson.profile_image ||
            upJson.photo_url ||
            uaJson.image_url ||
            uaJson.user_image ||
            uaJson.avatar_url ||
            '';

        if (!String(avatarUrl).trim() && targetProfileId) {
            try {
                const mediaRes = await client.query(`
                    SELECT image_url
                    FROM citizen_profiles_media
                    WHERE profile_id::text = $1::text
                    ORDER BY COALESCE(is_active, false) DESC, uploaded_at DESC NULLS LAST
                    LIMIT 1
                `, [String(targetProfileId)]);
                if (mediaRes.rows[0]?.image_url) {
                    avatarUrl = mediaRes.rows[0].image_url;
                }
            } catch (_) {}
        }

        const cleanAvatar = String(avatarUrl || '').trim();
        const step1Done = Boolean(cleanAvatar && !cleanAvatar.endsWith('/profile-img.jpg'));

        // ข้อ 2: จำนวนครัวเรือน และจำนวนประชากรในหมู่บ้าน
        const targetHouseholds = Number(
            vJson.total_households ?? vJson.household_count ?? vJson.households_target ?? 0
        ) || 0;
        const targetPopulation = Number(
            vJson.total_population ?? vJson.population_count ?? vJson.population_target ?? 0
        ) || 0;
        const step2Done = targetHouseholds > 0 && targetPopulation > 0;

        // ข้อ 3: บ้านเลขที่ในหมู่บ้าน
        let actualHouseholds = 0;
        try {
            const hCountRes = await client.query(`
                SELECT COUNT(*)::int AS cnt
                FROM households
                WHERE village_id::text = $1::text
            `, [String(villageId)]);
            actualHouseholds = Number(hCountRes.rows[0]?.cnt || 0);
        } catch (_) {
            actualHouseholds = 0;
        }
        const step3Done = targetHouseholds > 0 && actualHouseholds >= targetHouseholds;

        // ข้อ 4: ประชากรในบ้านเลขที่ / หมู่บ้าน
        let actualPopulation = 0;
        try {
            const mCountRes = await client.query(`
                SELECT COUNT(*)::int AS cnt
                FROM household_members hm
                JOIN households h ON hm.household_id::text = h.household_id::text
                WHERE h.village_id::text = $1::text
                  AND COALESCE(UPPER(hm.status::text), 'ACTIVE') <> 'MOVED_OUT'
            `, [String(villageId)]);
            actualPopulation = Number(mCountRes.rows[0]?.cnt || 0);
        } catch (_) {
            try {
                const pCountRes = await client.query(`
                    SELECT COUNT(*)::int AS cnt
                    FROM user_accounts
                    WHERE village_id::text = $1::text
                `, [String(villageId)]);
                actualPopulation = Number(pCountRes.rows[0]?.cnt || 0);
            } catch (_) {
                actualPopulation = 0;
            }
        }
        const step4Done = targetPopulation > 0 && actualPopulation >= targetPopulation;


// เช็กข้อ 5: ผู้ช่วยผู้ใหญ่บ้าน / ผู้ช่วยในผังผู้นำชุมชนครบ 2 คน
       // เช็กข้อ 5: ผู้ช่วยผู้ใหญ่บ้าน / ผู้ช่วยในผังผู้นำชุมชนครบ 2 คน (อิงตารางหลัก user_positions)
        let assistantCount = 0;
        try {
            const posRes = await client.query(`
                SELECT COUNT(*)::int AS cnt
                FROM user_positions upos
                LEFT JOIN sys_positions sp
                    ON sp.position_id::text = upos.position_id::text
                WHERE COALESCE(upos.village_id::text, upos.scope_id::text) = $1::text
                  AND COALESCE(upos.is_active, true) = true
                  AND COALESCE(UPPER(upos.status::text), 'ACTIVE') IN ('ACTIVE', 'APPROVED')
                  AND (
                      COALESCE(to_jsonb(upos)->>'custom_position_title', '') ILIKE '%ผู้ช่วย%'
                      OR COALESCE(to_jsonb(upos)->>'position_name', '') ILIKE '%ผู้ช่วย%'
                      OR COALESCE(to_jsonb(upos)->>'responsibilities', '') ILIKE '%ผู้ช่วย%'
                      OR COALESCE(to_jsonb(sp)->>'position_name', '') ILIKE '%ผู้ช่วย%'
                      OR COALESCE(to_jsonb(sp)->>'position_title', '') ILIKE '%ผู้ช่วย%'
                      OR UPPER(COALESCE(to_jsonb(upos)->>'role_template_code', '')) LIKE '%ASSISTANT%'
                      OR UPPER(COALESCE(to_jsonb(upos)->>'role_template_code', '')) LIKE '%DEPUTY%'
                  )
            `, [String(villageId)]);
            assistantCount = Number(posRes.rows[0]?.cnt || 0);
        } catch (_) {
            assistantCount = 0;
        }

        if (assistantCount === 0) {
            const fallbackAssistantQueries = [
                `
                    SELECT COUNT(*)::int AS cnt
                    FROM village_committees vc
                    WHERE vc.village_id::text = $1::text
                      AND COALESCE(UPPER(to_jsonb(vc)->>'status'), 'ACTIVE') IN ('ACTIVE', 'APPROVED')
                      AND (
                          COALESCE(to_jsonb(vc)->>'position_name', '') ILIKE '%ผู้ช่วย%'
                          OR COALESCE(to_jsonb(vc)->>'custom_position_title', '') ILIKE '%ผู้ช่วย%'
                          OR COALESCE(to_jsonb(vc)->>'committee_name', '') ILIKE '%ผู้ช่วย%'
                      )
                `,
                `
                    SELECT COUNT(*)::int AS cnt
                    FROM community_committees cc
                    WHERE cc.village_id::text = $1::text
                      AND COALESCE(UPPER(to_jsonb(cc)->>'status'), 'ACTIVE') IN ('ACTIVE', 'APPROVED')
                      AND (
                          COALESCE(to_jsonb(cc)->>'position_name', '') ILIKE '%ผู้ช่วย%'
                          OR COALESCE(to_jsonb(cc)->>'custom_position_title', '') ILIKE '%ผู้ช่วย%'
                          OR COALESCE(to_jsonb(cc)->>'committee_name', '') ILIKE '%ผู้ช่วย%'
                      )
                `
            ];

            for (const q of fallbackAssistantQueries) {
                try {
                    const r = await client.query(q, [String(villageId)]);
                    const c = Number(r.rows[0]?.cnt || 0);
                    if (c > assistantCount) assistantCount = c;
                } catch (_) {}
            }
        }
        const step5Done = assistantCount >= 2;

        const checklist = [
            {
                step: 1,
                key: 'profile_avatar',
                label: 'เพิ่มรูปโปรไฟล์ผู้ใหญ่บ้าน',
                completed: step1Done,
                detail: step1Done ? 'มีรูปโปรไฟล์แล้ว' : 'ยังไม่ได้อัปโหลดรูปโปรไฟล์'
            },
            {
                step: 2,
                key: 'village_stats',
                label: 'กรอกจำนวนครัวเรือนและจำนวนประชากรในหมู่บ้าน',
                completed: step2Done,
                detail: `ครัวเรือนเป้าหมาย ${targetHouseholds} | ประชากรเป้าหมาย ${targetPopulation}`
            },
            {
                step: 3,
                key: 'households_complete',
                label: 'เพิ่มบ้านเลขที่ในหมู่บ้านให้ครบ',
                completed: step3Done,
                detail: `เพิ่มแล้ว ${actualHouseholds} / ${targetHouseholds} หลัง`
            },
            {
                step: 4,
                key: 'population_complete',
                label: 'เพิ่มประชากรในบ้านเลขที่ให้ครบ',
                completed: step4Done,
                detail: `เพิ่มแล้ว ${actualPopulation} / ${targetPopulation} คน`
            },
            {
                step: 5,
                key: 'assistant_headmen',
                label: 'เพิ่มผังผู้นำชุมชน (ผู้ช่วยผู้ใหญ่บ้านครบ 2 คน)',
                completed: step5Done,
                detail: `ผู้ช่วยผู้ใหญ่บ้าน ${Math.min(assistantCount, 2)} / 2 คน`
            }
        ];

        const completedSteps = checklist.filter(c => c.completed).length;
        const completionPercent = Math.round((completedSteps / checklist.length) * 100);
        const isReadyToShare = completedSteps === checklist.length;

        const refCode = row.headman_acc_id || row.headman_phone || '';
        const shareLink = isReadyToShare
            ? `https://banrao.life/register-village${refCode ? `?ref=${encodeURIComponent(refCode)}` : ''}`
            : null;

        res.json({
            success: true,
            village_id: row.village_id,
            is_ready_to_share: isReadyToShare,
            completed_steps: completedSteps,
            total_steps: checklist.length,
            completion_percent: completionPercent,
            share_link: shareLink,
            checklist
        });
    } catch (error) {
        console.error('Readiness Check Error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

// =========================================================================
// 2. API เรียงลำดับสายผังผู้นำชุมชน + สถานะบัญชีสำหรับ Login
//    - ลำดับที่ 1: ผู้ใหญ่บ้าน
//    - ลำดับที่ 2: ผู้ช่วยผู้ใหญ่บ้านทั้ง 2 คน
//    - ลำดับที่ 3+: ตำแหน่ง/คณะทำงานอื่นๆ ของหมู่บ้าน
// =========================================================================
app.get('/api/villages/:villageId/leaders-line', async (req, res) => {
    const { villageId } = req.params;
    const client = await pgPool.connect();

    try {
        const result = await client.query(`
            SELECT
                vc.*,
                to_jsonb(vc) AS vc_json,
                ua.account_id AS linked_account_id,
                ua.username_phone,
                ua.is_active AS account_active,
                up.first_name,
                up.last_name,
                up.nickname,
                CASE
                    WHEN COALESCE(vc.position_name, '') ILIKE '%ผู้ใหญ่บ้าน%'
                     AND COALESCE(vc.position_name, '') NOT ILIKE '%ผู้ช่วย%' THEN 1
                    WHEN COALESCE(vc.position_name, '') ILIKE '%ผู้ช่วยผู้ใหญ่บ้าน%' THEN 2
                    ELSE 3
                END AS line_order
            FROM village_committees vc
            LEFT JOIN user_accounts ua
                ON ua.account_id = vc.account_id
                OR (
                    vc.account_id IS NULL
                    AND COALESCE(vc.phone_number, '') <> ''
                    AND ua.username_phone = vc.phone_number
                )
            LEFT JOIN user_profiles up ON up.profile_id = ua.profile_id
            WHERE vc.village_id::text = $1::text
            ORDER BY line_order ASC, vc.assigned_at ASC NULLS LAST
        `, [String(villageId)]);

        const leaders = result.rows.map((r, idx) => {
            const hasAccount = Boolean(r.linked_account_id);
            const canLogin = Boolean(hasAccount && r.account_active !== false);
            return {
                line_no: idx + 1,
                line_group: r.line_order === 1 ? 'HEADMAN' : (r.line_order === 2 ? 'ASSISTANT_HEADMAN' : 'OTHER_COMMITTEE'),
                committee_id: r.committee_id,
                village_id: r.village_id,
                position_name: r.position_name,
                committee_name: r.committee_name,
                account_id: r.linked_account_id || null,
                username_phone: r.username_phone || r.vc_json?.phone_number || null,
                full_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.vc_json?.full_name || null,
                nickname: r.nickname || null,
                has_account: hasAccount,
                can_login: canLogin,
                login_status_label: canLogin ? 'พร้อมเข้าสู่ระบบ (Login ได้แล้ว)' : 'ต้องลงทะเบียนบัญชีเพื่อ Login'
            };
        });

        res.json({
            success: true,
            village_id: villageId,
            total_leaders: leaders.length,
            assistant_headman_count: leaders.filter(l => l.line_group === 'ASSISTANT_HEADMAN').length,
            leaders
        });
    } catch (error) {
        console.error('Leaders Line Error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});


// =========================================================================
// 3. API ลงทะเบียนบัญชีให้ผู้ช่วยผู้ใหญ่บ้าน / บุคคลในผัง เพื่อ Login เข้าระบบ
//    - สร้าง/ผูก user_profiles + user_accounts และอัปเดต account_id ในผังทันที
// =========================================================================
app.post('/api/villages/:villageId/leaders/register-account', async (req, res) => {
    const { villageId } = req.params;
    const {
        committee_id,
        phone_number,
        password,
        first_name,
        last_name,
        nickname,
        citizen_id,
        gender,
        dob,
        role
    } = req.body;

    if (!phone_number || !password || !first_name || !last_name) {
        return res.status(400).json({
            success: false,
            message: 'กรุณากรอกเบอร์โทรศัพท์ รหัสผ่าน ชื่อจริง และนามสกุลให้ครบถ้วน'
        });
    }

    const cleanPhone = String(phone_number).replace(/\D/g, '');
    if (cleanPhone.length !== 10) {
        return res.status(400).json({ success: false, message: 'เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก' });
    }
    if (String(password).length < 6) {
        return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
    }

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        const existsPhone = await client.query(
            'SELECT account_id FROM user_accounts WHERE username_phone = $1 LIMIT 1',
            [cleanPhone]
        );
        if (existsPhone.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                message: 'เบอร์โทรศัพท์นี้มีบัญชีในระบบแล้ว สามารถใช้ Login ได้ทันที'
            });
        }

        const cleanCid = citizen_id ? String(citizen_id).replace(/\D/g, '').trim() : null;
        const finalCid = cleanCid || `999${Math.floor(Math.random() * 10000000000).toString().padStart(10, '0')}`;
        const finalGender = gender && String(gender).trim() !== '' ? String(gender).trim() : null;
        const finalDob = dob && String(dob).trim() !== '' ? String(dob).trim() : '1900-01-01';
        const finalRole = ['HEADMAN', 'CITIZEN'].includes(String(role || '').toUpperCase())
            ? String(role).toUpperCase()
            : 'CITIZEN';

        const profRes = await client.query(`
            INSERT INTO user_profiles (profile_id, first_name, last_name, nickname, citizen_id, gender, dob)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
            RETURNING profile_id
        `, [first_name.trim(), last_name.trim(), nickname ? nickname.trim() : null, finalCid, finalGender, finalDob]);
        const newProfileId = profRes.rows[0].profile_id;

        const hashedPassword = await bcrypt.hash(String(password), 10);
        const accRes = await client.query(`
            INSERT INTO user_accounts (account_id, username_phone, password_hash, is_active, area_code, profile_id, role, village_id)
            VALUES (gen_random_uuid(), $1, $2, true, '100000', $3, $4, $5)
            RETURNING account_id
        `, [cleanPhone, hashedPassword, newProfileId, finalRole, villageId]);
        const newAccountId = accRes.rows[0].account_id;

        if (committee_id) {
            await client.query(`
                UPDATE village_committees
                SET account_id = $1
                WHERE committee_id::text = $2::text
                  AND village_id::text = $3::text
            `, [newAccountId, String(committee_id), String(villageId)]);
        }

        await client.query('COMMIT');
        res.json({
            success: true,
            message: 'ลงทะเบียนบัญชีสำเร็จ สามารถใช้เบอร์โทรศัพท์และรหัสผ่าน Login เข้าระบบได้ทันที',
            account_id: newAccountId,
            profile_id: newProfileId,
            username_phone: cleanPhone
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Leader Register Account Error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});