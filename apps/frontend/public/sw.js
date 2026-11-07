// Postiz service worker.
// Intentionally NO fetch handler: this worker must never intercept requests
// (the app is fully dynamic, cookie-authenticated, and calls the backend API).
// It exists to make the app installable and to provide a registration point
// for future features (Web Push, offline caching).

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      // Deliberately no fetch handler: this worker must never intercept
      // requests. It exists to make the app installable and to provide a
      // registration point for future features (push, offline).
      await self.clients.claim();
    })()
  );
});
