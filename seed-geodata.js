require('dotenv').config();
const { Pool } = require('pg');

console.log("Database URL: ", process.env.DATABASE_URL ? "Loaded" : "Missing"); 
// ... (โค้ดเดิม) ...
// ใช้การเชื่อมต่อแบบเดียวกับ server.js ของคุณ
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    //ssl: { rejectUnauthorized: false } 
});

async function seedData() {
    const client = await pool.connect();
    try {
        console.log("⏳ กำลังดาวน์โหลดข้อมูล อำเภอ และ ตำบล ทั่วประเทศ...");

// 1. ดึงข้อมูล JSON พื้นฐานของไทยจาก Public Repository
        const amphuresRes = await fetch('https://raw.githubusercontent.com/kongvut/thai-province-data/main/api_amphure.json');
        if (!amphuresRes.ok) {
            throw new Error(`โหลดข้อมูลอำเภอไม่สำเร็จ (Status: ${amphuresRes.status})`);
        }
        const amphures = await amphuresRes.json();

        const tambonsRes = await fetch('https://raw.githubusercontent.com/kongvut/thai-province-data/main/api_tambon.json');
        if (!tambonsRes.ok) {
            throw new Error(`โหลดข้อมูลตำบลไม่สำเร็จ (Status: ${tambonsRes.status})`);
        }
        const tambons = await tambonsRes.json();

        // 2. เคลียร์ข้อมูลอำเภอและตำบลเดิม (รวมถึงตัวอย่างเขต กทม. ที่ทดสอบไป) เพื่อใส่ข้อมูลฉบับเต็ม
        console.log("🧹 กำลังล้างข้อมูลตารางเดิมเพื่อเตรียมนำเข้า...");
        await client.query('TRUNCATE sys_tambons, sys_amphures CASCADE');

        // 3. นำเข้าข้อมูลอำเภอ
        console.log("💾 กำลังบันทึกลงตาราง sys_amphures...");
        for (const a of amphures) {
            await client.query(
                `INSERT INTO sys_amphures (amphure_id, province_id, amphure_code, amphure_name_th, amphure_name_en) 
                 VALUES ($1, $2, $3, $4, $5)`,
                [a.id, a.province_id, a.id.toString(), a.name_th, a.name_en]
            );
        }

        // 4. นำเข้าข้อมูลตำบล และ รหัสไปรษณีย์
        console.log("💾 กำลังบันทึกลงตาราง sys_tambons...");
        for (const t of tambons) {
            // บางตำบลอาจไม่มีรหัสไปรษณีย์ ให้ดักค่า null ไว้
            const zipCode = t.zip_code ? t.zip_code.toString() : '00000';
            await client.query(
                `INSERT INTO sys_tambons (tambon_id, amphure_id, tambon_code, tambon_name_th, tambon_name_en, zip_code) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [t.id, t.amphure_id, t.id.toString(), t.name_th, t.name_en, zipCode]
            );
        }

        await client.query('COMMIT');
        console.log("🎉 นำเข้าข้อมูลภูมิศาสตร์ ประเทศไทย สำเร็จ 100%!");

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("❌ เกิดข้อผิดพลาดในการนำเข้า:", error);
    } finally {
        client.release();
        pool.end();
    }
}

// เรียกใช้งานฟังก์ชัน
seedData();