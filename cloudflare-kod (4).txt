// ================================================================
//  HODIM — server (Cloudflare Worker) · ko'p kompaniyali (SaaS) versiya
//  • Baza: Cloudflare D1 (Bindings → D1 → nomi: DB). Har bir kompaniya ma'lumoti alohida: c/<kompaniya>/...
//  • /db/c/<kompaniya>/... — ilova bazasi (har bir so'rov qoidalar bilan tekshiriladi)
//  • /owner — FAQAT EGASI uchun boshqaruv paneli (parol: Cloudflare'dagi OWNER_KEY)
//  • Har daqiqa: push-eslatmalar, Telegram hisobot, haftalik zaxira (har bir kompaniya uchun)
//  • /api/mark — kelish/ketish: GPS + Face ID + internetsiz belgilash, shubhalilar adminga
//  Maxfiy kalitlar (Cloudflare → Settings → Variables): VAPID_PRIVATE, TG_TOKEN, OWNER_KEY
// ================================================================
const TZ_OFFSET_MIN = 5 * 60;
const OFFSETS = [5, 1];
const APP_URL = 'https://coresani5-cloud.github.io/davomat/';
const VAPID_PUBLIC = 'BC5NthMD_-bMu8gCP1KMJXgCaSI_szJL2OPdFew2vqXA45X8LSH8X9ezy_09zAky7zv55O6d7Y2j8mXMny70Oio';
const VAPID_PUB_JWK = {"kty": "EC", "crv": "P-256", "x": "Lk22EwP_5sy7yAI_UowleAJpIj-zMkvY490V7Da-pcA", "y": "45X8LSH8X9ezy_09zAky7zv55O6d7Y2j8mXMny70Oio"};
const ALLOWED_ORIGINS = ['https://coresani5-cloud.github.io', 'http://localhost:8765'];
const WEEK = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];
const DAY = 86400000;
let ENV = {};

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const txt = (t, status = 200) => new Response(t, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...CORS } });
const html = (h) => new Response(h, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
async function body(req) { try { const t = await req.text(); return t ? JSON.parse(t) : {}; } catch (e) { return null; } }
const CID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const cidOf = v => { const c = String(v || 'main').toLowerCase(); return CID_RE.test(c) ? c : null; };

export default {
  async scheduled(event, env, ctx) { ENV = env; ctx.waitUntil((async () => { if (env.DB) { await dbInit(); await runAll(); } })()); },
  async fetch(req, env, ctx) {
    ENV = env;
    const url = new URL(req.url), p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (!env.DB) return txt('XATO: D1 baza ulanmagan (Settings → Bindings → D1, nomi: DB)', 503);
      await dbInit();
      if (p.startsWith('/db/')) return await dbApi(req, url);
      if (p === '/owner' || p === '/owner/') return html(OWNER_HTML);
      if (p.startsWith('/owner/api/')) return await ownerApi(req, url, p.slice(11));
      const q = url.searchParams;
      if (p === '/api/mark' && req.method === 'POST') return await markApi(req, ctx);
      if (p === '/api/cfg') return await cfgApi(url);
      if (p === '/api/billing') return await billingInfo(url);
      if (p === '/api/payreq' && req.method === 'POST') return await payRequest(req);
      if (p === '/join' || p === '/join/') return await joinPage(url);
      if (p === '/api/join' && req.method === 'POST') return await joinApi(req);
      if (p === '/api/log' && req.method === 'POST') return await clientLog(req);
      if (p === '/api/login' && req.method === 'POST') return await login(req);
      if (p === '/api/public') { const cid = cidOf(q.get('c')); const co = cid && await company(cid); return co ? json(await publicList(cid)) : json({ error: 'nocompany' }, 404); }
      if (p === '/api/bio/challenge') return json({ challenge: await makeChallenge() });
      if (p === '/api/bio/register' && req.method === 'POST') return await bioRegister(req);
      if (p === '/api/bio/login' && req.method === 'POST') return await bioLogin(req);
      if (p === '/api/push-test' && req.method === 'POST') return await pushTest(req, ctx);
      // Admin tugmalari (ilova ichidan, admin kaliti bilan)
      if (['/api/tg-setup', '/api/tg-now', '/api/backup-setup', '/api/backup-now'].includes(p)) {
        const cid = cidOf(q.get('c')), au = await authOf(q.get('auth'));
        if (!cid || !au || au.role !== 'admin' || (au.cid || 'main') !== cid) return txt('Ruxsat yo‘q — admin bo‘lib kiring', 401);
        if (p === '/api/tg-setup') return txt(await tgSetup(cid));
        if (p === '/api/tg-now') return txt(await tgReport(cid, true));
        if (p === '/api/backup-setup') return txt(await backupSetup(cid));
        return txt(await backupSend(cid, 'qo‘lda'));
      }
      // Eski manzillar (asosiy kompaniya uchun)
      if (p === '/tg-setup') return txt(await tgSetup('main'));
      if (p === '/tg-now') return txt(await tgReport('main', true));
      if (p === '/backup-setup') return txt(await backupSetup('main'));
      if (p === '/backup-now') return txt(await backupSend('main', 'qo‘lda'));
      if (!env.VAPID_PRIVATE) return txt('XATO: Cloudflare sozlamasida VAPID_PRIVATE kiritilmagan', 500);
      if (p === '/test') {
        const cid = cidOf(q.get('c')) || 'main';
        const all = (await dbGet(cid, '/hodim/push/subs')) || {};
        let n = 0, bad = 0;
        for (const [empId, subs] of Object.entries(all))
          for (const [key, s] of Object.entries(subs || {})) {
            const r = await sendPush(s.sub, { title: 'HODIM', body: '🔔 Sinov: eslatmalar ishlayapti!', type: 'test' });
            if (r === 404 || r === 410) await dbDel(cid, `/hodim/push/subs/${empId}/${key}`);
            else if (r >= 200 && r < 300) n++; else bad++;
          }
        return txt(`Yuborildi: ${n} ta telefonga` + (bad ? `\nXato: ${bad} ta telefonga yuborilmadi` : ''));
      }
      const r = await runAll();
      const cos = await companies();
      return txt('HODIM server ishlayapti ✅\n' + r + '\nBaza himoyasi: YOQILGAN 🔐 (Cloudflare D1)\nKompaniyalar: ' + cos.length +
        '\nTelegram: ' + (env.TG_TOKEN ? 'bot ulangan' : 'ulanmagan') + '\nEgasi paneli (/owner): ' + (env.OWNER_KEY ? 'yoqilgan' : 'OWNER_KEY kiritilmagan') + '\nHaftalik zaxira (asosiy): ' + await backupStatus('main'));
    } catch (e) {
      try { await logErr('server', 'server', String(e && e.stack || e).slice(0, 800), p); } catch (_) { }
      return json({ error: 'server', msg: String(e && e.message || e) }, 500);
    }
  }
};

// ---------------- Kompaniyalar (obuna) ----------------
const coCache = new Map();
async function company(cid, fresh) {
  const c = coCache.get(cid);
  if (!fresh && c && Date.now() - c.t < 20000) return c.v;
  const r = await ENV.DB.prepare('SELECT j FROM companies WHERE cid=?').bind(cid).first();
  const v = r ? JSON.parse(r.j) : null;
  coCache.set(cid, { t: Date.now(), v });
  return v;
}
async function saveCompany(co) {
  await ENV.DB.prepare('INSERT INTO companies(cid,j) VALUES(?,?) ON CONFLICT(cid) DO UPDATE SET j=excluded.j').bind(co.cid, JSON.stringify(co)).run();
  coCache.set(co.cid, { t: Date.now(), v: co });
}
async function companies() {
  const rs = await ENV.DB.prepare('SELECT j FROM companies').all();
  return rs.results.map(r => JSON.parse(r.j)).sort((a, b) => (a.created || 0) - (b.created || 0));
}
// Obuna holati: ok — ishlaydi; why — sabab; left — qolgan kun
function subState(co) {
  if (!co) return { ok: false, why: 'nocompany' };
  if (co.blocked) return { ok: false, why: 'blocked' };
  const now = Date.now(), until = Math.max(co.trialEnd || 0, co.paidUntil || 0);
  if (now > until) return { ok: false, why: 'expired', until };
  const trial = !(co.paidUntil > now);
  return { ok: true, until, trial, left: Math.ceil((until - now) / DAY) };
}
async function ownerContact() { const s = await metaGetJ('owner_settings'); return (s && s.contact) || ''; }
async function subDenied(cid) {
  const co = await company(cid), s = subState(co);
  if (s.ok) return null;
  const os = await metaGetJ('owner_settings') || {};
  return json({ ok: false, reason: 'sub', why: s.why, contact: await ownerContact(), company: co ? co.name : '', billing: true, ...payContacts(os) }, 402);
}

const PUSH_T = {
  uz: { forgot: 'CHIQISHNI UNUTDINGIZ!', forgotBody: 'Ish vaqti tugadi, lekin chiqish belgilanmagan. Ilovani ochib «CHIQISH» ni bosing.', in: 'KIRISH QILISHNI UNUTMANG!', out: 'CHIQISH QILISHNI UNUTMANG!', body: (m, t) => `${m} daqiqadan keyin ${t === 'in' ? 'ish boshlanadi' : 'ish tugaydi'}. Ilovani ochib belgilang.` },
  ru: { forgot: 'ВЫ ЗАБЫЛИ ОТМЕТИТЬ УХОД!', forgotBody: 'Рабочий день закончился, но уход не отмечен. Откройте приложение и нажмите «УХОД».', in: 'НЕ ЗАБУДЬТЕ ОТМЕТИТЬ ПРИХОД!', out: 'НЕ ЗАБУДЬТЕ ОТМЕТИТЬ УХОД!', body: (m, t) => `Через ${m} мин ${t === 'in' ? 'начало работы' : 'конец работы'}. Откройте приложение и отметьтесь.` },
  en: { forgot: 'YOU FORGOT TO CHECK OUT!', forgotBody: 'Your shift has ended but you have not checked out. Open the app and tap “CHECK OUT”.', in: 'DON’T FORGET TO CHECK IN!', out: 'DON’T FORGET TO CHECK OUT!', body: (m, t) => `Work ${t === 'in' ? 'starts' : 'ends'} in ${m} min. Open the app and check ${t === 'in' ? 'in' : 'out'}.` }
};
// ---------------- Vaqt yordamchilari ----------------
function nowT() {
  const t = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  return { date: t.toISOString().slice(0, 10), cur: t.getUTCHours() * 60 + t.getUTCMinutes(), dow: t.getUTCDay() };
}
function toMin(s) { const [h, m] = String(s || '00:00').split(':').map(Number); return h * 60 + m; }
function hm(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
function dayOff(P, empId, date, dow) {
  const sc = (P.sched || {})[empId] || {};
  if ((P.holidays || []).includes(date)) return 'bayram';
  if (((P.leaves || {})[empId] || []).some(([a, b]) => a <= date && date <= b)) return 'javob';
  if (Array.isArray(sc.off) ? sc.off.includes(dow) : dow === 0) return 'dam';
  return '';
}



// ---------------- Har daqiqa: barcha kompaniyalar ----------------
async function runAll() {
  const { date, cur } = nowT();
  const out = [], Ps = {};
  for (const co of await companies()) {
    if (!subState(co).ok) continue;
    try { const r = await run(co.cid); Ps[co.cid] = r.P; if (r.msg) out.push(co.cid + ': ' + r.msg); }
    catch (e) { out.push(co.cid + ': xato'); try { await logErr(co.cid, 'cron', String(e && e.stack || e).slice(0, 600), 'run'); } catch (_) { } }
  }
  // Kanalga «zaxira» deb yozilsa — o'sha kompaniyaga darhol zaxira yuboriladi
  if (ENV.TG_TOKEN && Object.values(Ps).some(P => P && P.backup && P.backup.chat)) { const c = await backupCommands(Ps); if (c) out.push(c); }
  // Kunda bir marta: eski o'zgarishlar jurnali va xatolar tozalanadi
  const last = await metaGet('cleanDay');
  if (last !== date && cur >= 2 * 60) {
    await metaSet('cleanDay', date);
    const cut = Date.now() - 3 * DAY;
    const mx = await ENV.DB.prepare('SELECT MAX(seq) AS m FROM changes WHERE t<?').bind(cut).first();
    if (mx && mx.m) { await ENV.DB.prepare('DELETE FROM changes WHERE seq<=?').bind(mx.m).run(); await metaSet('prunedSeq', mx.m); }
    await ENV.DB.prepare('DELETE FROM logs WHERE t<?').bind(Date.now() - 30 * DAY).run();
    await ENV.DB.prepare('DELETE FROM ev WHERE t<?').bind(Date.now() - 45 * DAY).run();
    await ENV.DB.prepare('DELETE FROM stat WHERE d<?').bind(new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10)).run();
  }
  // Kunda bir marta (21:00): egasiga Telegram'da umumiy hisobot
  if (ENV.TG_TOKEN && cur >= 21 * 60 && cur < 23 * 60 && (await metaGet('ownerDigest')) !== date) { await metaSet('ownerDigest', date); try { if (await ownerDigest()) out.push('egasiga hisobot'); } catch (e) { } }
  return `${date} ${hm(cur)} — ` + (out.join(' · ') || 'hammasi joyida');
}
async function pushDocs(cid) {
  const base = `c/${cid}/hodim/push/`;
  const rs = await ENV.DB.prepare('SELECT k, v FROM docs WHERE k>=? AND k<?').bind(base, base + '￿').all();
  const P = {};
  for (const r of rs.results) {
    const rel = r.k.slice(base.length).split('/'); let o = P;
    for (let i = 0; i < rel.length - 1; i++) o = o[rel[i]] = o[rel[i]] || {};
    o[rel[rel.length - 1]] = JSON.parse(r.v);
  }
  return P;
}
async function run(cid) {
  const { date, cur, dow } = nowT();
  const P = await pushDocs(cid);
  const subs = P.subs || {}, sched = P.sched || {}, status = P.status || {};
  const fired = (P.fired && P.fired[date]) || {};
  let sent = 0, changed = false;
  for (const [empId, devs] of Object.entries(subs)) {
    const sc0 = sched[empId] || { start: '08:00', end: '19:00' }, sc = (sc0.week && sc0.week[dow]) || sc0;
    const st = (status[empId] && status[empId].date === date) ? status[empId] : { in: false, out: false };
    const jobs = [];
    if (!st.in && !dayOff(P, empId, date, dow)) jobs.push(['in', toMin(sc.start)]);
    if (st.in && !st.out) jobs.push(['out', toMin(sc.end)]);
    // Ish tugaganidan 30 daqiqa o'tib ham chiqish belgilanmagan bo'lsa — bir marta eslatma
    if (st.in && !st.out && cur >= toMin(sc.end) + 30 && cur < toMin(sc.end) + 120 && !fired[`${empId}_forgot`]) {
      fired[`${empId}_forgot`] = true; changed = true;
      const L = PUSH_T[(P.lang || {})[empId]] || PUSH_T.uz;
      for (const [key, s] of Object.entries(devs || {})) {
        const r = await sendPush(s.sub, { title: '⚠️ ' + L.forgot, body: L.forgotBody, type: 'out' });
        if (r === 404 || r === 410) await dbDel(cid, `/hodim/push/subs/${empId}/${key}`); else sent++;
      }
    }
    for (const [type, at] of jobs) {
      if (cur >= at) continue;
      const due = OFFSETS.filter(o => cur >= at - o && !fired[`${empId}_${type}${o}`]);
      if (!due.length) continue;
      due.forEach(o => fired[`${empId}_${type}${o}`] = true); changed = true;
      const left = at - cur;
      for (const [key, s] of Object.entries(devs || {})) {
        const L = PUSH_T[(P.lang || {})[empId]] || PUSH_T.uz;
        const r = await sendPush(s.sub, { title: '⏰ ' + L[type], body: L.body(left, type), type });
        if (r === 404 || r === 410) await dbDel(cid, `/hodim/push/subs/${empId}/${key}`); else sent++;
      }
    }
  }
  let extra = '';
  if (ENV.TG_TOKEN && P.tgTime && P.tg && P.tg.chat && !fired.tg && cur >= toMin(P.tgTime) && cur < toMin(P.tgTime) + 30) {
    fired.tg = true; changed = true; extra += ' · telegram: ' + await tgReport(cid, false, P);
  }
  // Kunda bir marta: eski oylarning suratlari o'chiriladi (vaqt yozuvlari qoladi)
  if (!fired.ph && cur >= 3 * 60) {
    fired.ph = true; changed = true;
    const keep = Number(P.photoKeepDays) || 60, cutM = new Date(Date.now() + TZ_OFFSET_MIN * 60000 - keep * DAY).toISOString().slice(0, 7);
    await ENV.DB.prepare('DELETE FROM docs WHERE k>=? AND k<?').bind(`c/${cid}/hodim_photos/`, `c/${cid}/hodim_photos/${cutM}`).run();
    await ENV.DB.prepare('DELETE FROM docs WHERE k>=? AND k<?').bind(`c/${cid}/hodim_ck/`, `c/${cid}/hodim_ck/${cutM}`).run();
  }
  const B = P.backup || {};
  if (ENV.TG_TOKEN && B.chat && cur >= 4 * 60 && !fired.bk) {
    const diff = B.last ? Math.round((Date.parse(date) - Date.parse(B.last)) / DAY) : 99;
    if ((dow === 1 && diff >= 6) || diff >= 8) { fired.bk = true; changed = true; extra += ' · zaxira: ' + await backupSend(cid, 'haftalik'); }
  }
  if (changed) await dbPut(cid, '/hodim/push/fired', { [date]: fired });
  return { P, msg: sent || extra ? `yuborildi ${sent}${extra}` : '' };
}

// ---------------- Kirish ekrani uchun ochiq ro'yxat (faqat ism, lavozim, rasm) ----------------
async function publicList(cid) {
  const emps = (await dbGet(cid, '/hodim/employees')) || [], st = (await dbGet(cid, '/hodim/settings')) || {};
  const list = (Array.isArray(emps) ? emps : Object.values(emps)).filter(Boolean)
    .map(e => ({ id: e.id, name: e.name, role: e.role || '', photoV: e.photoV || 0 }));
  return { employees: list, settings: { company: st.company || '', hours: st.hours || '' } };
}
// ---------------- Bitta telefonga sinov eslatmasi (10 soniyadan keyin) ----------------
async function pushTest(req, ctx) {
  const b = await body(req); if (!b) return json({ ok: false }, 400);
  const cid = cidOf(b.c); if (!cid) return json({ ok: false }, 400);
  const all = (await dbGet(cid, '/hodim/push/subs')) || {};
  let sub = null;
  for (const devs of Object.values(all)) for (const s of Object.values(devs || {})) if (s && s.sub && s.sub.endpoint === b.endpoint) sub = s.sub;
  if (!sub) return json({ ok: false, reason: 'unknown' }, 400);
  const job = (async () => { await new Promise(r => setTimeout(r, 10000)); await sendPush(sub, { title: '⏰ KIRISH QILISHNI UNUTMANG!', body: 'Bu sinov xabari: tovush va titrash ishlayapti ✅', type: 'in' }); })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return json({ ok: true });
}

// ---------------- PIN tekshiruvi va kirish kaliti ----------------
async function checkPin(cid, role, id, pin) {
  pin = String(pin || '');
  if (!pin) return null;
  if (role === 'admin') {
    const a = await dbGet(cid, '/hodim_admin');
    if (a && a.pinHash) return (await sha256hex('hodim:' + pin)) === a.pinHash ? { uid: 'admin', role: 'admin', mustChange: false, name: 'Admin' } : null;
    return cid === 'main' && pin === '1234' ? { uid: 'admin', role: 'admin', mustChange: true } : null;
  }
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(id || ''))) return null;
  const emps = (await dbGet(cid, '/hodim/employees')) || [];
  const e = (Array.isArray(emps) ? emps : Object.values(emps)).find(x => x && x.id === id);
  if (!e) return null;
  const h = await dbGet(cid, '/hodim_pins/' + id);
  if (h) return (await sha256hex('hodim:' + id + ':' + pin.toUpperCase())) === h ? { uid: e.id, role: 'emp', mustChange: false, name: e.name } : null;
  return e.pin != null && String(e.pin).toUpperCase() === pin.toUpperCase() ? { uid: e.id, role: 'emp', mustChange: false, name: e.name } : null;
}
// ---- PIN'ni taxmin qilib topishdan himoya: 5 marta xato → 15 daqiqa blok; bitta tarmoqdan 30 xato → 30 daqiqa ----
const SEC_VER = 3, MAX_FAIL = 5, LOCK_MIN = 15, IP_MAX = 30, IP_LOCK_MIN = 30;
function failKey(role, id) { return '/hodim_sec/fail/' + (role === 'admin' ? 'admin' : 'e_' + String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)); }
async function ipKey(req) { return '/hodim_sec/ip/' + (await sha256hex('ip:' + (req.headers.get('CF-Connecting-IP') || 'x'))).slice(0, 24); }
async function lockLeft(cid, path) { const f = await dbGet(cid, path); return f && f.until && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; }
async function addFail(cid, path, max, mins) { const f = (await dbGet(cid, path)) || {}; const fresh = !f.t || Date.now() - f.t > mins * 60000; const n = (fresh ? 0 : (f.n || 0)) + 1; await dbPut(cid, path, { n, t: Date.now(), until: n >= max ? Date.now() + mins * 60000 : 0 }); return Math.max(0, max - n); }
async function guardedCheck(req, cid, role, id, pin) {
  const fk = failKey(role, id), ik = await ipKey(req);
  const wait = Math.max(await lockLeft(cid, fk), await lockLeft(cid, ik));
  if (wait) return { blocked: wait };
  const u = await checkPin(cid, role, id, pin);
  if (u) { await dbDel(cid, fk); return { u }; }
  const left = await addFail(cid, fk, MAX_FAIL, LOCK_MIN); await addFail(cid, ik, IP_MAX, IP_LOCK_MIN);
  return { left };
}
async function noteLogin(cid, role) {
  const co = await company(cid, true); if (!co) return;
  const { date } = nowT(); const st = co.stats = co.stats || {};
  st.last = Date.now(); if (role === 'admin') st.lastAdmin = Date.now();
  const L = st.logins = st.logins || {}; L[date] = (L[date] || 0) + 1;
  for (const d of Object.keys(L)) if (d < new Date(Date.now() - 31 * DAY).toISOString().slice(0, 10)) delete L[d];
  await saveCompany(co);
}
function subInfo(co) { const s = subState(co); return s.ok ? { left: s.left, trial: s.trial, until: s.until } : null; }
async function login(req) {
  const b = await body(req); if (!b) return json({ ok: false }, 400);
  const cid = cidOf(b.c); const co = cid && await company(cid);
  if (!co) return json({ ok: false, reason: 'nocompany', v: SEC_VER }, 404);
  const den = await subDenied(cid); if (den) return den;
  const role = b.role === 'admin' ? 'admin' : 'emp';
  const g = await guardedCheck(req, cid, role, b.id, b.pin);
  if (g.blocked) return json({ ok: false, blocked: g.blocked, v: SEC_VER }, 429);
  if (!g.u) return g.left === 0 ? json({ ok: false, blocked: LOCK_MIN, v: SEC_VER }, 429) : json({ ok: false, left: g.left, v: SEC_VER }, 401);
  const token = await mintToken(g.u.uid, g.u.role, cid);
  await noteLogin(cid, role);
  const cf = req.cf || {};
  await Promise.all([statInc(cid, 'login'), ev(cid, 'login', g.u.name || g.u.uid, (role === 'admin' ? 'Admin kirdi' : 'Xodim kirdi') + (cf.city ? ' · ' + cf.city : ''))]);
  return json({ ok: true, token, mustChange: g.u.mustChange, v: SEC_VER, secure: true, sub: subInfo(co), contact: await ownerContact() });
}

// ---------------- Barmoq izi (WebAuthn) ----------------
// Telefon barmoq izini tekshirib, raqamli imzo beradi. Server imzoni saqlangan ochiq kalit bilan tekshiradi.
function hmacKeyRaw() { return enc.encode(String(ENV.FB_SECRET || ENV.VAPID_PRIVATE || 'hodim').trim() + ':bio'); }
async function hmac16(data) {
  const k = await crypto.subtle.importKey('raw', hmacKeyRaw(), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)).slice(0, 16);
}
async function makeChallenge() {
  const ts = new Uint8Array(8); new DataView(ts.buffer).setBigUint64(0, BigInt(Date.now()));
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const body = cat(ts, rnd);
  return b64u.enc(cat(body, await hmac16(body)));
}
async function challengeValid(ch) {
  try {
    const raw = b64u.dec(ch); if (raw.length !== 32) return false;
    const body = raw.slice(0, 16), mac = raw.slice(16);
    const good = await hmac16(body); if (!good.every((x, i) => x === mac[i])) return false;
    const ts = Number(new DataView(body.buffer, body.byteOffset, 8).getBigUint64(0));
    return Date.now() - ts < 3 * 60 * 1000 && ts <= Date.now() + 60000;
  } catch (e) { return false; }
}

function derToRaw(der) { // ECDSA imzosi DER → r||s (64 bayt)
  let i = 2; if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const part = () => { i++; const len = der[i++]; let v = der.slice(i, i + len); i += len; while (v.length > 32 && v[0] === 0) v = v.slice(1); const o = new Uint8Array(32); o.set(v, 32 - v.length); return o; };
  const r = part(), s = part(); return cat(r, s);
}

async function sha256hex(t) { const h = await crypto.subtle.digest('SHA-256', enc.encode(t)); return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join(''); }

async function bioPath(credId) { return '/hodim_bio/' + (await sha256hex('cred:' + credId)).slice(0, 32); }
async function bioRegister(req) {
  const b = await body(req); if (!b) return json({ ok: false }, 400);
  const cid = cidOf(b.c); if (!cid || !(await company(cid))) return json({ ok: false }, 404);
  const den = await subDenied(cid); if (den) return den;
  const g = await guardedCheck(req, cid, b.role === 'admin' ? 'admin' : 'emp', b.id, b.pin);
  if (g.blocked) return json({ ok: false, blocked: g.blocked }, 429);
  const u = g.u; if (!u) return json({ ok: false }, 401);
  if (!b.credId || !b.spki || ![-7, -257].includes(Number(b.alg))) return json({ ok: false }, 400);
  await dbPut(cid, await bioPath(b.credId), { uid: u.uid, role: u.role, spki: b.spki, alg: Number(b.alg), t: Date.now() });
  return json({ ok: true });
}
async function bioLogin(req) {
  const b = await body(req); if (!b) return json({ ok: false }, 400);
  const cid = cidOf(b.c); const co = cid && await company(cid);
  if (!co) return json({ ok: false, reason: 'unknown' }, 401);
  const den = await subDenied(cid); if (den) return den;
  const rec = b.credId ? await dbGet(cid, await bioPath(b.credId)) : null;
  if (!rec) return json({ ok: false, reason: 'unknown' }, 401);
  let cd; try { cd = JSON.parse(new TextDecoder().decode(b64u.dec(b.clientDataJSON))); } catch (e) { return json({ ok: false }, 400); }
  if (cd.type !== 'webauthn.get' || !ALLOWED_ORIGINS.includes(cd.origin) || !(await challengeValid(cd.challenge))) return json({ ok: false, reason: 'challenge' }, 401);
  const ad = b64u.dec(b.authenticatorData);
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(new URL(cd.origin).hostname)));
  if (ad.length < 37 || !rpHash.every((x, i) => x === ad[i])) return json({ ok: false, reason: 'rp' }, 401);
  if (!(ad[32] & 0x01) || !(ad[32] & 0x04)) return json({ ok: false, reason: 'uv' }, 401);
  const signed = cat(ad, new Uint8Array(await crypto.subtle.digest('SHA-256', b64u.dec(b.clientDataJSON))));
  let ok = false;
  try {
    if (rec.alg === -7) {
      const key = await crypto.subtle.importKey('spki', b64u.dec(rec.spki), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(b64u.dec(b.signature)), signed);
    } else {
      const key = await crypto.subtle.importKey('spki', b64u.dec(rec.spki), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u.dec(b.signature), signed);
    }
  } catch (e) { ok = false; }
  if (!ok) return json({ ok: false, reason: 'sig' }, 401);
  let mustChange = false;
  if (rec.role === 'emp') {
    const emps = (await dbGet(cid, '/hodim/employees')) || [];
    if (!(Array.isArray(emps) ? emps : Object.values(emps)).some(x => x && x.id === rec.uid)) return json({ ok: false, reason: 'unknown' }, 401);
  } else { const a = await dbGet(cid, '/hodim_admin'); mustChange = !(a && a.pinHash); }
  const token = await mintToken(rec.uid, rec.role, cid);
  await noteLogin(cid, rec.role);
  return json({ ok: true, token, role: rec.role, id: rec.uid, mustChange, v: SEC_VER, secure: true, sub: subInfo(co), contact: await ownerContact() });
}

