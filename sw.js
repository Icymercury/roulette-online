/* ============================================================
 * 生死转盘 · Service Worker（只为让手机能「装到桌面」）
 * ------------------------------------------------------------
 * 它不参与联机 —— 联机靠 WebSocket，SW 碰不到，也不该碰。
 * 它做的事只有一件：把外壳（页面 / 引擎 / 图标）缓存下来，
 * 一是满足「可安装」的条件，二是服务器短暂重启时页面还能打开。
 *
 * 策略：网络优先、失败回落缓存。
 * 局域网里房主随时可能更新代码，缓存优先会让人拿着旧页面连新服务端 —— 那是灾难。
 * ============================================================ */

const CACHE = 'rr-shell-v4';

const SHELL = [
  '/client.html',
  '/roulette-wheel.html',
  '/engine.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;   // 跨域一律不插手

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || new Response('离线，且这一份没有缓存', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      });
    })
  );
});
