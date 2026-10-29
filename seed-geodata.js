require('dotenv').config();
const { Pool } = require('pg');

const amphures = require('./api_amphure.json');
const tambons = require('./api_tambon.json');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // ssl: { rejectUnauthorized: false }
});

function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

// สร้างฟังก์ชันสำหรับหยุดพัก (หน่วงเวลา)
const delay = ms => new Promise(res => setTimeout(res, ms));

async function seedData() {
    const client = await pool.connect();
    try {
        console.log(`✅ โหลดข้อมูลจากไฟล์สำเร็จ: อำเภอ ${amphures.length} แห่ง | ตำบล ${tambons.length} แห่ง`);

        await client.query('BEGIN');
        
        console.log("🧹 กำลังล้างข้อมูลตารางเดิม...");
        await client.query('TRUNCATE sys_tambons, sys_amphures CASCADE');

        // 1. นำเข้าอำเภอ (ลดเหลือทีละ 200)
        console.log("💾 กำลังบันทึกข้อมูลอำเภอ...");
        const amphureChunks = chunkArray(amphures, 200); 
        for (let i = 0; i < amphureChunks.length; i++) {
            const chunk = amphureChunks[i];
            for (const a of chunk) {
                await client.query(
                    `INSERT INTO sys_amphures (amphure_id, province_id, amphure_code, amphure_name_th, amphure_name_en) 
                     VALUES ($1, $2, $3, $4, $5)`,
                    [a.id, a.province_id, a.id.toString(), a.name_th, a.name_en]
                );
            }
            console.log(`  - บันทึกอำเภอแล้ว ${Math.min((i + 1) * 200, amphures.length)} / ${amphures.length}`);
            await delay(500); // หยุดพัก 0.5 วินาที
        }

        // 2. นำเข้าตำบล (ลดเหลือทีละ 200)
        console.log("💾 กำลังบันทึกข้อมูลตำบล (ใจเย็นๆ ปล่อยรันไปเรื่อยๆ นะครับ)...");
        const tambonChunks = chunkArray(tambons, 200); 
        for (let i = 0; i < tambonChunks.length; i++) {
            const chunk = tambonChunks[i];
            for (const t of chunk) {
                const zipCode = t.zip_code ? t.zip_code.toString() : '00000';
                await client.query(
                    `INSERT INTO sys_tambons (tambon_id, amphure_id, tambon_code, tambon_name_th, tambon_name_en, zip_code) 
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [t.id, t.amphure_id, t.id.toString(), t.name_th, t.name_en, zipCode]
                );
            }
            console.log(`  - บันทึกตำบลแล้ว ${Math.min((i + 1) * 200, tambons.length)} / ${tambons.length}`);
            await delay(500); // หยุดพัก 0.5 วินาที
        }

        await client.query('COMMIT');
        console.log("🎉 นำเข้าข้อมูลภูมิศาสตร์ ประเทศไทย สำเร็จ 100%!");

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("❌ เกิดข้อผิดพลาด:", error.message);
    } finally {
        client.release();
        pool.end();
    }
}

seedData();