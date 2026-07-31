/* notask — interface web. Vanilla JS, aucun framework. */

// Repère de version, à bumper à chaque changement notable de ce fichier —
// affiché bien visible au chargement pour trancher, sans ambiguïté, entre
// "le navigateur affiche encore une version en cache" et "il y a un vrai
// bug dans le code déployé". Coller ce numéro (visible dans la console,
// F12) résout en un coup d'œil ce genre de doute.
const BUILD_VERSION = '2026-07-31-labels-composer-1';
console.log('%c[notask] build ' + BUILD_VERSION, 'background:#6750a4;color:#fff;padding:2px 8px;border-radius:4px;font-weight:bold;');

const TOKEN_KEY = 'notask_token';
const COLORS = [
  'default', 'red', 'coral', 'orange', 'amber', 'yellow', 'lime',
  'green', 'emerald', 'teal', 'cyan', 'blue', 'indigo', 'violet',
  'purple', 'magenta', 'pink', 'rose', 'brown', 'slate', 'grey',
];

// Mêmes teintes que les classes .c-* de style.css, dupliquées ici pour
// pouvoir les poser en style inline sur un libellé (voir renderLabelsDrawer).
const LABEL_COLOR_HEX = {
  red: '#7a2e33', coral: '#8a3a2a', orange: '#8a541c', amber: '#856614',
  yellow: '#7a6f12', lime: '#55771c', green: '#2f7a3c', emerald: '#16785b',
  teal: '#146b6a', cyan: '#12607a', blue: '#1d548f', indigo: '#364196',
  violet: '#5138a3', purple: '#68318f', magenta: '#7d2c7d', pink: '#8a2c61',
  rose: '#8a2c44', brown: '#664a37', slate: '#3f4b5a', grey: '#4b4b52',
};

// Même alpha que le composeur/la recherche (.55), pour une couleur de
// libellé tout aussi atténuée plutôt qu'un aplat plein.
function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ============================ Chiffrement ============================
   Chiffrement de bout en bout du contenu des notes (titre, description,
   contenu, texte des lignes de checklist) : le serveur ne stocke et ne
   transporte que des chaînes chiffrées ; il n'a jamais accès à la clé.

   Deux clés distinctes :
   - KEK ("key-encryption key") : dérivée du mot de passe de connexion par
     PBKDF2, à partir du sel public de l'utilisateur (User.enc_salt). Jamais
     stockée, recalculée à chaque connexion.
   - DEK ("data-encryption key") : clé aléatoire qui chiffre réellement les
     notes, générée une seule fois. Stockée côté serveur "enveloppée"
     (chiffrée) par la KEK du moment (User.wrapped_dek) — le serveur voit
     l'enveloppe, jamais la DEK. Changer son propre mot de passe ne fait que
     réenvelopper la même DEK avec la nouvelle KEK (voir
     rewrapDekForNewPassword()) : aucune note n'est perdue. Seule une
     réinitialisation par un administrateur (qui ne connaît pas l'ancien mot
     de passe) empêche de déballer l'ancienne enveloppe ; une nouvelle DEK
     est alors générée, et les notes chiffrées avec l'ancienne restent
     illisibles — c'est la conséquence attendue, pas un bug.

   La DEK déballée (encKey) n'est mise en cache qu'en sessionStorage, jamais
   localStorage — elle ne survit ni à la fermeture de l'onglet, ni à celle
   du navigateur, contrairement au jeton de connexion. Conséquence assumée :
   une nouvelle fenêtre ou un redémarrage du navigateur redemande le mot de
   passe (voir boot()).

   Format d'un champ chiffré : "e1:" + base64(iv[12 octets] + données
   chiffrées). Une valeur sans ce préfixe est traitée comme du texte en
   clair (notes créées avant l'activation de cette fonctionnalité) : elle
   reste lisible telle quelle et sera chiffrée à la prochaine modification. */

const ENC_PREFIX = 'e1:';
const EKEY_STORAGE = 'notask_ekey';
let encKey = null; // CryptoKey AES-GCM (la DEK, déballée) — jamais persistée telle quelle

function bytesToBase64(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function deriveKEK(password, saltHex) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  // 210 000 itérations : recommandation OWASP 2023 pour PBKDF2-HMAC-SHA256.
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 210000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function generateDek() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function wrapDek(dek, kek) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const raw = await crypto.subtle.exportKey('raw', dek);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw);
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return ENC_PREFIX + bytesToBase64(combined);
}

async function unwrapDek(wrapped, kek) {
  const combined = base64ToBytes(wrapped.slice(ENC_PREFIX.length));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ct);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

/* Appelée juste après une connexion/inscription réussie (mot de passe
   encore disponible en clair dans le formulaire). Déballe la DEK existante,
   ou en génère une nouvelle si aucune enveloppe valide n'est déchiffrable
   avec le mot de passe fourni (première connexion, ou après une
   réinitialisation par un administrateur — voir le commentaire plus haut). */
async function unlockWithPassword(password, user) {
  const kek = await deriveKEK(password, user.enc_salt);
  encKey = null;
  if (user.wrapped_dek) {
    try {
      encKey = await unwrapDek(user.wrapped_dek, kek);
    } catch {
      encKey = null; // enveloppe posée par un autre mot de passe (reset admin)
    }
  }
  if (!encKey) {
    encKey = await generateDek();
    const wrapped = await wrapDek(encKey, kek);
    await api('/auth/enc-key', { method: 'PUT', body: { wrapped_dek: wrapped } });
    user.wrapped_dek = wrapped;
  }
  const raw = await crypto.subtle.exportKey('raw', encKey);
  sessionStorage.setItem(EKEY_STORAGE, bytesToBase64(new Uint8Array(raw)));
}

/* Appelée après un changement de mot de passe volontaire (l'ancien est
   vérifié côté serveur) : réenveloppe la même DEK — déjà en mémoire, donc
   aucune note existante n'a besoin d'être rechiffrée. */
async function rewrapDekForNewPassword(newPassword) {
  if (!encKey || !state.user) return;
  const kek = await deriveKEK(newPassword, state.user.enc_salt);
  const wrapped = await wrapDek(encKey, kek);
  await api('/auth/enc-key', { method: 'PUT', body: { wrapped_dek: wrapped } });
}

/* Reprend la DEK mise en cache en session (même onglet, pas de redémarrage
   du navigateur) — évite de redemander le mot de passe à chaque rechargement
   de page tant que l'onglet reste ouvert. */
async function restoreCachedKey() {
  const cached = sessionStorage.getItem(EKEY_STORAGE);
  if (!cached) return false;
  try {
    encKey = await crypto.subtle.importKey('raw', base64ToBytes(cached), 'AES-GCM', true, ['encrypt', 'decrypt']);
    return true;
  } catch {
    return false;
  }
}

function clearEncKey() {
  encKey = null;
  sessionStorage.removeItem(EKEY_STORAGE);
}

async function encryptField(plain) {
  if (!plain) return '';
  if (!encKey) throw new Error('Notasks verrouillées : reconnectez-vous.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, new TextEncoder().encode(plain));
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return ENC_PREFIX + bytesToBase64(combined);
}

async function decryptField(value) {
  if (!value || !value.startsWith(ENC_PREFIX)) return value || '';
  if (!encKey) return 'Notask verrouillée';
  try {
    const combined = base64ToBytes(value.slice(ENC_PREFIX.length));
    const iv = combined.slice(0, 12);
    const ct = combined.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, encKey, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return 'Contenu illisible (déchiffrement impossible)';
  }
}

/* Chiffrement binaire des pièces jointes — même DEK (encKey) et même
   principe que encryptField()/decryptField(), mais sur des octets bruts
   plutôt que du texte, et sans le préfixe "e1:" ni le passage par base64
   (inutile : le blob part directement dans un FormData, pas dans du JSON).
   Format du blob envoyé au serveur : iv (12 octets) + texte chiffré. */
async function encryptBinary(buffer) {
  if (!encKey) throw new Error('Notasks verrouillées : reconnectez-vous.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, buffer);
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return combined;
}

async function decryptBinary(buffer) {
  if (!encKey) throw new Error('Notasks verrouillées : reconnectez-vous.');
  const bytes = new Uint8Array(buffer);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, encKey, ct);
}

/* Déchiffre en place les champs sensibles d'une note reçue de l'API, avant
   de l'exposer au reste de l'app — qui manipule ensuite toujours du texte
   en clair, exactement comme avant l'introduction du chiffrement. */
async function decryptNote(n) {
  n.title = await decryptField(n.title);
  n.description = await decryptField(n.description);
  n.content = await decryptField(n.content);
  if (n.items) {
    for (const it of n.items) it.text = await decryptField(it.text);
  }
  if (n.attachments) {
    for (const a of n.attachments) {
      try {
        a.meta = JSON.parse(await decryptField(a.enc_meta) || '{}');
      } catch {
        a.meta = { name: 'Fichier', mime: 'application/octet-stream' };
      }
    }
  }
  return n;
}

let state = {
  user: null,
  view: 'notes',
  notes: [],
  showArchived: false,
  showFavoritesOnly: false,
  search: '',
  tasks: [],
  trashNotes: [],
  editingNote: null,
  editingNoteItems: [],
  labels: [],
  labelFilter: null,
  editingLabelIds: [],
  composerIcon: null,
  editingIcon: null,
};

const BUCKET_LABELS = {
  late: 'Notasks en retard',
  today: 'Notasks du jour',
  upcoming: 'Notasks à venir',
  done: 'Notasks terminées',
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* Filet de sécurité : une action qui échoue sans être explicitement
   rattrapée ne doit jamais rester silencieuse — sans quoi un clic qui ne
   fait rien devient indiscernable d'un bug de l'interface. */
window.addEventListener('unhandledrejection', (e) => {
  const texte = e.reason && e.reason.message ? e.reason.message : 'Une erreur est survenue.';
  if (texte !== 'Session expirée') alert(texte);
});

/* ------------------------------- API ------------------------------- */

function token() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const t = token();
  if (t) headers['Authorization'] = 'Bearer ' + t;

  const res = await fetch('/api' + path, {
    ...options,
    headers,
    cache: 'no-store',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) { setToken(null); showLogin(); throw new Error('Session expirée'); }
  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.detail) || 'Erreur ' + res.status);
  return data;
}

/* Envoi multipart (pièces jointes) : pas de Content-Type manuel — le
   navigateur doit fixer lui-même la frontière ("boundary") du FormData,
   sinon le serveur ne peut pas parser le corps de la requête. `method`
   passé à 'PUT' pour remplacer une pièce jointe existante (voir
   openImageEditor()), 'POST' par défaut pour en créer une nouvelle. */
async function apiUpload(path, formData, method = 'POST') {
  const t = token();
  const res = await fetch('/api' + path, {
    method,
    headers: t ? { Authorization: 'Bearer ' + t } : {},
    body: formData,
  });
  if (res.status === 401) { setToken(null); showLogin(); throw new Error('Session expirée'); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.detail) || 'Erreur ' + res.status);
  return data;
}

/* Récupère des octets bruts (contenu chiffré d'une pièce jointe) — api()
   ne convient pas ici, elle force un parsing JSON de la réponse. */
async function apiFetchBytes(path) {
  const t = token();
  const res = await fetch('/api' + path, {
    headers: t ? { Authorization: 'Bearer ' + t } : {},
    cache: 'no-store',
  });
  if (res.status === 401) { setToken(null); showLogin(); throw new Error('Session expirée'); }
  if (!res.ok) throw new Error('Erreur ' + res.status);
  return res.arrayBuffer();
}

/* ------------------------- Pièces jointes ------------------------- */
/* 8 Mo de fichier d'origine — un peu de marge est laissée côté serveur pour
   l'overhead d'AES-GCM (voir MAX_ATTACHMENT_BYTES dans attachments.py),
   mais la limite annoncée à l'utilisateur porte sur le fichier d'origine. */
const MAX_ATTACHMENT_MB = 8;
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

// Cache mémoire des pièces jointes déjà déchiffrées (id -> {blob, name, mime}
// -> aussi url, générée à la demande). Une image reste modifiable via
// l'éditeur d'image (voir openImageEditor() plus bas), qui remplace son
// contenu sans changer son id : dans ce cas précis, l'entrée est retirée du
// cache pour forcer un rechargement des octets à jour — c'est la seule
// autre raison d'invalidation que la suppression elle-même.
const attachmentCache = new Map();

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' Ko';
  return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
}

/* Chiffre et envoie un fichier choisi (bouton, presse-papier ou
   glisser-déposer) — vérifie la taille avant de chiffrer, pour ne pas
   gaspiller du temps CPU sur un fichier de toute façon refusé. */
async function uploadAttachment(noteId, file) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`« ${file.name} » dépasse ${MAX_ATTACHMENT_MB} Mo (${formatFileSize(file.size)})`);
  }
  const buffer = await file.arrayBuffer();
  const encrypted = await encryptBinary(buffer);
  const meta = await encryptField(JSON.stringify({
    name: file.name || 'Fichier',
    mime: file.type || 'application/octet-stream',
  }));

  const form = new FormData();
  form.append('file', new Blob([encrypted]), 'blob');
  form.append('meta', meta);
  return apiUpload(`/notes/${noteId}/attachments`, form);
}

async function deleteAttachment(attachmentId) {
  await api('/attachments/' + attachmentId, { method: 'DELETE' });
  attachmentCache.delete(attachmentId);
}

/* Télécharge et déchiffre une pièce jointe (une seule fois, mise en cache
   ensuite). Retourne {blob, url, name, mime} — `url` est une object URL
   valable pour toute la session de page (jamais révoquée explicitement :
   l'app ne recharge pas assez de pièces jointes différentes pour que ça
   pèse sur la mémoire d'un onglet). */
async function loadAttachment(att) {
  if (attachmentCache.has(att.id)) return attachmentCache.get(att.id);
  const raw = await apiFetchBytes('/attachments/' + att.id);
  const plain = await decryptBinary(raw);
  const meta = att.meta || { name: 'Fichier', mime: 'application/octet-stream' };
  const blob = new Blob([plain], { type: meta.mime || 'application/octet-stream' });
  const result = { blob, url: URL.createObjectURL(blob), name: meta.name || 'Fichier', mime: meta.mime || '' };
  attachmentCache.set(att.id, result);
  return result;
}

/* ---------------------------- Utilitaires ---------------------------- */

