require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // ปิด/เปิดตามการตั้งค่าใน server.js ของคุณวิทยาครับ
});

const BATCH_SIZE = 500; // 🌟 กำหนดจำนวนการบันทึกทีละ 500 รายชื่อ

async function importVillages() {
    const client = await pgPool.connect();
    try {
        console.log('กำลังอ่านไฟล์ api_villages.json...');
        const filePath = path.join(__dirname, 'api_villages.json');
        const rawData = fs.readFileSync(filePath, 'utf8');
        const villages = JSON.parse(rawData);

        console.log(`พบข้อมูลหมู่บ้านทั้งหมด ${villages.length} รายการ เริ่มทำการ Import ทีละ ${BATCH_SIZE} รายการ...`);

        let totalInserted = 0;

        // วนลูปตัดแบ่งข้อมูลทีละ 500 รายชื่อ
        for (let i = 0; i < villages.length; i += BATCH_SIZE) {
            const batch = villages.slice(i, i + BATCH_SIZE);

            const values = [];
            const placeholders = [];

            batch.forEach((v, index) => {
                const offset = index * 3;
                placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);

                // 🌟 จุดเช็กชื่อ Key ในไฟล์ api_villages.json (ดักเผื่อไว้หลายชื่อที่ใช้บ่อยใน GitHub)
                const tambonId = v.tambon_id || v.sub_district_id || v.subdistrict_id;
                const villageNo = v.village_no || v.moo || v.moo_no || '-';
                const villageName = v.name_th || v.village_name || v.name || '';

                values.push(tambonId, String(villageNo), villageName);
            });

            const query = `
                INSERT INTO villages (tambon_id, village_no, village_name)
                VALUES ${placeholders.join(', ')}
                ON CONFLICT DO NOTHING;
            `;

            await client.query('BEGIN');
            await client.query(query, values);
            await client.query('COMMIT');

            totalInserted += batch.length;
            console.log(`✅ นำเข้าแล้ว ${totalInserted} / ${villages.length} รายการ`);
        }

        console.log('🎉 Import รายชื่อหมู่บ้านทั้งหมดเสร็จสมบูรณ์!');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ เกิดข้อผิดพลาดในการ Import:', error);
    } finally {
        client.release();
        await pgPool.end();
    }
}

importVillages();