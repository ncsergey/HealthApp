const CACHE_NAME = "health-app-static-v126"; // Версия также отображается в шапке приложения.
const CACHE_PREFIX = "health-app-static-";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/app.css",
  "./js/app.js",
  "./js/db.js",
  "./js/datetime.js",
  "./js/utils.js",
  "./js/statistics.js",
  "./js/medical.js",
  "./js/charts.js",
  "./js/export.js",
  "./js/import.js",
  "./js/interface-settings.js",
  "./js/pain.js",
  "./js/medications.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

const shellUrls = new Set(APP_SHELL.map((path) => new URL(path, self.registration.scope).href));
const indexUrl = new URL("./index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(caches.match(indexUrl).then((cached) => cached || fetch(request)));
    return;
  }

  if (!shellUrls.has(url.href)) return;
  event.respondWith(caches.match(request, { ignoreSearch: true }).then((cached) => cached || fetch(request)));
});