function msg(el, text, kind = 'error') {
  el.innerHTML = text ? `<div class="msg ${kind}">${escapeHtml(text)}</div>` : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Icônes SVG, tracé uniquement — aucune police ni dépendance externe.
   Volontairement différentes de celles de Keep tout en restant lisibles. */
const ICONS = {
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17.5" cy="10.5" r="1.2"/><circle cx="8.5" cy="7.5" r="1.2"/><circle cx="6.5" cy="12.5" r="1.2"/><path d="M12 2a10 10 0 1 0 0 20c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a6 6 0 0 0 6-6c0-4.9-4.5-8.6-10-8.6z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5z"/><path d="M12 14v6"/></svg>',
  pinFilled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5z"/><path d="M12 14v6" fill="none"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>',
  unarchive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M12 17v-5"/><path d="M9.5 14.5 12 12l2.5 2.5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 4h4"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>',

  /* Cuillère : grosse tête ovale, manche court. Jaune, en remplacement de
     l'ampoule de Keep. Le viewBox est resserré autour de la forme (et non
     0 0 24 24) : sans cela, la marge interne du carré de dessin s'ajoutait
     au gap CSS et donnait un espacement visuel bien plus grand que 4px. */
  spoon: '<svg viewBox="6 1 12 20"><ellipse cx="12" cy="8" rx="5.5" ry="6.5" fill="#ffd54f"/><ellipse cx="12" cy="7.6" rx="3.4" ry="4.2" fill="#ffe082"/><rect x="10.3" y="13" width="3.4" height="7.6" rx="1.7" fill="#ffd54f"/></svg>',
  /* Même cuillère, en bleu — posée à côté de la jaune dans le logo. */
  spoonBlue: '<svg viewBox="6 1 12 20"><ellipse cx="12" cy="8" rx="5.5" ry="6.5" fill="#42a5f5"/><ellipse cx="12" cy="7.6" rx="3.4" ry="4.2" fill="#90caf9"/><rect x="10.3" y="13" width="3.4" height="7.6" rx="1.7" fill="#42a5f5"/></svg>',

  /* Calendrier — trait Material, recolorable via currentColor. */
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>',

  tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l2 2 3.5-3.5"/><path d="M4 17l2 2 3.5-3.5"/><path d="M13 7h7"/><path d="M13 17h7"/></svg>',
  late: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><circle cx="12" cy="14.5" r="1.6" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.5 2.5 4.5-5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  noteRef: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h4"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.4a3.2 3.2 0 0 1 0 5.2"/><path d="M17.5 14.2A5.5 5.5 0 0 1 20.5 19"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6.5 3.5 12 9 17.5"/><path d="M15 6.5 20.5 12 15 17.5"/></svg>',
  attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8.5 9.5 16a3 3 0 0 1-4.2-4.2l8-8a4.5 4.5 0 0 1 6.4 6.4l-8.1 8.1a2 2 0 0 1-2.8-2.8l7-7"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 3.5H5.5A2 2 0 0 0 3.5 5.5v6l9.6 9.6a2 2 0 0 0 2.8 0l5.8-5.8a2 2 0 0 0 0-2.8z"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/></svg>',

  /* Outils de l'éditeur d'image (voir openImageEditor() plus bas). */
  imgRect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="16" height="12" rx="1.5"/></svg>',
  imgEllipse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="12" rx="8" ry="6"/></svg>',
  imgHighlight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14 14 6l4 4-8 8H6z"/><path d="M6 14 4 20l6-2"/></svg>',
  imgText: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6.5h14"/><path d="M12 6.5V19"/><path d="M9 19h6"/></svg>',
  imgMosaic: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8.5H4.5V5"/><path d="M4.5 8.5a8 8 0 1 1-2 5.3"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7.5 11 12 15.5 16.5 11"/><path d="M4.5 17.5v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 9.5a8 8 0 1 1 .8 6.2"/><path d="M4.5 4.5v5h5"/><path d="M12 8v4.5l3 2"/></svg>',
};

/* Icônes facultatives associables à une note, à la création comme à
   l'édition — jeu fixe, synchronisé avec ICON_KEYS côté serveur
   (app/routers/notes.py). En couleur (plutôt qu'en simple trait) pour
   qu'elles se distinguent d'un coup d'œil sur la carte. */
const ICON_CHOICES = {
  star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.65l5.9-.85z" fill="#ffd54f"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M4 11.5 12 4l8 7.5v8.5a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" fill="#ef9a6d"/></svg>',
  work: '<svg viewBox="0 0 24 24"><rect x="3.5" y="7.5" width="17" height="12" rx="1.6" fill="#a1887f"/><path d="M8.5 7.5V5.8a1.6 1.6 0 0 1 1.6-1.6h3.8a1.6 1.6 0 0 1 1.6 1.6v1.7" fill="none" stroke="#a1887f" stroke-width="1.6"/></svg>',
  shopping: '<svg viewBox="0 0 24 24"><path d="M4 7h16l-1.5 10.5a2 2 0 0 1-2 1.7H7.5a2 2 0 0 1-2-1.7z" fill="#81c784"/><path d="M8 7V5.5a4 4 0 0 1 8 0V7" fill="none" stroke="#81c784" stroke-width="1.6"/></svg>',
  /* Cœur reconstruit : les deux lobes sont désormais des miroirs exacts
     l'un de l'autre de part et d'autre de x=12 (l'ancien tracé était
     dissymétrique, d'où l'aspect « pas droit »). */
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-6.7-4.35-9.3-8.2C1 10.5 1.6 6.9 4.6 5.2 7 3.9 9.8 4.7 12 7.3 14.2 4.7 17 3.9 19.4 5.2c3 1.7 3.6 5.3 1.9 7.6C18.7 16.65 12 21 12 21z" fill="#e57373"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><rect x="4.3" y="3.5" width="1.4" height="17" rx="0.7" fill="#64b5f6"/><path d="M5.7 4.5h11l-2.5 4 2.5 4h-11z" fill="#64b5f6"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M4 5.5A2 2 0 0 1 6 4h5v16H6a2 2 0 0 0-2 2z" fill="#ba68c8"/><path d="M20 5.5A2 2 0 0 0 18 4h-5v16h5a2 2 0 0 1 2 2z" fill="#ce93d8"/></svg>',
  idea: '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0-3.2 11.1c.5.35.7.9.7 1.4v.5h5v-.5c0-.5.2-1.05.7-1.4A6 6 0 0 0 12 3z" fill="#fff176"/><rect x="9.5" y="17.5" width="5" height="1.6" rx="0.8" fill="#fbc02d"/><rect x="10" y="19.5" width="4" height="1.4" rx="0.7" fill="#fbc02d"/></svg>',
  travel: '<svg viewBox="0 0 24 24"><path d="M21 3 3 10.5l6.5 2.3L12 21l2.4-6.8L21 3z" fill="#4fc3f7"/></svg>',
  gift: '<svg viewBox="0 0 24 24"><rect x="4" y="9.5" width="16" height="10.5" rx="1" fill="#f06292"/><rect x="4" y="6.5" width="16" height="3.5" rx="1" fill="#f48fb1"/><rect x="11" y="6.5" width="2" height="13.5" fill="#fff"/></svg>',
  money: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="#66bb6a"/><path d="M14.5 8.7a4.3 4.3 0 1 0 0 6.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><path d="M8.3 10.8h5M8.3 13.2h5" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/></svg>',
  music: '<svg viewBox="0 0 24 24"><circle cx="7" cy="17.5" r="2.6" fill="#9575cd"/><circle cx="16" cy="15.5" r="2.6" fill="#9575cd"/><path d="M9.6 17.5V5.5L18.6 4v11" fill="none" stroke="#9575cd" stroke-width="1.6"/></svg>',

  /* Mêmes cuillères que le logo (#brand-logo/ICONS.spoon[Blue]), redessinées
     dans le viewBox 0 0 24 24 commun à ce jeu d'icônes plutôt que le viewBox
     resserré des originales (6 1 12 20) — sinon elles apparaîtraient bien
     plus grandes que les autres choix une fois mises côte à côte dans le
     sélecteur. */
  spoonyellow: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="9.5" rx="5.5" ry="6.5" fill="#ffd54f"/><ellipse cx="12" cy="9.1" rx="3.4" ry="4.2" fill="#ffe082"/><rect x="10.3" y="14.5" width="3.4" height="7.6" rx="1.7" fill="#ffd54f"/></svg>',
  spoonblue: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="9.5" rx="5.5" ry="6.5" fill="#42a5f5"/><ellipse cx="12" cy="9.1" rx="3.4" ry="4.2" fill="#90caf9"/><rect x="10.3" y="14.5" width="3.4" height="7.6" rx="1.7" fill="#42a5f5"/></svg>',
  spoons: '<svg viewBox="0 0 24 24"><g transform="translate(1.5,1) scale(0.62)"><ellipse cx="12" cy="9.5" rx="5.5" ry="6.5" fill="#ffd54f"/><ellipse cx="12" cy="9.1" rx="3.4" ry="4.2" fill="#ffe082"/><rect x="10.3" y="14.5" width="3.4" height="7.6" rx="1.7" fill="#ffd54f"/></g><g transform="translate(9,1) scale(0.62)"><ellipse cx="12" cy="9.5" rx="5.5" ry="6.5" fill="#42a5f5"/><ellipse cx="12" cy="9.1" rx="3.4" ry="4.2" fill="#90caf9"/><rect x="10.3" y="14.5" width="3.4" height="7.6" rx="1.7" fill="#42a5f5"/></g></svg>',
};

/* Affiche une échéance de façon lisible : « aujourd'hui 14:00 », « 3 août 09:30 ». */
function formatDue(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const now = new Date();
  const heure = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const memeJour = (a, b) => a.toDateString() === b.toDateString();

  const demain = new Date(now); demain.setDate(now.getDate() + 1);
  const hier = new Date(now); hier.setDate(now.getDate() - 1);

  if (memeJour(d, now)) return `aujourd'hui ${heure}`;
  if (memeJour(d, demain)) return `demain ${heure}`;
  if (memeJour(d, hier)) return `hier ${heure}`;

  const jour = d.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
  return `${jour} ${heure}`;
}

/* Conversions date/heure <-> ISO 8601 en UTC attendu par l'API.
   Le sélecteur n'utilise plus le widget natif <input type="datetime-local">
   (comportement trop variable d'un navigateur à l'autre pour le pas de 15mn,
   et un choix de jour dans son calendrier natif ne se comportait pas de
   façon fiable avec la fermeture du popover) : un <input type="date"> pour
   le jour + deux <select> pour l'heure et les minutes (uniquement 00/15/30/45)
   sont entièrement sous notre contrôle, donc prévisibles partout. */
function isoToParts(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  let minute = Math.round(d.getMinutes() / 15) * 15;
  let hour = d.getHours();
  if (minute === 60) { minute = 0; hour = (hour + 1) % 24; }
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hour: pad(hour),
    minute: pad(minute),
  };
}

function partsToIso(dateStr, hour, minute) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, Number(hour), Number(minute), 0, 0).toISOString();
}

/* Prochain quart d'heure à venir, pour une valeur de départ sensée quand
   aucune échéance n'est encore réglée. */
function nextQuarterHourParts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  let minute = Math.ceil(d.getMinutes() / 15) * 15;
  let hour = d.getHours();
  if (minute === 60) { minute = 0; hour = (hour + 1) % 24; }
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hour: pad(hour),
    minute: pad(minute),
  };
}

/* Popup de sélection date + heure, ancré sous l'icône calendrier qui l'ouvre.
   Une seule instance à la fois ; se ferme au clic extérieur ou sur Échap. */
let _closeCalPopup = null;

function closeCalPopup() {
  if (_closeCalPopup) { _closeCalPopup(); _closeCalPopup = null; }
}

function openCalPopup(anchor, currentIso, onChange) {
  closeCalPopup();

  const parts = isoToParts(currentIso) || nextQuarterHourParts();
  const hourOpts = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  const minOpts = ['00', '15', '30', '45'];

  const pop = document.createElement('div');
  pop.className = 'cal-popup';
  pop.innerHTML = `
    <div class="cal-popup-row">
      <input type="date" class="cal-popup-date">
      <select class="cal-popup-hour">${hourOpts.map((h) => `<option value="${h}">${h}</option>`).join('')}</select>
      <span class="cal-popup-colon">:</span>
      <select class="cal-popup-min">${minOpts.map((m) => `<option value="${m}">${m}</option>`).join('')}</select>
    </div>
    <div class="cal-popup-actions">
      <button type="button" class="btn ghost sm" data-act="clear">Effacer</button>
      <button type="button" class="btn sm" data-act="ok">Valider</button>
    </div>`;

  // Une case datée peut se trouver dans une <dialog> ouverte : celle-ci
  // s'affiche dans le "top layer" du navigateur, indépendant du z-index
  // normal. Un popup ajouté à document.body resterait donc caché derrière.
  // On l'ajoute plutôt dans le dialog lui-même, et on le positionne par
  // rapport à lui (dialog { position: relative } dans le CSS).
  const hostDialog = anchor.closest('dialog');
  const host = hostDialog || document.body;
  host.appendChild(pop);

  const dateInput = pop.querySelector('.cal-popup-date');
  const hourSelect = pop.querySelector('.cal-popup-hour');
  const minSelect = pop.querySelector('.cal-popup-min');
  dateInput.value = parts.date;
  hourSelect.value = parts.hour;
  minSelect.value = parts.minute;

  if (hostDialog) {
    const dialogRect = hostDialog.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    let top = anchorRect.bottom - dialogRect.top + 6;
    let left = anchorRect.left - dialogRect.left;
    left = Math.min(left, dialogRect.width - 250);
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(8, left)}px`;
  } else {
    const rect = anchor.getBoundingClientRect();
    const top = rect.bottom + window.scrollY + 6;
    let left = rect.left + window.scrollX;
    left = Math.min(left, window.scrollX + document.documentElement.clientWidth - 260);
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(8, left)}px`;
  }

  const currentValue = () => partsToIso(dateInput.value, hourSelect.value, minSelect.value);
  const finish = (iso) => { onChange(iso); closeCalPopup(); };
  pop.querySelector('[data-act=ok]').onclick = () => finish(currentValue());
  pop.querySelector('[data-act=clear]').onclick = () => finish(null);

  // Comme les autres popovers de l'app : toute façon de le quitter applique
  // la valeur en cours (pas seulement le bouton Valider) — sans quoi choisir
  // une date puis cliquer ailleurs (geste naturel) perdait silencieusement
  // le choix.
  const onOutside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) finish(currentValue()); };
  const onKey = (e) => { if (e.key === 'Escape') finish(currentValue()); };
  setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
  document.addEventListener('keydown', onKey);

  _closeCalPopup = () => {
    pop.remove();
    document.removeEventListener('mousedown', onOutside);
    document.removeEventListener('keydown', onKey);
  };

  dateInput.focus();
}

/* Popover de choix d'icône, même ancrage top-layer que le calendrier :
   dans le dialog s'il y en a un d'ouvert, sinon dans document.body. */
let _closeIconPopup = null;

function closeIconPopup() {
  if (_closeIconPopup) { _closeIconPopup(); _closeIconPopup = null; }
}

