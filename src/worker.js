// うごく習慣ラボ：通知サーバー（Cloudflare Worker）
// - 静的ファイル（public/）の配信
// - /api/* : 通知の購読・スケジュール更新・実施済みの連絡
// - 毎分の Cron で、各ユーザーの現地時刻に合わせて Web Push を送信
// 保存するのは「通知先・時刻設定・きっかけの文言・最後に実施した日付」だけ。運動や体調の記録は受け取らない。
import { sendPush, generateVapidKeys } from './webpush.js';

// 初回アクセス時にテーブルと通知用の鍵を自動で用意する（手作業のセットアップ不要）
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, tz TEXT NOT NULL DEFAULT 'Asia/Tokyo', days TEXT NOT NULL DEFAULT '[]', cue_time TEXT NOT NULL DEFAULT '', nudge_time TEXT NOT NULL DEFAULT '', review INTEGER NOT NULL DEFAULT 1, anchor TEXT NOT NULL DEFAULT '', behavior TEXT NOT NULL DEFAULT '', minutes INTEGER NOT NULL DEFAULT 0, mini TEXT NOT NULL DEFAULT '', last_done TEXT NOT NULL DEFAULT '', last_rest TEXT NOT NULL DEFAULT '', sent TEXT NOT NULL DEFAULT '{}', updated INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
];
let ready = null;
async function setup(env) {
  if (!ready) ready = (async () => {
    await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q)));
    let row = await env.DB.prepare(`SELECT v FROM meta WHERE k='vapid'`).first();
    if (!row) {
      const k = await generateVapidKeys();
      await env.DB.prepare(`INSERT OR IGNORE INTO meta (k,v) VALUES ('vapid',?1)`).bind(JSON.stringify(k)).run();
      row = await env.DB.prepare(`SELECT v FROM meta WHERE k='vapid'`).first();
    }
    return JSON.parse(row.v);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// GitHub Pages など別サイトに置いたアプリからも使えるように CORS を許可
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
});
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const clip = (s, n) => String(s ?? '').slice(0, n);

function cleanSchedule(s = {}) {
  const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter(d => d >= 0 && d <= 6))] : [];
  return {
    tz: typeof s.tz === 'string' && s.tz.length < 64 ? s.tz : 'Asia/Tokyo',
    days: JSON.stringify(days),
    cue_time: s.cue && HHMM.test(s.cueTime || '') ? s.cueTime : '',
    nudge_time: s.nudge && HHMM.test(s.nudgeTime || '') ? s.nudgeTime : '',
    review: s.review ? 1 : 0,
    anchor: clip(s.anchor, 60), behavior: clip(s.behavior, 40), minutes: Math.max(0, Math.min(300, Number(s.minutes) || 0)), mini: clip(s.mini, 60),
    last_done: /^\d{4}-\d\d-\d\d$/.test(s.lastDone || '') ? s.lastDone : '',
    last_rest: /^\d{4}-\d\d-\d\d$/.test(s.lastRest || '') ? s.lastRest : '',
  };
}
function validSub(sub) {
  return sub && typeof sub.endpoint === 'string' && sub.endpoint.startsWith('https://') && sub.endpoint.length < 1024
    && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
}

async function handleApi(req, env, url) {
  const path = url.pathname;
  const keys = await setup(env);
  if (path === '/api/vapid' && req.method === 'GET') return json({ publicKey: keys.publicKey });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }

  if (path === '/api/subscribe') {
    if (!validSub(body.subscription)) return json({ error: 'bad subscription' }, 400);
    const s = cleanSchedule(body.schedule);
    const sub = body.subscription;
    await env.DB.prepare(`INSERT INTO subs (endpoint,p256dh,auth,tz,days,cue_time,nudge_time,review,anchor,behavior,minutes,mini,last_done,last_rest,sent,updated)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'{}',?15)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=?2,auth=?3,tz=?4,days=?5,cue_time=?6,nudge_time=?7,review=?8,anchor=?9,behavior=?10,minutes=?11,mini=?12,last_done=?13,last_rest=?14,updated=?15`)
      .bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth, s.tz, s.days, s.cue_time, s.nudge_time, s.review, s.anchor, s.behavior, s.minutes, s.mini, s.last_done, s.last_rest, Date.now()).run();
    await env.DB.prepare(`INSERT INTO meta (k,v) VALUES ('origin',?1) ON CONFLICT(k) DO UPDATE SET v=?1`).bind(url.origin).run();
    return json({ ok: true });
  }
  if (path === '/api/done') { // 通知ボタンやアプリから「今日やった／休む」を連絡（声かけ通知を止めるため）
    if (typeof body.endpoint !== 'string') return json({ error: 'endpoint' }, 400);
    const col = body.kind === 'rest' ? 'last_rest' : 'last_done';
    if (!/^\d{4}-\d\d-\d\d$/.test(body.date || '')) return json({ error: 'date' }, 400);
    await env.DB.prepare(`UPDATE subs SET ${col}=?1, updated=?2 WHERE endpoint=?3`).bind(body.date, Date.now(), body.endpoint).run();
    return json({ ok: true });
  }
  if (path === '/api/unsubscribe') {
    if (typeof body.endpoint !== 'string') return json({ error: 'endpoint' }, 400);
    await env.DB.prepare('DELETE FROM subs WHERE endpoint=?1').bind(body.endpoint).run();
    return json({ ok: true });
  }
  if (path === '/api/test') {
    const row = await env.DB.prepare('SELECT * FROM subs WHERE endpoint=?1').bind(body.endpoint || '').first();
    if (!row) return json({ error: 'not subscribed' }, 404);
    const st = await sendPush(row, { kind: 'test', title: 'サーバーからのテスト通知', body: 'アプリを閉じていても、この通知が届きます 🎉' }, vapid(keys, url.origin));
    return json({ ok: st < 300, status: st });
  }
  return json({ error: 'not found' }, 404);
}

