const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Roshd@2026';
const ROOT = __dirname;

const TURSO_URL = process.env.TURSO_DATABASE_URL ? process.env.TURSO_DATABASE_URL.replace(/^libsql:\/\//, 'https://') : '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

// دالة تنفيذ الاستعلامات عبر HTTP API الخاص بـ Turso مباشرة
async function dbQuery(sql, args = []) {
  if (!TURSO_URL || !TURSO_TOKEN) {
    throw new Error("TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is missing");
  }
  
  const baseUrl = TURSO_URL.endsWith('/') ? TURSO_URL.slice(0, -1) : TURSO_URL;
  
  const formattedArgs = args.map(val => {
    if (val === null || val === undefined) return { type: 'null' };
    if (typeof val === 'number') return { type: Number.isInteger(val) ? 'integer' : 'float', value: String(val) };
    if (typeof val === 'boolean') return { type: 'integer', value: val ? '1' : '0' };
    return { type: 'text', value: String(val) };
  });

  const response = await fetch(`${baseUrl}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURSO_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requests: [
        { type: 'execute', stmt: { sql, args: formattedArgs } },
        { type: 'close' }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Turso HTTP Error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  const result = data.results[0];
  
  if (result.type === 'error') {
    throw new Error(`SQL Error: ${result.error.message}`);
  }

  const cols = result.response.result.cols.map(c => c.name);
  const rows = result.response.result.rows.map(row => {
    const obj = {};
    row.forEach((cell, idx) => {
      let val = null;
      if (cell.type === 'integer') val = Number(cell.value);
      else if (cell.type === 'float') val = parseFloat(cell.value);
      else if (cell.type === 'text') val = cell.value;
      else if (cell.type === 'blob') val = cell.value;
      obj[cols[idx]] = val;
    });
    return obj;
  });

  return { rows, columns: cols };
}

const sessions = new Map();

// تهيئة الجداول في السحابة
async function initDB() {
  await dbQuery(`PRAGMA foreign_keys = ON;`);
  
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS members (
      student_id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL,
      committee TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      points INTEGER NOT NULL CHECK(points >= 0), status TEXT NOT NULL DEFAULT 'نشط'
    );
  `);
  
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS point_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT NOT NULL,
      activity_id INTEGER, activity_name TEXT NOT NULL, logged_at TEXT NOT NULL,
      points INTEGER NOT NULL, note TEXT,
      FOREIGN KEY(student_id) REFERENCES members(student_id) ON DELETE CASCADE,
      FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
    );
  `);

  const memberColumnsRes = await dbQuery('PRAGMA table_info(members)');
  const memberColumns = memberColumnsRes.rows.map(c => c.name);
  if (!memberColumns.includes('status')) await dbQuery("ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'مقبول'");
  if (!memberColumns.includes('bio')) await dbQuery("ALTER TABLE members ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
  if (!memberColumns.includes('skills')) await dbQuery("ALTER TABLE members ADD COLUMN skills TEXT NOT NULL DEFAULT ''");

  const actCountRes = await dbQuery('SELECT COUNT(*) AS c FROM activities');
  if (Number(actCountRes.rows[0].c) === 0) {
    const activities = [['اجتماع الفريق',5],['حضور ورشة',10],['المشاركة في فعالية',10],['تمثيل النادي في البوث',15],['تنظيم فعالية',15],['تنفيذ مهمة',10],['تقديم فكرة قابلة للتنفيذ',10],['تنفيذ مبادرة',25],['تصميم / تصوير / مونتاج',15],['قيادة مهمة',20]];
    for (const [name, points] of activities) {
      await dbQuery('INSERT INTO activities (name, points, status) VALUES (?, ?, ?)', [name, points, 'نشط']);
    }
  }

  const memCountRes = await dbQuery('SELECT COUNT(*) AS c FROM members');
  if (Number(memCountRes.rows[0].c) === 0) {
    const members = [['441800001','سارة المطيري','0500000001','لجنة الإعلام',145],['441800002','عبدالعزيز العتيبي','0500000002','لجنة البرامج',128],['441800003','نورة الشمري','0500000003','لجنة العلاقات العامة',105],['441800004','محمد العنزي','0500000004','لجنة التنظيم',82],['441800005','الجوهرة القحطاني','0500000005','لجنة المحتوى',55],['441800006','فهد الدوسري','0500000006','لجنة التطوير',37]];
    for (const m of members) {
      await dbQuery('INSERT INTO members (student_id,name,phone,committee,points) VALUES (?,?,?,?,?)', m);
    }
  }
}

initDB().catch(err => console.error('Database initialization error:', err));

function level(points) {
  if (points < 50) return { title:'عضو مشارك', color:'green', min:0, next:50 };
  if (points < 100) return { title:'عضو فعّال', color:'blue', min:50, next:100 };
  if (points < 150) return { title:'عضو متميز', color:'purple', min:100, next:150 };
  return { title:'نخبة رُشد', color:'gold', min:150, next:null };
}

async function enrich(m) {
  if (!m) return null;
  let rank = null;
  if (m.status === 'مقبول') {
    const exactRes = await dbQuery("SELECT COUNT(*) + 1 AS r FROM members WHERE status='مقبول' AND points > ?", [m.points]);
    rank = exactRes.rows[0].r;
  }
  return { ...m, level: level(m.points), rank };
}

function send(res, status, data, headers={}) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', ...headers}); res.end(JSON.stringify(data)); }
function body(req) { return new Promise((resolve,reject)=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>{try{resolve(d?JSON.parse(d):{})}catch(e){reject(e)}}) }); }
function getSession(req) { const token = (req.headers.cookie||'').match(/roshd_session=([^;]+)/)?.[1]; return token && sessions.get(token); }
function requireAdmin(req,res) { if (!getSession(req)) { send(res,401,{error:'يلزم تسجيل الدخول للإدارة'}); return false; } return true; }
function error(res,e) { console.error(e); send(res,400,{error: e.message || 'تعذر إتمام العملية'}); }
function dateNow(){ return new Date().toISOString().slice(0,10); }

async function api(req,res,url) {
  const p=url.pathname, method=req.method;
  
  if (method==='GET' && p==='/api/wallet-card') {
    const id = url.searchParams.get('student_id');
    const mRes = await dbQuery('SELECT * FROM members WHERE student_id=?', [id]);
    const m = mRes.rows[0];
    if (!m) {
      res.writeHead(404, {'Content-Type': 'text/html; charset=utf-8'});
      return res.end('<h3>العضوية غير موجودة</h3>');
    }
    const enriched = await enrich(m);
    const cardUrl = `https://${req.headers.host}/api/wallet-card?student_id=${m.student_id}`;
    
    const htmlCard = `<!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>بطاقة عضوية نادي رُشد</title>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
      <style>
        body { background: #0f172a; font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
        .pass-card { background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border: 1px solid rgba(255,255,255,0.15); border-radius: 24px; width: 100%; max-width: 380px; padding: 28px; box-shadow: 0 25px 35px -5px rgba(0, 0, 0, 0.6); color: white; position: relative; overflow: hidden; }
        .pass-card::before { content: ''; position: absolute; top: -60px; right: -60px; width: 160px; height: 160px; background: rgba(52, 211, 153, 0.15); border-radius: 50%; filter: blur(45px); }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 12px; }
        .club-name { font-weight: bold; font-size: 1.1rem; color: #34d399; }
        .committee { font-size: 0.8rem; background: rgba(52, 211, 153, 0.15); color: #34d399; padding: 4px 12px; border-radius: 20px; font-weight: 500; }
        .info-group { margin-bottom: 14px; }
        .label { font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; margin-bottom: 2px; }
        .value { font-size: 1.15rem; font-weight: bold; color: #f8fafc; }
        .footer { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.1); }
        .points-badge { background: #34d399; color: #064e3b; font-weight: bold; padding: 5px 12px; border-radius: 12px; font-size: 0.95rem; }
        .qrcode-container { display: flex; justify-content: center; margin-top: 16px; background: white; padding: 10px; border-radius: 12px; width: fit-content; margin-left: auto; margin-right: auto; }
        .btn-print { display: block; width: 100%; background: #34d399; color: #064e3b; text-align: center; padding: 12px; border-radius: 14px; text-decoration: none; font-weight: bold; margin-top: 18px; border: none; cursor: pointer; transition: 0.2s; box-shadow: 0 4px 12px rgba(52, 211, 153, 0.3); }
        .btn-print:hover { background: #10b981; color: #fff; }
      </style>
    </head>
    <body>
      <div class="pass-card">
        <div class="header">
          <span class="club-name">نادي رُشد | Roshd</span>
          <span class="committee">${m.committee}</span>
        </div>
        <div class="info-group">
          <div class="label">اسم العضو</div>
          <div class="value">${m.name}</div>
        </div>
        <div class="info-group">
          <div class="label">الرقم الجامعي</div>
          <div class="value">${m.student_id}</div>
        </div>
        <div class="info-group">
          <div class="label">المستوى واللقب</div>
          <div class="value" style="color: #34d399; font-size: 1rem;">${enriched.level.title}</div>
        </div>
        <div class="footer">
          <div>
            <div class="label">الحالة</div>
            <div style="color: #34d399; font-weight: 600; font-size: 0.9rem;">${m.status}</div>
          </div>
          <div>
            <div class="label">النقاط الإجمالية</div>
            <div class="points-badge">${m.points} نقطة</div>
          </div>
        </div>
        <div class="qrcode-container" id="qrcode"></div>
        <button class="btn-print" onclick="window.print()">حفظ أو طباعة البطاقة الرقمية</button>
      </div>
      <script>
        new QRCode(document.getElementById("qrcode"), {
          text: "${cardUrl}",
          width: 110,
          height: 110,
          colorDark: "#0f172a",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.H
        });
      </script>
    </body>
    </html>`;
    
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    return res.end(htmlCard);
  }

  if (method==='GET' && p==='/api/member') { 
    const id=url.searchParams.get('student_id'); 
    const mRes = await dbQuery('SELECT student_id,name,committee,points,status,created_at FROM members WHERE student_id=?', [id]);
    const m = mRes.rows[0];
    if(!m) return send(res,404,{error:'لم نعثر على عضوية بهذا الرقم الجامعي'}); 
    if(m.status!=='مقبول') return send(res,403,{error:m.status==='قيد المراجعة'?'طلب عضويتك قيد المراجعة.':'تم رفض طلب العضوية.'}); 
    return send(res,200,{member: await enrich(m)}); 
  }
  
  if (method==='GET' && p==='/api/leaderboard') { 
    const rowsRaw = (await dbQuery("SELECT student_id,name,committee,points,status FROM members WHERE status='مقبول' ORDER BY points DESC, name ASC")).rows; 
    const rows = [];
    for (const r of rowsRaw) {
      rows.push(await enrich(r));
    }
    return send(res,200,{members:rows}); 
  }
  
  if (method==='POST' && p==='/api/register') { 
    const b=await body(req); 
    if(!b.student_id||!b.name||!b.phone||!b.committee) throw Error('أكمل الحقول المطلوبة'); 
    const valid=['لجنة الإرشاد','لجنة التصميم','لجنة التعيين والاختيار','لجنة التسويق والإعلام']; 
    if(!valid.includes(b.committee)) throw Error('اللجنة المختارة غير متاحة'); 
    await dbQuery(
      "INSERT INTO members(student_id,name,phone,committee,bio,skills,status,points) VALUES(?,?,?,?,?,?,'قيد المراجعة',0)",
      [String(b.student_id).trim(), b.name.trim(), b.phone.trim(), b.committee, b.bio?.trim()||'', b.skills?.trim()||'']
    );
    return send(res,201,{ok:true,message:'تم إرسال طلبك بنجاح، وسيتم إشعارك بعد مراجعته.'}); 
  }
  
  if (method==='POST' && p==='/api/admin/login') { 
    const b=await body(req); 
    if (b.password !== ADMIN_PASSWORD) return send(res,401,{error:'كلمة المرور غير صحيحة'}); 
    const token=crypto.randomBytes(24).toString('hex'); 
    sessions.set(token,{at:Date.now()}); 
    return send(res,200,{ok:true},{'Set-Cookie':`roshd_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`}); 
  }
  
  if (method==='POST' && p==='/api/admin/logout') { 
    const token=(req.headers.cookie||'').match(/roshd_session=([^;]+)/)?.[1]; 
    if(token) sessions.delete(token); 
    return send(res,200,{ok:true},{'Set-Cookie':'roshd_session=; Path=/; Max-Age=0'}); 
  }
  
  if (method==='GET' && p==='/api/admin/session') return send(res,200,{authenticated:!!getSession(req)});
  
  if (!p.startsWith('/api/admin/')) return send(res,404,{error:'غير موجود'});
  if (!requireAdmin(req,res)) return;
  
  if (method==='GET' && p==='/api/admin/dashboard') {
    const membersRaw = (await dbQuery('SELECT * FROM members ORDER BY points DESC, name ASC')).rows;
    const members = [];
    for (const m of membersRaw) {
      members.push(await enrich(m));
    }
    const accepted = members.filter(m => m.status === 'مقبول'); 
    const top = accepted[0] || null; 
    const totalRes = await dbQuery("SELECT COALESCE(SUM(points),0) AS n FROM members WHERE status='مقبول'");
    const total = totalRes.rows[0].n;
    
    const counts = { مشارك:0, فعال:0, متميز:0, نخبة:0 }; 
    members.forEach(m => { 
      if(m.level.color==='green') counts.مشارك++; 
      else if(m.level.color==='blue') counts.فعال++; 
      else if(m.level.color==='purple') counts.متميز++; 
      else counts.نخبة++; 
    });
    
    const activitiesList = (await dbQuery('SELECT * FROM activities ORDER BY id')).rows;
    const logsList = (await dbQuery('SELECT l.*, m.name AS member_name FROM point_logs l JOIN members m ON m.student_id=l.student_id ORDER BY l.id DESC LIMIT 100')).rows;

    return send(res, 200, {
      stats: {
        members: members.length, 
        accepted: accepted.length, 
        pending: members.filter(m => m.status === 'قيد المراجعة').length, 
        points: total, 
        top: top?.name || '—', 
        topPoints: top?.points || 0, 
        counts
      },
      members,
      activities: activitiesList,
      logs: logsList
    });
  }
  
  const b = await body(req);
  
  if (method==='POST' && p==='/api/admin/members') { 
    if(!b.student_id||!b.name||!b.phone||!b.committee) throw Error('أكمل جميع بيانات العضو'); 
    await dbQuery(
      "INSERT INTO members (student_id,name,phone,committee,points,status,bio,skills) VALUES (?,?,?,?,?,'مقبول',?,?)",
      [String(b.student_id).trim(), b.name.trim(), b.phone.trim(), b.committee.trim(), Number(b.points)||0, b.bio||'', b.skills||'']
    );
    return send(res,201,{ok:true}); 
  }
  
  if (method==='PUT' && p.startsWith('/api/admin/members/')) { 
    const id = decodeURIComponent(p.split('/').pop()); 
    await dbQuery(
      'UPDATE members SET name=?,phone=?,committee=?,points=?,status=?,bio=?,skills=? WHERE student_id=?',
      [b.name.trim(), b.phone.trim(), b.committee.trim(), Number(b.points)||0, b.status||'قيد المراجعة', b.bio||'', b.skills||'', id]
    );
    return send(res,200,{ok:true}); 
  }
  
  if (method==='POST' && p.startsWith('/api/admin/members/') && p.endsWith('/status')) { 
    const id = decodeURIComponent(p.split('/').slice(-2)[0]); 
    if(!['مقبول','مرفوض','قيد المراجعة'].includes(b.status)) throw Error('حالة غير صالحة'); 
    await dbQuery('UPDATE members SET status=? WHERE student_id=?', [b.status, id]);
    return send(res,200,{ok:true}); 
  }
  
  if (method==='DELETE' && p.startsWith('/api/admin/members/')) { 
    await dbQuery('DELETE FROM members WHERE student_id=?', [decodeURIComponent(p.split('/').pop())]);
    return send(res,200,{ok:true}); 
  }
  
  if (method==='POST' && p==='/api/admin/activities') { 
    if(!b.name) throw Error('اسم النشاط مطلوب'); 
    await dbQuery('INSERT INTO activities (name,points,status) VALUES (?,?,?)', [b.name.trim(), Number(b.points)||0, b.status||'نشط']);
    return send(res,201,{ok:true}); 
  }
  
  if (method==='PUT' && p.startsWith('/api/admin/activities/')) { 
    await dbQuery('UPDATE activities SET name=?,points=?,status=? WHERE id=?', [b.name.trim(), Number(b.points)||0, b.status, Number(p.split('/').pop())]);
    return send(res,200,{ok:true}); 
  }
  
  if (method==='DELETE' && p.startsWith('/api/admin/activities/')) { 
    await dbQuery('DELETE FROM activities WHERE id=?', [Number(p.split('/').pop())]);
    return send(res,200,{ok:true}); 
  }
  
  if (method==='POST' && p==='/api/admin/logs') { 
    const actRes = await dbQuery("SELECT * FROM activities WHERE id=? AND status='نشط'", [Number(b.activity_id)]);
    const a = actRes.rows[0];
    const memRes = await dbQuery("SELECT * FROM members WHERE student_id=? AND status='مقبول'", [String(b.student_id)]);
    const m = memRes.rows[0];
    
    if(!a) throw Error('اختر نشاطًا نشطًا'); 
    if(!m) throw Error('يمكن تسجيل نقاط للأعضاء المقبولين فقط'); 
    
    await dbQuery('INSERT INTO point_logs(student_id,activity_id,activity_name,logged_at,points,note) VALUES(?,?,?,?,?,?)', [m.student_id, a.id, a.name, b.logged_at || dateNow(), a.points, (b.note || '').trim()]);
    await dbQuery('UPDATE members SET points=points+? WHERE student_id=?', [a.points, m.student_id]);
    
    return send(res,201,{ok:true}); 
  }
  
  if (method==='DELETE' && p.startsWith('/api/admin/logs/')) { 
    const logId = Number(p.split('/').pop());
    const logRes = await dbQuery('SELECT * FROM point_logs WHERE id=?', [logId]);
    const log = logRes.rows[0];
    if(!log) throw Error('السجل غير موجود'); 
    
    await dbQuery('DELETE FROM point_logs WHERE id=?', [log.id]);
    await dbQuery('UPDATE members SET points=MAX(0,points-?) WHERE student_id=?', [log.points, log.student_id]);
    
    return send(res,200,{ok:true}); 
  }
  
  return send(res,404,{error:'غير موجود'});
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  if (parsedUrl.pathname.startsWith('/api/')) {
    try {
      await api(req, res, parsedUrl);
    } catch (e) {
      error(res, e);
    }
    return;
  }
  let filePath = path.join(ROOT, parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Access Denied'); }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(ROOT, 'index.html');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); return res.end('Server Error'); }
      const ext = path.extname(filePath);
      const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg' }[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