function openIconPopup(anchor, currentIcon, onChange) {
  closeIconPopup();

  const pop = document.createElement('div');
  pop.className = 'cal-popup icon-popup';
  pop.innerHTML = `
    <div class="icon-popup-grid">
      <button type="button" class="icon-opt" data-icon="" title="Aucune icône">${ICONS.plus}</button>
      ${Object.entries(ICON_CHOICES).map(([key, svg]) =>
        `<button type="button" class="icon-opt${key === currentIcon ? ' active' : ''}" data-icon="${key}">${svg}</button>`
      ).join('')}
    </div>`;

  const hostDialog = anchor.closest('dialog');
  const host = hostDialog || document.body;
  host.appendChild(pop);

  if (hostDialog) {
    const dialogRect = hostDialog.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    let top = anchorRect.bottom - dialogRect.top + 6;
    let left = anchorRect.left - dialogRect.left;
    left = Math.min(left, dialogRect.width - 220);
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(8, left)}px`;
  } else {
    const rect = anchor.getBoundingClientRect();
    pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
    pop.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
  }

  pop.querySelectorAll('.icon-opt').forEach((btn) => {
    btn.onclick = () => { onChange(btn.dataset.icon || null); closeIconPopup(); };
  });

  const onOutside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) closeIconPopup(); };
  const onKey = (e) => { if (e.key === 'Escape') closeIconPopup(); };
  setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
  document.addEventListener('keydown', onKey);

  _closeIconPopup = () => {
    pop.remove();
    document.removeEventListener('mousedown', onOutside);
    document.removeEventListener('keydown', onKey);
  };
}

/* Bouton de zone icône : affiche l'icône choisie, ou un simple "+" tant
   qu'aucune n'est associée à la note. */
function renderIconBtn(btn, iconKey) {
  btn.innerHTML = iconKey && ICON_CHOICES[iconKey] ? ICON_CHOICES[iconKey] : ICONS.plus;
  btn.classList.toggle('has-icon', !!iconKey);
}

/* Applique la couleur de la note comme fond du dialogue (éditer ou éditer
   simple), pour qu'il se fonde dans la carte qu'on est en train d'ouvrir. */
function applyDialogColor(dialogEl, color) {
  for (const c of COLORS) dialogEl.classList.remove('c-' + c);
  dialogEl.classList.add('c-' + (color || 'default'));
}

function show(id) {
  ['screen-setup', 'screen-login', 'screen-app'].forEach((s) => { $('#' + s).hidden = s !== id; });
}

/* ------------------------------ Écrans ------------------------------ */

function showLogin() { show('screen-login'); }

async function boot() {
  // Le chiffrement de bout en bout du contenu des notes (voir plus haut)
  // repose sur l'API WebCrypto, qui n'existe que dans un "contexte
  // sécurisé" (HTTPS, ou localhost en développement). Sans elle, mieux vaut
  // un message clair que des erreurs cryptiques partout dans l'app.
  if (!window.crypto || !window.crypto.subtle) {
    document.body.innerHTML =
      '<div style="max-width:32rem;margin:4rem auto;padding:1.5rem;font-family:sans-serif;color:#e6e0e9;">'
      + '<h1>Connexion non sécurisée</h1><p>notask chiffre le contenu des notasks dans le navigateur, ce qui '
      + "nécessite une connexion HTTPS (l'API de chiffrement du navigateur est désactivée en HTTP). "
      + 'Vérifiez la configuration HTTPS du serveur (Traefik/Coolify).</p></div>';
    return;
  }

  const status = await fetch('/api/auth/status', { cache: 'no-store' }).then((r) => r.json());
  if (status.needs_setup) { show('screen-setup'); return; }

  if (!token()) { showLogin(); return; }

  // Le jeton de connexion (localStorage) peut survivre à un redémarrage du
  // navigateur, mais la clé de chiffrement des notes non — jamais persistée
  // ailleurs qu'en sessionStorage (voir unlockWithPassword()). Sans elle,
  // impossible de déchiffrer quoi que ce soit : on redemande le mot de
  // passe plutôt que d'ouvrir une appli à moitié illisible.
  if (!(await restoreCachedKey())) {
    setToken(null);
    showLogin();
    return;
  }
  try {
    state.user = await api('/auth/me');
    enterApp();
  } catch { showLogin(); }
}

function enterApp() {
  show('screen-app');
  $('#who').textContent = state.user.username;
  $('#tab-admin').hidden = !state.user.is_admin;
  $('#admin-sep').hidden = !state.user.is_admin;

  // Icônes du menu latéral et logo
  $('#brand-logo').innerHTML = ICONS.spoon + ICONS.spoonBlue;
  // Survoler le logo affiche la version chargée — pas besoin d'ouvrir la
  // console pour vérifier si un déploiement a bien pris effet (voir
  // BUILD_VERSION en haut du fichier).
  $('#brand-logo').title = 'build ' + BUILD_VERSION;
  $('#nav-notes').innerHTML = ICONS.spoon + '<span class="label">Notasks</span>';
  $('#nav-favorites').innerHTML = ICONS.pinFilled + '<span class="label">Favoris</span>';
  $('#nav-archives').innerHTML = ICONS.archive + '<span class="label">Archives</span>';
  $('#nav-trash').innerHTML = ICONS.trash + '<span class="label">Corbeille</span>';
  $('#nav-tasks').innerHTML = ICONS.spoonBlue + '<span class="label">Toutes les notasks</span><span class="nav-count" id="count-tasks" hidden></span>';
  $('#nav-late').innerHTML = ICONS.late + '<span class="label">Notasks en retard</span><span class="nav-count" id="count-late" hidden></span>';
  $('#nav-today').innerHTML = ICONS.today + '<span class="label">Notasks du jour</span><span class="nav-count" id="count-today" hidden></span>';
  $('#nav-upcoming').innerHTML = ICONS.calendar + `<span class="label">${BUCKET_LABELS.upcoming}</span><span class="nav-count" id="count-upcoming" hidden></span>`;
  $('#tab-admin').innerHTML = ICONS.users + '<span class="label">Comptes</span>';

  loadLabels();
  switchView('notes');
  if (state.user.must_change_password) {
    $('#dlg-password').showModal();
    msg($('#dp-msg'), 'Votre mot de passe a été défini par un administrateur. Choisissez-en un nouveau.', 'ok');
  }
}

const TASK_VIEWS = { tasks: null, late: 'late', today: 'today', upcoming: 'upcoming' };

function switchView(view) {
  state.view = view;
  $$('.drawer-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  const isNotes = view === 'notes' || view === 'archives' || view === 'favorites';
  const isTasks = view in TASK_VIEWS;

  $('#view-notes').hidden = !isNotes;
  $('#view-tasks').hidden = !isTasks;
  $('#view-trash').hidden = view !== 'trash';
  $('#view-admin').hidden = view !== 'admin';

  // Colonne d'échéances : seulement sur les vues Notes/Favoris/Archives, là
  // où la mosaïque a des marges à céder (voir .shell.has-agenda). Son
  // contenu se recharge à l'intérieur de loadNotes() ci-dessous, pas ici :
  // un seul point de rechargement, plutôt que de dupliquer l'appel à chaque
  // fois que l'un ou l'autre change (pin, archive, éditions...).
  $('.shell').classList.toggle('has-agenda', isNotes);
  $('#agenda-col').hidden = !isNotes;

  if (isNotes) {
    state.showArchived = view === 'archives';
    state.showFavoritesOnly = view === 'favorites';
    $('#notes-empty').textContent = state.showArchived
      ? 'Aucune notask archivée.'
      : state.showFavoritesOnly ? 'Aucun favori.' : 'Aucune notask.';
    // On ne compose pas dans les archives, ni dans les favoris (vue filtrée
    // en lecture — une note qui vient d'y être créée n'est de toute façon
    // pas encore épinglée, donc disparaîtrait aussitôt de la liste).
    $('.note-composer').hidden = state.showArchived || state.showFavoritesOnly;
    loadNotes();
  }
  if (isTasks) {
    // Mêmes intitulés que le menu de gauche (BUCKET_LABELS), plus "tasks"
    // qui n'y figure pas (regroupement "Toutes", pas un bucket de tâches).
    const titres = { tasks: 'Toutes les notasks', ...BUCKET_LABELS };
    $('#tasks-title').textContent = titres[view];
    loadTasks(TASK_VIEWS[view]);
  }
  if (view === 'trash') loadTrash();
  if (view === 'admin') loadUsers();
}

/* ---------------------- Configuration / connexion ---------------------- */

$('#form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#setup-pw').value, pw2 = $('#setup-pw2').value;
  if (pw !== pw2) return msg($('#setup-msg'), 'Les deux mots de passe ne correspondent pas.');
  try {
    const data = await api('/auth/setup', {
      method: 'POST',
      body: { username: $('#setup-user').value, password: pw, is_admin: true },
    });
    setToken(data.access_token);
    await unlockWithPassword(pw, data.user);
    state.user = data.user;
    enterApp();
  } catch (err) { msg($('#setup-msg'), err.message); }
});

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const pw = $('#login-pw').value;
    const data = await api('/auth/login', {
      method: 'POST',
      body: { username: $('#login-user').value, password: pw },
    });
    setToken(data.access_token);
    await unlockWithPassword(pw, data.user);
    state.user = data.user;
    $('#login-pw').value = '';
    msg($('#login-msg'), '');
    enterApp();
  } catch (err) { msg($('#login-msg'), err.message); }
});

$('#btn-logout').addEventListener('click', () => { setToken(null); clearEncKey(); location.reload(); });
$$('.drawer-item[data-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

/* -------------------------------- Notes -------------------------------- */

/* Le paramètre "q" n'est plus envoyé au serveur : titre/description/contenu
   sont chiffrés de bout en bout, une recherche SQL sur le texte chiffré ne
   peut rien trouver. La recherche se fait donc ici, après déchiffrement. */
function noteMatchesSearch(n, q) {
  const needle = q.toLowerCase();
  return (n.title || '').toLowerCase().includes(needle)
    || (n.description || '').toLowerCase().includes(needle)
    || (n.content || '').toLowerCase().includes(needle)
    || (n.items || []).some((it) => (it.text || '').toLowerCase().includes(needle));
}

async function loadNotes() {
  const params = new URLSearchParams({ archived: state.showArchived });
  if (state.labelFilter) params.set('label', state.labelFilter);
  const notes = await api('/notes?' + params);
  await Promise.all(notes.map(decryptNote));
  let filtered = notes;
  // Favoris : pas de paramètre côté serveur, la liste des notes non
  // archivées est déjà chargée — filtrer ici sur `pinned` suffit, comme la
  // recherche juste en dessous.
  if (state.showFavoritesOnly) filtered = filtered.filter((n) => n.pinned);
  if (state.search) filtered = filtered.filter((n) => noteMatchesSearch(n, state.search));
  state.notes = filtered;
  renderNotes();
  if (!$('#agenda-col').hidden) loadAgenda();
  updateTaskBadges();
}

/* -------------------------------- Corbeille --------------------------------
   Notasks supprimées : liste en lecture seule, juste de quoi identifier la
   notask avant de la restaurer ou de la supprimer définitivement — pas
   d'édition possible depuis ici (voir renderNotes() pour la vue normale,
   bien plus riche en interactions). Purge automatique après 30 jours côté
   serveur (TRASH_RETENTION_DAYS dans notes.py) ; le même chiffre est
   dupliqué ici uniquement pour l'affichage du compte à rebours. */
const TRASH_RETENTION_DAYS = 30;

async function loadTrash() {
  const notes = await api('/notes?' + new URLSearchParams({ trashed: true }));
  await Promise.all(notes.map(decryptNote));
  state.trashNotes = notes;
  renderTrash();
}

function daysLeftInTrash(trashedAt) {
  const elapsedDays = (Date.now() - new Date(trashedAt).getTime()) / 86400000;
  return Math.max(0, Math.ceil(TRASH_RETENTION_DAYS - elapsedDays));
}

function renderTrash() {
  const grid = $('#trash-grid');
  grid.innerHTML = '';
  const notes = state.trashNotes || [];
  $('#trash-empty').hidden = notes.length > 0;

  for (const n of notes) {
    const el = document.createElement('article');
    el.className = 'trash-card c-' + n.color;

    const icon = n.icon && ICON_CHOICES[n.icon] ? `<span class="note-icon">${ICON_CHOICES[n.icon]}</span>` : '';
    const title = n.title || 'Notask sans titre';
    const snippet = n.is_checklist
      ? `${(n.items || []).length} élément${(n.items || []).length > 1 ? 's' : ''}`
      : (n.content || '').slice(0, 140);

    el.innerHTML = `
      <div class="trash-card-title-row">${icon}<h3>${escapeHtml(title)}</h3></div>
      ${n.description ? `<div class="description">${escapeHtml(n.description)}</div>` : ''}
      ${snippet ? `<div class="trash-card-snippet">${escapeHtml(snippet)}</div>` : ''}
      <div class="trash-card-meta">${daysLeftInTrash(n.trashed_at)} j avant suppression définitive</div>
      <div class="trash-card-actions">
        <button type="button" class="btn ghost sm" data-act="restore">${ICONS.undo} Restaurer</button>
        <button type="button" class="btn danger sm" data-act="purge">${ICONS.trash} Supprimer définitivement</button>
      </div>`;

    el.querySelector('[data-act=restore]').onclick = async () => {
      await api('/notes/' + n.id + '/restore', { method: 'POST' });
      loadTrash();
      updateTaskBadges();
    };
    el.querySelector('[data-act=purge]').onclick = async () => {
      if (!confirm('Supprimer définitivement cette notask ? Cette action est irréversible.')) return;
      await api('/notes/' + n.id, { method: 'DELETE' });
      loadTrash();
    };

    grid.appendChild(el);
  }
}

/* -------------------------------- Libellés --------------------------------
   Catégories façon Keep, affichées dans le menu latéral. Cliquer sur un
   libellé filtre les notes ; une note peut en porter plusieurs. */

async function loadLabels() {
  state.labels = await api('/labels');
  renderLabelsDrawer();
}

function renderLabelsDrawer() {
  const box = $('#labels-list');
  box.innerHTML = '';
  for (const l of state.labels) {
    const row = document.createElement('div');
    row.className = 'label-row';

    const btn = document.createElement('button');
    btn.className = 'drawer-item label-item' + (state.labelFilter === l.id ? ' active' : '');
    btn.dataset.id = l.id;
    // Couleur en style inline plutôt qu'en classe .c-* : une classe a la même
    // spécificité CSS que .drawer-item:hover, qui l'écrasait donc au survol
    // (la couleur ne restait visible qu'en dehors du survol). Un style inline
    // gagne toujours, la couleur reste affichée en toutes circonstances.
    if (l.color && LABEL_COLOR_HEX[l.color]) btn.style.background = hexToRgba(LABEL_COLOR_HEX[l.color], .55);
    btn.innerHTML = `<span class="label">${escapeHtml(l.name)}</span>`;
    btn.onclick = () => {
      state.labelFilter = state.labelFilter === l.id ? null : l.id;
      if (state.view !== 'notes' && state.view !== 'archives') switchView('notes');
      else { renderLabelsDrawer(); loadNotes(); }
    };
    btn.oncontextmenu = async (e) => {
      e.preventDefault();
      if (!confirm(`Supprimer le libellé « ${l.name} » ?`)) return;
      await api('/labels/' + l.id, { method: 'DELETE' });
      if (state.labelFilter === l.id) state.labelFilter = null;
      loadLabels();
      loadNotes();
    };

    // Crayon visible au survol de la ligne : renommer et choisir une
    // couleur de fond propre au libellé, indépendante des couleurs de note.
    const edit = document.createElement('button');
    edit.className = 'label-edit-btn';
    edit.type = 'button';
    edit.setAttribute('aria-label', 'Modifier le libellé');
    edit.innerHTML = ICONS.pencil;
    edit.onclick = (e) => { e.stopPropagation(); openLabelEditPopup(edit, l); };

    row.append(btn, edit);

    // Glisser-déposer pour réordonner manuellement — même mécanique que la
    // mosaïque de notes (voir getDropTarget()/commitNoteOrder() plus bas),
    // juste scopée à '.label-row' au lieu de '.note'. Le crayon (édition)
    // ne doit pas déclencher le geste, sous peine de gêner son propre clic.
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      if (e.target.closest('.label-edit-btn')) { e.preventDefault(); return; }
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      commitLabelOrder();
    });

    box.appendChild(row);
  }
}

$('#labels-list').addEventListener('dragover', (e) => {
  const dragging = $('#labels-list').querySelector('.label-row.dragging');
  if (!dragging) return;
  e.preventDefault();
  const target = getDropTarget($('#labels-list'), e.clientX, e.clientY, '.label-row');
  if (!target || target.el === dragging) return;
  if (target.before) target.el.before(dragging);
  else target.el.after(dragging);
});

/* Comme commitNoteOrder() : l'ordre visuel du DOM fait foi une fois le
   geste terminé, on ne PATCH que les libellés dont la position a changé. */
async function commitLabelOrder() {
  const ids = [...$('#labels-list').querySelectorAll('.label-row')].map((row) => {
    const btn = row.querySelector('.label-item');
    return btn ? Number(btn.dataset.id) : null;
  }).filter((id) => id !== null);
  const total = ids.length;
  const updates = [];
  ids.forEach((id, idx) => {
    const label = state.labels.find((x) => x.id === id);
    if (!label) return;
    const newPos = (total - idx) * 1000;
    if (Math.round(label.position || 0) !== newPos) {
      updates.push(api('/labels/' + id, { method: 'PATCH', body: { position: newPos } }));
    }
  });
  if (!updates.length) return;
  try {
    await Promise.all(updates);
  } catch (err) {
    alert(err.message);
  } finally {
    loadLabels();
  }
}

/* Popover de renommage + couleur d'un libellé, ancré sous le crayon. */
function openLabelEditPopup(anchor, label) {
  closeCalPopup();
  closeIconPopup();

  const pop = document.createElement('div');
  pop.className = 'cal-popup label-edit-popup';
  pop.innerHTML = `
    <input type="text" class="cal-popup-input" maxlength="50">
    <div class="label-color-grid">
      <button type="button" class="swatch label-color-opt" data-color="" title="Aucune couleur"></button>
      ${COLORS.filter((c) => c !== 'default').map((c) =>
        `<button type="button" class="swatch c-${c} label-color-opt${c === label.color ? ' active' : ''}"
                 data-color="${c}" title="${c}"></button>`
      ).join('')}
    </div>
    <div class="cal-popup-actions">
      <button type="button" class="label-delete-btn" data-act="delete" title="Supprimer le libellé" aria-label="Supprimer le libellé">${ICONS.close}</button>
      <span class="cal-popup-actions-spacer"></span>
      <button type="button" class="btn ghost sm" data-act="close">Fermer</button>
      <button type="button" class="btn sm" data-act="save">Enregistrer</button>
    </div>`;
  document.body.appendChild(pop);

  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
  pop.style.left = `${Math.max(8, rect.left + window.scrollX - 150)}px`;

  const input = pop.querySelector('.cal-popup-input');
  input.value = label.name;
  let chosenColor = label.color || null;

  pop.querySelectorAll('.label-color-opt').forEach((btn) => {
    btn.onclick = () => {
      chosenColor = btn.dataset.color || null;
      pop.querySelectorAll('.label-color-opt').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', onOutside);
    document.removeEventListener('keydown', onKey);
  };

  // Comme les autres fenêtres de l'app : toute façon de quitter ce popover
  // (bouton, clic à côté, Échap) enregistre — sans ça, choisir une couleur
  // puis cliquer ailleurs (geste naturel) perdait silencieusement le choix,
  // puisque seul le bouton "Enregistrer" appelait l'API.
  const save = async () => {
    try {
      await api('/labels/' + label.id, {
        method: 'PATCH',
        body: { name: input.value.trim() || label.name, color: chosenColor },
      });
    } catch (err) {
      alert(err.message);
    }
    close();
    loadLabels();
    loadNotes();
  };

  pop.querySelector('[data-act=close]').onclick = save;
  pop.querySelector('[data-act=save]').onclick = save;
  // Même geste que le clic droit sur le libellé dans le menu (raccourci
  // existant, conservé) : confirmation puis suppression, sans passer par
  // save() — un libellé supprimé n'a plus de nom/couleur à enregistrer.
  pop.querySelector('[data-act=delete]').onclick = async () => {
    if (!confirm(`Supprimer définitivement le libellé « ${label.name} » ?`)) return;
    close();
    try {
      await api('/labels/' + label.id, { method: 'DELETE' });
    } catch (err) {
      alert(err.message);
    }
    if (state.labelFilter === label.id) state.labelFilter = null;
    loadLabels();
    loadNotes();
  };

  const onOutside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) save(); };
  const onKey = (e) => { if (e.key === 'Escape') save(); };
  setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
  document.addEventListener('keydown', onKey);

  input.focus();
  input.select();
}

$('#label-new-btn').addEventListener('click', async () => {
  const name = $('#label-new-input').value.trim();
  if (!name) return;
  try {
    await api('/labels', { method: 'POST', body: { name } });
    $('#label-new-input').value = '';
    loadLabels();
  } catch (err) { alert(err.message); }
});
$('#label-new-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#label-new-btn').click(); }
});

// Le glisser-déposer ne réordonne que la vue par défaut (pas de recherche,
// pas de filtre par libellé, pas les archives) : ailleurs, ne recalculer les
// positions que du sous-ensemble visible mélangerait l'ordre des notes
// masquées par le filtre.
function notesReorderable() {
  return !state.showArchived && !state.showFavoritesOnly && !state.search && !state.labelFilter;
}

/* Place le composeur, la recherche, ET assez de notes pour les entourer des
   deux côtés — le tout en colonnes/lignes de grille EXPLICITES, calculées à
   partir du nombre réel de colonnes.
   Vérifié en navigateur headless : le placement automatique de CSS Grid ne
   comble JAMAIS une colonne restée libre avant un élément explicitement
   positionné (les notes suivantes, en position automatique, atterrissent
   systématiquement après lui, jamais avant, quel que soit leur ordre dans le
   DOM). Un simple "grid-column" sur le composeur ne suffit donc pas à faire
   apparaître des notes à sa gauche : il faut aussi positionner soi-même,
   explicitement, les quelques notes qui doivent occuper ces cases-là. Les
   notes suivantes (au-delà de ce qu'il faut pour remplir les deux rangées du
   composeur et de la recherche) retrouvent un placement 100% automatique à
   partir de la rangée suivante — inchangé, aucune limite de nombre de notes. */
function layoutMosaic() {
  const grid = $('#notes-grid');
  const composer = $('.note-composer');
  const search = $('.search-toolbar');
  const noteEls = $$('#notes-grid .note');
  if (!grid || !composer || !search) return;

  const reset = (el) => { el.style.gridColumn = ''; el.style.gridRow = ''; };

  if (window.innerWidth <= 860) {
    reset(composer); reset(search);
    noteEls.forEach(reset);
    return;
  }

  const cols = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length;
  const span = Math.min(2, cols);
  const start = Math.max(1, Math.floor((cols - span) / 2) + 1);
  const colValue = `${start} / span ${span}`;

  let row = 1;
  const composerVisible = !composer.hidden;
  if (composerVisible) {
    composer.style.gridColumn = colValue;
    composer.style.gridRow = String(row);
    row += 1;
  } else {
    reset(composer);
  }
  const searchRow = row;
  search.style.gridColumn = colValue;
  search.style.gridRow = String(searchRow);

  let noteIdx = 0;
  const placeSideNotes = (rowNum) => {
    for (let c = 1; c < start && noteIdx < noteEls.length; c++, noteIdx++) {
      noteEls[noteIdx].style.gridColumn = String(c);
      noteEls[noteIdx].style.gridRow = String(rowNum);
    }
    for (let c = start + span; c <= cols && noteIdx < noteEls.length; c++, noteIdx++) {
      noteEls[noteIdx].style.gridColumn = String(c);
      noteEls[noteIdx].style.gridRow = String(rowNum);
    }
  };
  if (composerVisible) placeSideNotes(1);
  placeSideNotes(searchRow);

  // Le reste suit un placement automatique normal, à partir de la rangée
  // suivante (aucune case du composeur/de la recherche ne reste à combler).
  for (; noteIdx < noteEls.length; noteIdx++) reset(noteEls[noteIdx]);
}

let _layoutResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_layoutResizeTimer);
  _layoutResizeTimer = setTimeout(layoutMosaic, 150);
});

function renderNotes() {
  const grid = $('#notes-grid');
  // Le composeur et la recherche vivent en dur DANS #notes-grid (voir
  // index.html) : on ne retire que les cartes de note d'un rendu précédent,
  // jamais tout le conteneur, sous peine de les faire disparaître.
  grid.querySelectorAll('.note').forEach((el) => el.remove());
  $('#notes-empty').hidden = state.notes.length > 0;
  const dragOk = notesReorderable();

  for (const n of state.notes) {
    const el = document.createElement('article');
    el.className = 'note c-' + n.color + (n.pinned ? ' pinned' : '');
    el.dataset.id = n.id;

    let inner = `<button class="pin-btn" data-act="pin"
      title="${n.pinned ? 'Désépingler' : 'Épingler'}"
      aria-label="${n.pinned ? 'Désépingler' : 'Épingler'}">${n.pinned ? ICONS.pinFilled : ICONS.pin}</button>`;

    // Icône à gauche du titre, sur la même ligne (plutôt qu'au-dessus).
    if ((n.icon && ICON_CHOICES[n.icon]) || n.title) {
      const icon = n.icon && ICON_CHOICES[n.icon] ? `<span class="note-icon">${ICON_CHOICES[n.icon]}</span>` : '';
      const title = n.title ? `<h3>${escapeHtml(n.title)}</h3>` : '';
      inner += `<div class="note-title-row">${icon}${title}</div>`;
    }
    if (n.description) inner += `<div class="description">${escapeHtml(n.description)}</div>`;

    if (n.is_checklist) {
      inner += '<ul class="check">';
      for (const it of n.items) {
        const due = it.due_at
          ? `<em class="item-due-tag">${formatDue(it.due_at)}</em>` : '';
        inner += `<li class="${it.checked ? 'done' : ''}" data-item="${it.id}">
          <input type="checkbox" ${it.checked ? 'checked' : ''}>
          <span>${escapeHtml(it.text)}${due}</span></li>`;
      }
      inner += '</ul>';
    } else if (n.content) {
      inner += `<div class="body">${renderFormatted(n.content)}</div>`;
    }

    if (n.attachments && n.attachments.length) {
      const images = n.attachments.filter((a) => (a.meta && a.meta.mime || '').startsWith('image/'));
      const files = n.attachments.filter((a) => !(a.meta && a.meta.mime || '').startsWith('image/'));
      inner += '<div class="note-attachments">';
      for (const a of images) {
        inner += `<img class="note-attach-thumb" data-att="${a.id}" alt="">`;
      }
      if (files.length) {
        inner += `<div class="note-attach-files">${ICONS.file}<span>${files.length} fichier${files.length > 1 ? 's' : ''}</span></div>`;
      }
      inner += '</div>';
    }

    inner += `<div class="palette" hidden></div>
      <div class="actions">
        <button data-act="color" title="Couleur" aria-label="Couleur">${ICONS.palette}</button>
        <button data-act="edit" title="Modifier" aria-label="Modifier">${ICONS.edit}</button>
        <span class="sep"></span>
        <button data-act="archive" title="${n.archived ? 'Désarchiver' : 'Archiver'}"
          aria-label="${n.archived ? 'Désarchiver' : 'Archiver'}">${n.archived ? ICONS.unarchive : ICONS.archive}</button>
        <button data-act="delete" title="Mettre à la corbeille" aria-label="Mettre à la corbeille">${ICONS.trash}</button>
      </div>`;
    // Rangée de libellés : lecture seule ici (voir renderCardLabels()), pas
    // de bouton + ni de panneau associé sur la carte.

    // Échéance : tout en bas de la carte, sous la barre d'options — plus
    // au-dessus des pièces jointes comme avant (déplacée à la demande, au
    // même niveau que l'ancien bouton + des libellés, juste au-dessus de
    // la rangée de libellés).
    if (n.due_at) {
      const now = new Date();
      const late = !n.done && new Date(n.due_at) < now;
      inner += `<div class="note-due ${late ? 'late' : ''} ${n.done ? 'done' : ''}">
        <input type="checkbox" data-act="done" ${n.done ? 'checked' : ''} aria-label="Terminer">
        ${ICONS.clock}<span>${formatDue(n.due_at)}</span>
      </div>`;
    }

    inner += `<div class="note-labels"></div>`;

    el.innerHTML = inner;

    // Déchiffrement paresseux des miniatures — chaque image n'est décodée
    // qu'une fois (voir le cache dans loadAttachment()), donc un ré-rendu
    // de la grille ne recoûte rien pour les pièces jointes déjà vues.
    el.querySelectorAll('.note-attach-thumb').forEach((img) => {
      const att = (n.attachments || []).find((a) => String(a.id) === img.dataset.att);
      if (!att) return;
      loadAttachment(att).then((r) => { img.src = r.url; }).catch(() => {});
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        openImageEditor(att, n, 'card');
      });
    });

    el.querySelector('[data-act=edit]').onclick = () => openNoteDialog(n);
    el.querySelector('[data-act=pin]').onclick = async () => {
      await api('/notes/' + n.id, { method: 'PATCH', body: { pinned: !n.pinned } });
      loadNotes();
    };
    el.querySelector('[data-act=archive]').onclick = async () => {
      await api('/notes/' + n.id, { method: 'PATCH', body: { archived: !n.archived } });
      loadNotes();
    };
    el.querySelector('[data-act=delete]').onclick = async () => {
      if (!confirm('Déplacer cette notask vers la corbeille ? Elle y restera 30 jours avant suppression définitive.')) return;
      await api('/notes/' + n.id, { method: 'DELETE' });
      loadNotes();
    };

    const doneBox = el.querySelector('[data-act=done]');
    if (doneBox) doneBox.onchange = async (e) => {
      await api(`/tasks/note/${n.id}`, { method: 'PATCH', body: { done: e.target.checked } });
      loadNotes();
    };

    // Palette dépliable, à même la carte
    const palette = el.querySelector('.palette');
    el.querySelector('[data-act=color]').onclick = () => {
      if (!palette.dataset.filled) {
        for (const c of COLORS) {
          const s = document.createElement('button');
          s.type = 'button';
          s.className = 'swatch c-' + c + (c === n.color ? ' active' : '');
          s.title = c;
          s.onclick = async () => {
            await api('/notes/' + n.id, { method: 'PATCH', body: { color: c } });
            loadNotes();
          };
          palette.appendChild(s);
        }
        palette.dataset.filled = '1';
      }
      palette.hidden = !palette.hidden;
    };

    // Rangée de libellés en bas de la carte : PATCH + rechargement immédiat
    // à chaque clic, pas de bouton Enregistrer — même logique que la
    // palette de couleur ci-dessus, la carte n'a pas de moment de fermeture
    // où différer l'envoi (contrairement aux boîtes de dialogue, voir
    // renderNoteLabelChips[Simple]()).
    renderCardLabels(el, n);

    el.querySelectorAll('ul.check li').forEach((li) => {
      li.querySelector('input').onchange = async (ev) => {
        await api(`/notes/${n.id}/items/${li.dataset.item}`, {
          method: 'PATCH', body: { checked: ev.target.checked },
        });
        loadNotes();
      };
    });

    // Clic sur la carte (hors boutons eux-mêmes, cases à cocher, palette) :
    // édition simple façon Keep — juste le texte, sans les réglages de la
    // carte. ".actions button" et non ".actions" : seuls les boutons sont
    // exclus, pas les espaces vides autour (le séparateur, la marge) — un
    // clic là doit ouvrir la carte comme n'importe où ailleurs.
    el.addEventListener('click', (e) => {
      // Les libellés en bas de carte sont désormais en lecture seule (plus
      // aucun élément interactif dedans) : plus besoin de les exclure ici,
      // cliquer dessus ouvre l'édition rapide comme le reste de la carte.
      if (e.target.closest('.pin-btn, .actions button, .palette, .note-attachments, input')) return;
      openNoteSimpleDialog(n);
    });

    // Glisser-déposer pour réorganiser la mosaïque (vue par défaut seulement,
    // voir notesReorderable). Le geste ne doit pas partir d'un bouton ou
    // d'une case, sous peine de gêner leurs propres clics.
    if (dragOk) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        if (e.target.closest('.pin-btn, .actions, .palette, .note-attachments, input')) {
          e.preventDefault();
          return;
        }
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        commitNoteOrder();
      });
    }

    grid.appendChild(el);
  }

  layoutMosaic();
}

/* Rangée de libellés en bas de la carte (mosaïque) : uniquement ceux déjà
   assignés à cette notask, colorés avec la couleur propre du libellé
   (celle choisie dans le menu latéral via openLabelEditPopup — pas la
   couleur de la note), pas un aplat générique. Lecture seule à cet
   endroit — sur demande explicite, ajouter/retirer un libellé n'est plus
   possible depuis l'accueil (ni croix au survol, ni bouton +), seulement
   depuis "Modifier" ou l'édition rapide (voir renderNoteLabelChips[Simple]()
   plus bas). Couleur en style inline plutôt qu'en classe .c-* :
   `.label-chip:hover` a la même spécificité et écraserait sinon la
   couleur au survol (même piège que celui déjà rencontré et corrigé sur
   .drawer-item, voir renderLabelsDrawer()). */
function renderCardLabels(el, n) {
  const box = el.querySelector('.note-labels');
  if (!box) return;
  box.innerHTML = '';

  const assigned = (n.label_ids || [])
    .map((id) => state.labels.find((l) => l.id === id))
    .filter(Boolean);

  for (const l of assigned) {
    const chip = document.createElement('span');
    chip.className = 'label-chip label-chip-card is-readonly';
    if (l.color && LABEL_COLOR_HEX[l.color]) {
      chip.style.background = hexToRgba(LABEL_COLOR_HEX[l.color], .55);
    }
    chip.textContent = l.name;
    box.appendChild(chip);
  }
}

/* Pendant le survol, on déplace en direct la carte glissée juste avant ou
   après la carte la plus proche du pointeur — retour visuel immédiat,
   comme les autres interfaces à glisser-déposer. */
$('#notes-grid').addEventListener('dragover', (e) => {
  const dragging = $('#notes-grid').querySelector('.note.dragging');
  if (!dragging) return;
  e.preventDefault();
  const target = getDropTarget($('#notes-grid'), e.clientX, e.clientY);
  if (!target || target.el === dragging) return;
  if (target.before) target.el.before(dragging);
  else target.el.after(dragging);
});

// `itemSelector` par défaut à '.note' : seul le réordonnancement des
// libellés (voir plus bas, renderLabelsDrawer()) passe '.label-row'.
function getDropTarget(container, x, y, itemSelector = '.note') {
  const els = [...container.querySelectorAll(itemSelector + ':not(.dragging)')];
  let best = null;
  let bestDist = Infinity;
  let before = true;
  for (const el of els) {
    const box = el.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const dist = (x - cx) ** 2 + (y - cy) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = el;
      before = y < cy || (Math.abs(y - cy) < box.height / 2 && x < cx);
    }
  }
  return best ? { el: best, before } : null;
}

/* Une fois le geste terminé, l'ordre visuel du DOM fait foi : on réattribue
   à chaque note visible une position décroissante correspondant à sa place,
   et on ne PATCH que celles dont la position a réellement changé. */
async function commitNoteOrder() {
  const ids = [...$('#notes-grid').querySelectorAll('.note')].map((el) => Number(el.dataset.id));
  const total = ids.length;
  const updates = [];
  ids.forEach((id, idx) => {
    const note = state.notes.find((x) => x.id === id);
    if (!note) return;
    const newPos = (total - idx) * 1000;
    if (Math.round(note.position || 0) !== newPos) {
      updates.push(api('/notes/' + id, { method: 'PATCH', body: { position: newPos } }));
    }
  });
  if (!updates.length) return;
  try {
    await Promise.all(updates);
  } catch (err) {
    alert(err.message);
  }
  loadNotes();
}

/* Composeur — bascule entre texte libre et liste à cocher en direct : dès
   qu'on coche l'option, chaque ligne devient une case, comme dans Keep. */
let composerChecklist = false;
let composerItems = [{ text: '', checked: false }];
// Couleur/libellés/échéance : mêmes réglages que sur une notask existante,
// disponibles dès la création (voir la barre d'outils secondaire ci-dessous).
let composerColor = 'default';
let composerLabelIds = [];
// Fichiers choisis avant que la notask n'existe côté serveur : gardés en
// mémoire (File bruts, pas encore chiffrés/envoyés) et uploadés seulement
// une fois la notask créée (voir le handler #nc-add), contrairement à
// handleIncomingAttachments() en édition rapide qui envoie immédiatement
// puisque la note existe déjà.
let composerPendingFiles = [];
// Barre d'outils secondaire masquée tant qu'on n'a pas touché au titre ou
// au corps — voir composerExpand() et les écouteurs "focus" plus bas.
let composerExpanded = false;

/* Redimensionnement vertical maison d'une zone de texte, au clic-glissé sur
   sa poignée (voir le commentaire CSS sur .ta-resize-handle : le natif
   ::-webkit-resizer personnalisé s'est révélé peu fiable d'un navigateur à
   l'autre — celui-ci fonctionne partout, c'est du JS + un élément normal). */
function initTextareaResize(handle, textarea) {
  if (!handle || !textarea) return;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = textarea.offsetHeight;
    const onMove = (ev) => {
      const next = startHeight + (ev.clientY - startY);
      textarea.style.height = Math.max(48, next) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
initTextareaResize($('#nc-content-resize'), $('#nc-content'));

function resetComposer() {
  $('#nc-title').value = '';
  $('#nc-description').value = '';
  $('#nc-content').innerHTML = '';
  composerChecklist = false;
  composerItems = [{ text: '', checked: false }];
  composerColor = 'default';
  composerLabelIds = [];
  composerExpanded = false;
  composerPendingFiles = [];
  renderComposerAttachments();
  $('#nc-due').value = '';
  renderNcDueBtn();
  $('#nc-colors').hidden = true;
  $('#nc-label-chips').hidden = true;
  state.composerIcon = null;
  renderIconBtn($('#nc-icon-btn'), null);
  renderComposer();
  msg($('#composer-msg'), '');
}

function composerExpand() {
  if (composerExpanded) return;
  composerExpanded = true;
  renderComposer();
}
// Le clic peut partir de n'importe quel champ du composeur (titre,
// description ou corps) — pas seulement titre/corps comme au tout premier
// jet, qui laissait la barre masquée si on cliquait d'abord dans la
// description.
$('#nc-title').addEventListener('focus', composerExpand);
$('#nc-description').addEventListener('focus', composerExpand);
$('#nc-content').addEventListener('focus', composerExpand);

renderIconBtn($('#nc-icon-btn'), null);
$('#nc-icon-btn').addEventListener('click', () => {
  openIconPopup($('#nc-icon-btn'), state.composerIcon, (icon) => {
    state.composerIcon = icon;
    renderIconBtn($('#nc-icon-btn'), icon);
  });
});

function renderComposer() {
  $('#nc-content').hidden = composerChecklist;
  $('#nc-items').hidden = !composerChecklist;
  $('#nc-add-item').hidden = !composerChecklist;
  renderComposerChecklistBtn();
  // Le bloc entier (fond arrondi propre, voir .nc-toolbar-block) bascule,
  // pas seulement la rangée de boutons à l'intérieur.
  $('#nc-toolbar-block').hidden = !composerExpanded;
  $('#nc-cancel').hidden = !composerExpanded;
  if (!composerChecklist) return;

  const box = $('#nc-items');
  box.innerHTML = '';
  composerItems.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'composer-item-row';
    row.innerHTML = `<input type="checkbox" ${item.checked ? 'checked' : ''}>
      <input type="text" value="${escapeHtml(item.text)}" placeholder="Élément…">
      <button class="btn ghost sm" type="button" aria-label="Retirer">✕</button>`;
    const [cb, txt, del] = row.children;
    cb.onchange = (e) => { item.checked = e.target.checked; };
    txt.oninput = (e) => { item.text = e.target.value; };
    txt.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // Entrée sur la dernière ligne : on en ouvre une nouvelle, comme Keep.
      if (idx === composerItems.length - 1 && txt.value.trim()) {
        composerItems.push({ text: '', checked: false });
        renderComposer();
        $('#nc-items').lastElementChild.querySelector('input[type=text]').focus();
      }
    };
    del.onclick = () => {
      composerItems.splice(idx, 1);
      if (composerItems.length === 0) composerItems.push({ text: '', checked: false });
      renderComposer();
    };
    box.appendChild(row);
  });
}

// Même icône dynamique (crayon/liste) que #dns-toggle-checklist dans
// l'édition simple, pour rester cohérent d'un bout à l'autre de l'app.
function renderComposerChecklistBtn() {
  const btn = $('#nc-toggle-checklist');
  btn.innerHTML = composerChecklist ? ICONS.pencil : ICONS.tasks;
  const label = composerChecklist ? 'Passer en texte libre' : 'Passer en liste à cocher';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.classList.toggle('active-toggle', composerChecklist);
}

$('#nc-toggle-checklist').addEventListener('click', () => {
  composerExpand();
  if (!composerChecklist) {
    // Bascule depuis le texte libre : chaque ligne déjà tapée devient un élément.
    const lignes = richToText($('#nc-content')).split('\n').filter((l) => l.trim());
    composerItems = lignes.length
      ? lignes.map((l) => ({ text: l.trim(), checked: false }))
      : [{ text: '', checked: false }];
  } else {
    // Bascule inverse : les éléments redeviennent des paragraphes (même
    // logique que #dns-toggle-checklist en édition rapide).
    $('#nc-content').innerHTML = renderFormatted(
      composerItems.map((i) => i.text).filter(Boolean).join('\n')
    );
  }
  composerChecklist = !composerChecklist;
  renderComposer();
});

// Couleur : mêmes swatches .c-* que partout ailleurs, reconstruites à
// chaque ouverture (liste courte, pas besoin de mise en cache — évite
// aussi d'avoir à re-synchroniser une pastille active restée périmée
// après un resetComposer()).
const ncColorsBox = $('#nc-colors');
$('#nc-color-btn').innerHTML = ICONS.palette;
$('#nc-color-btn').addEventListener('click', () => {
  composerExpand();
  if ($('#nc-label-chips').hidden === false) $('#nc-label-chips').hidden = true;
  if (!ncColorsBox.hidden) { ncColorsBox.hidden = true; return; }
  ncColorsBox.innerHTML = '';
  for (const c of COLORS) {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'swatch c-' + c + (c === composerColor ? ' active' : '');
    s.title = c;
    s.onclick = () => {
      composerColor = c;
      ncColorsBox.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
      s.classList.add('active');
    };
    ncColorsBox.appendChild(s);
  }
  ncColorsBox.hidden = false;
});

// Libellés : liste complète en cases à cocher (une nouvelle notask n'a pas
// encore de libellés "déjà posés" à afficher différemment, contrairement à
// la rangée dédiée sur une carte existante — voir renderCardLabels()).
const ncLabelChipsBox = $('#nc-label-chips');
$('#nc-labels-btn').innerHTML = ICONS.tag;
function renderComposerLabelChips() {
  ncLabelChipsBox.innerHTML = '';
  if (!state.labels.length) {
    ncLabelChipsBox.innerHTML = '<span class="hint">Aucun libellé — créez-en un dans le menu latéral.</span>';
    return;
  }
  for (const l of state.labels) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'label-chip' + (composerLabelIds.includes(l.id) ? ' active' : '');
    chip.textContent = l.name;
    chip.onclick = () => {
      composerLabelIds = composerLabelIds.includes(l.id)
        ? composerLabelIds.filter((id) => id !== l.id)
        : [...composerLabelIds, l.id];
      renderComposerLabelChips();
    };
    ncLabelChipsBox.appendChild(chip);
  }
}
$('#nc-labels-btn').addEventListener('click', () => {
  composerExpand();
  if ($('#nc-colors').hidden === false) $('#nc-colors').hidden = true;
  if (!ncLabelChipsBox.hidden) { ncLabelChipsBox.hidden = true; return; }
  renderComposerLabelChips();
  ncLabelChipsBox.hidden = false;
});

// Échéance : même bouton + popover calendrier que sur une notask existante
// (voir renderDueBtn()/openCalPopup(), partagés avec dn-due-btn/dns-due-btn).
function renderNcDueBtn() {
  renderDueBtn('#nc-due-btn', '#nc-due-label', $('#nc-due').value || null);
}
$('#nc-due-btn').addEventListener('click', () => {
  composerExpand();
  openCalPopup($('#nc-due-btn'), $('#nc-due').value || null, (iso) => {
    $('#nc-due').value = iso || '';
    renderNcDueBtn();
  });
});
renderNcDueBtn();

// Mise en forme (gras/italique/souligné/code) : même mécanique que
// #dns-fmt-toolbar en édition rapide (wrapSelectionRich()/richToText(),
// définies plus bas dans ce fichier mais utilisables ici — déclarations de
// fonction, donc "remontées" (hoisted) avant l'exécution de ce script).
$('#nc-fmt-group').querySelectorAll('button[data-fmt]').forEach((btn) => {
  if (btn.dataset.fmt === 'code') btn.innerHTML = ICONS.code;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => wrapSelectionRich($('#nc-content'), btn.dataset.fmt));
});

// Pièces jointes : la notask n'existe pas encore, les fichiers restent en
// mémoire (composerPendingFiles) jusqu'à l'envoi (voir #nc-add). Aperçu
// local seulement — pas de chiffrement/upload avant que la notask existe.
$('#nc-attach-btn').innerHTML = ICONS.attach;
function renderComposerAttachments() {
  const box = $('#nc-attachments');
  box.innerHTML = '';
  box.hidden = composerPendingFiles.length === 0;
  composerPendingFiles.forEach((file, idx) => {
    const isImage = (file.type || '').startsWith('image/');
    const chip = document.createElement('div');
    chip.className = 'dns-attach-chip' + (isImage ? ' is-image' : '');
    if (isImage) {
      chip.innerHTML = `<img class="dns-attach-thumb" alt="${escapeHtml(file.name || '')}">
        <button type="button" class="dns-attach-remove" title="Retirer">${ICONS.close}</button>`;
      chip.querySelector('img').src = URL.createObjectURL(file);
    } else {
      chip.innerHTML = `<span class="dns-attach-icon">${ICONS.file}</span>
        <span class="dns-attach-name" title="${escapeHtml(file.name || '')}">${escapeHtml(file.name || 'Fichier')}</span>
        <span class="dns-attach-size">${formatFileSize(file.size)}</span>
        <button type="button" class="dns-attach-remove" title="Retirer">${ICONS.close}</button>`;
    }
    chip.querySelector('.dns-attach-remove').addEventListener('click', () => {
      composerPendingFiles.splice(idx, 1);
      renderComposerAttachments();
    });
    box.appendChild(chip);
  });
}

function queueComposerFiles(fileList) {
  if (!fileList || !fileList.length) return;
  composerExpand();
  composerPendingFiles.push(...Array.from(fileList));
  renderComposerAttachments();
}

$('#nc-attach-btn').addEventListener('click', () => $('#nc-attach-input').click());
$('#nc-attach-input').addEventListener('change', (e) => {
  queueComposerFiles(e.target.files);
  e.target.value = ''; // permet de rechoisir le même fichier ensuite
});

// Coller une image directement dans le composeur, comme en édition rapide.
$('.note-composer').addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData ? e.clipboardData.items : [])
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  queueComposerFiles(files);
});

// Glisser-déposer un fichier sur le composeur.
const ncComposerEl = $('.note-composer');
['dragenter', 'dragover'].forEach((evt) => ncComposerEl.addEventListener(evt, (e) => {
  e.preventDefault();
  ncComposerEl.classList.add('drag-over');
}));
['dragleave', 'dragend'].forEach((evt) => ncComposerEl.addEventListener(evt, () => {
  ncComposerEl.classList.remove('drag-over');
}));
ncComposerEl.addEventListener('drop', (e) => {
  e.preventDefault();
  ncComposerEl.classList.remove('drag-over');
  queueComposerFiles(e.dataTransfer.files);
});

// Bouton explicite, indépendant du raccourci Entrée — toujours visible et fiable.
$('#nc-add-item').addEventListener('click', () => {
  composerItems.push({ text: '', checked: false });
  renderComposer();
  $('#nc-items').lastElementChild.querySelector('input[type=text]').focus();
});

$('#nc-cancel').addEventListener('click', resetComposer);

$('#nc-add').addEventListener('click', async () => {
  const title = $('#nc-title').value.trim();
  const content = richToText($('#nc-content')).trim();
  const items = composerItems.filter((i) => i.text.trim());

  if (!title && !content && !(composerChecklist && items.length) && !composerPendingFiles.length) return;

  try {
    const body = {
      title: await encryptField(title),
      description: await encryptField($('#nc-description').value.trim()),
      content: composerChecklist ? '' : await encryptField(content),
      is_checklist: composerChecklist,
      items: composerChecklist
        ? await Promise.all(items.map(async (i) => ({ ...i, text: await encryptField(i.text) })))
        : [],
      icon: state.composerIcon,
      color: composerColor,
      due_at: $('#nc-due').value || null,
      label_ids: composerLabelIds,
    };
    const created = await api('/notes', { method: 'POST', body });

    // Pièces jointes : la notask vient tout juste d'obtenir un id, on peut
    // enfin les envoyer (voir le commentaire sur composerPendingFiles).
    // Une erreur d'upload ne doit pas faire perdre la notask déjà créée :
    // signalée à part, sans bloquer la réinitialisation du composeur.
    if (composerPendingFiles.length) {
      const files = composerPendingFiles;
      composerPendingFiles = [];
      const results = await Promise.allSettled(files.map((f) => uploadAttachment(created.id, f)));
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) {
        alert(`${failed.length} pièce(s) jointe(s) n'ont pas pu être envoyées : ${failed[0].reason.message}`);
      }
    }

    resetComposer();
    loadNotes();
  } catch (err) {
    // Sans ceci, un échec silencieux donne l'impression que le bouton ne
    // fait rien — on affiche toujours la cause dans le composeur.
    msg($('#composer-msg'), err.message);
  }
});

