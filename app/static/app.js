/* notask — interface web. Vanilla JS, aucun framework. */

// Repère de version, à bumper à chaque changement notable de ce fichier —
// affiché bien visible au chargement pour trancher, sans ambiguïté, entre
// "le navigateur affiche encore une version en cache" et "il y a un vrai
// bug dans le code déployé". Coller ce numéro (visible dans la console,
// F12) résout en un coup d'œil ce genre de doute.
/* Version de l'application. Palier 0.9 jusqu'à l'annonce de la V1 :
   on incrémente la 4e décimale à chaque livraison (0.9001, 0.9002, …),
   ce qui laisse de la place jusqu'à 1.0 sans jamais l'atteindre par
   accident. Doit rester synchronisé avec le fichier VERSION à la racine
   (source de vérité côté dépôt) et avec la version de l'API dans
   app/main.py. */
const APP_VERSION = '0.9003';

const BUILD_VERSION = APP_VERSION;
console.log('%c[notask] build ' + BUILD_VERSION, 'background:#6750a4;color:#fff;padding:2px 8px;border-radius:4px;font-weight:bold;');

/* ============================== Journal ==============================
   Journal consultable depuis Outils → Journal, sans passer par la console
   du navigateur (inaccessible en pratique sur mobile, où se produisent
   justement la plupart des soucis : micro refusé, réseau qui coupe,
   synchronisation Google...).

   Placé tout en haut du fichier, AVANT tout le reste : une erreur survenue
   pendant l'évaluation du script ou au premier rendu doit déjà être
   capturée. Placé plus bas, ces erreurs-là — les plus intéressantes —
   seraient perdues.

   Tampon circulaire borné : un journal qui grandit sans fin finirait par
   peser sur la mémoire d'un onglet laissé ouvert des jours durant. */
const JOURNAL_MAX = 500;
const journal = [];
let journalAuChangement = null;   // rendu de la fenêtre, branché plus bas

function ajouterAuJournal(niveau, source, message, detail) {
  const entree = {
    ts: new Date(),
    niveau,                       // 'error' | 'warn' | 'info' | 'debug'
    source: source || 'app',
    message: String(message),
    detail: detail === undefined ? '' : detailLisible(detail),
  };
  journal.push(entree);
  if (journal.length > JOURNAL_MAX) journal.shift();
  if (journalAuChangement) journalAuChangement();
  return entree;
}

/* Un détail peut être une Error, un objet, un tableau… Tout est ramené à
   du texte AU MOMENT de la journalisation : garder la référence laisserait
   voir l'état de l'objet au moment de la CONSULTATION, pas au moment de
   l'incident — trompeur pour un journal. */
function detailLisible(v) {
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    // Références circulaires, objets natifs non sérialisables.
    return String(v);
  }
}

const log = {
  error: (source, message, detail) => ajouterAuJournal('error', source, message, detail),
  warn: (source, message, detail) => ajouterAuJournal('warn', source, message, detail),
  info: (source, message, detail) => ajouterAuJournal('info', source, message, detail),
  debug: (source, message, detail) => ajouterAuJournal('debug', source, message, detail),
};

/* Erreurs non rattrapées et promesses rejetées : ce sont exactement celles
   qui n'apparaissent nulle part dans l'interface et qu'on ne peut pas
   deviner autrement. */
window.addEventListener('error', (e) => {
  const ou = e.filename ? ` (${String(e.filename).split('/').pop()}:${e.lineno})` : '';
  ajouterAuJournal('error', 'navigateur', (e.message || 'Erreur inconnue') + ou, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  ajouterAuJournal('error', 'promesse', 'Promesse rejetée sans traitement', e.reason);
});

/* console.error/warn recopiés dans le journal — sans les remplacer : la
   sortie console normale doit rester intacte pour le débogage sur poste
   fixe. Beaucoup de code (y compris des bibliothèques) ne signale ses
   soucis que par ce canal. */
['error', 'warn'].forEach((niveau) => {
  const original = console[niveau].bind(console);
  console[niveau] = (...args) => {
    original(...args);
    try {
      ajouterAuJournal(niveau, 'console', args.map((a) => (typeof a === 'string' ? a : detailLisible(a))).join(' '));
    } catch { /* le journal ne doit jamais casser un appel console */ }
  };
});

log.info('app', `Démarrage de notask ${APP_VERSION}`);

// PWA : enregistrement du service worker (app-shell uniquement, voir sw.js).
// Après le chargement pour ne jamais retarder l'affichage initial ; l'échec
// est avalé volontairement (ex. navigation privée) — l'app doit continuer à
// fonctionner normalement sans installation possible.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

/* Hauteur du clavier virtuel mobile, tenue à jour dans --kb-inset. Le
   clavier n'est PAS une rotation/barre d'adresse : les unités dvh/svh/lvh
   (déjà utilisées ailleurs pour les boîtes plein écran, voir style.css) ne
   le prennent pas en compte, par définition — il faut l'API VisualViewport
   pour le détecter. Sur Android Chrome, le viewport de mise en page se
   redimensionne déjà tout seul avec le clavier (--kb-inset resterait à peu
   près 0, sans conséquence) ; sur iOS Safari, le clavier recouvre juste le
   bas de l'écran SANS redimensionner la mise en page — c'est là que la
   barre d'outils d'une notask ouverte se retrouverait cachée dessous sans
   ce calcul (voir .dns-bottom-bar dans style.css, qui lit cette variable). */
if (window.visualViewport) {
  const vv = window.visualViewport;
  const ajusterPourClavier = () => {
    const hauteurClavier = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb-inset', hauteurClavier + 'px');
  };
  vv.addEventListener('resize', ajusterPourClavier);
  vv.addEventListener('scroll', ajusterPourClavier);
  ajusterPourClavier();
}

const TOKEN_KEY = 'notask_token';
/* 24 teintes = deux rangées pleines de 12 dans le sélecteur. Trois listes à
   garder synchronisées : celle-ci, LABEL_COLOR_HEX juste en dessous, les
   classes .c-* de style.css, et l'ensemble COLORS de app/routers/notes.py
   (le serveur refuse toute couleur qu'il ne connaît pas). */
const COLORS = [
  'default', 'red', 'coral', 'orange', 'amber', 'yellow', 'lime',
  'green', 'emerald', 'teal', 'cyan', 'blue', 'indigo', 'violet',
  'purple', 'magenta', 'pink', 'rose', 'brown', 'slate', 'grey',
  'navy', 'olive', 'white',
];

// Mêmes teintes que les classes .c-* de style.css, dupliquées ici pour
// pouvoir les poser en style inline sur un libellé (voir renderLabelsDrawer)
// ou comme couleur de texte (voir la palette partagée construirePalette).
const LABEL_COLOR_HEX = {
  red: '#7a2e33', coral: '#8a3a2a', orange: '#8a541c', amber: '#856614',
  yellow: '#7a6f12', lime: '#55771c', green: '#2f7a3c', emerald: '#16785b',
  teal: '#146b6a', cyan: '#12607a', blue: '#1d548f', indigo: '#364196',
  violet: '#5138a3', purple: '#68318f', magenta: '#7d2c7d', pink: '#8a2c61',
  rose: '#8a2c44', brown: '#664a37', slate: '#3f4b5a', grey: '#4b4b52',
  navy: '#1e3a5f', olive: '#5d6b2f', white: '#ffffff',
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

   La DEK déballée (encKey) est mise en cache en localStorage, comme le
   jeton de connexion — donc survit à la fermeture de l'onglet/appli et à un
   redémarrage du navigateur, jusqu'à déconnexion explicite (clearEncKey(),
   voir seDeconnecter()). Compromis de sécurité choisi EXPLICITEMENT par
   l'utilisateur (2026-08-01), en connaissance de cause : ça évite de
   ressaisir le mot de passe à chaque lancement de la PWA installée (où,
   contrairement à un onglet de navigateur classique, chaque lancement
   démarre un contexte neuf — sessionStorage y était donc vidé à CHAQUE
   ouverture, pas seulement de temps en temps), au prix d'une garantie de
   bout en bout affaiblie : quiconque accède au stockage local de l'appareil
   (vol, malware, appareil déverrouillé laissé sans surveillance) peut lire
   les notasks sans connaître le mot de passe, tant qu'aucune déconnexion
   explicite n'a eu lieu entretemps. Avant ce changement, la DEK n'était
   jamais mise en cache qu'en sessionStorage, précisément pour éviter ce
   risque — à rétablir si la décision devait changer un jour.

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
  localStorage.setItem(EKEY_STORAGE, bytesToBase64(new Uint8Array(raw)));
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

/* Reprend la DEK mise en cache en localStorage — survit à un rechargement
   de page, à la fermeture de l'onglet/appli, et à un redémarrage du
   navigateur (voir le commentaire d'architecture plus haut : choix
   explicite de l'utilisateur, 2026-08-01, pour ne pas avoir à ressaisir
   le mot de passe à chaque lancement de la PWA). Seule une déconnexion
   explicite (clearEncKey(), voir seDeconnecter()) l'efface. */
async function restoreCachedKey() {
  const cached = localStorage.getItem(EKEY_STORAGE);
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
  localStorage.removeItem(EKEY_STORAGE);
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
  // Recherche en profondeur (seconde barre) : terme cherché, et rang de
  // l'occurrence affichée pour chaque notask (clé = id de la notask).
  deepSearch: '',
  deepCursor: {},
  trashNotes: [],
  editingNote: null,
  editingNoteItems: [],
  labels: [],
  labelFilter: null,
  editingLabelIds: [],
  // Couleur en cours d'édition dans la boîte d'édition rapide (la boîte
  // "Modifier" complète, elle, écrit directement dans state.editingNote).
  editingColor: 'default',
  // Masquage du contenu sur l'accueil, en cours d'édition.
  editingMasked: false,
  composerIcon: null,
  editingIcon: null,
};

const BUCKET_LABELS = {
  late: 'notasks en retard',
  today: 'notasks du jour',
  upcoming: 'notasks à venir',
  done: 'notasks terminées',
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

  if (res.status === 401) {
    log.warn('api', `401 sur ${options.method || 'GET'} ${path} — session expirée`);
    setToken(null); showLogin(); throw new Error('Session expirée');
  }
  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Journalisé ici, au seul endroit par lequel passent tous les appels :
    // les appelants, eux, se contentent souvent d'un message générique et
    // la vraie cause renvoyée par le serveur se perdait.
    log.error('api', `${res.status} sur ${options.method || 'GET'} ${path}`, (data && data.detail) || null);
    throw new Error((data && data.detail) || 'Erreur ' + res.status);
  }
  log.debug('api', `${res.status} ${options.method || 'GET'} ${path}`);
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
  // Distingue une image d'un fichier quelconque dans les LISTES de pièces
  // jointes, qui n'affichent plus de vignette (le rendu visuel est réservé
  // au corps de la notask).
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4 16.5l4.5-4 3.5 3 3-2.5 5 4.5"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v4"/><path d="M8 7v10"/><path d="M12 4.5v15"/><path d="M16 8v8"/><path d="M20 10.5v3"/></svg>',
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

  /* Pointes de tracé libre + tableau blanc + plein écran. */
  imgBrush: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 4.5 19.5 8.5 11 17a4 4 0 0 1-2 1.1l-3.6.8.8-3.6A4 4 0 0 1 7.3 13z"/><path d="M14 6 18 10"/></svg>',
  imgPencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5z"/><path d="M13.5 7 17 10.5"/><path d="M5 15.5 8.5 19"/></svg>',
  imgMarker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15l-3.5.8.8-3.5 8.2-8.2a2 2 0 0 1 2.8 0l.9.9a2 2 0 0 1 0 2.8z"/><path d="M4 20h16"/></svg>',
  imgEraser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 19 4 14.5a1.5 1.5 0 0 1 0-2.1l7.9-7.9a1.5 1.5 0 0 1 2.1 0l5.5 5.5a1.5 1.5 0 0 1 0 2.1L13.5 19z"/><path d="M8.5 19H20"/><path d="M9 9.5 15.5 16"/></svg>',
  board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M12 16.5V20"/><path d="M9 20h6"/><path d="M7 12.5l3-3 2.5 2.5 2-2"/></svg>',
  // Micro plein = note vocale (enregistre un fichier joint).
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/><path d="M9 21h6"/></svg>',
  // Micro + lignes de texte = dictée (écrit dans la notask, n'attache rien) :
  // volontairement distinct du micro seul, les deux boutons étant voisins.
  dictee: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="5" height="9.5" rx="2.5"/><path d="M1.8 10.5a4.7 4.7 0 0 0 9.4 0"/><path d="M6.5 15v2.5"/><path d="M14 8h7"/><path d="M14 12h7"/><path d="M14 16h5"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="7.5" y="5.5" width="3.5" height="13" rx="1"/><rect x="13" y="5.5" width="3.5" height="13" rx="1"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4.5h4.5"/><path d="M20 9V4.5h-4.5"/><path d="M4 15v4.5h4.5"/><path d="M20 15v4.5h-4.5"/></svg>',
  fullscreenExit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 4.5V9H4"/><path d="M15.5 4.5V9H20"/><path d="M8.5 19.5V15H4"/><path d="M15.5 19.5V15H20"/></svg>',

  // Œil barré : masquage du contenu sur l'accueil.
  maskEye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.6"/><path d="M4 20 20 4"/></svg>',

  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="1.8"/><path d="M15 6.5V5.8A1.8 1.8 0 0 0 13.2 4H5.8A1.8 1.8 0 0 0 4 5.8v7.4A1.8 1.8 0 0 0 5.8 15h.7"/></svg>',

  // Couleur du texte : un "A" surmontant une barre colorée, comme dans les
  // traitements de texte. La barre prend la couleur courante via
  // currentColor, donc elle suit la teinte du bouton.
  textColor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15.5 9.5 5l4.5 10.5"/><path d="M6.6 12.5h5.8"/><rect x="15.5" y="5" width="4" height="11" rx="1"/><path d="M4 20h16" stroke-width="2.4"/></svg>',

  // Effacer la mise en forme : un "T" (texte) barré en diagonale, lecture
  // immédiate même sans connaître l'icône à l'avance.
  clearFormat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5.5h14"/><path d="M12 5.5V17"/><path d="M9 17h6"/><path d="M4.5 20 19.5 4"/></svg>',
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

  /* Lot ajouté pour étoffer le choix (15 -> 35) — même esprit que les
     précédentes : formes simples, en couleur, viewBox 0 0 24 24 commun.
     Synchronisé avec ICON_KEYS côté serveur (app/routers/notes.py). */
  health: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="3" fill="#ef5350"/><path d="M11 7h2v4h4v2h-4v4h-2v-4H7v-2h4z" fill="#fff"/></svg>',
  sport: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="#ff8a65"/><path d="M12 3.5v17M3.5 12h17M5.8 6.2c2 1.6 2 8 0 11.6M18.2 6.2c-2 1.6-2 8 0 11.6" fill="none" stroke="#d84315" stroke-width="1.2"/></svg>',
  car: '<svg viewBox="0 0 24 24"><path d="M4.5 14.5 6 9.5a2 2 0 0 1 1.9-1.4h8.2A2 2 0 0 1 18 9.5l1.5 5" fill="none" stroke="#5c6bc0" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><rect x="3" y="14" width="18" height="4.5" rx="1.4" fill="#5c6bc0"/><circle cx="7.5" cy="18.7" r="1.7" fill="#37474f"/><circle cx="16.5" cy="18.7" r="1.7" fill="#37474f"/></svg>',
  laptop: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="10" rx="1.2" fill="#78909c"/><rect x="5.2" y="6.2" width="13.6" height="7.6" rx=".6" fill="#263238"/><path d="M2.5 18.5h19l-1.5 2H4z" fill="#90a4ae"/><path d="M9.5 8.3 7.6 10l1.9 1.7M14.5 8.3 16.4 10l-1.9 1.7" fill="none" stroke="#80deea" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  school: '<svg viewBox="0 0 24 24"><path d="M12 4 2 8.5 12 13l10-4.5z" fill="#8d6e63"/><path d="M6 10.5v4.3c0 1.4 2.7 2.7 6 2.7s6-1.3 6-2.7v-4.3" fill="none" stroke="#8d6e63" stroke-width="1.5" stroke-linecap="round"/><path d="M20.5 9v6" stroke="#5d4037" stroke-width="1.4" stroke-linecap="round"/></svg>',
  plant: '<svg viewBox="0 0 24 24"><path d="M12 21V11" stroke="#6d4c41" stroke-width="1.6" stroke-linecap="round" fill="none"/><path d="M12 12c0-4.5 3.5-8 8-8 0 4.5-3.5 8-8 8z" fill="#66bb6a"/><path d="M12 15c0-3.5-2.7-6.2-6.2-6.2 0 3.5 2.7 6.2 6.2 6.2z" fill="#81c784"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1-1.8h7l1 1.8h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z" fill="#78909c"/><circle cx="12" cy="13" r="3.6" fill="#37474f"/><circle cx="12" cy="13" r="2.1" fill="#90a4ae"/></svg>',
  game: '<svg viewBox="0 0 24 24"><path d="M6.5 8.5h11a4 4 0 0 1 3.9 4.9l-.6 2.6a2.3 2.3 0 0 1-4-1L16 14H8l-.8 1a2.3 2.3 0 0 1-4 1l-.6-2.6a4 4 0 0 1 3.9-4.9z" fill="#7e57c2"/><path d="M8 10.7v3M6.5 12.2h3" stroke="#ede7f6" stroke-width="1.3" stroke-linecap="round"/><circle cx="15" cy="11" r=".9" fill="#ede7f6"/><circle cx="17" cy="13" r=".9" fill="#ede7f6"/></svg>',
  tool: '<svg viewBox="0 0 24 24"><path d="M14.7 9.3a4 4 0 0 1-5.4 5.4L4 20l-1-1 5.3-5.3a4 4 0 0 1 5.4-5.4l-2.4 2.4 1.4 1.4z" fill="#8d6e63"/></svg>',
  warning: '<svg viewBox="0 0 24 24"><path d="M12 3.5 22 20.5H2z" fill="#ffb300"/><rect x="11.1" y="9.5" width="1.8" height="5.5" rx=".9" fill="#5d4037"/><circle cx="12" cy="17.3" r="1.1" fill="#5d4037"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9.5" rx="1.6" fill="#78909c"/><path d="M7.5 11V8a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="#78909c" stroke-width="1.7"/><circle cx="12" cy="15" r="1.6" fill="#263238"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="#4dd0e1"/><path d="M3.5 12h17M12 3.5c2.6 2.3 2.6 15 0 17M12 3.5c-2.6 2.3-2.6 15 0 17" fill="none" stroke="#00838f" stroke-width="1.2"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2" fill="#455a64"/><rect x="8.2" y="4.7" width="7.6" height="12.6" fill="#cfd8dc"/><circle cx="12" cy="19" r="1" fill="#cfd8dc"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5.5" width="18" height="13" rx="1.6" fill="#4fc3f7"/><path d="M3.5 6.5 12 13l8.5-6.5" fill="none" stroke="#e1f5fe" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  coffee: '<svg viewBox="0 0 24 24"><path d="M5 9h11v6a3.5 3.5 0 0 1-3.5 3.5H8.5A3.5 3.5 0 0 1 5 15z" fill="#8d6e63"/><path d="M16 10.5h1.5a2.3 2.3 0 0 1 0 4.6H16" fill="none" stroke="#8d6e63" stroke-width="1.5"/><path d="M8 5.5c-.8.9-.8 1.7 0 2.6M11.5 5.5c-.8.9-.8 1.7 0 2.6" stroke="#a1887f" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.6" fill="#ffca28"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19" stroke="#ffca28" stroke-width="1.6" stroke-linecap="round"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M19 14.5A8 8 0 1 1 9.5 5a6.5 6.5 0 0 0 9.5 9.5z" fill="#7986cb"/></svg>',
  paw: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="16" rx="5.5" ry="4.3" fill="#a1887f"/><circle cx="5.5" cy="10" r="2.1" fill="#a1887f"/><circle cx="9.3" cy="6.3" r="2.1" fill="#a1887f"/><circle cx="14.7" cy="6.3" r="2.1" fill="#a1887f"/><circle cx="18.5" cy="10" r="2.1" fill="#a1887f"/></svg>',
  food: '<svg viewBox="0 0 24 24"><path d="M7 2.5v8.6M5 2.5v5.6a2 2 0 0 0 4 0V2.5M7 11.1V21.5" stroke="#ff8a65" stroke-width="1.5" stroke-linecap="round" fill="none"/><path d="M17 2.5c-1.8 1-2.3 3.4-1.1 6.4.7 1.9.2 2.9-.9 3.6v9" stroke="#ff8a65" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>',
  document: '<svg viewBox="0 0 24 24"><path d="M6 3.5h8l4 4v13H6z" fill="#90a4ae"/><path d="M14 3.5v4h4" fill="#cfd8dc"/><path d="M8.5 12h7M8.5 15.5h7M8.5 19h4" stroke="#455a64" stroke-width="1.3" stroke-linecap="round"/></svg>',

  /* Encore un lot (35 -> 55), sur demande explicite ("pas assez d'icônes") —
     même esprit : formes simples, en couleur, viewBox 0 0 24 24 commun.
     Chaque SVG vérifié bien formé (xml.etree) avant intégration, mais pas
     vu rendu dans un vrai navigateur (aucun disponible dans cet
     environnement) — à vérifier côté utilisateur. Synchronisé avec
     ICON_KEYS côté serveur (app/routers/notes.py). */
  fish: '<svg viewBox="0 0 24 24"><path d="M2.5 12c3-3.5 7.5-5.5 12-4.5 2.3.5 4 2 5 4.5-1 2.5-2.7 4-5 4.5-4.5 1-9-1-12-4.5z" fill="#4fc3f7"/><circle cx="7.5" cy="11.3" r="1" fill="#01579b"/><path d="M19.5 12l2.7-3v6z" fill="#4fc3f7"/></svg>',
  bird: '<svg viewBox="0 0 24 24"><circle cx="10" cy="14" r="6" fill="#90caf9"/><circle cx="15.5" cy="9.5" r="3.6" fill="#90caf9"/><path d="M18.5 8.5l3-1-1.5 3z" fill="#f9a825"/><circle cx="16.3" cy="8.3" r=".8" fill="#0d47a1"/><path d="M6 17c-1.5 1-2.7 1.3-4 1 1-1.3 1.8-2.3 2.3-3.2z" fill="#64b5f6"/></svg>',
  tree: '<svg viewBox="0 0 24 24"><rect x="10.7" y="14" width="2.6" height="7.5" rx="1" fill="#6d4c41"/><circle cx="12" cy="9" r="7" fill="#66bb6a"/><circle cx="7.5" cy="11.5" r="4.2" fill="#81c784"/><circle cx="16.5" cy="11.5" r="4.2" fill="#81c784"/></svg>',
  flower: '<svg viewBox="0 0 24 24"><circle cx="12" cy="7.5" r="3" fill="#f06292"/><circle cx="17" cy="12" r="3" fill="#f06292"/><circle cx="12" cy="16.5" r="3" fill="#f06292"/><circle cx="7" cy="12" r="3" fill="#f06292"/><circle cx="12" cy="12" r="2.6" fill="#ffd54f"/><rect x="11" y="16" width="2" height="6" rx="1" fill="#66bb6a"/></svg>',
  pizza: '<svg viewBox="0 0 24 24"><path d="M12 3 21.5 20.5H2.5z" fill="#ffb74d"/><path d="M12 3 21.5 20.5H2.5z" fill="none" stroke="#e65100" stroke-width="1" stroke-linejoin="round"/><circle cx="11" cy="11.5" r="1.1" fill="#c62828"/><circle cx="14.5" cy="14.5" r="1.1" fill="#c62828"/><circle cx="9.5" cy="16" r="1.1" fill="#c62828"/></svg>',
  cake: '<svg viewBox="0 0 24 24"><rect x="4" y="12" width="16" height="8" rx="1.4" fill="#f06292"/><rect x="4" y="12" width="16" height="3" fill="#fff176"/><rect x="11" y="4" width="2" height="6" rx="1" fill="#a1887f"/><path d="M12 3.5c-1 1-1 1.8 0 2.8 1-1 1-1.8 0-2.8z" fill="#ffb300"/></svg>',
  bike: '<svg viewBox="0 0 24 24"><circle cx="6" cy="17" r="4" fill="none" stroke="#5c6bc0" stroke-width="1.8"/><circle cx="18" cy="17" r="4" fill="none" stroke="#5c6bc0" stroke-width="1.8"/><path d="M6 17l4.5-8h4l3.5 8M10.5 9H8.5M14.5 9l2 4" fill="none" stroke="#3949ab" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="14.5" cy="9" r="1.3" fill="#3949ab"/></svg>',
  plane: '<svg viewBox="0 0 24 24"><path d="M3 12 20.5 4 13 20l-2-6.5z" fill="#4fc3f7"/><path d="M11 13.5 3 12l8-3z" fill="#0288d1"/></svg>',
  train: '<svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="12" rx="3" fill="#5c6bc0"/><rect x="6.5" y="6" width="4.5" height="4" rx=".6" fill="#e8eaf6"/><rect x="13" y="6" width="4.5" height="4" rx=".6" fill="#e8eaf6"/><circle cx="8" cy="19" r="1.6" fill="#37474f"/><circle cx="16" cy="19" r="1.6" fill="#37474f"/><path d="M6 16l-2 3M18 16l2 3" stroke="#5c6bc0" stroke-width="1.4" stroke-linecap="round"/></svg>',
  paintbrush: '<svg viewBox="0 0 24 24"><path d="M15.5 3.5 20.5 8.5 11 18l-6 1.5L6.5 13.5z" fill="#ba68c8"/><path d="M6.5 13.5 4 21l7.5-2.5z" fill="#8e24aa"/></svg>',
  football: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="#f5f5f5" stroke="#263238" stroke-width="1"/><path d="M12 8.3 15 10.5l-1.1 3.6H10.1L9 10.5z" fill="#263238"/></svg>',
  bed: '<svg viewBox="0 0 24 24"><rect x="2.5" y="11" width="19" height="7" rx="1.4" fill="#8d6e63"/><rect x="3.5" y="8" width="7.5" height="4.5" rx="1" fill="#ffb74d"/><rect x="12" y="8" width="8.5" height="4.5" rx="1" fill="#4fc3f7"/><path d="M3 18v2.5M21 18v2.5" stroke="#5d4037" stroke-width="1.6" stroke-linecap="round"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="4.3" fill="none" stroke="#ffb300" stroke-width="2"/><path d="M11 11 20 20M16.5 15.5l2-2M19 18l2-2" stroke="#ffb300" stroke-width="2" stroke-linecap="round"/></svg>',
  umbrella: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 18 0z" fill="#e57373"/><rect x="11.2" y="12" width="1.6" height="8.5" rx=".8" fill="#5d4037"/><path d="M12.8 20c0 1-.8 1.5-1.8 1.5" fill="none" stroke="#5d4037" stroke-width="1.4" stroke-linecap="round"/><circle cx="12" cy="12" r="1" fill="#5d4037"/></svg>',
  alarm: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7.5" fill="#4fc3f7"/><path d="M12 8.5V13l3 2" stroke="#01579b" stroke-width="1.4" stroke-linecap="round" fill="none"/><path d="M5 4l-2.5 3M19 4l2.5 3" stroke="#0288d1" stroke-width="1.6" stroke-linecap="round"/><rect x="9.5" y="2.5" width="5" height="1.8" rx=".9" fill="#0288d1"/></svg>',
  target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#ef5350"/><circle cx="12" cy="12" r="6" fill="#fff"/><circle cx="12" cy="12" r="3" fill="#ef5350"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M6.5 17.5a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.7-1.7A4.3 4.3 0 0 1 17.5 17.5z" fill="#90a4ae"/></svg>',
  scissors: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.4" fill="none" stroke="#78909c" stroke-width="1.6"/><circle cx="6" cy="18" r="2.4" fill="none" stroke="#78909c" stroke-width="1.6"/><path d="M7.8 7.6 20 18M7.8 16.4 20 6" stroke="#78909c" stroke-width="1.6" stroke-linecap="round"/></svg>',
  magnifier: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="#42a5f5" stroke-width="2"/><path d="M15.2 15.2 21 21" stroke="#42a5f5" stroke-width="2.2" stroke-linecap="round"/></svg>',
  gem: '<svg viewBox="0 0 24 24"><path d="M12 3 4 9l8 12 8-12z" fill="#4dd0e1"/><path d="M4 9h16M8 9 12 3l4 6M8 9l4 12M16 9l-4 12" fill="none" stroke="#00acc1" stroke-width=".8"/></svg>',
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

/* Échéance ponctuelle ou plage (« période » cochée dans le sélecteur). Une
   plage tenant sur la même journée n'affiche que l'heure de fin — répéter
   la date n'apporte rien et allonge inutilement les étiquettes de carte. */
function formatDueRange(isoStart, isoEnd) {
  if (!isoStart) return '';
  const debut = formatDue(isoStart);
  if (!isoEnd) return debut;
  const d1 = new Date(isoStart);
  const d2 = new Date(isoEnd);
  if (Number.isNaN(d2.getTime()) || d2 <= d1) return debut;
  if (d1.toDateString() === d2.toDateString()) {
    return `${debut} → ${d2.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return `${debut} → ${formatDue(isoEnd)}`;
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

/* `onChange` reçoit (isoDebut, isoFin) — isoFin vaut null tant que la case
   « période » n'est pas cochée. `currentEndIso` permet de rouvrir le popup
   sur une plage déjà enregistrée. Une plage se traduit par un événement
   Google couvrant réellement l'intervalle, au lieu des 30 minutes par
   défaut (voir DEFAULT_DURATION dans app/google_calendar.py). */
function openCalPopup(anchor, currentIso, onChange, currentEndIso = null) {
  closeCalPopup();

  const parts = isoToParts(currentIso) || nextQuarterHourParts();
  const hourOpts = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  const minOpts = ['00', '15', '30', '45'];
  // Fin par défaut : même jour, une heure après le début — proposition
  // plausible pour qui coche « période » sans vouloir tout ressaisir.
  const endParts = isoToParts(currentEndIso) || {
    date: parts.date,
    hour: String((Number(parts.hour) + 1) % 24).padStart(2, '0'),
    minute: parts.minute,
  };

  const pop = document.createElement('div');
  pop.className = 'cal-popup';
  const champsHeure = (classe) => `
      <select class="cal-popup-hour ${classe}-hour">${hourOpts.map((h) => `<option value="${h}">${h}</option>`).join('')}</select>
      <span class="cal-popup-colon">:</span>
      <select class="cal-popup-min ${classe}-min">${minOpts.map((m) => `<option value="${m}">${m}</option>`).join('')}</select>`;
  pop.innerHTML = `
    <div class="cal-popup-row">
      <input type="date" class="cal-popup-date">
      ${champsHeure('cal-popup-start')}
    </div>
    <label class="cal-popup-periode">
      <input type="checkbox" class="cal-popup-toggle">
      <span>Période (date de fin)</span>
    </label>
    <div class="cal-popup-row cal-popup-row-end" hidden>
      <input type="date" class="cal-popup-date-end">
      ${champsHeure('cal-popup-end')}
    </div>
    <p class="cal-popup-erreur" hidden>La fin doit être après le début.</p>
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
  const hourSelect = pop.querySelector('.cal-popup-start-hour');
  const minSelect = pop.querySelector('.cal-popup-start-min');
  dateInput.value = parts.date;
  hourSelect.value = parts.hour;
  minSelect.value = parts.minute;

  const toggle = pop.querySelector('.cal-popup-toggle');
  const rowEnd = pop.querySelector('.cal-popup-row-end');
  const dateEnd = pop.querySelector('.cal-popup-date-end');
  const hourEnd = pop.querySelector('.cal-popup-end-hour');
  const minEnd = pop.querySelector('.cal-popup-end-min');
  const erreur = pop.querySelector('.cal-popup-erreur');
  dateEnd.value = endParts.date;
  hourEnd.value = endParts.hour;
  minEnd.value = endParts.minute;
  toggle.checked = !!currentEndIso;
  rowEnd.hidden = !toggle.checked;
  toggle.onchange = () => {
    rowEnd.hidden = !toggle.checked;
    if (!toggle.checked) erreur.hidden = true;
  };

  // Largeur mesurée plutôt que codée en dur : les 250/260px d'origine
  // étaient devenus faux en élargissant le popup (champ date tronqué), et
  // le popup débordait alors du bord droit. offsetWidth est disponible dès
  // l'insertion dans le document, juste au-dessus.
  const largeur = pop.offsetWidth;
  const marge = 8;
  if (hostDialog) {
    const dialogRect = hostDialog.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const top = anchorRect.bottom - dialogRect.top + 6;
    let left = anchorRect.left - dialogRect.left;
    left = Math.min(left, dialogRect.width - largeur - marge);
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(marge, left)}px`;
  } else {
    const rect = anchor.getBoundingClientRect();
    const top = rect.bottom + window.scrollY + 6;
    let left = rect.left + window.scrollX;
    left = Math.min(left, window.scrollX + document.documentElement.clientWidth - largeur - marge);
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(marge, left)}px`;
  }

  const currentValue = () => partsToIso(dateInput.value, hourSelect.value, minSelect.value);
  const currentEndValue = () =>
    (toggle.checked ? partsToIso(dateEnd.value, hourEnd.value, minEnd.value) : null);

  // Une fin antérieure ou égale au début serait refusée par Google (400) et
  // ferait échouer la synchro en silence : on la bloque ici, à la source.
  const finEstValide = () => {
    const debut = currentValue();
    const fin = currentEndValue();
    return !fin || !debut || new Date(fin) > new Date(debut);
  };

  const finish = (iso, endIso) => { onChange(iso, endIso); closeCalPopup(); };
  const valider = () => {
    if (!finEstValide()) { erreur.hidden = false; return false; }
    finish(currentValue(), currentEndValue());
    return true;
  };
  pop.querySelector('[data-act=ok]').onclick = valider;
  pop.querySelector('[data-act=clear]').onclick = () => finish(null, null);

  // Comme les autres popovers de l'app : toute façon de le quitter applique
  // la valeur en cours (pas seulement le bouton Valider) — sans quoi choisir
  // une date puis cliquer ailleurs (geste naturel) perdait silencieusement
  // le choix.
  // Une plage incohérente ne doit pas non plus être validée par une sortie
  // « douce » (clic ailleurs / Échap) : dans ce cas on ferme en ignorant la
  // fin plutôt qu'en enregistrant une plage que Google refuserait.
  const sortieDouce = () => finish(currentValue(), finEstValide() ? currentEndValue() : null);
  const onOutside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) sortieDouce(); };
  const onKey = (e) => { if (e.key === 'Escape') sortieDouce(); };
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

