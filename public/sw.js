/* うごく習慣ラボ Service Worker
   - オフライン動作（アプリ本体をキャッシュ。ページは「ネット優先・だめならキャッシュ」で常に最新に）
   - Web Push 受信（公開版：サーバーから時刻どおりに届く）
   - 通知の「やった！」「ミニ版」で、アプリを開かずに記録
   - サーバーがない環境では、定期バックグラウンド同期（対応環境のみ）で確認 */
const CACHE='ugoku-v3';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon.svg','./icon-192.png','./icon-512.png'];

self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).catch(()=>{}));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==location.origin||url.pathname.includes('/api/'))return;
  if(req.mode==='navigate'){
    e.respondWith(fetch(req).then(res=>{const c=res.clone();caches.open(CACHE).then(x=>x.put('./index.html',c));return res}).catch(()=>caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req,{ignoreSearch:true}).then(r=>{
    const net=fetch(req).then(res=>{if(res.ok){const c=res.clone();caches.open(CACHE).then(x=>x.put(req,c))}return res}).catch(()=>r);
    return r||net;
  }));
});

/* ---- IndexedDB（ページと共有する小さなKVストア） ---- */
function db(){return new Promise((res,rej)=>{const r=indexedDB.open('ugoku',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function get(k){const d=await db();return new Promise(res=>{const q=d.transaction('kv').objectStore('kv').get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>res(null)})}
async function put(k,v){const d=await db();return new Promise(res=>{const tx=d.transaction('kv','readwrite');tx.objectStore('kv').put(v,k);tx.oncomplete=res;tx.onerror=res})}

const pad=n=>String(n).padStart(2,'0');
const ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const toMin=t=>{const[a,b]=(t||'0:0').split(':').map(Number);return a*60+b};
const ACTIONS=[{action:'full',title:'✓ やった！'},{action:'mini',title:'🌱 ミニ版'}];

function show(title,body,kind,date){
  return self.registration.showNotification(title,{body,tag:'ugoku-'+kind,renotify:true,icon:'./icon-192.png',badge:'./icon-192.png',
    actions:(kind==='cue'||kind==='nudge')?ACTIONS:[],data:{kind,date:date||ymd(new Date())},requireInteraction:kind==='cue'});
}

/* サーバーなし環境用：定期確認 */
async function check(){
  const s=await get('sched');if(!s||!s.enabled||s.server)return;
  const now=new Date(),t=ymd(now),m=now.getHours()*60+now.getMinutes();
  if(!s.days.includes(now.getDay())||s.lastDone===t||s.lastRest===t)return;
  const sent=(await get('sent'))||{};
  if(s.cue&&s.cueTime&&m>=toMin(s.cueTime)&&m<toMin(s.cueTime)+180&&sent.cue!==t){
    await show(`もし「${s.anchor}」なら…`,`${s.behavior}を${s.minutes}分。しんどい日は「${s.mini}」だけでOK`,'cue',t);sent.cue=t;
  }else if(s.nudge&&s.nudgeTime&&m>=toMin(s.nudgeTime)&&m<toMin(s.nudgeTime)+120&&sent.nudge!==t){
    await show('今日はまだ記録がありません',`ミニ版「${s.mini}」だけでも、連続記録はつながります`,'nudge',t);sent.nudge=t;
  }
  await put('sent',sent);
}
self.addEventListener('periodicsync',e=>{if(e.tag==='ugoku-check')e.waitUntil(check())});
self.addEventListener('message',e=>{if(e.data==='check')e.waitUntil(check())});

/* サーバーからのプッシュ（プッシュを受けたら必ず通知を表示する必要がある） */
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{}}catch(_){d={body:e.data&&e.data.text()}}
  e.waitUntil((async()=>{
    const t=d.date||ymd(new Date());
    let s=null;try{s=await get('sched')}catch(_){}
    if((d.kind==='cue'||d.kind==='nudge')&&s&&(s.lastDone===t||s.lastRest===t))
      return self.registration.showNotification('今日はもう記録済みです ✓',{body:'その調子！',tag:'ugoku-'+d.kind,silent:true,icon:'./icon-192.png'});
    return show(d.title||'うごく習慣ラボ',d.body||'運動の時間です',d.kind||'push',t);
  })());
});

/* 通知ボタンから、アプリを開かずに記録 */
async function recordFromNotification(status,date){
  const s=(await get('sched'))||{};
  const pend=(await get('pending'))||[];
  if(!pend.some(p=>p.date===date)&&s.lastDone!==date){
    const min=status==='mini'?Math.min(5,s.minutes||5):(s.minutes||10);
    pend.push({date,status,min,type:s.type||'walk',at:Date.now()});
    await put('pending',pend);
  }
  s.lastDone=date;await put('sched',s);
  if(s.endpoint)fetch(s.api||'./api/done',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:s.endpoint,date})}).catch(()=>{});
  const cs=await self.clients.matchAll({type:'window',includeUncontrolled:true});cs.forEach(c=>c.postMessage({pending:true}));
  await self.registration.showNotification(status==='full'?'記録しました ✓ おつかれさま！':'ミニ版を記録しました 🌱 立派です',
    {body:'アプリを開くと、きつさや気分も追加できます',tag:'ugoku-done',icon:'./icon-192.png',silent:true});
}
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const d=e.notification.data||{};
  if(e.action==='full'||e.action==='mini'){e.waitUntil(recordFromNotification(e.action,d.date||ymd(new Date())));return}
  const act=d.kind==='review'?'review':(d.kind==='cue'||d.kind==='nudge')?'log':'open';
  const target=new URL('./?do='+act,self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
    for(const c of cs){if('focus' in c){c.postMessage({do:act});return c.focus()}}
    return self.clients.openWindow(target);
  }));
});
