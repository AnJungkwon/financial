/* 오프라인에서도 앱이 열리도록 앱 파일만 캐시한다(사용자 데이터는 IndexedDB에 있고 캐시하지 않음).
 * 네트워크 우선: 온라인이면 항상 최신 파일, 오프라인이면 캐시로 대체. */
const CACHE = 'fp-shell-202609291624';
const SHELL = [
  './', 'index.html', 'css/style.css', 'js/calc.js', 'js/db.js', 'js/prices.js', 'js/app.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    // 같은 origin(예: github.io)의 다른 사이트 캐시는 건드리지 않고 이 앱의 옛 캐시만 지운다
    .then(keys => Promise.all(keys.filter(k => k.startsWith('fp-shell-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