// ---------------- Telegram ----------------
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${ENV.TG_TOKEN.trim()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) });
  return r.json().catch(() => ({}));
}
// Ulash: admin botga kompaniya kodini yozadi (masalan «sanicore»), keyin ilovada «Ulash» ni bosadi
const hasCode = (t, cid) => String(t || '').toLowerCase().split(/[\s/]+/).includes(cid);
async function tgSetup(cid) {
  if (!ENV.TG_TOKEN) return "XATO: Cloudflare sozlamasida TG_TOKEN kiritilmagan";
  const u = await tg('getUpdates', {});
  if (!u.ok) return 'XATO: bot tokeni noto‘g‘ri';
  const msgs = (u.result || []).slice().reverse().filter(x => x.message && x.message.chat && x.message.chat.type === 'private');
  const hit = msgs.find(x => hasCode(x.message.text, cid)) || (cid === 'main' ? msgs[0] : null);
  if (!hit) return `Botga hali kod yozilmagan.\n\nTelegram’da botni oching va shu kodni yuboring:  ${cid}\nKeyin «Ulash» tugmasini qayta bosing.`;
  const chat = hit.message.chat;
  await dbPut(cid, '/hodim/push/tg', { chat: chat.id, name: chat.first_name || chat.title || '' });
  await tg('sendMessage', { chat_id: chat.id, text: '✅ HODIM ulandi! Har kuni belgilangan vaqtda shu yerga davomat hisoboti keladi.' });
  return `✅ Ulandi: ${chat.first_name || chat.title || chat.id}. Telegram'ga sinov xabari yuborildi.`;
}
async function tgReport(cid, manual, P) {
  if (!ENV.TG_TOKEN) return "Telegram ulanmagan (TG_TOKEN kiritilmagan)";
  P = P || await pushDocs(cid);
  if (!P.tg || !P.tg.chat) return 'Telegram ulanmagan: avval Kompaniya bo‘limida botni ulang';
  const { date, cur, dow } = nowT();
  const ok = [], late = [], absent = [], off = [], wait = [], left = [];
  for (const [id, sc0] of Object.entries(P.sched || {})) {
    const sc = { ...sc0, ...((sc0.week && sc0.week[dow]) || {}) };
    const st = (P.status || {})[id], name = sc.name || id;
    const came = st && st.date === date && st.in;
    if (came) {
      const lm = toMin(st.inTime) - toMin(sc.start), why = dayOff(P, id, date, dow);
      if (lm > 0 && !why) late.push(`${name} — ${st.inTime} (+${lm} daq)`); else ok.push(`${name} — ${st.inTime}`);
      if (st.out) left.push(`${name} — ${st.outTime}`);
    } else {
      const why = dayOff(P, id, date, dow);
      if (why) off.push(`${name} (${why})`);
      else if (cur < toMin(sc.start)) wait.push(name);
      else absent.push(name);
    }
  }
  const [y, m, d] = date.split('-');
  const sec = (t, a) => a.length ? `\n\n${t} (${a.length}):\n` + a.map(x => '• ' + esc(x)).join('\n') : '';
  const text = `📊 <b>${esc(P.company || 'HODIM')} — davomat</b>\n${d}.${m}.${y}, ${WEEK[dow]} · ${hm(cur)}` +
    sec('✅ Vaqtida keldi', ok) + sec('⏰ Kechikdi', late) + sec('❌ Kelmadi', absent) + sec('⏳ Hali vaqti bo‘lmagan', wait) + sec('🌴 Dam olish / javob', off) + sec('🏁 Ishdan ketgan', left);
  const r = await tg('sendMessage', { chat_id: P.tg.chat, text, parse_mode: 'HTML' });
  return r.ok ? '✅ Hisobot Telegram’ga yuborildi' : 'XATO: Telegram’ga yuborib bo‘lmadi';
}
// ---------------- Haftalik zaxira nusxa (yopiq Telegram kanal) ----------------
async function backupSetup(cid) {
  if (!ENV.TG_TOKEN) return "XATO: Cloudflare sozlamasida TG_TOKEN kiritilmagan (avval Telegram botini ulang)";
  const u = await tg('getUpdates', { allowed_updates: ['channel_post', 'my_chat_member', 'message'] });
  if (!u.ok) return 'XATO: bot tokeni noto‘g‘ri';
  const ups = (u.result || []).slice().reverse();
  let chat = null, any = null;
  for (const x of ups) {
    const c = (x.channel_post && x.channel_post.chat) || (x.my_chat_member && x.my_chat_member.chat);
    if (!c || c.type !== 'channel') continue;
    if (!any) any = c;
    if (x.channel_post && hasCode(x.channel_post.text, cid)) { chat = c; break; }
  }
  if (!chat && cid === 'main') chat = any;
  if (!chat) return `Kanal topilmadi.\n\n1) Botni kanalga ADMIN qilib qo‘shing (xabar yuborish huquqi bilan)\n2) Kanalga shu kodni yozing:  ${cid}\n3) Shu tugmani qayta bosing`;
  const old = (await dbGet(cid, '/hodim/push/backup')) || {};
  await dbPut(cid, '/hodim/push/backup', { ...old, chat: chat.id, title: chat.title || '' });
  const r = await backupSend(cid, 'birinchi');
  return `✅ Kanal ulandi: ${chat.title || chat.id}\n${r}\n\nEndi har dushanba soat 04:00 da shu kanalga zaxira fayl keladi.\nIstalgan payt kanalga «zaxira» deb yozsangiz — 1 daqiqa ichida fayllar keladi.`;
}
const BK_CMD = /^\s*\/?(zaxira|backup|excel|hisobot|fayl)\b/i;
async function backupCommands(Ps) {
  const u = await tg('getUpdates', { allowed_updates: ['channel_post', 'message', 'my_chat_member'], timeout: 0 });
  if (!u.ok || !u.result || !u.result.length) return '';
  const lastId = Number(await metaGet('tgupd')) || 0, ups = u.result.filter(x => x.update_id > lastId);
  const maxId = Math.max(lastId, ...u.result.map(x => x.update_id));
  const want = new Set();
  for (const x of ups) {
    const m = x.channel_post || x.message;
    if (!m || !m.text || !BK_CMD.test(m.text)) continue;
    for (const [cid, P] of Object.entries(Ps)) if (P && P.backup && String(P.backup.chat) === String(m.chat.id)) want.add(cid);
  }
  if (maxId !== lastId) await metaSet('tgupd', maxId);
  if (u.result.length > 80) await tg('getUpdates', { offset: u.result[u.result.length - 20].update_id, limit: 1, timeout: 0 });
  const out = [];
  for (const cid of want) out.push(cid + ' so‘rov: ' + await backupSend(cid, 'so‘rov bo‘yicha'));
  return out.join(' · ');
}
async function backupStatus(cid) {
  const B = (await dbGet(cid, '/hodim/push/backup')) || {};
  if (!B.chat) return 'ulanmagan';
  return `kanal «${B.title || B.chat}»` + (B.last ? `, oxirgisi ${B.last.split('-').reverse().join('.')}` : '');
}
// Kompaniyaning to'liq nusxasi (suratlarsiz)
async function tenantDump(cid) {
  const [H, AD, BIO, AV, PAY, PINS, FACE] = await Promise.all([dbGet(cid, '/hodim'), dbGet(cid, '/hodim_admin'), dbGet(cid, '/hodim_bio'), dbGet(cid, '/hodim_av'), dbGet(cid, '/hodim_pay'), dbGet(cid, '/hodim_pins'), dbGet(cid, '/hodim_face')]);
  if (H && H.push) { delete H.push.fired; delete H.push.status; }
  return { app: 'HODIM', version: 3, company: cid, created: new Date().toISOString(), date: nowT().date, hodim: H || {}, hodim_admin: AD || null, hodim_bio: BIO || null, hodim_av: AV || null, hodim_pay: PAY || null, hodim_pins: PINS || null, hodim_face: FACE || null };
}
async function backupSend(cid, kind) {
  if (!ENV.TG_TOKEN) return 'XATO: TG_TOKEN kiritilmagan';
  const B = (await dbGet(cid, '/hodim/push/backup')) || {};
  if (!B.chat) return 'Kanal ulanmagan: avval Kompaniya bo‘limida zaxira kanalini ulang';
  const dump = await tenantDump(cid), H = dump.hodim, PAY = dump.hodim_pay, date = dump.date;
  if (!H || !H.employees) return 'XATO: bazani o‘qib bo‘lmadi';
  const bodyTxt = JSON.stringify(dump);
  const emps = Object.values(H.employees || {}).filter(Boolean).map(e => (PAY && PAY[e.id] != null ? { ...e, salary: PAY[e.id] } : e));
  const from = new Date(Date.parse(date) - 7 * DAY).toISOString().slice(0, 10);
  const xl = buildReport(H, emps, from, date);
  let nRec = 0; for (const mon of Object.values(H.rec || {})) nRec += Object.keys(mon || {}).length;
  const d = date.split('-').reverse().join('.');
  const cap = `🗄 <b>${esc((H.settings && H.settings.company) || 'HODIM')} — ${kind} zaxira</b>\n${d}\n\n👥 Xodimlar: ${emps.length}\n📋 Davomat yozuvlari: ${nRec}\n💾 Hajmi: ${Math.max(1, Math.round(bodyTxt.length / 1024))} KB\n\nTiklash uchun shu .json faylni saqlab qo‘ying.`;
  const r1 = await sendDoc(B.chat, `hodim-${cid}-zaxira-${date}.json`, 'application/json', bodyTxt, cap);
  if (!r1.ok) return 'XATO: kanalga yuborib bo‘lmadi' + (r1.description ? ` (${r1.description})` : '') + ' — bot kanalda admin ekanini tekshiring';
  const f2 = from.split('-').reverse().join('.'), t2 = new Date(Date.parse(date) - DAY).toISOString().slice(0, 10).split('-').reverse().join('.');
  await sendDoc(B.chat, `davomat-${cid}-${date}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xl.bytes, `📊 <b>Excel hisobot</b> · ${f2} – ${t2}\n\n1) Haftalik davomat (${xl.weekRows} qator)\n2) Oy jamlanmasi\n3) Xodimlar`);
  const fresh = (await dbGet(cid, '/hodim/push/backup')) || B;
  await dbPut(cid, '/hodim/push/backup', (kind === 'haftalik' || kind === 'birinchi') ? { ...fresh, last: date } : { ...fresh, lastManual: date });
  return `✅ Zaxira yuborildi (${Math.max(1, Math.round(bodyTxt.length / 1024))} KB, ${nRec} ta yozuv)`;
}
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// ---- Hisobot ma'lumoti ----
function bkSched(H, e, ds) {
  const st = H.settings || {}, dw = new Date(ds + 'T12:00:00Z').getUTCDay();
  const w = (e.week && e.week[dw] && e.week[dw].start && e.week[dw].end && e.week[dw]) || (st.week && st.week[dw] && st.week[dw].start && st.week[dw].end && st.week[dw]);
  return w ? { start: w.start, end: w.end } : { start: e.workStart || st.workStart || '08:00', end: e.workEnd || st.workEnd || '19:00' };
}
function bkKind(H, e, ds) {
  const st = H.settings || {}, dw = new Date(ds + 'T12:00:00Z').getUTCDay();
  if ((st.holidays || []).some(h => h && h.date === ds)) return 'Bayram';
  if (Object.values(H.lv || {}).some(l => l && l.employeeId === e.id && l.status === 'approved' && l.from <= ds && ds <= l.to)) return 'Javob';
  const off = Array.isArray(e.offDays) ? e.offDays : (Array.isArray(st.offDays) ? st.offDays : []);
  return off.includes(dw) ? 'Dam olish' : '';
}
function buildReport(H, emps, from, to) {
  const recs = {}, first = {};
  for (const mon of Object.values(H.rec || {})) for (const r of Object.values(mon || {})) {
    if (!r || !r.date) continue; recs[r.employeeId + '|' + r.date] = r;
    if (r.inTime && (!first[r.employeeId] || r.date < first[r.employeeId])) first[r.employeeId] = r.date;
  }
  const day = (e, ds) => {
    const r = recs[e.id + '|' + ds], sc = bkSched(H, e, ds), k = bkKind(H, e, ds);
    if (!r || !r.inTime) { if (k) return k === 'Dam olish' ? null : { st: k }; if (!first[e.id] || ds < first[e.id]) return null; return { st: 'Kelmadi', sc }; }
    const late = k ? 0 : Math.max(0, toMin(r.inTime) - toMin(sc.start));
    const early = !k && r.outTime ? Math.max(0, toMin(sc.end) - toMin(r.outTime)) : 0;
    return { r, sc, late, early, st: k ? k + ' (ishladi)' : !r.outTime ? 'Chiqish yo‘q' : late > 0 ? 'Kechikdi' : 'Vaqtida' };
  };
  const dates = (a, b) => { const o = []; for (let t = Date.parse(a); t < Date.parse(b); t += 86400000) o.push(new Date(t).toISOString().slice(0, 10)); return o; };
  const fmtD = ds => ds.split('-').reverse().join('.');
  // 1) Haftalik davomat
  const W = [['Sana', 'Hafta kuni', 'Xodim', 'Belgilangan vaqt', 'Kelish', 'Ketish', 'Kechikish (daq)', 'Erta ketish (daq)', 'Holat']];
  for (const ds of dates(from, to)) for (const e of emps) {
    const x = day(e, ds); if (!x) continue;
    W.push([fmtD(ds), WEEK[new Date(ds + 'T12:00:00Z').getUTCDay()], e.name || e.id, x.sc ? `${x.sc.start}–${x.sc.end}` : '', x.r ? x.r.inTime || '' : '', x.r ? x.r.outTime || '' : '', x.r ? x.late : '', x.r ? x.early : '', x.st]);
  }
  // 2) Joriy oy jamlanmasi (oy boshidan kechagacha)
  const mStart = to.slice(0, 8) + '01', M = [['Xodim', 'Lavozim', 'Kelgan kun', 'Kelmagan kun', 'Kechikkan (marta)', 'Kechikish (daq)', 'Erta ketish (daq)', 'Chiqish yo‘q (marta)', 'Javob / bayram']];
  for (const e of emps) {
    let p = 0, a = 0, lc = 0, lm = 0, em = 0, no = 0, ot = 0;
    for (const ds of dates(mStart, to)) { const x = day(e, ds); if (!x) continue;
      if (x.r) { p++; if (x.late > 0) { lc++; lm += x.late; } em += x.early; if (!x.r.outTime) no++; } else if (x.st === 'Kelmadi') a++; else ot++; }
    M.push([e.name || e.id, e.role || '', p, a, lc, lm, em, no, ot]);
  }
  // 3) Xodimlar
  const st = H.settings || {}, CURS = { UZS: 'so‘m', RUB: '₽', USD: '$' }, X = [['Xodim', 'Lavozim', 'Ish vaqti', 'Dam olish kunlari', `Oylik (${CURS[st.currency] || 'so‘m'})`]];
  const WD = ['Ya', 'Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh'];
  for (const e of emps) { const off = Array.isArray(e.offDays) ? e.offDays : (Array.isArray(st.offDays) ? st.offDays : []);
    X.push([e.name || e.id, e.role || '', `${e.workStart || st.workStart || '08:00'}–${e.workEnd || st.workEnd || '19:00'}`, off.map(d => WD[d]).join(', ') || 'yo‘q', (parseFloat(String(e.salary || '').replace(/[^\d.]/g, '')) || '')]); }
  const bytes = xlsx([
    { name: 'Haftalik davomat', rows: W, widths: [12, 12, 24, 15, 9, 9, 15, 16, 15] },
    { name: 'Oy jamlanmasi', rows: M, widths: [24, 16, 12, 14, 17, 16, 17, 19, 15] },
    { name: 'Xodimlar', rows: X, widths: [24, 18, 14, 18, 15] }]);
  return { bytes, weekRows: W.length - 1 };
}
// ---- Kutubxonasiz .xlsx yaratish (ZIP, siqilmagan) ----
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(files) {
  const parts = [], cen = []; let off = 0;
  const u16 = v => [v & 255, (v >>> 8) & 255], u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  for (const [name, text] of files) {
    const nb = enc.encode(name), data = typeof text === 'string' ? enc.encode(text) : text, crc = crc32(data);
    const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0)];
    const lh = new Uint8Array([...u32(0x04034b50), ...common]);
    parts.push(lh, nb, data);
    cen.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), nb);
    off += lh.length + nb.length + data.length;
  }
  const cenLen = cen.reduce((n, x) => n + x.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cenLen), ...u32(off), ...u16(0)]);
  return cat(...parts, ...cen, end);
}
function xlsx(sheets) {
  const x = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const col = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const sheetXml = sh => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>` +
    sh.rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => { const ref = col(ci) + (ri + 1), s = ri === 0 ? ' s="1"' : '';
      return typeof v === 'number' ? `<c r="${ref}"${s}><v>${v}</v></c>` : v === '' || v == null ? '' : `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${x(v)}</t></is></c>`; }).join('') + '</row>').join('') +
    `</sheetData>${sh.rows.length > 1 ? `<autoFilter ref="A1:${col(sh.rows[0].length - 1)}${sh.rows.length}"/>` : ''}</worksheet>`;
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sh, i) => `<sheet name="${x(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${sheets.map((sh, i) => sh.rows.length > 1 ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${x(sh.name)}'!$A$1:$${col(sh.rows[0].length - 1)}$${sh.rows.length}</definedName></definedNames>` : '').join('').replace(/<\/definedNames><definedNames>/g, '')}</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2F6FE0"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...sheets.map((sh, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sh)])
  ];
  return zip(files);
}
async function sendDoc(chat, name, type, body, caption) {
  const fd = new FormData();
  fd.append('chat_id', String(chat));
  fd.append('document', new Blob([body], { type }), name);
  if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
  const r = await fetch(`https://api.telegram.org/bot${ENV.TG_TOKEN.trim()}/sendDocument`, { method: 'POST', body: fd });
  return r.json().catch(() => ({}));
}

