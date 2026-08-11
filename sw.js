const CACHE='yommo-v12';
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/'])));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put('/',cp));return r;}).catch(()=>caches.match('/')));
  }
});
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{};}catch(err){}
  const n=(d.notification)||(d.data)||{};
  e.waitUntil(self.registration.showNotification(n.title||'Yommo!',{body:n.body||'',icon:n.icon||'/icon-192.png',badge:'/icon-192.png',data:{url:(d.fcmOptions&&d.fcmOptions.link)||'/'}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{
    for(const w of ws){if('focus' in w){return w.focus();}}
    return clients.openWindow((e.notification.data&&e.notification.data.url)||'/');
  }));
});