function vapid(keys, origin) {
  return { publicKey: keys.publicKey, privateJwk: keys.privateJwk, subject: origin || 'mailto:noreply@example.com' };
}

// 指定タイムゾーンでの現在の日付・曜日・分
function localNow(tz, now = new Date()) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(now); }
  catch { return localNow('Asia/Tokyo', now); }
  const g = t => parts.find(p => p.type === t).value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { date: `${g('year')}-${g('month')}-${g('day')}`, dow: wd, min: Number(g('hour')) * 60 + Number(g('minute')) };
}
const toMin = t => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
const WINDOW = 20; // 指定時刻から何分以内なら送るか（Cron の遅延・取りこぼし対策）

export function duePushes(row, now = new Date()) {
  const L = localNow(row.tz, now);
  const sent = JSON.parse(row.sent || '{}');
  const days = JSON.parse(row.days || '[]');
  const inWin = t => t && L.min >= toMin(t) && L.min < toMin(t) + WINDOW;
  const out = [];
  const settled = row.last_done === L.date || row.last_rest === L.date;
  if (days.includes(L.dow) && !settled) {
    if (inWin(row.cue_time) && sent.cue !== L.date)
      out.push({ key: 'cue', payload: { kind: 'cue', date: L.date, title: `もし「${row.anchor}」なら…`, body: `${row.behavior}を${row.minutes}分。しんどい日は「${row.mini}」だけでOK` } });
    else if (inWin(row.nudge_time) && sent.nudge !== L.date)
      out.push({ key: 'nudge', payload: { kind: 'nudge', date: L.date, title: '今日はまだ記録がありません', body: `ミニ版「${row.mini}」だけでも、連続記録はつながります` } });
  }
  if (row.review && L.dow === 0 && inWin('19:00') && sent.review !== L.date)
    out.push({ key: 'review', payload: { kind: 'review', date: L.date, title: '週のふり返りの時間です', body: '3分で今週をふり返り、来週のプランを整えましょう' } });
  return { L, sent, out };
}

async function runCron(env, now = new Date()) {
  const keys = await setup(env);
  const { results } = await env.DB.prepare(`SELECT * FROM subs WHERE cue_time!='' OR nudge_time!='' OR review=1`).all();
  const originRow = await env.DB.prepare(`SELECT v FROM meta WHERE k='origin'`).first();
  const v = vapid(keys, originRow && originRow.v);
  let sentCount = 0;
  for (const row of results) {
    const { L, sent, out } = duePushes(row, now);
    if (!out.length) continue;
    for (const p of out) {
      let st = 0;
      try { st = await sendPush(row, p.payload, v, { topic: p.key }); } catch (e) { console.log('push error', e && e.message); }
      if (st === 404 || st === 410) { await env.DB.prepare('DELETE FROM subs WHERE endpoint=?1').bind(row.endpoint).run(); break; }
      if (st >= 200 && st < 300) { sent[p.key] = L.date; sentCount++; }
      else console.log('push status', st);
    }
    await env.DB.prepare('UPDATE subs SET sent=?1 WHERE endpoint=?2').bind(JSON.stringify(sent), row.endpoint).run();
  }
  return sentCount;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      try { return await handleApi(req, env, url); } catch (e) { return json({ error: 'server', detail: String(e && e.message) }, 500); }
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, new Date(event.scheduledTime)));
  },
};