/* Vrai si le clic qu'on vient de recevoir termine une sélection de texte
   faite dans `el`. Un glisser pour sélectionner se termine par un
   "click" tout à fait normal : sans ce garde-fou, relâcher la souris après
   avoir surligné du texte ouvre la notask et fait perdre la sélection —
   impossible de copier quoi que ce soit. */
function clicTermineUneSelection(el) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return false;
  // La sélection doit bien appartenir à cet élément : une sélection
  // laissée ailleurs sur la page ne doit pas bloquer l'ouverture.
  const noeud = sel.anchorNode;
  return !!noeud && el.contains(noeud.nodeType === 1 ? noeud : noeud.parentNode);
}

/* --------------------- Copie par clic droit + bulle ---------------------
   Clic droit sur une sélection : copie immédiate, sans menu contextuel ni
   sous-menu, avec une petite bulle éphémère de confirmation. */
function afficherBulleCopie(x, y, texte) {
  const bulle = document.createElement('div');
  bulle.className = 'copy-bubble';
  bulle.textContent = texte;

  /* Même piège que le nuancier de couleurs : une <dialog> modale rend le
     reste du document inerte et le masque derrière son voile sombre. Une
     bulle ajoutée à document.body était donc invisible dès qu'on copiait
     depuis l'édition rapide ou l'éditeur d'image. On la place dans la
     boîte ouverte la plus haute quand il y en a une.
     Positionnement en `absolute` relatif à cette boîte, et non `fixed` :
     un ancêtre animé/transformé redéfinit le repère du positionnement
     fixe, les coordonnées écran ne seraient plus fiables. */
  const boites = [...document.querySelectorAll('dialog[open]')];
  const hote = boites.length ? boites[boites.length - 1] : document.body;

  if (hote !== document.body) {
    const r = hote.getBoundingClientRect();
    bulle.style.position = 'absolute';
    bulle.style.left = `${x - r.left}px`;
    bulle.style.top = `${y - r.top}px`;
  } else {
    bulle.style.left = `${x}px`;
    bulle.style.top = `${y}px`;
  }

  hote.appendChild(bulle);
  setTimeout(() => bulle.remove(), 1400);
}

/* Copie la sélection en conservant sa mise en forme (gras, couleur, code,
   zone d'archive…), pas seulement le texte brut — sinon coller ailleurs
   (Word, Gmail, Slack…) perdait toute la mise en forme, même quand la
   notask en avait. Le presse-papier reçoit les DEUX représentations
   (text/html ET text/plain) via ClipboardItem : chaque appli cible choisit
   celle qu'elle sait interpréter, avec le texte brut en repli sinon —
   writeText() seul ne peut écrire qu'un type à la fois, d'où le passage à
   l'API plus verbeuse ClipboardItem. */
async function copierSelectionRiche(sel) {
  const texte = sel.toString();
  if (!sel.rangeCount || typeof ClipboardItem === 'undefined') {
    return navigator.clipboard.writeText(texte);
  }
  try {
    const conteneur = document.createElement('div');
    conteneur.appendChild(sel.getRangeAt(0).cloneContents());
    // Nettoie ce qui n'a de sens que DANS l'app : l'icône décorative de la
    // zone d'archive et la pastille de copie des blocs de code ne sont que
    // des SVG orphelins une fois collés ailleurs.
    conteneur.querySelectorAll('.archive-icon-mark, .code-copy-btn').forEach((n) => n.remove());
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([texte], { type: 'text/plain' }),
      'text/html': new Blob([conteneur.innerHTML], { type: 'text/html' }),
    })]);
  } catch {
    // Construction du HTML ou permission refusée : mieux vaut une copie en
    // texte brut qu'aucune copie.
    await navigator.clipboard.writeText(texte);
  }
}

document.addEventListener('contextmenu', async (e) => {
  // Le menu latéral garde son propre raccourci au clic droit (suppression
  // d'un libellé) : on ne le lui prend pas.
  if (e.target.closest('.drawer')) return;

  const sel = window.getSelection();
  const texte = sel ? sel.toString() : '';
  if (!texte.trim()) return;   // pas de sélection : menu contextuel normal

  e.preventDefault();
  try {
    await copierSelectionRiche(sel);
    afficherBulleCopie(e.clientX, e.clientY, 'Copié');
  } catch {
    // Refus du navigateur (page non sécurisée, permission) : on le dit,
    // plutôt que de laisser croire que la copie a eu lieu.
    afficherBulleCopie(e.clientX, e.clientY, 'Copie impossible');
  }
});

/* ------------------ Animation d'ouverture des dialogues ------------------
   La boîte grandit depuis le point cliqué, avec un rebond de matière
   souple (élastique/gélatine) : elle dépasse légèrement sa taille finale
   puis se stabilise en alternant étirement horizontal et vertical.

   L'origine du geste est relevée sur le dernier pointerdown de la page, en
   phase de capture : ça couvre d'un coup tous les points d'entrée (carte
   de la mosaïque, carte de tâche, colonne d'échéances, résultat de
   recherche) sans avoir à passer l'événement de main en main. */
let dernierPointDeClic = null;
document.addEventListener('pointerdown', (e) => {
  dernierPointDeClic = { x: e.clientX, y: e.clientY };
}, true);

/* --------------------- Retour mobile (bouton/geste "précédent") ---------------------
   Sans ceci, le retour matériel (Android) ou le geste (iOS/Android) quitte
   carrément le site pendant qu'une notask/l'éditeur d'image est ouvert(e),
   au lieu de la refermer et de revenir à l'endroit où on en était — parce
   qu'aux yeux du navigateur, ouvrir une <dialog> n'est pas une "navigation"
   qu'il pourrait défaire tout seul. On lui en fournit une : une entrée
   d'historique est ajoutée à l'ouverture d'une boîte suivie (voir chaque
   showModal() plus bas), que le retour peut alors défaire normalement —
   popstate referme la boîte (en enregistrant si la fermeture le prévoit,
   exactement comme un clic en dehors de la boîte) au lieu de laisser le
   navigateur changer de page. Une seule boîte suivie à la fois : ces
   boîtes ne s'imbriquent jamais dans cette app. */
let dlgOuverteParHistorique = null; // { dlg, fermer() }

function suivreAvecHistorique(dlg, fermer) {
  history.pushState({ notaskDlgOpen: true }, '', location.href);
  dlgOuverteParHistorique = { dlg, fermer };
}

// Appelée par CHAQUE fermeture normale (bouton, clic sur le fond, Échap) —
// retire l'entrée d'historique posée à l'ouverture avec un history.back(),
// pour ne pas en empiler une à chaque ouverture/fermeture (il aurait sinon
// fallu appuyer plusieurs fois de suite sur retour pour vraiment quitter
// l'app). Sans effet si la boîte n'a pas été suivie, ou si son entrée vient
// justement d'être consommée par le retour lui-même (voir popstate
// ci-dessous, qui remet dlgOuverteParHistorique à null AVANT de fermer —
// c'est ce qui rend cet appel-ci idempotent dans ce cas précis).
function oublierHistoriqueSiPresent(dlg) {
  if (dlgOuverteParHistorique && dlgOuverteParHistorique.dlg === dlg) {
    dlgOuverteParHistorique = null;
    history.back();
  }
}

/* --------------------- Fond figé pendant qu'une boîte est ouverte ---------------------
   Sur mobile, un défilement au doigt démarré à l'intérieur d'une <dialog>
   modale peut quand même faire bouger la mosaïque DERRIÈRE elle, visible en
   transparence sous la boîte — le "top layer" d'une dialog modale bloque
   les clics sur le fond mais pas forcément le geste de défilement tactile
   lui-même sur tous les navigateurs. Verrouillé ici via position:fixed sur
   <body> (plus fiable que overflow:hidden seul, insuffisant sur iOS
   Safari), en conservant la position de défilement pour la restaurer telle
   quelle à la fermeture — sans ça, la page "sauterait" en haut à chaque
   ouverture/fermeture de boîte.

   Détection par MutationObserver sur l'attribut "open" (posé/retiré par
   showModal()/close(), quelle que soit la <dialog>) plutôt qu'en appelant
   verrouiller/déverrouiller à la main à chaque site d'ouverture : une
   dialog de plus dans l'app en bénéficie automatiquement, sans rien
   ajouter ici. Compteur plutôt qu'un simple booléen : gère le cas — réel
   dans cette app — d'une boîte qui en ouvre une autre par-dessus (le
   changement de mot de passe depuis Profil, par exemple) sans déverrouiller
   trop tôt pendant que la première est encore là derrière. */
let dialoguesOuvertsCompte = 0;
let scrollAvantVerrouillage = 0;

function verrouillerDefilementFond() {
  dialoguesOuvertsCompte++;
  if (dialoguesOuvertsCompte > 1) return;
  scrollAvantVerrouillage = window.scrollY;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${scrollAvantVerrouillage}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
}

function deverrouillerDefilementFond() {
  dialoguesOuvertsCompte = Math.max(0, dialoguesOuvertsCompte - 1);
  if (dialoguesOuvertsCompte > 0) return;
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  window.scrollTo(0, scrollAvantVerrouillage);
}

new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.attributeName !== 'open') continue;
    const dlg = m.target;
    if (dlg.hasAttribute('open')) verrouillerDefilementFond();
    else deverrouillerDefilementFond();
  }
}).observe(document.body, { attributes: true, attributeFilter: ['open'], subtree: true });

// Le menu mobile (voir ouvrirMenuMobile()/fermerMenuMobile() plus bas) est
// une <aside> superposée, pas une <dialog> — pas suivie par le
// MutationObserver ci-dessus, mais exposée au même risque (défiler la
// mosaïque en dessous en touchant à travers le fond assombri). Même
// mécanisme de verrouillage, appelé directement puisqu'il n'y a que ces
// deux points d'entrée (pas besoin d'un observer dédié pour un seul cas).

window.addEventListener('popstate', () => {
  if (!dlgOuverteParHistorique) return;
  const { dlg, fermer } = dlgOuverteParHistorique;
  dlgOuverteParHistorique = null;
  if (dlg.open) fermer();
});

/* Fermeture animée : la boîte se rétracte vers le point d'où elle est
   sortie (transform-origin posée à l'ouverture, conservée telle quelle),
   nettement plus vite qu'à l'ouverture — on veut relire la note, pas
   admirer sa sortie.
   Le `close()` réel n'a lieu qu'à la fin : l'événement "close" du <dialog>
   se déclenche APRÈS la disparition, il est donc trop tard pour animer
   quoi que ce soit depuis là. Repli sur minuterie si l'animation ne se
   déclenche pas du tout (onglet en arrière-plan, animations désactivées) :
   sans lui, la boîte ne se fermerait jamais. */
function fermerAvecAnimation(dlg) {
  if (!dlg.open || dlg.dataset.fermeture === '1') return;
  oublierHistoriqueSiPresent(dlg);
  dlg.dataset.fermeture = '1';
  dlg.classList.remove('dlg-open-anim');
  dlg.classList.add('dlg-close-anim');

  const terminer = (e) => {
    // animationend remonte depuis les enfants : la bulle "Copié", elle
    // aussi animée et désormais placée DANS la boîte, fermerait sinon la
    // note en plein milieu. On n'accepte que l'animation de la boîte.
    if (e && e.target !== dlg) return;
    if (dlg.dataset.fermeture !== '1') return;
    delete dlg.dataset.fermeture;
    dlg.removeEventListener('animationend', terminer);
    dlg.classList.remove('dlg-close-anim');
    dlg.close();
  };
  dlg.addEventListener('animationend', terminer);
  setTimeout(() => terminer(null), 500);
}

/* Recentre horizontalement une boîte sur la mosaïque (#notes-grid) plutôt
   que sur le viewport entier — le centrage natif d'un <dialog> (showModal())
   se fait par rapport à TOUT le viewport, or le menu latéral fixe (278px,
   voir .drawer) décale visuellement le centre réel de la mosaïque vers la
   droite : une boîte centrée "à la native" déborde alors trop à gauche
   (par-dessus le menu/sa marge) et n'atteint pas la marge de droite,
   exactement le défaut signalé. Corrigé en mesurant la position RÉELLE de
   #notes-grid (ça marche donc aussi bien avec ou sans colonne d'échéances à
   droite, sans avoir à recalculer la largeur du menu à la main) et en
   appliquant l'écart via la propriété `translate` — PAS `transform` : les
   animations d'ouverture/fermeture (dlg-gelatine/-out) animent déjà
   `transform` (scale), et `translate`/`scale` sont des propriétés CSS
   distinctes qui se composent automatiquement sans se marcher dessus
   (contrairement à deux valeurs dans `transform`, où la dernière écraserait
   l'autre) — voir la spec CSS Transforms niveau 2, `translate` et `rotate`
   s'appliquent avant `transform` sur l'élément.
   Ignoré sous 861px : la boîte y passe en plein écran (voir la media query
   dans style.css), un décalage n'y aurait aucun sens et casserait l'ajustage. */
function recentrerDialogueSurMosaique(dlg) {
  if (window.matchMedia('(max-width: 860px)').matches) {
    dlg.style.translate = '';
    return;
  }
  const grid = $('#notes-grid');
  if (!grid) { dlg.style.translate = ''; return; }
  const gridRect = grid.getBoundingClientRect();
  const dlgRect = dlg.getBoundingClientRect();
  if (!gridRect.width || !dlgRect.width) { dlg.style.translate = ''; return; }
  const centreCible = gridRect.left + gridRect.width / 2;
  const centreActuel = dlgRect.left + dlgRect.width / 2;
  dlg.style.translate = Math.round(centreCible - centreActuel) + 'px 0px';
}

function animerOuvertureDialogue(dlg) {
  const r = dlg.getBoundingClientRect();
  // transform-origin exprimée dans le repère de la boîte : le point cliqué
  // tombe souvent en dehors d'elle, ce qui est parfaitement admis et donne
  // justement l'impression que la boîte "sort" de la carte.
  dlg.style.transformOrigin = dernierPointDeClic
    ? `${dernierPointDeClic.x - r.left}px ${dernierPointDeClic.y - r.top}px`
    : '50% 50%';

  // Retirer/relire/remettre : sans la lecture intermédiaire (qui force le
  // recalcul de style), le navigateur regroupe les deux changements de
  // classe et l'animation ne repart pas à la deuxième ouverture.
  dlg.classList.remove('dlg-open-anim');
  void dlg.offsetWidth;
  dlg.classList.add('dlg-open-anim');
}

/* --------------------------- Menu mobile (< 860px) ---------------------------
   Le menu latéral (.drawer) est toujours affiché sur desktop, mais devient
   un panneau replié sous 860px (voir style.css), ouvert par le bouton
   hamburger (#mobile-menu-btn dans index.html). Même mécanique d'ouverture
   que les notes — animerOuvertureDialogue() ci-dessus, réutilisée telle
   quelle — mais la fermeture ne peut pas réutiliser fermerAvecAnimation() :
   celle-ci appelle dlg.close(), une méthode propre à <dialog>, et .drawer
   reste un <aside> tout à fait normal (il doit pouvoir continuer à
   participer à la grille sur desktop, ce qu'un <dialog> ne permettrait pas
   facilement). D'où cette petite paire dédiée, qui reprend sinon exactement
   la même logique (classes dlg-open-anim/dlg-close-anim, minuterie de
   secours si l'animation ne se déclenche pas). */
function ouvrirMenuMobile() {
  const drawer = $('.drawer');
  $('#drawer-backdrop').hidden = false;
  drawer.classList.add('mobile-open');
  animerOuvertureDialogue(drawer);
  verrouillerDefilementFond();
}

function fermerMenuMobile() {
  const drawer = $('.drawer');
  if (!drawer.classList.contains('mobile-open') || drawer.dataset.fermeture === '1') return;
  deverrouillerDefilementFond();
  drawer.dataset.fermeture = '1';
  drawer.classList.remove('dlg-open-anim');
  drawer.classList.add('dlg-close-anim');

  const terminer = (e) => {
    if (e && e.target !== drawer) return;
    if (drawer.dataset.fermeture !== '1') return;
    delete drawer.dataset.fermeture;
    drawer.removeEventListener('animationend', terminer);
    drawer.classList.remove('dlg-close-anim', 'mobile-open');
    $('#drawer-backdrop').hidden = true;
  };
  drawer.addEventListener('animationend', terminer);
  setTimeout(() => terminer(null), 500);
}

$('#mobile-menu-btn').addEventListener('click', () => {
  $('.drawer').classList.contains('mobile-open') ? fermerMenuMobile() : ouvrirMenuMobile();
});
// Fond assombri : le cliquer referme, comme le clic sur le fond d'une
// boîte de dialogue ailleurs dans l'app.
$('#drawer-backdrop').addEventListener('click', fermerMenuMobile);
// Sans conséquence si le menu n'est pas ouvert (fermerMenuMobile() ne fait
// alors rien) : une seule écoute globale, pas besoin de savoir ici si une
// autre boîte doit aussi réagir à Échap, chacune gère la sienne séparément.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermerMenuMobile(); });

/* Palette de couleurs, unique et partagée : couleur de note (carte, boîte
   d'édition, composeur) ET couleur de texte utilisent exactement le même
   nuancier et le même code. Les pastilles portent les classes .c-*, donc
   toute teinte ajoutée à COLORS apparaît partout d'un coup.
   `onPick` reçoit le NOM de la couleur ('red', 'default'…) ; à l'appelant
   de le traduire en ce dont il a besoin (classe pour une note, hexadécimal
   via LABEL_COLOR_HEX pour du texte).
   preventDefault sur mousedown : indispensable quand la palette sert à
   colorer du texte, sinon le focus quitte la zone d'édition et la
   sélection disparaît avant le clic. */