renderComposer();

let searchTimer;
$('#notes-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = e.target.value.trim(); loadNotes(); }, 250);
});

/* Les archives sont désormais une entrée du menu latéral, pas un bouton. */

/* --- Dialogue note --- */

function openNoteDialog(note) {
  state.editingNote = note;
  // Comparé à l'enregistrement pour décider si un instantané d'historique
  // est nécessaire — voir noteSnapshotFromNote()/snapshotNoteVersion().
  state.editingNoteOriginal = noteSnapshotFromNote(note);
  state.editingIsChecklist = note.is_checklist;
  state.editingNoteItems = note.items.map((i) => ({
    text: i.text, checked: i.checked, due_at: i.due_at,
  }));
  state.editingLabelIds = [...(note.label_ids || [])];
  renderNoteLabelChips();
  state.editingIcon = note.icon || null;
  renderIconBtn($('#dn-icon-btn'), state.editingIcon);

  $('#dn-title').value = note.title;
  $('#dn-description').value = note.description || '';
  $('#dn-content').value = note.content;
  $('#dn-due').value = note.due_at || '';
  renderDialogMode();
  renderNoteDueBtn();
  applyDialogColor($('#dlg-note'), note.color);

  const colors = $('#dn-colors');
  colors.innerHTML = '';
  for (const c of COLORS) {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'swatch c-' + c + (c === note.color ? ' active' : '');
    s.title = c;
    s.onclick = () => {
      state.editingNote.color = c;
      colors.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
      s.classList.add('active');
      applyDialogColor($('#dlg-note'), c);
    };
    colors.appendChild(s);
  }

  renderNoteItems();
  $('#dlg-note').showModal();
}

