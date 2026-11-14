const { Pool } = require('pg');
require('dotenv').config(); // ดึงค่าเชื่อมต่อ DB จากไฟล์ .env

// ตั้งค่าฐานข้อมูลของคุณ
const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } // ปรับตามการตั้งค่า Neon ของคุณ
});

// URL ของไฟล์ JSON จาก GitHub (คุณต้องเปลี่ยนเป็น URL จริงที่มีข้อมูลหมู่บ้าน)
const DATA_URL = 'https://raw.githubusercontent.com/YOUR_GITHUB_PATH/thai_villages.json'; 
const BATCH_SIZE = 200;

// ฟังก์ชันสำหรับหน่วงเวลา (หน่วงให้ดู Log ทัน และไม่ยิง DB รัวเกินไป)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function importVillages() {
    console.log('⏳ กำลังดาวน์โหลดข้อมูลหมู่บ้านจาก GitHub...');
    
    try {
        // 1. ดึงข้อมูล JSON จาก GitHub
        const response = await fetch(DATA_URL);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const villagesData = await response.json();
        console.log(`✅ ดาวน์โหลดสำเร็จ! พบข้อมูลทั้งหมด ${villagesData.length} รายการ`);
        console.log(`🚀 จะทำการบันทึกทีละ ${BATCH_SIZE} รายการ...\n`);

        const client = await pgPool.connect();

        try {
            // 2. ลูปแบ่งข้อมูลเป็นก้อน (Chunks) ทีละ 200
            for (let i = 0; i < villagesData.length; i += BATCH_SIZE) {
                const chunk = villagesData.slice(i, i + BATCH_SIZE);
                
                await client.query('BEGIN'); // เริ่ม Transaction ทีละ 200
                
                // 3. วนลูป Insert ข้อมูลใน Chunk ลงฐานข้อมูล
                for (const v of chunk) {
                    // 🌟 ปรับชื่อตาราง (sys_villages) และคอลัมน์ให้ตรงกับฐานข้อมูลจริงของคุณ
                    await client.query(`
                        INSERT INTO sys_villages (tambon_id, village_no, village_name) 
                        VALUES ($1, $2, $3)
                        ON CONFLICT DO NOTHING -- ป้องกันการบันทึกซ้ำ
                    `, [v.tambon_id, v.village_no, v.village_name]);
                }

                await client.query('COMMIT'); // ยืนยันการบันทึก 200 แถว
                
                const progress = Math.min(i + BATCH_SIZE, villagesData.length);
                const percent = ((progress / villagesData.length) * 100).toFixed(2);
                
                console.log(`[${percent}%] 💾 บันทึกแล้ว: ${progress} / ${villagesData.length} รายการ`);
                
                // หน่วงเวลา 0.5 วินาที ก่อนรันชุดต่อไป (ปรับตัวเลขได้ตามต้องการ)
                await sleep(500); 
            }
            
            console.log('\n🎉 นำเข้าข้อมูลหมู่บ้านทั้งประเทศเสร็จสมบูรณ์!');

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('\n❌ เกิดข้อผิดพลาดในการบันทึกข้อมูล (Rollback แล้ว):', error);
        } finally {
            client.release();
            pgPool.end(); // ปิดการเชื่อมต่อเมื่อเสร็จสิ้น
        }

    } catch (error) {
        console.error('\n❌ ไม่สามารถดึงข้อมูลจาก API/GitHub ได้:', error.message);
        pgPool.end();
    }
}

// เริ่มรันการทำงาน
importVillages();