function construirePalette(box, actif, onPick) {
  box.innerHTML = '';
  for (const c of COLORS) {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'swatch c-' + c + (c === actif ? ' active' : '');
    s.title = c;
    s.addEventListener('mousedown', (e) => e.preventDefault());
    s.onclick = (e) => {
      e.stopPropagation();
      box.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
      s.classList.add('active');
      onPick(c);
    };
    box.appendChild(s);
  }
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

  // Le jeton de connexion ET la clé de chiffrement des notes survivent
  // maintenant tous les deux à un redémarrage (localStorage, voir le
  // commentaire d'architecture en tête de fichier) — restoreCachedKey()
  // échoue quand même s'il n'y a vraiment rien en cache (première visite,
  // ou après une déconnexion explicite) : on redemande alors le mot de
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

/* Pseudo en lettres alternées : une sur deux en jaune cuillère, l'autre en
   bleu cuillère — les deux teintes du logo. Construit lettre par lettre en
   textContent (jamais en innerHTML) : un pseudo est une donnée saisie par
   l'utilisateur, elle n'a rien à faire dans du HTML interprété. */
function renderWho(nom) {
  const box = $('#who');
  box.innerHTML = '';
  [...(nom || '')].forEach((lettre, i) => {
    const s = document.createElement('span');
    s.className = i % 2 === 0 ? 'who-jaune' : 'who-bleu';
    s.textContent = lettre;
    box.appendChild(s);
  });
}

/* Lien profond ?notask=<id> — utilisé par le lien « Ouvrir dans notask »
   placé dans la description des événements Google Calendar (voir
   _event_body dans app/google_calendar.py). L'ouverture elle-même a lieu à
   la fin de loadNotes() (voir ouvrirNotaskDemandeeParUrl) et pas ici : la
   notask doit d'abord être chargée ET déchiffrée. Déclaré au-dessus
   d'enterApp(), qui l'affecte, pour éviter toute zone morte temporelle. */
let notaskDemandeeParUrl = null;

function enterApp() {
  show('screen-app');
  renderWho(state.user.username);
  $('#tab-admin').hidden = !state.user.is_admin;
  $('#admin-sep').hidden = !state.user.is_admin;

  // Icônes du menu latéral et logo
  $('#brand-logo').innerHTML = ICONS.spoon + ICONS.spoonBlue;
  // Survoler le logo affiche la version chargée — pas besoin d'ouvrir la
  // console pour vérifier si un déploiement a bien pris effet (voir
  // BUILD_VERSION en haut du fichier).
  $('#brand-logo').title = 'build ' + BUILD_VERSION;
  $('#nav-notes').innerHTML = ICONS.spoon + '<span class="label">notasks</span>';
  // Entrée unique pour les notasks datées, juste sous "Notasks" : les
  // anciennes entrées par échéance (En retard / Aujourd'hui / À venir) ont
  // été retirées du menu, la vue les regroupe déjà avec des en-têtes de
  // couleur. Le compteur reste celui du total.
  $('#nav-tasks').innerHTML = ICONS.spoonBlue + '<span class="label">notasks prévues</span><span class="nav-count" id="count-tasks" hidden></span>';
  $('#nav-favorites').innerHTML = ICONS.pinFilled + '<span class="label">favoris</span>';
  $('#nav-archives').innerHTML = ICONS.archive + '<span class="label">archives</span>';
  $('#nav-trash').innerHTML = ICONS.trash + '<span class="label">corbeille</span>';
  $('#tab-admin').innerHTML = ICONS.users + '<span class="label">comptes</span>';

  // Lien profond venant d'un événement Google Calendar (?notask=<id>). Lu
  // AVANT switchView() — qui déclenche loadNotes(), lequel consomme ce
  // drapeau une fois les notasks déchiffrées (voir
  // ouvrirNotaskDemandeeParUrl).
  const notaskParam = new URLSearchParams(location.search).get('notask');
  if (notaskParam && /^\d+$/.test(notaskParam)) notaskDemandeeParUrl = Number(notaskParam);

  loadLabels();
  switchView('notes');
  if (state.user.must_change_password) {
    $('#dlg-password').showModal();
    msg($('#dp-msg'), 'Votre mot de passe a été défini par un administrateur. Choisissez-en un nouveau.', 'ok');
  }

  // Retour du flux de connexion Google Calendar (voir /api/google/callback
  // côté serveur, qui redirige ici avec ?google=connected ou ?google=error
  // après l'échange OAuth). On nettoie l'URL pour ne pas rejouer ce message
  // à chaque rechargement, puis on ouvre directement le Profil.
  const googleParam = new URLSearchParams(location.search).get('google');
  if (googleParam) {
    history.replaceState(null, '', location.pathname);
    $('#btn-profil').click();
    msg(
      $('#profil-google-msg'),
      googleParam === 'connected' ? 'Compte Google connecté.' : 'Échec de la connexion à Google, réessayez.',
      googleParam === 'connected' ? 'ok' : 'error'
    );
  }

  // Page fantôme (/quick, voir quick.html) : composeur déjà déplié et
  // titre au focus, prêt à écrire dès l'ouverture — c'est tout son intérêt
  // (icône d'écran d'accueil dédiée à la prise de note rapide, voir
  // quick-manifest.json). Le drapeau NOTASK_QUICK_CAPTURE n'est posé QUE
  // dans quick.html (jamais dans index.html), en dur avant le chargement
  // de ce fichier — voir aussi le style .quick-capture dans style.css, qui
  // masque tout le reste, et la sortie en location.reload() dans le
  // gestionnaire #nc-add plus bas.
  if (window.NOTASK_QUICK_CAPTURE) {
    composerExpand();
    $('#nc-title').focus();
  }
}

function switchView(view) {
  // Un changement de vue referme le menu mobile s'il était ouvert (voir
  // ouvrirMenuMobile() plus haut) — rester dessus après avoir choisi une
  // destination n'aurait aucun sens, et il faudrait sinon un second geste
  // rien que pour le faire disparaître. Sans effet sur desktop (le menu ne
  // se replie jamais, la classe 'mobile-open' n'y est jamais posée).
  fermerMenuMobile();
  state.view = view;
  $$('.drawer-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  const isNotes = view === 'notes' || view === 'archives' || view === 'favorites';

  $('#view-notes').hidden = !isNotes;
  $('#view-tasks').hidden = view !== 'tasks';
  $('#view-trash').hidden = view !== 'trash';
  $('#view-admin').hidden = view !== 'admin';

  // Colonne d'échéances : seulement sur les vues Notes/Favoris/Archives, là
  // où la mosaïque a des marges à céder (voir .shell.has-agenda). Son
  // contenu se recharge à l'intérieur de loadNotes() ci-dessous, pas ici :
  // un seul point de rechargement, plutôt que de dupliquer l'appel à chaque
  // fois que l'un ou l'autre change (pin, archive, éditions...).
  $('.shell').classList.toggle('has-agenda', isNotes);
  $('#agenda-col').hidden = !isNotes;
  // Sous 860px, .shell.has-agenda devient un carrousel à deux volets
  // glissés au doigt (accueil, puis la page agenda à sa droite — voir
  // style.css). Sans ce recalage, revenir sur la vue Notes après être
  // passé par la page agenda puis être allé voir une autre vue (tâches,
  // corbeille…) rouvrirait directement sur la page agenda : le défilement
  // horizontal du conteneur reste où il était, la classe has-agenda est
  // juste retirée puis reposée. Sans effet sur desktop (le carrousel
  // n'existe pas, scrollLeft y vaut toujours 0).
  if (isNotes) $('.shell').scrollLeft = 0;

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
  if (view === 'tasks') loadTasks();
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

function seDeconnecter() { setToken(null); clearEncKey(); location.reload(); }

/* ------------------------------ Profil ------------------------------ */

$('#btn-profil').addEventListener('click', () => {
  const u = state.user || {};
  const lignes = [
    ['Nom d’utilisateur', u.username || '—'],
    ['Rôle', u.is_admin ? 'Administrateur' : 'Utilisateur'],
    ['Compte créé le', u.created_at ? formatDue(u.created_at) : '—'],
    ['Chiffrement des notasks', u.wrapped_dek ? 'Actif' : 'Non initialisé'],
  ];
  const box = $('#profil-infos');
  box.innerHTML = '';
  for (const [nom, valeur] of lignes) {
    const dt = document.createElement('dt');
    dt.textContent = nom;
    const dd = document.createElement('dd');
    dd.textContent = valeur;
    box.append(dt, dd);
  }
  $('#dlg-profil').showModal();
  animerOuvertureDialogue($('#dlg-profil'));
  // Identifiants OAuth de l'installation : réservés aux administrateurs
  // (le serveur les refuserait de toute façon à un compte non admin, mais
  // autant ne pas afficher des champs qui échoueraient systématiquement).
  // Les boutons Effacer/Enregistrer des identifiants d'installation vivent
  // désormais dans la rangée d'actions COMMUNE (hors de #admin-google, pour
  // qu'un non-admin garde le bouton Déconnecter) : ils doivent donc être
  // masqués séparément du bloc de champs.
  $('#admin-google').hidden = !state.user.is_admin;
  $('#ga-clear').hidden = !state.user.is_admin;
  $('#ga-save').hidden = !state.user.is_admin;
  if (state.user.is_admin) loadGoogleAdminConfig();
  refreshGoogleStatus();
});

/* -------------------- Connexion Google Calendar -------------------- */
// Voir /api/google/* côté serveur (app/routers/google.py) et le compromis
// de chiffrement expliqué dans app/google_calendar.py : seuls le titre en
// clair et la date des notasks DATÉES sont vus par le serveur pour cette
// fonctionnalité, tout le reste reste chiffré de bout en bout.

async function refreshGoogleStatus() {
  const dot = $('#profil-google-dot');
  const label = $('#profil-google-label');
  const btnConnect = $('#profil-google-connect');
  const btnDisconnect = $('#profil-google-disconnect');
  dot.className = 'profil-google-dot';
  label.textContent = 'Google Calendar : vérification…';
  btnConnect.hidden = true;
  btnDisconnect.hidden = true;
  try {
    const st = await api('/google/status');
    if (!st.connected) {
      label.textContent = 'Google Calendar : non connecté';
      btnConnect.hidden = false;
    } else if (st.needs_reauth) {
      dot.classList.add('needs-reauth');
      label.textContent = `Google Calendar : reconnexion nécessaire (${st.email || 'compte inconnu'})`;
      btnConnect.hidden = false;
      btnDisconnect.hidden = false;
    } else {
      dot.classList.add('connected');
      label.textContent = `Google Calendar : connecté (${st.email || 'compte Google'})`;
      btnDisconnect.hidden = false;
    }
    // Le choix de l'agenda n'a de sens qu'une fois le compte relié.
    $('#profil-google-cal').hidden = !st.connected;
    if (st.connected) chargerAgendasGoogle();
  } catch {
    label.textContent = 'Google Calendar : statut indisponible';
  }
}

// Remplit le sélecteur d'agenda de destination. Google refuse
// calendarList.list sans le scope calendar.readonly : un compte relié avant
// l'ajout de ce scope reçoit une erreur "scope", auquel cas on bascule sur
// la saisie manuelle de l'identifiant plutôt que de bloquer la
// fonctionnalité (l'écriture, elle, ne demande que calendar.events et
// fonctionne déjà dans n'importe quel agenda).
async function chargerAgendasGoogle() {
  const select = $('#profil-google-cal-select');
  const manuel = $('#profil-google-cal-manuel');
  const hint = $('#profil-google-cal-hint');
  select.innerHTML = '';
  hint.hidden = true;
  try {
    const data = await api('/google/calendars');
    if (data.error || !data.calendars.length) {
      select.hidden = true;
      manuel.hidden = false;
      manuel.value = data.current || '';
      hint.hidden = false;
      hint.textContent = data.error === 'scope'
        ? "Liste indisponible : reconnectez le compte pour autoriser la lecture des agendas. En attendant, collez l'identifiant de l'agenda (Google Agenda → Paramètres de l'agenda → Intégrer l'agenda → ID de l'agenda)."
        : "Liste des agendas indisponible pour le moment. Saisissez l'identifiant de l'agenda à la main.";
      return;
    }
    select.hidden = false;
    manuel.hidden = true;
    for (const cal of data.calendars) {
      const opt = document.createElement('option');
      opt.value = cal.id;
      opt.textContent = cal.primary ? `${cal.summary} (principal)` : cal.summary;
      if (cal.id === data.current) opt.selected = true;
      select.append(opt);
    }
  } catch {
    select.hidden = true;
    manuel.hidden = false;
    hint.hidden = false;
    hint.textContent = "Impossible de contacter le serveur pour lister les agendas.";
  }
}

$('#profil-google-cal-save').addEventListener('click', async () => {
  const select = $('#profil-google-cal-select');
  const manuel = $('#profil-google-cal-manuel');
  const calendarId = (manuel.hidden ? select.value : manuel.value).trim();
  if (!calendarId) {
    msg($('#profil-google-msg'), "Choisissez ou saisissez un agenda.", 'error');
    return;
  }
  const btn = $('#profil-google-cal-save');
  btn.disabled = true;
  // Le changement d'agenda déplace les événements existants côté serveur
  // (suppression dans l'ancien puis recréation dans le nouveau, voir
  // change_calendar) : ça peut prendre quelques secondes s'il y en a
  // beaucoup, d'où le retour visuel.
  msg($('#profil-google-msg'), "Déplacement des événements en cours…", 'ok');
  try {
    const r = await api('/google/calendar', {
      method: 'PUT',
      // api() sérialise elle-même le corps (voir plus haut) : passer un
      // objet, surtout pas une chaîne déjà sérialisée — sinon le serveur
      // reçoit une chaîne JSON au lieu d'un objet et rejette la requête.
      body: { calendar_id: calendarId },
    });
    let texte = `Agenda de destination enregistré. ${r.moved} événement(s) déplacé(s).`;
    if (r.orphans) texte += ` ${r.orphans} n'ont pas pu être supprimé(s) de l'ancien agenda, à retirer à la main.`;
    msg($('#profil-google-msg'), texte, 'ok');
  } catch {
    msg($('#profil-google-msg'), "Échec du changement d'agenda, réessayez.", 'error');
  }
  btn.disabled = false;
});

$('#profil-google-connect').addEventListener('click', () => {
  // Navigation complète (pas un fetch) : Google doit pouvoir rediriger le
  // navigateur en retour vers /api/google/callback. Le jeton n'est envoyé
  // qu'à notre propre serveur (voir commentaire en tête de routers/google.py) —
  // jamais à Google, qui ne reçoit qu'un état opaque à usage unique.
  location.href = '/api/google/connect?token=' + encodeURIComponent(token());
});

$('#profil-google-disconnect').addEventListener('click', async () => {
  $('#profil-google-disconnect').disabled = true;
  try {
    await api('/google/disconnect', { method: 'POST' });
    msg($('#profil-google-msg'), 'Compte Google déconnecté.', 'ok');
  } catch {
    msg($('#profil-google-msg'), 'Échec de la déconnexion, réessayez.', 'error');
  }
  $('#profil-google-disconnect').disabled = false;
  refreshGoogleStatus();
});
/* Clic sur le fond = fermeture, comme dans les boîtes de note : le bouton
   "Fermer" dédié n'apportait rien. Échap passe par le même chemin, pour
   garder l'animation de sortie. */
$('#dlg-profil').addEventListener('click', (e) => {
  if (e.target === $('#dlg-profil')) fermerAvecAnimation($('#dlg-profil'));
});
$('#dlg-profil').addEventListener('cancel', (e) => {
  e.preventDefault();
  fermerAvecAnimation($('#dlg-profil'));
});
$('#profil-logout').addEventListener('click', seDeconnecter);
$('#profil-password').addEventListener('click', () => {
  $('#dlg-profil').close();
  ouvrirChangementMotDePasse();
});
// Un libellé cliqué (bouton .label-item, sans [data-view] — donc pas visé
// par ce sélecteur, aucun double-déclenchement possible ici) gère lui-même
// state.labelFilter et son propre appel à switchView() le cas échéant (voir
// renderLabelsDrawer()). Les VRAIES entrées de menu (notasks, favoris,
// archives...) ci-dessous doivent en revanche effacer un filtre par
// libellé resté actif : sinon la liste reste filtrée sans indice visible,
// il fallait recliquer sur le libellé ou recharger la page pour s'en sortir.
$$('.drawer-item[data-view]').forEach((b) => b.addEventListener('click', () => {
  if (state.labelFilter) {
    state.labelFilter = null;
    renderLabelsDrawer();
  }
  switchView(b.dataset.view);
}));

// "Notasks Prévues" : pas de [data-view] (voir index.html), donc ignoré par
// la boucle générique ci-dessus — sans quoi il gagnerait aussi la classe
// .active en même temps que "Notasks" (même vue 'notes' derrière les deux),
// un double-surlignage trompeur. Sur demande explicite, plus de vue à part :
// ce bouton ramène juste à la vue Notes puis fait défiler jusqu'à la
// colonne d'échéances (à droite sur desktop, deuxième page du carrousel en
// mobile — voir .shell.has-agenda dans style.css). scrollWidth ne dépasse
// clientWidth qu'en mobile (le carrousel), donc ce scrollTo ne fait rien de
// visible sur desktop : la colonne y est déjà affichée en permanence.
$('#nav-tasks').addEventListener('click', () => {
  if (state.labelFilter) {
    state.labelFilter = null;
    renderLabelsDrawer();
  }
  // Deux comportements selon la largeur, à la demande : en mobile, pas la
  // place pour trois colonnes, on renvoie donc vers la colonne d'échéances
  // (deuxième volet du carrousel) ; sur desktop, on garde la vue à part en
  // trois colonnes. Même seuil que le carrousel dans style.css.
  if (window.matchMedia('(max-width: 860px)').matches) {
    switchView('notes');
    $('.shell').scrollTo({ left: $('.shell').scrollWidth, behavior: 'smooth' });
  } else {
    switchView('tasks');
  }
});

/* -------------------------------- Notes -------------------------------- */

/* Le paramètre "q" n'est plus envoyé au serveur : titre/description/contenu
   sont chiffrés de bout en bout, une recherche SQL sur le texte chiffré ne
   peut rien trouver. La recherche se fait donc ici, après déchiffrement. */
/* Formes textuelles d'une date sur lesquelles la recherche doit mordre.
   Trois écritures, parce qu'on ne peut pas deviner comment l'utilisateur
   tape sa date : l'affichage tel qu'il le voit (« 7 août 10:30 »,
   « demain 09:00 »), la forme numérique française (07/08/2026), et la forme
   ISO (2026-08-07) qui permet aussi de chercher un mois entier (« 2026-08 »).
   Recherche accent-insensible, sinon « aout » ne trouverait pas « août ». */
function dateSearchTerms(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (v) => String(v).padStart(2, '0');
  const jour = pad(d.getDate());
  const mois = pad(d.getMonth() + 1);
  const an = d.getFullYear();
  return [
    formatDue(iso),
    d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
    `${jour}/${mois}/${an}`,
    `${an}-${mois}-${jour}`,
  ].join(' ');
}

function sansAccents(s) {
  // \u0300-\u036f = signes diacritiques combinants isolés par NFD.
  // Écrits en échappements plutôt qu'en caractères bruts : illisibles
  // et fragiles au moindre passage dans un outil qui recode le fichier.
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function noteMatchesSearch(n, q) {
  const needle = sansAccents(q.toLowerCase());
  // Libellés : la note ne porte que des identifiants, les noms vivent dans
  // state.labels (déjà chargé — voir loadLabels()).
  const libelles = (n.label_ids || [])
    .map((id) => ((state.labels || []).find((l) => l.id === id) || {}).name || '')
    .join(' ');
  const dates = [
    dateSearchTerms(n.due_at),
    dateSearchTerms(n.due_end_at),
    ...(n.items || []).map((it) => dateSearchTerms(it.due_at)),
  ].join(' ');

  const foin = sansAccents([
    n.title || '',
    n.description || '',
    n.content || '',
    (n.items || []).map((it) => it.text || '').join(' '),
    libelles,
    dates,
  ].join(' ').toLowerCase());

  return foin.includes(needle);
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
  loadArchivedItems();
  if (!$('#agenda-col').hidden) loadAgenda();
  updateTaskBadges();
  ouvrirNotaskDemandeeParUrl();
}

/* Lignes à cocher archivées seules — affichées sous la mosaïque, dans les
   Archives uniquement (voir NoteItem.archived côté serveur). Présentées
   comme des lignes et non comme des cartes : la notask parente n'est pas
   archivée, seule cette ligne l'est. Cliquer dessus ouvre la notask
   complète qui la contient, comme partout ailleurs. */
async function loadArchivedItems() {
  const bloc = $('#archived-items');
  if (!state.showArchived) { bloc.hidden = true; return; }

  let items;
  try {
    items = await api('/notes/archived-items');
  } catch {
    bloc.hidden = true;
    return;
  }
  await Promise.all(items.map(async (it) => { it.text = await decryptField(it.text); }));

  bloc.hidden = items.length === 0;
  const liste = $('#archived-items-list');
  liste.innerHTML = '';
  for (const it of items) {
    // Adapté à la forme attendue par creerLigneAgenda (qui parle de tâches) :
    // une ligne archivée peut ne plus avoir d'échéance du tout.
    const ligne = creerLigneAgenda({
      kind: 'item', id: it.id, note_id: it.note_id, text: it.text,
      due_at: it.due_at, due_end_at: it.due_end_at, done: it.checked,
      color: it.color, icon: it.icon,
    }, () => loadNotes(), true, 'unarchive');
    liste.appendChild(ligne);
  }
}

async function ouvrirNotaskDemandeeParUrl() {
  if (notaskDemandeeParUrl === null) return;
  const id = notaskDemandeeParUrl;
  notaskDemandeeParUrl = null;
  history.replaceState(null, '', location.pathname);

  let note = state.notes.find((n) => n.id === id);
  if (!note) {
    // Absente de la vue courante : la notask peut être archivée (ou filtrée
    // par un libellé/une recherche). On va la rechercher explicitement
    // plutôt que de laisser le lien sans effet.
    try {
      const archivees = await api('/notes?' + new URLSearchParams({ archived: true }));
      await Promise.all(archivees.map(decryptNote));
      note = archivees.find((n) => n.id === id);
    } catch { /* réseau : on abandonne silencieusement, cf. ci-dessous */ }
  }
  // Introuvable (notask supprimée depuis, ou lien d'un autre compte) : on
  // laisse simplement l'application ouverte sur la liste. Pas de message
  // bloquant — il n'existe pas de bandeau global dans cette appli, et
  // fabriquer une alerte pour ce cas limite serait plus gênant qu'utile.
  if (note) openNoteSimpleDialog(note);
  else console.warn('[notask] lien ?notask=%s : notask introuvable', id);
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
    // Pas de troncature ici (un slice() par caractère risquerait de couper
    // un marqueur en plein milieu, ex. "[c:ffffff]" sans son "[/c]" — il
    // resterait alors affiché tel quel, en texte brut, faute de pouvoir
    // être reconnu) : .trash-card-snippet limite déjà l'affichage à 4
    // lignes en CSS (-webkit-line-clamp), inutile de le refaire ici.
    const snippet = n.is_checklist
      ? `${(n.items || []).length} élément${(n.items || []).length > 1 ? 's' : ''}`
      : renderFormatted(n.content || '');

    el.innerHTML = `
      <div class="trash-card-title-row">${icon}<h3>${escapeHtml(title)}</h3></div>
      ${n.description ? `<div class="description">${escapeHtml(n.description)}</div>` : ''}
      ${snippet ? `<div class="trash-card-snippet">${snippet}</div>` : ''}
      <div class="trash-card-meta">${daysLeftInTrash(n.trashed_at)} j avant suppression définitive</div>
      <div class="trash-card-actions">
        <button type="button" class="btn ghost sm" data-act="restore">${ICONS.undo} Restaurer</button>
        <button type="button" class="btn danger sm" data-act="purge">${ICONS.trash} Supprimer définitivement</button>
      </div>`;

    // Même traitement que sur une carte active (voir renderNotes()) :
    // renderFormatted() ci-dessus ne pose que des <img> sans src pour les
    // images insérées dans le texte (voir NOTE_IMG_MARK), à déchiffrer et
    // hydrater après coup.
    hydrateInlineImages(el, n);
    hydrateInlineAudio(el, n);
    ajouterBoutonsCopieCode(el);

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
  // La rangée de libellés du composeur est persistante : elle doit refléter
  // tout de suite un libellé créé/renommé/supprimé depuis le menu latéral.
  renderComposerLabelChips();
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
      // Voir enablePointerReorder() : un glisser qui vient de réordonner
      // cette ligne se termine par un "click" tout à fait normal — sans ce
      // garde-fou, relâcher le doigt/la souris après avoir réordonné le
      // libellé le filtrerait aussi, ce qui n'est pas le geste voulu.
      if (geleParGlisser(row)) return;
      state.labelFilter = state.labelFilter === l.id ? null : l.id;
      if (state.view !== 'notes' && state.view !== 'archives') switchView('notes');
      else { renderLabelsDrawer(); loadNotes(); fermerMenuMobile(); }
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
    box.appendChild(row);
  }
}

// Réordonnancement par glisser (souris, stylet ET tactile) — voir
// enablePointerReorder() plus bas, juste avant son autre utilisation sur
// la mosaïque de notes. Le crayon (édition) ne doit pas déclencher le
// geste, sous peine de gêner son propre clic.
enablePointerReorder($('#labels-list'), '.label-row', {
  excludeSelector: '.label-edit-btn',
  onDrop: commitLabelOrder,
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
  return !state.showArchived && !state.showFavoritesOnly && !state.search
    && !state.deepSearch && !state.labelFilter;
}

/* Vrai masonry (empilement par colonnes), en positionnement absolu — plus
   une grille CSS. Avec CSS Grid, chaque RANGÉE impose sa hauteur à partir de
   son occupant le plus haut : une notask courte à côté d'une notask très
   longue (beaucoup de blocs de code, par exemple) laissait un grand vide en
   dessous d'elle avant que la rangée suivante ne commence — exactement le
   défaut signalé. Ici, chaque carte est calée directement sous la carte la
   plus basse de SA colonne : le même espace vertical partout, sans jamais
   dépendre de la hauteur des voisines.

   Algorithme glouton classique (type Pinterest) : pour chaque carte, on
   calcule la hauteur atteinte dans chaque position de colonne(s) possible,
   et on choisit celle qui minimise cette hauteur. Le bloc composeur+
   recherche (.composer-stack) est toujours centré en haut, sur 2 colonnes —
   c'est le seul élément dont la position n'est PAS choisie par l'algorithme,
   pour rester au milieu quel que soit ce qui l'entoure ensuite. Les cartes
   de résultat de recherche en profondeur (.search-hit) sont larges de 2
   colonnes elles aussi, mais suivent l'algorithme glouton normal — plus
   besoin d'un mode séparé pour elles (voir l'ancienne branche
   state.deepSearch, disparue : le glouton gère déjà tout seul le fait
   qu'elles ne trouvent de la place qu'après le composeur). */
/* `instant` : coupe la transition left/top le temps de ce calcul — à passer
   après un rendu COMPLET de la grille (toutes les .note détruites et
   recréées, voir renderNotes()/renderSearchHits()). Sans ça : chaque carte,
   fraîche dans le DOM à sa position CSS par défaut (top:0, left:0, voir
   .notes-grid .note en CSS), se voit poser sa position finale par place()
   plus bas — mais la lecture de el.offsetHeight qu'il contient force un
   reflow synchrone à CHAQUE itération de la boucle, qui "fige" au passage
   la position par défaut des cartes pas encore traitées. Leur position
   finale, posée l'itération suivante, devient alors un vrai changement de
   style aux yeux du navigateur, et la transition s'anime — tout le tableau
   semblait "sauter" depuis le coin en haut à gauche à chaque fermeture de
   notask (l'affichage se reconstruit entièrement après coup). Un
   déplacement normal (glisser-déposer, redimensionnement, image tardive)
   n'est PAS concerné : ces cartes existent déjà à leur ancienne position
   réelle, la transition y est voulue. */
/* Recale automatiquement la mosaïque dès qu'une carte OU le bloc composeur
   change de HAUTEUR, quelle qu'en soit la cause. Alternative choisie après
   un bug concret : le composeur qui se déplie (barre d'outils révélée au
   premier clic, voir composerExpand()) chevauchait les cartes voisines au
   lieu de les repousser, parce qu'aucun appel à layoutMosaic() n'avait été
   prévu à CET endroit précis. Semer des appels ponctuels dans chaque
   fonction qui peut changer une hauteur (déplier le composeur, ajouter une
   pièce jointe, ouvrir la palette de couleur, ajouter un libellé, ajouter
   une ligne de liste à cocher, glisser la poignée de redimensionnement
   d'un textarea...) est voué à en oublier — exactement ce qui vient de se
   produire. Un seul point de vérité qui observe la géométrie réelle, et
   réagit à N'IMPORTE QUEL changement, connu ou pas encore pensé, est plus
   robuste.
   Ne réagit qu'à un changement de HAUTEUR (comparée à la dernière connue) :
   la LARGEUR, elle, est POSÉE par layoutMosaic() lui-même (voir place()) —
   y réagir aussi redéclencherait un recalcul à chaque recalcul. */
const _mosaicHeights = new WeakMap();
const mosaicResizeObserver = new ResizeObserver((entries) => {
  let changed = false;
  for (const entry of entries) {
    // borderBoxSize (padding + bordure incluses), pas contentRect (qui les
    // exclut) : place() met en cache offsetHeight, qui les inclut aussi —
    // comparer contentRect à ce cache les aurait rendus JAMAIS égaux, une
    // toute première observation semblant alors toujours être un
    // changement, et redéclenchant un recalcul en boucle douce et sans fin
    // (inoffensif visuellement, les positions ne bougent pas réellement une
    // fois stabilisées, mais un vrai gâchis de cycles pour rien).
    const box = entry.borderBoxSize && entry.borderBoxSize[0];
    const h = Math.round(box ? box.blockSize : entry.contentRect.height);
    if (_mosaicHeights.get(entry.target) !== h) { _mosaicHeights.set(entry.target, h); changed = true; }
  }
  if (changed) scheduleLayoutMosaic();
});

function layoutMosaic(instant) {
  const grid = $('#notes-grid');
  const stack = $('.composer-stack');
  if (!grid || !stack) return;
  if (instant) grid.classList.add('mosaic-instant');

  const css = getComputedStyle(grid);
  const minCol = parseFloat(css.getPropertyValue('--mosaic-min-col')) || 240;
  const gap = parseFloat(css.getPropertyValue('--mosaic-gap')) || 16;
  const containerWidth = grid.clientWidth;
  if (containerWidth <= 0) return; // conteneur pas encore mesurable (onglet en fond, etc.)

  const cols = Math.max(1, Math.floor((containerWidth + gap) / (minCol + gap)));
  const colWidth = (containerWidth - gap * (cols - 1)) / cols;
  const heights = new Array(cols).fill(0);

  // Repart d'un suivi propre à chaque calcul : les cartes d'un rendu
  // précédent (détruites depuis, voir renderNotes()) ne doivent pas rester
  // observées indéfiniment.
  mosaicResizeObserver.disconnect();

  // Pose l'élément à la colonne `col` (0-indexée), sur `span` colonnes, à la
  // hauteur atteinte par la plus haute des colonnes concernées — puis met à
  // jour ces colonnes avec la nouvelle hauteur (bas de l'élément + espace).
  const place = (el, col, span) => {
    el.style.width = (colWidth * span + gap * (span - 1)) + 'px';
    el.style.left = (col * (colWidth + gap)) + 'px';
    const top = Math.max(...heights.slice(col, col + span));
    el.style.top = top + 'px';
    const h = el.offsetHeight;
    _mosaicHeights.set(el, h);
    mosaicResizeObserver.observe(el);
    const bottom = top + h + gap;
    for (let i = col; i < col + span; i++) heights[i] = bottom;
  };

  // Meilleure colonne de départ pour un élément large de `span` colonnes :
  // celle qui minimise la hauteur atteinte (égalité → la plus à gauche).
  const bestStart = (span) => {
    let best = 0, bestH = Infinity;
    for (let c = 0; c <= cols - span; c++) {
      const h = Math.max(...heights.slice(c, c + span));
      if (h < bestH) { bestH = h; best = c; }
    }
    return best;
  };

  const stackSpan = Math.min(2, cols);
  place(stack, Math.max(0, Math.floor((cols - stackSpan) / 2)), stackSpan);

  for (const el of $$('#notes-grid .note')) {
    const span = el.classList.contains('search-hit') ? Math.min(2, cols) : 1;
    place(el, bestStart(span), span);
  }

  // Les enfants sont tous en position absolue : sans hauteur explicite, le
  // conteneur s'effondrerait à 0 et casserait le défilement de la page.
  grid.style.height = Math.max(0, Math.max(...heights) - gap) + 'px';

  if (instant) {
    // Un reflow force le navigateur à considérer les positions posées
    // ci-dessus comme déjà "acquises" avant de réautoriser la transition —
    // sinon le prochain déplacement (drag, redimensionnement...) repartirait
    // en l'animant depuis zéro au lieu de la vraie position précédente.
    void grid.offsetHeight;
    grid.classList.remove('mosaic-instant');
  }
}

/* Recalcule la mosaïque, avec un court débounce — partagé par toutes les
   causes de changement de hauteur qui ne sont pas un glisser-déposer actif
   (celui-ci veut un retour IMMÉDIAT, voir layoutMosaicNow ci-dessous) :
   redimensionnement de la fenêtre, mais aussi une image (dessin inséré,
   miniature de pièce jointe) qui finit de se charger après coup et change
   la hauteur de sa carte. */
let _layoutTimer;
function scheduleLayoutMosaic(delay = 80) {
  clearTimeout(_layoutTimer);
  _layoutTimer = setTimeout(layoutMosaic, delay);
}

/* Recalcule au prochain frame, sans attendre le débounce ci-dessus — pour
   le retour visuel pendant un glisser-déposer (voir le dragover sur
   #notes-grid plus bas), où un délai de 80ms se voit et fait paraître la
   mosaïque en retard sur le geste. */
let _layoutRaf = null;
function layoutMosaicNow() {
  if (_layoutRaf) return;
  _layoutRaf = requestAnimationFrame(() => { _layoutRaf = null; layoutMosaic(); });
}

window.addEventListener('resize', () => scheduleLayoutMosaic(150));

/* ------------------ Recherche en profondeur (2e barre) ------------------
   Contrairement au tri (1re barre) qui se contente de filtrer la mosaïque,
   celle-ci montre OÙ le terme apparaît : cartes deux fois plus larges,
   extrait de 3 lignes avant et 3 lignes après l'occurrence, navigation
   entre occurrences d'une même notask. */

/* Lignes de contexte visibles de part et d'autre de l'occurrence. Ce n'est
   qu'un CADRAGE par défaut : la notask entière est rendue, la hauteur
   visible est bornée à 2×n+1 lignes (voir --hit-lines en CSS) et le reste
   se fait défiler au survol, sans que la carte change de taille. */
const HIT_CONTEXT_LINES = 4;

/* Texte d'une notask ramené à une liste de lignes, tous champs confondus :
   c'est sur cette liste que portent la recherche ET le découpage en
   contexte, pour que "3 lignes avant/après" veuille dire la même chose
   quel que soit le champ où le terme a été trouvé. */
function noteLines(n) {
  const lignes = [];
  if (n.title) lignes.push(n.title);
  if (n.description) lignes.push(n.description);
  if (n.is_checklist) {
    for (const it of (n.items || [])) lignes.push(it.text || '');
  } else if (n.content) {
    lignes.push(...n.content.split('\n'));
  }
  return lignes;
}

/* Toutes les occurrences du terme dans une notask, dans l'ordre de
   lecture. Recherche insensible à la casse, sur du texte déjà déchiffré. */
function findHits(n, terme) {
  const lignes = noteLines(n);
  const cible = terme.toLowerCase();
  const hits = [];
  lignes.forEach((ligne, idx) => {
    const bas = (ligne || '').toLowerCase();
    let from = 0;
    for (;;) {
      const p = bas.indexOf(cible, from);
      if (p === -1) break;
      hits.push({ ligne: idx, debut: p, fin: p + cible.length });
      from = p + cible.length;
    }
  });
  return { lignes, hits };
}

/* Rend la notask ENTIÈRE, toutes occurrences surlignées — celle qui est
   sélectionnée en bleu cuillère, les autres en jaune cuillère. La hauteur
   visible est bornée en CSS à 2×HIT_CONTEXT_LINES + 1 lignes, et le bloc
   est recadré sur l'occurrence courante après insertion
   (voir cadrerExtrait) : on voit donc par défaut HIT_CONTEXT_LINES lignes
   au-dessus et autant en dessous, mais on peut faire défiler le reste au
   survol sans que la carte ne change de taille. */
function renderHitExtract(lignes, hits, courant) {
  const cible = hits[courant];

  let html = '';
  for (let i = 0; i < lignes.length; i++) {
    const ligne = lignes[i] || '';
    // Occurrences de CETTE ligne. On garde leur rang global (idx) pour
    // savoir laquelle est celle qui est sélectionnée.
    const surCetteLigne = hits
      .map((h, idx) => ({ ...h, idx }))
      .filter((h) => h.ligne === i);

    let morceau = escapeHtml(ligne);
    if (surCetteLigne.length) {
      morceau = '';
      let pos = 0;
      for (const h of surCetteLigne.slice().sort((a, b) => a.debut - b.debut)) {
        morceau += escapeHtml(ligne.slice(pos, h.debut));
        const classe = h.idx === courant ? 'hit current' : 'hit';
        morceau += `<mark class="${classe}">${escapeHtml(ligne.slice(h.debut, h.fin))}</mark>`;
        pos = h.fin;
      }
      morceau += escapeHtml(ligne.slice(pos));
    }
    html += `<div class="hit-line${i === cible.ligne ? ' hit-line-current' : ''}">${morceau || '&nbsp;'}</div>`;
  }
  return html;
}

/* Recadre l'extrait sur l'occurrence sélectionnée. Cadrage par le HAUT :
   on aligne en tête de zone visible la ligne située HIT_CONTEXT_LINES
   au-dessus de l'occurrence. L'occurrence apparaît donc en haut, avec ses
   4 lignes de contexte au-dessus, et tout le reste de la notask en
   dessous — plutôt que centrée au milieu du bloc.

   Le calcul se fait en LIGNES du document, pas en pixels : une ligne
   longue est repliée sur plusieurs rangées à l'écran, si bien qu'un
   centrage au pixel ne donne pas le même nombre de lignes de contexte
   d'une notask à l'autre. Positions relevées via getBoundingClientRect
   plutôt qu'offsetTop : ce dernier se mesure par rapport au premier
   ancêtre positionné (ici la carte, en position:relative), pas par
   rapport au bloc défilant. */
function cadrerExtrait(extrait) {
  if (!extrait) return;
  // Hauteur visible posée depuis JS plutôt qu'en dur dans la feuille de
  // style : HIT_CONTEXT_LINES reste la seule valeur à changer, les deux ne
  // peuvent pas diverger.
  extrait.style.setProperty('--hit-lines', HIT_CONTEXT_LINES * 2 + 1);

  const cible = extrait.querySelector('.hit-line-current');
  if (!cible) return;

  let premiere = cible;
  for (let i = 0; i < HIT_CONTEXT_LINES && premiere.previousElementSibling; i++) {
    premiere = premiere.previousElementSibling;
  }

  const haut = premiere.getBoundingClientRect().top;
  const hautBloc = extrait.getBoundingClientRect().top;
  const marge = parseFloat(getComputedStyle(extrait).paddingTop) || 0;
  extrait.scrollTop = Math.max(0, extrait.scrollTop + (haut - hautBloc) - marge);
}

/* Remplace la mosaïque par les résultats de la recherche en profondeur. */
function renderSearchHits() {
  const grid = $('#notes-grid');
  grid.querySelectorAll('.note').forEach((el) => el.remove());

  const terme = state.deepSearch;
  const resultats = [];
  for (const n of state.notes) {
    const { lignes, hits } = findHits(n, terme);
    if (hits.length) resultats.push({ n, lignes, hits });
  }

  $('#notes-empty').hidden = resultats.length > 0;
  $('#notes-empty').textContent = `Aucune notask ne contient « ${terme} ».`;

  for (const { n, lignes, hits } of resultats) {
    const courant = Math.min(state.deepCursor[n.id] || 0, hits.length - 1);

    const el = document.createElement('article');
    el.className = 'note search-hit c-' + n.color;
    el.dataset.id = n.id;

    const icon = n.icon && ICON_CHOICES[n.icon] ? `<span class="note-icon">${ICON_CHOICES[n.icon]}</span>` : '';
    const nav = hits.length > 1
      ? `<div class="hit-nav">
           <button type="button" class="hit-prev" aria-label="Occurrence précédente">&#8249;</button>
           <span class="hit-count">${courant + 1} / ${hits.length}</span>
           <button type="button" class="hit-next" aria-label="Occurrence suivante">&#8250;</button>
         </div>`
      : `<div class="hit-nav"><span class="hit-count">1 occurrence</span></div>`;

    el.innerHTML = `
      <div class="note-title-row">${icon}<h3>${escapeHtml(n.title || 'Notask sans titre')}</h3></div>
      ${nav}
      <div class="hit-extract">${renderHitExtract(lignes, hits, courant)}</div>`;

    const bouger = (delta) => {
      state.deepCursor[n.id] = (courant + delta + hits.length) % hits.length;
      renderSearchHits();
    };
    const prev = el.querySelector('.hit-prev');
    const next = el.querySelector('.hit-next');
    if (prev) prev.onclick = (e) => { e.stopPropagation(); bouger(-1); };
    if (next) next.onclick = (e) => { e.stopPropagation(); bouger(1); };

    // Clic ailleurs sur la carte : ouvre la notask, comme dans la mosaïque.
    el.addEventListener('click', (e) => {
      // Ni la navigation entre occurrences, ni un simple défilement de
      // l'extrait, ni la fin d'une sélection de texte ne doivent ouvrir la
      // notask — c'est justement dans ces cartes qu'on vient lire et
      // recopier un extrait.
      if (e.target.closest('.hit-nav')) return;
      if (clicTermineUneSelection(el)) return;
      openNoteSimpleDialog(n);
    });

    grid.appendChild(el);
    // Après insertion seulement : les hauteurs ne sont mesurables qu'une
    // fois l'élément dans le document.
    cadrerExtrait(el.querySelector('.hit-extract'));
  }

  layoutMosaic(true); // rendu complet : positionnement instantané, voir layoutMosaic()
}

/* --------------------- Masquage "terminal" d'une carte ---------------------
   Remplace le contenu d'une notask marquée `masked`, UNIQUEMENT dans la
   mosaïque d'accueil : ni en édition rapide, ni dans les deux recherches —
   on masque contre un regard de passage ou une photo, pas contre soi-même
   en train de chercher quelque chose.

   Le contenu réel n'est jamais mis dans le DOM de la carte : le masquer en
   CSS le laisserait lisible dans l'inspecteur et sur bien des captures.

   Rendu : un terminal qui tape des lignes de code et des journaux
   d'exécution, avec des erreurs en rouge, dans l'esprit d'un terminal
   Fallout (phosphore, lignes de balayage, curseur plein). Les lignes sont
   plausibles mais entièrement fictives — aucune ne provient de la notask. */

const TERM_LIGNES_VISIBLES = 7;

// Trois familles mélangées : du code, des journaux de validation, et
// quelques invites façon terminal Fallout.
const TERM_CODE = [
  'const session = await fetch("/api/v2/session", { method: "POST" });',
  'if (!verifySignature(chunk, key)) throw new Error("bad signature");',
  'for (let i = 0; i < buffer.length; i += 4) { crc = update(crc, buffer[i]); }',
  'export async function rotateKeys(store) {',
  '  const derived = await pbkdf2(secret, salt, 210_000, "SHA-256");',
  'db.exec("PRAGMA journal_mode = WAL");',
  'let attempts = 0; while (attempts++ < MAX_RETRY) { … }',
  'memcpy(dst + offset, src, len - offset);',
  'return payload.map(decodeFrame).filter(Boolean);',
  'router.get("/health", (_, res) => res.json({ status: "ok" }));',
  'assert(node.left.height - node.right.height <= 1);',
  'std::vector<uint8_t> block(BLOCK_SIZE, 0x00);',
];
const TERM_LOGS = [
  '[  OK  ] handshake completed  tls1.3  x25519',
  '[  OK  ] 4096 blocks verified in 0.312s',
  '[ INFO ] cache warm — 128 entries preloaded',
  '[  OK  ] signature chain valid up to root',
  '[ INFO ] scheduler tick 0x1f4  drift 2ms',
  '[  OK  ] wal checkpoint  1.2 MiB flushed',
  '[ INFO ] 3 workers idle, 1 busy',
];
const TERM_ERREURS = [
  '[ FAIL ] checksum mismatch at 0x7ffd21a0',
  'panic: index out of range [12] with length 8',
  '[ WARN ] retry 2/5 — connection reset by peer',
  'segmentation fault (core dumped)',
  '[ FAIL ] permission denied: /dev/mem',
];
const TERM_FALLOUT = [
  'ROBCO INDUSTRIES (TM) TERMLINK PROTOCOL',
  '> SET TERMINAL/INQUIRE',
  '> RUN DEBUG/ACCOUNTS.F',
  'WELCOME TO ROBCO TERMLINK',
  '> ENTER PASSWORD NOW',
];

function tirerAuSort(liste) { return liste[Math.floor(Math.random() * liste.length)]; }

/* Choisit la prochaine ligne et sa nature. Les proportions donnent un flux
   surtout technique, ponctué de validations, avec l'erreur assez rare pour
   qu'elle reste remarquable. */
function prochaineLigneTerminal() {
  const d = Math.random();
  if (d < 0.10) return { texte: tirerAuSort(TERM_FALLOUT), type: 'fallout' };
  if (d < 0.22) return { texte: tirerAuSort(TERM_ERREURS), type: 'erreur' };
  if (d < 0.50) return { texte: tirerAuSort(TERM_LOGS), type: 'log' };
  return { texte: tirerAuSort(TERM_CODE), type: 'code' };
}

/* État de frappe par terminal. WeakMap plutôt qu'un tableau : les cartes
   sont reconstruites à chaque rendu de la mosaïque, et une entrée dont
   l'élément a disparu du document se libère toute seule. */
const termEtats = new WeakMap();

function creerTerminalMasque() {
  const box = document.createElement('div');
  box.className = 'term-mask';
  box.setAttribute('aria-hidden', 'true');

  const corps = document.createElement('div');
  corps.className = 'term-body';

  const courante = document.createElement('div');
  courante.className = 'term-line term-current';
  const tape = document.createElement('span');
  const caret = document.createElement('span');
  caret.className = 'term-caret';
  caret.textContent = '█';
  courante.append(tape, caret);
  corps.appendChild(courante);

  // Voile de lignes de balayage, par-dessus le texte.
  const scan = document.createElement('div');
  scan.className = 'term-scan';

  box.append(corps, scan);
  termEtats.set(box, {
    corps, courante, tape,
    ligne: prochaineLigneTerminal(),
    pos: 0,
    pause: 0,
  });
  return box;
}

/* Une seule minuterie pour toute la page, plutôt qu'une par carte : le
   nombre de cartes change à chaque rendu, autant de minuteries à
   créer/détruire serait une source de fuites. On avance de 1 à 3
   caractères par tick, ce qui donne une frappe irrégulière — une vitesse
   constante trahirait immédiatement la machine. */
setInterval(() => {
  // Onglet en arrière-plan : personne ne regarde, on ne touche à rien.
  if (document.hidden) return;
  const terminaux = document.querySelectorAll('.term-mask');
  if (!terminaux.length) return;

  terminaux.forEach((box) => {
    const e = termEtats.get(box);
    if (!e) return;

    // Petite pause en fin de ligne, comme quelqu'un qui reprend son souffle.
    if (e.pause > 0) { e.pause -= 1; return; }

    e.pos += 1 + Math.floor(Math.random() * 3);
    const texte = e.ligne.texte;

    if (e.pos >= texte.length) {
      // Ligne terminée : elle rejoint l'historique, une nouvelle commence.
      e.tape.textContent = '';
      const finie = document.createElement('div');
      finie.className = 'term-line term-' + e.ligne.type;
      finie.textContent = texte;
      e.corps.insertBefore(finie, e.courante);

      // On ne garde que les dernières lignes : la hauteur du bloc est
      // fixe, tout ce qui dépasse serait invisible et coûterait pour rien.
      while (e.corps.children.length > TERM_LIGNES_VISIBLES + 1) {
        e.corps.removeChild(e.corps.firstChild);
      }

      e.ligne = prochaineLigneTerminal();
      e.pos = 0;
      e.pause = 4 + Math.floor(Math.random() * 8);
      return;
    }

    e.tape.textContent = texte.slice(0, e.pos);
    e.courante.className = 'term-line term-current term-' + e.ligne.type;
  });
}, 55);

function renderNotes() {
  // Recherche en profondeur active : la mosaïque laisse place aux
  // résultats détaillés (voir renderSearchHits()).
  if (state.deepSearch) { renderSearchHits(); return; }

  const grid = $('#notes-grid');
  // Le composeur et la recherche vivent en dur DANS #notes-grid (voir
  // index.html) : on ne retire que les cartes de note d'un rendu précédent,
  // jamais tout le conteneur, sous peine de les faire disparaître.
  grid.querySelectorAll('.note').forEach((el) => el.remove());
  $('#notes-empty').hidden = state.notes.length > 0;
  // Remet le message d'origine : la recherche en profondeur le remplace
  // par « Aucune notask ne contient … » quand elle est active.
  $('#notes-empty').textContent = state.showArchived
    ? 'Aucune notask archivée.'
    : state.showFavoritesOnly ? 'Aucun favori.' : 'Aucune notask.';

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

    /* Notask masquée : titre et description restent lisibles (ils servent
       à retrouver sa notask), tout le reste — contenu, lignes à cocher,
       pièces jointes — est remplacé par le rideau de caractères et n'est
       même pas construit dans le DOM. */
    if (n.masked) {
      inner += '<div class="term-slot"></div>';
    } else {
    if (n.is_checklist) {
      inner += '<ul class="check">';
      // Une ligne archivée seule (voir NoteItem.archived) est mise de côté :
      // elle ne s'affiche plus dans sa notask, mais figure dans les Archives
      // comme une ligne à part (voir loadArchivedItems()).
      for (const it of n.items.filter((i) => !i.archived)) {
        const due = it.due_at
          ? `<em class="item-due-tag">${formatDueRange(it.due_at, it.due_end_at)}</em>` : '';
        inner += `<li class="${it.checked ? 'done' : ''}" data-item="${it.id}">
          <input type="checkbox" ${it.checked ? 'checked' : ''}>
          <span>${escapeHtml(it.text)}${due}</span></li>`;
      }
      inner += '</ul>';
    } else if (n.content) {
      // Le contenu peut porter des images insérées dans le texte
      // (`![att:ID]`) : le HTML sort avec des <img> sans src, hydratées
      // plus bas une fois la carte dans le DOM.
      inner += `<div class="body">${renderFormatted(n.content)}</div>`;
    }

    // Sous le trait : aucun rendu visuel (plus de vignettes d'images). Le
    // visuel — image affichée, lecteur de note vocale — n'existe que dans le
    // CORPS de la notask, là où l'élément a été inséré. Ici on ne donne
    // qu'un décompte de ce qui est joint, tout type confondu.
    const jointes = n.attachments || [];
    if (jointes.length) {
      inner += '<div class="note-attachments">';
      inner += `<div class="note-attach-files">${ICONS.file}<span>${jointes.length} fichier${jointes.length > 1 ? 's' : ''}</span></div>`;
      inner += '</div>';
    }
    }   // fin du bloc "notask non masquée"

    inner += `<div class="palette" hidden></div>
      <div class="actions">
        <button data-act="color" title="Couleur" aria-label="Couleur">${ICONS.palette}</button>
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
        ${ICONS.clock}<span>${formatDueRange(n.due_at, n.due_end_at)}</span>
      </div>`;
    }

    inner += `<div class="note-labels"></div>`;

    el.innerHTML = inner;
    // Rideau construit en DOM (et non en chaîne) : chaque colonne porte sa
    // propre durée d'animation tirée au sort.
    const emplacement = el.querySelector('.term-slot');
    if (emplacement) emplacement.replaceWith(creerTerminalMasque());
    hydrateInlineImages(el, n);
    hydrateInlineAudio(el, n);
    ajouterBoutonsCopieCode(el);

    // (Plus de miniatures de pièces jointes à hydrater ici : la carte
    // n'affiche plus qu'un décompte sous le trait, le visuel étant réservé
    // au corps de la notask — voir renderFormatted/hydrateInlineImages.)

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
        construirePalette(palette, n.color, async (c) => {
          await api('/notes/' + n.id, { method: 'PATCH', body: { color: c } });
          loadNotes();
        });
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
      if (clicTermineUneSelection(el)) return;
      if (geleParGlisser(el)) return;
      openNoteSimpleDialog(n);
    });

    grid.appendChild(el);
  }

  layoutMosaic(true); // rendu complet : positionnement instantané, voir layoutMosaic()
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

/* --------------------- Réordonnancement par glisser (souris + tactile) ---------------------
   Remplace un ancien glisser-déposer HTML5 natif (draggable="true" /
   dragstart / dragover / dragend) qui ne fonctionnait tout simplement pas
   au doigt : sur la quasi-totalité des navigateurs mobiles, un geste
   tactile ne déclenche jamais "dragstart" — la mosaïque de notasks et la
   liste de libellés étaient donc totalement impossibles à réordonner sur
   téléphone, malgré le bouton "+ / -" ou n'importe quel autre contournement.
   Remplacé par une seule implémentation à base de Pointer Events, qui
   unifie souris/stylet/tactile : plus de risque de double logique à
   maintenir en parallèle (une pour desktop, une pour mobile).

   Comportement :
   - Souris/stylet : le glisser démarre dès que le pointeur s'éloigne de
     quelques pixels du point d'appui — un simple clic ne bouge jamais rien.
   - Tactile : le glisser démarre après un bref appui MAINTENU
     (LONG_PRESS_MS) sans mouvement significatif. Indispensable : sans ce
     délai, impossible de faire défiler la page en touchant une carte ou
     un libellé — chaque geste de défilement serait pris pour une tentative
     de glisser. Tout mouvement avant la fin de l'appui annule le glisser
     et laisse le défilement natif du navigateur reprendre la main.
   - Une fois démarré, l'élément suit le pointeur en direct (translate())
     pendant que la carte/le libellé le plus proche est repéré et permuté
     dans le DOM — même mécanique de proximité que l'ancien code
     (getDropTarget(), juste au-dessous), désormais pilotée par
     pointermove plutôt que par dragover. Après chaque permutation, la
     position de référence du suivi est ré-ancrée sur l'emplacement réel
     tout juste atteint (mosaïque en positionnement absolu recalculée via
     layoutMosaicNow(), ou simple reflow pour les libellés) — sans ce
     réancrage, l'élément décollerait visiblement du doigt dès la
     permutation suivante. */
const LONG_PRESS_MS = 280;
const DRAG_MOVE_THRESHOLD = 6;

// Marque le geste qui vient de réordonner un élément, pour que le "click"
// qui suit immanquablement le relâchement du doigt/bouton ne soit pas
// interprété comme une ouverture de la carte ou un filtre par libellé —
// même principe que clicTermineUneSelection() pour une sélection de texte.
const _dragJustHappened = new WeakSet();
function marquerGesteDeGlisser(el) {
  _dragJustHappened.add(el);
  setTimeout(() => _dragJustHappened.delete(el), 0);
}
function geleParGlisser(el) {
  return _dragJustHappened.has(el);
}

function enablePointerReorder(container, itemSelector, { excludeSelector, onSwap, onDrop, enabled } = {}) {
  let pending = null; // avant le démarrage effectif : { pointerId, item, startX, startY, timer }
  let active = null;  // glisser réellement en cours

  function clearPending() {
    if (pending && pending.timer) clearTimeout(pending.timer);
    pending = null;
  }

  function startDrag(item, pointerId, clientX, clientY) {
    const box = item.getBoundingClientRect();
    active = {
      el: item, pointerId,
      grabX: clientX - box.left, grabY: clientY - box.top,
      baseLeft: box.left, baseTop: box.top,
      moved: false,
    };
    item.classList.add('dragging');
    try { item.setPointerCapture(pointerId); } catch { /* déjà relâché entretemps, sans conséquence */ }
  }

  container.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (active || (enabled && !enabled())) return;
    const item = e.target.closest(itemSelector);
    if (!item || !container.contains(item)) return;
    if (excludeSelector && e.target.closest(excludeSelector)) return;

    clearPending();
    pending = { pointerId: e.pointerId, item, startX: e.clientX, startY: e.clientY, timer: null };
    if (e.pointerType === 'touch') {
      pending.timer = setTimeout(() => {
        if (!pending || pending.pointerId !== e.pointerId) return;
        const p = pending;
        pending = null;
        startDrag(p.item, p.pointerId, p.startX, p.startY);
      }, LONG_PRESS_MS);

      // Un appui tactile maintenu déclenche aussi, sur certains navigateurs
      // (Android notamment), un vrai événement "contextmenu" — qui sur les
      // libellés ouvre le menu de suppression (voir oncontextmenu, pensé
      // pour le clic droit desktop). Les deux gestes partagent la même
      // durée d'appui : sans ce garde-fou, tenir un libellé pour le
      // réordonner risquerait de faire apparaître la confirmation de
      // suppression en même temps. Neutralisé pendant toute la fenêtre où
      // ça pourrait se produire, uniquement pour ce point de contact précis
      // — le clic droit souris, lui, n'entre jamais dans cette branche.
      const suppressContextMenu = (ce) => ce.preventDefault();
      item.addEventListener('contextmenu', suppressContextMenu, { once: true });
      setTimeout(() => item.removeEventListener('contextmenu', suppressContextMenu), LONG_PRESS_MS + 600);
    }
  });

  container.addEventListener('pointermove', (e) => {
    if (active && e.pointerId === active.pointerId) {
      e.preventDefault();
      active.moved = true;

      const target = getDropTarget(container, e.clientX, e.clientY, itemSelector);
      if (target && target.el !== active.el) {
        active.el.style.transform = '';
        if (target.before) target.el.before(active.el);
        else target.el.after(active.el);
        if (onSwap) onSwap();
        const box = active.el.getBoundingClientRect();
        active.baseLeft = box.left;
        active.baseTop = box.top;
      }

      const x = e.clientX - active.grabX - active.baseLeft;
      const y = e.clientY - active.grabY - active.baseTop;
      active.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      return;
    }
    if (pending && e.pointerId === pending.pointerId) {
      const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);
      if (dist <= DRAG_MOVE_THRESHOLD) return;
      if (pending.timer) {
        // Tactile, appui pas encore assez long : un mouvement franc avant
        // la fin du délai est un défilement normal, pas un glisser.
        clearPending();
      } else {
        // Souris/stylet, pas d'appui long : le premier mouvement franc
        // démarre directement le glisser.
        const p = pending;
        pending = null;
        startDrag(p.item, p.pointerId, e.clientX, e.clientY);
      }
    }
  }, { passive: false });

  function endDrag(e) {
    if (pending && e.pointerId === pending.pointerId) clearPending();
    if (!active || e.pointerId !== active.pointerId) return;
    const el = active.el;
    const moved = active.moved;
    el.classList.remove('dragging');
    el.style.transform = '';
    active = null;
    if (moved) {
      marquerGesteDeGlisser(el);
      if (onDrop) onDrop();
    }
  }
  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointercancel', endDrag);
}