/* Icône calendrier de la note : jaune dès qu'une échéance est réglée. */
function renderDueBtn(btnSel, labelSel, iso) {
  const btn = $(btnSel);
  if (!btn.innerHTML) btn.innerHTML = ICONS.calendar;
  btn.classList.toggle('has-due', !!iso);
  $(labelSel).textContent = iso ? formatDue(iso) : 'Aucune échéance';
}

function renderNoteDueBtn() {
  renderDueBtn('#dn-due-btn', '#dn-due-label', $('#dn-due').value || null);
}

$('#dn-due-btn').addEventListener('click', () => {
  openCalPopup($('#dn-due-btn'), $('#dn-due').value || null, (iso) => {
    $('#dn-due').value = iso || '';
    renderNoteDueBtn();
  });
});

function renderNoteDueBtnSimple() {
  renderDueBtn('#dns-due-btn', '#dns-due-label', $('#dns-due').value || null);
}

$('#dns-due-btn').addEventListener('click', () => {
  openCalPopup($('#dns-due-btn'), $('#dns-due').value || null, (iso) => {
    $('#dns-due').value = iso || '';
    renderNoteDueBtnSimple();
  });
});

$('#dn-icon-btn').addEventListener('click', () => {
  openIconPopup($('#dn-icon-btn'), state.editingIcon, (icon) => {
    state.editingIcon = icon;
    renderIconBtn($('#dn-icon-btn'), icon);
  });
});

/* Bascule entre texte libre et liste à cocher, pour une note déjà existante. */
function renderDialogMode() {
  $('#dn-content-field').hidden = state.editingIsChecklist;
  $('#dn-items-field').hidden = !state.editingIsChecklist;
  $('#dn-add-item').hidden = !state.editingIsChecklist;
  $('#dn-toggle-checklist').textContent =
    state.editingIsChecklist ? 'Passer en texte libre' : 'Passer en liste à cocher';
}

$('#dn-toggle-checklist').addEventListener('click', () => {
  if (!state.editingIsChecklist) {
    // Texte libre -> liste : chaque ligne déjà écrite devient un élément.
    const lignes = $('#dn-content').value.split('\n').filter((l) => l.trim());
    state.editingNoteItems = lignes.length
      ? lignes.map((l) => ({ text: l.trim(), checked: false, due_at: null }))
      : [{ text: '', checked: false, due_at: null }];
    renderNoteItems();
  } else {
    // Liste -> texte libre : les lignes deviennent des paragraphes.
    $('#dn-content').value = state.editingNoteItems.map((i) => i.text).filter(Boolean).join('\n');
  }
  state.editingIsChecklist = !state.editingIsChecklist;
  renderDialogMode();
});

function renderNoteItems() {
  const box = $('#dn-items');
  box.innerHTML = '';
  state.editingNoteItems.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'dn-item-row';
    row.innerHTML = `<input type="checkbox" ${item.checked ? 'checked' : ''}>
      <input type="text" value="${escapeHtml(item.text)}" placeholder="Texte de la ligne">
      <button type="button" class="cal-btn${item.due_at ? ' has-due' : ''}"
              title="${item.due_at ? formatDue(item.due_at) : 'Dater cette ligne en fait une tâche'}">${ICONS.calendar}</button>
      <button class="btn ghost sm" type="button" title="Retirer la ligne">✕</button>`;
    const [cb, txt, cal, del] = row.children;
    cb.onchange = (e) => { state.editingNoteItems[idx].checked = e.target.checked; };
    txt.oninput = (e) => { state.editingNoteItems[idx].text = e.target.value; };
    cal.onclick = () => {
      openCalPopup(cal, state.editingNoteItems[idx].due_at, (iso) => {
        state.editingNoteItems[idx].due_at = iso;
        renderNoteItems();
      });
    };
    del.onclick = () => { state.editingNoteItems.splice(idx, 1); renderNoteItems(); };
    box.appendChild(row);
  });
}

/* Chips de libellés dans une boîte de dialogue d'édition (complète ou
   simple, voir les deux wrappers ci-dessous). Même présentation que sur la
   carte (renderCardLabels()) : puces déjà posées, colorées avec la couleur
   propre du libellé, croix au survol pour la retirer, puis un bouton +
   après la dernière puce qui ouvre .label-add-picker (élément frère du
   conteneur de puces, voir index.html) pour poser un libellé restant.
   Aucun appel API ici (contrairement à la carte) : on modifie seulement
   state.editingLabelIds, la boîte de dialogue enregistre au moment de sa
   fermeture (voir saveNoteDialog()/saveNoteSimpleDialog()). Mêmes
   state.editingLabelIds et state.labels dans les deux dialogues — un seul
   dialogue est jamais ouvert à la fois, pas de risque de collision. */
function renderLabelChipsInto(boxSelector, pickerSelector, rerender) {
  const box = $(boxSelector);
  const picker = $(pickerSelector);
  box.innerHTML = '';
  if (picker) { picker.innerHTML = ''; picker.hidden = true; }

  const assigned = state.editingLabelIds
    .map((id) => state.labels.find((l) => l.id === id))
    .filter(Boolean);

  for (const l of assigned) {
    const chip = document.createElement('span');
    chip.className = 'label-chip label-chip-card';
    if (l.color && LABEL_COLOR_HEX[l.color]) {
      chip.style.background = hexToRgba(LABEL_COLOR_HEX[l.color], .55);
    }
    const name = document.createElement('span');
    name.className = 'label-chip-name';
    name.textContent = l.name;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'label-chip-x';
    x.setAttribute('aria-label', `Retirer le libellé ${l.name}`);
    x.innerHTML = ICONS.close;
    x.onclick = (e) => {
      e.stopPropagation();
      state.editingLabelIds = state.editingLabelIds.filter((id) => id !== l.id);
      rerender();
    };
    chip.append(name, x);
    box.appendChild(chip);
  }

  if (picker) {
    const remaining = state.labels.filter((l) => !state.editingLabelIds.includes(l.id));
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'label-add-btn';
    addBtn.title = 'Ajouter un libellé';
    addBtn.setAttribute('aria-label', 'Ajouter un libellé');
    addBtn.innerHTML = ICONS.plus;
    addBtn.onclick = (e) => {
      e.stopPropagation();
      if (!picker.hidden) { picker.hidden = true; return; }
      picker.innerHTML = '';
      if (!remaining.length) {
        picker.innerHTML = '<span class="hint">Aucun libellé disponible — créez-en un dans le menu latéral.</span>';
      } else {
        for (const l of remaining) {
          const opt = document.createElement('button');
          opt.type = 'button';
          opt.className = 'label-chip';
          if (l.color && LABEL_COLOR_HEX[l.color]) {
            opt.style.background = hexToRgba(LABEL_COLOR_HEX[l.color], .55);
          }
          opt.textContent = l.name;
          opt.onclick = (e2) => {
            e2.stopPropagation();
            state.editingLabelIds.push(l.id);
            rerender();
          };
          picker.appendChild(opt);
        }
      }
      picker.hidden = false;
    };
    box.appendChild(addBtn);
  }

  if (!state.labels.length) {
    box.innerHTML = '<span class="hint">Aucun libellé — créez-en un dans le menu latéral.</span>';
  }
}
function renderNoteLabelChips() { renderLabelChipsInto('#dn-labels', '#dn-labels-picker', renderNoteLabelChips); }
function renderNoteLabelChipsSimple() { renderLabelChipsInto('#dns-labels', '#dns-labels-picker', renderNoteLabelChipsSimple); }

$('#dn-add-item').addEventListener('click', () => {
  state.editingNoteItems.push({ text: '', checked: false, due_at: null });
  renderNoteItems();
});

$('#dn-cancel').addEventListener('click', () => $('#dlg-note').close());

/* Sauvegarde du dialogue d'édition complet — utilisée par le bouton
   Enregistrer, et par le clic en dehors de la fenêtre (qui enregistre puis
   ferme, comme demandé, au lieu de simplement fermer). */
