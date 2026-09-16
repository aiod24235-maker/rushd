const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Roshd@2026';
const ROOT = __dirname;

// الاتصال بقاعدة بيانات Turso السحابية عبر متغيرات البيئة
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const sessions = new Map();

// تهيئة الجداول في السحابة
async function initDB() {
  await db.execute(`PRAGMA foreign_keys = ON;`);
  
  await db.execute(`
    CREATE TABLE IF NOT EXISTS members (
      student_id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL,
      committee TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  await db.execute(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      points INTEGER NOT NULL CHECK(points >= 0), status TEXT NOT NULL DEFAULT 'نشط'
    );
  `);
  
  await db.execute(`
    CREATE TABLE IF NOT EXISTS point_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT NOT NULL,
      activity_id INTEGER, activity_name TEXT NOT NULL, logged_at TEXT NOT NULL,
      points INTEGER NOT NULL, note TEXT,
      FOREIGN KEY(student_id) REFERENCES members(student_id) ON DELETE CASCADE,
      FOREIGN KEY(activity_id) REFERENCES activities(id) ON DELETE SET NULL
    );
  `);

  // التحقق من الأعمدة الإضافية وإضافتها إذا لم تكن موجودة
  const memberColumns = (await db.execute('PRAGMA table_info(members)')).rows.map(c => c.name);
  if (!memberColumns.includes('status')) await db.execute("ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'مقبول'");
  if (!memberColumns.includes('bio')) await db.execute("ALTER TABLE members ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
  if (!memberColumns.includes('skills')) await db.execute("ALTER TABLE members ADD COLUMN skills TEXT NOT NULL DEFAULT ''");

  // إضافة الأنشطة الافتراضية إذا كانت الجدول فارغاً
  const actCount = (await db.execute('SELECT COUNT(*) AS c FROM activities')).rows[0].c;
  if (Number(actCount) === 0) {
    const activities = [['اجتماع الفريق',5],['حضور ورشة',10],['المشاركة في فعالية',10],['تمثيل النادي في البوث',15],['تنظيم فعالية',15],['تنفيذ مهمة',10],['تقديم فكرة قابلة للتنفيذ',10],['تنفيذ مبادرة',25],['تصميم / تصوير / مونتاج',15],['قيادة مهمة',20]];
    for (const [name, points] of activities) {
      await db.execute({ sql: 'INSERT INTO activities (name, points, status) VALUES (?, ?, ?)', args: [name, points, 'نشط'] });
    }
  }

  // إضافة أعضاء افتراضيين إذا كان الجدول فارغاً
  const memCount = (await db.execute('SELECT COUNT(*) AS c FROM members')).rows[0].c;
  if (Number(memCount) === 0) {
    const members = [['441800001','سارة المطيري','0500000001','لجنة الإعلام',145],['441800002','عبدالعزيز العتيبي','0500000002','لجنة البرامج',128],['441800003','نورة الشمري','0500000003','لجنة العلاقات العامة',105],['441800004','محمد العنزي','0500000004','لجنة التنظيم',82],['441800005','الجوهرة القحطاني','0500000005','لجنة المحتوى',55],['441800006','فهد الدوسري','0500000006','لجنة التطوير',37]];
    for (const m of members) {
      await db.execute({ sql: 'INSERT INTO members (student_id,name,phone,committee,points) VALUES (?,?,?,?,?)', args: m });
    }
  }
}

// تشغيل تهيئة القاعدة عند بدء السيرفر
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
    const res = await db.execute({ sql: "SELECT COUNT(*) + 1 AS r FROM members WHERE status='mقبول' OR status='مقبول' AND points > ?", args: [m.points] });
    // للتأكد الدقيق من الرتبة بناءً على النقاط
    const exactRes = await db.execute({ sql: "SELECT COUNT(*) + 1 AS r FROM members WHERE status='مقبول' AND points > ?", args: [m.points] });
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
  
  if (method==='GET' && p==='/api/member') { 
    const id=url.searchParams.get('student_id'); 
    const mRes = await db.execute({ sql: 'SELECT student_id,name,committee,points,status,created_at FROM members WHERE student_id=?', args: [id] });
    const m = mRes.rows[0];
    if(!m) return send(res,404,{error:'لم نعثر على عضوية بهذا الرقم الجامعي'}); 
    if(m.status!=='مقبول') return send(res,403,{error:m.status==='قيد المراجعة'?'طلب عضويتك قيد المراجعة.':'تم رفض طلب العضوية.'}); 
    return send(res,200,{member: await enrich(m)}); 
  }
  
  if (method==='GET' && p==='/api/leaderboard') { 
    const rowsRaw = (await db.execute("SELECT student_id,name,committee,points,status FROM members WHERE status='مقبول' ORDER BY points DESC, name ASC")).rows; 
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
    await db.execute({
      sql: "INSERT INTO members(student_id,name,phone,committee,bio,skills,status,points) VALUES(?,?,?,?,?,?,'قيد المراجعة',0)",
      args: [String(b.student_id).trim(), b.name.trim(), b.phone.trim(), b.committee, b.bio?.trim()||'', b.skills?.trim()||'']
    });
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
    const membersRaw = (await db.execute('SELECT * FROM members ORDER BY points DESC, name ASC')).rows;
    const members = [];
    for (const m of membersRaw) {
      members.push(await enrich(m));
    }
    const accepted = members.filter(m => m.status === 'مقبول'); 
    const top = accepted[0] || null; 
    const totalRes = await db.execute("SELECT COALESCE(SUM(points),0) AS n FROM members WHERE status='مقبول'");
    const total = totalRes.rows[0].n;
    
    const counts = { مشارك:0, فعال:0, متميز:0, نخبة:0 }; 
    members.forEach(m => { 
      if(m.level.color==='green') counts.مشارك++; 
      else if(m.level.color==='blue') counts.فعال++; 
      else if(m.level.color==='purple') counts.متميز++; 
      else counts.نخبة++; 
    });
    
    const activitiesList = (await db.execute('SELECT * FROM activities ORDER BY id')).rows;
    const logsList = (await db.execute('SELECT l.*, m.name AS member_name FROM point_logs l JOIN members m ON m.student_id=l.student_id ORDER BY l.id DESC LIMIT 100')).rows;

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
    await db.execute({
      sql: "INSERT INTO members (student_id,name,phone,committee,points,status,bio,skills) VALUES (?,?,?,?,?,'مقبول',?,?)",
      args: [String(b.student_id).trim(), b.name.trim(), b.phone.trim(), b.committee.trim(), Number(b.points)||0, b.bio||'', b.skills||'']
    });
    return send(res,201,{ok:true}); 
  }
  
  if (method==='PUT' && p.startsWith('/api/admin/members/')) { 
    const id = decodeURIComponent(p.split('/').pop()); 
    await db.execute({
      sql: 'UPDATE members SET name=?,phone=?,committee=?,points=?,status=?,bio=?,skills=? WHERE student_id=?',
      args: [b.name.trim(), b.phone.trim(), b.committee.trim(), Number(b.points)||0, b.status||'قيد المراجعة', b.bio||'', b.skills||'', id]
    });
    return send(res,200,{ok:true}); 
  }
  
  if (method==='POST' && p.startsWith('/api/admin/members/') && p.endsWith('/status')) { 
    const id = decodeURIComponent(p.split('/').slice(-2)[0]); 
    if(!['مقبول','مرفوض','قيد المراجعة'].includes(b.status)) throw Error('حالة غير صالحة'); 
    await db.execute({ sql: 'UPDATE members SET status=? WHERE student_id=?', args: [b.status, id] });
    return send(res,200,{ok:true}); 
  }
  
  if (method==='DELETE' && p.startsWith('/api/admin/members/')) { 
    await db.execute({ sql: 'DELETE FROM members WHERE student_id=?', args: [decodeURIComponent(p.split('/').pop())] });
    return send(res,200,{ok:true}); 
  }
  
  if (method==='POST' && p==='/api/admin/activities') { 
    if(!b.name) throw Error('اسم النشاط مطلوب'); 
    await db.execute({ sql: 'INSERT INTO activities (name,points,status) VALUES (?,?,?)', args: [b.name.trim(), Number(b.points)||0, b.status||'نشط'] });
    return send(res,201,{ok:true}); 
  }
  
  if (method==='PUT' && p.startsWith('/api/admin/activities/')) { 
    await db.execute({ sql: 'UPDATE activities SET name=?,points=?,status=? WHERE id=?', args: [b.name.trim(), Number(b.points)||0, b.status, Number(p.split('/').pop())] });
    return send(res,200,{ok:true}); 
  }
  
  if (method==='DELETE' && p.startsWith('/api/admin/activities/')) { 
    await db.execute({ sql: 'DELETE FROM activities WHERE id=?', args: [Number(p.split('/').pop())] });
    return send(res,200,{ok:true}); 
  }
  
  if (method==='POST' && p==='/api/admin/logs') { 
    const actRes = await db.execute({ sql: "SELECT * FROM activities WHERE id=? AND status='نشط'", args: [Number(b.activity_id)] });
    const a = actRes.rows[0];
    const memRes = await db.execute({ sql: "SELECT * FROM members WHERE student_id=? AND status='مقبول'", args: [String(b.student_id)] });
    const m = memRes.rows[0];
    
    if(!a) throw Error('اختر نشاطًا نشطًا'); 
    if(!m) throw Error('يمكن تسجيل نقاط للأعضاء المقبولين فقط'); 
    
    await db.batch([
      { sql: 'INSERT INTO point_logs(student_id,activity_id,activity_name,logged_at,points,note) VALUES(?,?,?,?,?,?)', args: [m.student_id, a.id, a.name, b.logged_at || dateNow(), a.points, (b.note || '').trim()] },
      { sql: 'UPDATE members SET points=points+? WHERE student_id=?', args: [a.points, m.student_id] }
    ], 'write');
    
    return send(res,201,{ok:true}); 
  }
  
  if (method==='DELETE' && p.startsWith('/api/admin/logs/')) { 
    const logId = Number(p.split('/').pop());
    const logRes = await db.execute({ sql: 'SELECT * FROM point_logs WHERE id=?', args: [logId] });
    const log = logRes.rows[0];
    if(!log) throw Error('السجل غير موجود'); 
    
    await db.batch([
      { sql: 'DELETE FROM point_logs WHERE id=?', args: [log.id] },
      { sql: 'UPDATE members SET points=MAX(0,points-?) WHERE student_id=?', args: [log.points, log.student_id] }
    ], 'write');
    
    return send(res,200,{ok:true}); 
  }
  
  return send(res,404,{error:'غير موجود'});
}