enablePointerReorder($('#notes-grid'), '.note', {
  // Le geste ne doit pas partir d'un bouton ou d'une case, sous peine de
  // gêner leurs propres clics ; réservé à la vue par défaut, voir
  // notesReorderable() — filtrer/rechercher ne mélange pas l'ordre du
  // sous-ensemble affiché avec celui, complet, des notasks masquées.
  excludeSelector: '.pin-btn, .actions, .palette, .note-attachments, input',
  enabled: notesReorderable,
  // La mosaïque est en positionnement absolu (voir layoutMosaic()) : sans
  // ce recalcul après chaque permutation, réordonner le DOM ne bouge plus
  // rien à l'écran — un CSS Grid classique se serait reflowé tout seul,
  // plus maintenant.
  onSwap: layoutMosaicNow,
  onDrop: commitNoteOrder,
});

// `itemSelector` par défaut à '.note' : seul le réordonnancement des
// libellés (voir renderLabelsDrawer()) passe '.label-row'. Doit rester
// AVANT enablePointerReorder() dans l'ordre de lecture du fichier — pas
// une contrainte technique (les déclarations `function` sont hissées),
// juste pour suivre l'ordre logique : la cible d'abord, le geste ensuite.
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
let composerMasked = false;
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
  composerMasked = false;
  renderBoutonMasque('#nc-toggle-mask', false);
  composerExpanded = false;
  composerPendingFiles = [];
  renderComposerAttachments();
  $('#nc-due').value = '';
  $('#nc-due-end').value = '';
  renderNcDueBtn();
  $('#nc-colors').hidden = true;
  renderComposerLabelChips();
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
  // Déclenchement DIRECT, en plus du ResizeObserver global (voir
  // mosaicResizeObserver/layoutMosaic()) : signalé encore chevauchant les
  // cartes voisines au dépliage du composeur malgré ce dernier — plutôt que
  // de creuser une éventuelle latence/rate du ResizeObserver sans navigateur
  // réel sous la main pour le vérifier, on garantit ici le recalcul à la
  // source du changement de hauteur, qui a lieu à CHAQUE appel de cette
  // fonction (bascule barre d'outils, libellés, liste à cocher...). Coût
  // nul si la hauteur n'a pas changé : layoutMosaic() replace alors les
  // cartes exactement où elles étaient déjà.
  scheduleLayoutMosaic(0);
  $('#nc-content').hidden = composerChecklist;
  $('#nc-items').hidden = !composerChecklist;
  $('#nc-add-item').hidden = !composerChecklist;
  // Gras/italique/souligné/code ne s'appliquent qu'au texte libre : groupe
  // masqué en mode liste à cocher, comme #dns-fmt-group en édition rapide.
  // La bascule note/liste, elle, reste visible dans les deux sens.
  $('#nc-fmt-group').hidden = composerChecklist;
  renderComposerChecklistBtn();
  // Le bloc entier (fond arrondi propre, voir .nc-toolbar-block) bascule,
  // pas seulement la rangée de boutons à l'intérieur.
  $('#nc-toolbar-block').hidden = !composerExpanded;
  // La rangée de libellés suit la barre d'outils : inutile d'afficher un
  // "+" isolé sous un composeur replié qui ne montre que "Nouvelle notask…".
  $('#nc-labels').hidden = !composerExpanded;
  if (!composerExpanded) $('#nc-labels-picker').hidden = true;
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

$('#nc-toggle-mask').addEventListener('click', () => {
  composerExpand();
  composerMasked = !composerMasked;
  renderBoutonMasque('#nc-toggle-mask', composerMasked);
});
renderBoutonMasque('#nc-toggle-mask', false);

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
  if (!ncColorsBox.hidden) { ncColorsBox.hidden = true; return; }
  $('#nc-text-colors').hidden = true;    // une seule palette ouverte à la fois
  construirePalette(ncColorsBox, composerColor, (c) => { composerColor = c; });
  ncColorsBox.hidden = false;
});

// Libellés : rangée persistante + bouton "+", strictement la même que dans
// les boîtes d'édition — même fonction de rendu (renderLabelChipsInto),
// seule la liste d'identifiants change (composerLabelIds au lieu de
// state.editingLabelIds). Plus de bouton "Libellés" dans la barre d'outils :
// la rangée est toujours visible, comme en édition rapide.
function renderComposerLabelChips() {
  renderLabelChipsInto(
    '#nc-labels', '#nc-labels-picker',
    () => composerLabelIds,
    (v) => { composerLabelIds = v; },
    renderComposerLabelChips,
  );
}

// Échéance : même bouton + popover calendrier que sur une notask existante
// (voir renderDueBtn()/openCalPopup(), partagés avec dn-due-btn/dns-due-btn).
function renderNcDueBtn() {
  renderDueBtn('#nc-due-btn', '#nc-due-label', $('#nc-due').value || null, $('#nc-due-end').value || null);
}
$('#nc-due-btn').addEventListener('click', () => {
  composerExpand();
  openCalPopup($('#nc-due-btn'), $('#nc-due').value || null, (iso, finIso) => {
    $('#nc-due').value = iso || '';
    $('#nc-due-end').value = (iso && finIso) || '';
    renderNcDueBtn();
  }, $('#nc-due-end').value || null);
});
renderNcDueBtn();

// Mise en forme (gras/italique/souligné/code) : même mécanique que
// #dns-fmt-toolbar en édition rapide (wrapSelectionRich()/richToText(),
// définies plus bas dans ce fichier mais utilisables ici — déclarations de
// fonction, donc "remontées" (hoisted) avant l'exécution de ce script).
brancherBarreFormat('#nc-fmt-group', '#nc-content', '#nc-text-colors', '#nc-colors');