async function saveNoteDialog() {
  const n = state.editingNote;
  try {
    // Instantané d'historique seulement si quelque chose a réellement
    // changé depuis l'ouverture (comparaison en clair, seule fiable) —
    // sinon fermer/rouvrir la boîte sans rien toucher grignoterait les 10
    // versions disponibles pour rien.
    const currentItemsForDiff = state.editingIsChecklist
      ? state.editingNoteItems.filter((i) => i.text.trim())
        .map((i) => ({ text: i.text, checked: i.checked, due_at: i.due_at || null }))
      : [];
    const currentForDiff = {
      title: $('#dn-title').value,
      description: $('#dn-description').value,
      content: state.editingIsChecklist ? '' : $('#dn-content').value,
      color: n.color,
      due_at: $('#dn-due').value || null,
      is_checklist: state.editingIsChecklist,
      icon: state.editingIcon,
      label_ids: state.editingLabelIds,
      items: currentItemsForDiff,
    };
    if (!notePlainStateEqual(state.editingNoteOriginal, currentForDiff)) {
      await snapshotNoteVersion(n.id);
    }

    const body = {
      title: await encryptField($('#dn-title').value),
      description: await encryptField($('#dn-description').value),
      color: n.color,
      due_at: $('#dn-due').value || null,
      is_checklist: state.editingIsChecklist,
      label_ids: state.editingLabelIds,
      icon: state.editingIcon,
    };
    if (state.editingIsChecklist) {
      const items = state.editingNoteItems.filter((i) => i.text.trim());
      body.items = await Promise.all(items.map(async (i) => ({ ...i, text: await encryptField(i.text) })));
      body.content = '';
    } else {
      body.content = await encryptField($('#dn-content').value);
      body.items = [];
    }
    await api('/notes/' + n.id, { method: 'PATCH', body });
    $('#dlg-note').close();
    // Le dialogue s'ouvre aussi depuis la vue Tâches : on rafraîchit la bonne vue.
    if (state.view in TASK_VIEWS) loadTasks(TASK_VIEWS[state.view]);
    else loadNotes();
  } catch (err) {
    alert(err.message);
  }
}

$('#dn-save').addEventListener('click', saveNoteDialog);

// Cliquer en dehors du contenu (sur le fond du dialogue ou le backdrop, qui
// ne sont couverts par aucun élément enfant) enregistre puis ferme, plutôt
// que de fermer sans rien faire.
$('#dlg-note').addEventListener('click', (e) => {
  if (e.target === $('#dlg-note')) saveNoteDialog();
});

/* --- Dialogue d'édition simple, façon Keep ---
   Ouvert au clic sur le corps d'une note : texte, cases à cocher, échéance,
   pièces jointes et bascule texte libre/liste s'y modifient — pas de
   couleur, pas de libellé (réservés à la boîte "Modifier" complète). Toute
   fermeture enregistre. */

/* -------------------- Pièces jointes, édition simple -------------------- *
 * Upload/suppression immédiats (pas de bouton Enregistrer sur cette boîte
 * de dialogue) : contrairement au titre/contenu, une pièce jointe n'a rien
 * à faire dans le PATCH envoyé à la fermeture, ce sont des appels REST à
 * part entière — voir uploadAttachment()/deleteAttachment(). */

$('#dns-attach-btn').innerHTML = ICONS.attach;

function renderAttachmentsSimple() {
  const box = $('#dns-attachments');
  const list = (state.editingNote && state.editingNote.attachments) || [];
  box.hidden = list.length === 0;
  box.innerHTML = '';

  for (const att of list) {
    const isImage = (att.meta && att.meta.mime || '').startsWith('image/');
    const chip = document.createElement('div');
    chip.className = 'dns-attach-chip' + (isImage ? ' is-image' : '');

    if (isImage) {
      chip.innerHTML = `<img class="dns-attach-thumb" alt="${escapeHtml(att.meta.name || '')}">
        <button type="button" class="dns-attach-remove" title="Supprimer">${ICONS.close}</button>`;
      const img = chip.querySelector('img');
      loadAttachment(att).then((r) => { img.src = r.url; }).catch(() => {
        chip.classList.add('is-broken');
      });
      img.addEventListener('click', () => openImageEditor(att, state.editingNote, 'dns'));
    } else {
      const name = (att.meta && att.meta.name) || 'Fichier';
      chip.innerHTML = `<span class="dns-attach-icon">${ICONS.file}</span>
        <span class="dns-attach-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="dns-attach-size">${formatFileSize(att.size)}</span>
        <button type="button" class="dns-attach-remove" title="Supprimer">${ICONS.close}</button>`;
      chip.querySelector('.dns-attach-name').addEventListener('click', async () => {
        try {
          const r = await loadAttachment(att);
          const a = document.createElement('a');
          a.href = r.url; a.download = r.name;
          a.click();
        } catch (err) { alert(err.message); }
      });
    }

    chip.querySelector('.dns-attach-remove').addEventListener('click', async () => {
      if (!confirm('Supprimer définitivement cette pièce jointe ?')) return;
      try {
        // Suppression irréversible côté serveur (le fichier est effacé du
        // disque) : un instantané avant coup est le seul moyen de la
        // rattraper depuis l'historique.
        await snapshotNoteVersion(state.editingNote.id);
        await deleteAttachment(att.id);
        state.editingNote.attachments = state.editingNote.attachments.filter((a) => a.id !== att.id);
        renderAttachmentsSimple();
      } catch (err) { alert(err.message); }
    });

    box.appendChild(chip);
  }
}

// Suivi des envois de pièces jointes en cours (paste/glisser-déposer/bouton
// ne sont jamais attendus par leur appelant, ce sont des gestionnaires
// d'événement). Sans ce suivi, fermer la boîte juste après un collage
// déclenche saveNoteSimpleDialog() -> loadNotes() AVANT la fin de l'envoi :
// loadNotes() remplace state.notes par des objets fraîchement récupérés du
// serveur (qui ne connaît pas encore la pièce jointe), et le the résultat de
// l'upload, une fois arrivé, ne fait plus que muter un objet déjà orphelin
// — la photo est bien envoyée, mais jamais revue dans l'interface. Voir
// saveNoteSimpleDialog() qui attend ce tableau avant de continuer.
let pendingAttachmentUploads = [];

function handleIncomingAttachments(fileList) {
  const note = state.editingNote;
  if (!note || !fileList || !fileList.length) return;
  const job = (async () => {
    for (const file of Array.from(fileList)) {
      try {
        const created = await uploadAttachment(note.id, file);
        created.meta = JSON.parse(await decryptField(created.enc_meta) || '{}');
        note.attachments.push(created);
      } catch (err) {
        alert(err.message);
      }
    }
    renderAttachmentsSimple();
  })();
  pendingAttachmentUploads.push(job);
  return job;
}

$('#dns-attach-btn').addEventListener('click', () => $('#dns-attach-input').click());
$('#dns-attach-input').addEventListener('change', (e) => {
  handleIncomingAttachments(e.target.files);
  e.target.value = ''; // permet de rechoisir le même fichier ensuite
});

// Coller une image (capture d'écran, image copiée) directement dans la
// note. Le preventDefault ne se déclenche que s'il y a effectivement un
// fichier dans le presse-papier, pour laisser le collage de texte normal
// intact partout ailleurs.
$('#dlg-note-simple').addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData ? e.clipboardData.items : [])
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  handleIncomingAttachments(files);
});

// Glisser-déposer un fichier sur la carte en édition simple.
const dnsCard = document.querySelector('#dlg-note-simple .dns-card');
['dragenter', 'dragover'].forEach((evt) => dnsCard.addEventListener(evt, (e) => {
  e.preventDefault();
  dnsCard.classList.add('drag-over');
  $('#dns-dropzone-hint').hidden = false;
}));
['dragleave', 'dragend'].forEach((evt) => dnsCard.addEventListener(evt, () => {
  dnsCard.classList.remove('drag-over');
  $('#dns-dropzone-hint').hidden = true;
}));
dnsCard.addEventListener('drop', (e) => {
  e.preventDefault();
  dnsCard.classList.remove('drag-over');
  $('#dns-dropzone-hint').hidden = true;
  handleIncomingAttachments(e.dataTransfer.files);
});

/* Bascule texte libre <-> liste à cocher, édition simple. Contrairement au
   fmt-toolbar (gras/italique/souligné/code), ce bouton reste visible dans
   les deux modes — voir #dns-fmt-group dans index.html, qui regroupe les
   seuls boutons de mise en forme et se masque seul en mode liste. */
function renderDnsMode() {
  $('#dns-content-field').hidden = state.editingIsChecklist;
  $('#dns-fmt-group').hidden = state.editingIsChecklist;
  $('#dns-items-field').hidden = !state.editingIsChecklist;
  $('#dns-add-item').hidden = !state.editingIsChecklist;
  const btn = $('#dns-toggle-checklist');
  btn.innerHTML = state.editingIsChecklist ? ICONS.pencil : ICONS.tasks;
  const label = state.editingIsChecklist ? 'Passer en texte libre' : 'Passer en liste à cocher';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

$('#dns-toggle-checklist').addEventListener('click', () => {
  if (!state.editingIsChecklist) {
    // Texte libre -> liste : chaque ligne déjà écrite devient un élément.
    const lignes = richToText($('#dns-content')).split('\n').filter((l) => l.trim());
    state.editingNoteItems = lignes.length
      ? lignes.map((l) => ({ text: l.trim(), checked: false, due_at: null }))
      : [{ text: '', checked: false, due_at: null }];
    renderNoteItemsSimple();
  } else {
    // Liste -> texte libre : les lignes deviennent des paragraphes.
    $('#dns-content').innerHTML = renderFormatted(
      state.editingNoteItems.map((i) => i.text).filter(Boolean).join('\n')
    );
  }
  state.editingIsChecklist = !state.editingIsChecklist;
  renderDnsMode();
});

function openNoteSimpleDialog(note) {
  state.editingNote = note;
  state.editingNoteOriginal = noteSnapshotFromNote(note);
  state.editingIsChecklist = note.is_checklist;
  state.editingNoteItems = note.items.map((i) => ({
    text: i.text, checked: i.checked, due_at: i.due_at,
  }));
  if (!state.editingNote.attachments) state.editingNote.attachments = [];
  pendingAttachmentUploads = [];
  state.editingLabelIds = [...(note.label_ids || [])];

  $('#dns-title').value = note.title;
  $('#dns-description').value = note.description || '';
  $('#dns-content').innerHTML = renderFormatted(note.content || '');
  renderDnsMode();
  $('#dns-due').value = note.due_at || '';
  renderNoteDueBtnSimple();
  renderNoteItemsSimple();
  renderAttachmentsSimple();
  renderNoteLabelChipsSimple();
  applyDialogColor($('#dlg-note-simple'), note.color);
  $('#dlg-note-simple').showModal();
}

/* Barre d'outils de mise en forme, édition rapide uniquement. #dns-content
   est une zone contenteditable (pas un <textarea>) : la sélection est donc
   entourée d'un vrai tag HTML (<strong>/<em>/<u>/<code>) qui s'affiche
   réellement mis en forme pendant l'édition (WYSIWYG), et pas seulement une
   fois la note enregistrée et réaffichée sur la carte. Le contenu est
   reconverti en texte façon markdown par richToText() à l'enregistrement —
   l'opération inverse de renderFormatted(), qui remplit cette zone à
   l'ouverture (voir openNoteSimpleDialog()). */
const FMT_TAGS = { bold: 'strong', italic: 'em', underline: 'u' };

function wrapSelectionRich(el, kind) {
  el.focus();
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return;
  const text = range.toString();

  let wrapper;
  if (kind === 'code') {
    // Bloc de code si la sélection contient un saut de ligne, sinon code en
    // ligne — même distinction que renderFormatted() (``` contre `) pour
    // rester cohérent avec le rendu final sur la carte.
    if (text.includes('\n')) {
      wrapper = document.createElement('pre');
      wrapper.className = 'note-code-block';
      const code = document.createElement('code');
      code.textContent = text || '\u200b';
      wrapper.appendChild(code);
    } else {
      wrapper = document.createElement('code');
      wrapper.className = 'note-code-inline';
      wrapper.textContent = text || '\u200b';
    }
  } else {
    wrapper = document.createElement(FMT_TAGS[kind]);
    wrapper.textContent = text || '\u200b';
  }

  range.deleteContents();
  range.insertNode(wrapper);

  const newRange = document.createRange();
  if (text) {
    newRange.setStartAfter(wrapper);
    newRange.collapse(true);
  } else {
    newRange.selectNodeContents(wrapper);
  }
  sel.removeAllRanges();
  sel.addRange(newRange);
}

$('#dns-fmt-toolbar').querySelectorAll('button[data-fmt]').forEach((btn) => {
  if (btn.dataset.fmt === 'code') btn.innerHTML = ICONS.code;
  // Sans ce preventDefault, le clic sur le bouton déplace le focus hors de
  // la zone contenteditable au mousedown et efface la sélection avant même
  // que le click ne se déclenche (constaté à la vérification : le texte
  // sélectionné n'était plus entouré, un tag vide s'insérait au début).
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => wrapSelectionRich($('#dns-content'), btn.dataset.fmt));
});

/* Inverse de renderFormatted() : reconvertit le HTML de la zone
   contenteditable en texte façon markdown pour l'enregistrement. */
function richToText(root) {
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\u200b/g, '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const inner = () => Array.from(node.childNodes).map(walk).join('');
    switch (tag) {
      case 'br': return '\n';
      case 'strong': case 'b': return '**' + inner() + '**';
      case 'em': case 'i': return '*' + inner() + '*';
      case 'u': return '__' + inner() + '__';
      case 'pre': return '```' + node.textContent.replace(/\u200b/g, '') + '```';
      case 'code': return '`' + node.textContent.replace(/\u200b/g, '') + '`';
      case 'div': case 'p': return '\n' + inner();
      default: return inner();
    }
  }
  return Array.from(root.childNodes).map(walk).join('').replace(/^\n/, '');
}

/* Rendu markdown minimal (gras/italique/souligné/code) pour l'affichage des
   notes en texte libre sur la carte — jamais sur du HTML non échappé
   (escapeHtml tourne toujours en premier, la mise en forme s'applique après
   coup sur le texte déjà échappé). */
