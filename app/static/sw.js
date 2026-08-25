/* Service worker — app-shell UNIQUEMENT (HTML/CSS/JS statiques). Ne touche
   jamais à /api/* : le serveur envoie déjà Cache-Control: no-store sur ces
   réponses (voir main.py, middleware no_cache) — les notasks chiffrées ne
   doivent transiter que via le réseau, jamais depuis un cache local. Ce
   service worker sert uniquement à installer l'app (PWA) et à accélérer
   les chargements suivants, pas à donner un accès hors-ligne aux notasks.

   Stratégie réseau d'abord, repli sur le cache : jamais le cache en
   premier, sinon un redéploiement resterait invisible tant que le cache
   n'expire pas — même philosophie que le Cache-Control: no-cache déjà posé
   côté serveur sur tout le reste (voir main.py). */
const CACHE_NAME = 'notask-shell-v10';
const SHELL_FILES = [
  '/',
  '/quick',
  '/static/style.css',
  '/static/app.js',
  '/static/favicon.svg',
  '/static/manifest.json',
  '/static/quick-manifest.json',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/static/icon-maskable-192.png',
  '/static/icon-maskable-512.png',
  '/static/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // Le nouveau service worker prend la main dès l'installation, sans
  // attendre la fermeture de tous les onglets ouverts — cohérent avec
  // BUILD_VERSION, dont tout le sens est de repérer un déploiement au plus
  // vite, pas de traîner sur une version en cache.
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;  // jamais intercepté, jamais mis en cache
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((reponse) => {
        const copie = reponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copie));
        return reponse;
      })
      .catch(() => caches.match(event.request))
  );
});