// Pièces jointes : la notask n'existe pas encore, les fichiers restent en
// mémoire (composerPendingFiles) jusqu'à l'envoi (voir #nc-add). Aperçu
// local seulement — pas de chiffrement/upload avant que la notask existe.
$('#nc-attach-btn').innerHTML = ICONS.attach;
function renderComposerAttachments() {
  const box = $('#nc-attachments');
  box.innerHTML = '';
  box.hidden = composerPendingFiles.length === 0;
  // Cf. renderAttachmentsSimple() : liste non visuelle, le rendu intégré
  // est réservé au corps de la notask.
  composerPendingFiles.forEach((file, idx) => {
    const type = file.type || '';
    const isImage = type.startsWith('image/');
    const isAudio = type.startsWith('audio/');
    const chip = document.createElement('div');
    chip.className = 'dns-attach-chip';
    chip.innerHTML = `<span class="dns-attach-icon">${isImage ? ICONS.image : isAudio ? ICONS.audio : ICONS.file}</span>
      <span class="dns-attach-name" title="${escapeHtml(file.name || '')}">${escapeHtml(file.name || 'Fichier')}</span>
      <span class="dns-attach-size">${formatFileSize(file.size)}</span>
      <button type="button" class="dns-attach-remove" title="Retirer">${ICONS.close}</button>`;
    chip.querySelector('.dns-attach-remove').addEventListener('click', () => {
      composerPendingFiles.splice(idx, 1);
      // Un marqueur provisoire référence le RANG dans composerPendingFiles :
      // retirer un fichier décale tous les suivants. Sans cette
      // renumérotation, un dessin ou une note vocale déjà inséré dans le
      // texte pointerait après coup vers le mauvais fichier — et la
      // réécriture des marqueurs à la création (voir #nc-add) figerait
      // l'erreur. On renumérote directement dans le DOM plutôt que de
      // réécrire le contenu, pour ne pas déplacer le curseur de l'utilisateur.
      $('#nc-content').querySelectorAll('[data-att^="tmp"]').forEach((el) => {
        const rang = Number(el.dataset.att.slice(3));
        if (Number.isInteger(rang) && rang > idx) el.dataset.att = 'tmp' + (rang - 1);
      });
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

/* ==================== Notes vocales et dictée ====================
   Deux fonctions distinctes, volontairement sur deux boutons :
   - Note vocale : enregistre l'audio et le joint à la notask comme
     n'importe quel fichier (il passe donc par le même chiffrement de bout
     en bout que les autres pièces jointes).
   - Dictée : ne produit aucun fichier, écrit du texte dans la notask.
     S'appuie sur l'API Web Speech, qui sur Chrome Android délègue à la
     reconnaissance vocale du système — c'est bien l'outil Android qui
     travaille, sans rien à installer. Firefox ne l'implémente pas : on le
     dit clairement plutôt que de laisser un bouton inerte. */

const AUDIO_BITS_PER_SECOND = 96000;
const MAX_AUDIO_MB = 5;
const MAX_AUDIO_BYTES = MAX_AUDIO_MB * 1024 * 1024;

/* Le conteneur audio dépend du navigateur : Chrome/Android produisent du
   WebM/Opus, Safari/iOS uniquement du MP4. On prend le premier format
   réellement supporté au lieu d'en imposer un qui ferait échouer
   l'enregistrement sur la moitié des appareils. */
function choisirFormatAudio() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidats = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidats.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function extensionAudio(mime) {
  if (!mime) return 'webm';
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

let enregistrementEnCours = null;

/* Lectures interrompues par une capture micro, à reprendre après coup.

   Portée réelle : les notes vocales de l'appli, plus tout <audio>/<video>
   présent dans la page. Une page web ne peut PAS mettre en pause une autre
   application (Spotify, YouTube dans un autre onglet, lecteur du
   téléphone) — aucune API navigateur ne le permet, et prétendre le
   contraire serait faux. Sur Android, le système coupe généralement de
   lui-même la lecture en cours quand une appli prend le micro. */
let lecturesSuspendues = [];

function captureMicroActive() {
  return !!(enregistrementEnCours || dicteeEnCours);
}

function suspendreLecturesPourMicro() {
  // On n'écrase pas une liste déjà constituée : si l'enregistrement démarre
  // pendant une dictée (ou l'inverse), la seconde capture ne doit pas
  // repartir d'une liste vide et faire oublier ce qu'il faut reprendre.
  if (lecturesSuspendues.length) return;
  lecteursAudio.forEach((a) => { if (!a.paused) { a.pause(); lecturesSuspendues.push(a); } });
  document.querySelectorAll('audio, video').forEach((el) => {
    if (!el.paused) { el.pause(); lecturesSuspendues.push(el); }
  });
}

function reprendreLecturesApresMicro() {
  // Tant qu'une capture reste active (dictée lancée pendant un
  // enregistrement, par exemple), on ne reprend rien.
  if (captureMicroActive()) return;
  const aReprendre = lecturesSuspendues;
  lecturesSuspendues = [];
  aReprendre.forEach((a) => a.play().catch(() => {}));
}

async function basculerNoteVocale(btnSel, onFichier) {
  const btn = $(btnSel);

  // Deuxième clic sur le bouton actif : on arrête et on laisse onstop faire
  // le reste. Un clic sur l'AUTRE bouton pendant un enregistrement arrête
  // aussi celui en cours, pour ne jamais avoir deux flux micro ouverts.
  if (enregistrementEnCours) {
    const memeBouton = enregistrementEnCours.btnSel === btnSel;
    enregistrementEnCours.recorder.stop();
    if (memeBouton) return;
    return;
  }

  const mime = choisirFormatAudio();
  if (mime === null) {
    alert("Ce navigateur ne sait pas enregistrer d'audio (MediaRecorder absent).");
    return;
  }

  let flux;
  try {
    flux = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    // Refus de permission, micro absent, ou page non sécurisée : un seul
    // message, l'utilisateur n'a pas à distinguer ces cas.
    alert("Micro indisponible : autorisez l'accès au microphone pour enregistrer une note vocale.");
    return;
  }

  const recorder = new MediaRecorder(flux, {
    mimeType: mime || undefined,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  });
  const morceaux = [];
  let taille = 0;
  let coupeParLimite = false;

  const arreterFlux = () => flux.getTracks().forEach((t) => t.stop());

  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    morceaux.push(e.data);
    taille += e.data.size;
    // Coupure nette à la limite plutôt qu'un rejet après coup : l'utilisateur
    // garde ce qu'il a déjà dit au lieu de tout perdre.
    if (taille >= MAX_AUDIO_BYTES && recorder.state === 'recording') {
      coupeParLimite = true;
      recorder.stop();
    }
  };

  recorder.onstop = () => {
    arreterFlux();
    clearInterval(enregistrementEnCours && enregistrementEnCours.minuteur);
    enregistrementEnCours = null;
    btn.classList.remove('is-recording');
    btn.innerHTML = ICONS.mic;
    btn.title = `Note vocale (${MAX_AUDIO_MB} Mo max)`;
    reprendreLecturesApresMicro();

    if (!morceaux.length) return;
    const type = recorder.mimeType || mime || 'audio/webm';
    const blob = new Blob(morceaux, { type });
    const horodatage = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '');
    const fichier = new File([blob], `note-vocale-${horodatage}.${extensionAudio(type)}`, { type });
    onFichier(fichier);
    if (coupeParLimite) {
      alert(`Enregistrement arrêté : limite de ${MAX_AUDIO_MB} Mo atteinte. La partie enregistrée est conservée.`);
    }
  };

  // Toute lecture en cours est mise en pause le temps de l'enregistrement :
  // sans ça, le micro réenregistrerait le haut-parleur.
  suspendreLecturesPourMicro();

  // timeslice de 1s : sans lui, ondataavailable n'est appelé qu'à l'arrêt et
  // la limite de taille ne pourrait jamais être surveillée en cours de route.
  recorder.start(1000);

  const debut = Date.now();
  const minuteur = setInterval(() => {
    const s = Math.floor((Date.now() - debut) / 1000);
    btn.title = `Enregistrement… ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')} — cliquer pour arrêter`;
  }, 1000);

  enregistrementEnCours = { recorder, btnSel, minuteur };
  btn.classList.add('is-recording');
  btn.innerHTML = ICONS.stop;
  btn.title = 'Enregistrement… cliquer pour arrêter';
}

/* ---------------------------- Dictée ---------------------------- */

const ReconnaissanceVocale = window.SpeechRecognition || window.webkitSpeechRecognition;
let dicteeEnCours = null;

/* Insère le texte reconnu dans la zone visée. Deux cas : un champ de
   formulaire classique (value) ou une zone riche contenteditable
   (#nc-content / #dns-content). Pour la zone riche on passe par
   execCommand('insertText') quand c'est possible : c'est le seul moyen
   simple d'insérer au curseur en gardant l'annulation (Ctrl+Z) fonctionnelle. */
function insererTexteDicte(cible, texte) {
  if (!cible || !texte) return;
  const morceau = texte.trim();
  if (!morceau) return;

  if (cible.isContentEditable) {
    cible.focus();
    const separateur = cible.textContent && !/\s$/.test(cible.textContent) ? ' ' : '';
    let insere = false;
    try {
      insere = document.execCommand('insertText', false, separateur + morceau);
    } catch { insere = false; }
    if (!insere) cible.textContent += separateur + morceau;
  } else {
    const separateur = cible.value && !/\s$/.test(cible.value) ? ' ' : '';
    cible.value += separateur + morceau;
  }
  cible.dispatchEvent(new Event('input', { bubbles: true }));
}

function basculerDictee(btnSel, cibleFn, avantDemarrage) {
  const btn = $(btnSel);

  if (dicteeEnCours) {
    const memeBouton = dicteeEnCours.btnSel === btnSel;
    dicteeEnCours.arretDemande = true;
    dicteeEnCours.reco.stop();
    if (memeBouton) return;
  }

  if (!ReconnaissanceVocale) {
    alert("La dictée vocale n'est pas disponible dans ce navigateur. Elle fonctionne sur Chrome (y compris Android, qui utilise la reconnaissance vocale du téléphone).");
    return;
  }

  if (avantDemarrage) avantDemarrage();
  const cible = cibleFn();
  if (!cible) return;

  const reco = new ReconnaissanceVocale();
  reco.lang = 'fr-FR';
  reco.continuous = true;
  // Les résultats intermédiaires ne sont pas insérés (ils changent à chaque
  // mot) : seuls les segments marqués définitifs le sont, sinon le texte
  // se réécrirait en boucle pendant qu'on parle.
  reco.interimResults = false;

  reco.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) insererTexteDicte(cible, e.results[i][0].transcript);
    }
  };

  const terminer = () => {
    dicteeEnCours = null;
    btn.classList.remove('is-recording');
    btn.innerHTML = ICONS.dictee;
    btn.title = 'Dictée vocale (parler pour écrire)';
    // Après terminer() seulement, pas dans onend : la reconnaissance se
    // relance d'elle-même après un silence, reprendre la lecture à chaque
    // relance la ferait hoqueter pendant toute la dictée.
    reprendreLecturesApresMicro();
  };

  reco.onerror = (e) => {
    terminer();
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      alert("Micro refusé : autorisez l'accès au microphone pour la dictée.");
    }
    // 'no-speech'/'aborted' : silence ou arrêt volontaire, rien à signaler.
  };

  reco.onend = () => {
    // La reconnaissance s'arrête d'elle-même après un silence prolongé. Tant
    // que l'utilisateur n'a pas cliqué pour arrêter, on relance : sinon une
    // dictée un peu hésitante se couperait toute seule sans prévenir.
    if (dicteeEnCours && !dicteeEnCours.arretDemande) {
      try { reco.start(); return; } catch { /* relance impossible : on termine */ }
    }
    terminer();
  };

  suspendreLecturesPourMicro();
  try {
    reco.start();
  } catch {
    terminer();
    return;
  }
  dicteeEnCours = { reco, btnSel, arretDemande: false };
  btn.classList.add('is-recording');
  btn.innerHTML = ICONS.stop;
  btn.title = 'Dictée en cours… cliquer pour arrêter';
}

// --- Composeur ---
$('#nc-mic-btn').innerHTML = ICONS.mic;
$('#nc-dictee-btn').innerHTML = ICONS.dictee;
// mousedown et pas click : au clic, le curseur a déjà quitté la zone de
// texte et la sélection est perdue. Même approche que le tableau blanc.
$('#nc-mic-btn').addEventListener('mousedown', () => memoriserCurseur($('#nc-content')));
$('#nc-mic-btn').addEventListener('click', () => {
  composerExpand();
  basculerNoteVocale('#nc-mic-btn', (fichier) => {
    // La notask n'existe pas encore : pas d'identifiant de pièce jointe.
    // Marqueur provisoire `[audio:tmpN]` (N = rang dans la file), réécrit
    // avec le vrai id juste après la création — exactement le mécanisme
    // déjà en place pour les dessins insérés dans le texte.
    const idProvisoire = 'tmp' + composerPendingFiles.length;
    composerPendingFiles.push(fichier);
    renderComposerAttachments();
    insererAudioDansContenu(idProvisoire, URL.createObjectURL(fichier), fichier);
  });
});
$('#nc-dictee-btn').addEventListener('click', () => {
  basculerDictee('#nc-dictee-btn', () => $('#nc-content'), composerExpand);
});

// --- Édition rapide ---
$('#dns-mic-btn').innerHTML = ICONS.mic;
$('#dns-dictee-btn').innerHTML = ICONS.dictee;
$('#dns-mic-btn').addEventListener('mousedown', () => memoriserCurseur($('#dns-content')));
$('#dns-mic-btn').addEventListener('click', () => {
  basculerNoteVocale('#dns-mic-btn', async (fichier) => {
    const note = state.editingNote;
    if (!note) return;
    try {
      const created = await uploadAttachment(note.id, fichier);
      created.meta = { name: fichier.name, mime: fichier.type };
      if (!note.attachments) note.attachments = [];
      note.attachments.push(created);
      renderAttachmentsSimple();
      insererAudioDansContenu(created.id, URL.createObjectURL(fichier), fichier);
    } catch (err) {
      alert(err.message);
    }
  });
});
$('#dns-dictee-btn').addEventListener('click', () => {
  // En mode liste à cocher, #dns-content est masqué : on dicte alors dans la
  // description, seul champ texte libre restant.
  basculerDictee('#dns-dictee-btn', () =>
    (state.editingIsChecklist ? $('#dns-description') : $('#dns-content')));
});

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
brancherCollagePropre($('#nc-content'));

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
      // Fin de plage : n'a de sens qu'avec un début (voir due_end_at dans
      // app/models.py, remis à None côté serveur si due_at est absent).
      due_end_at: ($('#nc-due').value && $('#nc-due-end').value) || null,
      // Miroir en clair du titre, vu par le serveur UNIQUEMENT quand une
      // échéance est posée — sert à nommer l'événement Google Calendar lié
      // (voir app/google_calendar.py). Reste vide sans échéance : compromis
      // de chiffrement volontairement limité au strict nécessaire.
      calendar_title: $('#nc-due').value ? title : null,
      label_ids: composerLabelIds,
      masked: composerMasked,
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

      // Les dessins insérés dans le texte portaient un marqueur provisoire
      // (`![att:tmpN]`, N = rang dans la file) faute d'identifiant avant la
      // création. Maintenant que le serveur les a attribués, on réécrit le
      // contenu avec les vrais ids. Second appel assumé : impossible de
      // connaître ces ids avant d'avoir créé la notask ET envoyé les
      // fichiers.
      let contenuFinal = content;
      let remplace = false;
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') return;
        // Deux familles de marqueurs provisoires à réécrire : les dessins
        // (`![att:tmpN]`) et les notes vocales (`[audio:tmpN]`). Elles
        // partagent la même file composerPendingFiles, donc le même rang N.
        for (const [avant, apres] of [
          [`![att:tmp${i}]`, `![att:${r.value.id}]`],
          [`[audio:tmp${i}]`, `[audio:${r.value.id}]`],
        ]) {
          if (!contenuFinal.includes(avant)) continue;
          contenuFinal = contenuFinal.split(avant).join(apres);
          remplace = true;
        }
      });
      if (remplace && !composerChecklist) {
        await api('/notes/' + created.id, {
          method: 'PATCH',
          body: { content: await encryptField(contenuFinal) },
        });
      }
    }

    // Page fantôme (voir NOTASK_QUICK_CAPTURE, /quick) : un rechargement
    // complet plutôt que resetComposer() + loadNotes() — plus simple et
    // plus sûr que de rejouer à la main toute la logique d'expansion du
    // composeur (voir le bootstrap de app.js) pour être immédiatement prêt
    // à saisir la note suivante, sans dépendre de l'ordre d'exécution entre
    // ce gestionnaire asynchrone et un éventuel second gestionnaire posé à
    // côté.
    if (window.NOTASK_QUICK_CAPTURE) { location.reload(); return; }

    resetComposer();
    loadNotes();
  } catch (err) {
    // Sans ceci, un échec silencieux donne l'impression que le bouton ne
    // fait rien — on affiche toujours la cause dans le composeur.
    msg($('#composer-msg'), err.message);
  }
});

renderComposer();

/* Croix d'effacement des deux barres : masquée tant que le champ est vide,
   pour ne pas encombrer une barre inutilisée. Le clic vide le champ,
   relance la recherche correspondante et redonne le focus — on efface
   presque toujours pour retaper autre chose. */
function brancherEffacementRecherche(inputSel, btnSel, onClear) {
  const input = $(inputSel);
  const btn = $(btnSel);
  btn.innerHTML = ICONS.close;
  const sync = () => { btn.hidden = !input.value; };
  input.addEventListener('input', sync);
  btn.addEventListener('click', () => {
    input.value = '';
    sync();
    onClear();
    input.focus();
  });
  sync();
}

let searchTimer;
$('#notes-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = e.target.value.trim(); loadNotes(); }, 250);
});
brancherEffacementRecherche('#notes-search', '#notes-search-clear', () => {
  clearTimeout(searchTimer);
  state.search = '';
  loadNotes();
});

/* Seconde barre : recherche en profondeur, qui ne filtre pas la mosaïque
   mais la remplace par des cartes larges centrées sur chaque occurrence
   (voir renderSearchHits()). Les curseurs d'occurrence sont remis à zéro à
   chaque frappe : la liste des résultats change, garder l'ancien rang
   n'aurait aucun sens. */
let deepSearchTimer;
$('#notes-deep-search').addEventListener('input', (e) => {
  clearTimeout(deepSearchTimer);
  deepSearchTimer = setTimeout(() => {
    state.deepSearch = e.target.value.trim();
    state.deepCursor = {};
    renderNotes();
  }, 250);
});
brancherEffacementRecherche('#notes-deep-search', '#notes-deep-search-clear', () => {
  clearTimeout(deepSearchTimer);
  state.deepSearch = '';
  state.deepCursor = {};
  renderNotes();
});

/* Les archives sont désormais une entrée du menu latéral, pas un bouton —
   les notasks s'ouvrent toutes via l'édition simple (openNoteSimpleDialog,
   voir plus bas) : l'ancienne boîte "Modifier" complète (#dlg-note) et
   toute sa gestion en double ont été retirées sur demande explicite. */

/* Icône calendrier de la note : jaune dès qu'une échéance est réglée. */
function renderDueBtn(btnSel, labelSel, iso, isoEnd = null) {
  const btn = $(btnSel);
  if (!btn.innerHTML) btn.innerHTML = ICONS.calendar;
  btn.classList.toggle('has-due', !!iso);
  $(labelSel).textContent = iso ? formatDueRange(iso, isoEnd) : 'Aucune échéance';
}

function renderNoteDueBtnSimple() {
  renderDueBtn('#dns-due-btn', '#dns-due-label', $('#dns-due').value || null, $('#dns-due-end').value || null);
}

$('#dns-due-btn').addEventListener('click', () => {
  openCalPopup($('#dns-due-btn'), $('#dns-due').value || null, (iso, finIso) => {
    $('#dns-due').value = iso || '';
    $('#dns-due-end').value = (iso && finIso) || '';
    renderNoteDueBtnSimple();
  }, $('#dns-due-end').value || null);
});

/* Chips de libellés dans la boîte d'édition simple (seule restante — voir
   plus haut, l'ancienne boîte "Modifier" complète a été retirée). Même
   présentation que sur la carte (renderCardLabels()) : puces déjà posées,
   colorées avec la couleur propre du libellé, croix au survol pour la
   retirer, puis un bouton + après la dernière puce qui ouvre
   .label-add-picker (élément frère du conteneur de puces, voir index.html)
   pour poser un libellé restant. Aucun appel API ici (contrairement à la
   carte) : on modifie seulement state.editingLabelIds, la boîte de
   dialogue enregistre au moment de sa fermeture (voir
   saveNoteSimpleDialog()). renderLabelChipsInto() reste générique (elle
   prenait déjà des sélecteurs en paramètre, pour être partagée avec
   l'ancienne boîte "Modifier" — gardée telle quelle, un seul appelant de
   moins ne justifie pas de la simplifier). */
function renderLabelChipsInto(boxSelector, pickerSelector, getIds, setIds, rerender) {
  const box = $(boxSelector);
  const picker = $(pickerSelector);
  box.innerHTML = '';
  if (picker) { picker.innerHTML = ''; picker.hidden = true; }

  const assigned = getIds()
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
      setIds(getIds().filter((id) => id !== l.id));
      rerender();
    };
    chip.append(name, x);
    box.appendChild(chip);
  }

  // Notask sans aucun libellé : on n'affiche que le "+", sans texte
  // explicatif (essayé un temps, retiré à la demande — ça alourdissait
  // la rangée pour rien).
  if (picker) {
    const remaining = state.labels.filter((l) => !getIds().includes(l.id));
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
            setIds([...getIds(), l.id]);
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
const getEditingLabelIds = () => state.editingLabelIds;
const setEditingLabelIds = (v) => { state.editingLabelIds = v; };
function renderNoteLabelChipsSimple() {
  renderLabelChipsInto('#dns-labels', '#dns-labels-picker', getEditingLabelIds, setEditingLabelIds, renderNoteLabelChipsSimple);
}

/* --- Dialogue d'édition simple, façon Keep ---
   Ouvert au clic sur une notask — c'est désormais le SEUL moyen d'éditer
   (l'ancienne boîte "Modifier" complète, #dlg-note, a été retirée) : texte,
   cases à cocher, échéance, icône, couleur, libellés, pièces jointes et
   bascule texte libre/liste s'y modifient tous. Toute fermeture enregistre. */

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

  // Liste volontairement NON visuelle : pas de vignette d'image, pas de
  // lecteur audio. Le rendu intégré (image affichée, onde et bouton de
  // lecture) n'a lieu que dans le CORPS de la notask, à l'endroit où
  // l'élément a été inséré. Ici, tout ce qui est joint apparaît de la même
  // façon — une ligne de fichier qu'on peut ouvrir — y compris ce qui est
  // déjà visible dans le corps.
  for (const att of list) {
    const mime = (att.meta && att.meta.mime) || '';
    const isImage = mime.startsWith('image/');
    const isAudio = mime.startsWith('audio/');
    const name = (att.meta && att.meta.name) || 'Fichier';
    const chip = document.createElement('div');
    chip.className = 'dns-attach-chip';
    chip.innerHTML = `<span class="dns-attach-icon">${isImage ? ICONS.image : isAudio ? ICONS.audio : ICONS.file}</span>
      <span class="dns-attach-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <span class="dns-attach-size">${formatFileSize(att.size)}</span>
      <button type="button" class="dns-attach-remove" title="Supprimer">${ICONS.close}</button>`;
    chip.querySelector('.dns-attach-name').addEventListener('click', async () => {
      // Une image « s'ouvre » dans l'éditeur d'image (seul point d'entrée
      // pour la retoucher, la vignette cliquable ayant disparu) ; tout le
      // reste se télécharge.
      if (isImage) { openImageEditor(att, state.editingNote, 'dns'); return; }
      try {
        const r = await loadAttachment(att);
        const a = document.createElement('a');
        a.href = r.url; a.download = r.name;
        a.click();
      } catch (err) { alert(err.message); }
    });

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
// intact partout ailleurs (les champs titre/description, en particulier —
// #dns-content, lui, passe par brancherCollagePropre() juste en dessous,
// qui nettoie la couleur/police d'un éventuel HTML collé sans toucher au
// texte brut).
$('#dlg-note-simple').addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData ? e.clipboardData.items : [])
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  handleIncomingAttachments(files);
});
brancherCollagePropre($('#dns-content'));

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
/* Bouton de masquage : état enfoncé quand il est actif, dans les deux
   barres. Le rendu est identique, seule la source de l'état change. */
function renderBoutonMasque(btnSel, actif) {
  const btn = $(btnSel);
  btn.innerHTML = ICONS.maskEye;
  btn.classList.toggle('active-toggle', !!actif);
  const label = actif
    ? "Contenu masqué sur l'accueil — cliquer pour l'afficher"
    : "Masquer le contenu sur l'accueil";
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

$('#dns-toggle-mask').addEventListener('click', () => {
  state.editingMasked = !state.editingMasked;
  renderBoutonMasque('#dns-toggle-mask', state.editingMasked);
});

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
    text: i.text, checked: i.checked, due_at: i.due_at, due_end_at: i.due_end_at || null,
  }));
  if (!state.editingNote.attachments) state.editingNote.attachments = [];
  pendingAttachmentUploads = [];
  state.editingLabelIds = [...(note.label_ids || [])];
  state.editingColor = note.color || 'default';
  state.editingMasked = !!note.masked;
  renderBoutonMasque('#dns-toggle-mask', state.editingMasked);
  $('#dns-colors').hidden = true;
  state.editingIcon = note.icon || null;
  renderIconBtn($('#dns-icon-btn'), state.editingIcon);

  $('#dns-title').value = note.title;
  $('#dns-description').value = note.description || '';
  $('#dns-content').innerHTML = renderFormatted(note.content || '');
  hydrateInlineImages($('#dns-content'), note);
  hydrateInlineAudio($('#dns-content'), note);
  ajouterBoutonsCopieCode($('#dns-content'));
  renderDnsMode();
  $('#dns-due').value = note.due_at || '';
  $('#dns-due-end').value = note.due_end_at || '';
  renderNoteDueBtnSimple();
  renderNoteItemsSimple();
  renderAttachmentsSimple();
  renderNoteLabelChipsSimple();
  applyDialogColor($('#dlg-note-simple'), state.editingColor);
  $('#dlg-note-simple').showModal();
  recentrerDialogueSurMosaique($('#dlg-note-simple'));
  animerOuvertureDialogue($('#dlg-note-simple'));
  // Retour mobile : referme comme un clic en dehors de la boîte — le
  // listener 'close' existant (voir plus bas) enregistre déjà quoi qu'il
  // arrive, aucun besoin d'un callback dédié ici.
  suivreAvecHistorique($('#dlg-note-simple'), () => fermerAvecAnimation($('#dlg-note-simple')));
}

// Icône de la notask, changeable depuis l'édition simple — même mécanisme
// que #nc-icon-btn dans le composeur (openIconPopup/renderIconBtn),
// désormais le seul endroit où une notask EXISTANTE peut aussi en changer
// (ajouté ici après le retrait de l'ancienne boîte "Modifier" complète, qui
// portait ce réglage jusque-là).
$('#dns-icon-btn').addEventListener('click', () => {
  openIconPopup($('#dns-icon-btn'), state.editingIcon, (icon) => {
    state.editingIcon = icon;
    renderIconBtn($('#dns-icon-btn'), icon);
  });
});

/* Barre d'outils de mise en forme, édition rapide uniquement. #dns-content
   est une zone contenteditable (pas un <textarea>) : la sélection est donc
   entourée d'un vrai tag HTML (<strong>/<em>/<u>/<code>) qui s'affiche
   réellement mis en forme pendant l'édition (WYSIWYG), et pas seulement une
   fois la note enregistrée et réaffichée sur la carte. Le contenu est
   reconverti en texte façon markdown par richToText() à l'enregistrement —
   l'opération inverse de renderFormatted(), qui remplit cette zone à
   l'ouverture (voir openNoteSimpleDialog()). */
const FMT_TAGS = { bold: 'strong', italic: 'em', underline: 'u' };

/* Mémorise la position de défilement de l'élément et de tous ses ancêtres
   défilables, et rend une fonction qui la rétablit. `focus()` sur une zone
   éditable fait remonter le conteneur en haut : sans ce garde-fou, appliquer
   une mise en forme au milieu d'une longue notask ramenait la vue à la
   première ligne. */
function memoriserDefilements(el) {
  const positions = [];
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight) positions.push([n, n.scrollTop]);
  }
  return () => positions.forEach(([n, v]) => { n.scrollTop = v; });
}

/* Sélecteur de l'enveloppe correspondant à chaque effet. Sert à savoir si
   la sélection est DÉJÀ habillée par cet effet, auquel cas le bouton le
   retire au lieu de l'appliquer une seconde fois. */
const FMT_ENVELOPPES = {
  bold: 'strong, b',
  italic: 'em, i',
  underline: 'u',
  code: 'code',
  // Bloc (plusieurs lignes) ou en ligne (une phrase/un mot) — même
  // distinction que le code, voir wrapSelectionRich().
  archive: 'div.note-archive-zone, span.note-archive-zone',
  color: 'span[style*="color"]',
};

/* Icône décorative de la zone d'archive : purement informative, jamais un
   bouton. contenteditable="false" pour ne pas devenir éditable/déplaçable
   dans la zone de saisie ; pointer-events:none en CSS pour qu'un clic
   dessus retombe sur ce qu'il y a en dessous, sans jamais rien déclencher.
   Insérée une seconde fois par clonerEnveloppe() : cloneNode(false) copie
   l'enveloppe à plat, sans ses enfants, donc chaque moitié issue d'une
   bascule partielle doit recevoir sa propre icône.
   Balise <span>, pas <i> : richToText() lit <i> comme de l'italique
   (case 'em': case 'i'), ce qui aurait glissé un "**" fantôme dans le
   texte enregistré à chaque zone d'archive. Un <span> sans le style
   `color` ni la classe note-archive-zone retombe déjà, dans ce même
   switch, sur inner() — vide ici puisqu'un SVG n'a aucun nœud de texte. */
const ARCHIVE_ICON_HTML = `<span class="archive-icon-mark" contenteditable="false">${ICONS.archive}</span>`;

function trouverEnveloppe(el, range, kind) {
  const depart = range.commonAncestorContainer;
  const noeud = depart.nodeType === 1 ? depart : depart.parentNode;
  if (!noeud || !el.contains(noeud)) return null;
  // Bloc de code : on vise le <pre> englobant plutôt que le <code>
  // intérieur, sinon le retrait ferait disparaître le bloc lui-même.
  if (kind === 'code') {
    const bloc = noeud.closest('pre.note-code-block');
    if (bloc && el.contains(bloc)) return bloc;
  }
  const trouve = noeud.closest(FMT_ENVELOPPES[kind]);
  return trouve && el.contains(trouve) ? trouve : null;
}

/* Copie l'enveloppe avec un autre texte. Un <pre> porte son texte dans un
   <code> intérieur : le cloner à plat perdrait cette structure. */
function clonerEnveloppe(source, texte) {
  const copie = source.cloneNode(false);
  if (source.tagName === 'PRE') {
    const code = document.createElement('code');
    code.textContent = texte;
    copie.appendChild(code);
  } else {
    copie.textContent = texte;
    // L'icône de la zone d'archive n'est pas un enfant récupéré par le
    // cloneNode(false) ci-dessus (il ne clone que l'élément lui-même) : il
    // faut la reposer à l'identique sur chaque moitié issue du partage.
    if (copie.classList.contains('note-archive-zone')) {
      copie.insertAdjacentHTML('beforeend', ARCHIVE_ICON_HTML);
    }
  }
  return copie;
}

/* Retire l'effet sur la seule portion sélectionnée : ce qui précède et ce
   qui suit restent habillés, chacun dans sa propre enveloppe. Sélectionner
   le milieu d'un bloc de code et recliquer sur "code" donne donc bien deux
   blocs séparés encadrant du texte redevenu normal.
   Retourne le nœud de texte mis à nu, pour y reposer la sélection. */
function retirerEnveloppe(range, enveloppe) {
  const avant = document.createRange();
  avant.selectNodeContents(enveloppe);
  avant.setEnd(range.startContainer, range.startOffset);
  const texteAvant = avant.toString();

  const apres = document.createRange();
  apres.selectNodeContents(enveloppe);
  apres.setStart(range.endContainer, range.endOffset);
  const texteApres = apres.toString();

  const morceau = document.createDocumentFragment();
  if (texteAvant) morceau.appendChild(clonerEnveloppe(enveloppe, texteAvant));
  const nu = document.createTextNode(range.toString());
  morceau.appendChild(nu);
  if (texteApres) morceau.appendChild(clonerEnveloppe(enveloppe, texteApres));

  enveloppe.parentNode.replaceChild(morceau, enveloppe);
  return nu;
}

function wrapSelectionRich(el, kind, couleur) {
  const retablirDefilement = memoriserDefilements(el);
  el.focus();
  const sel = window.getSelection();
  // Sorties anticipées : le focus() ci-dessus a déjà pu faire défiler, il
  // faut rétablir avant de renoncer.
  if (!sel.rangeCount) { retablirDefilement(); return; }
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) { retablirDefilement(); return; }
  const text = range.toString();

  /* Bouton bascule : si la sélection est déjà habillée par cet effet, on
     le RETIRE au lieu de l'empiler. Cas particulier de la couleur : tant
     qu'on choisit une teinte, on veut recolorer, pas décolorer — seul le
     rond "défaut" (couleur nulle) enlève la couleur. */
  const bascule = kind !== 'color' || !couleur;
  if (text && bascule) {
    const enveloppe = trouverEnveloppe(el, range, kind);
    if (enveloppe) {
      const nu = retirerEnveloppe(range, enveloppe);
      const r = document.createRange();
      r.selectNodeContents(nu);
      sel.removeAllRanges();
      sel.addRange(r);
      retablirDefilement();
      return;
    }
  }

  let wrapper;
  if (kind === 'archive') {
    // Bloc si la s\u00e9lection contient un saut de ligne, sinon simple chip en
    // ligne \u2014 m\u00eame distinction que le code (voir plus bas), pour un cadre
    // qui ait du sens : un passage de plusieurs lignes m\u00e9rite un vrai
    // rectangle, un mot ou une phrase reste dans le fil du texte.
    const bloc = text.includes('\n');
    wrapper = document.createElement(bloc ? 'div' : 'span');
    wrapper.className = 'note-archive-zone' + (bloc ? ' note-archive-block' : ' note-archive-inline');
    wrapper.textContent = text || '\u200b';
    wrapper.insertAdjacentHTML('beforeend', ARCHIVE_ICON_HTML);
  } else if (kind === 'color') {
    wrapper = document.createElement('span');
    wrapper.style.color = couleur;
    wrapper.textContent = text || '​';
  } else if (kind === 'code') {
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

  /* La sélection est REPOSÉE sur le texte qu'on vient d'habiller, au lieu
     d'être repliée juste après : on enchaîne très souvent deux effets sur
     le même passage (gras puis couleur, par exemple), et devoir le
     resélectionner à chaque fois était pénible. Les effets s'imbriquent
     alors proprement — `**[c:e53935]texte[/c]**` — et richToText comme
     renderFormatted savent déjà lire cette imbrication.
     Quand il n'y avait rien de sélectionné, on place simplement le curseur
     dans le marqueur vide qui vient d'être créé, pour taper dedans. */
  const newRange = document.createRange();
  if (kind === 'archive') {
    // L'enveloppe porte aussi l'icône décorative (dernier enfant) : la
    // resélection ne doit couvrir que le texte, sinon un effet enchaîné
    // (gras, couleur…) sur ce même passage engloberait l'icône avec.
    newRange.setStart(wrapper, 0);
    newRange.setEnd(wrapper, wrapper.childNodes.length - 1);
  } else {
    newRange.selectNodeContents(wrapper);
  }
  sel.removeAllRanges();
  sel.addRange(newRange);
  // En tout dernier : le focus et le repositionnement du curseur ci-dessus
  // ont pu faire défiler le conteneur.
  retablirDefilement();
}