function renderFormatted(text) {
  let html = escapeHtml(text);
  html = html.replace(/```([\s\S]+?)```/g, (m, code) => `<pre class="note-code-block"><code>${code}</code></pre>`);
  html = html.replace(/`([^`\n]+?)`/g, '<code class="note-code-inline">$1</code>');
  html = html.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^\n]+?)__/g, '<u>$1</u>');
  html = html.replace(/\*([^\n*]+?)\*/g, '<em>$1</em>');
  return html;
}

function renderNoteItemsSimple() {
  const box = $('#dns-items');
  box.innerHTML = '';
  state.editingNoteItems.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'dn-item-row';
    row.innerHTML = `<input type="checkbox" ${item.checked ? 'checked' : ''}>
      <input type="text" value="${escapeHtml(item.text)}" placeholder="Texte de la ligne">
      <button type="button" class="cal-btn${item.due_at ? ' has-due' : ''}"
              title="${item.due_at ? formatDue(item.due_at) : 'Dater cette ligne en fait une tâche'}">${ICONS.calendar}</button>
      <button class="btn ghost sm" type="button" title="Retirer la ligne">✕</button>`;
    const [cb, txt, cal, del] = row.children;
    cb.onchange = (e) => { state.editingNoteItems[idx].checked = e.target.checked; };
    txt.oninput = (e) => { state.editingNoteItems[idx].text = e.target.value; };
    cal.onclick = () => {
      openCalPopup(cal, state.editingNoteItems[idx].due_at, (iso) => {
        state.editingNoteItems[idx].due_at = iso;
        renderNoteItemsSimple();
      });
    };
    del.onclick = () => { state.editingNoteItems.splice(idx, 1); renderNoteItemsSimple(); };
    box.appendChild(row);
  });
}

$('#dns-add-item').addEventListener('click', () => {
  state.editingNoteItems.push({ text: '', checked: false, due_at: null });
  renderNoteItemsSimple();
});

async function saveNoteSimpleDialog() {
  const n = state.editingNote;
  if (!n) return;
  // Attendre les pièces jointes encore en cours d'envoi (collées/déposées
  // juste avant la fermeture) avant tout PATCH/rechargement — voir le
  // commentaire sur pendingAttachmentUploads plus haut.
  await Promise.allSettled(pendingAttachmentUploads);
  pendingAttachmentUploads = [];
  try {
    // Même logique que saveNoteDialog() : instantané seulement si quelque
    // chose a réellement changé. L'icône n'est pas éditable depuis cette
    // boîte : on reprend telle quelle celle de l'état chargé, pour qu'elle
    // ne déclenche jamais elle-même un faux positif ici.
    const currentItemsForDiff = state.editingIsChecklist
      ? state.editingNoteItems.filter((i) => i.text.trim())
        .map((i) => ({ text: i.text, checked: i.checked, due_at: i.due_at || null }))
      : [];
    const currentForDiff = {
      title: $('#dns-title').value,
      description: $('#dns-description').value,
      content: state.editingIsChecklist ? '' : richToText($('#dns-content')),
      color: n.color,
      due_at: $('#dns-due').value || null,
      is_checklist: state.editingIsChecklist,
      icon: (state.editingNoteOriginal && state.editingNoteOriginal.icon) || null,
      label_ids: state.editingLabelIds,
      items: currentItemsForDiff,
    };
    if (!notePlainStateEqual(state.editingNoteOriginal, currentForDiff)) {
      await snapshotNoteVersion(n.id);
    }

    const body = {
      title: await encryptField($('#dns-title').value),
      description: await encryptField($('#dns-description').value),
      due_at: $('#dns-due').value || null,
      // Sans ce champ, basculer le mode avec #dns-toggle-checklist ne
      // survivait pas à la fermeture : is_checklist n'était jamais envoyé,
      // la note rouvrait dans son ancien mode au prochain clic.
      is_checklist: state.editingIsChecklist,
      label_ids: state.editingLabelIds,
    };
    // Les deux champs sont toujours envoyés (l'un vidé) plutôt que seulement
    // celui du mode courant : sinon, après une bascule, l'ancien contenu
    // (lignes de checklist ou texte libre) restait en base sans être
    // affiché nulle part — même logique que saveNoteDialog() ci-dessus.
    if (state.editingIsChecklist) {
      const items = state.editingNoteItems.filter((i) => i.text.trim());
      body.items = await Promise.all(items.map(async (i) => ({ ...i, text: await encryptField(i.text) })));
      body.content = '';
    } else {
      body.content = await encryptField(richToText($('#dns-content')));
      body.items = [];
    }
    await api('/notes/' + n.id, { method: 'PATCH', body });
  } catch (err) {
    alert(err.message);
  }
  if (state.view in TASK_VIEWS) loadTasks(TASK_VIEWS[state.view]);
  else loadNotes();
}

// Pas de bouton Enregistrer/Annuler ici : toute fermeture (clic à côté,
// Échap) déclenche l'événement natif "close", seul point d'enregistrement.
$('#dlg-note-simple').addEventListener('close', saveNoteSimpleDialog);
$('#dlg-note-simple').addEventListener('click', (e) => {
  if (e.target === $('#dlg-note-simple')) $('#dlg-note-simple').close();
});

/* ---------------------------- Éditeur d'image ----------------------------
   Visualiseuse + outil de marquage pour les pièces jointes image, ouverte
   au clic sur une vignette (carte ou édition simple) à la place d'un
   nouvel onglet. Cinq outils : rectangle, ellipse (contours), surlignage
   (aplat semi-transparent), texte, mosaïque (pour cacher une zone) — plus
   une palette de couleurs qui reprend telle quelle celle des notes/
   libellés (COLORS, .c-* et LABEL_COLOR_HEX), pour rester dans le thème déjà
   en place plutôt que d'inventer une nouvelle gamme de couleurs.

   Tout se dessine directement sur #img-editor-canvas, à la résolution
   naturelle de l'image (pas celle, réduite, à laquelle il est affiché à
   l'écran — voir canvasPoint() pour la conversion). "Enregistrer" aplatit
   le canvas en PNG, le chiffre (encryptBinary(), comme à la création) et
   remplace le contenu de la pièce jointe via PUT /api/attachments/{id} —
   même id, donc même vignette partout où elle apparaît déjà. Fermer par
   tout autre moyen (Échap, clic à côté, bouton "Fermer sans enregistrer")
   abandonne les annotations sans rien envoyer au serveur. */

const imgEditor = {
  att: null,       // pièce jointe en cours d'édition
  note: null,       // note propriétaire (pour rafraîchir la bonne vue après enregistrement)
  source: null,     // 'card' | 'dns' — qui a ouvert l'éditeur
  tool: 'rect',
  color: LABEL_COLOR_HEX.red,
  history: [],      // pile d'ImageData ; le dernier élément = état affiché
  strokeBase: null, // clone de l'état courant, pris au pointerdown, restauré à chaque pointermove pour prévisualiser sans laisser de trace
  drawing: false,
  startX: 0,
  startY: 0,
};

const IMG_EDITOR_TOOL_ICONS = {
  rect: 'imgRect', ellipse: 'imgEllipse', highlight: 'imgHighlight',
  text: 'imgText', mosaic: 'imgMosaic',
};

function imgEditorCanvas() { return $('#img-editor-canvas'); }

$('#img-editor-undo').innerHTML = ICONS.undo;
$('#img-editor-download').innerHTML = ICONS.download;
$$('#img-editor-tools .img-tool-btn').forEach((b) => {
  b.innerHTML = ICONS[IMG_EDITOR_TOOL_ICONS[b.dataset.tool]];
  b.classList.toggle('active', b.dataset.tool === imgEditor.tool);
  b.onclick = () => {
    imgEditor.tool = b.dataset.tool;
    $$('#img-editor-tools .img-tool-btn').forEach((x) => x.classList.toggle('active', x === b));
    imgEditorCanvas().classList.toggle('tool-text', imgEditor.tool === 'text');
  };
});

// Palette de couleurs de l'éditeur : construite une seule fois (elle ne
// dépend d'aucune note en particulier), "default" exclu comme pour
// label-color-grid — un gris quasi invisible ne sert à rien comme couleur
// de marquage.
(function buildImgEditorColors() {
  const box = $('#img-editor-colors');
  for (const c of COLORS.filter((x) => x !== 'default')) {
    const hex = LABEL_COLOR_HEX[c];
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'swatch c-' + c + (hex === imgEditor.color ? ' active' : '');
    s.title = c;
    s.onclick = () => {
      imgEditor.color = hex;
      box.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
      s.classList.add('active');
    };
    box.appendChild(s);
  }
})();

async function openImageEditor(att, note, source) {
  if (!att || !((att.meta && att.meta.mime) || '').startsWith('image/')) return;
  let loaded;
  try {
    loaded = await loadAttachment(att);
  } catch (err) {
    alert(err.message);
    return;
  }

  imgEditor.att = att;
  imgEditor.note = note;
  imgEditor.source = source;

  const img = new Image();
  img.onload = () => {
    const canvas = imgEditorCanvas();
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    imgEditor.history = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
    $('#dlg-image-editor').showModal();
  };
  img.onerror = () => alert("Impossible d'afficher cette image.");
  img.src = loaded.url;
}

// Conversion écran -> coordonnées du canvas : celui-ci est affiché à une
// taille réduite (max-width/max-height en CSS) mais dessiné à sa résolution
// naturelle, souvent bien plus grande — sans cette conversion, les tracés
// atterriraient au mauvais endroit dès que l'image dépasse la place
// disponible à l'écran.
function canvasPoint(e) {
  const canvas = imgEditorCanvas();
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function imgEditorStrokeWidth(canvas) { return Math.max(3, Math.round(canvas.width * 0.006)); }

function imgEditorPushHistory() {
  const canvas = imgEditorCanvas();
  imgEditor.history.push(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height));
  // Limite raisonnable : au-delà, on oublie les tout premiers états plutôt
  // que de laisser grandir indéfiniment la mémoire (chaque état est une
  // copie complète des pixels de l'image).
  if (imgEditor.history.length > 40) imgEditor.history.shift();
}

function imgEditorUndo() {
  if (imgEditor.history.length < 2) return;
  imgEditor.history.pop();
  const last = imgEditor.history[imgEditor.history.length - 1];
  imgEditorCanvas().getContext('2d').putImageData(last, 0, 0);
}
$('#img-editor-undo').addEventListener('click', imgEditorUndo);

function imgEditorRestoreStrokeBase() {
  imgEditorCanvas().getContext('2d').putImageData(imgEditor.strokeBase, 0, 0);
}

/* Dessine la forme en cours de geste (rectangle/ellipse/surlignage) ou un
   simple cadre pointillé de prévisualisation (mosaïque, dont le calcul
   réel n'a lieu qu'au relâchement — voir imgEditorCommitShape() — le
   recalculer à chaque déplacement de souris serait coûteux pour rien tant
   que la zone n'est pas fixée). Repart toujours de strokeBase pour ne
   jamais laisser de trace du tracé précédent pendant le glisser. */
function imgEditorDrawPreview(x0, y0, x1, y1) {
  imgEditorRestoreStrokeBase();
  const canvas = imgEditorCanvas();
  const ctx = canvas.getContext('2d');
  const x = Math.min(x0, x1), y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);

  if (imgEditor.tool === 'rect') {
    ctx.lineWidth = imgEditorStrokeWidth(canvas);
    ctx.strokeStyle = imgEditor.color;
    ctx.strokeRect(x, y, w, h);
  } else if (imgEditor.tool === 'ellipse') {
    ctx.lineWidth = imgEditorStrokeWidth(canvas);
    ctx.strokeStyle = imgEditor.color;
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (imgEditor.tool === 'highlight') {
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = imgEditor.color;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
  } else if (imgEditor.tool === 'mosaic') {
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
}

/* Pixellise une zone du canvas par blocs (réduction puis agrandissement
   sans lissage, la technique la plus simple pour "cacher" une zone sans
   dépendance externe). Taille de bloc proportionnelle à la zone choisie :
   une petite sélection a besoin de blocs plus petits, sinon elle
   disparaît entièrement en un seul carré uni. */
function imgEditorPixelate(ctx, x, y, w, h) {
  const canvas = ctx.canvas;
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.min(Math.round(w), canvas.width - x);
  h = Math.min(Math.round(h), canvas.height - y);
  if (w <= 0 || h <= 0) return;

  const blockSize = Math.max(6, Math.round(Math.min(w, h) / 12));
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(w / blockSize));
  small.height = Math.max(1, Math.round(h / blockSize));
  const sctx = small.getContext('2d');
  sctx.drawImage(canvas, x, y, w, h, 0, 0, small.width, small.height);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
  ctx.imageSmoothingEnabled = true;
}

function imgEditorCommitShape(x0, y0, x1, y1) {
  imgEditorRestoreStrokeBase();
  const canvas = imgEditorCanvas();
  const ctx = canvas.getContext('2d');
  const x = Math.min(x0, x1), y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  if (w < 2 || h < 2) return; // clic sans glisser : rien à enregistrer

  if (imgEditor.tool === 'rect') {
    ctx.lineWidth = imgEditorStrokeWidth(canvas);
    ctx.strokeStyle = imgEditor.color;
    ctx.strokeRect(x, y, w, h);
  } else if (imgEditor.tool === 'ellipse') {
    ctx.lineWidth = imgEditorStrokeWidth(canvas);
    ctx.strokeStyle = imgEditor.color;
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (imgEditor.tool === 'highlight') {
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = imgEditor.color;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
  } else if (imgEditor.tool === 'mosaic') {
    imgEditorPixelate(ctx, x, y, w, h);
  }
  imgEditorPushHistory();
}

/* Outil texte : un clic pose un <input> flottant pile à l'endroit cliqué
   (converti en coordonnées écran, pas celles du canvas) plutôt qu'un
   prompt() natif — reste dans le style de l'app et prévisualise la
   couleur choisie pendant la frappe. Entrée/perte de focus = valider,
   Échap = annuler. */
function imgEditorOpenTextInput(e, p) {
  const input = $('#img-editor-text-input');
  const wrap = $('#img-editor-canvas-wrap');
  const wrapRect = wrap.getBoundingClientRect();
  input.value = '';
  input.style.left = (e.clientX - wrapRect.left + wrap.scrollLeft) + 'px';
  input.style.top = (e.clientY - wrapRect.top + wrap.scrollTop - 14) + 'px';
  input.style.color = imgEditor.color;
  input.hidden = false;
  input.focus();

  const commit = () => {
    input.hidden = true;
    input.removeEventListener('blur', commit);
    input.removeEventListener('keydown', onKey);
    const text = input.value.trim();
    if (!text) return;
    const canvas = imgEditorCanvas();
    const ctx = canvas.getContext('2d');
    const fontSize = Math.max(18, Math.round(canvas.width * 0.028));
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
    ctx.fillStyle = imgEditor.color;
    ctx.textBaseline = 'top';
    ctx.fillText(text, p.x, p.y);
    imgEditorPushHistory();
  };
  const onKey = (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
    if (ev.key === 'Escape') { input.value = ''; input.blur(); }
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', onKey);
}

imgEditorCanvas().addEventListener('pointerdown', (e) => {
  if (!imgEditor.att) return;
  const p = canvasPoint(e);
  if (imgEditor.tool === 'text') {
    imgEditorOpenTextInput(e, p);
    return;
  }
  imgEditor.drawing = true;
  imgEditor.startX = p.x;
  imgEditor.startY = p.y;
  const canvas = imgEditorCanvas();
  imgEditor.strokeBase = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  canvas.setPointerCapture(e.pointerId);
});
imgEditorCanvas().addEventListener('pointermove', (e) => {
  if (!imgEditor.drawing) return;
  const p = canvasPoint(e);
  imgEditorDrawPreview(imgEditor.startX, imgEditor.startY, p.x, p.y);
});
imgEditorCanvas().addEventListener('pointerup', (e) => {
  if (!imgEditor.drawing) return;
  imgEditor.drawing = false;
  const p = canvasPoint(e);
  imgEditorCommitShape(imgEditor.startX, imgEditor.startY, p.x, p.y);
});
imgEditorCanvas().addEventListener('pointercancel', () => { imgEditor.drawing = false; });

// Fermeture sans enregistrer : bouton dédié, clic sur le fond, ou Échap
// (événement natif "cancel" d'un <dialog>) — les trois abandonnent les
// annotations. Seul le bouton "Enregistrer" ci-dessous envoie quoi que ce
// soit au serveur.
$('#img-editor-cancel').addEventListener('click', () => $('#dlg-image-editor').close());
$('#dlg-image-editor').addEventListener('click', (e) => {
  if (e.target === $('#dlg-image-editor')) $('#dlg-image-editor').close();
});

/* Aplatit le canvas et l'envoie au serveur (PUT, même id) — utilisé à la
   fois par "Enregistrer" et par "Télécharger" (qui enregistre d'abord la
   dernière version avant de la proposer en téléchargement, plutôt que de
   permettre de télécharger des annotations jamais persistées). Retourne
   le blob PNG déjà en clair (pas la peine de le redemander/déchiffrer au
   serveur juste après l'avoir chiffré nous-mêmes) et le nom de fichier à
   utiliser, pour que l'appelant puisse aussi déclencher un téléchargement
   sans repasser par le réseau. */
async function imgEditorPersist() {
  const att = imgEditor.att;
  if (!att) throw new Error('Aucune image chargée.');

  // Écraser les octets d'une pièce jointe est irréversible côté serveur
  // (voir PUT /api/attachments/{id}) : un instantané avant coup est le
  // seul moyen de retrouver l'image telle qu'elle était avant l'annotation.
  if (imgEditor.note) await snapshotNoteVersion(imgEditor.note.id);

  const canvas = imgEditorCanvas();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error("Impossible d'enregistrer l'image.");
  const buffer = await blob.arrayBuffer();
  const encrypted = await encryptBinary(buffer);

  // Toujours réenregistrée en PNG (le format du canvas) : le nom garde
  // son extension d'origine si on ne peut pas la remplacer proprement,
  // par simple prudence, mais le mime, lui, est systématiquement à jour.
  const originalName = (att.meta && att.meta.name) || 'image.png';
  const pngName = /\.[a-z0-9]+$/i.test(originalName)
    ? originalName.replace(/\.[a-z0-9]+$/i, '.png')
    : originalName + '.png';
  const meta = await encryptField(JSON.stringify({ name: pngName, mime: 'image/png' }));

  const form = new FormData();
  form.append('file', new Blob([encrypted]), 'blob');
  form.append('meta', meta);
  const updated = await apiUpload('/attachments/' + att.id, form, 'PUT');
  updated.meta = { name: pngName, mime: 'image/png' };

  // Les octets sur disque ont changé sous le même id : la version mise en
  // cache (l'ancienne image) est maintenant fausse.
  attachmentCache.delete(att.id);
  const list = (imgEditor.note && imgEditor.note.attachments) || [];
  const idx = list.findIndex((a) => a.id === att.id);
  if (idx !== -1) list[idx] = { ...list[idx], ...updated };

  return { blob, name: pngName };
}

function imgEditorRefreshCaller() {
  if (imgEditor.source === 'dns') renderAttachmentsSimple();
  else loadNotes();
}

$('#img-editor-save').addEventListener('click', async () => {
  const saveBtn = $('#img-editor-save');
  saveBtn.disabled = true;
  try {
    await imgEditorPersist();
    $('#dlg-image-editor').close();
    imgEditorRefreshCaller();
  } catch (err) {
    alert(err.message);
  } finally {
    saveBtn.disabled = false;
  }
});

// Télécharger : toujours la dernière version, modifiée ou non — on
// enregistre donc d'abord (même chemin que le bouton "Enregistrer") avant
// de proposer le fichier, sinon on risquerait de télécharger des
// annotations jamais réellement sauvegardées côté serveur. Ne ferme pas
// le dialogue : on peut vouloir continuer à annoter juste après.
$('#img-editor-download').addEventListener('click', async () => {
  const btn = $('#img-editor-download');
  btn.disabled = true;
  try {
    const { blob, name } = await imgEditorPersist();
    imgEditorRefreshCaller();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------- Historique -------------------------------
   Jusqu'à 10 instantanés par notask, pris côté client juste avant un
   changement potentiellement destructeur (voir snapshotNoteVersion() plus
   bas, appelée depuis saveNoteDialog()/saveNoteSimpleDialog() quand le
   contenu a réellement changé, avant une suppression de pièce jointe, et
   avant un enregistrement dans l'éditeur d'image). Liste -> détail d'une
   version -> restauration, dans #dlg-history, ouvert depuis dlg-note ou
   dlg-note-simple (bouton "Historique"/icône horloge). */

const historyState = { note: null, versions: [], current: null };
const versionAttachmentCache = new Map();

/* Octets d'une pièce jointe telle que sauvegardée dans un instantané —
   même principe que loadAttachment(), mais vers /version-attachments/{id}
   et avec son propre cache : ce sont des ids d'une table différente, une
   pièce jointe vivante et sa version historique ne doivent jamais être
   confondues. */
async function loadVersionAttachment(att) {
  if (versionAttachmentCache.has(att.id)) return versionAttachmentCache.get(att.id);
  const raw = await apiFetchBytes('/version-attachments/' + att.id);
  const plain = await decryptBinary(raw);
  const meta = att.meta || { name: 'Fichier', mime: 'application/octet-stream' };
  const blob = new Blob([plain], { type: meta.mime || 'application/octet-stream' });
  const result = { blob, url: URL.createObjectURL(blob), name: meta.name || 'Fichier', mime: meta.mime || '' };
  versionAttachmentCache.set(att.id, result);
  return result;
}

function formatHistoryDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/* Snapshot explicite côté client : voir le commentaire en tête de
   NoteVersion dans app/models.py pour le pourquoi (le serveur ne peut pas
   détecter par lui-même un changement dans un champ chiffré, IV aléatoire
   à chaque chiffrement). Volontairement silencieuse en cas d'échec — un
   instantané manqué ne doit jamais empêcher l'action réelle (sauvegarde,
   suppression, édition d'image) de continuer. */
async function snapshotNoteVersion(noteId) {
  try {
    await api('/notes/' + noteId + '/versions', { method: 'POST' });
  } catch (err) {
    console.warn('Instantané d\'historique non créé :', err.message);
  }
}

/* État "en clair" d'une notask au moment de l'ouverture d'un dialogue —
   comparé à sa version au moment de l'enregistrement (voir
   notePlainStateEqual()) pour décider si un instantané d'historique est
   nécessaire. Uniquement les champs qu'un dialogue peut effectivement
   modifier ; label_ids trié pour qu'un simple réordonnancement ne compte
   pas comme un changement. */
function noteSnapshotFromNote(note) {
  return {
    title: note.title || '',
    description: note.description || '',
    content: note.content || '',
    color: note.color,
    due_at: note.due_at || null,
    is_checklist: !!note.is_checklist,
    icon: note.icon || null,
    label_ids: [...(note.label_ids || [])].sort(),
    items: (note.items || []).map((i) => ({ text: i.text || '', checked: !!i.checked, due_at: i.due_at || null })),
  };
}

function notePlainStateEqual(a, b) {
  if (!a || !b) return false;
  if (a.title !== b.title || a.description !== b.description || a.content !== b.content) return false;
  if (a.color !== b.color || a.due_at !== b.due_at || a.is_checklist !== b.is_checklist || a.icon !== b.icon) return false;
  const lb = [...b.label_ids].sort();
  if (a.label_ids.length !== lb.length || a.label_ids.some((id, i) => id !== lb[i])) return false;
  if (a.items.length !== b.items.length) return false;
  for (let i = 0; i < a.items.length; i++) {
    const x = a.items[i], y = b.items[i];
    if (x.text !== y.text || x.checked !== y.checked || x.due_at !== y.due_at) return false;
  }
  return true;
}

function openHistoryDialog(note) {
  historyState.note = note;
  historyState.versions = [];
  historyState.current = null;
  $('#history-list').innerHTML = '';
  $('#history-list').hidden = false;
  $('#history-detail').hidden = true;
  $('#history-footer').hidden = true;
  $('#history-empty').hidden = true;
  $('#dlg-history').showModal();
  loadHistoryList();
}

async function loadHistoryList() {
  const note = historyState.note;
  if (!note) return;
  let versions;
  try {
    versions = await api(`/notes/${note.id}/versions`);
  } catch (err) {
    alert(err.message);
    return;
  }
  await Promise.all(versions.map(async (v) => { v.title = await decryptField(v.title); }));
  historyState.versions = versions;
  renderHistoryList();
}

function renderHistoryList() {
  const box = $('#history-list');
  box.innerHTML = '';
  $('#history-empty').hidden = historyState.versions.length > 0;
  for (const v of historyState.versions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item c-' + v.color;
    btn.innerHTML = `<span class="history-item-title">${escapeHtml(v.title || 'Sans titre')}</span>
      <span class="history-item-date">${formatHistoryDate(v.created_at)}</span>`;
    btn.onclick = () => openHistoryDetail(v.id);
    box.appendChild(btn);
  }
}

async function openHistoryDetail(versionId) {
  const note = historyState.note;
  if (!note) return;
  let v;
  try {
    v = await api(`/notes/${note.id}/versions/${versionId}`);
  } catch (err) {
    alert(err.message);
    return;
  }

  v.title = await decryptField(v.title);
  v.description = await decryptField(v.description);
  v.content = await decryptField(v.content);
  for (const it of v.items) it.text = await decryptField(it.text);
  for (const a of v.attachments) {
    try {
      a.meta = JSON.parse(await decryptField(a.enc_meta) || '{}');
    } catch {
      a.meta = { name: 'Fichier', mime: 'application/octet-stream' };
    }
  }
  historyState.current = v;

  let html = `<h3>${escapeHtml(v.title || 'Sans titre')}</h3>`;
  if (v.description) html += `<p class="history-detail-desc">${escapeHtml(v.description)}</p>`;
  if (v.is_checklist) {
    html += '<ul class="history-detail-items">' + v.items.map((it) =>
      `<li class="${it.checked ? 'done' : ''}">${escapeHtml(it.text || '')}</li>`
    ).join('') + '</ul>';
  } else if (v.content) {
    html += `<div class="history-detail-body">${escapeHtml(v.content)}</div>`;
  }
  if (v.due_at) html += `<div class="history-detail-due">${ICONS.clock}${formatDue(v.due_at)}</div>`;
  $('#history-detail-content').innerHTML = html;

  if (v.attachments.length) {
    const wrap = document.createElement('div');
    wrap.className = 'history-detail-attachments';
    for (const a of v.attachments) {
      const isImage = ((a.meta && a.meta.mime) || '').startsWith('image/');
      if (isImage) {
        const img = document.createElement('img');
        img.className = 'history-attach-thumb';
        loadVersionAttachment(a).then((r) => { img.src = r.url; }).catch(() => {});
        wrap.appendChild(img);
      } else {
        const chip = document.createElement('div');
        chip.className = 'history-attach-file';
        chip.innerHTML = `${ICONS.file}<span>${escapeHtml((a.meta && a.meta.name) || 'Fichier')}</span>`;
        wrap.appendChild(chip);
      }
    }
    $('#history-detail-content').appendChild(wrap);
  }

  $('#history-list').hidden = true;
  $('#history-detail').hidden = false;
  $('#history-footer').hidden = false;
}

$('#history-back').addEventListener('click', () => {
  historyState.current = null;
  $('#history-detail').hidden = true;
  $('#history-footer').hidden = true;
  $('#history-list').hidden = false;
});

$('#history-close').innerHTML = ICONS.close;
$('#history-close').addEventListener('click', () => $('#dlg-history').close());
$('#dlg-history').addEventListener('click', (e) => {
  if (e.target === $('#dlg-history')) $('#dlg-history').close();
});

$('#history-restore').addEventListener('click', async () => {
  const note = historyState.note;
  const v = historyState.current;
  if (!note || !v) return;
  if (!confirm('Restaurer cette version ? L’état actuel sera d’abord sauvegardé dans l’historique.')) return;
  try {
    await api(`/notes/${note.id}/versions/${v.id}/restore`, { method: 'POST' });
  } catch (err) {
    alert(err.message);
    return;
  }
  $('#dlg-history').close();
  // Les deux boîtes d'édition peuvent afficher des champs périmés après une
  // restauration (elles ne rechargent pas leur contenu en direct) : on les
  // referme plutôt que de tenter de resynchroniser chaque champ un par un.
  // close() sur une <dialog> déjà fermée ne fait rien (pas d'erreur).
  // IMPORTANT : dlg-note-simple enregistre à CHAQUE fermeture, y compris
  // native (voir plus haut : addEventListener('close', saveNoteSimpleDialog))
  // — fermer sans vider state.editingNote aurait renvoyé un PATCH avec les
  // anciennes valeurs du formulaire et écrasé la restauration qu'on vient
  // de faire. saveNoteSimpleDialog() retourne immédiatement si editingNote
  // est vide, avant de toucher au réseau.
  state.editingNote = null;
  $('#dlg-note-simple').close();
  $('#dlg-note').close();
  if (state.view in TASK_VIEWS) loadTasks(TASK_VIEWS[state.view]);
  else loadNotes();
});

$('#dn-history-btn').addEventListener('click', () => {
  if (state.editingNote) openHistoryDialog(state.editingNote);
});
$('#dns-history-btn').innerHTML = ICONS.history;
$('#dns-history-btn').addEventListener('click', () => {
  if (state.editingNote) openHistoryDialog(state.editingNote);
});

/* -------------------------------- Tâches --------------------------------
   Aucune création ici : une tâche est une note datée, ou une ligne à cocher
   datée à l'intérieur d'une note. On ne fait que les lister et les cocher. */

async function loadTasks(bucket) {
  const params = new URLSearchParams();
  if (bucket) params.set('bucket', bucket);
  const tasks = await api('/tasks' + (params.toString() ? '?' + params : ''));
  await Promise.all(tasks.map(async (t) => {
    t.text = await decryptField(t.text);
    t.note_title = await decryptField(t.note_title);
  }));
  state.tasks = tasks;
  renderTasks();
  updateTaskBadges();
}

function renderTasks() {
  const grid = $('#tasks-grid');
  grid.innerHTML = '';
  $('#tasks-empty').hidden = state.tasks.length > 0;

  // Regroupement par échéance, dans un ordre qui a du sens à la lecture
  const ordre = ['late', 'today', 'upcoming', 'done'];
  const groupes = {};
  for (const t of state.tasks) (groupes[t.bucket] ||= []).push(t);

  for (const b of ordre) {
    if (!groupes[b]) continue;

    const titre = document.createElement('h2');
    titre.className = 'tasks-group' + (b === 'late' ? ' late' : '');
    titre.textContent = `${BUCKET_LABELS[b]} (${groupes[b].length})`;
    grid.appendChild(titre);

    const liste = document.createElement('div');
    liste.className = 'task-cards';

    for (const t of groupes[b]) {
      const card = document.createElement('article');
      card.className = 'task-card c-' + t.color + (t.done ? ' done' : '');

      // Une tâche issue d'une ligne rappelle toujours la note dont elle vient
      const origine = t.kind === 'item'
        ? `<button class="task-origin" title="Ouvrir la notask">
             ${ICONS.noteRef}<span>${escapeHtml(t.note_title || 'Notask sans titre')}</span>
           </button>`
        : '';

      card.innerHTML = `
        <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Terminer">
        <div class="task-main">
          <div class="task-text">${escapeHtml(t.text || (t.kind === 'item' ? 'Ligne sans texte' : 'Notask sans titre'))}</div>
          <div class="task-meta">
            <span class="${b === 'late' ? 'late' : ''}">${ICONS.clock}${formatDue(t.due_at)}</span>
          </div>
          ${origine}
        </div>`;

      card.querySelector('input').onchange = async (e) => {
        e.stopPropagation();
        await api(`/tasks/${t.kind}/${t.id}`, { method: 'PATCH', body: { done: e.target.checked } });
        loadTasks(TASK_VIEWS[state.view]);
      };

      // Clic n'importe où sur la carte (hors case à cocher) = ouvrir la
      // notask d'origine en édition rapide. Le bouton .task-origin fait la
      // même chose (voir plus bas) : exclu ici pour ne pas déclencher
      // l'ouverture deux fois d'affilée.
      card.addEventListener('click', (e) => {
        if (e.target.closest('input, .task-origin')) return;
        ouvrirNoteParId(t.note_id);
      });

      const lien = card.querySelector('.task-origin');
      if (lien) lien.onclick = () => ouvrirNoteParId(t.note_id);

      liste.appendChild(card);
    }
    grid.appendChild(liste);
  }
}

// Ouvre la notask d'origine d'une tâche (menu de gauche ou colonne agenda
// à droite) directement en édition rapide, pas la boîte "Modifier" complète
// — c'est ce que demande l'utilisateur pour un clic depuis une liste de
// tâches. decryptNote() hydrate déjà items/attachments/label_ids, tout ce
// dont openNoteSimpleDialog() a besoin.
async function ouvrirNoteParId(noteId) {
  const note = await api('/notes/' + noteId);
  await decryptNote(note);
  openNoteSimpleDialog(note);
}

/* Petits ronds de comptage dans le menu de gauche (nav-late/today/upcoming/
   tasks). Pas de déchiffrement ici : `bucket` est calculé côté serveur à
   partir de due_at/done, jamais chiffré — on n'a besoin que de ce champ
   pour compter, inutile de déchiffrer texte/titre pour un simple nombre.
   Volontairement indépendant de loadAgenda() : le badge "à venir" doit
   refléter le total réel (la colonne, elle, se limite à 7 jours). */
async function updateTaskBadges() {
  let tasks;
  try {
    tasks = await api('/tasks');
  } catch {
    return;
  }
  const counts = { late: 0, today: 0, upcoming: 0 };
  for (const t of tasks) if (t.bucket in counts) counts[t.bucket] += 1;
  const total = counts.late + counts.today + counts.upcoming;

  const set = (id, n) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = n;
    el.hidden = n === 0;
  };
  set('count-tasks', total);
  set('count-late', counts.late);
  set('count-today', counts.today);
  set('count-upcoming', counts.upcoming);
}

/* --------------------------- Colonne d'échéances --------------------------
   Aperçu compact des notasks proches, affiché à côté de la mosaïque (voir
   #agenda-col dans index.html et switchView() qui l'active/désactive selon
   la vue). Volontairement borné à 7 jours pour "à venir" — sans limite, la
   colonne finirait par afficher toutes les échéances lointaines, ce qui n'a
   plus rien d'un coup d'œil rapide. Les tâches terminées n'y figurent pas. */
async function loadAgenda() {
  let tasks;
  try {
    tasks = await api('/tasks');
  } catch {
    return; // session expirée par ex. — api() gère déjà la redirection
  }
  await Promise.all(tasks.map(async (t) => {
    t.text = await decryptField(t.text);
    t.note_title = await decryptField(t.note_title);
  }));
  const now = new Date();
  const dans7j = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const items = tasks.filter((t) => {
    if (t.bucket === 'late' || t.bucket === 'today') return true;
    if (t.bucket === 'upcoming') return new Date(t.due_at) <= dans7j;
    return false; // "done" exclu : la colonne suit les échéances à venir, pas un historique
  });
  renderAgenda(items);
}

function renderAgenda(items) {
  const box = $('#agenda-content');
  box.innerHTML = '';
  $('#agenda-empty').hidden = items.length > 0;

  const ordre = ['late', 'today', 'upcoming'];
  const groupes = {};
  for (const t of items) (groupes[t.bucket] ||= []).push(t);

  for (const b of ordre) {
    if (!groupes[b] || !groupes[b].length) continue;

    const section = document.createElement('div');
    // Classe de bucket toujours posée (pas seulement pour "late") : la
    // couleur du titre de section en dépend (rouge/vert/bleu cuillère),
    // voir .agenda-group.late/.today/.upcoming dans style.css.
    section.className = 'agenda-group ' + b;
    const h2 = document.createElement('h2');
    h2.textContent = `${BUCKET_LABELS[b]} (${groupes[b].length})`;
    section.appendChild(h2);

    for (const t of groupes[b]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      // Fond = couleur propre de la note d'origine (même classe .c-* que
      // sur sa carte), pas un simple repère en bordure : on veut
      // reconnaître la note d'un coup d'œil, pas juste voir "une tâche".
      btn.className = 'agenda-item c-' + t.color;
      const label = t.text || (t.kind === 'item' ? 'Ligne sans texte' : 'Notask sans titre');
      // Icône toujours affichée dans un rond : celle de la notask si elle en
      // a une, sinon la cuillère bleue par défaut — jamais de rond vide, le
      // texte est ainsi toujours décalé de la même largeur.
      const icon = ICON_CHOICES[t.icon] || ICON_CHOICES.spoonblue;
      btn.innerHTML = `<span class="agenda-item-icon">${icon}</span>
        <span class="agenda-item-body">
          <span class="agenda-item-text">${escapeHtml(label)}</span>
          <span class="agenda-item-due">${formatDue(t.due_at)}</span>
        </span>`;
      btn.addEventListener('click', () => ouvrirNoteParId(t.note_id));
      section.appendChild(btn);
    }
    box.appendChild(section);
  }
}

/* -------------------------------- Comptes -------------------------------- */

async function loadUsers() {
  const users = await api('/users');
  const body = $('#users-body');
  body.innerHTML = '';

  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(u.username)}${u.id === state.user.id ? ' <span class="badge">vous</span>' : ''}</td>
      <td>${u.is_admin ? '<span class="badge admin">admin</span>' : '<span class="badge">membre</span>'}</td>
      <td>${u.is_active ? 'actif' : '<span class="badge off">désactivé</span>'}</td>
      <td>${new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
      <td style="text-align:right"></td>`;

    const cell = tr.lastElementChild;
    if (u.id !== state.user.id) {
      const toggle = document.createElement('button');
      toggle.className = 'btn ghost sm';
      toggle.textContent = u.is_active ? 'Désactiver' : 'Réactiver';
      toggle.onclick = async () => {
        try { await api('/users/' + u.id, { method: 'PATCH', body: { is_active: !u.is_active } }); loadUsers(); }
        catch (err) { alert(err.message); }
      };

      const reset = document.createElement('button');
      reset.className = 'btn ghost sm';
      reset.textContent = 'Réinit. mdp';
      reset.onclick = async () => {
        const pw = prompt('Nouveau mot de passe provisoire (8 caractères minimum) :');
        if (!pw) return;
        try { await api('/users/' + u.id, { method: 'PATCH', body: { password: pw } }); alert('Mot de passe réinitialisé.'); }
        catch (err) { alert(err.message); }
      };

      const del = document.createElement('button');
      del.className = 'btn danger sm';
      del.textContent = 'Supprimer';
      del.onclick = async () => {
        if (!confirm(`Supprimer ${u.username} et toutes ses données ?`)) return;
        try { await api('/users/' + u.id, { method: 'DELETE' }); loadUsers(); }
        catch (err) { alert(err.message); }
      };

      cell.append(toggle, ' ', reset, ' ', del);
    }
    body.appendChild(tr);
  }
}