// ---------------- Web Push (VAPID + aes128gcm) ----------------
const enc = new TextEncoder();
const b64u = {
  enc: b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
};
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function vapidJWT(aud) {
  const key = await crypto.subtle.importKey('jwk', { ...VAPID_PUB_JWK, d: String(ENV.VAPID_PRIVATE || '').trim() }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const h = b64u.enc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u.enc(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: APP_URL })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64u.enc(sig)}`;
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
async function encryptPayload(sub, data) {
  const uaPub = b64u.dec(sub.keys.p256dh), auth = b64u.dec(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, cat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, cat(enc.encode(data), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
async function sendPush(sub, msg) {
  try {
    const u = new URL(sub.endpoint);
    const body = await encryptPayload(sub, JSON.stringify(msg));
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { 'Authorization': `vapid t=${await vapidJWT(u.origin)}, k=${VAPID_PUBLIC}`, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'TTL': '600', 'Urgency': 'high' },
      body
    });
    return r.status;
  } catch (e) { return 0; }
}




// ================================================================
//  KELISH/KETISH TEKSHIRUVI: joylashuv (GPS), yuzni tanish (Face ID), internetsiz belgilash
//  Xodim belgisi har doim yoziladi; tekshiruvdan o'tmasa — «shubhali» deb belgilanadi va admin ko'rib chiqadi.
// ================================================================
const FLAG_TXT = {
  gps_none: 'joylashuv aniqlanmadi', gps_far: 'ish joyidan uzoqda', gps_acc: 'GPS aniqligi past', gps_mock: 'soxta GPS ehtimoli', ip_far: 'internet manzili boshqa shaharda',
  face_none: 'yuz tekshirilmadi', face_file: 'surat galereyadan/kameradan tashqari', face_spoof: 'soxta rasm ehtimoli (ekran yoki qog‘oz)', face_noblink: 'ko‘z qisilmadi (jonli emas bo‘lishi mumkin)',
  face_mismatch: 'yuz mos kelmadi (boshqa odam)', face_new: 'yuz namunasi birinchi marta olindi — tekshirib qo‘ying', off_time: 'internetsiz belgilandi — vaqtni tekshirib bo‘lmadi', old_app: 'eski ilova orqali (tekshiruvsiz)'
};
const flagTxt = f => (f || []).map(x => FLAG_TXT[x] || x).join(', ');
async function ev(cid, k, who, msg) {
  try { await ENV.DB.prepare('INSERT INTO ev(cid,t,k,who,msg) VALUES(?,?,?,?,?)').bind(cid, Date.now(), k, String(who || '').slice(0, 80), typeof msg === 'string' ? msg.slice(0, 600) : JSON.stringify(msg).slice(0, 1500)).run(); } catch (e) { }
}
async function statInc(cid, k, n) {
  try { await ENV.DB.prepare('INSERT INTO stat(cid,d,k,n) VALUES(?,?,?,?) ON CONFLICT(cid,d,k) DO UPDATE SET n=n+excluded.n').bind(cid, nowT().date, k, n || 1).run(); } catch (e) { }
}
const tokOk = (au, co) => !(co && co.revokeAt && au && au.iat && au.iat * 1000 < co.revokeAt);
async function chkOf(cid, co, S) {
  S = S || (await dbGet(cid, '/hodim/settings')) || {};
  const c = S.chk || {}, f = (co && co.feat) || {};
  return { face: c.face !== false && f.face !== false, gps: c.gps !== false && f.gps !== false, off: c.off !== false && f.offline !== false, tgSus: c.tgSus !== false };
}
function geoDist(a1, o1, a2, o2) {
  const R = 6371000, r = d => d * Math.PI / 180, dA = r(a2 - a1), dO = r(o2 - o1);
  const x = Math.sin(dA / 2) ** 2 + Math.cos(r(a1)) * Math.cos(r(a2)) * Math.sin(dO / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
async function locForSrv(cid, S, e) {
  const br = (Array.isArray(S.branches) ? S.branches : Object.values(S.branches || {})).find(b => b && e && b.id === e.branch && b.name);
  const ok = o => o && o.lat != null && o.lng != null && o.lat !== '' && o.lng !== '' && !isNaN(Number(o.lat)) && !isNaN(Number(o.lng));
  if (ok(br)) return { lat: Number(br.lat), lng: Number(br.lng), radius: Number(br.radius) || 150 };
  const L = await dbGet(cid, '/hodim/location');
  return ok(L) ? { lat: Number(L.lat), lng: Number(L.lng), radius: Number(L.radius) || 150 } : null;
}
// Human (faceres) kutubxonasidagi bilan bir xil o'xshashlik formulasi: 0..1, 0.5 dan yuqori — o'sha odam
function faceSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length < 64) return 0;
  let s = 0; for (let i = 0; i < a.length; i++) { const d = (Number(a[i]) || 0) - (Number(b[i]) || 0); s += d * d; }
  const dist = Math.round(100 * 25 * s) / 100; if (dist === 0) return 1;
  const norm = (1 - Math.sqrt(dist) / 100 - 0.2) / 0.6;
  return Math.round(100 * Math.max(Math.min(norm, 1), 0)) / 100;
}
const FACE_OK = 0.5;
const cleanEmb = v => Array.isArray(v) && v.length >= 64 && v.length <= 2048 && v.every(x => typeof x === 'number' && isFinite(x)) ? v.map(x => Math.round(x * 1e5) / 1e5) : null;
const isJpeg = p => typeof p === 'string' && /^data:image\/(jpeg|webp|png);base64,/.test(p) && p.length < 450000;

async function markApi(req, ctx) {
  const b = await body(req); if (!b) return json({ ok: false, msg: 'bad' }, 400);
  const cid = cidOf(b.c), au = await authOf(b.auth);
  if (!cid || !au || au.cid !== cid || au.role !== 'emp') return json({ ok: false, auth: true, msg: 'Qayta kiring' }, 401);
  const co = await company(cid); if (!co) return json({ ok: false, msg: 'nocompany' }, 404);
  if (!tokOk(au, co)) return json({ ok: false, auth: true, msg: 'Qayta kiring' }, 401);
  const den = await subDenied(cid); if (den) return den;
  const a = b.a === 'out' ? 'out' : 'in', idRe = /^[A-Za-z0-9_-]{2,48}$/;
  if (!idRe.test(String(b.rid || '')) || !idRe.test(String(b.mid || ''))) return json({ ok: false, drop: true, msg: 'Noto‘g‘ri so‘rov' }, 400);
  const uid = au.uid, now = Date.now();
  // ---- Vaqt: server vaqti. Internetsiz belgilanganda — telefon belgilagan paytdan qancha vaqt o'tgani bo'yicha ----
  const devT = Number(b.devT) || 0, sendT = Number(b.sendT) || 0;
  let el = (devT && sendT && sendT >= devT) ? sendT - devT : 0, off = false, tv = true;
  if (el > 120000) {
    off = true;
    if (el > 48 * 3600000) return json({ ok: false, drop: true, msg: 'Bu belgi 48 soatdan eski — qabul qilinmadi. Adminga murojaat qiling.' });
    const pm = Number(b.pm), pn = Number(b.pn);
    tv = b.pn != null && b.pm != null && isFinite(pm) && isFinite(pn) && pn >= pm && Math.abs(el - (pn - pm)) <= 120000;
  }
  const TM = now - el, lt = new Date(TM + TZ_OFFSET_MIN * 60000), date = lt.toISOString().slice(0, 10), tm = hm(lt.getUTCHours() * 60 + lt.getUTCMinutes());
  const S = (await dbGet(cid, '/hodim/settings')) || {}, chk = await chkOf(cid, co, S);
  const emps = empList(await dbGet(cid, '/hodim/employees')), E = emps.find(x => x.id === uid);
  if (!E) return json({ ok: false, drop: true, msg: 'Xodim topilmadi' }, 404);
  // ---- Yozuv ----
  let m, rec;
  if (a === 'in') {
    m = date.slice(0, 7);
    rec = await sGet(T(cid, `hodim/rec/${m}/${b.rid}`));
    if (rec) {
      if (rec.employeeId !== uid) return json({ ok: false, drop: true, msg: 'Ruxsat yo‘q' }, 403);
      if ((rec.mk || {}).in === b.mid) return json({ ok: true, rec, dup: true });
      return json({ ok: false, drop: true, msg: 'Bu yozuv allaqachon bor' });
    }
    rec = { id: b.rid, employeeId: uid, date, inTime: tm, outTime: '' };
  } else {
    const rd = /^\d{4}-\d{2}-\d{2}$/.test(String(b.rdate || '')) ? b.rdate : date;
    m = rd.slice(0, 7);
    rec = await sGet(T(cid, `hodim/rec/${m}/${b.rid}`));
    if (!rec || rec.employeeId !== uid) return json({ ok: false, drop: true, msg: 'Kelish yozuvi topilmadi — admin bilan bog‘laning' });
    if (rec.outTime) { if ((rec.mk || {}).out === b.mid) return json({ ok: true, rec, dup: true }); return json({ ok: false, drop: true, msg: 'Ketish allaqachon belgilangan' }); }
    if (TM - Date.parse(rec.date + 'T00:00:00+05:00') > 2 * DAY) return json({ ok: false, drop: true, msg: 'Kelish yozuvi juda eski — admin to‘g‘rilaydi' });
    rec = { ...rec, outTime: tm };
  }
  // ---- Tekshiruvlar ----
  const F = [], ck = { t: TM, tm, off: off ? 1 : 0, tv: tv ? 1 : 0, at: now };
  const cf = req.cf || {}; ck.ip = [cf.city, cf.country].filter(Boolean).join(', ');
  const g = b.gps && typeof b.gps === 'object' ? b.gps : null;
  if (chk.gps) {
    const loc = await locForSrv(cid, S, E);
    if (loc) {
      ck.rad = loc.radius;
      if (!g || g.e || !isFinite(Number(g.lat)) || !isFinite(Number(g.lng))) { F.push('gps_none'); if (g && g.e) ck.ge = String(g.e).slice(0, 40); }
      else {
        const lat = Number(g.lat), lng = Number(g.lng), acc = Math.round(Number(g.acc) || 0), dist = Math.round(geoDist(lat, lng, loc.lat, loc.lng));
        Object.assign(ck, { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, acc, dist, n: Number(g.n) || 1, sp: Math.round(Number(g.sp) || 0) });
        if (dist > loc.radius + Math.min(acc, 100)) F.push('gps_far');
        if (acc > 150) F.push('gps_acc');
        if ((Number(g.n) || 0) >= 3 && !Number(g.sp) && acc > 0 && acc <= 3) F.push('gps_mock');
        if (g.mock) F.push('gps_mock');
        const cl = Number(cf.latitude), co2 = Number(cf.longitude);
        if (!off && isFinite(cl) && isFinite(co2) && cf.latitude && geoDist(lat, lng, cl, co2) > 600000) { F.push('ip_far'); }
      }
    }
  }
  const f = b.face && typeof b.face === 'object' ? b.face : null;
  let enrolled = false;
  if (chk.face) {
    const emb = f && cleanEmb(f.emb);
    if (!f || f.e || !emb) { F.push(f && f.file ? 'face_file' : 'face_none'); if (f && f.e) ck.fe = String(f.e).slice(0, 40); }
    else {
      const fl0 = F.length;
      if (f.file) F.push('face_file');
      ck.real = Math.round((Number(f.real) || 0) * 100) / 100; ck.live = Math.round((Number(f.live) || 0) * 100) / 100; ck.bl = f.blink ? 1 : 0;
      if ((f.real != null && Number(f.real) < 0.5) || (f.live != null && Number(f.live) < 0.5)) F.push('face_spoof');
      if (!f.blink && !f.file) F.push('face_noblink');
      const ref = await dbGet(cid, '/hodim_face/' + uid);
      if (ref && Array.isArray(ref.emb)) {
        const sim = faceSim(emb, ref.emb); ck.fs = sim;
        if (sim < FACE_OK) F.push('face_mismatch');
      } else if (!F.includes('face_spoof') && !f.file) {
        await dbPut(cid, '/hodim_face/' + uid, { emb, t: now, by: 'self', rid: b.rid, a });
        if (isJpeg(b.photo)) await dbPut(cid, '/hodim_face_ph/' + uid, b.photo);
        F.push('face_new'); ck.enr = 1; enrolled = true;
      } else F.push('face_new');
    }
  }
  if (off && !tv) F.push('off_time');
  ck.f = F;
  const sus = F.length > 0;
  rec.sus = { ...(rec.sus || {}) }; if (sus) rec.sus[a] = 1; else delete rec.sus[a]; if (!Object.keys(rec.sus).length) delete rec.sus;
  if (off) rec.off = { ...(rec.off || {}), [a]: 1 };
  rec.mk = { ...(rec.mk || {}), [a]: b.mid };
  if (rec.rv) { rec.rv = { ...rec.rv }; delete rec.rv[a]; if (!Object.keys(rec.rv).length) delete rec.rv; }
  await sSet(T(cid, `hodim/rec/${m}/${b.rid}`), rec);
  await sSet(T(cid, `hodim_ck/${m}/${b.rid}/${a}`), ck);
  if (isJpeg(b.photo)) await sSet(T(cid, `hodim_photos/${m}/${b.rid}/${a}`), b.photo);
  await logChanges(cid, [`hodim/rec/${m}/${b.rid}`]);
  // ---- Hisoblagichlar, voqealar, ogohlantirish ----
  const jobs = [];
  if (a === 'in') jobs.push(statInc(cid, 'in'));
  if (sus) jobs.push(statInc(cid, 'sus'));
  if (off) jobs.push(statInc(cid, 'off'));
  jobs.push(ev(cid, sus ? 'sus' : 'mark', E.name || uid, { a, tm, date, f: F, rid: b.rid, m, eid: uid, off: off ? 1 : 0, dist: ck.dist, fs: ck.fs }));
  await Promise.all(jobs);
  if (sus && chk.tgSus && ENV.TG_TOKEN && !(F.length === 1 && F[0] === 'face_new')) {
    const P = await dbGet(cid, '/hodim/push/tg');
    if (P && P.chat) {
      const t = `⚠️ <b>Shubhali belgi</b>\n${esc(E.name || uid)} — ${a === 'in' ? 'kelish' : 'ketish'} ${tm}${off ? ' (internetsiz)' : ''}\nSabab: ${esc(flagTxt(F))}${ck.dist != null ? `\nMasofa: ${ck.dist} m` : ''}\n\nIlovada: Admin → 🛡 Nazorat bo‘limida ko‘rib chiqing.`;
      const job = tg('sendMessage', { chat_id: P.chat, text: t, parse_mode: 'HTML' }).catch(() => { });
      if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    }
  }
  return json({ ok: true, rec, flags: F, enrolled, off, tv });
}

// Ilova sozlamalari: egasi ruxsat bergan funksiyalar, e'lonlar, server vaqti
async function cfgApi(url) {
  const q = url.searchParams, cid = cidOf(q.get('c')), au = await authOf(q.get('auth'));
  const co = cid && await company(cid); if (!co) return json({ ok: false }, 404);
  const out = { ok: true, now: Date.now(), feat: { face: (co.feat || {}).face !== false, gps: (co.feat || {}).gps !== false, offline: (co.feat || {}).offline !== false } };
  if (au && au.cid === cid && tokOk(au, co)) {
    const g = await metaGetJ('owner_msg'), msg = co.msg;
    const fit = x => x && x.text && (x.to !== 'admin' || au.role === 'admin') && (!x.until || x.until > Date.now());
    if (fit(msg)) out.msg = msg; if (fit(g)) out.gmsg = g;
    if (au.role === 'admin') { const os = await ownerSettings(); const R = co.refs || []; out.ref = { days: Number(os.refDays ?? 15) || 0, n: R.filter(r => r.st !== 'wait').length, wait: R.filter(r => r.st === 'wait').map(r => r.name).slice(0, 10), earned: R.reduce((x, r) => x + (r.days || 0), 0), code: cid, ...payContacts(os) }; }
    if (au.role === 'emp') { const r = await ENV.DB.prepare('SELECT 1 AS x FROM docs WHERE k=?').bind(`c/${cid}/hodim_face/${au.uid}`).first(); out.faceRef = !!r; }
  } else if (au) out.auth = false;
  return json(out);
}

// ---------------- Egasiga Telegram ogohlantirishlari ----------------
async function tgOwner(text) {
  if (!ENV.TG_TOKEN) return false;
  const o = await metaGetJ('owner_tg'); if (!o || !o.chat) return false;
  const r = await tg('sendMessage', { chat_id: o.chat, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => ({}));
  return !!(r && r.ok);
}
async function ownerDigest() {
  const { date } = nowT();
  const cos = await companies(), st = await ENV.DB.prepare('SELECT cid,k,n FROM stat WHERE d=?').bind(date).all();
  const S = {}; for (const r of st.results) (S[r.cid] = S[r.cid] || {})[r.k] = r.n;
  const errs = await ENV.DB.prepare('SELECT cid, COUNT(*) AS n FROM logs WHERE t>? GROUP BY cid').bind(Date.now() - DAY).all();
  const E = Object.fromEntries(errs.results.map(r => [r.cid, r.n]));
  const lines = [], soon = [];
  for (const co of cos) {
    const s = subState(co), x = S[co.cid] || {};
    lines.push(`• <b>${esc(co.name)}</b>: keldi ${x.in || 0}${x.sus ? ` · ⚠️ shubhali ${x.sus}` : ''}${x.off ? ` · 📴 ${x.off}` : ''}${E[co.cid] ? ` · 🐞 xato ${E[co.cid]}` : ''}${!s.ok ? ' · ⛔ to‘xtagan' : ''}`);
    if (co.cid !== 'main' && s.ok && s.left <= 3) soon.push(`• ${esc(co.name)} — ${s.left} kun qoldi${s.trial ? ' (sinov)' : ''}${co.phone ? ' · ' + esc(co.phone) : ''}`);
  }
  const [y, m, d] = date.split('-');
  return tgOwner(`📊 <b>HODIM — kunlik hisobot</b> (${d}.${m}.${y})\n\n${lines.join('\n') || 'Kompaniya yo‘q'}` + (soon.length ? `\n\n⏳ <b>Obunasi tugayapti:</b>\n${soon.join('\n')}` : '') + (E.server ? `\n\n🐞 Server xatolari: ${E.server}` : ''));
}
async function ownerTgLink(check) {
  if (!ENV.TG_TOKEN) return { ok: false, msg: 'TG_TOKEN kiritilmagan' };
  if (!check) { const code = 'egasi-' + randPin(); await metaSet('owner_tgcode', code); return { ok: true, code }; }
  const code = await metaGet('owner_tgcode'); if (!code) return { ok: false, msg: 'Avval kod oling' };
  const u = await tg('getUpdates', {}); if (!u.ok) return { ok: false, msg: 'Bot tokeni noto‘g‘ri' };
  const hit = (u.result || []).slice().reverse().find(x => x.message && x.message.chat && x.message.chat.type === 'private' && String(x.message.text || '').toLowerCase().includes(code));
  if (!hit) return { ok: false, msg: `Botga hali kod yuborilmagan. Telegram’da botga shu kodni yozing: ${code}` };
  await metaSet('owner_tg', JSON.stringify({ chat: hit.message.chat.id, name: hit.message.chat.first_name || '' }));
  await tgOwner('✅ HODIM egasi paneli ulandi. Endi har kuni soat 21:00 da hisobot, panelga kirilganda esa ogohlantirish keladi.');
  return { ok: true, msg: '✅ Ulandi: ' + (hit.message.chat.first_name || hit.message.chat.id) };
}



// ================================================================
//  OBUNA TO'LOVI: mijoz egasining kartasiga o'tkazadi → chek rasmini yuboradi → egasi tasdiqlaydi → obuna uzayadi
//  (Payme/Octobank shartnomasi bo'lgach — shu yerga avtomatik karta to'lovi qo'shiladi)
// ================================================================
const PAY_MONTHS = [1, 3, 6, 12];
async function ownerSettings() { return (await metaGetJ('owner_settings')) || { contact: '', trialDays: 7, price: 120000, cur: 'UZS', maxEmp: 10 }; }
function payContacts(s) {
  const phones = String(s.phones || '').split(/[,;\n]+/).map(x => x.trim()).filter(Boolean).slice(0, 4);
  return { phones, tg: String(s.tg || '').replace(/^@/, '').trim(), contact: s.contact || '' };
}
const CARD_TYPES = ['humo', 'uzcard', 'mir', 'sbp', 'kaspi', 'visa', 'mastercard', 'other'];
const CURS = ['UZS', 'RUB', 'USD', 'KZT', 'EUR'];
function cleanCards(list) {
  return (Array.isArray(list) ? list : []).slice(0, 10).map((c, i) => ({
    id: String(c.id || ('k' + Date.now().toString(36) + i)).replace(/[^\w-]/g, '').slice(0, 20),
    type: CARD_TYPES.includes(c.type) ? c.type : 'other', number: String(c.number || '').replace(/[^\d+ ]/g, '').trim().slice(0, 32),
    holder: String(c.holder || '').slice(0, 60), bank: String(c.bank || '').slice(0, 60), cur: CURS.includes(c.cur) ? c.cur : 'UZS', note: String(c.note || '').slice(0, 120), off: !!c.off
  })).filter(c => c.number);
}
function cardsOf(s) {
  if (Array.isArray(s.payCards)) return s.payCards;
  if (s.payCard) return [{ id: 'k1', type: /uzcard/i.test(s.payType || '') ? 'uzcard' : /visa/i.test(s.payType || '') ? 'visa' : /master/i.test(s.payType || '') ? 'mastercard' : 'humo', number: s.payCard, holder: s.payHolder || '', bank: '', cur: 'UZS', note: '' }];
  return [];
}
async function billingInfo(url) {
  const cid = cidOf(url.searchParams.get('c')); const co = cid && await company(cid, true);
  if (!co) return json({ ok: false, msg: 'Kompaniya topilmadi' }, 404);
  const s = await ownerSettings();
  const last = await ENV.DB.prepare('SELECT id,t,months,amount,cur,st,why FROM pay WHERE cid=? ORDER BY id DESC LIMIT 1').bind(cid).first();
  return json({ ok: true, company: co.name, price: co.price || 0, cur: co.cur || 'UZS', maxEmp: co.maxEmp || 0, sub: subState(co), until: Math.max(co.trialEnd || 0, co.paidUntil || 0),
    cards: cardsOf(s).filter(c => !c.off), months: PAY_MONTHS, ...payContacts(s), last: last || null });
}
async function payRequest(req) {
  const b = await body(req); if (!b) return json({ ok: false, msg: 'Xato so‘rov' }, 400);
  const cid = cidOf(b.c); const co = cid && await company(cid, true);
  if (!co) return json({ ok: false, msg: 'Kompaniya topilmadi' }, 404);
  // Faqat kompaniya admini yubora oladi: kirgan bo'lsa — kaliti, kirmagan bo'lsa — admin PIN
  const au = await authOf(b.auth);
  if (!(au && au.role === 'admin' && au.cid === cid && tokOk(au, co))) {
    const g = await guardedCheck(req, cid, 'admin', 'admin', b.pin);
    if (g.blocked) return json({ ok: false, msg: `Ko‘p xato urinish. ${g.blocked} daqiqadan keyin urinib ko‘ring.` });
    if (!g.u) return json({ ok: false, pin: true, msg: 'Admin PIN noto‘g‘ri' + (g.left ? ` (yana ${g.left} ta urinish)` : '') });
  }
  const months = PAY_MONTHS.includes(Number(b.months)) ? Number(b.months) : 1;
  const ph = typeof b.ph === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(b.ph) && b.ph.length < 900000 ? b.ph : '';
  if (!ph) return json({ ok: false, msg: 'Chek (to‘lov) rasmini yuklang' });
  const card = cardsOf(await ownerSettings()).find(c => c.id === b.card);
  const amount = (co.price || 0) * months, phone = String(b.phone || '').slice(0, 40);
  const note = ((card ? `[${card.type.toUpperCase()} •${card.number.replace(/\D/g, '').slice(-4)}] ` : '') + String(b.note || '')).slice(0, 300);
  await ENV.DB.prepare("UPDATE pay SET st='old' WHERE cid=? AND st='wait'").bind(cid).run();
  const r = await ENV.DB.prepare("INSERT INTO pay(cid,t,months,amount,cur,note,phone,ph,st) VALUES(?,?,?,?,?,?,?,?,'wait')").bind(cid, Date.now(), months, amount, co.cur || 'UZS', note, phone, ph).run();
  const id = r.meta && r.meta.last_row_id;
  await ev(cid, 'pay', 'admin', `💳 To‘lov cheki yuborildi: ${months} oy · ${amount} ${co.cur || 'UZS'}`);
  try {
    const o = await metaGetJ('owner_tg');
    if (ENV.TG_TOKEN && o && o.chat) {
      const m = ph.match(/^data:(image\/\w+);base64,(.*)$/), bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
      await sendDoc(o.chat, `chek-${cid}-${id}.${m[1].split('/')[1].replace('jpeg', 'jpg')}`, m[1], bytes,
        `💳 <b>Yangi to‘lov</b>\n${esc(co.name)} (${cid})\n${months} oy · ${amount.toLocaleString('ru-RU')} ${co.cur || 'UZS'}${phone ? '\n📞 ' + esc(phone) : ''}${note ? '\n📝 ' + esc(note) : ''}\n\nTasdiqlash: egasi paneli → 💳 To‘lovlar`);
    }
  } catch (e) { }
  return json({ ok: true, id });
}
async function ownerPayDecide(b) {
  const p = await ENV.DB.prepare('SELECT * FROM pay WHERE id=?').bind(Number(b.id) || 0).first();
  if (!p) return { ok: false, msg: 'Topilmadi' };
  if (p.st !== 'wait') return { ok: false, msg: 'Bu so‘rov allaqachon ko‘rib chiqilgan' };
  const co = await company(p.cid, true); if (!co) return { ok: false, msg: 'Kompaniya o‘chirilgan' };
  if (!b.ok) {
    const why = String(b.why || '').slice(0, 200);
    await ENV.DB.prepare("UPDATE pay SET st='no', why=?, done=? WHERE id=?").bind(why, Date.now(), p.id).run();
    await ev(p.cid, 'owner', 'egasi', '❌ To‘lov rad etildi' + (why ? ': ' + why : ''));
    return { ok: true };
  }
  const months = Number(b.months) || p.months, amount = b.amount != null && b.amount !== '' ? Number(b.amount) || 0 : p.amount;
  const base = Math.max(Date.now(), co.paidUntil || 0, co.trialEnd || 0), until = new Date(base); until.setMonth(until.getMonth() + months);
  co.paidUntil = until.getTime(); co.blocked = false;
  (co.payments = co.payments || []).unshift({ t: Date.now(), months, amount, cur: co.cur, until: co.paidUntil, via: 'chek' });
  co.payments = co.payments.slice(0, 60);
  await saveCompany(co);
  await ENV.DB.prepare("UPDATE pay SET st='ok', months=?, amount=?, done=? WHERE id=?").bind(months, amount, Date.now(), p.id).run();
  await ev(p.cid, 'owner', 'egasi', `✅ To‘lov tasdiqlandi: ${months} oy · ${amount} ${co.cur} → ${new Date(co.paidUntil + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10)} gacha`);
  const refG = await refOnPaid(co, amount);
  return { ok: true, co, ref: refG };
}
// ---------------- Taklif bonusi: kompaniya boshqasini olib kelsa — bepul kunlar ----------------
function addDays(co, days) {
  const now = Date.now();
  if ((co.paidUntil || 0) >= (co.trialEnd || 0) && (co.paidUntil || 0) > now) co.paidUntil += days * DAY;
  else if ((co.trialEnd || 0) > now) co.trialEnd += days * DAY;
  else co.paidUntil = now + days * DAY;
}
// Yangi kompaniya taklif bilan ulandi — bonus HALI berilmaydi, faqat birinchi to'lovdan keyin
async function refRegister(refCid, newCo) {
  const ref = await company(refCid, true); if (!ref || ref.cid === newCo.cid) return null;
  const days = Math.max(0, Number((await ownerSettings()).refDays ?? 15) || 0);
  (ref.refs = ref.refs || []).unshift({ cid: newCo.cid, name: newCo.name, t: Date.now(), days: 0, st: 'wait' }); ref.refs = ref.refs.slice(0, 100);
  if (days) ref.msg = { text: `🎁 «${newCo.name}» kompaniyasi sizning taklifingiz bilan HODIM'ga ulandi. U birinchi obuna to‘lovini qilgach, sizga ${days} kun bepul qo‘shiladi.`, k: 'refw', n: newCo.name, d: days, to: 'admin', t: Date.now(), until: Date.now() + 14 * DAY };
  await saveCompany(ref);
  await ev(refCid, 'owner', 'egasi', `🎁 Taklif: «${newCo.name}» ulandi — bonus birinchi to‘lovdan keyin`);
  return { cid: refCid, days, pending: true };
}
// Taklif bilan kelgan kompaniya birinchi marta pul to'laganda chaqiriladi
async function refOnPaid(co, amount) {
  if (!co || !co.refBy || co.refPaid || !(Number(amount) > 0)) return null;
  co.refPaid = Date.now(); await saveCompany(co);
  return grantReferral(co.refBy, co);
}
async function grantReferral(refCid, newCo) {
  const ref = await company(refCid, true); if (!ref || ref.cid === newCo.cid) return null;
  const days = Math.max(0, Number((await ownerSettings()).refDays ?? 15) || 0); if (!days) return null;
  ref.refs = ref.refs || []; const e = ref.refs.find(r => r.cid === newCo.cid);
  if (e && e.st !== 'wait') return null; // eski tizimda bonus allaqachon berilgan
  addDays(ref, days); ref.blocked = false;
  if (e) { e.days = days; e.st = 'ok'; e.paid = Date.now(); }
  else ref.refs.unshift({ cid: newCo.cid, name: newCo.name, t: Date.now(), days, st: 'ok', paid: Date.now() });
  ref.refs = ref.refs.slice(0, 100);
  ref.msg = { text: `🎁 Rahmat! Siz «${newCo.name}» kompaniyasini HODIM'ga taklif qildingiz — obunangizga ${days} kun bepul qo‘shildi.`, k: 'ref', n: newCo.name, d: days, to: 'admin', t: Date.now(), until: Date.now() + 14 * DAY };
  await saveCompany(ref);
  await ev(refCid, 'owner', 'egasi', `🎁 Taklif bonusi: +${days} kun («${newCo.name}» birinchi to‘lovni qildi)`);
  try { const P = await dbGet(refCid, '/hodim/push/tg'); if (ENV.TG_TOKEN && P && P.chat) await tg('sendMessage', { chat_id: P.chat, text: `🎁 Rahmat! «${newCo.name}» kompaniyasini taklif qilganingiz uchun HODIM obunangizga ${days} kun bepul qo‘shildi.` }); } catch (e) { }
  return { cid: refCid, days };
}