/* Couleur du texte : MÊME nuancier et MÊME code que la couleur de note
   (construirePalette), déplié dans la barre d'outils au lieu d'un popover
   flottant. Ce choix règle d'un coup les deux défauts de la version
   flottante : plus de problème de superposition avec une <dialog> modale
   (le panneau vit dans le flux de la boîte), et plus de calcul de
   placement qui débordait sous la barre.
   `default` sert de "retirer la couleur" : on enveloppe alors sans couleur,
   donc richToText n'écrit aucun marqueur. */
function basculerPaletteTexte(paletteSel, autrePaletteSel, editableSel) {
  const box = $(paletteSel);
  if (!box.hidden) { box.hidden = true; return; }
  if (autrePaletteSel) $(autrePaletteSel).hidden = true;
  construirePalette(box, null, (c) => {
    wrapSelectionRich($(editableSel), 'color', c === 'default' ? null : LABEL_COLOR_HEX[c]);
    box.hidden = true;
  });
  box.hidden = false;
}

/* Branche une barre de mise en forme sur sa zone de texte. Mutualisée
   entre l'édition rapide et le composeur : les deux ont exactement les
   mêmes boutons, il n'y a aucune raison d'en tenir deux copies. */
function brancherBarreFormat(groupeSel, editableSel, paletteSel, autrePaletteSel) {
  $(groupeSel).querySelectorAll('button[data-fmt]').forEach((btn) => {
    if (btn.dataset.fmt === 'code') btn.innerHTML = ICONS.code;
    if (btn.dataset.fmt === 'color') btn.innerHTML = ICONS.textColor;
    if (btn.dataset.fmt === 'archive') btn.innerHTML = ICONS.archive;
    if (btn.dataset.fmt === 'clear') btn.innerHTML = ICONS.clearFormat;
    // Sans ce preventDefault, le clic sur le bouton déplace le focus hors de
    // la zone contenteditable au mousedown et efface la sélection avant même
    // que le click ne se déclenche (constaté à la vérification : le texte
    // sélectionné n'était plus entouré, un tag vide s'insérait au début).
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (btn.dataset.fmt === 'color') basculerPaletteTexte(paletteSel, autrePaletteSel, editableSel);
      else if (btn.dataset.fmt === 'clear') effacerMiseEnForme($(editableSel));
      else wrapSelectionRich($(editableSel), btn.dataset.fmt);
    });
  });
}

/* Retire toute mise en forme (gras/italique/souligné/couleur/code/archive)
   de la sélection, quelle qu'elle soit, pour revenir au texte brut — celui
   d'une notask tapée à la main sans toucher un seul bouton. Contrairement
   aux autres effets, qui visent une enveloppe précise (voir
   trouverEnveloppe), on ne sait pas à l'avance QUELLE mise en forme est
   présente, ni si plusieurs sont imbriquées : Range.toString() donne déjà
   le texte NU de la sélection (tout balisage ignoré), et le réinsérer tel
   quel via deleteContents()/insertNode() éclate proprement toute enveloppe
   partiellement sélectionnée au passage — le même mécanisme natif que
   n'importe quelle édition de texte riche. */
function effacerMiseEnForme(el) {
  const retablirDefilement = memoriserDefilements(el);
  el.focus();
  const sel = window.getSelection();
  if (!sel.rangeCount) { retablirDefilement(); return; }
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) { retablirDefilement(); return; }
  const text = range.toString();
  if (!text) { retablirDefilement(); return; }

  range.deleteContents();
  const nu = document.createTextNode(text);
  range.insertNode(nu);

  // Un collage externe (voir brancherCollagePropre()) peut laisser un
  // conteneur encore stylé (attribut style — couleur, police...) autour du
  // point d'insertion, vidé par deleteContents() ci-dessus mais pas
  // supprimé : le nœud de texte nu réinséré en hérite quand même par
  // simple héritage CSS, malgré tout balisage retiré. On le fait donc
  // remonter hors de toute enveloppe encore porteuse d'un style, en la
  // scindant en deux au besoin (le texte AVANT `nu` et celui APRÈS restent
  // chacun dans leur propre moitié), jusqu'à retrouver soit la racine
  // éditable, soit un conteneur sans style — un simple retour à la ligne
  // pour richToText(), donc sans risque. Utile aussi bien pour du contenu
  // collé avant ce correctif que pour tout autre cas déjà passé au travers.
  let noeud = nu;
  while (noeud.parentNode && noeud.parentNode !== el) {
    const parent = noeud.parentNode;
    if (!parent.hasAttribute || !parent.hasAttribute('style') || !parent.getAttribute('style').trim()) break;
    const grandParent = parent.parentNode;
    if (!grandParent) break;
    const apres = parent.cloneNode(false);
    while (noeud.nextSibling) apres.appendChild(noeud.nextSibling);
    grandParent.insertBefore(noeud, parent.nextSibling);
    grandParent.insertBefore(apres, noeud.nextSibling);
    if (!parent.hasChildNodes()) parent.remove();
    if (!apres.hasChildNodes()) apres.remove();
  }

  const newRange = document.createRange();
  newRange.selectNodeContents(nu);
  sel.removeAllRanges();
  sel.addRange(newRange);
  retablirDefilement();
}

brancherBarreFormat('#dns-fmt-toolbar', '#dns-content', '#dns-text-colors', '#dns-colors');

/* Inverse de renderFormatted() : reconvertit le HTML de la zone
   contenteditable en texte façon markdown pour l'enregistrement. */