$('#btn-new-user').addEventListener('click', () => {
  $('#du-name').value = ''; $('#du-pw').value = ''; $('#du-admin').checked = false;
  msg($('#du-msg'), '');
  $('#dlg-user').showModal();
});

$('#du-cancel').addEventListener('click', () => $('#dlg-user').close());

$('#du-save').addEventListener('click', async () => {
  try {
    await api('/users', {
      method: 'POST',
      body: {
        username: $('#du-name').value.trim(),
        password: $('#du-pw').value,
        is_admin: $('#du-admin').checked,
      },
    });
    $('#dlg-user').close();
    loadUsers();
  } catch (err) { msg($('#du-msg'), err.message); }
});

/* ---------------------------- Mot de passe ---------------------------- */

$('#btn-password').addEventListener('click', () => {
  $('#dp-current').value = ''; $('#dp-new').value = ''; $('#dp-new2').value = '';
  msg($('#dp-msg'), '');
  $('#dlg-password').showModal();
});

$('#dp-cancel').addEventListener('click', () => $('#dlg-password').close());

$('#dp-save').addEventListener('click', async () => {
  if ($('#dp-new').value !== $('#dp-new2').value) {
    return msg($('#dp-msg'), 'Les deux mots de passe ne correspondent pas.');
  }
  try {
    await api('/auth/password', {
      method: 'POST',
      body: { current_password: $('#dp-current').value, new_password: $('#dp-new').value },
    });
    // Le mot de passe change, donc la clé qui le protège (KEK) aussi : on
    // réenveloppe la même clé de chiffrement des notes (déjà en mémoire)
    // avec la nouvelle, pour ne perdre l'accès à aucune note existante.
    await rewrapDekForNewPassword($('#dp-new').value);
    state.user.must_change_password = false;
    $('#dlg-password').close();
  } catch (err) { msg($('#dp-msg'), err.message); }
});

boot();
