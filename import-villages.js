const { Pool } = require('pg');
const fs = require('fs'); // 🌟 เพิ่มบรรทัดนี้เพื่อเรียกใช้ File System ของ Node.js
require('dotenv').config();

const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

const BATCH_SIZE = 200;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function importVillages() {
    console.log('⏳ กำลังอ่านข้อมูลหมู่บ้านจากไฟล์ในเครื่อง...');
    
    try {
        // 🌟 1. อ่านข้อมูลจากไฟล์ JSON ในเครื่อง (เช็คชื่อไฟล์ให้ตรงกับที่คุณมี)
        const fileData = fs.readFileSync('./api_village.json', 'utf8');
        const villagesData = JSON.parse(fileData);
        
        console.log(`✅ อ่านไฟล์สำเร็จ! พบข้อมูลทั้งหมด ${villagesData.length} รายการ`);
        console.log(`🚀 จะทำการบันทึกทีละ ${BATCH_SIZE} รายการ...\n`);

        const client = await pgPool.connect();

        try {
            for (let i = 0; i < villagesData.length; i += BATCH_SIZE) {
                const chunk = villagesData.slice(i, i + BATCH_SIZE);
                await client.query('BEGIN'); 
                
                for (const v of chunk) {
                    await client.query(`
                        INSERT INTO sys_villages (tambon_id, village_no, village_name) 
                        VALUES ($1, $2, $3)
                        ON CONFLICT DO NOTHING
                    `, [v.tambon_id, v.village_no, v.village_name]);
                }

                await client.query('COMMIT'); 
                
                const progress = Math.min(i + BATCH_SIZE, villagesData.length);
                const percent = ((progress / villagesData.length) * 100).toFixed(2);
                console.log(`[${percent}%] 💾 บันทึกแล้ว: ${progress} / ${villagesData.length} รายการ`);
                
                await sleep(500); 
            }
            console.log('\n🎉 นำเข้าข้อมูลหมู่บ้านทั้งประเทศเสร็จสมบูรณ์!');

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('\n❌ เกิดข้อผิดพลาดในการบันทึกข้อมูล:', error);
        } finally {
            client.release();
            pgPool.end(); 
        }

    } catch (error) {
        console.error('\n❌ ไม่สามารถอ่านไฟล์ JSON ได้ (ตรวจสอบว่ามีไฟล์นี้และชื่อถูกต้อง):', error.message);
        pgPool.end();
    }
}

importVillages();