function richToText(root) {
  function walk(node) {
    // \u00c9chappement des d\u00e9limiteurs : un * / _ / ` tap\u00e9 comme texte normal
    // (\u00ab vitesse * 2 \u00bb, \u00ab fichier_important \u00bb, un backtick isol\u00e9\u2026) est
    // indiscernable, une fois enregistr\u00e9 en texte brut, d'un VRAI marqueur
    // de mise en forme. Sans \u00e9chappement, renderFormatted() le r\u00e9interpr\u00e8te
    // au rendu suivant \u2014 c'est ce qui produisait des \u00e9toiles et bouts de
    // texte en italique/code parasites apr\u00e8s enregistrement, quand le
    // contenu contenait par hasard deux de ces caract\u00e8res sur la m\u00eame ligne
    // (voire ailleurs dans toute la notask, pour l'italique et le code en
    // ligne \u2014 voir plus bas pourquoi ces deux-l\u00e0 ont aussi besoin d'une
    // garde \u00e0 la lecture). Le backslash lui-m\u00eame est doubl\u00e9 en premier,
    // sinon un backslash tap\u00e9 litt\u00e9ralement fausserait le d\u00e9s\u00e9chappement
    // inverse dans renderFormatted().
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent
        .replace(/\u200b/g, '')
        .replace(/\\/g, '\\\\')
        .replace(/([*_`])/g, '\\$1');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const inner = () => Array.from(node.childNodes).map(walk).join('');
    switch (tag) {
      case 'br': return '\n';
      case 'strong': case 'b': return '**' + inner() + '**';
      case 'em': case 'i': return '*' + inner() + '*';
      case 'u': return '__' + inner() + '__';
      // texteCodeSansBouton : la pastille de copie est inject\u00e9e DANS la
      // zone de code, elle ne doit jamais se retrouver dans le texte
      // enregistr\u00e9 (voir ajouterBoutonsCopieCode).
      case 'pre': return '```' + texteCodeSansBouton(node) + '```';
      case 'code': return '`' + texteCodeSansBouton(node) + '`';
      // Image insérée dans le texte (dessin/tableau) : on ne garde qu'un
      // marqueur avec l'id de la pièce jointe, jamais les octets ni une
      // URL temporaire — voir NOTE_IMG_MARK et hydrateInlineImages().
      case 'img': return node.dataset.att ? `![att:${node.dataset.att}]` : '';
      // Texte coloré : conservé sous forme de marqueur, comme le gras ou le
      // code — voir NOTE_COLOR_MARK et renderFormatted(). L'icône
      // décorative de la zone d'archive (ARCHIVE_ICON_HTML) est aussi un
      // <span> ici : elle n'a ni cette classe ni un style.color, donc elle
      // retombe sans risque sur inner() — vide, un SVG n'a pas de texte.
      case 'span': {
        if (node.classList.contains('note-archive-zone')) return `[arch]${inner()}[/arch]`;
        const hex = cssColorToHex(node.style.color);
        return hex ? `[c:${hex}]${inner()}[/c]` : inner();
      }
      // Éléments d'interface injectés dans le rendu (pastille de copie des
      // blocs de code) : ils ne font pas partie du texte de la notask.
      case 'button': return '';
      // Variante BLOC de la zone d'archive (sélection contenant un saut de
      // ligne, voir wrapSelectionRich) : même marqueur que la variante en
      // ligne, sans le '\n' préfixé qu'un <div> normal reçoit ci-dessous —
      // le contenu porte déjà ses propres retours à la ligne.
      case 'div': {
        if (node.classList.contains('note-archive-zone')) return `[arch]${inner()}[/arch]`;
        // Lecteur de note vocale : on ne conserve que le marqueur, jamais
        // le squelette HTML ni les octets audio (cf. le cas 'img'). Le
        // retour avant/après évite que le bloc se colle au texte voisin
        // quand il est réinséré au rendu suivant.
        if (node.classList.contains('note-audio')) {
          return node.dataset.att ? `\n[audio:${node.dataset.att}]\n` : '';
        }
        return '\n' + inner();
      }
      case 'p': return '\n' + inner();
      default: return inner();
    }
  }
  return Array.from(root.childNodes).map(walk).join('').replace(/^\n/, '');
}

/* Rendu markdown minimal (gras/italique/souligné/code) pour l'affichage des
   notes en texte libre sur la carte — jamais sur du HTML non échappé
   (escapeHtml tourne toujours en premier, la mise en forme s'applique après
   coup sur le texte déjà échappé). */
/* Marqueur d'image insérée dans le corps d'une notask : `![att:12]`, où 12
   est l'id de la pièce jointe. Stocké tel quel dans le texte (donc chiffré
   avec lui) ; l'image n'est déchiffrée et affichée qu'au rendu, par
   hydrateInlineImages(). Ce détour évite de mettre une URL temporaire ou
   des octets dans le contenu — seul l'identifiant voyage. */
const NOTE_IMG_MARK = /!\[att:(\w+)\]/g;

/* Note vocale insérée dans le corps d'une notask : `[audio:12]`. Même
   principe exact que NOTE_IMG_MARK — seul l'identifiant de la pièce jointe
   voyage dans le texte (donc chiffré avec lui), les octets ne sont
   déchiffrés qu'au rendu par hydrateInlineAudio(). */
const NOTE_AUDIO_MARK = /\[audio:(\w+)\]/g;

/* Squelette d'un lecteur de note vocale. contenteditable="false" : sans
   lui, le bloc serait éditable caractère par caractère dans la zone riche
   et l'utilisateur pourrait le disloquer sans s'en rendre compte. */
function audioBlockHtml(attId) {
  return `<div class="note-audio" data-att="${attId}" contenteditable="false">`
    + `<button type="button" class="note-audio-play" aria-label="Lire la note vocale">${ICONS.play}</button>`
    + `<canvas class="note-audio-wave"></canvas>`
    + `<span class="note-audio-time">--:--</span>`
    + `</div>`;
}

/* Texte coloré dans le corps d'une notask : `[c:e53935]texte[/c]`. Même
   principe que le gras/italique — un marqueur dans le texte, donc chiffré
   avec lui et rendu à l'affichage. Hex sur 6 chiffres uniquement, pour ne
   pas laisser passer n'importe quelle valeur CSS dans un attribut style. */
const NOTE_COLOR_MARK = /\[c:([0-9a-fA-F]{6})\]([\s\S]*?)\[\/c\]/g;

/* Zone d'archive : `[arch]texte[/arch]`. Purement VISUEL — écriture
   manuscrite sur fond assombri, pour distinguer d'un coup d'œil un passage
   mis de côté. Aucun rapport avec les notasks archivées (Note.archived),
   qui sont une vue à part ; le nom est celui choisi par l'utilisateur. */
const NOTE_ARCHIVE_MARK = /\[arch\]([\s\S]*?)\[\/arch\]/g;

/* Collage depuis l'extérieur (page web, Word, Google Docs...) : le
   navigateur insère par défaut le HTML tel quel dans la zone éditable (la
   tâche #74 en dépend, pour garder gras/italique/souligné venus d'ailleurs)
   — mais avec lui viennent aussi tous les styles inline de la source
   (couleur, police, fond...), souvent pensés pour un fond CLAIR et donc
   illisibles (texte noir ou gris foncé) une fois collés sur le thème
   sombre de l'app. On ne garde ici que les balises de notre propre
   vocabulaire de mise en forme (celui que richToText() sait relire), sans
   AUCUN attribut : la couleur éventuelle se choisit ensuite à la main,
   avec notre propre palette. Un lien, une liste, un tableau... (balise pas
   dans la liste) perd sa balise mais garde son contenu — pareil que ce que
   richToText() ferait de toute façon à l'enregistrement (case 'default').
   N'agit que si le presse-papier contient du HTML : un simple texte brut
   ne peut cacher aucune couleur, le collage natif du navigateur suffit. */
const PASTE_TAG_WHITELIST = new Set(['B', 'STRONG', 'EM', 'I', 'U', 'BR', 'DIV', 'P', 'SPAN', 'PRE', 'CODE']);
function nettoyerHtmlColle(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  // En profondeur D'ABORD, décision de garder/déballer ENSUITE : un style
  // planqué plusieurs niveaux sous une balise inconnue (tableau, liste
  // imbriquée...) doit être nettoyé avant que son ancêtre ne soit déballé
  // et ses enfants remontés — sinon ces enfants, ajoutés après coup au
  // niveau du dessus, ne seraient jamais revisités par cette même passe.
  (function nettoyer(node) {
    Array.from(node.childNodes).forEach((enfant) => {
      if (enfant.nodeType === Node.TEXT_NODE) return;
      if (enfant.nodeType !== Node.ELEMENT_NODE) { node.removeChild(enfant); return; }
      nettoyer(enfant);
      if (!PASTE_TAG_WHITELIST.has(enfant.tagName)) {
        while (enfant.firstChild) node.insertBefore(enfant.firstChild, enfant);
        node.removeChild(enfant);
        return;
      }
      Array.from(enfant.attributes).forEach((a) => enfant.removeAttribute(a.name));
    });
  })(tmp);
  return tmp.innerHTML;
}

// Insère un fragment HTML déjà nettoyé à la place de la sélection en cours,
// puis replace le curseur juste après — même esprit que effacerMiseEnForme()
// juste au-dessus (manipulation directe du Range, pas execCommand).
function insererHtmlDansSelection(html) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const frag = document.createDocumentFragment();
  let dernier = null;
  while (tmp.firstChild) { dernier = tmp.firstChild; frag.appendChild(tmp.firstChild); }
  range.insertNode(frag);
  if (dernier) {
    const newRange = document.createRange();
    newRange.setStartAfter(dernier);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
}

// Branché sur la zone éditable elle-même (pas sur un ancêtre) : reçoit
// l'événement AVANT les gestionnaires de collage d'image posés sur
// .note-composer/#dlg-note-simple (ordre de bulle DOM, cible d'abord), donc
// s'efface proprement devant eux quand le presse-papier contient un fichier.
function brancherCollagePropre(el) {
  el.addEventListener('paste', (e) => {
    if (!e.clipboardData) return;
    const aDesFichiers = Array.from(e.clipboardData.items || []).some((it) => it.kind === 'file');
    if (aDesFichiers) return; // laissé au gestionnaire de pièce jointe de l'ancêtre
    const html = e.clipboardData.getData('text/html');
    if (!html) return; // texte brut : rien à nettoyer, comportement natif intact
    e.preventDefault();
    insererHtmlDansSelection(nettoyerHtmlColle(html));
  });
}

/* `element.style.color` rend "rgb(r, g, b)" : reconverti en hex pour le
   marqueur. Retourne null si la couleur est absente ou illisible, auquel
   cas on n'écrit aucun marqueur. */
function cssColorToHex(valeur) {
  if (!valeur) return null;
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(valeur.trim());
  if (m) {
    return [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('');
  }
  const h = /^#([0-9a-fA-F]{6})$/.exec(valeur.trim());
  return h ? h[1].toLowerCase() : null;
}

/* Ajoute une pastille de copie sur chaque bloc de code déjà rendu. Injecté
   après coup, jamais dans le HTML produit par renderFormatted() : ce même
   HTML sert à remplir la zone d'édition, et un bouton laissé dans le
   contenu finirait recopié dans le texte de la notask (voir aussi le
   `case 'button'` de richToText, garde-fou pour le même risque).
   contentEditable="false" : sans lui, le bouton devient éditable et
   déplaçable au milieu du texte dans la boîte d'édition rapide. */
/* Texte d'une zone de code, débarrassé de la pastille de copie qu'on y a
   injectée. Indispensable partout où l'on relit ce contenu (copie ET
   reconversion en texte par richToText) : sans ça, le bouton ferait
   potentiellement partie du code recopié ou enregistré. */
function texteCodeSansBouton(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('.code-copy-btn').forEach((b) => b.remove());
  return (clone.textContent || '').replace(/​/g, '');
}

function ajouterBoutonsCopieCode(root) {
  if (!root) return;
  // Blocs ET code en ligne : un mot de passe ou une clé se met souvent en
  // code en ligne, c'est justement là qu'on veut copier d'un geste.
  const zones = root.querySelectorAll('pre.note-code-block, code.note-code-inline');
  zones.forEach((zone) => {
    // Un <code> situé à l'intérieur d'un bloc est déjà couvert par le
    // bouton du bloc : pas de second bouton imbriqué.
    if (zone.tagName === 'CODE' && zone.closest('pre.note-code-block')) return;
    if (zone.querySelector('.code-copy-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-btn';
    btn.contentEditable = 'false';
    btn.title = 'Copier';
    btn.setAttribute('aria-label', 'Copier le code');
    btn.innerHTML = ICONS.copy;
    // Sans ce preventDefault, le mousedown déplace le curseur/efface la
    // sélection dans la zone éditable avant même que le clic n'arrive.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', async (e) => {
      // La carte entière est cliquable : sans ça, copier ouvrirait aussi
      // la notask.
      e.stopPropagation();
      e.preventDefault();
      const cible = zone.tagName === 'PRE' ? (zone.querySelector('code') || zone) : zone;
      try {
        await navigator.clipboard.writeText(texteCodeSansBouton(cible));
        afficherBulleCopie(e.clientX, e.clientY, 'Copié');
      } catch {
        afficherBulleCopie(e.clientX, e.clientY, 'Copie impossible');
      }
    });
    // Bloc : le bouton est placé EN TÊTE et flotte à droite (voir le CSS),
    // pour rester en haut à droite du bloc et suivre le défilement d'un
    // code sur plusieurs lignes. Placé en fin, il se serait retrouvé tout
    // en bas, hors de vue. Code en ligne : à la suite du texte, là où on
    // l'attend.
    if (zone.tagName === 'PRE') zone.prepend(btn);
    else zone.appendChild(btn);
  });
}

/* Remplace les <img data-att> d'un conteneur déjà rendu par leur vraie
   source, déchiffrée à la demande. Appelé après chaque insertion de HTML
   contenant du contenu de notask (carte ou édition rapide). */
function hydrateInlineImages(root, note) {
  const list = (note && note.attachments) || [];
  root.querySelectorAll('img.note-inline-img[data-att]').forEach((img) => {
    if (img.src) return;
    const att = list.find((a) => String(a.id) === img.dataset.att);
    if (!att) return;
    // Comme les miniatures de pièces jointes : l'image change la hauteur de
    // la carte une fois chargée, il faut recaler la mosaïque (si on est
    // bien dans #notes-grid — scheduleLayoutMosaic() ne fait rien sinon).
    img.addEventListener('load', () => scheduleLayoutMosaic());
    loadAttachment(att).then((r) => { img.src = r.url; }).catch(() => {});
  });
}

/* Contexte audio partagé : un par onglet suffit, et les navigateurs en
   limitent le nombre — en créer un par note vocale finirait par lever une
   erreur sur une notask qui en contient plusieurs. Créé à la demande
   seulement, pour ne pas en ouvrir un si aucune note vocale n'est lue. */
// Registre des lecteurs créés (new Audio n'insère rien dans le document :
// impossible de les retrouver par un sélecteur CSS). Sert à n'avoir qu'une
// note vocale en lecture à la fois.
const lecteursAudio = new Set();

let _audioCtx = null;
function contexteAudio() {
  if (!_audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    _audioCtx = new Ctx();
  }
  return _audioCtx;
}

function formatDuree(secondes) {
  if (!Number.isFinite(secondes)) return '--:--';
  const s = Math.max(0, Math.round(secondes));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* Calcule les crêtes affichées, en moyennant la valeur absolue sur des
   tranches égales. On ne dessine PAS l'échantillon brut : à 48 kHz un
   canvas de 300px devrait en afficher des centaines de milliers, ce qui
   donnerait un pâté illisible et coûterait cher à tracer. */
function cretesAudio(buffer, nbBarres) {
  const data = buffer.getChannelData(0);
  const parTranche = Math.max(1, Math.floor(data.length / nbBarres));
  const cretes = [];
  let max = 0;
  for (let i = 0; i < nbBarres; i++) {
    let somme = 0;
    const debut = i * parTranche;
    const fin = Math.min(data.length, debut + parTranche);
    for (let j = debut; j < fin; j++) somme += Math.abs(data[j]);
    const v = fin > debut ? somme / (fin - debut) : 0;
    cretes.push(v);
    if (v > max) max = v;
  }
  // Normalisation : un enregistrement à faible volume doit rester lisible.
  return max > 0 ? cretes.map((v) => v / max) : cretes;
}

function dessinerOnde(canvas, cretes, progression) {
  const ratio = window.devicePixelRatio || 1;
  const largeur = canvas.clientWidth || 240;
  const hauteur = canvas.clientHeight || 36;
  // Le canvas doit être dimensionné en pixels RÉELS, sinon le tracé est
  // flou sur les écrans à forte densité (mobile en particulier).
  canvas.width = Math.round(largeur * ratio);
  canvas.height = Math.round(hauteur * ratio);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, largeur, hauteur);

  const n = cretes.length || 1;
  const pas = largeur / n;
  const largeurBarre = Math.max(1, pas * 0.6);
  const milieu = hauteur / 2;
  for (let i = 0; i < n; i++) {
    const h = Math.max(2, cretes[i] * (hauteur - 4));
    const x = i * pas;
    ctx.fillStyle = (i / n) <= progression ? '#ffd54f' : 'rgba(255,255,255,.32)';
    ctx.fillRect(x, milieu - h / 2, largeurBarre, h);
  }
}

/* Remplace les blocs .note-audio d'un conteneur rendu par un lecteur
   fonctionnel : audio déchiffré, forme d'onde tracée, bouton lecture.
   Même logique que hydrateInlineImages(), appelée aux mêmes endroits. */
function hydrateInlineAudio(root, note) {
  const list = (note && note.attachments) || [];
  root.querySelectorAll('.note-audio[data-att]').forEach((bloc) => {
    if (bloc.dataset.pret === '1') return;
    const att = list.find((a) => String(a.id) === bloc.dataset.att);
    if (!att) return;
    loadAttachment(att)
      .then((r) => brancherLecteurAudio(bloc, r.url, r.blob))
      .catch(() => {
        const minuteur = bloc.querySelector('.note-audio-time');
        if (minuteur) minuteur.textContent = 'indisponible';
      });
  });
}

/* Rend un bloc .note-audio fonctionnel à partir d'une source déjà
   disponible. Séparé de hydrateInlineAudio() pour pouvoir brancher aussi
   une note vocale qu'on vient d'enregistrer : dans le composeur, la notask
   (et donc la pièce jointe) n'existe pas encore, mais on a déjà le blob en
   main — sans ce chemin, le lecteur resterait inerte jusqu'au premier
   rechargement de la page. */
function brancherLecteurAudio(bloc, url, blob) {
  if (!bloc || bloc.dataset.pret === '1') return;
  bloc.dataset.pret = '1';

  const btn = bloc.querySelector('.note-audio-play');
  const canvas = bloc.querySelector('.note-audio-wave');
  const minuteur = bloc.querySelector('.note-audio-time');
  let audio = null;
  let cretes = null;

  const redessiner = () => {
    if (!cretes) return;
    const p = audio && audio.duration ? audio.currentTime / audio.duration : 0;
    dessinerOnde(canvas, cretes, p);
  };

  (async () => {
    audio = new Audio(url);
    audio.preload = 'metadata';
    lecteursAudio.add(audio);
    audio.addEventListener('loadedmetadata', () => {
      minuteur.textContent = formatDuree(audio.duration);
      scheduleLayoutMosaic();
    });
    audio.addEventListener('timeupdate', () => {
      minuteur.textContent = formatDuree(audio.duration - audio.currentTime);
      redessiner();
    });
    audio.addEventListener('ended', () => {
      audio.currentTime = 0;
      minuteur.textContent = formatDuree(audio.duration);
      redessiner();
    });

    // Icône pilotée par les ÉVÉNEMENTS du lecteur, et non par le clic : la
    // lecture peut aussi être interrompue de l'extérieur (démarrage d'un
    // enregistrement, lecture d'une autre note vocale). Câblée sur le clic,
    // l'icône affichait alors « pause » sur un lecteur pourtant à l'arrêt.
    audio.addEventListener('play', () => { btn.innerHTML = ICONS.pause; });
    audio.addEventListener('pause', () => { btn.innerHTML = ICONS.play; });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation(); // ne pas ouvrir la notask en cliquant sur Lecture
      if (audio.paused) {
        // Une seule note vocale à la fois : deux lectures simultanées n'ont
        // aucun intérêt et rendent les deux inaudibles. On passe par le
        // registre `lecteursAudio` et PAS par un sélecteur CSS : ces
        // éléments <audio> sont créés en mémoire (new Audio), ils ne sont
        // jamais insérés dans le document et resteraient introuvables.
        lecteursAudio.forEach((a) => { if (a !== audio) a.pause(); });
        audio.play().catch(() => {});
      } else {
        audio.pause();
      }
    });

    // Clic sur l'onde = déplacement dans la lecture.
    canvas.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!audio.duration) return;
      const rect = canvas.getBoundingClientRect();
      audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
      redessiner();
    });

    // Décodage pour la forme d'onde. Volontairement APRÈS le branchement
    // des contrôles : si le décodage échoue (format non décodable par ce
    // navigateur, fichier tronqué), la lecture doit rester possible — on se
    // contente alors d'une onde plate.
    try {
      const ctx = contexteAudio();
      if (!ctx) throw new Error('pas de contexte audio');
      // slice() : decodeAudioData neutralise l'ArrayBuffer qu'on lui passe,
      // on ne doit jamais lui donner celui du cache de pièces jointes,
      // réutilisé ailleurs.
      const octets = await blob.arrayBuffer();
      const buffer = await ctx.decodeAudioData(octets.slice(0));
      cretes = cretesAudio(buffer, 64);
      minuteur.textContent = formatDuree(buffer.duration);
    } catch {
      cretes = new Array(64).fill(0.12);
    }
    redessiner();
  })();
}

function renderFormatted(text) {
  let html = escapeHtml(text);
  html = html.replace(NOTE_IMG_MARK, (m, id) => `<img class="note-inline-img" data-att="${id}" alt="">`);
  html = html.replace(NOTE_AUDIO_MARK, (m, id) => audioBlockHtml(id));
  // Couleur avant les autres marqueurs : son contenu peut lui-même être en
  // gras/italique, qui seront traités ensuite à l'intérieur du span.
  html = html.replace(NOTE_COLOR_MARK, (m, hex, contenu) => `<span style="color:#${hex}">${contenu}</span>`);
  html = html.replace(NOTE_ARCHIVE_MARK, (m, contenu) => {
    const bloc = /\n/.test(contenu);
    const tag = bloc ? 'div' : 'span';
    return `<${tag} class="note-archive-zone${bloc ? ' note-archive-block' : ' note-archive-inline'}">${contenu}${ARCHIVE_ICON_HTML}</${tag}>`;
  });
  html = html.replace(/```([\s\S]+?)```/g, (m, code) => `<pre class="note-code-block"><code>${code}</code></pre>`);
  // Garde (?<!\\) sur le code EN LIGNE et l'italique : ce sont les deux
  // seuls délimiteurs d'UN SEUL caractère. Un */_/` échappé par
  // richToText() (voir plus haut) reste malgré tout le caractère * ou `
  // lui-même dans le texte — sans cette garde, la regex le prendrait quand
  // même pour un délimiteur, et pourrait même s'apparier avec un AUTRE * ou
  // ` échappé plus loin dans toute la notask, engloutissant tout le texte
  // entre deux au passage. Gras/souligné/bloc de code n'en ont pas besoin :
  // ce sont des délimiteurs à 2-3 caractères IDENTIQUES consécutifs, que
  // l'échappement (caractère par caractère) empêche déjà de se reformer.
  html = html.replace(/(?<!\\)`([^`\n]+?)(?<!\\)`/g, '<code class="note-code-inline">$1</code>');
  html = html.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^\n]+?)__/g, '<u>$1</u>');
  html = html.replace(/(?<!\\)\*([^\n*]+?)(?<!\\)\*/g, '<em>$1</em>');
  // Déséchappement, à la toute fin — une fois que plus aucune regex de mise
  // en forme ne va relire le texte. Ordre inverse de l'échappement : les
  // délimiteurs d'abord (\* → *), le doublement du backslash ensuite
  // (\\ → \), sinon un backslash tapé littéralement ressortirait mal.
  html = html.replace(/\\([*_`])/g, '$1').replace(/\\\\/g, '\\');
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
              title="${item.due_at ? formatDueRange(item.due_at, item.due_end_at) : 'Dater cette ligne en fait une tâche'}">${ICONS.calendar}</button>
      <button class="btn ghost sm" type="button" title="Retirer la ligne">✕</button>`;
    const [cb, txt, cal, del] = row.children;
    cb.onchange = (e) => { state.editingNoteItems[idx].checked = e.target.checked; };
    txt.oninput = (e) => { state.editingNoteItems[idx].text = e.target.value; };
    cal.onclick = () => {
      openCalPopup(cal, state.editingNoteItems[idx].due_at, (iso, finIso) => {
        state.editingNoteItems[idx].due_at = iso;
        state.editingNoteItems[idx].due_end_at = (iso && finIso) || null;
        renderNoteItemsSimple();
      }, state.editingNoteItems[idx].due_end_at || null);
    };
    del.onclick = () => { state.editingNoteItems.splice(idx, 1); renderNoteItemsSimple(); };
    box.appendChild(row);
  });
}

$('#dns-add-item').addEventListener('click', () => {
  state.editingNoteItems.push({ text: '', checked: false, due_at: null });
  renderNoteItemsSimple();
});

/* Couleur en édition rapide : elle n'y était pas (réservée à la boîte
   "Modifier" complète), ajoutée pour que les trois barres d'outils —
   création, édition rapide d'une note, édition rapide d'une liste à
   cocher — proposent la même base. La couleur choisie s'applique tout de
   suite au fond de la boîte (applyDialogColor), et part avec le reste à
   la fermeture (voir saveNoteSimpleDialog). */
const dnsColorsBox = $('#dns-colors');
$('#dns-color-btn').innerHTML = ICONS.palette;
$('#dns-color-btn').addEventListener('click', () => {
  if (!dnsColorsBox.hidden) { dnsColorsBox.hidden = true; return; }
  $('#dns-text-colors').hidden = true;   // une seule palette ouverte à la fois
  construirePalette(dnsColorsBox, state.editingColor, (c) => {
    state.editingColor = c;
    applyDialogColor($('#dlg-note-simple'), c);
  });
  dnsColorsBox.hidden = false;
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
    // Instantané seulement si quelque chose a réellement changé — l'icône
    // est éditable depuis cette boîte (#dns-icon-btn) depuis le retrait de
    // l'ancienne boîte "Modifier" complète qui portait ce réglage jusque-là,
    // donc state.editingIcon (et non plus l'icône figée de l'état chargé)
    // entre bien dans la comparaison.
    const currentItemsForDiff = state.editingIsChecklist
      ? state.editingNoteItems.filter((i) => i.text.trim())
        .map((i) => ({ text: i.text, checked: i.checked, due_at: i.due_at || null }))
      : [];
    const currentForDiff = {
      title: $('#dns-title').value,
      description: $('#dns-description').value,
      content: state.editingIsChecklist ? '' : richToText($('#dns-content')),
      color: state.editingColor || n.color,
      due_at: $('#dns-due').value || null,
      is_checklist: state.editingIsChecklist,
      icon: state.editingIcon,
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
      due_end_at: ($('#dns-due').value && $('#dns-due-end').value) || null,
      // Cf. #nc-add : miroir en clair du titre pour Google Calendar, vidé
      // dès que la notask n'a plus d'échéance.
      calendar_title: $('#dns-due').value ? $('#dns-title').value : null,
      // Sans ce champ, basculer le mode avec #dns-toggle-checklist ne
      // survivait pas à la fermeture : is_checklist n'était jamais envoyé,
      // la note rouvrait dans son ancien mode au prochain clic.
      is_checklist: state.editingIsChecklist,
      label_ids: state.editingLabelIds,
      color: state.editingColor || n.color,
      masked: state.editingMasked,
      icon: state.editingIcon,
    };
    // Les deux champs sont toujours envoyés (l'un vidé) plutôt que seulement
    // celui du mode courant : sinon, après une bascule, l'ancien contenu
    // (lignes de checklist ou texte libre) restait en base sans être
    // affiché nulle part.
    if (state.editingIsChecklist) {
      const items = state.editingNoteItems.filter((i) => i.text.trim());
      // Cf. plus haut : calculé avant l'écrasement de i.text par sa version
      // chiffrée juste en dessous (même objet, la clé calendar_title est
      // évaluée à partir de la valeur d'origine, l'ordre des clés dans le
      // littéral n'a pas d'importance ici).
      body.items = await Promise.all(items.map(async (i) => ({
        ...i,
        calendar_title: i.due_at ? i.text : null,
        text: await encryptField(i.text),
      })));
      body.content = '';
    } else {
      body.content = await encryptField(richToText($('#dns-content')));
      body.items = [];
    }
    await api('/notes/' + n.id, { method: 'PATCH', body });
  } catch (err) {
    alert(err.message);
  }
  loadNotes();
}

// Pas de bouton Enregistrer/Annuler ici : toute fermeture (clic à côté,
// Échap) déclenche l'événement natif "close", seul point d'enregistrement.
/* Un micro ouvert ne doit jamais survivre à la fermeture de la boîte : sans
   ça, l'enregistrement continuerait en arrière-plan et son fichier
   arriverait sur une notask qu'on a déjà quittée. Placé AVANT la
   sauvegarde : arrêter l'enregistrement déclenche l'ajout de la pièce
   jointe, qui doit encore trouver state.editingNote renseigné. */
function arreterCaptureAudio() {
  if (enregistrementEnCours) enregistrementEnCours.recorder.stop();
  if (dicteeEnCours) { dicteeEnCours.arretDemande = true; dicteeEnCours.reco.stop(); }
}
$('#dlg-note-simple').addEventListener('close', arreterCaptureAudio);
$('#dlg-note-simple').addEventListener('close', saveNoteSimpleDialog);
$('#dlg-note-simple').addEventListener('click', (e) => {
  if (e.target === $('#dlg-note-simple')) fermerAvecAnimation($('#dlg-note-simple'));
});
// Échap : on reprend la main pour animer, puis on ferme nous-mêmes.
$('#dlg-note-simple').addEventListener('cancel', (e) => {
  e.preventDefault();
  fermerAvecAnimation($('#dlg-note-simple'));
});

/* ---------------------------- Éditeur d'image ----------------------------
   Visualiseuse + outil de marquage pour les pièces jointes image, ouverte
   au clic sur une vignette (carte ou édition simple) à la place d'un
   nouvel onglet. Cinq outils : rectangle, ellipse (contours), surlignage
   (aplat semi-transparent), texte, mosaïque (pour cacher une zone) — plus
   une palette de couleurs qui reprend telle quelle celle des notes/
   une palette de VRAIES couleurs (IMG_EDITOR_COLORS), volontairement
   distincte de celle des notes : les teintes de notes sont assombries pour
   servir de fond sur un thème sombre, un trait de marquage doit au
   contraire ressortir sur la photo ou le tableau.

   Tout se dessine directement sur #img-editor-canvas, à la résolution
   naturelle de l'image (pas celle, réduite, à laquelle il est affiché à
   l'écran — voir canvasPoint() pour la conversion). "Enregistrer" aplatit
   le canvas en PNG, le chiffre (encryptBinary(), comme à la création) et
   remplace le contenu de la pièce jointe via PUT /api/attachments/{id} —
   même id, donc même vignette partout où elle apparaît déjà. Fermer par
   tout autre moyen (Échap, clic à côté, bouton "Fermer sans enregistrer")
   abandonne les annotations sans rien envoyer au serveur. */

/* Résolution de référence du tableau blanc. Ce n'est PAS un format figé,
   ni un format paysage imposé : le canvas est dimensionné sur la place
   réellement disponible à l'ouverture (voir openWhiteboard), aussi bien
   en portrait qu'en paysage, pour que la surface dessinable remplisse la
   fenêtre sans bandes vides ni déformation. BOARD_WIDTH sert de cible de
   finesse pour le plus grand des deux côtés du conteneur (largeur sur
   desktop, le plus souvent hauteur sur téléphone en portrait) ; les deux
   BOARD_MIN_* sont un plancher de résolution appliqué aux deux axes à la
   fois, jamais un axe seul, pour ne jamais fausser le rapport largeur/
   hauteur réel de l'écran. */
const BOARD_WIDTH = 1600;
const BOARD_MIN_WIDTH = 640;
const BOARD_MIN_HEIGHT = 400;

const imgEditor = {
  att: null,       // pièce jointe en cours d'édition (null en mode tableau blanc)
  note: null,       // note propriétaire (pour rafraîchir la bonne vue après enregistrement)
  source: null,     // 'card' | 'dns' | 'nc' — qui a ouvert l'éditeur
  // 'photo' : on annote une pièce jointe existante, l'enregistrement
  // remplace ses octets (PUT). 'board' : tableau blanc, l'enregistrement
  // crée une nouvelle pièce jointe (ou, depuis le composeur, un fichier en
  // attente puisque la notask n'existe pas encore).
  mode: 'photo',
  tool: 'brush',
  color: '#e53935',   // rouge franc, cf. IMG_EDITOR_COLORS
  size: 6,          // épaisseur du trait libre, en pixels canvas
  // Couleur de fond, visible uniquement là où le canvas est transparent —
  // donc jamais sur une photo (opaque), et partout sur un tableau blanc
  // (dont le canvas reste transparent, le fond n'étant aplati qu'à
  // l'enregistrement). Permet d'en changer à tout moment sans effacer le
  // dessin déjà fait, contrairement à un remplissage réel.
  bg: '#ffffff',
  fullscreen: false,
  history: [],      // pile d'ImageData ; le dernier élément = état affiché
  strokeBase: null, // clone de l'état courant, pris au pointerdown, restauré à chaque pointermove pour prévisualiser sans laisser de trace
  drawing: false,
  lastX: 0,         // dernier point du tracé libre (segment par segment)
  lastY: 0,
  startX: 0,
  startY: 0,
};

const IMG_EDITOR_TOOL_ICONS = {
  brush: 'imgBrush', pencil: 'imgPencil', marker: 'imgMarker', eraser: 'imgEraser',
  rect: 'imgRect', ellipse: 'imgEllipse', highlight: 'imgHighlight',
  text: 'imgText', mosaic: 'imgMosaic',
};

// Outils à main levée : le geste trace segment par segment au fil du
// pointeur, au lieu de définir une forme entre deux points.
const IMG_EDITOR_FREEHAND = new Set(['brush', 'pencil', 'marker', 'eraser']);

function imgEditorCanvas() { return $('#img-editor-canvas'); }

$('#img-editor-undo').innerHTML = ICONS.undo;
$('#img-editor-download').innerHTML = ICONS.download;
$('#img-editor-bg-btn').innerHTML = ICONS.palette;
$('#img-editor-fullscreen').innerHTML = ICONS.fullscreen;
$$('#img-editor-tools .img-tool-btn').forEach((b) => {
  b.innerHTML = ICONS[IMG_EDITOR_TOOL_ICONS[b.dataset.tool]];
  b.classList.toggle('active', b.dataset.tool === imgEditor.tool);
  b.onclick = () => {
    imgEditor.tool = b.dataset.tool;
    $$('#img-editor-tools .img-tool-btn').forEach((x) => x.classList.toggle('active', x === b));
    imgEditorCanvas().classList.toggle('tool-text', imgEditor.tool === 'text');
  };
});

// Épaisseur du trait libre.
$('#img-editor-size').addEventListener('input', (e) => {
  imgEditor.size = Number(e.target.value) || 1;
  $('#img-editor-size-val').textContent = imgEditor.size;
});

/* Palette de dessin : de VRAIES couleurs, franches et saturées — pas la
   palette des notes (LABEL_COLOR_HEX), dont les teintes sont volontairement
   assombries pour servir de fond de carte sur un thème sombre. Un trait de
   marquage doit ressortir sur la photo ou le tableau, pas se fondre dedans.
   Noir et blanc inclus : indispensables pour annoter. */
const IMG_EDITOR_COLORS = [
  ['#000000', 'Noir'], ['#ffffff', 'Blanc'], ['#9e9e9e', 'Gris'],
  ['#e53935', 'Rouge'], ['#ff5722', 'Orange vif'], ['#ff9800', 'Orange'],
  ['#ffc107', 'Ambre'], ['#ffeb3b', 'Jaune'], ['#cddc39', 'Citron'],
  ['#8bc34a', 'Vert clair'], ['#4caf50', 'Vert'], ['#009688', 'Turquoise'],
  ['#00bcd4', 'Cyan'], ['#03a9f4', 'Bleu clair'], ['#2196f3', 'Bleu'],
  ['#3f51b5', 'Indigo'], ['#673ab7', 'Violet'], ['#9c27b0', 'Pourpre'],
  ['#e91e63', 'Rose'], ['#795548', 'Brun'],
];

(function buildImgEditorColors() {
  const box = $('#img-editor-colors');
  for (const [hex, nom] of IMG_EDITOR_COLORS) {
    const s = document.createElement('button');
    s.type = 'button';
    // Fond en style inline, pas via une classe .c-* : celles-ci portent
    // justement les teintes assombries du thème qu'on veut éviter ici.
    s.className = 'swatch' + (hex === imgEditor.color ? ' active' : '');
    s.style.background = hex;
    s.title = nom;
    s.onclick = () => {
      imgEditor.color = hex;
      box.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
      s.classList.add('active');
    };
    box.appendChild(s);
  }
})();

/* Couleur de fond : palette séparée, avec blanc et noir en plus des
   couleurs de notes (un tableau blanc doit pouvoir être… blanc, et un
   fond noir sert pour les croquis clairs). Appliquée en direct au fond
   CSS du canvas — le canvas lui-même reste transparent, la couleur n'est
   aplatie dans le PNG qu'à l'enregistrement (voir imgEditorFlatten()) :
   on peut donc en changer autant de fois qu'on veut sans jamais effacer
   ce qui est déjà dessiné. */
const IMG_EDITOR_BG_COLORS = ['#ffffff', '#fffde7', '#f2efe6', '#e0e0e0', '#cfd8dc', '#263238', '#000000'];

(function buildImgEditorBgColors() {
  const box = $('#img-editor-bg-colors');
  // Fonds neutres d'abord, puis les mêmes vraies couleurs que le trait —
  // et non les teintes assombries du thème.
  const hexes = [...IMG_EDITOR_BG_COLORS, ...IMG_EDITOR_COLORS.map(([hex]) => hex)];
  for (const hex of hexes) {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'swatch' + (hex === imgEditor.bg ? ' active' : '');
    s.style.background = hex;
    s.title = hex;
    s.onclick = () => {
      imgEditorSetBackground(hex);
      box.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
      s.classList.add('active');
    };
    box.appendChild(s);
  }
})();

function imgEditorSetBackground(hex) {
  imgEditor.bg = hex;
  imgEditorCanvas().style.background = hex;
}

$('#img-editor-bg-btn').addEventListener('click', () => {
  const box = $('#img-editor-bg-colors');
  box.hidden = !box.hidden;
});

/* Plein écran : la boîte occupe tout l'écran, il ne reste que la barre
   d'outils en haut et l'image/le fond. Ce n'est PAS l'API Fullscreen du
   navigateur — un <dialog> modal vit déjà dans le "top layer", une classe
   CSS suffit et évite les demandes de permission/sorties inopinées. Échap
   sort du plein écran au lieu de fermer l'éditeur (voir l'écouteur
   "cancel" plus bas), ce qui évite de perdre un dessin en cours d'un
   simple appui. */
function imgEditorSetFullscreen(on) {
  imgEditor.fullscreen = on;
  $('#dlg-image-editor').classList.toggle('fullscreen', on);
  const btn = $('#img-editor-fullscreen');
  btn.innerHTML = on ? ICONS.fullscreenExit : ICONS.fullscreen;
  const label = on ? 'Quitter le plein écran' : 'Plein écran';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}
$('#img-editor-fullscreen').addEventListener('click', () => imgEditorSetFullscreen(!imgEditor.fullscreen));

/* Prépare le dialogue pour une nouvelle session d'édition, quelle que
   soit sa provenance (photo existante ou tableau blanc vierge). */
function imgEditorReset(note, source, mode) {
  imgEditor.note = note;
  imgEditor.source = source;
  imgEditor.mode = mode;
  imgEditor.drawing = false;
  imgEditorSetFullscreen(false);
  $('#img-editor-bg-colors').hidden = true;
  $('#img-editor-size').value = imgEditor.size;
  $('#img-editor-size-val').textContent = imgEditor.size;
}

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
  imgEditorReset(note, source, 'photo');
  // Une photo garde ses marges (elle a son propre rapport, on ne l'étire
  // pas) — contrairement au tableau blanc, voir openWhiteboard().
  $('#dlg-image-editor').classList.remove('board-mode');

  const img = new Image();
  img.onload = () => {
    const canvas = imgEditorCanvas();
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // Une photo est opaque : le fond ne se verra nulle part, mais on le
    // met quand même à jour pour que la gomme révèle du blanc plutôt que
    // le damier de transparence du navigateur.
    imgEditorSetBackground(imgEditor.bg);
    imgEditor.history = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
    $('#dlg-image-editor').showModal();
    // Retour mobile = même geste que le clic en dehors de la boîte :
    // enregistre puis ferme (voir imgEditorSaveAndClose() plus bas).
    suivreAvecHistorique($('#dlg-image-editor'), imgEditorSaveAndClose);
  };
  img.onerror = () => alert("Impossible d'afficher cette image.");
  img.src = loaded.url;
}

/* Tableau blanc : le même éditeur, sur un canvas vierge. Volontairement
   TRANSPARENT et non rempli de blanc — le fond est une simple couleur CSS
   sous le canvas, aplatie dans le PNG seulement à l'enregistrement
   (imgEditorFlatten()). Conséquences voulues : on peut changer la couleur
   de fond à tout moment sans toucher au dessin, et la gomme fait vraiment
   réapparaître le fond. */
function openWhiteboard(note, source) {
  imgEditor.att = null;
  imgEditorReset(note, source, 'board');

  const dlg = $('#dlg-image-editor');
  // Classe posée avant l'ouverture : elle supprime les marges autour du
  // canvas (voir .board-mode dans style.css) pour que la zone dessinable
  // occupe toute la place, sans bandes noires autour.
  dlg.classList.add('board-mode');
  dlg.showModal();
  // Retour mobile : idem openImageEditor() ci-dessus.
  suivreAvecHistorique(dlg, imgEditorSaveAndClose);

  // La taille du tableau est calculée SUR la place réellement disponible,
  // pas figée à un format arbitraire : un canvas 1600x1000 dans une
  // fenêtre d'un autre rapport laisse forcément des bandes vides.
  // Mesure possible seulement une fois la boîte affichée, d'où le
  // requestAnimationFrame.
  requestAnimationFrame(() => {
    const wrap = $('#img-editor-canvas-wrap');
    const cs = getComputedStyle(wrap);
    const dispoW = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const dispoH = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);

    // Résolution de dessin plus fine que l'affichage (trait net, et le PNG
    // reste exploitable si on l'agrandit ensuite), plafonnée pour ne pas
    // fabriquer un canvas démesuré sur un grand écran.
    //
    // L'échelle se calcule sur le plus GRAND des deux côtés du conteneur,
    // pas toujours sur la largeur : sur un téléphone en portrait, c'est la
    // hauteur qui est la plus grande. Cibler systématiquement la largeur
    // (comme avant) n'avait pas d'effet visible sur un écran large, mais
    // sur un conteneur étroit et haut, ça pouvait sous-échelonner la
    // hauteur — sans conséquence tant que le plancher (BOARD_MIN_*) ne
    // s'en mêlait pas, mais le plancher s'appliquait ensuite AXE PAR AXE,
    // ce qui pouvait remonter un seul des deux côtés et déformer le
    // rapport largeur/hauteur réel du conteneur (cercles dessinés ovales
    // à l'écran, par exemple) sur les conteneurs très courts. Le facteur
    // correctif ci-dessous applique le plancher aux deux axes ENSEMBLE
    // (un agrandissement uniforme si besoin), donc le rapport du canvas
    // reste toujours exactement celui du conteneur, quelle que soit
    // l'orientation ou la taille de l'écran.
    const grandCote = Math.max(dispoW, dispoH);
    const echelle = Math.min(2, Math.max(1, BOARD_WIDTH / Math.max(1, grandCote)));
    const canvas = imgEditorCanvas();
    const largeurBrute = Math.max(1, dispoW) * echelle;
    const hauteurBrute = Math.max(1, dispoH) * echelle;
    const facteurPlancher = Math.max(BOARD_MIN_WIDTH / largeurBrute, BOARD_MIN_HEIGHT / hauteurBrute, 1);
    canvas.width = Math.round(largeurBrute * facteurPlancher);
    canvas.height = Math.round(hauteurBrute * facteurPlancher);

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    imgEditorSetBackground(imgEditor.bg);
    imgEditor.history = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
  });
}

/* Le dessin s'insère DANS le texte, à l'endroit où était le curseur avant
   d'ouvrir l'outil — pas en pièce jointe reléguée en bas de carte. Le
   curseur étant perdu dès que le focus part vers le bouton, on mémorise la
   position au tout dernier moment utile : le mousedown du bouton, qui
   précède le changement de focus. */
let inlineDrawTarget = null;   // zone contenteditable visée
let inlineDrawRange = null;    // position du curseur dedans

function memoriserCurseur(editable) {
  inlineDrawTarget = editable;
  inlineDrawRange = null;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  if (editable.contains(r.commonAncestorContainer)) inlineDrawRange = r.cloneRange();
}

/* Insère l'image à la position mémorisée (ou à la fin, si le curseur
   n'était pas dans la zone de texte), suivie d'un saut de ligne pour
   pouvoir continuer à écrire dessous. */
function insererImageDansContenu(attId, apercuUrl) {
  const editable = inlineDrawTarget;
  if (!editable) return false;
  const img = document.createElement('img');
  img.className = 'note-inline-img';
  img.dataset.att = String(attId);
  // Aperçu immédiat depuis le blob qu'on vient de produire : inutile de
  // redemander puis redéchiffrer la pièce jointe qu'on a déjà en main.
  if (apercuUrl) img.src = apercuUrl;
  const saut = document.createElement('br');

  if (inlineDrawRange && editable.contains(inlineDrawRange.commonAncestorContainer)) {
    inlineDrawRange.deleteContents();
    inlineDrawRange.insertNode(saut);
    inlineDrawRange.insertNode(img);
  } else {
    editable.append(img, saut);
  }
  inlineDrawRange = null;
  return true;
}

/* Insère un lecteur de note vocale à la position mémorisée au moment du
   clic sur le micro (ou à la fin du contenu si le curseur n'était pas dans
   la zone de texte). Même mécanique que insererImageDansContenu(), à ceci
   près que le bloc est un élément de niveau bloc : on l'encadre de sauts de
   ligne pour pouvoir continuer à écrire au-dessus comme en dessous. */
function insererAudioDansContenu(attId, url, blob) {
  const editable = inlineDrawTarget;
  if (!editable) return false;

  const gabarit = document.createElement('div');
  gabarit.innerHTML = audioBlockHtml(attId);
  const bloc = gabarit.firstElementChild;
  const saut = document.createElement('br');

  if (inlineDrawRange && editable.contains(inlineDrawRange.commonAncestorContainer)) {
    inlineDrawRange.deleteContents();
    inlineDrawRange.insertNode(saut);
    inlineDrawRange.insertNode(bloc);
  } else {
    editable.append(bloc, saut);
  }
  inlineDrawRange = null;

  // Lecteur immédiatement utilisable, sans attendre un rechargement : on a
  // déjà les octets en main (cf. brancherLecteurAudio).
  if (url && blob) brancherLecteurAudio(bloc, url, blob);
  editable.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

// Icône pinceau (et non un écran) : c'est l'action "dessiner" qu'on veut
// reconnaître, la même que la pointe pinceau de l'éditeur.
$('#dns-board-btn').innerHTML = ICONS.imgBrush;
$('#dns-board-btn').addEventListener('mousedown', () => memoriserCurseur($('#dns-content')));
$('#dns-board-btn').addEventListener('click', () => {
  if (state.editingNote) openWhiteboard(state.editingNote, 'dns');
});
$('#nc-board-btn').innerHTML = ICONS.imgBrush;
$('#nc-board-btn').addEventListener('mousedown', () => memoriserCurseur($('#nc-content')));
$('#nc-board-btn').addEventListener('click', () => {
  composerExpand();
  openWhiteboard(null, 'nc');
});

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

/* Trace un segment de tracé libre entre deux points, selon la pointe
   choisie. `pressure` vaut 0..1 : les stylets et tablettes graphiques la
   renseignent réellement, la souris renvoie 0.5 (ou 0 sur certains
   navigateurs, d'où le repli). Seuls le pinceau et le crayon en tiennent
   compte — un feutre a par nature un trait d'épaisseur constante.

   Chaque pointe est un réglage de contexte, pas un algorithme différent :
   - pinceau : opaque, épaisseur très sensible à la pression ;
   - crayon  : fin, légèrement transparent, peu sensible à la pression ;
   - feutre  : épais, franchement transparent, épaisseur constante — les
     passages se superposent comme un surligneur ;
   - gomme   : efface réellement (destination-out) au lieu de peindre en
     blanc, ce qui laisse réapparaître le fond du tableau. */
function imgEditorStrokeSegment(ctx, x0, y0, x1, y1, pressure) {
  const p = pressure > 0 ? pressure : 0.5;
  const base = imgEditor.size;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = imgEditor.color;

  if (imgEditor.tool === 'brush') {
    ctx.lineWidth = Math.max(1, base * (0.35 + 1.3 * p));
  } else if (imgEditor.tool === 'pencil') {
    ctx.lineWidth = Math.max(1, base * (0.5 + 0.5 * p) * 0.6);
    ctx.globalAlpha = 0.85;
  } else if (imgEditor.tool === 'marker') {
    ctx.lineWidth = Math.max(2, base * 1.6);
    ctx.globalAlpha = 0.35;
  } else if (imgEditor.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = Math.max(2, base * 1.8);
  }

  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
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

// Une session d'édition est ouverte soit sur une pièce jointe (mode photo),
// soit sur un tableau blanc (aucune pièce jointe) : tester `att` seul
// bloquerait tout dessin sur le tableau.
function imgEditorActif() { return imgEditor.mode === 'board' || !!imgEditor.att; }

imgEditorCanvas().addEventListener('pointerdown', (e) => {
  if (!imgEditorActif()) return;
  const p = canvasPoint(e);
  if (imgEditor.tool === 'text') {
    imgEditorOpenTextInput(e, p);
    return;
  }
  // preventDefault + touch-action:none en CSS : sans ça, un doigt ou un
  // stylet sur écran tactile fait défiler/zoomer la page au lieu de
  // dessiner, et le geste est interrompu au bout de quelques pixels.
  e.preventDefault();
  imgEditor.drawing = true;
  imgEditor.startX = p.x;
  imgEditor.startY = p.y;
  imgEditor.lastX = p.x;
  imgEditor.lastY = p.y;
  const canvas = imgEditorCanvas();
  const ctx = canvas.getContext('2d');
  imgEditor.strokeBase = ctx.getImageData(0, 0, canvas.width, canvas.height);
  canvas.setPointerCapture(e.pointerId);
  // Un simple appui sans déplacement doit laisser un point, pas rien.
  if (IMG_EDITOR_FREEHAND.has(imgEditor.tool)) {
    imgEditorStrokeSegment(ctx, p.x, p.y, p.x, p.y, e.pressure);
  }
});

imgEditorCanvas().addEventListener('pointermove', (e) => {
  if (!imgEditor.drawing) return;
  e.preventDefault();

  if (!IMG_EDITOR_FREEHAND.has(imgEditor.tool)) {
    const p = canvasPoint(e);
    imgEditorDrawPreview(imgEditor.startX, imgEditor.startY, p.x, p.y);
    return;
  }

  // getCoalescedEvents() rend tous les points captés par le matériel depuis
  // la dernière frame — un stylet ou une tablette en produit bien plus que
  // les pointermove livrés au JS. Sans ça, un geste rapide donne une ligne
  // brisée à angles visibles au lieu d'une courbe.
  const ctx = imgEditorCanvas().getContext('2d');
  const points = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of (points.length ? points : [e])) {
    const p = canvasPoint(ev);
    imgEditorStrokeSegment(ctx, imgEditor.lastX, imgEditor.lastY, p.x, p.y, ev.pressure);
    imgEditor.lastX = p.x;
    imgEditor.lastY = p.y;
  }
});

imgEditorCanvas().addEventListener('pointerup', (e) => {
  if (!imgEditor.drawing) return;
  imgEditor.drawing = false;
  if (IMG_EDITOR_FREEHAND.has(imgEditor.tool)) {
    // Le tracé s'est déjà inscrit au fil du geste : un seul état
    // d'historique pour tout le trait, pas un par segment.
    imgEditorPushHistory();
    return;
  }
  const p = canvasPoint(e);
  imgEditorCommitShape(imgEditor.startX, imgEditor.startY, p.x, p.y);
});

imgEditorCanvas().addEventListener('pointercancel', () => {
  if (!imgEditor.drawing) return;
  imgEditor.drawing = false;
  if (IMG_EDITOR_FREEHAND.has(imgEditor.tool)) imgEditorPushHistory();
});

// Fermeture sans enregistrer : bouton dédié, ou Échap (événement natif
// "cancel" d'un <dialog>) — les deux abandonnent les annotations. Le clic
// sur le fond et le retour mobile ENREGISTRENT (voir imgEditorSaveAndClose()
// juste en dessous) ; seul ce bouton et Échap abandonnent volontairement.
$('#img-editor-cancel').addEventListener('click', () => $('#dlg-image-editor').close());

/* Clic à côté, OU retour mobile (voir suivreAvecHistorique() dans
   openImageEditor()/openWhiteboard()) = ENREGISTRER puis fermer, comme la
   boîte d'édition rapide (toute fermeture y enregistre). Perdre un dessin
   en cours parce qu'on a cliqué à côté ou appuyé sur retour serait bien
   pire que d'enregistrer une version dont on ne voulait pas — celle-ci
   reste rattrapable par l'historique. Seul le bouton "Fermer sans
   enregistrer" abandonne volontairement le travail. */
async function imgEditorSaveAndClose() {
  try {
    await imgEditorPersist();
    imgEditorRefreshCaller();
  } catch (err) {
    alert(err.message);
    return; // on garde la boîte ouverte : le dessin n'est pas perdu
  }
  $('#dlg-image-editor').close();
}
$('#dlg-image-editor').addEventListener('click', (e) => {
  if (e.target !== $('#dlg-image-editor')) return;
  imgEditorSaveAndClose();
});

/* Échap : sort d'abord du plein écran s'il est actif, et seulement au
   second appui ferme l'éditeur. Sans ça, un réflexe d'Échap pour "revenir
   à la fenêtre normale" ferait perdre tout un dessin en cours. */
$('#dlg-image-editor').addEventListener('cancel', (e) => {
  if (imgEditor.fullscreen) {
    e.preventDefault();
    imgEditorSetFullscreen(false);
  }
});

// Sortir du plein écran quand la boîte se ferme, sinon la classe resterait
// posée et la prochaine ouverture démarrerait en plein écran sans raison.
// Ce dialogue n'utilise pas fermerAvecAnimation() (pas d'effet gélatine
// ici) : toutes ses fermetures passent par .close() directement, donc cet
// unique écouteur natif "close" est le bon endroit pour nettoyer l'entrée
// d'historique posée à l'ouverture (voir suivreAvecHistorique() plus
// haut) — qu'elle vienne du bouton, du clic sur le fond, d'Échap ou du
// retour mobile lui-même (auquel cas oublierHistoriqueSiPresent() ne fait
// rien : l'entrée a déjà été consommée par le retour).
$('#dlg-image-editor').addEventListener('close', () => {
  oublierHistoriqueSiPresent($('#dlg-image-editor'));
  imgEditorSetFullscreen(false);
  $('#dlg-image-editor').classList.remove('board-mode');
});

/* Aplatit le canvas et l'envoie au serveur (PUT, même id) — utilisé à la
   fois par "Enregistrer" et par "Télécharger" (qui enregistre d'abord la
   dernière version avant de la proposer en téléchargement, plutôt que de
   permettre de télécharger des annotations jamais persistées). Retourne
   le blob PNG déjà en clair (pas la peine de le redemander/déchiffrer au
   serveur juste après l'avoir chiffré nous-mêmes) et le nom de fichier à
   utiliser, pour que l'appelant puisse aussi déclencher un téléchargement
   sans repasser par le réseau. */
/* Aplatit le canvas SUR son fond : le canvas est transparent là où rien
   n'a été dessiné (voir openWhiteboard), or un PNG transparent donnerait
   une vignette illisible sur une carte sombre. On recompose donc dans un
   canvas temporaire — fond d'abord, dessin par-dessus — plutôt que de
   remplir le canvas d'édition, qui doit rester transparent pour permettre
   de changer de couleur de fond et de gommer à tout moment. */
function imgEditorFlatten() {
  const canvas = imgEditorCanvas();
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = imgEditor.bg || '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/* Enregistre le tableau blanc comme NOUVELLE pièce jointe. Depuis
   l'édition rapide la notask existe déjà : envoi immédiat. Depuis le
   composeur elle n'existe pas encore : le PNG rejoint la file des
   fichiers en attente (composerPendingFiles), envoyée à la création. */
async function imgEditorPersistBoard() {
  const flat = imgEditorFlatten();
  const blob = await new Promise((resolve) => flat.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error("Impossible d'enregistrer le tableau.");
  const name = `tableau-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  const apercu = URL.createObjectURL(blob);

  if (imgEditor.source === 'nc') {
    // La notask n'existe pas encore : pas d'identifiant de pièce jointe à
    // référencer. On pose un marqueur provisoire, remplacé par le vrai id
    // juste après la création (voir le gestionnaire de #nc-add).
    const idProvisoire = 'tmp' + composerPendingFiles.length;
    composerPendingFiles.push(file);
    insererImageDansContenu(idProvisoire, apercu);
    return { blob, name };
  }

  const note = imgEditor.note;
  if (!note) throw new Error('Aucune notask associée.');
  const created = await uploadAttachment(note.id, file);
  created.meta = { name, mime: 'image/png' };
  if (!note.attachments) note.attachments = [];
  note.attachments.push(created);
  // Insérée dans le texte, à la position mémorisée — et pas seulement
  // ajoutée à la liste des pièces jointes en bas de carte.
  insererImageDansContenu(created.id, apercu);
  return { blob, name };
}