// ================================================================
//  TAKLIF HAVOLASI: /join?ref=<kod> — ulanish arizasi sahifasi
//  Ariza egasining Telegram'iga boradi va egasi panelidagi «📥 Arizalar» bo'limida turadi
// ================================================================
async function leadsAll() { return (await metaGetJ('leads')) || []; }
async function joinPage(url) {
  const ref = cidOf(url.searchParams.get('ref'));
  const rc = ref && await company(ref, true);
  const s = await ownerSettings(), c = payContacts(s), days = Number(s.refDays ?? 15) || 0;
  const H = JOIN_HTML.replace('__CFG__', JSON.stringify({ ref: rc ? rc.cid : '', refName: rc ? rc.name : '', phones: c.phones, tg: c.tg, trial: Number(s.trialDays ?? 7) || 0, days, logo: APP_URL + 'hodim-192.png' }).replace(/</g, '\\u003c'));
  return new Response(H, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function joinApi(req) {
  const b = await body(req); if (!b) return json({ ok: false, msg: 'bad' }, 400);
  const name = String(b.name || '').trim().slice(0, 80), person = String(b.person || '').trim().slice(0, 60);
  const phone = String(b.phone || '').replace(/[^\d+ ()-]/g, '').trim().slice(0, 30), emp = Math.max(0, Math.min(100000, Number(b.emp) || 0));
  const city = String(b.city || '').trim().slice(0, 60);
  if (!name || phone.replace(/\D/g, '').length < 7) return json({ ok: false, msg: 'fill' });
  const ref = cidOf(b.ref); const rc = ref && await company(ref, true);
  const L = await leadsAll(), now = Date.now(), dig = phone.replace(/\D/g, '');
  const ip = req.headers.get('CF-Connecting-IP') || '';
  if (L.filter(x => x.ip === ip && now - x.t < 3600000).length >= 5) return json({ ok: false, msg: 'many' });
  if (L.some(x => x.phone.replace(/\D/g, '') === dig && now - x.t < 6 * 3600000)) return json({ ok: true, dup: true });
  const id = now.toString(36) + Math.random().toString(36).slice(2, 6);
  L.unshift({ id, t: now, name, person, phone, emp, city, ref: rc ? rc.cid : '', refName: rc ? rc.name : '', st: 'new', ip });
  await metaSet('leads', JSON.stringify(L.slice(0, 300)));
  if (rc) await ev(rc.cid, 'owner', 'egasi', `📥 Taklif havolasi orqali ariza: «${name}»`);
  await tgOwner(`📥 <b>Yangi ulanish arizasi</b>\n🏢 ${esc(name)}${city ? ' · ' + esc(city) : ''}\n👤 ${esc(person || '—')}\n📞 ${esc(phone)}\n👥 Xodimlar: ${emp || '—'}${rc ? `\n🎁 Taklif qilgan: <b>${esc(rc.name)}</b> (${rc.cid})` : ''}\n\nEgasi paneli → 📥 Arizalar`);
  return json({ ok: true });
}
async function ownerLeads() { const L = await leadsAll(); return { ok: true, list: L.map(({ ip, ...x }) => x) }; }
async function ownerLeadDo(b) {
  const L = await leadsAll(); const x = L.find(l => l.id === b.id); if (!x) return { ok: false, msg: 'Topilmadi' };
  if (b.del) L.splice(L.indexOf(x), 1); else { x.st = ['new', 'done', 'no'].includes(b.st) ? b.st : x.st; if (b.cid) x.cid = String(b.cid).slice(0, 40); }
  await metaSet('leads', JSON.stringify(L)); return { ok: true };
}
const JOIN_HTML = `<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HODIM — ulanish</title>
<meta property="og:title" content="HODIM — xodimlar davomati ilovasi"><meta property="og:description" content="Face ID · GPS · internetsiz belgilash · oylik hisobi. Ulanish uchun ariza qoldiring.">
<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:linear-gradient(160deg,#0a1033,#1a1060 60%,#2a1a6b);color:#eef2ff;min-height:100vh}
.w{max-width:480px;margin:0 auto;padding:22px 16px 40px}.hd{display:flex;align-items:center;gap:12px}.hd img{width:56px;height:56px;border-radius:14px}.hd b{font-size:26px;letter-spacing:.5px}.hd small{display:block;color:#a9b6ff;font-size:13px}
.lg{display:flex;gap:6px;justify-content:flex-end;margin-bottom:6px}.lg button{background:rgba(255,255,255,.1);border:0;color:#cfd8ff;border-radius:8px;padding:5px 9px;cursor:pointer}.lg button.on{background:#4f6bff;color:#fff}
.ref{margin:16px 0;padding:12px 14px;border-radius:14px;background:rgba(251,191,36,.13);border:1px dashed rgba(251,191,36,.6);font-size:14px}
.f{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.f div{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px;font-size:13px;line-height:1.35}.f div b{display:block;font-size:15px;margin-bottom:2px}
.card{background:rgba(255,255,255,.07);border:1px solid rgba(140,170,255,.3);border-radius:18px;padding:16px;margin-top:14px}label{display:block;font-size:13px;color:#b9c4ff;margin:10px 0 4px}
input{width:100%;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.25);color:#fff;font-size:16px}.btn{width:100%;margin-top:16px;padding:14px;border:0;border-radius:14px;font-size:17px;font-weight:700;color:#fff;background:linear-gradient(90deg,#3b5bff,#6a3cff);cursor:pointer}
.btn:disabled{opacity:.6}.ok{text-align:center;padding:10px 0}.ok .big{font-size:52px}.ct{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.ct a{flex:1;min-width:140px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:14px;padding:12px;border-radius:12px;color:#fff;text-decoration:none;font-weight:700;background:rgba(255,255,255,.12)}.ct a.tg{background:#229ED9}
.er{color:#fca5a5;font-size:14px;margin-top:8px;min-height:18px}.mut{color:#a9b6ff;font-size:12px;margin-top:10px;text-align:center}</style></head><body><div class="w">
<div class="lg"><button data-l="uz">O‘z</button><button data-l="ru">Рус</button><button data-l="en">Eng</button></div>
<div class="hd"><img id="lo" alt=""><div><b>HODIM</b><small data-t="sub"></small></div></div><div id="ref"></div>
<div class="f"><div><b>🙂 Face ID</b><span data-t="f1"></span></div><div><b>📍 GPS</b><span data-t="f2"></span></div><div><b>📴 Offline</b><span data-t="f3"></span></div><div><b data-t="f4t"></b><span data-t="f4"></span></div></div>
<div class="card" id="box"><b data-t="form" style="font-size:18px"></b>
<label data-t="lName"></label><input id="name" autocomplete="organization"><label data-t="lPerson"></label><input id="person" autocomplete="name">
<label data-t="lPhone"></label><input id="phone" type="tel" placeholder="+998 __ ___ __ __" autocomplete="tel"><label data-t="lEmp"></label><input id="emp" type="number" min="1" inputmode="numeric">
<label data-t="lCity"></label><input id="city"><button class="btn" id="go" data-t="send"></button><div class="er" id="er"></div></div><div id="ct"></div><div class="mut" data-t="trial"></div></div>
<script>const C=__CFG__;const T={uz:{sub:'Xodimlar davomati ilovasi',f1:'Yuzni taniydi, soxta rasm o‘tmaydi',f2:'Faqat ish joyida belgilaydi',f3:'Internetsiz ham ishlaydi',f4t:'💰 Oylik',f4:'Oylik, jarima va hisobotlar avtomatik',form:'📝 Ulanish uchun ariza',lName:'Kompaniya nomi *',lPerson:'Ismingiz',lPhone:'Telefon raqam *',lEmp:'Xodimlar soni',lCity:'Shahar',send:'Ariza yuborish',fill:'Kompaniya nomi va telefon raqamini kiriting',many:'Juda ko‘p urinish, keyinroq urinib ko‘ring',net:'Internet xatosi, qayta urinib ko‘ring',okT:'Rahmat! Arizangiz qabul qilindi',okD:'Tez orada siz bilan bog‘lanamiz.',call:'📞 Qo‘ng‘iroq',ref:'«{n}» kompaniyasi sizni HODIM’ga taklif qildi 🎁',trial:'Bepul sinov muddati: {t} kun'},
ru:{sub:'Приложение учёта посещаемости',f1:'Распознаёт лицо, фото не пройдёт',f2:'Отметка только на рабочем месте',f3:'Работает без интернета',f4t:'💰 Зарплата',f4:'Зарплата, штрафы и отчёты автоматически',form:'📝 Заявка на подключение',lName:'Название компании *',lPerson:'Ваше имя',lPhone:'Номер телефона *',lEmp:'Количество сотрудников',lCity:'Город',send:'Отправить заявку',fill:'Укажите название компании и телефон',many:'Слишком много попыток, попробуйте позже',net:'Ошибка интернета, попробуйте ещё раз',okT:'Спасибо! Заявка принята',okD:'Мы скоро свяжемся с вами.',call:'📞 Позвонить',ref:'Компания «{n}» пригласила вас в HODIM 🎁',trial:'Бесплатный пробный период: {t} дн.'},
en:{sub:'Employee attendance app',f1:'Recognizes faces, photos won’t pass',f2:'Check-in only at the workplace',f3:'Works offline',f4t:'💰 Payroll',f4:'Payroll, fines and reports automatically',form:'📝 Request to join',lName:'Company name *',lPerson:'Your name',lPhone:'Phone number *',lEmp:'Number of employees',lCity:'City',send:'Send request',fill:'Enter the company name and phone number',many:'Too many attempts, try later',net:'Network error, try again',okT:'Thank you! Request received',okD:'We will contact you soon.',call:'📞 Call',ref:'«{n}» invited you to HODIM 🎁',trial:'Free trial: {t} days'}};
let L=/^ru/i.test(navigator.language||'')?'ru':'uz';try{L=localStorage.getItem('HODIM_LANG')||L}catch(e){}
const $=i=>document.getElementById(i),e=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function ctHTML(){const a=[];if(C.tg)a.push('<a class="tg" target="_blank" href="https://t.me/'+e(C.tg)+'">✈️ Telegram</a>');(C.phones||[]).slice(0,2).forEach(p=>a.push('<a href="tel:'+e(p.replace(/[^\\d+]/g,''))+'">'+T[L].call+' '+e(p)+'</a>'));return a.length?'<div class="ct">'+a.join('')+'</div>':''}
function draw(){const t=T[L];document.documentElement.lang=L;document.querySelectorAll('[data-t]').forEach(x=>x.textContent=(t[x.dataset.t]||'').replace('{t}',C.trial));
 document.querySelectorAll('[data-l]').forEach(b=>b.classList.toggle('on',b.dataset.l===L));$('ref').innerHTML=C.refName?'<div class="ref">'+e(t.ref.replace('{n}',C.refName))+'</div>':'';
 $('ct').innerHTML=ctHTML();if(!C.trial)document.querySelector('[data-t=trial]').textContent=''}
document.querySelectorAll('[data-l]').forEach(b=>b.onclick=()=>{L=b.dataset.l;try{localStorage.setItem('HODIM_LANG',L)}catch(e){}draw()});
$('lo').src=C.logo;draw();
$('go').onclick=async()=>{const t=T[L];$('er').textContent='';const d={name:$('name').value,person:$('person').value,phone:$('phone').value,emp:$('emp').value,city:$('city').value,ref:C.ref};
 if(!d.name.trim()||d.phone.replace(/\\D/g,'').length<7){$('er').textContent=t.fill;return}$('go').disabled=true;
 let r=null;try{r=await fetch('/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(x=>x.json())}catch(x){}
 $('go').disabled=false;if(!r){$('er').textContent=t.net;return}if(!r.ok){$('er').textContent=t[r.msg]||t.net;return}
 $('box').innerHTML='<div class="ok"><div class="big">✅</div><h2>'+t.okT+'</h2><p>'+t.okD+'</p></div>'+ctHTML();$('ct').innerHTML=''};
</script></body></html>`;


// ================================================================
//  CLOUDFLARE D1 BAZA. Kalitlar: c/<kompaniya>/<yo'l>. Ilova /db/c/<kompaniya>/... manziliga
//  Firebase'dagi kabi so'rov yuboradi, server esa har birini qoidalar bilan tekshiradi.
// ================================================================
let dbReady = false;
async function dbInit() {
  if (dbReady) return;
  await ENV.DB.batch([
    ENV.DB.prepare('CREATE TABLE IF NOT EXISTS docs (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    ENV.DB.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    ENV.DB.prepare('CREATE TABLE IF NOT EXISTS companies (cid TEXT PRIMARY KEY, j TEXT NOT NULL)'),
    ENV.DB.prepare('CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT NOT NULL, k TEXT NOT NULL, t INTEGER NOT NULL)'),
    ENV.DB.prepare('CREATE INDEX IF NOT EXISTS changes_cid ON changes(cid, seq)'),
    ENV.DB.prepare('CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT, t INTEGER NOT NULL, kind TEXT, msg TEXT, extra TEXT)'),
    ENV.DB.prepare('CREATE INDEX IF NOT EXISTS logs_cid ON logs(cid, id)'),
    ENV.DB.prepare('CREATE TABLE IF NOT EXISTS ev (id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT, t INTEGER NOT NULL, k TEXT, who TEXT, msg TEXT)'),
    ENV.DB.prepare('CREATE INDEX IF NOT EXISTS ev_cid ON ev(cid, id)'),
    ENV.DB.prepare('CREATE INDEX IF NOT EXISTS ev_k ON ev(k, id)'),
    ENV.DB.prepare('CREATE TABLE IF NOT EXISTS stat (cid TEXT NOT NULL, d TEXT NOT NULL, k TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(cid, d, k))'),
    ENV.DB.prepare('CREATE TABLE IF NOT EXISTS pay (id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT, t INTEGER, months INTEGER, amount REAL, cur TEXT, note TEXT, phone TEXT, ph TEXT, st TEXT, why TEXT, done INTEGER)')
  ]);
  // Bir martalik: eski (bitta kompaniyali) ma'lumotlar «main» kompaniyasiga o'tkaziladi
  if (!(await metaGet('tenant1'))) {
    await ENV.DB.prepare("UPDATE docs SET k='c/main/'||k WHERE k NOT LIKE 'c/%'").run();
    if (!(await company('main', true))) {
      const st = (await dbGet('main', '/hodim/settings')) || {};
      await saveCompany({ cid: 'main', name: st.company || 'Asosiy kompaniya', created: Date.now(), trialEnd: 0, paidUntil: Date.parse('2099-12-31'), price: 0, cur: 'UZS', maxEmp: 0, note: 'Egasining o‘z kompaniyasi' });
    }
    await metaSet('tenant1', new Date().toISOString());
  }
  dbReady = true;
}
async function metaGet(k) { const r = await ENV.DB.prepare('SELECT v FROM meta WHERE k=?').bind(k).first(); return r ? r.v : null; }
async function metaSet(k, v) { await ENV.DB.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, String(v)).run(); }
async function metaGetJ(k) { const v = await metaGet(k); try { return v ? JSON.parse(v) : null; } catch (e) { return null; } }
// Har bir "hujjat" (qator) qaysi chuqurlikda saqlanadi (kompaniya ichidagi yo'l bo'yicha)
function relDepth(s) {
  const t = s[0];
  if (t === 'hodim') {
    const k = s[1];
    if (k === 'rec') return 4;
    if (k === 'lv' || k === 'lx' || k === 'adv') return 3;
    if (k === 'push') return (s[2] === 'subs' || s[2] === 'lang') ? 4 : 3;
    return 2;
  }
  if (t === 'hodim_photos' || t === 'hodim_sec' || t === 'hodim_ck') return 3;
  if (t === 'hodim_av' || t === 'hodim_pay' || t === 'hodim_pins' || t === 'hodim_bio' || t === 'hodim_face' || t === 'hodim_face_ph') return 2;
  return 1;
}
const docDepth = s => 2 + relDepth(s.slice(2));
const segsOf = p => String(p || '').split('/').filter(Boolean);
const T = (cid, p) => ['c', cid, ...segsOf(p)];
const isEmpty = v => v == null || (typeof v === 'object' && Object.keys(v).length === 0);
function prune(v) { if (v && typeof v === 'object' && !Array.isArray(v)) { for (const k of Object.keys(v)) { v[k] = prune(v[k]); if (isEmpty(v[k])) delete v[k]; } } return v; }
function range(segs) { const p = segs.join('/'); return [p + '/', p + '0']; }
async function sGet(segs, opt = {}) {
  const d = docDepth(segs);
  if (segs.length >= d) {
    const row = await ENV.DB.prepare('SELECT v FROM docs WHERE k=?').bind(segs.slice(0, d).join('/')).first();
    if (!row) return null;
    let v = JSON.parse(row.v);
    for (const x of segs.slice(d)) { if (v == null || typeof v !== 'object') return null; v = v[x]; }
    if (v === undefined) v = null;
    if (opt.shallow && v && typeof v === 'object') return Object.fromEntries(Object.keys(v).map(k => [k, true]));
    return v;
  }
  const [lo, hi] = range(segs);
  if (opt.shallow) {
    const rs = await ENV.DB.prepare('SELECT k FROM docs WHERE k>=? AND k<?').bind(lo, hi).all();
    const out = {}; for (const r of rs.results) out[r.k.slice(lo.length).split('/')[0]] = true;
    return Object.keys(out).length ? out : null;
  }
  const rs = await ENV.DB.prepare('SELECT k, v FROM docs WHERE k>=? AND k<?').bind(lo, hi).all();
  if (!rs.results.length) return null;
  const out = {};
  for (const r of rs.results) {
    const rel = r.k.slice(lo.length).split('/'); let o = out;
    for (let i = 0; i < rel.length - 1; i++) o = o[rel[i]] = (o[rel[i]] && typeof o[rel[i]] === 'object') ? o[rel[i]] : {};
    o[rel[rel.length - 1]] = JSON.parse(r.v);
  }
  return out;
}
const UPSERT = 'INSERT INTO docs(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v';
async function sOps(segs, val, ops) {
  const d = docDepth(segs);
  if (segs.length >= d) {
    const k = segs.slice(0, d).join('/'), rest = segs.slice(d);
    if (!rest.length) {
      if (isEmpty(prune(val))) ops.push(ENV.DB.prepare('DELETE FROM docs WHERE k=?').bind(k));
      else ops.push(ENV.DB.prepare(UPSERT).bind(k, JSON.stringify(val)));
      return;
    }
    const row = await ENV.DB.prepare('SELECT v FROM docs WHERE k=?').bind(k).first();
    let doc = row ? JSON.parse(row.v) : {}; if (!doc || typeof doc !== 'object') doc = {};
    let o = doc; for (let i = 0; i < rest.length - 1; i++) { if (!o[rest[i]] || typeof o[rest[i]] !== 'object') o[rest[i]] = {}; o = o[rest[i]]; }
    if (val == null) delete o[rest[rest.length - 1]]; else o[rest[rest.length - 1]] = val;
    prune(doc);
    if (isEmpty(doc)) ops.push(ENV.DB.prepare('DELETE FROM docs WHERE k=?').bind(k));
    else ops.push(ENV.DB.prepare(UPSERT).bind(k, JSON.stringify(doc)));
    return;
  }
  const [lo, hi] = range(segs);
  ops.push(ENV.DB.prepare('DELETE FROM docs WHERE k>=? AND k<?').bind(lo, hi));
  if (val && typeof val === 'object') for (const [ck, cv] of Object.entries(val)) if (cv != null) await sOps(segs.concat(String(ck)), cv, ops);
}
async function sRun(ops) { for (let i = 0; i < ops.length; i += 80) await ENV.DB.batch(ops.slice(i, i + 80)); }
async function sSet(segs, val) { const ops = []; await sOps(segs, val, ops); await sRun(ops); }
async function dbGet(cid, p) { try { return await sGet(T(cid, p)); } catch (e) { return null; } }
async function dbPut(cid, p, v) { await sSet(T(cid, p), v); }
async function dbDel(cid, p) { await sSet(T(cid, p), null); }

// ---------------- Kirish kaliti (token) ----------------
let sigKeyCache = null;
async function sigKey() {
  if (sigKeyCache) return sigKeyCache;
  let k = await metaGet('sigkey');
  if (!k) { const a = new Uint8Array(32); crypto.getRandomValues(a); k = [...a].map(x => x.toString(16).padStart(2, '0')).join(''); await ENV.DB.prepare('INSERT OR IGNORE INTO meta(k,v) VALUES(?,?)').bind('sigkey', k).run(); k = await metaGet('sigkey'); }
  sigKeyCache = await crypto.subtle.importKey('raw', enc.encode(k), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return sigKeyCache;
}
async function mintToken(uid, role, cid, hours) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u.enc(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64u.enc(enc.encode(JSON.stringify({ v: 0, iat: now, exp: now + (hours || 72) * 3600, d: { uid, role, cid } })));
  const sig = await crypto.subtle.sign('HMAC', await sigKey(), enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64u.enc(sig)}`;
}
async function authOf(tok) {
  if (!tok) return null;
  try {
    const [h, p, s] = tok.split('.'); if (!s) return null;
    if (!(await crypto.subtle.verify('HMAC', await sigKey(), b64u.dec(s), enc.encode(`${h}.${p}`)))) return null;
    const c = JSON.parse(new TextDecoder().decode(b64u.dec(p)));
    if (!c.exp || c.exp < Date.now() / 1000 || !c.d) return null;
    if (!c.d.cid) c.d.cid = 'main';
    return { ...c.d, iat: c.iat };
  } catch (e) { return null; }
}

// ---------------- Xavfsizlik qoidalari (s — kompaniya ichidagi yo'l) ----------------
function canRead(s, au, q) {
  const t = s[0];
  if (t === 'hodim_public' || t === 'hodim_av') return true;
  if (!au) return false;
  const admin = au.role === 'admin';
  if (t === 'hodim_photos') return true;
  if (t === 'hodim_pay') return admin || (s.length >= 2 && s[1] === au.uid);
  if (t === 'hodim_pins') return admin;
  if (t === 'hodim_ck' || t === 'hodim_face' || t === 'hodim_face_ph') return admin;
  if (t !== 'hodim' || s.length < 2) return false;
  const k = s[1];
  if (['employees', 'settings', 'location', 'rec', 'lv'].includes(k)) return true;
  if (k === 'lx' || k === 'adv') return admin || (s.length === 2 && q && q.get('orderBy') === '"employeeId"' && q.get('equalTo') === JSON.stringify(au.uid)) || (s.length === 3 && q === 'own');
  return admin;
}
async function canWrite(cid, s, au, nv) {
  if (!au) return false;
  const admin = au.role === 'admin', t = s[0];
  if (['hodim_public', 'hodim_av', 'hodim_pay', 'hodim_admin', 'hodim_ck', 'hodim_face', 'hodim_face_ph'].includes(t)) return admin;
  if (t === 'hodim_photos') {
    if (admin) return true;
    if (s.length < 3) return false;
    const r = await sGet(T(cid, `hodim/rec/${s[1]}/${s[2]}`));
    return !!(r && r.employeeId === au.uid && r.date === nowT().date);
  }
  if (t === 'hodim_pins') return s.length === 2 && (admin || s[1] === au.uid);
  if (t !== 'hodim' || s.length < 2) return false;
  if (admin) return true;
  const k = s[1];
  if ((k === 'lv' || k === 'lx') && s.length === 3) {
    const old = await sGet(T(cid, s.join('/'))), own = x => x && x.employeeId === au.uid && x.status === 'pending';
    return (own(nv) && (!old || own(old))) || (!nv && own(old));
  }
  if (k === 'push') {
    const c = s[2];
    if (['sched', 'status', 'leaves', 'holidays', 'tgTime', 'company', 'photoKeepDays'].includes(c)) return true;
    if ((c === 'subs' || c === 'lang') && s[3] === au.uid) return true;
  }
  return false;
}
// Xodimning davomat yozuvi: faqat BUGUN, vaqtni server belgilaydi (telefon soati 10 daqiqadan ko'p farq qilsa — server vaqti yoziladi)
async function stampRec(cid, s, au, nv) {
  if (!nv || nv.employeeId !== au.uid || s.length !== 4) return { err: 'Ruxsat yo‘q' };
  const { date, cur } = nowT();
  if (s[2] !== date.slice(0, 7)) return { err: 'Faqat bugungi kun uchun belgilash mumkin' };
  const old = await sGet(T(cid, s.join('/')));
  if (old && old.employeeId !== au.uid) return { err: 'Ruxsat yo‘q' };
  const fix = (cl) => { const c = toMin(cl); return (cl && c >= cur - 10 && c <= cur + 2) ? { t: cl } : { t: hm(cur), dev: cl || '—' }; };
  const chk = await chkOf(cid, await company(cid));
  const flag = (r, a) => { if (chk.face || chk.gps) { r.sus = { ...(r.sus || {}), [a]: 1 }; return { a, f: ['old_app'] }; } return null; };
  if (!old) {
    if (nv.date !== date) return { err: 'Faqat bugungi kun uchun belgilash mumkin' };
    const f = fix(nv.inTime), r = { id: s[3], employeeId: au.uid, date, inTime: f.t, outTime: '' };
    if (f.dev) r.devIn = f.dev;
    const ck = flag(r, 'in');
    if (nv.outTime) { const g = fix(nv.outTime); r.outTime = g.t; if (g.dev) r.devOut = g.dev; }
    return { v: r, ck, isNew: true };
  }
  if (old.date !== date) return { err: 'O‘tgan kunlarni faqat admin o‘zgartira oladi' };
  const r = { ...old, id: s[3] };
  let ck = null;
  if (!old.outTime && nv.outTime) { const g = fix(nv.outTime); r.outTime = g.t; if (g.dev) r.devOut = g.dev; else delete r.devOut; ck = flag(r, 'out'); }
  return { v: r, ck };
}
// O'zgarishlar jurnali (ilova faqat yangi o'zgarishlarni oladi — bazadan o'qish ~100 marta kamayadi)
function logPath(s) {
  if (s[0] === 'hodim') return ['employees', 'settings', 'location', 'rec', 'lv', 'lx', 'adv'].includes(s[1]) ? s.slice(0, s[1] === 'rec' ? 4 : (['lv', 'lx', 'adv'].includes(s[1]) ? 3 : 2)).join('/') : (s.length === 1 ? 'hodim' : null);
  if (s[0] === 'hodim_pay' || s[0] === 'hodim_pins') return s.slice(0, 2).join('/');
  return null;
}
function expandLog(s, val) {
  if (s.length === 1 && s[0] === 'hodim' && val && typeof val === 'object') return Object.keys(val).map(k => logPath(['hodim', ...segsOf(k)])).filter(Boolean);
  const p = logPath(s); return p ? [p] : [];
}
async function logChanges(cid, paths) {
  const u = [...new Set(paths)]; if (!u.length) return;
  const now = Date.now();
  await ENV.DB.batch(u.map(k => ENV.DB.prepare('INSERT INTO changes(cid,k,t) VALUES(?,?,?)').bind(cid, k, now)));
}
// /db/c/<kompaniya>/<yo'l>.json — Firebase REST bilan bir xil ko'rinish (GET / PUT / PATCH / DELETE)
async function dbApi(req, url) {
  const deny = (m, st) => json({ error: m || 'Permission denied' }, st || 401);
  let all = segsOf(decodeURIComponent(url.pathname.slice(3).replace(/\.json$/, '')));
  let cid = 'main';
  if (all[0] === 'c') { cid = cidOf(all[1]); all = all.slice(2); }
  if (!cid) return deny('bad company', 400);
  const s = all;
  if (s.some(x => x === '.' || x === '..' || x.length > 120)) return json({ error: 'bad path' }, 400);
  const q = url.searchParams, au = await authOf(q.get('auth'));
  if (au && au.cid !== cid) return deny();
  const co = await company(cid); if (!co) return deny('nocompany', 404);
  if (au && !tokOk(au, co)) return deny('revoked', 401);
  if (au && au.role !== 'owner') { const den = await subDenied(cid); if (den) return den; }
  const m = req.method;
  // O'zgarishlar: /db/c/<k>/_changes?since=N — faqat yangi/o'zgargan yozuvlar
  if (s[0] === '_seq') { if (!au) return deny(); const r = await ENV.DB.prepare('SELECT MAX(seq) AS m FROM changes WHERE cid=?').bind(cid).first(); return json({ seq: (r && r.m) || 0 }); }
  if (s[0] === '_changes') {
    if (!au) return deny();
    const since = Number(q.get('since')) || 0, pruned = Number(await metaGet('prunedSeq')) || 0;
    if (since < pruned) return json({ full: true });
    const rs = await ENV.DB.prepare('SELECT seq, k FROM changes WHERE cid=? AND seq>? ORDER BY seq LIMIT 401').bind(cid, since).all();
    if (rs.results.length > 400) return json({ full: true });
    let seq = since; const keys = new Set();
    for (const r of rs.results) { seq = r.seq; keys.add(r.k); }
    const ch = [];
    for (const k of keys) {
      let ss = segsOf(k), kk = k;
      if (ss[0] === 'hodim_pay' && au.role !== 'admin') { if (ss[1] && ss[1] !== au.uid) continue; kk = 'hodim_pay/' + au.uid; ss = ['hodim_pay', au.uid]; }
      else if (!canRead(ss, au, ss.length === 3 ? 'own' : null)) continue;
      let v = await sGet(T(cid, kk));
      if ((ss[1] === 'lx' || ss[1] === 'adv') && au.role !== 'admin' && v && v.employeeId !== au.uid) continue;
      ch.push([kk, v]);
    }
    return json({ seq, ch });
  }
  if (m === 'GET') {
    if (!canRead(s, au, q)) return deny();
    let v = await sGet(T(cid, s.join('/')), { shallow: !!q.get('shallow') });
    const ob = q.get('orderBy'), eq = q.get('equalTo');
    if (ob && eq && v && typeof v === 'object') { try { const f = JSON.parse(ob), e = JSON.parse(eq); v = Object.fromEntries(Object.entries(v).filter(([, x]) => x && x[f] === e)); } catch (e) { } }
    return new Response(JSON.stringify(v ?? null), { headers: { 'content-type': 'application/json', ...CORS } });
  }
  let b = null; try { const t = await req.text(); b = t ? JSON.parse(t) : null; } catch (e) { return json({ error: 'bad json' }, 400); }
  const logs = [];
  if (m === 'PUT' || m === 'DELETE') {
    let nv = m === 'DELETE' ? null : b;
    if (au && au.role === 'emp' && s[0] === 'hodim' && s[1] === 'rec') {
      if (!nv) return deny();
      const r = await stampRec(cid, s, au, nv); if (r.err) return deny(r.err, 403); nv = r.v;
      if (r.isNew) await statInc(cid, 'in');
      if (r.ck) { const en = empList(await dbGet(cid, '/hodim/employees')).find(x => x.id === au.uid); await sSet(T(cid, `hodim_ck/${s[2]}/${s[3]}/${r.ck.a}`), { t: Date.now(), f: r.ck.f, at: Date.now() }); await statInc(cid, 'sus'); await ev(cid, 'sus', (en && en.name) || au.uid, { a: r.ck.a, tm: r.ck.a === 'in' ? nv.inTime : nv.outTime, date: nv.date, f: r.ck.f, rid: s[3], m: s[2], eid: au.uid }); }
    } else if (!(await canWrite(cid, s, au, nv))) return deny();
    if (au && au.role === 'admin' && s[0] === 'hodim' && s[1] === 'employees' && s.length === 2) { const lim = await empLimit(co, nv); if (lim) return lim; }
    await sSet(T(cid, s.join('/')), nv);
    await logChanges(cid, expandLog(s, nv));
    if (au && au.role === 'admin') await adminJournal(cid, s, m, nv);
    return new Response(JSON.stringify(nv), { headers: { 'content-type': 'application/json', ...CORS } });
  }
  if (m === 'PATCH') {
    const subs = Object.entries(b || {}).map(([k, v]) => [s.concat(segsOf(k)), v]);
    for (const [p, v] of subs) {
      if (au && au.role === 'emp' && p[0] === 'hodim' && p[1] === 'rec') return deny();
      if (!(await canWrite(cid, p, au, v))) return deny();
      if (au && au.role === 'admin' && p[0] === 'hodim' && p[1] === 'employees' && p.length === 2) { const lim = await empLimit(co, v); if (lim) return lim; }
    }
    const ops = []; for (const [p, v] of subs) await sOps(T(cid, p.join('/')), v, ops); await sRun(ops);
    for (const [p, v] of subs) logs.push(...expandLog(p, v));
    await logChanges(cid, logs);
    if (au && au.role === 'admin') for (const [p, v] of subs.slice(0, 5)) await adminJournal(cid, p, 'PATCH', v);
    return new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json', ...CORS } });
  }
  return json({ error: 'method' }, 405);
}
// Admin nima o'zgartirgani — egasi panelidagi «Jonli lenta» uchun (bir xil o'zgarish 1 daqiqada bir marta yoziladi)
const jrnSeen = new Map();
async function adminJournal(cid, s, m, v) {
  const t0 = s[0], k = s[1];
  if (t0 === 'hodim' && (k === 'push' || s.length === 1)) return;
  if (['hodim_photos', 'hodim_public', 'hodim_sec', 'hodim_av'].includes(t0)) return;
  let txt = '';
  if (t0 === 'hodim') {
    if (k === 'employees') txt = 'Xodimlar ro‘yxati o‘zgartirildi';
    else if (k === 'settings') txt = 'Kompaniya sozlamalari o‘zgartirildi';
    else if (k === 'location') txt = 'Ish joyi (joylashuv) o‘zgartirildi';
    else if (k === 'rec') txt = m === 'DELETE' || !v ? `Davomat yozuvi o‘chirildi (${s[3] || s[2] || ''})` : `Davomat qo‘lda tahrirlandi: ${v.employeeId || ''} ${v.date || ''} ${v.inTime || ''}–${v.outTime || ''}${v.rv ? ' · ko‘rib chiqildi: ' + Object.entries(v.rv).map(([a, x]) => (a === 'in' ? 'kelish ' : 'ketish ') + (x === 'ok' ? '✅' : '❌')).join(', ') : ''}`;
    else if (k === 'lv') txt = 'Javob so‘rovi o‘zgartirildi';
    else if (k === 'adv') txt = 'Avans ' + (v ? 'qo‘shildi' : 'o‘chirildi');
    else if (k === 'lx') txt = 'Kechikish izohi o‘zgartirildi';
    else txt = 'O‘zgarish: ' + s.join('/');
  } else if (t0 === 'hodim_pay') txt = 'Oyliklar o‘zgartirildi';
  else if (t0 === 'hodim_pins') txt = 'Xodim PIN kodi o‘zgartirildi: ' + (s[1] || '');
  else if (t0 === 'hodim_admin') txt = 'Admin PIN o‘zgartirildi';
  else if (t0 === 'hodim_face' || t0 === 'hodim_face_ph') { if (t0 === 'hodim_face_ph') return; txt = 'Yuz namunasi ' + (v ? 'olindi' : 'o‘chirildi') + ': ' + (s[1] || ''); }
  else if (t0 === 'hodim_ck') return;
  else txt = 'O‘zgarish: ' + s.join('/');
  const key = cid + '|' + txt.slice(0, 60);
  if (Date.now() - (jrnSeen.get(key) || 0) < 60000) return;
  jrnSeen.set(key, Date.now()); if (jrnSeen.size > 500) jrnSeen.clear();
  await ev(cid, 'admin', 'admin', txt);
}
async function empLimit(co, list) {
  const n = (Array.isArray(list) ? list : Object.values(list || {})).filter(Boolean).length;
  if (co.maxEmp && n > co.maxEmp) return json({ error: 'limit', max: co.maxEmp, msg: `Obunangiz bo‘yicha xodimlar soni ${co.maxEmp} tagacha` }, 403);
  return null;
}
// ---------------- Ilovadagi xatolar (egasi panelida ko'rinadi) ----------------
async function logErr(cid, kind, msg, extra) {
  await ENV.DB.prepare('INSERT INTO logs(cid,t,kind,msg,extra) VALUES(?,?,?,?,?)').bind(cid, Date.now(), kind, String(msg || '').slice(0, 1000), String(extra || '').slice(0, 400)).run();
}
async function clientLog(req) {
  const b = await body(req); if (!b) return json({ ok: false }, 400);
  const cid = cidOf(b.c); if (!cid || !(await company(cid))) return json({ ok: false }, 400);
  const extra = [b.role || '', b.where || '', b.v || '', String(req.headers.get('user-agent') || '').slice(0, 120)].join(' | ');
  await logErr(cid, 'app', String(b.m || '').slice(0, 600) + (b.s ? ` @${String(b.s).slice(-80)}:${b.l || ''}` : ''), extra);
  return json({ ok: true });
}


// ================================================================
//  EGASI PANELI API (/owner/api/...) — faqat OWNER_KEY bilan kirgan egasi uchun
// ================================================================
async function ownerApi(req, url, ep) {
  const q = url.searchParams;
  if (ep === 'login') {
    if (!ENV.OWNER_KEY) return json({ ok: false, msg: 'Cloudflare sozlamasida OWNER_KEY kiritilmagan.' });
    const ik = 'ownerfail:' + (await sha256hex('ip:' + (req.headers.get('CF-Connecting-IP') || 'x'))).slice(0, 24);
    const f = (await metaGetJ(ik)) || {};
    if (f.until && f.until > Date.now()) return json({ ok: false, msg: `Ko‘p xato urinish. ${Math.ceil((f.until - Date.now()) / 60000)} daqiqadan keyin urinib ko‘ring.` });
    const b = await body(req) || {};
    const a = await sha256hex('o:' + String(b.key || '')), e = await sha256hex('o:' + String(ENV.OWNER_KEY).trim());
    if (a !== e) {
      const fresh = !f.t || Date.now() - f.t > 30 * 60000, n = (fresh ? 0 : (f.n || 0)) + 1;
      await metaSet(ik, JSON.stringify({ n, t: Date.now(), until: n >= 5 ? Date.now() + 30 * 60000 : 0 }));
      if (n === 3 || n === 5) { const cf = req.cf || {}; await ev('*', 'owner', '?', `Egasi paneliga noto‘g‘ri parol (${n} marta)` + (cf.city ? ' · ' + cf.city : '')); try { await tgOwner(`⚠️ Egasi paneliga ${n} marta noto‘g‘ri parol kiritildi` + (cf.city ? ' · ' + esc(cf.city) : '')); } catch (e) { } }
      return json({ ok: false, msg: 'Parol noto‘g‘ri' + (n < 5 ? ` (yana ${5 - n} ta urinish)` : '') });
    }
    await ENV.DB.prepare('DELETE FROM meta WHERE k=?').bind(ik).run();
    const cf = req.cf || {}, where = [cf.city, cf.country].filter(Boolean).join(', ');
    await ev('*', 'owner', 'egasi', 'Egasi paneliga kirildi' + (where ? ' · ' + where : ''));
    try { await tgOwner('🔐 HODIM egasi paneliga kirildi' + (where ? ' · ' + esc(where) : '') + '\nAgar bu siz bo‘lmasangiz — Cloudflare’da OWNER_KEY ni darhol almashtiring.'); } catch (e) { }
    return json({ ok: true, token: await mintToken('owner', 'owner', '*', 12) });
  }
  const au = await authOf((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!au || au.role !== 'owner') return json({ ok: false, auth: false, msg: 'Qayta kiring' }, 401);
  const b = req.method === 'POST' ? (await body(req) || {}) : {};
  const cid = cidOf(b.cid || q.get('cid'));
  if (ep === 'overview') return json(await ownerOverview());
  if (ep === 'settings') {
    if (req.method === 'POST') { const old = await ownerSettings(); const n = { ...old, contact: String(b.contact ?? old.contact ?? '').slice(0, 200), trialDays: Number(b.trialDays ?? old.trialDays) || 0, price: Number(b.price ?? old.price) || 0, cur: ['UZS', 'RUB', 'USD', 'KZT', 'EUR'].includes(b.cur) ? b.cur : (old.cur || 'UZS'), maxEmp: Number(b.maxEmp ?? old.maxEmp) || 0 };
      for (const k of ['payCard', 'payHolder', 'payType', 'phones', 'tg']) if (b[k] != null) n[k] = String(b[k]).slice(0, 200);
      if (b.refDays != null) n.refDays = Math.max(0, Math.min(365, Number(b.refDays) || 0));
      if (Array.isArray(b.payCards)) { n.payCards = cleanCards(b.payCards); delete n.payCard; }
      await metaSet('owner_settings', JSON.stringify(n)); }
    return json({ ok: true, settings: (await metaGetJ('owner_settings')) || { contact: '', trialDays: 7, price: 120000, cur: 'UZS', maxEmp: 10 } });
  }
  if (ep === 'errors') {
    const rs = cid ? await ENV.DB.prepare('SELECT * FROM logs WHERE cid=? ORDER BY id DESC LIMIT 100').bind(cid).all()
      : await ENV.DB.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 150').all();
    return json({ ok: true, logs: rs.results });
  }
  if (ep === 'feed') {
    const w = [], a = []; const fc = cidOf(q.get('cid')), k = q.get('k'), bf = Number(q.get('before')) || 0, af = Number(q.get('after')) || 0;
    if (q.get('cid') === '*') { w.push('cid=?'); a.push('*'); } else if (fc) { w.push('cid=?'); a.push(fc); }
    if (k && /^[a-z]{2,10}$/.test(k)) { w.push('k=?'); a.push(k); }
    if (bf) { w.push('id<?'); a.push(bf); } if (af) { w.push('id>?'); a.push(af); }
    const lim = Math.min(300, Number(q.get('limit')) || 120);
    const rs = await ENV.DB.prepare(`SELECT id,cid,t,k,who,msg FROM ev ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id ${af ? 'ASC' : 'DESC'} LIMIT ${lim}`).bind(...a).all();
    return json({ ok: true, ev: rs.results });
  }
  if (ep === 'gmsg') {
    const text = String(b.text || '').trim().slice(0, 500);
    if (text) await metaSet('owner_msg', JSON.stringify({ text, to: b.to === 'admin' ? 'admin' : 'all', t: Date.now(), until: Number(b.days) > 0 ? Date.now() + Number(b.days) * DAY : 0 }));
    else await ENV.DB.prepare('DELETE FROM meta WHERE k=?').bind('owner_msg').run();
    await ev('*', 'owner', 'egasi', text ? 'Hammaga e’lon: ' + text.slice(0, 80) : 'Umumiy e’lon o‘chirildi');
    return json({ ok: true, gmsg: await metaGetJ('owner_msg') });
  }
  if (ep === 'payreqs') { const rs = await ENV.DB.prepare("SELECT id,cid,t,months,amount,cur,note,phone,st,why,done FROM pay WHERE st!='old' ORDER BY id DESC LIMIT 100").all(); return json({ ok: true, list: rs.results }); }
  if (ep === 'payph') { const r = await ENV.DB.prepare('SELECT ph FROM pay WHERE id=?').bind(Number(q.get('id')) || 0).first(); return json({ ok: true, ph: r ? r.ph : null }); }
  if (ep === 'paydecide') return json(await ownerPayDecide(b));
  if (ep === 'leads') return json(await ownerLeads());
  if (ep === 'leaddo') return json(await ownerLeadDo(b));
  if (ep === 'tglink') return json(await ownerTgLink(!!b.check));
  if (ep === 'tgtest') return json({ ok: await tgOwner('🔔 Sinov: HODIM egasi ogohlantirishlari ishlayapti.') });
  if (ep === 'digest') return json({ ok: await ownerDigest() });
  if (ep === 'tgoff') { await ENV.DB.prepare('DELETE FROM meta WHERE k=?').bind('owner_tg').run(); return json({ ok: true }); }
  if (ep === 'exportall') {
    const all = []; for (const co of await companies()) all.push({ company: co, dump: await tenantDump(co.cid) });
    await ev('*', 'owner', 'egasi', 'Barcha kompaniyalar zaxirasi yuklab olindi');
    return new Response(JSON.stringify({ app: 'HODIM-ALL', date: nowT().date, companies: all }), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="hodim-hammasi-${nowT().date}.json"` } });
  }
  if (ep === 'clearerrors') { if (cid) await ENV.DB.prepare('DELETE FROM logs WHERE cid=?').bind(cid).run(); else await ENV.DB.prepare('DELETE FROM logs').run(); return json({ ok: true }); }
  if (ep === 'create') {
    const id = cidOf(b.newCid);
    if (!id || id === 'c') return json({ ok: false, msg: 'Kod: 2–31 ta kichik lotin harf, raqam yoki «-» (masalan: koer-namangan)' });
    if (await company(id, true)) return json({ ok: false, msg: 'Bu kod band — boshqa kod tanlang' });
    const name = String(b.name || '').trim().slice(0, 80); if (!name) return json({ ok: false, msg: 'Kompaniya nomini yozing' });
    const trialDays = Math.max(0, Number(b.trialDays) || 0), now = Date.now();
    const co = { cid: id, name, created: now, trialEnd: now + trialDays * DAY, paidUntil: 0, price: Number(b.price) || 0, cur: ['UZS', 'RUB', 'USD', 'KZT', 'EUR'].includes(b.cur) ? b.cur : 'UZS', maxEmp: Number(b.maxEmp) || 0, phone: String(b.phone || '').slice(0, 60), note: String(b.note || '').slice(0, 300), payments: [] };
    await saveCompany(co);
    const pin = randPin();
    await dbPut(id, '/hodim/settings', { company: name, currency: co.cur, workStart: '08:00', workEnd: '18:00', offDays: [0] });
    await dbPut(id, '/hodim_admin', { pinHash: await sha256hex('hodim:' + pin) });
    await logChanges(id, ['hodim']);
    await ev(id, 'owner', 'egasi', 'Yangi kompaniya yaratildi: ' + name);
    let refRes = null; const rc = cidOf(b.refBy); if (b.refBy && rc && rc !== id) { co.refBy = rc; await saveCompany(co); refRes = await refRegister(rc, co); }
    return json({ ok: true, cid: id, pin, link: APP_URL + '?c=' + id, ref: refRes });
  }
  if (!cid) return json({ ok: false, msg: 'Kompaniya tanlanmagan' }, 400);
  const co = await company(cid, true); if (!co) return json({ ok: false, msg: 'Kompaniya topilmadi' }, 404);
  if (ep === 'company') return json(await ownerCompany(co));
  if (ep === 'msg') {
    const text = String(b.text || '').trim().slice(0, 500);
    if (text) co.msg = { text, to: b.to === 'admin' ? 'admin' : 'all', t: Date.now(), until: Number(b.days) > 0 ? Date.now() + Number(b.days) * DAY : 0 }; else delete co.msg;
    await saveCompany(co); await ev(cid, 'owner', 'egasi', text ? 'E’lon: ' + text.slice(0, 80) : 'E’lon o‘chirildi');
    return json({ ok: true, co });
  }
  if (ep === 'today') return json(await ownerToday(co));
  if (ep === 'photo') {
    const m = String(q.get('m') || b.m || ''), rid = String(q.get('rid') || b.rid || ''), a = q.get('a') === 'out' ? 'out' : 'in';
    if (!/^\d{4}-\d{2}$/.test(m) || !/^[A-Za-z0-9_-]{2,60}$/.test(rid)) return json({ ok: false }, 400);
    return json({ ok: true, ph: await sGet(T(cid, `hodim_photos/${m}/${rid}/${a}`)) });
  }
  if (ep === 'faceph') { const eid = String(q.get('eid') || ''); if (!/^[A-Za-z0-9_-]{1,40}$/.test(eid)) return json({ ok: false }, 400); return json({ ok: true, ph: await dbGet(cid, '/hodim_face_ph/' + eid) }); }
  if (ep === 'feat') {
    const f = b.feat || {};
    co.feat = { face: f.face !== false, gps: f.gps !== false, offline: f.offline !== false };
    await saveCompany(co); await ev(cid, 'owner', 'egasi', 'Funksiyalar: ' + ['face', 'gps', 'offline'].map(k => k + (co.feat[k] ? ' ✅' : ' ⛔')).join(', '));
    return json({ ok: true, co });
  }
  if (ep === 'impersonate') {
    const tok = await mintToken('admin', 'admin', cid, 2);
    await ev(cid, 'owner', 'egasi', 'Egasi admin sifatida kirdi');
    return json({ ok: true, url: APP_URL + '?c=' + cid + '#own=' + tok });
  }
  if (ep === 'revoke') { co.revokeAt = Date.now(); await saveCompany(co); await ev(cid, 'owner', 'egasi', 'Barcha telefonlar chiqarildi (qayta PIN bilan kirish kerak)'); return json({ ok: true, co }); }
  if (ep === 'review') {
    const m = String(b.m || ''), rid = String(b.rid || ''), a = b.a === 'out' ? 'out' : 'in', v = b.v === 'no' ? 'no' : 'ok';
    if (!/^\d{4}-\d{2}$/.test(m) || !/^[A-Za-z0-9_-]{2,60}$/.test(rid)) return json({ ok: false }, 400);
    const r = await sGet(T(cid, `hodim/rec/${m}/${rid}`)); if (!r) return json({ ok: false, msg: 'Yozuv topilmadi (o‘chirilgan bo‘lishi mumkin)' });
    r.rv = { ...(r.rv || {}), [a]: v }; await sSet(T(cid, `hodim/rec/${m}/${rid}`), r); await logChanges(cid, [`hodim/rec/${m}/${rid}`]);
    await ev(cid, 'owner', 'egasi', `Shubhali belgi ${v === 'ok' ? 'tasdiqlandi' : 'rad etildi'} (${r.date} ${a === 'in' ? r.inTime : r.outTime})`);
    return json({ ok: true, rec: r });
  }
  if (ep === 'resetface') {
    const eid = String(b.eid || ''); if (!/^[A-Za-z0-9_-]{1,40}$/.test(eid)) return json({ ok: false }, 400);
    await dbDel(cid, '/hodim_face/' + eid); await dbDel(cid, '/hodim_face_ph/' + eid);
    await ev(cid, 'owner', 'egasi', 'Yuz namunasi o‘chirildi: ' + eid); return json({ ok: true });
  }

  if (ep === 'save') {
    const p = b.patch || {};
    for (const k of ['name', 'phone', 'note']) if (p[k] != null) co[k] = String(p[k]).slice(0, k === 'note' ? 300 : 80);
    for (const k of ['price', 'maxEmp']) if (p[k] != null) co[k] = Math.max(0, Number(p[k]) || 0);
    for (const k of ['trialEnd', 'paidUntil']) if (p[k] != null) co[k] = p[k] ? Date.parse(p[k] + 'T23:59:59+05:00') || 0 : 0;
    if (p.cur && ['UZS', 'RUB', 'USD', 'KZT', 'EUR'].includes(p.cur)) co.cur = p.cur;
    if (p.blocked != null) { if (!!p.blocked !== !!co.blocked) await ev(cid, 'owner', 'egasi', p.blocked ? '⛔ Kompaniya bloklandi' : 'Kompaniya blokdan chiqarildi'); co.blocked = !!p.blocked; }
    await saveCompany(co);
    return json({ ok: true, co, sub: subState(co) });
  }
  if (ep === 'pay') {
    const months = Math.max(1, Math.min(36, Number(b.months) || 1)), base = Math.max(Date.now(), co.paidUntil || 0, co.trialEnd || 0);
    const until = new Date(base); until.setMonth(until.getMonth() + months);
    co.paidUntil = until.getTime(); co.blocked = false;
    (co.payments = co.payments || []).unshift({ t: Date.now(), months, amount: Number(b.amount) || (co.price || 0) * months, cur: co.cur, until: co.paidUntil });
    co.payments = co.payments.slice(0, 60);
    await saveCompany(co);
    await ev(cid, 'owner', 'egasi', `💵 To‘lov: ${months} oy · ${co.payments[0].amount} ${co.cur}`);
    await refOnPaid(co, co.payments[0].amount);
    return json({ ok: true, co, sub: subState(co) });
  }
  if (ep === 'resetpin') {
    const pin = randPin();
    await dbPut(cid, '/hodim_admin', { pinHash: await sha256hex('hodim:' + pin) });
    await dbDel(cid, '/hodim_sec/fail/admin');
    await ev(cid, 'owner', 'egasi', 'Admin PIN yangilandi');
    return json({ ok: true, pin });
  }
  if (ep === 'backup') {
    const dump = await tenantDump(cid);
    return new Response(JSON.stringify(dump), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="hodim-${cid}-${dump.date}.json"` } });
  }
  if (ep === 'restore') {
    if (b.confirm !== cid) return json({ ok: false, msg: 'Tasdiqlash uchun kompaniya kodini to‘g‘ri yozing' });
    const d = b.dump; if (!d || d.app !== 'HODIM' || !d.hodim) return json({ ok: false, msg: 'Bu HODIM zaxira fayli emas' });
    const keepPush = await dbGet(cid, '/hodim/push');
    const pre = `c/${cid}/`;
    await ENV.DB.prepare("DELETE FROM docs WHERE k>=? AND k<? AND k NOT LIKE ? AND k NOT LIKE ?").bind(pre, pre + '￿', pre + 'hodim_photos/%', pre + 'hodim_sec/%').run();
    const H = d.hodim; if (keepPush && keepPush.subs) H.push = { ...(H.push || {}), subs: keepPush.subs };
    await sSet(T(cid, 'hodim'), H);
    for (const k of ['hodim_admin', 'hodim_bio', 'hodim_av', 'hodim_pay', 'hodim_pins', 'hodim_face']) if (d[k]) await sSet(T(cid, k), d[k]);
    await ev(cid, 'owner', 'egasi', 'Zaxiradan tiklandi');
    await logChanges(cid, ['hodim', 'hodim_pay', 'hodim_pins']);
    let n = 0; for (const mon of Object.values(H.rec || {})) n += Object.keys(mon || {}).length;
    return json({ ok: true, msg: `✅ Tiklandi: ${Object.values(H.employees || {}).length} xodim, ${n} ta davomat yozuvi` });
  }
  if (ep === 'delete') {
    if (cid === 'main') return json({ ok: false, msg: 'Asosiy kompaniyani o‘chirib bo‘lmaydi' });
    if (b.confirm !== cid) return json({ ok: false, msg: 'Tasdiqlash uchun kompaniya kodini to‘g‘ri yozing' });
    const pre = `c/${cid}/`;
    await ENV.DB.batch([
      ENV.DB.prepare('DELETE FROM docs WHERE k>=? AND k<?').bind(pre, pre + '￿'),
      ENV.DB.prepare('DELETE FROM companies WHERE cid=?').bind(cid),
      ENV.DB.prepare('DELETE FROM changes WHERE cid=?').bind(cid),
      ENV.DB.prepare('DELETE FROM logs WHERE cid=?').bind(cid),
      ENV.DB.prepare('DELETE FROM ev WHERE cid=?').bind(cid),
      ENV.DB.prepare('DELETE FROM stat WHERE cid=?').bind(cid),
      ENV.DB.prepare('DELETE FROM pay WHERE cid=?').bind(cid)]);
    await ev('*', 'owner', 'egasi', 'Kompaniya o‘chirildi: ' + cid);
    coCache.delete(cid);
    return json({ ok: true });
  }
  return json({ ok: false, msg: 'Noma’lum amal' }, 404);
}
function randPin() { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(100000 + a[0] % 900000); }
async function monthRecs(cid, m) {
  const base = `c/${cid}/hodim/rec/${m}/`;
  const rs = await ENV.DB.prepare('SELECT v FROM docs WHERE k>=? AND k<?').bind(base, base + '￿').all();
  return rs.results.map(r => { try { return JSON.parse(r.v); } catch (e) { return null; } }).filter(Boolean);
}
const empList = v => (Array.isArray(v) ? v : Object.values(v || {})).filter(Boolean);
async function ownerOverview() {
  const { date } = nowT(), list = [], tot = { companies: 0, active: 0, trial: 0, off: 0, employees: 0, today: 0, sus: 0, offl: 0, mrr: {}, paidMonth: {} };
  const wk = new Date(Date.parse(date) - 6 * DAY).toISOString().slice(0, 10);
  const [stT, stW, errs, act] = await Promise.all([
    ENV.DB.prepare('SELECT cid,k,n FROM stat WHERE d=?').bind(date).all(),
    ENV.DB.prepare("SELECT cid,SUM(n) AS n FROM stat WHERE d>=? AND k='sus' GROUP BY cid").bind(wk).all(),
    ENV.DB.prepare('SELECT cid, COUNT(*) AS n FROM logs WHERE t>? GROUP BY cid').bind(Date.now() - 7 * DAY).all(),
    ENV.DB.prepare('SELECT cid, MAX(t) AS t FROM changes GROUP BY cid').all()]);
  const ST = {}; for (const r of stT.results) (ST[r.cid] = ST[r.cid] || {})[r.k] = r.n;
  const SW = Object.fromEntries(stW.results.map(r => [r.cid, r.n])), ER = Object.fromEntries(errs.results.map(r => [r.cid, r.n])), AC = Object.fromEntries(act.results.map(r => [r.cid, r.t]));
  const mNow = date.slice(0, 7);
  for (const co of await companies()) {
    const s = subState(co), emps = empList(await dbGet(co.cid, '/hodim/employees')), x = ST[co.cid] || {};
    list.push({ cid: co.cid, name: co.name, phone: co.phone || '', price: co.price || 0, cur: co.cur || 'UZS', maxEmp: co.maxEmp || 0, created: co.created, blocked: !!co.blocked, trialEnd: co.trialEnd || 0, paidUntil: co.paidUntil || 0,
      sub: s, employees: emps.length, today: x.in || 0, todaySus: x.sus || 0, todayOff: x.off || 0, sus7: SW[co.cid] || 0, errors7: ER[co.cid] || 0,
      lastActive: Math.max(AC[co.cid] || 0, (co.stats && co.stats.last) || 0), lastAdmin: (co.stats && co.stats.lastAdmin) || 0, feat: co.feat || {}, msg: co.msg || null, payments: (co.payments || []).slice(0, 24) });
    tot.companies++; tot.employees += emps.length; tot.today += x.in || 0; tot.sus += x.sus || 0; tot.offl += x.off || 0;
    if (!s.ok) tot.off++; else if (s.trial) tot.trial++; else { tot.active++; if (co.cid !== 'main' && co.price) tot.mrr[co.cur || 'UZS'] = (tot.mrr[co.cur || 'UZS'] || 0) + co.price; }
    for (const p of co.payments || []) { const pm = new Date(p.t + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 7); if (pm === mNow) tot.paidMonth[p.cur || 'UZS'] = (tot.paidMonth[p.cur || 'UZS'] || 0) + (Number(p.amount) || 0); }
  }
  const pw = await ENV.DB.prepare("SELECT COUNT(*) AS n FROM pay WHERE st='wait'").first(); tot.payWait = (pw && pw.n) || 0; tot.leadNew = ((await metaGetJ('leads')) || []).filter(x => x.st === 'new').length;
  return { ok: true, list, tot, now: Date.now(), settings: (await metaGetJ('owner_settings')) || { contact: '', trialDays: 7, price: 120000, cur: 'UZS', maxEmp: 10 }, gmsg: await metaGetJ('owner_msg'), tg: !!((await metaGetJ('owner_tg')) || {}).chat };
}
// Kompaniyaning bugungi holati: kim keldi, qachon, shubhali belgilar, masofa, yuz o'xshashligi
async function ownerToday(co) {
  const cid = co.cid, { date } = nowT(), m = date.slice(0, 7);
  const emps = empList(await dbGet(cid, '/hodim/employees'));
  const recs = (await monthRecs(cid, m)).filter(r => r.date === date || (!r.outTime && r.date >= new Date(Date.parse(date) - DAY).toISOString().slice(0, 10)));
  const base = `c/${cid}/hodim_ck/${m}/`;
  const cks = recs.length ? await ENV.DB.prepare(`SELECT k, v FROM docs WHERE k IN (${recs.map(() => '?').join(',')})`).bind(...recs.map(r => base + r.id)).all() : { results: [] };
  const CK = Object.fromEntries(cks.results.map(r => [r.k.slice(base.length), JSON.parse(r.v)]));
  const faces = await ENV.DB.prepare('SELECT k FROM docs WHERE k>=? AND k<?').bind(`c/${cid}/hodim_face/`, `c/${cid}/hodim_face/￿`).all();
  const FR = new Set(faces.results.map(r => r.k.split('/').pop()));
  const rows = emps.map(e => {
    const rr = recs.filter(r => r.employeeId === e.id).sort((a, b) => (a.inTime || '').localeCompare(b.inTime || ''));
    return { id: e.id, name: e.name, role: e.role || '', face: FR.has(e.id), recs: rr.map(r => ({ ...r, ck: CK[r.id] || null, m })) };
  });
  return { ok: true, date, rows };
}
async function ownerCompany(co) {
  const cid = co.cid, { date } = nowT(), m = date.slice(0, 7), pm = new Date(Date.parse(m + '-01') - DAY).toISOString().slice(0, 7);
  const [empsRaw, st, pushSubs, tgD, bk] = await Promise.all([dbGet(cid, '/hodim/employees'), dbGet(cid, '/hodim/settings'), sGet(T(cid, 'hodim/push/subs'), { shallow: true }), dbGet(cid, '/hodim/push/tg'), dbGet(cid, '/hodim/push/backup')]);
  const emps = empList(empsRaw), S = st || {};
  const recs = (await monthRecs(cid, pm)).concat(await monthRecs(cid, m));
  const start = e => e.workStart || S.workStart || '08:00';
  const byId = Object.fromEntries(emps.map(e => [e.id, e]));
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.parse(date) - i * DAY).toISOString().slice(0, 10), dow = new Date(d + 'T12:00:00Z').getUTCDay();
    const rr = recs.filter(r => r.date === d && r.inTime);
    const late = rr.filter(r => { const e = byId[r.employeeId] || {}; const w = (e.week && e.week[dow]) || (S.week && S.week[dow]); const st0 = (w && w.start) || start(e); return toMin(r.inTime) - toMin(st0) > 5; }).length;
    days.push({ d, came: rr.length, late, logins: ((co.stats && co.stats.logins) || {})[d] || 0 });
  }
  const size = await ENV.DB.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(v)) AS b FROM docs WHERE k>=? AND k<?').bind(`c/${cid}/`, `c/${cid}/￿`).first();
  const logs = await ENV.DB.prepare('SELECT * FROM logs WHERE cid=? ORDER BY id DESC LIMIT 50').bind(cid).all();
  const devIssues = recs.filter(r => r.devIn || r.devOut).length;
  const susEv = await ENV.DB.prepare("SELECT id,t,who,msg FROM ev WHERE cid=? AND k='sus' ORDER BY id DESC LIMIT 150").bind(cid).all();
  const RV = Object.fromEntries(recs.map(r => [r.id, r]));
  const sus = susEv.results.map(x => { let o = {}; try { o = JSON.parse(x.msg); } catch (e) { } const r = RV[o.rid]; return { id: x.id, t: x.t, who: x.who, ...o, rv: r && r.rv ? r.rv[o.a] || '' : '', gone: !r }; });
  const faceN = await ENV.DB.prepare('SELECT COUNT(*) AS n FROM docs WHERE k>=? AND k<?').bind(`c/${cid}/hodim_face/`, `c/${cid}/hodim_face/￿`).first();
  return { ok: true, co, sub: subState(co), link: APP_URL + '?c=' + cid, settings: { company: S.company || '', currency: S.currency || 'UZS', workStart: S.workStart || '', workEnd: S.workEnd || '', branches: (S.branches || []).length },
    employees: emps.map(e => ({ id: e.id, name: e.name, role: e.role || '', branch: e.branch || '' })), devices: Object.keys(pushSubs || {}).length,
    tg: !!(tgD && tgD.chat), backup: bk && bk.chat ? { title: bk.title || '', last: bk.last || '' } : null, days, size: { rows: (size && size.n) || 0, kb: Math.round(((size && size.b) || 0) / 1024) },
    logs: logs.results, devIssues, sus, faces: (faceN && faceN.n) || 0, feat: co.feat || {}, msg: co.msg || null };
}

const OWNER_HTML = "<!doctype html><html lang=\"uz\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<meta name=\"robots\" content=\"noindex,nofollow\"><title>HODIM — Egasi paneli</title>\n<style>\n:root{--bg:#060c24;--card:rgba(255,255,255,.06);--line:rgba(130,205,255,.22);--txt:#eef4ff;--mut:#9fb3d6;--neon:#5fe3ff;--ok:#4ade80;--warn:#fbbf24;--bad:#fb7185;--blue:#2f73e8}\n*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg)}\nbody{font-family:\"Segoe UI\",Roboto,Arial,sans-serif;color:var(--txt);background:radial-gradient(900px 600px at 90% -10%,rgba(98,84,255,.35),transparent 60%),radial-gradient(800px 600px at -10% 30%,rgba(18,140,255,.25),transparent 60%),linear-gradient(160deg,#081a48,#070e2c 50%,#120f4a);background-attachment:fixed}\nbutton,input,select,textarea{font:inherit}button{cursor:pointer}\n.card{background:linear-gradient(160deg,rgba(255,255,255,.08),rgba(255,255,255,.03));border:1px solid var(--line);border-radius:18px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.35);margin-bottom:14px}\nh1{font-size:20px;margin:0}h2{font-size:18px;margin:0 0 12px}h3{font-size:15px;margin:16px 0 8px;color:#cfe3ff}\n.mut{color:var(--mut)}.small{font-size:12px}\n.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}.top .sp{flex:1}\n.btn{border:1px solid rgba(160,240,255,.7);background:linear-gradient(90deg,#1f6fe0,#4f43e0);color:#fff;border-radius:999px;padding:10px 16px;font-weight:700;box-shadow:0 0 12px rgba(95,227,255,.25)}\n.btn.g{background:rgba(255,255,255,.07);border-color:var(--line);box-shadow:none}.btn.r{background:rgba(220,50,90,.25);border-color:rgba(255,130,160,.6)}.btn.ok{background:rgba(30,160,90,.35);border-color:rgba(110,240,170,.6)}\n.btn:disabled{opacity:.5}.btn.sm{padding:7px 12px;font-size:13px}.btn.xs{padding:4px 10px;font-size:12px;box-shadow:none}\ninput,select,textarea{width:100%;padding:10px 12px;border-radius:12px;border:1px solid rgba(130,200,255,.28);background:rgba(4,14,50,.6);color:#fff;outline:none}\ninput:focus,select:focus,textarea:focus{border-color:var(--neon);box-shadow:0 0 0 3px rgba(95,227,255,.15)}\nlabel{display:block;font-size:12px;color:var(--mut);margin:10px 0 4px}\n.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}\n.kpi{margin:0}.kpi b{display:block;font-size:24px;margin-top:4px}.kpi span{font-size:12px;color:var(--mut)}.kpi.warn b{color:var(--warn)}.kpi.bad b{color:var(--bad)}.kpi.ok b{color:var(--ok)}\n.chip{display:inline-block;font-size:12px;font-weight:700;border-radius:999px;padding:3px 9px;white-space:nowrap;margin:1px 2px 1px 0}\n.c-ok{background:rgba(74,222,128,.15);color:var(--ok)}.c-tr{background:rgba(95,227,255,.15);color:var(--neon)}.c-warn{background:rgba(251,191,36,.15);color:var(--warn)}.c-bad{background:rgba(251,113,133,.15);color:var(--bad)}.c-mut{background:rgba(255,255,255,.08);color:#c9d6ee}\ntable{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px 8px;border-bottom:1px solid rgba(130,190,255,.12);text-align:left;vertical-align:middle}th{font-size:12px;color:var(--mut);font-weight:600}\ntr.row{cursor:pointer}tr.row:hover td{background:rgba(255,255,255,.04)}\n.tblwrap{overflow:auto}\n.modal{position:fixed;inset:0;background:rgba(2,6,24,.75);display:none;align-items:flex-start;justify-content:center;padding:24px 12px;overflow:auto;z-index:20}.modal.show{display:flex}\n.mbox{width:min(100%,920px);background:linear-gradient(160deg,#0f1d4d,#0a1236);border:1px solid var(--line);border-radius:20px;padding:18px}\n.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.tabs button{border:1px solid var(--line);background:rgba(255,255,255,.05);color:#b9cbea;border-radius:999px;padding:8px 14px;font-weight:700}.tabs button.on{background:linear-gradient(90deg,#1f8bff,#5b4dff);color:#fff;border-color:rgba(160,240,255,.9)}\n.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}\n.bars{display:flex;align-items:flex-end;gap:3px;height:140px;padding:8px 0;border-bottom:1px solid var(--line)}.bars div{flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:1px;min-width:0}\n.bars i{display:block;border-radius:3px 3px 0 0}.bars .a{background:linear-gradient(#5fe3ff,#2f73e8)}.bars .l{background:#fbbf24}\n.legend{display:flex;gap:14px;font-size:12px;color:var(--mut);margin-top:6px;flex-wrap:wrap}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}\n.list>div{padding:9px 0;border-bottom:1px solid rgba(130,190,255,.12);font-size:13px}.list>div:last-child{border:0}\n.log{font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word}\n.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(20,44,110,.95);border:1px solid var(--line);padding:12px 18px;border-radius:14px;z-index:40;display:none}\n.pinbox{font-size:30px;letter-spacing:6px;font-weight:800;text-align:center;padding:14px;border-radius:14px;background:rgba(95,227,255,.1);border:1px dashed var(--neon);margin:10px 0}\n.row2{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}\n#login{max-width:400px;margin:12vh auto 0}\n/* tuzilma: chap menyu + kontent */\n.shell{display:grid;grid-template-columns:230px 1fr;min-height:100vh}\n.side{position:sticky;top:0;height:100vh;padding:18px 12px;border-right:1px solid var(--line);background:rgba(3,10,40,.55);backdrop-filter:blur(8px);display:flex;flex-direction:column;gap:4px}\n.side .brand{font-weight:800;font-size:17px;padding:4px 10px 14px}.side .brand small{display:block;font-size:11px;color:var(--mut);font-weight:600}\n.nav{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;background:transparent;color:#c4d3f0;padding:10px 12px;border-radius:12px;font-weight:700;font-size:14px}\n.nav:hover{background:rgba(255,255,255,.06)}.nav.on{background:linear-gradient(90deg,rgba(31,139,255,.35),rgba(91,77,255,.25));color:#fff;box-shadow:inset 0 0 0 1px rgba(160,240,255,.35)}\n.nav .cnt{margin-left:auto;font-size:11px;background:var(--bad);color:#fff;border-radius:999px;padding:1px 7px}\n.side .sp{flex:1}\n.main{padding:18px 18px 70px;max-width:1250px;width:100%}\n.sec{display:none}.sec.on{display:block}\n.ev{display:flex;gap:10px;align-items:flex-start}.ev .ic{font-size:18px;line-height:1.2;width:24px;text-align:center}.ev .bd{flex:1;min-width:0}.ev .tm{font-size:11px;color:var(--mut);white-space:nowrap}\n.alert{border-left:4px solid var(--warn);padding:10px 12px;background:rgba(251,191,36,.08);border-radius:10px;margin-bottom:8px;font-size:13px}.alert.bad{border-color:var(--bad);background:rgba(251,113,133,.08)}\n.thumb{width:54px;height:54px;border-radius:10px;object-fit:cover;border:1px solid var(--line);background:#0b1640;cursor:pointer;display:inline-block;vertical-align:middle}\n.ph{display:inline-flex;align-items:center;justify-content:center;width:54px;height:54px;border-radius:10px;border:1px dashed var(--line);font-size:11px;color:var(--mut);cursor:pointer;vertical-align:middle}\n.sw{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;border-bottom:1px solid rgba(130,190,255,.12)}.sw:last-child{border:0}\n.tog{position:relative;width:52px;height:30px;flex:none}.tog input{opacity:0;width:0;height:0}.tog i{position:absolute;inset:0;border-radius:999px;background:#2a3557;transition:.2s}.tog i:before{content:\"\";position:absolute;width:24px;height:24px;left:3px;top:3px;border-radius:50%;background:#fff;transition:.2s}.tog input:checked+i{background:#22a35a}.tog input:checked+i:before{transform:translateX(22px)}\n#bigph{max-width:min(92vw,520px);max-height:80vh;border-radius:16px;border:1px solid var(--line)}\n.mnav{display:none}\n@media(max-width:860px){.shell{grid-template-columns:1fr}.side{display:none}.mnav{display:flex;gap:6px;overflow:auto;padding:10px 12px;position:sticky;top:0;z-index:5;background:rgba(3,10,40,.9);border-bottom:1px solid var(--line)}.mnav .nav{white-space:nowrap;width:auto;padding:8px 12px}.main{padding:14px 12px 70px}}\n@media(max-width:640px){.g2,.g3{grid-template-columns:1fr}td.hm,th.hm{display:none}}\n</style></head><body>\n<div id=\"login\" class=\"card\" style=\"display:none\">\n  <h1>🔐 HODIM — Egasi paneli</h1><p class=\"mut small\">Bu sahifa faqat platforma egasi uchun. Parol — Cloudflare’dagi <b>OWNER_KEY</b>.</p>\n  <label>Parol</label><input id=\"key\" type=\"password\" autocomplete=\"current-password\">\n  <button class=\"btn\" id=\"go\" style=\"width:100%;margin-top:12px\">Kirish</button><div id=\"lmsg\" class=\"small\" style=\"margin-top:8px;color:var(--bad)\"></div>\n</div>\n<div id=\"app\" style=\"display:none\">\n <div class=\"mnav\" id=\"mnav\"></div>\n <div class=\"shell\">\n  <aside class=\"side\" id=\"side\"></aside>\n  <main class=\"main\">\n   <!-- UMUMIY -->\n   <section class=\"sec on\" id=\"s-dash\">\n    <div class=\"top\"><div><h1>📊 Umumiy holat</h1><div class=\"mut small\" id=\"upd\"></div></div><div class=\"sp\"></div><button class=\"btn g sm\" data-ref>↻ Yangilash</button><button class=\"btn sm\" data-new>+ Yangi kompaniya</button></div>\n    <div class=\"kpis\" id=\"kpis\"></div>\n    <div class=\"g2\"><div class=\"card\"><h2>🔔 Diqqat talab qiladi</h2><div id=\"attn\"></div></div>\n    <div class=\"card\"><div class=\"top\" style=\"margin:0 0 6px\"><h2 style=\"margin:0\">📡 So‘nggi voqealar</h2><div class=\"sp\"></div><button class=\"btn g xs\" data-go=\"feed\">Hammasi →</button></div><div id=\"miniFeed\" class=\"list\"></div></div></div>\n   </section>\n   <!-- KOMPANIYALAR -->\n   <section class=\"sec\" id=\"s-cos\">\n    <div class=\"top\"><h1>🏢 Kompaniyalar</h1><div class=\"sp\"></div><button class=\"btn sm\" data-new>+ Yangi kompaniya</button></div>\n    <div class=\"card\"><div class=\"top\" style=\"margin:0 0 8px\"><input id=\"q\" placeholder=\"Qidirish: nom, kod, telefon…\" style=\"max-width:300px\"><select id=\"flt\" style=\"max-width:200px\"><option value=\"\">Hammasi</option><option value=\"ok\">To‘lagan</option><option value=\"trial\">Sinovda</option><option value=\"soon\">Muddati yaqin (≤3 kun)</option><option value=\"off\">To‘xtatilgan</option><option value=\"sus\">Shubhali belgisi bor</option></select></div>\n    <div class=\"tblwrap\"><table><thead><tr><th>Kompaniya</th><th>Holat</th><th>Xodim</th><th class=\"hm\">Bugun keldi</th><th class=\"hm\">⚠️ 7 kun</th><th class=\"hm\">Oxirgi faollik</th><th class=\"hm\">Narx</th><th class=\"hm\">Xato</th></tr></thead><tbody id=\"tb\"></tbody></table></div></div>\n   </section>\n   <!-- TO'LOVLAR -->\n   <section class=\"sec\" id=\"s-pay\">\n    <div class=\"top\"><h1>💳 To‘lovlar</h1><div class=\"sp\"></div><button class=\"btn g sm\" onclick=\"loadPay()\">↻ Yangilash</button></div>\n    <p class=\"mut small\">Mijoz obuna tugaganda ilovada sizning kartangizga o‘tkazma qiladi va chek rasmini yuboradi. Chekni tekshirib «✅ Tasdiqlash» ni bosing — obuna darhol uzayadi. Karta raqami va aloqa: ⚙️ Sozlamalar.</p>\n    <div class=\"card\"><div id=\"payList\" class=\"list\"></div></div>\n   </section>\n   <section class=\"sec\" id=\"s-lead\">\n    <div class=\"top\"><h1>📥 Arizalar</h1><div class=\"sp\"></div><button class=\"btn g sm\" onclick=\"loadLeads()\">↻ Yangilash</button></div>\n    <p class=\"mut small\">Mijozlar taklif havolasi (…/join) orqali qoldirgan arizalar. «➕ Kompaniya ochish» — ma'lumotlar va kim taklif qilgani avtomatik to‘ldiriladi. Yangi ariza Telegram'ingizga ham keladi.</p>\n    <div class=\"card\"><div id=\"leadList\" class=\"list\"></div></div>\n   </section>\n   <!-- JONLI LENTA -->\n   <section class=\"sec\" id=\"s-feed\">\n    <div class=\"top\"><h1>📡 Jonli lenta</h1><span class=\"chip c-ok\" id=\"liveDot\">● jonli</span><div class=\"sp\"></div>\n     <select id=\"fCo\" style=\"max-width:220px\"></select><select id=\"fK\" style=\"max-width:200px\"><option value=\"\">Barcha voqealar</option><option value=\"mark\">✅ Kelish/ketish</option><option value=\"sus\">⚠️ Shubhali</option><option value=\"login\">🔑 Kirishlar</option><option value=\"admin\">🛠 Admin amallari</option><option value=\"owner\">👑 Egasi amallari</option></select></div>\n    <div class=\"card\"><div id=\"feed\" class=\"list\"></div><div class=\"row2\"><button class=\"btn g sm\" id=\"feedMore\">Yana yuklash</button></div></div>\n   </section>\n   <!-- SHUBHALILAR -->\n   <section class=\"sec\" id=\"s-sus\">\n    <div class=\"top\"><h1>⚠️ Shubhali belgilar</h1><div class=\"sp\"></div><select id=\"sCo\" style=\"max-width:240px\"></select></div>\n    <p class=\"mut small\">Joylashuv, yuz yoki vaqt tekshiruvidan o‘tmagan barcha belgilar. Har bir kompaniya admini ham o‘z ilovasida ko‘radi. Kompaniyani bosib — surat va tafsilotlarni ko‘ring.</p>\n    <div class=\"card\"><div id=\"susList\" class=\"list\"></div><div class=\"row2\"><button class=\"btn g sm\" id=\"susMore\">Yana yuklash</button></div></div>\n   </section>\n   <!-- DAROMAD -->\n   <section class=\"sec\" id=\"s-rev\">\n    <div class=\"top\"><h1>💰 Daromad</h1></div>\n    <div class=\"kpis\" id=\"revK\"></div>\n    <div class=\"card\"><h2>Oylar bo‘yicha tushum (12 oy)</h2><div id=\"revBars\"></div></div>\n    <div class=\"g2\"><div class=\"card\"><h2>⏳ Yaqin to‘lovlar</h2><div id=\"revSoon\" class=\"list\"></div></div><div class=\"card\"><h2>🧾 So‘nggi to‘lovlar</h2><div id=\"revLast\" class=\"list\"></div></div></div>\n   </section>\n   <!-- XATOLAR -->\n   <section class=\"sec\" id=\"s-err\">\n    <div class=\"top\"><h1>🐞 Ilovadagi xatolar</h1><div class=\"sp\"></div><button class=\"btn r sm\" id=\"eClr\">Hammasini tozalash</button></div>\n    <div class=\"card\"><div id=\"eList\" class=\"list\"></div></div>\n   </section>\n   <!-- SOZLAMALAR -->\n   <section class=\"sec\" id=\"s-set\">\n    <div class=\"top\"><h1>⚙️ Sozlamalar</h1></div>\n    <div class=\"g2\">\n     <div class=\"card\"><h2>📞 Aloqa va odatiy narxlar</h2>\n      <label>Mijozlar uchun aloqa (obuna tugaganda ilovada ko‘rinadi)</label><input id=\"sContact\" placeholder=\"Masalan: +998 90 123 45 67 · @telegram\">\n      <div class=\"g2\"><div><label>Bepul sinov (kun)</label><input id=\"sTrial\" type=\"number\" min=\"0\"></div><div><label>Maksimal xodim</label><input id=\"sMax\" type=\"number\" min=\"0\"></div></div>\n      <div class=\"g2\"><div><label>Oylik narx</label><input id=\"sPrice\" type=\"number\" min=\"0\"></div><div><label>Valyuta</label><select id=\"sCur\"><option>UZS</option><option>RUB</option><option>USD</option><option>KZT</option><option>EUR</option></select></div></div>\n      <div class=\"row2\"><button class=\"btn\" id=\"sGo\">💾 Saqlash</button></div></div>\n     <div class=\"card\"><h2>📞 Mijozlar uchun aloqa</h2>\n      <p class=\"mut small\">To‘lov oynasining pastida va «obuna tugadi» oynasida ko‘rinadi.</p>\n      <label>Telefon raqamlar (vergul bilan, 3 tagacha)</label><input id=\"sPhones\" placeholder=\"+998 90 123 45 67, +7 900 123 45 67\">\n      <label>Telegram (masalan: @hodim_admin)</label><input id=\"sTgU\" placeholder=\"@...\">\n      <h3>🎁 Taklif bonusi</h3>\n      <label>Boshqa kompaniyani olib kelgan mijozga necha kun bepul (0 = o‘chiq)</label><input id=\"sRef\" type=\"number\" min=\"0\" max=\"365\">\n      <div class=\"row2\"><button class=\"btn\" id=\"sPayGo\">💾 Saqlash</button></div></div>\n     <div class=\"card\"><h2>📲 Telegram ogohlantirishlar</h2>\n      <p class=\"mut small\">Ulansa: har kuni 21:00 da barcha kompaniyalar bo‘yicha hisobot, panelga kirilganda va noto‘g‘ri parol terilganda darhol xabar keladi.</p>\n      <div id=\"tgState\" class=\"small\" style=\"margin:8px 0\"></div>\n      <div class=\"row2\"><button class=\"btn sm\" id=\"tgCode\">1) Kod olish</button><button class=\"btn g sm\" id=\"tgCheck\">2) Ulash</button><button class=\"btn g sm\" id=\"tgTest\">🔔 Sinov</button><button class=\"btn g sm\" id=\"tgDig\">📊 Hisobotni hozir yuborish</button><button class=\"btn r sm\" id=\"tgOff\">Uzish</button></div><div id=\"tgMsg\" class=\"small\" style=\"margin-top:8px\"></div></div>\n    </div>\n    <div class=\"card\"><div class=\"top\" style=\"margin:0 0 6px\"><h2 style=\"margin:0\">💳 To‘lov qabul qilish kartalari</h2><div class=\"sp\"></div><button class=\"btn sm\" id=\"cdAdd\">+ Karta qo‘shish</button></div>\n     <p class=\"mut small\">Mijozga uning valyutasiga mos kartalar ko‘rsatiladi: so‘m — Humo/Uzcard, rubl — MIR/SBP, tenge — Kaspi, dollar/yevro — Visa/Mastercard. Bir nechta davlat bilan ishlasangiz — har biriga karta qo‘shing.</p>\n     <div id=\"cdList\" class=\"list\"></div>\n     <div id=\"cdForm\" style=\"display:none;margin-top:10px;padding:12px;border:1px dashed var(--line);border-radius:14px\">\n      <div class=\"g2\"><div><label>Karta turi / davlat</label><select id=\"cdType\"><option value=\"humo\">🇺🇿 Humo (O‘zbekiston, so‘m)</option><option value=\"uzcard\">🇺🇿 Uzcard (O‘zbekiston, so‘m)</option><option value=\"mir\">🇷🇺 MIR (Rossiya, rubl)</option><option value=\"sbp\">🇷🇺 SBP — telefon orqali (Rossiya, rubl)</option><option value=\"kaspi\">🇰🇿 Kaspi (Qozog‘iston, tenge)</option><option value=\"visa\">🌍 Visa (xalqaro)</option><option value=\"mastercard\">🌍 Mastercard (xalqaro)</option><option value=\"other\">Boshqa</option></select></div>\n      <div><label>Valyuta</label><select id=\"cdCur\"><option>UZS</option><option>RUB</option><option>KZT</option><option>USD</option><option>EUR</option></select></div></div>\n      <label id=\"cdNumL\">Karta raqami</label><input id=\"cdNum\" inputmode=\"numeric\" placeholder=\"8600 1234 5678 9012\"><div id=\"cdChk\" class=\"small\" style=\"margin-top:4px\"></div>\n      <div class=\"g2\"><div><label>Karta egasi</label><input id=\"cdHold\" placeholder=\"SARDOR ALIYEV\"></div><div><label>Bank (ixtiyoriy)</label><input id=\"cdBank\" placeholder=\"Masalan: Kapitalbank, Sberbank\"></div></div>\n      <label>Izoh mijozga (ixtiyoriy)</label><input id=\"cdNote\" placeholder=\"Masalan: izohga kompaniya nomini yozing\">\n      <div class=\"row2\"><button class=\"btn\" id=\"cdSave\">💾 Kartani saqlash</button><button class=\"btn g\" id=\"cdCancel\">Bekor qilish</button></div></div>\n    </div>\n    <div class=\"card\"><h2>📢 Barcha mijozlarga e’lon</h2><p class=\"mut small\">Barcha kompaniyalar ilovasining tepasida chiqadi (masalan: «Ertaga 22:00–23:00 texnik ishlar»).</p>\n     <textarea id=\"gText\" rows=\"2\" placeholder=\"E’lon matni (bo‘sh qoldirib saqlasangiz — o‘chadi)\"></textarea>\n     <div class=\"g2\"><div><label>Kimga</label><select id=\"gTo\"><option value=\"all\">Hammaga (admin va xodimlar)</option><option value=\"admin\">Faqat adminlarga</option></select></div><div><label>Necha kun turadi (0 = o‘chirguncha)</label><input id=\"gDays\" type=\"number\" min=\"0\" value=\"0\"></div></div>\n     <div class=\"row2\"><button class=\"btn\" id=\"gGo\">📢 Saqlash</button></div></div>\n    <div class=\"card\"><h2>🗄 Zaxira va xavfsizlik</h2>\n     <div class=\"row2\" style=\"margin-top:0\"><button class=\"btn g\" id=\"expAll\">⬇️ Barcha kompaniyalar zaxirasi (.json)</button></div>\n     <p class=\"mut small\">Parolni almashtirish: Cloudflare → Worker → Settings → Variables and Secrets → <b>OWNER_KEY</b> → yangi qiymat → Deploy. Shundan so‘ng hamma eski kirishlar 12 soat ichida tugaydi.</p></div>\n   </section>\n  </main>\n </div>\n</div>\n<div class=\"modal\" id=\"mCo\"><div class=\"mbox\" id=\"coBox\"></div></div>\n<div class=\"modal\" id=\"mPh\"><div style=\"text-align:center\"><img id=\"bigph\" alt=\"\"><div class=\"row2\" style=\"justify-content:center\"><button class=\"btn g\" data-close>Yopish</button></div></div></div>\n<div class=\"modal\" id=\"mNew\"><div class=\"mbox\" style=\"max-width:560px\" id=\"newBox\"></div></div>\n<div class=\"toast\" id=\"toast\"></div>\n<script>\nconst $=id=>document.getElementById(id);let TOK=sessionStorage.getItem('HODIM_OWNER')||'',DATA=null,CUR=null,SEC='dash';\nconst esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\nconst fmt=n=>Number(n||0).toLocaleString('ru-RU').replace(/,/g,' ');\nconst sym=c=>({UZS:'so‘m',RUB:'₽',USD:'$',KZT:'₸',EUR:'€'}[c]||c);\nconst d8=t=>t?new Date(t).toLocaleDateString('ru-RU'):'—';\nconst dt=t=>t?new Date(t).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';\nconst ago=t=>{if(!t)return'—';const m=Math.round((Date.now()-t)/60000);return m<1?'hozir':m<60?m+' daq oldin':m<1440?Math.round(m/60)+' soat oldin':Math.round(m/1440)+' kun oldin'};\nconst iso=t=>t?new Date(t+5*3600000).toISOString().slice(0,10):'';\nconst FLAG={gps_none:'📍 joylashuv aniqlanmadi',gps_far:'📍 ish joyidan uzoqda',gps_acc:'📍 GPS aniqligi past',gps_mock:'📍 soxta GPS ehtimoli',ip_far:'🌐 internet boshqa shaharda',face_none:'🙂 yuz tekshirilmadi',face_file:'🖼 surat kameradan emas',face_spoof:'🖼 soxta rasm ehtimoli',face_noblink:'👁 ko‘z qisilmadi',face_mismatch:'🙅 yuz mos emas',face_new:'🆕 yuz namunasi olindi',off_time:'📴 internetsiz, vaqt tekshirilmadi',old_app:'📱 eski ilova (tekshiruvsiz)'};\nconst flagChips=f=>(f||[]).map(x=>`<span class=\"chip ${x==='face_new'?'c-tr':x==='face_mismatch'||x==='face_spoof'||x==='gps_mock'?'c-bad':'c-warn'}\">${esc(FLAG[x]||x)}</span>`).join('');\nconst coName=cid=>cid==='*'?'Platforma':((DATA&&DATA.list.find(c=>c.cid===cid))||{}).name||cid;\nfunction toast(m){const t=$('toast');t.textContent=m;t.style.display='block';clearTimeout(t._h);t._h=setTimeout(()=>t.style.display='none',3000)}\nasync function api(ep,b,method){const r=await fetch('/owner/api/'+ep+(method==='GET'&&b?'?'+new URLSearchParams(b):''),{method:method||'POST',headers:{'Authorization':'Bearer '+TOK,'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(b||{})});\n if(r.status===401){TOK='';sessionStorage.removeItem('HODIM_OWNER');show();throw new Error('auth')}return r.json()}\nconst NAV=[['dash','📊','Umumiy'],['cos','🏢','Kompaniyalar'],['pay','💳','To‘lovlar'],['lead','📥','Arizalar'],['feed','📡','Jonli lenta'],['sus','⚠️','Shubhalilar'],['rev','💰','Daromad'],['err','🐞','Xatolar'],['set','⚙️','Sozlamalar']];\nfunction navHTML(){const sc=DATA?DATA.tot.sus:0,er=DATA?DATA.list.reduce((a,c)=>a+c.errors7,0):0;\n return NAV.map(([k,i,t])=>`<button class=\"nav ${SEC===k?'on':''}\" data-go=\"${k}\">${i} ${t}${k==='sus'&&sc?`<span class=\"cnt\">${sc}</span>`:''}${k==='pay'&&DATA&&DATA.tot.payWait?`<span class=\"cnt\">${DATA.tot.payWait}</span>`:''}${k==='lead'&&DATA&&DATA.tot.leadNew?`<span class=\"cnt\">${DATA.tot.leadNew}</span>`:''}${k==='err'&&er?`<span class=\"cnt\">${er}</span>`:''}</button>`).join('')}\nfunction drawNav(){$('side').innerHTML=`<div class=\"brand\">HODIM<small>Egasi paneli</small></div>`+navHTML()+`<div class=\"sp\"></div><button class=\"nav\" id=\"bOut\">🚪 Chiqish</button>`;$('mnav').innerHTML=navHTML()+`<button class=\"nav\" onclick=\"logout()\">🚪</button>`;\n document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));const o=$('bOut');if(o)o.onclick=logout}\nfunction go(k){SEC=k;document.querySelectorAll('.sec').forEach(s=>s.classList.toggle('on',s.id==='s-'+k));drawNav();window.scrollTo(0,0);\n if(k==='feed')loadFeed(true);if(k==='pay')loadPay();if(k==='lead')loadLeads();if(k==='sus')loadSus(true);if(k==='err')loadErr();if(k==='set')drawSet();if(k==='rev')drawRev();if(k==='cos')render()}\nfunction logout(){TOK='';sessionStorage.removeItem('HODIM_OWNER');show()}\nfunction show(){$('login').style.display=TOK?'none':'block';$('app').style.display=TOK?'block':'none';if(TOK){drawNav();load()}}\n$('go').onclick=async()=>{$('lmsg').textContent='';const r=await fetch('/owner/api/login',{method:'POST',body:JSON.stringify({key:$('key').value})}).then(x=>x.json()).catch(()=>({msg:'Internet xatosi'}));\n if(r.ok){TOK=r.token;sessionStorage.setItem('HODIM_OWNER',TOK);$('key').value='';show()}else $('lmsg').textContent=r.msg||'Xato'};\n$('key').onkeydown=e=>{if(e.key==='Enter')$('go').click()};\ndocument.querySelectorAll('[data-ref]').forEach(b=>b.onclick=()=>load());\ndocument.querySelectorAll('[data-new]').forEach(b=>b.onclick=()=>openNew());\ndocument.addEventListener('click',e=>{const c=e.target.closest('[data-close]');if(c)c.closest('.modal').classList.remove('show')});\ndocument.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('show')}));\nfunction stChip(c){const s=c.sub;if(c.blocked)return'<span class=\"chip c-bad\">⛔ Bloklangan</span>';if(!s.ok)return'<span class=\"chip c-bad\">⏱ Muddati tugagan</span>';\n if(c.cid==='main')return'<span class=\"chip c-ok\">★ Asosiy</span>';if(s.trial)return`<span class=\"chip c-tr\">🎁 Sinov · ${s.left} kun</span>`;return s.left<=3?`<span class=\"chip c-warn\">⚠️ ${s.left} kun qoldi</span>`:`<span class=\"chip c-ok\">✅ Faol · ${s.left} kun</span>`}\nasync function load(){try{DATA=await api('overview',null,'GET')}catch(e){return}\n const t=DATA.tot,mrr=Object.entries(t.mrr).map(([c,v])=>fmt(v)+' '+sym(c)).join(' + ')||'0',pm=Object.entries(t.paidMonth).map(([c,v])=>fmt(v)+' '+sym(c)).join(' + ')||'0';\n $('kpis').innerHTML=[['🏢 Kompaniyalar',t.companies],['✅ To‘lagan',t.active,'ok'],['🎁 Sinovda',t.trial],['⛔ To‘xtatilgan',t.off,t.off?'bad':''],['👥 Xodimlar',t.employees],['📍 Bugun keldi',t.today],['⚠️ Bugun shubhali',t.sus,t.sus?'warn':''],['📴 Internetsiz',t.offl],['💰 Oylik daromad',mrr],['💵 Shu oy tushgan',pm]].map(([a,b,c])=>`<div class=\"card kpi ${c||''}\"><span>${a}</span><b>${b}</b></div>`).join('');\n $('upd').textContent='Yangilandi: '+new Date().toLocaleTimeString('ru-RU');\n const A=[];DATA.list.forEach(c=>{const s=c.sub;if(c.cid==='main')return;\n  if(!s.ok)A.push(['bad',`⛔ <b>${esc(c.name)}</b> — ${c.blocked?'bloklangan':'obuna tugagan'}${c.phone?' · '+esc(c.phone):''}`,c.cid]);\n  else if(s.left<=3)A.push(['',`⏳ <b>${esc(c.name)}</b> — ${s.left} kun qoldi${s.trial?' (sinov)':''}${c.phone?' · '+esc(c.phone):''}`,c.cid])});\n DATA.list.forEach(c=>{if(c.todaySus)A.push(['',`⚠️ <b>${esc(c.name)}</b> — bugun ${c.todaySus} ta shubhali belgi`,c.cid,'sus']);if(c.errors7>=5)A.push(['',`🐞 <b>${esc(c.name)}</b> — 7 kunda ${c.errors7} ta xato`,c.cid,'err'])});\n if(DATA.tot.payWait)A.unshift(['',`💳 <b>${DATA.tot.payWait} ta to‘lov</b> tasdiqlashni kutmoqda — <a href=\"#\" data-go2=\"pay\" style=\"color:var(--neon)\">ko‘rish</a>`]);\n if(!cardsFrom(DATA.settings||{}).filter(c=>!c.off).length)A.push(['',`💳 To‘lov kartasi kiritilmagan — mijozlar to‘lay olmaydi. <a href=\"#\" data-go2=\"set\" style=\"color:var(--neon)\">Sozlamalar</a>`]);\n if(!DATA.tg)A.push(['',`📲 Telegram ogohlantirishlar ulanmagan — <a href=\"#\" data-go2=\"set\" style=\"color:var(--neon)\">Sozlamalar</a>`]);\n $('attn').innerHTML=A.map(([k,t,cid,tab])=>`<div class=\"alert ${k}\" ${cid?`data-co=\"${cid}\" data-tab=\"${tab||'sub'}\" style=\"cursor:pointer\"`:''}>${t}</div>`).join('')||'<div class=\"mut\">Hammasi joyida 🎉</div>';\n $('attn').querySelectorAll('[data-co]').forEach(x=>x.onclick=()=>openCo(x.dataset.co,x.dataset.tab));$('attn').querySelectorAll('[data-go2]').forEach(x=>x.onclick=e=>{e.preventDefault();go(x.dataset.go2)});\n coSelects();drawNav();render();loadMini()}\nfunction coSelects(){const o=`<option value=\"\">Barcha kompaniyalar</option><option value=\"*\">👑 Platforma (egasi)</option>`+DATA.list.map(c=>`<option value=\"${c.cid}\">${esc(c.name)}</option>`).join('');\n for(const id of ['fCo','sCo']){const el=$(id),v=el.value;el.innerHTML=id==='sCo'?o.replace('<option value=\"*\">👑 Platforma (egasi)</option>',''):o;el.value=v}}\nfunction render(){if(!DATA)return;const q=$('q').value.trim().toLowerCase(),f=$('flt').value;\n const L=DATA.list.filter(c=>(!q||(c.name+' '+c.cid+' '+c.phone).toLowerCase().includes(q))&&(!f||(f==='ok'&&c.sub.ok&&!c.sub.trial)||(f==='trial'&&c.sub.ok&&c.sub.trial)||(f==='off'&&!c.sub.ok)||(f==='soon'&&c.sub.ok&&c.sub.left<=3&&c.cid!=='main')||(f==='sus'&&c.sus7)));\n $('tb').innerHTML=L.map(c=>`<tr class=\"row\" data-cid=\"${c.cid}\"><td><b>${esc(c.name)}</b><div class=\"mut small\">${esc(c.cid)}${c.phone?' · '+esc(c.phone):''}</div></td><td>${stChip(c)}</td><td>${c.employees}${c.maxEmp?' / '+c.maxEmp:''}</td><td class=\"hm\">${c.today}${c.todayOff?` <span class=\"chip c-mut\">📴 ${c.todayOff}</span>`:''}</td><td class=\"hm\">${c.sus7?'<span class=\"chip c-warn\">'+c.sus7+'</span>':'0'}</td><td class=\"hm\">${ago(c.lastActive)}</td><td class=\"hm\">${c.price?fmt(c.price)+' '+sym(c.cur):'—'}</td><td class=\"hm\">${c.errors7?'<span class=\"chip c-warn\">'+c.errors7+'</span>':'0'}</td></tr>`).join('')||'<tr><td colspan=\"8\" class=\"mut\">Kompaniya topilmadi</td></tr>';\n document.querySelectorAll('tr.row').forEach(r=>r.onclick=()=>openCo(r.dataset.cid))}\n$('q').oninput=render;$('flt').onchange=render;\n// --- voqealar ---\nconst EVI={mark:'✅',sus:'⚠️',login:'🔑',admin:'🛠',owner:'👑'};\nfunction evText(x){if(x.k==='mark'||x.k==='sus'){let o={};try{o=JSON.parse(x.msg)}catch(e){}return `<b>${esc(x.who)}</b> — ${o.a==='out'?'ketish':'kelish'} ${esc(o.tm||'')}${o.off?' <span class=\"chip c-mut\">📴 internetsiz</span>':''}${o.dist!=null?` <span class=\"mut small\">· ${o.dist} m</span>`:''}${o.fs!=null?` <span class=\"mut small\">· yuz ${Math.round(o.fs*100)}%</span>`:''}<div>${flagChips(o.f)}</div>`}\n return `<b>${esc(x.who)}</b> — ${esc(x.msg)}`}\nfunction evHTML(x,showCo){return `<div class=\"ev\"><div class=\"ic\">${EVI[x.k]||'•'}</div><div class=\"bd\">${showCo?`<span class=\"chip c-mut\" data-co=\"${esc(x.cid)}\" style=\"cursor:pointer\">${esc(coName(x.cid))}</span> `:''}${evText(x)}</div><div class=\"tm\">${dt(x.t)}</div></div>`}\nfunction bindCo(el){el.querySelectorAll('[data-co]').forEach(x=>x.onclick=()=>{if(x.dataset.co&&x.dataset.co!=='*')openCo(x.dataset.co)})}\nasync function loadMini(){const r=await api('feed',{limit:10},'GET').catch(()=>null);if(!r)return;$('miniFeed').innerHTML=(r.ev||[]).map(x=>`<div>${evHTML(x,true)}</div>`).join('')||'<div class=\"mut\">Hali voqea yo‘q</div>';bindCo($('miniFeed'))}\nlet FEED=[],feedTimer=null;\nasync function loadFeed(reset){const p={limit:100};if($('fCo').value)p.cid=$('fCo').value;if($('fK').value)p.k=$('fK').value;\n if(reset){FEED=[]}else if(FEED.length)p.before=FEED[FEED.length-1].id;\n const r=await api('feed',p,'GET').catch(()=>null);if(!r)return;FEED=FEED.concat(r.ev||[]);drawFeed();\n clearInterval(feedTimer);feedTimer=setInterval(pollFeed,15000)}\nasync function pollFeed(){if(SEC!=='feed'||document.visibilityState!=='visible')return;const p={limit:100,after:FEED.length?FEED[0].id:0};if($('fCo').value)p.cid=$('fCo').value;if($('fK').value)p.k=$('fK').value;\n const r=await api('feed',p,'GET').catch(()=>null);if(!r||!r.ev||!r.ev.length)return;FEED=r.ev.slice().reverse().concat(FEED);drawFeed();toast(`${r.ev.length} ta yangi voqea`)}\nfunction drawFeed(){$('feed').innerHTML=FEED.map(x=>`<div>${evHTML(x,!$('fCo').value)}</div>`).join('')||'<div class=\"mut\">Voqea yo‘q</div>';bindCo($('feed'))}\n$('fCo').onchange=()=>loadFeed(true);$('fK').onchange=()=>loadFeed(true);$('feedMore').onclick=()=>loadFeed(false);\nlet SUS=[];\nasync function loadSus(reset){const p={limit:100,k:'sus'};if($('sCo').value)p.cid=$('sCo').value;if(reset)SUS=[];else if(SUS.length)p.before=SUS[SUS.length-1].id;\n const r=await api('feed',p,'GET').catch(()=>null);if(!r)return;SUS=SUS.concat(r.ev||[]);\n $('susList').innerHTML=SUS.map(x=>`<div>${evHTML(x,!$('sCo').value)}</div>`).join('')||'<div class=\"mut\">Shubhali belgi yo‘q 🎉</div>';bindCo($('susList'))}\n$('sCo').onchange=()=>loadSus(true);$('susMore').onclick=()=>loadSus(false);\n// --- to'lovlar ---\nlet LEADS=[];\nasync function loadLeads(){const r=await api('leads',null,'GET').catch(()=>null);if(!r)return;LEADS=r.list||[];\n const st={new:'<span class=\"chip c-warn\">🆕 Yangi</span>',done:'<span class=\"chip c-ok\">✅ Ulandi</span>',no:'<span class=\"chip c-bad\">✖ Rad</span>'};\n $('leadList').innerHTML=LEADS.map(x=>`<div><div class=\"ev\"><div class=\"ic\">📥</div><div class=\"bd\"><b>${esc(x.name)}</b> ${st[x.st]||''}\n  <div class=\"mut small\">${dt(x.t)} · 📞 <a href=\"tel:${esc(x.phone)}\">${esc(x.phone)}</a>${x.person?' · 👤 '+esc(x.person):''}${x.emp?' · 👥 '+x.emp+' xodim':''}${x.city?' · '+esc(x.city):''}</div>\n  ${x.refName?`<div class=\"small\">🎁 Taklif qilgan: <b>${esc(x.refName)}</b></div>`:''}${x.cid?`<div class=\"small\">Kompaniya: <b>${esc(coName(x.cid))}</b></div>`:''}\n  <div class=\"row2\" style=\"margin-top:8px\">${x.st==='new'?`<button class=\"btn ok xs\" data-lnew=\"${x.id}\">➕ Kompaniya ochish</button><button class=\"btn g xs\" data-lst=\"${x.id}\" data-v=\"done\">✅ Bajarildi</button><button class=\"btn r xs\" data-lst=\"${x.id}\" data-v=\"no\">✖ Rad</button>`:`<button class=\"btn g xs\" data-lst=\"${x.id}\" data-v=\"new\">↩ Qaytarish</button>`}<button class=\"btn g xs\" data-ldel=\"${x.id}\">🗑</button></div></div></div></div>`).join('')||'<div class=\"mut\">Hali ariza yo‘q. Mijozlar taklif havolasini bosib ariza qoldirishadi.</div>';\n $('leadList').querySelectorAll('[data-lst]').forEach(b=>b.onclick=async()=>{await api('leaddo',{id:b.dataset.lst,st:b.dataset.v});loadLeads();load()});\n $('leadList').querySelectorAll('[data-ldel]').forEach(b=>b.onclick=async()=>{if(!confirm('Arizani o‘chirasizmi?'))return;await api('leaddo',{id:b.dataset.ldel,del:1});loadLeads();load()});\n $('leadList').querySelectorAll('[data-lnew]').forEach(b=>b.onclick=()=>{const x=LEADS.find(l=>l.id===b.dataset.lnew);openNew(x)});}\nasync function loadPay(){const r=await api('payreqs',null,'GET').catch(()=>null);if(!r)return;\n const st={wait:'<span class=\"chip c-warn\">⏳ Kutilmoqda</span>',ok:'<span class=\"chip c-ok\">✅ Tasdiqlangan</span>',no:'<span class=\"chip c-bad\">❌ Rad etilgan</span>'};\n $('payList').innerHTML=r.list.map(x=>`<div><div class=\"ev\"><div class=\"ic\">💳</div><div class=\"bd\"><b>${esc(coName(x.cid))}</b> — ${x.months} oy · <b>${fmt(x.amount)} ${sym(x.cur)}</b> ${st[x.st]||''}\n  <div class=\"mut small\">${dt(x.t)}${x.phone?' · 📞 '+esc(x.phone):''}${x.note?' · 📝 '+esc(x.note):''}${x.why?' · sabab: '+esc(x.why):''}</div>\n  <div class=\"row2\" style=\"margin-top:8px\"><button class=\"btn g xs\" data-pph=\"${x.id}\">🧾 Chekni ko‘rish</button>${x.st==='wait'?`<button class=\"btn ok xs\" data-pok=\"${x.id}\" data-m=\"${x.months}\" data-a=\"${x.amount}\">✅ Tasdiqlash</button><button class=\"btn r xs\" data-pno=\"${x.id}\">❌ Rad etish</button>`:''}</div></div></div></div>`).join('')||'<div class=\"mut\">Hali to‘lov yo‘q</div>';\n $('payList').querySelectorAll('[data-pph]').forEach(b=>b.onclick=async()=>{const x=await api('payph',{id:b.dataset.pph},'GET');if(!x.ph){toast('Rasm yo‘q');return}$('bigph').src=x.ph;$('mPh').classList.add('show')});\n $('payList').querySelectorAll('[data-pok]').forEach(b=>b.onclick=async()=>{const m=prompt('Necha oyga uzaytiramiz?',b.dataset.m);if(m===null)return;const a=prompt('Qabul qilingan summa:',b.dataset.a);if(a===null)return;\n  const x=await api('paydecide',{id:b.dataset.pok,ok:true,months:Number(m)||1,amount:Number(String(a).replace(/\\s/g,''))||0});toast(x.ok?'✅ Obuna uzaytirildi':(x.msg||'Xato'));loadPay();load()});\n $('payList').querySelectorAll('[data-pno]').forEach(b=>b.onclick=async()=>{const w=prompt('Rad etish sababi (mijozga ko‘rinadi):','Pul tushmadi');if(w===null)return;const x=await api('paydecide',{id:b.dataset.pno,ok:false,why:w});toast(x.ok?'Rad etildi':(x.msg||'Xato'));loadPay();load()})}\n// --- daromad ---\nfunction drawRev(){if(!DATA)return;const months=[];const d=new Date();for(let i=11;i>=0;i--){const x=new Date(d.getFullYear(),d.getMonth()-i,1);months.push(x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0'))}\n const by={},all=[];DATA.list.forEach(c=>(c.payments||[]).forEach(p=>{all.push({...p,name:c.name,cid:c.cid});const m=new Date(p.t+5*3600000).toISOString().slice(0,7),cu=p.cur||'UZS';(by[cu]=by[cu]||{})[m]=(by[cu][m]||0)+(Number(p.amount)||0)}));\n const t=DATA.tot;$('revK').innerHTML=[['💰 Oylik daromad (MRR)',Object.entries(t.mrr).map(([c,v])=>fmt(v)+' '+sym(c)).join(' + ')||'0'],['💵 Shu oy tushgan',Object.entries(t.paidMonth).map(([c,v])=>fmt(v)+' '+sym(c)).join(' + ')||'0'],['✅ To‘layotgan',t.active],['🎁 Sinovda',t.trial]].map(([a,b])=>`<div class=\"card kpi\"><span>${a}</span><b>${b}</b></div>`).join('');\n $('revBars').innerHTML=Object.keys(by).length?Object.entries(by).map(([cu,o])=>{const mx=Math.max(1,...months.map(m=>o[m]||0));return `<h3>${sym(cu)}</h3><div class=\"bars\">${months.map(m=>`<div title=\"${m}: ${fmt(o[m]||0)} ${sym(cu)}\"><i class=\"a\" style=\"height:${(o[m]||0)/mx*120}px\"></i></div>`).join('')}</div><div class=\"legend\"><span>${months[0]} — ${months[11]}</span><span>Eng ko‘p: ${fmt(mx)} ${sym(cu)}</span></div>`}).join(''):'<div class=\"mut\">Hali to‘lov qayd etilmagan. Kompaniya → 💳 Obuna → «+1 oy to‘landi».</div>';\n $('revSoon').innerHTML=DATA.list.filter(c=>c.cid!=='main'&&c.sub.ok).sort((a,b)=>a.sub.until-b.sub.until).slice(0,15).map(c=>`<div data-co=\"${c.cid}\" style=\"cursor:pointer\"><b>${esc(c.name)}</b> — ${d8(c.sub.until)} <span class=\"mut small\">(${c.sub.left} kun${c.sub.trial?', sinov':''})</span>${c.price?` · ${fmt(c.price)} ${sym(c.cur)}`:''}</div>`).join('')||'<div class=\"mut\">—</div>';\n $('revLast').innerHTML=all.sort((a,b)=>b.t-a.t).slice(0,20).map(p=>`<div data-co=\"${p.cid}\" style=\"cursor:pointer\">${d8(p.t)} — <b>${esc(p.name)}</b> · ${p.months} oy · ${fmt(p.amount)} ${sym(p.cur)}</div>`).join('')||'<div class=\"mut\">—</div>';\n bindCo($('revSoon'));bindCo($('revLast'))}\n// --- xatolar ---\nfunction logHTML(l){return l.length?l.map(x=>`<div><span class=\"chip ${x.kind==='app'?'c-warn':'c-bad'}\">${esc(x.kind)}</span> <b>${esc(coName(x.cid))}</b> <span class=\"mut small\">${new Date(x.t).toLocaleString('ru-RU')}</span><div class=\"log\">${esc(x.msg)}</div><div class=\"mut small\">${esc(x.extra||'')}</div></div>`).join(''):'<div class=\"mut\">Xato yo‘q 🎉</div>'}\nasync function loadErr(){const r=await api('errors',null,'GET');$('eList').innerHTML=logHTML(r.logs||[])}\n$('eClr').onclick=async()=>{if(!confirm('Barcha xatolar o‘chirilsinmi?'))return;await api('clearerrors',{});loadErr();load()};\n// --- sozlamalar ---\nfunction drawSet(){const s=DATA.settings||{};CARDS=cardsFrom(s);drawCards();$('sPhones').value=s.phones||'';$('sRef').value=s.refDays!=null?s.refDays:15;$('sTgU').value=s.tg||'';$('sContact').value=s.contact||'';$('sTrial').value=s.trialDays??7;$('sMax').value=s.maxEmp??0;$('sPrice').value=s.price??0;$('sCur').value=s.cur||'UZS';\n const g=DATA.gmsg;$('gText').value=g&&g.text||'';$('gTo').value=g&&g.to||'all';$('gDays').value=0;\n $('tgState').innerHTML=DATA.tg?'<span class=\"chip c-ok\">✅ Ulangan</span>':'<span class=\"chip c-warn\">Ulanmagan</span> — «Kod olish» ni bosing, kodni botga (@Hodim_sanicore_bot) yuboring va «Ulash» ni bosing.'}\n$('sPayGo').onclick=async()=>{const r=await api('settings',{phones:$('sPhones').value.trim(),tg:$('sTgU').value.trim(),refDays:$('sRef').value});if(r.ok){DATA.settings=r.settings;toast('Saqlandi')}};\nconst CT={humo:['Humo','#0f766e,#0e9f6e'],uzcard:['Uzcard','#1d4ed8,#0ea5e9'],mir:['MIR','#15803d,#0284c7'],sbp:['SBP','#7c3aed,#db2777'],kaspi:['Kaspi','#dc2626,#f43f5e'],visa:['Visa','#1e3a8a,#3b82f6'],mastercard:['Mastercard','#9a3412,#f59e0b'],other:['Karta','#334155,#64748b']};\nconst CTCUR={humo:'UZS',uzcard:'UZS',mir:'RUB',sbp:'RUB',kaspi:'KZT',visa:'USD',mastercard:'USD'};\nlet CARDS=[],CDE=null;\nfunction cardsFrom(s){if(Array.isArray(s.payCards))return s.payCards.slice();if(s.payCard)return[{id:'k1',type:/uzcard/i.test(s.payType||'')?'uzcard':'humo',number:s.payCard,holder:s.payHolder||'',bank:'',cur:'UZS',note:''}];return[]}\nconst luhn=n=>{const d=n.replace(/\\D/g,'');if(d.length<13)return false;let s=0;for(let i=0;i<d.length;i++){let x=+d[d.length-1-i];if(i%2){x*=2;if(x>9)x-=9}s+=x}return s%10===0};\nconst fmtCard=n=>{const d=String(n).replace(/[^\\d+]/g,'');return d.startsWith('+')?String(n):d.replace(/(\\d{4})(?=\\d)/g,'$1 ')};\nfunction drawCards(){$('cdList').innerHTML=CARDS.map((c,i)=>`<div style=\"display:flex;gap:12px;align-items:center;flex-wrap:wrap\"><div style=\"width:150px;padding:10px 12px;border-radius:12px;color:#fff;background:linear-gradient(135deg,${(CT[c.type]||CT.other)[1]});${c.off?'opacity:.45':''}\"><b style=\"font-size:12px\">${(CT[c.type]||CT.other)[0]}</b><div style=\"font-family:ui-monospace,monospace;font-size:12px;margin-top:6px\">•••• ${esc(String(c.number).replace(/\\D/g,'').slice(-4))}</div></div>\n <div style=\"flex:1;min-width:160px\"><b>${esc(fmtCard(c.number))}</b> <span class=\"chip c-mut\">${c.cur}</span>${c.off?' <span class=\"chip c-warn\">o‘chirilgan</span>':''}<div class=\"mut small\">${esc(c.holder)}${c.bank?' · '+esc(c.bank):''}${c.note?' · '+esc(c.note):''}</div></div>\n <button class=\"btn g xs\" data-cde=\"${i}\">✏️</button><button class=\"btn g xs\" data-cdo=\"${i}\">${c.off?'Yoqish':'Yashirish'}</button><button class=\"btn r xs\" data-cdd=\"${i}\">🗑</button></div>`).join('')||'<div class=\"mut\">Hali karta qo‘shilmagan — mijozlar to‘lay olmaydi.</div>';\n $('cdList').querySelectorAll('[data-cde]').forEach(b=>b.onclick=()=>cardForm(+b.dataset.cde));\n $('cdList').querySelectorAll('[data-cdo]').forEach(b=>b.onclick=()=>{const c=CARDS[+b.dataset.cdo];c.off=!c.off;saveCards()});\n $('cdList').querySelectorAll('[data-cdd]').forEach(b=>b.onclick=()=>{if(!confirm('Karta o‘chirilsinmi?'))return;CARDS.splice(+b.dataset.cdd,1);saveCards()})}\nfunction cardForm(i){CDE=i;const c=i==null?{type:'humo',cur:'UZS',number:'',holder:'',bank:'',note:''}:CARDS[i];$('cdForm').style.display='block';$('cdType').value=c.type;$('cdCur').value=c.cur;$('cdNum').value=fmtCard(c.number);$('cdHold').value=c.holder||'';$('cdBank').value=c.bank||'';$('cdNote').value=c.note||'';cdTypeUI();cdCheck();$('cdNum').focus()}\nfunction cdTypeUI(){const sbp=$('cdType').value==='sbp';$('cdNumL').textContent=sbp?'Telefon raqami (SBP)':'Karta raqami';$('cdNum').placeholder=sbp?'+7 900 123 45 67':($('cdType').value==='humo'?'9860 …':$('cdType').value==='uzcard'?'8600 …':$('cdType').value==='mir'?'2200 …':'4000 …')}\nfunction cdCheck(){const v=$('cdNum').value,el=$('cdChk');if($('cdType').value==='sbp'){el.textContent='';return}const d=v.replace(/\\D/g,'');el.style.color=d.length<16?'var(--mut)':luhn(d)?'var(--ok)':'var(--bad)';el.textContent=d.length<16?d.length+'/16 raqam':luhn(d)?'✓ Raqam to‘g‘ri':'⚠️ Raqamda xato bo‘lishi mumkin — tekshiring'}\n$('cdType').onchange=()=>{if(CTCUR[$('cdType').value])$('cdCur').value=CTCUR[$('cdType').value];cdTypeUI();cdCheck()};\n$('cdNum').oninput=()=>{const p=$('cdNum').selectionStart,before=$('cdNum').value.length;if($('cdType').value!=='sbp')$('cdNum').value=fmtCard($('cdNum').value).slice(0,23);cdCheck()};\n$('cdAdd').onclick=()=>cardForm(null);$('cdCancel').onclick=()=>{$('cdForm').style.display='none'};\n$('cdSave').onclick=()=>{const n=$('cdNum').value.trim();if(n.replace(/\\D/g,'').length<10){toast('Raqamni to‘liq kiriting');return}\n const c={id:CDE!=null?CARDS[CDE].id:'k'+Date.now().toString(36),type:$('cdType').value,cur:$('cdCur').value,number:n,holder:$('cdHold').value.trim(),bank:$('cdBank').value.trim(),note:$('cdNote').value.trim(),off:CDE!=null?!!CARDS[CDE].off:false};\n if(CDE!=null)CARDS[CDE]=c;else CARDS.push(c);$('cdForm').style.display='none';saveCards()};\nasync function saveCards(){const r=await api('settings',{payCards:CARDS});if(r.ok){DATA.settings=r.settings;CARDS=cardsFrom(r.settings);drawCards();toast('Saqlandi')}}\n$('sGo').onclick=async()=>{const r=await api('settings',{contact:$('sContact').value,trialDays:$('sTrial').value,maxEmp:$('sMax').value,price:$('sPrice').value,cur:$('sCur').value});if(r.ok){DATA.settings=r.settings;toast('Saqlandi')}};\n$('gGo').onclick=async()=>{const r=await api('gmsg',{text:$('gText').value,to:$('gTo').value,days:$('gDays').value});if(r.ok){DATA.gmsg=r.gmsg;toast(r.gmsg?'E’lon chiqdi':'E’lon o‘chirildi')}};\n$('tgCode').onclick=async()=>{const r=await api('tglink',{});$('tgMsg').innerHTML=r.ok?`Telegram’da botga shu kodni yuboring: <b style=\"font-size:16px\">${esc(r.code)}</b> — keyin «2) Ulash» ni bosing.`:esc(r.msg)};\n$('tgCheck').onclick=async()=>{const r=await api('tglink',{check:true});$('tgMsg').textContent=r.msg||'';if(r.ok){DATA.tg=true;drawSet()}};\n$('tgTest').onclick=async()=>{const r=await api('tgtest',{});toast(r.ok?'Yuborildi':'Yuborilmadi — avval ulang')};\n$('tgDig').onclick=async()=>{const r=await api('digest',{});toast(r.ok?'Hisobot yuborildi':'Yuborilmadi — avval ulang')};\n$('tgOff').onclick=async()=>{if(!confirm('Telegram ogohlantirishlari uzilsinmi?'))return;await api('tgoff',{});DATA.tg=false;drawSet()};\n$('expAll').onclick=async()=>{toast('Tayyorlanmoqda…');const res=await fetch('/owner/api/exportall',{headers:{'Authorization':'Bearer '+TOK}});const bl=await res.blob();const a=document.createElement('a');a.href=URL.createObjectURL(bl);a.download=`hodim-hammasi-${new Date().toISOString().slice(0,10)}.json`;a.click()};\n// --- yangi kompaniya ---\nfunction openNew(L){if(L&&L.type)L=null;const s=(DATA&&DATA.settings)||{};\n $('newBox').innerHTML=`<h2>+ Yangi kompaniya</h2><label>Kompaniya nomi</label><input id=\"nName\" placeholder=\"Masalan: KOER Namangan\"><label>Kod (havolada ko‘rinadi, o‘zgarmaydi)</label><input id=\"nCid\" placeholder=\"masalan: koer-namangan\">\n <div class=\"g3\"><div><label>Bepul sinov (kun)</label><input id=\"nTrial\" type=\"number\" min=\"0\" value=\"${s.trialDays??7}\"></div><div><label>Oylik narx</label><input id=\"nPrice\" type=\"number\" min=\"0\" value=\"${s.price??0}\"></div><div><label>Valyuta</label><select id=\"nCur\"><option>UZS</option><option>RUB</option><option>USD</option><option>KZT</option><option>EUR</option></select></div></div>\n <div class=\"g2\"><div><label>Maksimal xodim (0 = cheklanmagan)</label><input id=\"nMax\" type=\"number\" min=\"0\" value=\"${s.maxEmp??0}\"></div><div><label>Mijoz telefoni</label><input id=\"nPhone\" placeholder=\"+998 …\"></div></div>\n <label>Kim taklif qildi? (ixtiyoriy)</label><select id=\"nRef\"><option value=\"\">— hech kim —</option>${(DATA?DATA.list:[]).map(c=>`<option value=\"${c.cid}\">${esc(c.name)}</option>`).join('')}</select><div class=\"mut small\" style=\"margin-top:4px\">Tanlansa — o‘sha kompaniyaga <b>${(DATA&&DATA.settings&&DATA.settings.refDays!=null)?DATA.settings.refDays:15} kun</b> bepul <b>shu yangi kompaniya birinchi obuna to‘lovini qilgandan keyin</b> qo‘shiladi (soxta kompaniya ochib bonus olishning oldi olinadi).</div>\n <label>Izoh</label><input id=\"nNote\" placeholder=\"ixtiyoriy\"><div class=\"row2\"><button class=\"btn\" id=\"nGo\">Yaratish</button><button class=\"btn g\" data-close>Bekor qilish</button></div><div id=\"nMsg\" class=\"small\" style=\"margin-top:8px\"></div>`;\n $('nCur').value=s.cur||'UZS';$('mNew').classList.add('show');\n if(L){$('nName').value=L.name||'';$('nName').oninput&&0;$('nPhone').value=L.phone||'';$('nNote').value=[L.person,L.emp?L.emp+' xodim':'',L.city].filter(Boolean).join(' · ');if(L.ref)$('nRef').value=L.ref;setTimeout(()=>$('nName').dispatchEvent(new Event('input')),0)}\n $('nName').oninput=()=>{if(!$('nCid')._t)$('nCid').value=$('nName').value.toLowerCase().replace(/[‘’'ʻ`]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,30)};$('nCid').oninput=()=>$('nCid')._t=1;\n $('nGo').onclick=async()=>{$('nGo').disabled=true;const r=await api('create',{newCid:$('nCid').value.trim().toLowerCase(),name:$('nName').value,trialDays:$('nTrial').value,price:$('nPrice').value,cur:$('nCur').value,maxEmp:$('nMax').value,phone:$('nPhone').value,note:$('nNote').value,refBy:$('nRef').value}).catch(()=>({msg:'Xato'}));$('nGo').disabled=false;\n  if(!r.ok){$('nMsg').style.color='var(--bad)';$('nMsg').textContent=r.msg;return}\n  if(L)api('leaddo',{id:L.id,st:'done',cid:r.cid}).then(()=>{if(SEC==='lead')loadLeads()});\n  $('newBox').innerHTML=`<h2>✅ Kompaniya yaratildi</h2><p>Quyidagilarni mijozga yuboring:</p><label>Ilova havolasi</label><input readonly value=\"${r.link}\" onclick=\"this.select()\"><label>Admin PIN kodi (faqat bir marta ko‘rsatiladi)</label><div class=\"pinbox\">${r.pin}</div>${r.ref?`<div class=\"alert\">🎁 «${esc(coName(r.ref.cid))}» taklif qiluvchi sifatida yozildi. Bu kompaniya birinchi to‘lovni qilgach, unga ${r.ref.days} kun bepul qo‘shiladi.</div>`:''}<div class=\"row2\"><button class=\"btn\" id=\"nCopy\">📋 Nusxalash</button><button class=\"btn g\" data-close>Yopish</button></div>`;\n  $('nCopy').onclick=()=>{navigator.clipboard.writeText('HODIM ilovasi: '+r.link+'\\nAdmin PIN: '+r.pin);toast('Nusxalandi')};load()}}\n// --- kompaniya oynasi ---\nlet TAB='sub',TODAY=null,CJ=null;\nasync function openCo(cid,tab){$('coBox').innerHTML='<div class=\"mut\">Yuklanmoqda…</div>';$('mCo').classList.add('show');try{CUR=await api('company',{cid},'GET')}catch(e){return}TAB=tab||'sub';TODAY=null;CJ=null;drawCo()}\nasync function bigPhoto(p){const r=await api(p.eid?'faceph':'photo',p,'GET');if(!r.ph){toast('Surat yo‘q (eski bo‘lsa o‘chirilgan)');return}$('bigph').src=r.ph;$('mPh').classList.add('show')}\nfunction ckLine(ck){if(!ck)return'';const a=[];if(ck.dist!=null)a.push(`📍 ${ck.dist} m${ck.rad?' / '+ck.rad+' m':''}${ck.acc?' (±'+ck.acc+')':''}`);if(ck.fs!=null)a.push(`🙂 ${Math.round(ck.fs*100)}%`);if(ck.real!=null)a.push(`jonli ${Math.round((ck.live||0)*100)}% · haqiqiy ${Math.round((ck.real||0)*100)}%`);if(ck.off)a.push('📴 internetsiz'+(ck.tv?' (vaqt tasdiqlangan)':''));if(ck.ip)a.push('🌐 '+esc(ck.ip));\n return `<div class=\"mut small\">${a.join(' · ')}${ck.lat!=null?` · <a target=\"_blank\" rel=\"noopener\" style=\"color:var(--neon)\" href=\"https://maps.google.com/?q=${ck.lat},${ck.lng}\">xarita</a>`:''}</div>`}\nfunction rvBtns(cid,m,rid,a,rv){return rv?`<span class=\"chip ${rv==='ok'?'c-ok':'c-bad'}\">${rv==='ok'?'✅ tasdiqlangan':'❌ rad etilgan'}</span>`:`<button class=\"btn ok xs\" data-rv=\"ok\" data-m=\"${m}\" data-rid=\"${rid}\" data-a=\"${a}\">✅ To‘g‘ri</button> <button class=\"btn r xs\" data-rv=\"no\" data-m=\"${m}\" data-rid=\"${rid}\" data-a=\"${a}\">❌ Rad</button>`}\nfunction drawCo(){const r=CUR,c=r.co,s=r.sub,F=c.feat||{};\n const head=`<div class=\"top\" style=\"margin:0\"><div><h2 style=\"margin:0\">${esc(c.name)}</h2><div class=\"mut small\">${esc(c.cid)} · yaratilgan ${d8(c.created)}${c.phone?' · '+esc(c.phone):''}</div></div><div class=\"sp\"></div>${stChip({...c,sub:s,blocked:c.blocked})}<button class=\"btn g sm\" data-close>✕</button></div>\n <div class=\"tabs\">${[['sub','💳 Obuna'],['today','📍 Bugun'],['sus',`⚠️ Shubhali${r.sus.filter(x=>!x.rv&&!x.gone).length?' ('+r.sus.filter(x=>!x.rv&&!x.gone).length+')':''}`],['stat','📈 Statistika'],['emp','👥 Xodimlar'],['ctl','🛠 Boshqaruv'],['jrn','📜 Jurnal'],['err','🐞 Xatolar'],['data','🗄 Ma’lumot']].map(([k,t])=>`<button data-tab=\"${k}\" class=\"${TAB===k?'on':''}\">${t}</button>`).join('')}</div>`;\n let b='';\n if(TAB==='sub'){b=`<div class=\"g3\"><div><label>Sinov tugaydi</label><input type=\"date\" id=\"cTrial\" value=\"${iso(c.trialEnd)}\"></div><div><label>To‘langan muddat</label><input type=\"date\" id=\"cPaid\" value=\"${iso(c.paidUntil)}\"></div><div><label>Holat</label><select id=\"cBlk\"><option value=\"0\">Ishlaydi</option><option value=\"1\" ${c.blocked?'selected':''}>⛔ Bloklangan</option></select></div></div>\n  <div class=\"g3\"><div><label>Oylik narx</label><input type=\"number\" id=\"cPrice\" value=\"${c.price||0}\"></div><div><label>Valyuta</label><select id=\"cCur\">${['UZS','RUB','USD','KZT','EUR'].map(x=>`<option ${c.cur===x?'selected':''}>${x}</option>`).join('')}</select></div><div><label>Maks. xodim (0 = cheksiz)</label><input type=\"number\" id=\"cMax\" value=\"${c.maxEmp||0}\"></div></div>\n  <div class=\"g2\"><div><label>Nomi</label><input id=\"cName\" value=\"${esc(c.name)}\"></div><div><label>Telefon</label><input id=\"cPhone\" value=\"${esc(c.phone||'')}\"></div></div><label>Izoh</label><input id=\"cNote\" value=\"${esc(c.note||'')}\">\n  <div class=\"row2\"><button class=\"btn\" id=\"cSave\">💾 Saqlash</button><button class=\"btn ok\" data-pay=\"1\">💵 +1 oy to‘landi</button><button class=\"btn ok\" data-pay=\"3\">+3 oy</button><button class=\"btn ok\" data-pay=\"12\">+12 oy</button></div>\n  <h3>🎁 Takliflar</h3><div class=\"list\">${c.refBy?`<div>Bu kompaniyani taklif qilgan: <b>${esc(coName(c.refBy))}</b></div>`:''}${c.refBy?`<div class=\"mut small\">${c.refPaid?'✅ Birinchi to‘lov qilindi — taklif bonusi berilgan':'⏳ Birinchi to‘lov kutilmoqda — taklif qilganga bonus hali berilmagan'}</div>`:''}${(c.refs||[]).map(x=>`<div>${d8(x.t)} — <b>${esc(x.name)}</b> ni olib keldi · ${x.st==='wait'?'<span style=\"color:#fbbf24\">⏳ to‘lov kutilmoqda</span>':'<span style=\"color:#4ade80\">✅ +'+x.days+' kun berildi</span>'}</div>`).join('')||(c.refBy?'':'<div class=\"mut\">Hali taklif yo‘q</div>')}</div>\n  <h3>To‘lovlar tarixi</h3><div class=\"list\">${(c.payments||[]).map(p=>`<div>${d8(p.t)} — <b>${p.months} oy</b> · ${fmt(p.amount)} ${sym(p.cur)} <span class=\"mut small\">(${d8(p.until)} gacha)</span></div>`).join('')||'<div class=\"mut\">Hali to‘lov yo‘q</div>'}</div>`}\n if(TAB==='today'){if(!TODAY){b='<div class=\"mut\">Yuklanmoqda…</div>';api('today',{cid:c.cid},'GET').then(x=>{TODAY=x;drawCo()})}else{\n  const came=TODAY.rows.filter(x=>x.recs.length).length;\n  b=`<div class=\"row2\" style=\"margin:0 0 8px\"><span class=\"chip c-ok\">Keldi: ${came}</span><span class=\"chip c-mut\">Kelmagan: ${TODAY.rows.length-came}</span><span class=\"chip c-warn\">Shubhali: ${TODAY.rows.reduce((a,x)=>a+x.recs.filter(r=>r.sus).length,0)}</span><div style=\"flex:1\"></div><button class=\"btn g xs\" id=\"tRef\">↻</button></div>\n  <div class=\"list\">${TODAY.rows.map(e=>`<div><b>${esc(e.name)}</b> <span class=\"mut small\">${esc(e.role)}</span> ${e.face?'<span class=\"chip c-ok\">🙂 yuz bor</span>':'<span class=\"chip c-mut\">yuz namunasi yo‘q</span>'}\n   ${e.recs.length?e.recs.map(rc=>['in','out'].filter(a=>a==='in'||rc.outTime).map(a=>{const ck=rc.ck&&rc.ck[a],sus=rc.sus&&rc.sus[a];return `<div style=\"display:flex;gap:10px;align-items:center;margin-top:6px\"><span class=\"ph\" data-ph=\"${rc.m}|${rc.id}|${a}\">📷</span><div style=\"flex:1\"><b>${a==='in'?'Kelish':'Ketish'} ${a==='in'?rc.inTime:rc.outTime}</b> ${rc.off&&rc.off[a]?'<span class=\"chip c-mut\">📴</span>':''} ${sus?flagChips(ck&&ck.f||['old_app']):'<span class=\"chip c-ok\">✓ tekshiruvdan o‘tdi</span>'}${ckLine(ck)}</div>${sus?rvBtns(c.cid,rc.m,rc.id,a,rc.rv&&rc.rv[a]):''}</div>`}).join('')).join(''):'<div class=\"mut small\">Bugun kelmagan</div>'}</div>`).join('')}</div>`}}\n if(TAB==='sus')b=`<p class=\"mut small\">Oxirgi 45 kundagi shubhali belgilar. «To‘g‘ri» — belgi qabul qilinadi; «Rad» — admin ilovasida ❌ bilan ko‘rinadi.</p><div class=\"list\">${r.sus.map(x=>`<div><div class=\"ev\"><div class=\"ic\">⚠️</div><div class=\"bd\"><b>${esc(x.who)}</b> — ${esc(x.date||'')} ${x.a==='out'?'ketish':'kelish'} ${esc(x.tm||'')}${x.off?' <span class=\"chip c-mut\">📴</span>':''}${x.dist!=null?` <span class=\"mut small\">· ${x.dist} m</span>`:''}${x.fs!=null?` <span class=\"mut small\">· yuz ${Math.round(x.fs*100)}%</span>`:''}<div>${flagChips(x.f)}</div></div><div style=\"text-align:right\">${x.gone?'<span class=\"chip c-mut\">yozuv o‘chirilgan</span>':`<span class=\"ph\" data-ph=\"${x.m}|${x.rid}|${x.a}\">📷</span><div style=\"margin-top:6px\">${rvBtns(c.cid,x.m,x.rid,x.a,x.rv)}</div>`}</div></div></div>`).join('')||'<div class=\"mut\">Shubhali belgi yo‘q 🎉</div>'}</div>`;\n if(TAB==='stat'){const mx=Math.max(1,...r.days.map(x=>x.came));const lg=Math.max(1,...r.days.map(x=>x.logins));\n  b=`<div class=\"kpis\"><div class=\"card kpi\"><span>👥 Xodimlar</span><b>${r.employees.length}</b></div><div class=\"card kpi\"><span>🙂 Yuz namunasi bor</span><b>${r.faces}</b></div><div class=\"card kpi\"><span>📱 Eslatma yoqilgan telefon</span><b>${r.devices}</b></div><div class=\"card kpi\"><span>📍 Bugun keldi</span><b>${r.days.at(-1).came}</b></div><div class=\"card kpi\"><span>⏰ 30 kunda kechikish</span><b>${r.days.reduce((a,x)=>a+x.late,0)}</b></div><div class=\"card kpi\"><span>⚠️ Shubhali (45 kun)</span><b>${r.sus.length}</b></div><div class=\"card kpi\"><span>💾 Hajm</span><b>${fmt(r.size.kb)} KB</b></div></div>\n  <h3>Kelganlar soni (30 kun)</h3><div class=\"bars\">${r.days.map(x=>`<div title=\"${x.d}: ${x.came} keldi, ${x.late} kechikdi\"><i class=\"l\" style=\"height:${x.late/mx*120}px\"></i><i class=\"a\" style=\"height:${(x.came-x.late)/mx*120}px\"></i></div>`).join('')}</div>\n  <div class=\"legend\"><span><i style=\"background:#5fe3ff\"></i>Vaqtida</span><span><i style=\"background:#fbbf24\"></i>Kechikkan</span><span>${r.days[0].d.split('-').reverse().join('.')} — bugun</span></div>\n  <h3>Ilovaga kirishlar (30 kun)</h3><div class=\"bars\" style=\"height:90px\">${r.days.map(x=>`<div title=\"${x.d}: ${x.logins} marta\"><i class=\"a\" style=\"height:${x.logins/lg*70}px;background:linear-gradient(#a78bfa,#5b4dff)\"></i></div>`).join('')}</div>\n  <h3>Sozlamalar</h3><div class=\"list\"><div>Ilovadagi nomi: <b>${esc(r.settings.company||'—')}</b> · valyuta ${r.settings.currency} · ish vaqti ${r.settings.workStart||'—'}–${r.settings.workEnd||'—'} · filiallar ${r.settings.branches}</div>\n  <div>Telegram hisobot: ${r.tg?'✅ ulangan':'— ulanmagan'} · Zaxira kanali: ${r.backup?'✅ '+esc(r.backup.title)+(r.backup.last?' (oxirgi '+r.backup.last+')':''):'— ulanmagan'}</div>\n  <div>Admin oxirgi marta kirgan: ${ago(c.stats&&c.stats.lastAdmin)} · oxirgi faollik: ${ago(c.stats&&c.stats.last)}</div></div>`}\n if(TAB==='emp')b=`<div class=\"list\">${r.employees.map(e=>`<div style=\"display:flex;gap:10px;align-items:center\"><div style=\"flex:1\"><b>${esc(e.name)}</b> <span class=\"mut\">· ${esc(e.role)}${e.branch?' · filial '+esc(e.branch):''}</span></div><button class=\"btn g xs\" data-fph=\"${esc(e.id)}\">🙂 Yuz namunasi</button><button class=\"btn r xs\" data-frs=\"${esc(e.id)}\">Yuzni qayta olish</button></div>`).join('')||'<div class=\"mut\">Xodim qo‘shilmagan</div>'}</div><p class=\"mut small\">«Yuzni qayta olish» — eski namuna o‘chadi, xodimning keyingi belgisida yangisi olinadi.</p>`;\n if(TAB==='ctl'){const m=c.msg||{};b=`<h3>🔒 Funksiyalar (egasi ruxsati)</h3><p class=\"mut small\">O‘chirsangiz — kompaniya admini ham yoqa olmaydi. Yoqiq bo‘lsa — admin o‘z ilovasida yoqib/o‘chirib turadi.</p>\n  <div class=\"sw\"><div><b>🙂 Face ID — yuzni tanish</b><div class=\"mut small\">Soxta rasm, boshqa odam, ko‘z qisish tekshiruvi</div></div><label class=\"tog\"><input type=\"checkbox\" id=\"fFace\" ${F.face!==false?'checked':''}><i></i></label></div>\n  <div class=\"sw\"><div><b>📍 Joylashuv (GPS)</b><div class=\"mut small\">Ish joyidan uzoqda / soxta GPS</div></div><label class=\"tog\"><input type=\"checkbox\" id=\"fGps\" ${F.gps!==false?'checked':''}><i></i></label></div>\n  <div class=\"sw\"><div><b>📴 Internetsiz belgilash</b><div class=\"mut small\">Internet yo‘q paytda ham belgilash, keyin yuboriladi</div></div><label class=\"tog\"><input type=\"checkbox\" id=\"fOff\" ${F.offline!==false?'checked':''}><i></i></label></div>\n  <div class=\"row2\"><button class=\"btn\" id=\"fSave\">💾 Saqlash</button></div>\n  <h3>📢 Shu kompaniyaga e’lon</h3><textarea id=\"mText\" rows=\"2\" placeholder=\"Masalan: Obunangiz 3 kundan keyin tugaydi — to‘lovni unutmang\">${esc(m.text||'')}</textarea>\n  <div class=\"g2\"><div><label>Kimga</label><select id=\"mTo\"><option value=\"all\">Hammaga</option><option value=\"admin\" ${m.to==='admin'?'selected':''}>Faqat adminga</option></select></div><div><label>Necha kun (0 = o‘chirguncha)</label><input id=\"mDays\" type=\"number\" min=\"0\" value=\"0\"></div></div>\n  <div class=\"row2\"><button class=\"btn\" id=\"mGo\">📢 Saqlash</button></div>\n  <h3>👑 To‘liq nazorat</h3>\n  <div class=\"row2\" style=\"margin-top:0\"><button class=\"btn\" id=\"imp\">🔓 Admin sifatida kirish</button><span class=\"mut small\">Ilova yangi oynada admin rejimida ochiladi (2 soat). Jurnalga yoziladi.</span></div>\n  <div class=\"row2\"><button class=\"btn r\" id=\"rvk\">🚪 Barcha telefonlarni chiqarish</button><span class=\"mut small\">Hamma (admin va xodimlar) PIN bilan qayta kiradi. PIN o‘g‘irlangan deb gumon bo‘lsa.</span></div>\n  <div class=\"row2\"><button class=\"btn g\" id=\"cPin\">🔑 Yangi admin PIN yaratish</button></div><div id=\"cPinOut\"></div>`}\n if(TAB==='jrn'){if(!CJ){b='<div class=\"mut\">Yuklanmoqda…</div>';api('feed',{cid:c.cid,limit:200},'GET').then(x=>{CJ=x.ev||[];drawCo()})}else b=`<div class=\"list\">${CJ.map(x=>`<div>${evHTML(x,false)}</div>`).join('')||'<div class=\"mut\">Voqea yo‘q</div>'}</div>`}\n if(TAB==='err')b=`<div class=\"row2\" style=\"margin:0 0 8px\"><button class=\"btn r sm\" id=\"cClr\">Bu kompaniya xatolarini tozalash</button></div><div class=\"list\">${logHTML(r.logs)}</div>`;\n if(TAB==='data')b=`<label>Ilova havolasi (mijozga yuboring)</label><div class=\"row2\" style=\"margin:0\"><input readonly value=\"${r.link}\" onclick=\"this.select()\" style=\"flex:1\"><button class=\"btn g sm\" id=\"cLink\">📋</button></div>\n  <h3>🗄 Zaxira</h3><div class=\"row2\" style=\"margin:0\"><button class=\"btn g\" id=\"cBk\">⬇️ Zaxirani yuklab olish (.json)</button></div>\n  <label>Zaxiradan tiklash (.json fayl) — hozirgi ma’lumotlar almashtiriladi!</label><input type=\"file\" id=\"cFile\" accept=\".json,application/json\"><button class=\"btn r\" id=\"cRes\" style=\"margin-top:8px\">♻️ Tiklash</button><div id=\"cResMsg\" class=\"small\" style=\"margin-top:6px\"></div>\n  ${c.cid!=='main'?`<h3 style=\"color:var(--bad)\">🗑 Kompaniyani o‘chirish</h3><p class=\"mut small\">Barcha xodimlar, davomat va suratlar butunlay o‘chadi. Qaytarib bo‘lmaydi.</p><button class=\"btn r\" id=\"cDel\">Kompaniyani o‘chirish</button>`:''}`;\n $('coBox').innerHTML=head+b;const B=$('coBox'),on=(id,f)=>{const el=$(id);if(el)el.onclick=f};\n B.querySelectorAll('[data-tab]').forEach(x=>x.onclick=()=>{TAB=x.dataset.tab;drawCo()});\n B.querySelectorAll('[data-ph]').forEach(x=>x.onclick=()=>{const [m,rid,a]=x.dataset.ph.split('|');bigPhoto({cid:c.cid,m,rid,a})});\n B.querySelectorAll('[data-rv]').forEach(x=>x.onclick=async()=>{const r2=await api('review',{cid:c.cid,m:x.dataset.m,rid:x.dataset.rid,a:x.dataset.a,v:x.dataset.rv});if(!r2.ok){toast(r2.msg||'Xato');return}toast('Saqlandi');const sx=CUR.sus.find(y=>y.rid===x.dataset.rid&&y.a===x.dataset.a);if(sx)sx.rv=x.dataset.rv;if(TODAY)TODAY.rows.forEach(e=>e.recs.forEach(rc=>{if(rc.id===x.dataset.rid)rc.rv={...(rc.rv||{}),[x.dataset.a]:x.dataset.rv}}));drawCo()});\n B.querySelectorAll('[data-fph]').forEach(x=>x.onclick=()=>bigPhoto({cid:c.cid,eid:x.dataset.fph}));\n B.querySelectorAll('[data-frs]').forEach(x=>x.onclick=async()=>{if(!confirm('Bu xodimning yuz namunasi o‘chirilsinmi? Keyingi belgisida yangisi olinadi.'))return;await api('resetface',{cid:c.cid,eid:x.dataset.frs});toast('O‘chirildi')});\n on('tRef',()=>{TODAY=null;drawCo()});\n on('cSave',async()=>{const r2=await api('save',{cid:c.cid,patch:{trialEnd:$('cTrial').value,paidUntil:$('cPaid').value,blocked:$('cBlk').value==='1',price:$('cPrice').value,cur:$('cCur').value,maxEmp:$('cMax').value,name:$('cName').value,phone:$('cPhone').value,note:$('cNote').value}});if(r2.ok){CUR.co=r2.co;CUR.sub=r2.sub;toast('Saqlandi');drawCo();load()}});\n B.querySelectorAll('[data-pay]').forEach(x=>x.onclick=async()=>{const m=+x.dataset.pay,amt=prompt(`${m} oylik to‘lov summasi (${sym(c.cur)}):`,String((c.price||0)*m));if(amt===null)return;const r2=await api('pay',{cid:c.cid,months:m,amount:Number(String(amt).replace(/\\s/g,''))||0});if(r2.ok){CUR.co=r2.co;CUR.sub=r2.sub;toast('To‘lov qayd etildi');drawCo();load()}});\n on('fSave',async()=>{const r2=await api('feat',{cid:c.cid,feat:{face:$('fFace').checked,gps:$('fGps').checked,offline:$('fOff').checked}});if(r2.ok){CUR.co=r2.co;toast('Saqlandi')}});\n on('mGo',async()=>{const r2=await api('msg',{cid:c.cid,text:$('mText').value,to:$('mTo').value,days:$('mDays').value});if(r2.ok){CUR.co=r2.co;toast($('mText').value.trim()?'E’lon chiqdi':'E’lon o‘chirildi')}});\n on('imp',async()=>{const w=window.open('about:blank','_blank');const r2=await api('impersonate',{cid:c.cid});if(r2.ok){if(w)w.location=r2.url;else location.href=r2.url}else if(w)w.close()});\n on('rvk',async()=>{if(!confirm('Hamma telefonlardan chiqarilsinmi? Har kim PIN bilan qayta kiradi.'))return;const r2=await api('revoke',{cid:c.cid});if(r2.ok){CUR.co=r2.co;toast('Hamma chiqarildi')}});\n on('cPin',async()=>{if(!confirm('Yangi admin PIN yaratilsinmi? Eskisi ishlamay qoladi.'))return;const r2=await api('resetpin',{cid:c.cid});if(r2.ok)$('cPinOut').innerHTML=`<div class=\"pinbox\">${r2.pin}</div><p class=\"mut small\">Shu kodni mijozga ayting. U kirgach o‘zgartirishi mumkin.</p>`});\n on('cClr',async()=>{await api('clearerrors',{cid:c.cid});CUR.logs=[];drawCo();load()});\n on('cLink',()=>{navigator.clipboard.writeText(r.link);toast('Nusxalandi')});\n on('cBk',async()=>{const res=await fetch('/owner/api/backup?cid='+c.cid,{headers:{'Authorization':'Bearer '+TOK}});const bl=await res.blob();const a=document.createElement('a');a.href=URL.createObjectURL(bl);a.download=`hodim-${c.cid}-${new Date().toISOString().slice(0,10)}.json`;a.click()});\n on('cRes',async()=>{const f=$('cFile').files[0];if(!f){alert('Avval .json faylni tanlang');return}const conf=prompt(`Tasdiqlash uchun kompaniya kodini yozing: ${c.cid}`);if(conf===null)return;let dump;try{dump=JSON.parse(await f.text())}catch(e){alert('Fayl o‘qilmadi');return}\n  $('cResMsg').textContent='Tiklanmoqda…';const r2=await api('restore',{cid:c.cid,confirm:conf.trim(),dump});$('cResMsg').textContent=r2.msg||(r2.ok?'✅ Tiklandi':'Xato');if(r2.ok)load()});\n on('cDel',async()=>{const conf=prompt(`DIQQAT! «${c.name}» butunlay o‘chiriladi.\\nTasdiqlash uchun kodni yozing: ${c.cid}`);if(conf===null)return;const r2=await api('delete',{cid:c.cid,confirm:conf.trim()});if(r2.ok){$('mCo').classList.remove('show');toast('O‘chirildi');load()}else alert(r2.msg)});\n}\nshow();setInterval(()=>{if(TOK&&document.visibilityState==='visible'&&SEC==='dash'&&!document.querySelector('.modal.show'))load()},300000);\n</script></body></html>\n";