async function imgEditorPersist() {
  if (imgEditor.mode === 'board') return imgEditorPersistBoard();

  const att = imgEditor.att;
  if (!att) throw new Error('Aucune image chargée.');

  // Écraser les octets d'une pièce jointe est irréversible côté serveur
  // (voir PUT /api/attachments/{id}) : un instantané avant coup est le
  // seul moyen de retrouver l'image telle qu'elle était avant l'annotation.
  if (imgEditor.note) await snapshotNoteVersion(imgEditor.note.id);

  // Aplati sur le fond comme le tableau : la gomme peut avoir rendu des
  // zones transparentes, qui deviendraient noires ou vides sans ça.
  const canvas = imgEditorFlatten();
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
   bas, appelée depuis saveNoteSimpleDialog() quand le contenu a réellement
   changé, avant une suppression de pièce jointe, et avant un enregistrement
   dans l'éditeur d'image). Liste -> détail d'une version -> restauration,
   dans #dlg-history, ouvert depuis dlg-note-simple (bouton "Historique"/
   icône horloge). */

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
  ajouterBoutonsCopieCode($('#history-detail-content'));

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
  // La boîte d'édition peut afficher des champs périmés après une
  // restauration (elle ne recharge pas son contenu en direct) : on la
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
  loadNotes();
});
$('#dns-history-btn').innerHTML = ICONS.history;
$('#dns-history-btn').addEventListener('click', () => {
  if (state.editingNote) openHistoryDialog(state.editingNote);
});

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

/* Rond de comptage de "Notasks Prévues" dans le menu de gauche. Ce bouton
   ne mène plus à une vue à part (voir la suppression de #view-tasks /
   renderTasks() / loadTasks() : redondant avec la colonne d'échéances de
   droite, voir loadAgenda() plus bas) — il ne fait plus que scroller
   jusqu'à cette colonne (voir le gestionnaire de clic de #nav-tasks). Le
   badge, lui, reste calculé indépendamment de cette colonne.
   Pas de déchiffrement ici : `bucket` est calculé côté serveur à
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
}

/* --------------------------- Colonne d'échéances --------------------------
   Aperçu des notasks à échéance, affiché à côté de la mosaïque (voir
   #agenda-col dans index.html et switchView() qui l'active/désactive selon
   la vue) — seul point d'accès aux tâches datées, "Notasks Prévues" dans le
   menu de gauche y renvoie directement (plus de vue à part, voir le
   gestionnaire de clic de #nav-tasks). Borné à un mois pour "à venir" —
   sans limite, la colonne finirait par afficher toutes les échéances
   lointaines, ce qui n'a plus rien d'un coup d'œil rapide. Les tâches
   terminées n'y figurent pas. */
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
  // Fenêtre d'un mois pour "à venir" (7 jours auparavant). setMonth gère
  // seul les mois de longueurs différentes, contrairement à un simple
  // "+30 jours" en millisecondes.
  const limite = new Date(now);
  limite.setMonth(limite.getMonth() + 1);
  const items = tasks.filter((t) => {
    if (t.bucket === 'late' || t.bucket === 'today') return true;
    if (t.bucket === 'upcoming') return new Date(t.due_at) <= limite;
    return false; // "done" exclu : la colonne suit les échéances à venir, pas un historique
  });
  renderAgenda(items);
}

/* Vue "notasks prévues" en trois colonnes, desktop uniquement (voir le
   gestionnaire de #nav-tasks : en mobile le même bouton renvoie vers la
   colonne d'échéances, faute de largeur). Mêmes données et mêmes lignes que
   la colonne de droite — c'est la disposition qui change, d'où la
   réutilisation de creerLigneAgenda() plutôt qu'un second rendu parallèle
   qui finirait par diverger. Contrairement à la colonne, aucune limite
   d'un mois : cette vue-ci sert justement à tout voir. */
async function loadTasks() {
  let tasks;
  try {
    tasks = await api('/tasks');
  } catch {
    return;
  }
  await Promise.all(tasks.map(async (t) => {
    t.text = await decryptField(t.text);
    t.note_title = await decryptField(t.note_title);
  }));
  // "done" inclus ici, contrairement à la colonne d'échéances : cette vue a
  // sa propre colonne "terminées".
  renderTasks(tasks);
}

function renderTasks(items) {
  const box = $('#tasks-columns');
  box.innerHTML = '';
  $('#tasks-empty').hidden = items.length > 0;

  const groupes = {};
  for (const t of items) (groupes[t.bucket] ||= []).push(t);

  // Ordre demandé, de gauche à droite : à venir, aujourd'hui, en retard,
  // terminées — différent de la colonne d'échéances de l'accueil, qui
  // empile en retard/aujourd'hui/à venir.
  for (const b of ['upcoming', 'today', 'late', 'done']) {
    const liste = groupes[b] || [];
    // Colonne affichée même vide : des colonnes qui apparaissent et
    // disparaissent au fil des échéances feraient sauter la mise en page
    // d'une visite à l'autre.
    const col = document.createElement('section');
    col.className = 'tasks-column agenda-group ' + b;
    const h2 = document.createElement('h2');
    h2.textContent = `${BUCKET_LABELS[b]} (${liste.length})`;
    col.appendChild(h2);
    // avecActions : archiver/corbeille au survol, réservés à cette vue —
    // pas dans la colonne d'échéances de l'accueil, à la demande.
    for (const t of liste) col.appendChild(creerLigneAgenda(t, loadTasks, true));
    box.appendChild(col);
  }
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

    for (const t of groupes[b]) section.appendChild(creerLigneAgenda(t, loadAgenda));
    box.appendChild(section);
  }
}

/* Une ligne d'échéance, partagée par la colonne de droite et la vue en
   trois colonnes. `rafraichir` est la fonction de rechargement de l'appelant
   (loadAgenda ou loadTasks) : sans ce paramètre, cocher depuis la vue en
   trois colonnes rechargerait la colonne de droite, restée invisible, et la
   ligne cochée ne bougerait pas sous les yeux de l'utilisateur. */
function creerLigneAgenda(t, rafraichir, avecActions = false, modeArchive = 'archive') {
  // <div>, pas <button> : il faut pouvoir héberger une vraie case à
  // cocher, et le HTML interdit un <input> à l'intérieur d'un <button>
  // (contenu interactif imbriqué). Le clic est donc géré à la main
  // ci-dessous, en excluant la case.
  const btn = document.createElement('div');
  btn.tabIndex = 0;
  btn.setAttribute('role', 'button');
  // Fond = couleur propre de la note d'origine (même classe .c-* que
  // sur sa carte), pas un simple repère en bordure : on veut
  // reconnaître la note d'un coup d'œil, pas juste voir "une tâche".
  btn.className = 'agenda-item c-' + t.color + (t.done ? ' done' : '');
  const label = t.text || (t.kind === 'item' ? 'Ligne sans texte' : 'Notask sans titre');
  // Icône toujours affichée dans un rond : celle de la notask si elle en
  // a une, sinon la cuillère bleue par défaut — jamais de rond vide, le
  // texte est ainsi toujours décalé de la même largeur.
  const icon = ICON_CHOICES[t.icon] || ICON_CHOICES.spoonblue;
  btn.innerHTML = `<input type="checkbox" class="agenda-item-check" aria-label="Terminer"${t.done ? ' checked' : ''}>
    <span class="agenda-item-icon">${icon}</span>
    <span class="agenda-item-body">
      <span class="agenda-item-text">${escapeHtml(label)}</span>
      <span class="agenda-item-due">${formatDueRange(t.due_at, t.due_end_at)}</span>
    </span>` + (avecActions ? `<span class="agenda-item-actions">
      <button type="button" data-act="archive"
              title="${modeArchive === 'unarchive' ? 'Désarchiver' : 'Archiver'}"
              aria-label="${modeArchive === 'unarchive' ? 'Désarchiver' : 'Archiver'}"
        >${modeArchive === 'unarchive' ? ICONS.unarchive : ICONS.archive}</button>
      <button type="button" data-act="trash" title="Mettre à la corbeille" aria-label="Mettre à la corbeille">${ICONS.trash}</button>
    </span>` : '');

  if (avecActions) {
    // Une ligne à cocher s'archive ou se jette SEULE (voir NoteItem.archived
    // côté serveur) : elle disparaît des tâches et de Google Calendar, mais
    // sa notask parente et les autres lignes restent intactes. Seule une
    // tâche "notask entière" agit sur la notask elle-même.
    btn.querySelectorAll('.agenda-item-actions button').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();  // sans ça, le clic ouvrirait aussi la notask
        const archiver = b.dataset.act === 'archive';
        // Dans les Archives, le même bouton fait l'inverse : il désarchive.
        const valeurArchive = modeArchive !== 'unarchive';
        try {
          if (t.kind === 'item') {
            await api(`/notes/${t.note_id}/items/${t.id}`, {
              method: 'PATCH',
              body: archiver ? { archived: valeurArchive } : { trashed: true },
            });
          } else if (archiver) {
            await api('/notes/' + t.note_id, { method: 'PATCH', body: { archived: true } });
          } else {
            await api('/notes/' + t.note_id, { method: 'DELETE' });
          }
        } catch (err) {
          alert(err.message);
          return;
        }
        rafraichir();
        updateTaskBadges();
      });
    });
  }

  btn.querySelector('input').onchange = async (e) => {
    e.stopPropagation();
    await api(`/tasks/${t.kind}/${t.id}`, { method: 'PATCH', body: { done: e.target.checked } });
    rafraichir();
    updateTaskBadges();
  };
  btn.addEventListener('click', (e) => {
    if (e.target.closest('input')) return;
    ouvrirNoteParId(t.note_id);
  });
  // Avant, un vrai <button> gérait Entrée/Espace nativement — repris à
  // la main puisque ce n'en est plus un (voir plus haut, HTML interdit
  // un <input> dans un <button>).
  btn.addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ouvrirNoteParId(t.note_id);
    }
  });
  return btn;
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

/* --------------------- Comptes : config Google Calendar --------------------
   Une seule ligne pour toute l'installation (voir GoogleAppConfig côté
   serveur) — Client ID/Secret OAuth, alternative aux variables
   d'environnement GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET. Chargée à chaque
   ouverture de l'onglet Comptes (voir switchView('admin') plus haut). */
async function loadGoogleAdminConfig() {
  msg($('#ga-msg'), '');
  try {
    const cfg = await api('/google/admin-config');
    $('#ga-client-id').value = cfg.client_id || '';
    $('#ga-client-secret').value = '';
    $('#ga-client-secret').placeholder = cfg.has_secret
      ? '••••••••  (laisser vide pour ne pas changer)'
      : '(non renseigné)';
    const src = { database: 'configuré depuis cet écran', environment: 'configuré via une variable d’environnement', none: 'non configuré' }[cfg.source] || '';
    $('#admin-google-source').textContent = src ? `Statut : ${src}.` : '';
  } catch (err) {
    $('#admin-google-source').textContent = 'Statut indisponible : ' + err.message;
  }
}

$('#ga-save').addEventListener('click', async () => {
  const clientId = $('#ga-client-id').value.trim();
  if (!clientId) return msg($('#ga-msg'), 'Le Client ID est obligatoire.');
  try {
    await api('/google/admin-config', {
      method: 'PUT',
      body: { client_id: clientId, client_secret: $('#ga-client-secret').value.trim() || null },
    });
    msg($('#ga-msg'), 'Enregistré.', 'ok');
    loadGoogleAdminConfig();
  } catch (err) {
    msg($('#ga-msg'), err.message);
  }
});

$('#ga-clear').addEventListener('click', async () => {
  if (!confirm('Effacer la configuration Google Calendar de cette installation ?\n(Les comptes déjà connectés restent connectés ; seule la création de nouvelles connexions sera bloquée, sauf si des variables d’environnement GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET existent encore.)')) return;
  try {
    await api('/google/admin-config', { method: 'DELETE' });
    msg($('#ga-msg'), 'Configuration effacée.', 'ok');
    loadGoogleAdminConfig();
  } catch (err) {
    msg($('#ga-msg'), err.message);
  }
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

/* ------------------------ Outils : export / import ------------------------
   Sauvegarde complète de l'application dans un fichier unique, chiffré par
   un mot de passe choisi ici — volontairement INDÉPENDANT de celui du
   compte : l'archive doit rester lisible même si le compte est perdu, or
   la clé des notasks (DEK) est justement enveloppée par le mot de passe du
   compte. Le contenu est donc déchiffré côté client, puis rechiffré pour
   l'archive.

   Format : "NOTASKX1" | sel (16 o) | iv (12 o) | AES-GCM(JSON compressé
   en UTF-8). Sel et itérations PBKDF2 sont dans le fichier plutôt que
   codés en dur, pour qu'un futur changement de paramètres n'empêche pas de
   relire les archives déjà produites. */

const EXPORT_MAGIC = 'NOTASKX1';
const EXPORT_ITERATIONS = 210000;

async function deriveArchiveKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: EXPORT_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/* Rassemble tout le contenu EN CLAIR : notasks (y compris archivées et en
   corbeille), leurs lignes, leurs pièces jointes déchiffrées, les libellés
   et les réglages. */
async function collecterExport(progres) {
  progres('Lecture des libellés…');
  const labels = await api('/labels');

  progres('Lecture des notasks…');
  const lots = await Promise.all([
    api('/notes?' + new URLSearchParams({ archived: false })),
    api('/notes?' + new URLSearchParams({ archived: true })),
    api('/notes?' + new URLSearchParams({ trashed: true })),
  ]);
  const notes = [].concat(...lots);
  await Promise.all(notes.map(decryptNote));

  let reglages = {};
  try { reglages = await api('/settings'); } catch { reglages = {}; }

  const notesExport = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    progres(`Pièces jointes… (${i + 1}/${notes.length})`);
    const pieces = [];
    for (const att of (n.attachments || [])) {
      try {
        const r = await loadAttachment(att);
        pieces.push({
          name: r.name,
          mime: r.mime,
          data: bytesToBase64(new Uint8Array(await r.blob.arrayBuffer())),
        });
      } catch {
        // Fichier illisible (disparu du disque, clé changée) : on
        // n'interrompt pas toute la sauvegarde pour autant.
      }
    }
    notesExport.push({
      title: n.title, description: n.description, content: n.content,
      color: n.color, pinned: n.pinned, archived: n.archived,
      is_checklist: n.is_checklist, due_at: n.due_at, icon: n.icon,
      label_ids: n.label_ids || [],
      trashed: !!n.trashed_at,
      items: (n.items || []).map((it) => ({
        text: it.text, checked: it.checked, due_at: it.due_at,
        calendar_title: it.due_at ? it.text : null,
      })),
      attachments: pieces,
    });
  }

  return {
    format: EXPORT_MAGIC,
    exported_at: new Date().toISOString(),
    // `id` conservé : les notasks référencent leurs libellés par
    // identifiant, il faut pouvoir refaire le lien à l'import (voir
    // nomParAncienId). Ces identifiants ne servent qu'à ça, ils n'ont
    // aucune valeur sur une autre installation.
    labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color, position: l.position })),
    notes: notesExport,
    settings: reglages,
  };
}

$('#btn-outils').addEventListener('click', () => {
  $('#archive-pw').value = '';
  $('#import-file').value = '';
  msg($('#outil-msg'), '');
  majCompteJournal();
  $('#dlg-outils').showModal();
  animerOuvertureDialogue($('#dlg-outils'));
});

/* ------------------------- Fenêtre de journal ------------------------- */

const LOGS_NIVEAUX = {
  error: { libelle: 'ERREUR', classe: 'est-error' },
  warn: { libelle: 'AVERT.', classe: 'est-warn' },
  info: { libelle: 'INFO', classe: 'est-info' },
  debug: { libelle: 'DÉTAIL', classe: 'est-debug' },
};

// 'debug' décoché par défaut : il contient un appel réussi par requête et
// noierait les lignes réellement utiles.
let logsNiveauxActifs = new Set(['error', 'warn', 'info']);

function majCompteJournal() {
  const erreurs = journal.filter((e) => e.niveau === 'error').length;
  const el = $('#logs-compte');
  if (!el) return;
  el.textContent = erreurs
    ? `${erreurs} erreur${erreurs > 1 ? 's' : ''} enregistrée${erreurs > 1 ? 's' : ''}`
    : `${journal.length} entrée${journal.length > 1 ? 's' : ''}`;
  el.classList.toggle('a-des-erreurs', erreurs > 0);
}

function horodatageJournal(d) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function entreesJournalFiltrees() {
  const q = ($('#logs-recherche').value || '').trim().toLowerCase();
  return journal.filter((e) => {
    if (!logsNiveauxActifs.has(e.niveau)) return false;
    if (!q) return true;
    return (e.message + ' ' + e.source + ' ' + e.detail).toLowerCase().includes(q);
  });
}

function renderJournal() {
  const box = $('#logs-liste');
  if (!box) return;
  const entrees = entreesJournalFiltrees();
  box.innerHTML = '';

  if (!entrees.length) {
    box.innerHTML = '<p class="logs-vide">Aucune entrée pour ces filtres.</p>';
    return;
  }

  // Plus récent en haut : on ouvre le journal pour voir ce qui vient de se
  // passer, pas pour faire défiler l'historique depuis le démarrage.
  for (const e of [...entrees].reverse()) {
    const meta = LOGS_NIVEAUX[e.niveau] || LOGS_NIVEAUX.info;
    const ligne = document.createElement('div');
    ligne.className = `logs-ligne ${meta.classe}`;
    ligne.innerHTML = `
      <span class="logs-heure">${horodatageJournal(e.ts)}</span>
      <span class="logs-niveau">${meta.libelle}</span>
      <span class="logs-source">${escapeHtml(e.source)}</span>
      <span class="logs-message">${escapeHtml(e.message)}</span>`;
    if (e.detail) {
      // Détail replié : une pile d'appels par ligne rendrait la liste
      // illisible alors qu'on ne l'ouvre que sur une entrée à la fois.
      const det = document.createElement('details');
      det.className = 'logs-detail';
      det.innerHTML = `<summary>détail</summary><pre>${escapeHtml(e.detail)}</pre>`;
      ligne.appendChild(det);
    }
    box.appendChild(ligne);
  }
}

// Rafraîchissement en direct, uniquement quand la fenêtre est ouverte :
// re-rendre la liste à chaque entrée alors qu'elle est fermée serait du
// travail pur perte.
journalAuChangement = () => {
  majCompteJournal();
  if ($('#dlg-logs').open) renderJournal();
};

$('#logs-open').addEventListener('click', () => {
  renderJournal();
  $('#dlg-logs').showModal();
  animerOuvertureDialogue($('#dlg-logs'));
});

$('#logs-filtres').addEventListener('click', (e) => {
  const chip = e.target.closest('.logs-chip');
  if (!chip) return;
  const niveau = chip.dataset.niveau;
  if (logsNiveauxActifs.has(niveau)) logsNiveauxActifs.delete(niveau);
  else logsNiveauxActifs.add(niveau);
  chip.classList.toggle('is-on');
  renderJournal();
});

$('#logs-recherche').addEventListener('input', renderJournal);

$('#logs-vider').addEventListener('click', () => {
  journal.length = 0;
  majCompteJournal();
  renderJournal();
});

$('#logs-copier').addEventListener('click', async () => {
  // Texte brut : c'est ce qu'on colle dans un rapport de bug. On copie ce
  // qui est FILTRÉ à l'écran, pas tout le journal — sinon le filtre qu'on
  // vient de poser pour isoler le problème ne servirait à rien.
  const texte = entreesJournalFiltrees()
    .map((e) => `${e.ts.toISOString()} [${e.niveau.toUpperCase()}] ${e.source} — ${e.message}`
      + (e.detail ? `\n${e.detail}` : ''))
    .join('\n');
  const entete = `notask ${APP_VERSION} — ${navigator.userAgent}\n\n`;
  try {
    await navigator.clipboard.writeText(entete + texte);
    $('#logs-copier').textContent = 'Copié';
    setTimeout(() => { $('#logs-copier').textContent = 'Copier'; }, 1500);
  } catch {
    // Presse-papiers refusé (contexte non sécurisé, permission) : on ne
    // laisse pas l'utilisateur sans solution.
    alert("Copie impossible depuis ce navigateur. Sélectionnez le texte à la main.");
  }
});

$('#logs-fermer').addEventListener('click', () => fermerAvecAnimation($('#dlg-logs')));
$('#dlg-logs').addEventListener('click', (e) => {
  if (e.target === $('#dlg-logs')) fermerAvecAnimation($('#dlg-logs'));
});
$('#dlg-logs').addEventListener('cancel', (e) => {
  e.preventDefault();
  fermerAvecAnimation($('#dlg-logs'));
});
$('#dlg-outils').addEventListener('click', (e) => {
  if (e.target === $('#dlg-outils')) fermerAvecAnimation($('#dlg-outils'));
});
$('#dlg-outils').addEventListener('cancel', (e) => {
  e.preventDefault();
  fermerAvecAnimation($('#dlg-outils'));
});

$('#export-run').addEventListener('click', async () => {
  const pw = $('#archive-pw').value;
  if (pw.length < 8) return msg($('#outil-msg'), 'Mot de passe : 8 caractères minimum.');

  const btn = $('#export-run');
  btn.disabled = true;
  try {
    const avancement = (t) => msg($('#outil-msg'), t, 'ok');
    const donnees = await collecterExport(avancement);

    avancement('Chiffrement…');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveArchiveKey(pw, salt);
    const clair = new TextEncoder().encode(JSON.stringify(donnees));
    const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, clair));

    const entete = new TextEncoder().encode(EXPORT_MAGIC);
    const fichier = new Uint8Array(entete.length + salt.length + iv.length + chiffre.length);
    fichier.set(entete, 0);
    fichier.set(salt, entete.length);
    fichier.set(iv, entete.length + salt.length);
    fichier.set(chiffre, entete.length + salt.length + iv.length);

    const url = URL.createObjectURL(new Blob([fichier], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `notask-${new Date().toISOString().slice(0, 10)}.notask`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);

    msg($('#outil-msg'), `Archive créée : ${donnees.notes.length} notask(s), ${donnees.labels.length} libellé(s).`, 'ok');
  } catch (err) {
    msg($('#outil-msg'), err.message);
  } finally {
    btn.disabled = false;
  }
});

/* "Importer" n'importe pas directement : il ouvre le sélecteur de fichier,
   et c'est le choix du fichier qui déclenche l'opération. Un bouton
   "Parcourir" séparé n'apportait rien. */
$('#import-run').addEventListener('click', () => {
  if (!$('#archive-pw').value) return msg($('#outil-msg'), 'Saisissez le mot de passe de l’archive.');
  $('#import-file').value = '';   // permet de rechoisir le même fichier
  $('#import-file').click();
});

$('#import-file').addEventListener('change', async () => {
  const fichier = $('#import-file').files[0];
  const pw = $('#archive-pw').value;
  if (!fichier || !pw) return;

  const btn = $('#import-run');
  btn.disabled = true;
  try {
    const octets = new Uint8Array(await fichier.arrayBuffer());
    const entete = new TextDecoder().decode(octets.slice(0, EXPORT_MAGIC.length));
    if (entete !== EXPORT_MAGIC) throw new Error("Ce fichier n'est pas une archive notask.");

    const salt = octets.slice(EXPORT_MAGIC.length, EXPORT_MAGIC.length + 16);
    const iv = octets.slice(EXPORT_MAGIC.length + 16, EXPORT_MAGIC.length + 28);
    const chiffre = octets.slice(EXPORT_MAGIC.length + 28);
    const key = await deriveArchiveKey(pw, salt);

    let donnees;
    try {
      const clair = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, chiffre);
      donnees = JSON.parse(new TextDecoder().decode(clair));
    } catch {
      // AES-GCM échoue à l'authentification : mot de passe faux, ou
      // fichier abîmé. Impossible de distinguer les deux, on le dit.
      throw new Error('Mot de passe incorrect, ou archive endommagée.');
    }

    msg($('#outil-msg'), 'Création des libellés…', 'ok');
    // Les identifiants de libellés de l'archive n'ont aucun sens ici : on
    // recrée les manquants et on garde une table de correspondance
    // nom -> nouvel identifiant pour rattacher les notasks.
    const existants = await api('/labels');
    const parNom = new Map(existants.map((l) => [l.name, l.id]));
    for (const l of (donnees.labels || [])) {
      if (parNom.has(l.name)) continue;
      try {
        const cree = await api('/labels', { method: 'POST', body: { name: l.name, color: l.color } });
        parNom.set(cree.name, cree.id);
      } catch { /* doublon ou nom refusé : on continue */ }
    }
    // Ancien identifiant -> nom : c'est par identifiant que les notasks
    // référencent leurs libellés, et ces identifiants n'ont aucun sens sur
    // cette installation. Le nom sert de pivot.
    const nomParAncienId = new Map();
    (donnees.labels || []).forEach((l) => nomParAncienId.set(l.id, l.name));

    /* Les notasks qui étaient en corbeille au moment de l'export
       (`trashed`) reviennent ici en notasks ordinaires : réimporter
       directement dans la corbeille les exposerait à la purge automatique
       des 30 jours, et on importe justement pour récupérer du contenu. Le
       drapeau reste dans l'archive, à titre d'information. */
    const notes = donnees.notes || [];
    let faits = 0, echecs = 0;
    for (const n of notes) {
      msg($('#outil-msg'), `Import des notasks… (${faits + echecs + 1}/${notes.length})`, 'ok');
      try {
        const body = {
          title: await encryptField(n.title || ''),
          description: await encryptField(n.description || ''),
          content: n.is_checklist ? '' : await encryptField(n.content || ''),
          color: n.color || 'default',
          pinned: !!n.pinned,
          archived: !!n.archived,
          is_checklist: !!n.is_checklist,
          due_at: n.due_at || null,
          calendar_title: n.due_at ? (n.title || '') : null,
          icon: n.icon || null,
          label_ids: (n.label_ids || [])
            .map((ancienId) => parNom.get(nomParAncienId.get(ancienId)))
            .filter((v) => v !== undefined),
          items: n.is_checklist
            ? await Promise.all((n.items || []).map(async (it) => ({
              text: await encryptField(it.text || ''),
              checked: !!it.checked,
              due_at: it.due_at || null,
              calendar_title: it.due_at ? (it.text || '') : null,
            })))
            : [],
        };
        const cree = await api('/notes', { method: 'POST', body });

        for (const p of (n.attachments || [])) {
          const octetsPj = base64ToBytes(p.data);
          const f = new File([octetsPj], p.name || 'fichier', { type: p.mime || 'application/octet-stream' });
          try { await uploadAttachment(cree.id, f); } catch { /* pièce jointe perdue, notask conservée */ }
        }
        faits += 1;
      } catch {
        echecs += 1;
      }
    }

    if (donnees.settings && Object.keys(donnees.settings).length) {
      try { await api('/settings', { method: 'PATCH', body: donnees.settings }); } catch { /* non bloquant */ }
    }

    await loadLabels();
    await loadNotes();
    msg($('#outil-msg'),
      `Import terminé : ${faits} notask(s) ajoutée(s)${echecs ? `, ${echecs} en échec` : ''}.`,
      echecs ? 'error' : 'ok');
  } catch (err) {
    msg($('#outil-msg'), err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------------------- Mot de passe ---------------------------- */

/* Appelée depuis la boîte Profil (le bouton dédié de l'en-tête a été
   remplacé par les entrées Profil/Outils). */
function ouvrirChangementMotDePasse() {
  $('#dp-current').value = ''; $('#dp-new').value = ''; $('#dp-new2').value = '';
  msg($('#dp-msg'), '');
  $('#dlg-password').showModal();
}

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
