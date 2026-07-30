/* notask — interface web. Vanilla JS, aucun framework. */

const TOKEN_KEY = 'notask_token';
const COLORS = [
  'default', 'red', 'coral', 'orange', 'amber', 'yellow', 'lime',
  'green', 'emerald', 'teal', 'cyan', 'blue', 'indigo', 'violet',
  'purple', 'magenta', 'pink', 'rose', 'brown', 'slate', 'grey',
];

let state = {
  user: null,
  view: 'notes',
  notes: [],
  showArchived: false,
  search: '',
  tasks: [],
  editingNote: null,
  editingNoteItems: [],
  labels: [],
  labelFilter: null,
  editingLabelIds: [],
};

const BUCKET_LABELS = {
  late: 'En retard',
  today: "Aujourd'hui",
  upcoming: 'À venir',
  done: 'Terminées',
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
     l'ampoule de Keep. */
  spoon: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="8" rx="5.5" ry="6.5" fill="#ffd54f"/><ellipse cx="12" cy="7.6" rx="3.4" ry="4.2" fill="#ffe082"/><rect x="10.3" y="13" width="3.4" height="7.6" rx="1.7" fill="#ffd54f"/></svg>',
  /* Même cuillère, en bleu — posée à côté de la jaune dans le logo. */
  spoonBlue: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="8" rx="5.5" ry="6.5" fill="#42a5f5"/><ellipse cx="12" cy="7.6" rx="3.4" ry="4.2" fill="#90caf9"/><rect x="10.3" y="13" width="3.4" height="7.6" rx="1.7" fill="#42a5f5"/></svg>',

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

/* Conversions entre <input type="datetime-local"> (heure locale, sans fuseau)
   et l'ISO 8601 en UTC attendu par l'API. */
function isoToLocalInput(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(value) {
  return value ? new Date(value).toISOString() : null;
}

/* Popup de sélection date + heure, ancré sous l'icône calendrier qui l'ouvre.
   Une seule instance à la fois ; se ferme au clic extérieur ou sur Échap. */
let _closeCalPopup = null;

function closeCalPopup() {
  if (_closeCalPopup) { _closeCalPopup(); _closeCalPopup = null; }
}

function openCalPopup(anchor, currentIso, onChange) {
  closeCalPopup();

  const pop = document.createElement('div');
  pop.className = 'cal-popup';
  pop.innerHTML = `
    <input type="datetime-local" class="cal-popup-input">
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

  const input = pop.querySelector('.cal-popup-input');
  input.value = isoToLocalInput(currentIso);

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

  const finish = (iso) => { onChange(iso); closeCalPopup(); };
  pop.querySelector('[data-act=ok]').onclick = () => finish(localInputToIso(input.value));
  pop.querySelector('[data-act=clear]').onclick = () => finish(null);

  const onOutside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) closeCalPopup(); };
  const onKey = (e) => { if (e.key === 'Escape') closeCalPopup(); };
  setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
  document.addEventListener('keydown', onKey);

  _closeCalPopup = () => {
    pop.remove();
    document.removeEventListener('mousedown', onOutside);
    document.removeEventListener('keydown', onKey);
  };

  input.focus();
}

function show(id) {
  ['screen-setup', 'screen-login', 'screen-app'].forEach((s) => { $('#' + s).hidden = s !== id; });
}

/* ------------------------------ Écrans ------------------------------ */

function showLogin() { show('screen-login'); }

async function boot() {
  const status = await fetch('/api/auth/status', { cache: 'no-store' }).then((r) => r.json());
  if (status.needs_setup) { show('screen-setup'); return; }

  if (!token()) { showLogin(); return; }
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
  $('#nav-notes').innerHTML =
    `<span class="spoon-pair">${ICONS.spoon}${ICONS.spoonBlue}</span><span class="label">Notes</span>`;
  $('#nav-archives').innerHTML = ICONS.archive + '<span class="label">Archives</span>';
  $('#nav-tasks').innerHTML = ICONS.tasks + '<span class="label">Toutes</span>';
  $('#nav-late').innerHTML = ICONS.late + '<span class="label">En retard</span>';
  $('#nav-today').innerHTML = ICONS.today + '<span class="label">Aujourd\'hui</span>';
  $('#nav-done').innerHTML = ICONS.check + '<span class="label">Terminées</span>';
  $('#tab-admin').innerHTML = ICONS.users + '<span class="label">Comptes</span>';

  loadLabels();
  switchView('notes');
  if (state.user.must_change_password) {
    $('#dlg-password').showModal();
    msg($('#dp-msg'), 'Votre mot de passe a été défini par un administrateur. Choisissez-en un nouveau.', 'ok');
  }
}

const TASK_VIEWS = { tasks: null, late: 'late', today: 'today', done: 'done' };

function switchView(view) {
  state.view = view;
  $$('.drawer-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  const isNotes = view === 'notes' || view === 'archives';
  const isTasks = view in TASK_VIEWS;

  $('#view-notes').hidden = !isNotes;
  $('#view-tasks').hidden = !isTasks;
  $('#view-admin').hidden = view !== 'admin';

  if (isNotes) {
    state.showArchived = view === 'archives';
    $('#notes-empty').textContent = state.showArchived ? 'Aucune note archivée.' : 'Aucune note.';
    $('.note-composer').hidden = state.showArchived;  // on ne compose pas dans les archives
    loadNotes();
  }
  if (isTasks) {
    const titres = { tasks: 'Toutes les tâches', late: 'En retard', today: "Aujourd'hui", done: 'Terminées' };
    $('#tasks-title').textContent = titres[view];
    loadTasks(TASK_VIEWS[view]);
  }
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
    state.user = data.user;
    enterApp();
  } catch (err) { msg($('#setup-msg'), err.message); }
});

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: { username: $('#login-user').value, password: $('#login-pw').value },
    });
    setToken(data.access_token);
    state.user = data.user;
    $('#login-pw').value = '';
    msg($('#login-msg'), '');
    enterApp();
  } catch (err) { msg($('#login-msg'), err.message); }
});

$('#btn-logout').addEventListener('click', () => { setToken(null); location.reload(); });
$$('.drawer-item[data-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

/* -------------------------------- Notes -------------------------------- */

async function loadNotes() {
  const params = new URLSearchParams({ archived: state.showArchived });
  if (state.search) params.set('q', state.search);
  if (state.labelFilter) params.set('label', state.labelFilter);
  state.notes = await api('/notes?' + params);
  renderNotes();
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
    const btn = document.createElement('button');
    btn.className = 'drawer-item label-item' + (state.labelFilter === l.id ? ' active' : '');
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
    box.appendChild(btn);
  }
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

function renderNotes() {
  const grid = $('#notes-grid');
  grid.innerHTML = '';
  $('#notes-empty').hidden = state.notes.length > 0;

  for (const n of state.notes) {
    const el = document.createElement('article');
    el.className = 'note c-' + n.color + (n.pinned ? ' pinned' : '');

    let inner = `<button class="pin-btn" data-act="pin"
      title="${n.pinned ? 'Désépingler' : 'Épingler'}"
      aria-label="${n.pinned ? 'Désépingler' : 'Épingler'}">${n.pinned ? ICONS.pinFilled : ICONS.pin}</button>`;

    if (n.title) inner += `<h3>${escapeHtml(n.title)}</h3>`;

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
      inner += `<div class="body">${escapeHtml(n.content)}</div>`;
    }

    if (n.due_at) {
      const now = new Date();
      const late = !n.done && new Date(n.due_at) < now;
      inner += `<div class="note-due ${late ? 'late' : ''} ${n.done ? 'done' : ''}">
        <input type="checkbox" data-act="done" ${n.done ? 'checked' : ''} aria-label="Terminer">
        ${ICONS.clock}<span>${formatDue(n.due_at)}</span>
      </div>`;
    }

    if (n.label_ids && n.label_ids.length) {
      const noms = n.label_ids
        .map((id) => state.labels.find((l) => l.id === id))
        .filter(Boolean)
        .map((l) => `<span class="label-chip">${escapeHtml(l.name)}</span>`)
        .join('');
      if (noms) inner += `<div class="label-chips">${noms}</div>`;
    }

    inner += `<div class="palette" hidden></div>
      <div class="actions">
        <button data-act="color" title="Couleur" aria-label="Couleur">${ICONS.palette}</button>
        <button data-act="archive" title="${n.archived ? 'Désarchiver' : 'Archiver'}"
          aria-label="${n.archived ? 'Désarchiver' : 'Archiver'}">${n.archived ? ICONS.unarchive : ICONS.archive}</button>
        <button data-act="edit" title="Modifier" aria-label="Modifier">${ICONS.edit}</button>
        <span class="sep"></span>
        <button data-act="delete" title="Supprimer" aria-label="Supprimer">${ICONS.trash}</button>
      </div>`;

    el.innerHTML = inner;

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
      if (!confirm('Supprimer définitivement cette note ?')) return;
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

    el.querySelectorAll('ul.check li').forEach((li) => {
      li.querySelector('input').onchange = async (ev) => {
        await api(`/notes/${n.id}/items/${li.dataset.item}`, {
          method: 'PATCH', body: { checked: ev.target.checked },
        });
        loadNotes();
      };
    });

    grid.appendChild(el);
  }
}

/* Composeur — bascule entre texte libre et liste à cocher en direct : dès
   qu'on coche l'option, chaque ligne devient une case, comme dans Keep. */
let composerChecklist = false;
let composerItems = [{ text: '', checked: false }];

function resetComposer() {
  $('#nc-title').value = '';
  $('#nc-content').value = '';
  composerChecklist = false;
  composerItems = [{ text: '', checked: false }];
  renderComposer();
  msg($('#composer-msg'), '');
}

function renderComposer() {
  $('#nc-content').hidden = composerChecklist;
  $('#nc-items').hidden = !composerChecklist;
  $('#nc-add-item').hidden = !composerChecklist;
  $('#nc-toggle-checklist').classList.toggle('active-toggle', composerChecklist);
  $('#nc-cancel').hidden = !composerChecklist;
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

$('#nc-toggle-checklist').addEventListener('click', () => {
  if (!composerChecklist) {
    // Bascule depuis le texte libre : chaque ligne déjà tapée devient un élément.
    const lignes = $('#nc-content').value.split('\n').filter((l) => l.trim());
    composerItems = lignes.length
      ? lignes.map((l) => ({ text: l.trim(), checked: false }))
      : [{ text: '', checked: false }];
  }
  composerChecklist = !composerChecklist;
  renderComposer();
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
  const content = $('#nc-content').value.trim();
  const items = composerItems.filter((i) => i.text.trim());

  if (!title && !content && !(composerChecklist && items.length)) return;

  const body = {
    title,
    content: composerChecklist ? '' : content,
    is_checklist: composerChecklist,
    items: composerChecklist ? items : [],
  };

  try {
    await api('/notes', { method: 'POST', body });
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
  state.editingIsChecklist = note.is_checklist;
  state.editingNoteItems = note.items.map((i) => ({
    text: i.text, checked: i.checked, due_at: i.due_at,
  }));
  state.editingLabelIds = [...(note.label_ids || [])];
  renderNoteLabelChips();

  $('#dn-title').value = note.title;
  $('#dn-content').value = note.content;
  $('#dn-due').value = note.due_at || '';
  renderDialogMode();
  renderNoteDueBtn();

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
    };
    colors.appendChild(s);
  }

  renderNoteItems();
  $('#dlg-note').showModal();
}

/* Icône calendrier de la note : jaune dès qu'une échéance est réglée. */
function renderNoteDueBtn() {
  const iso = $('#dn-due').value || null;
  const btn = $('#dn-due-btn');
  if (!btn.innerHTML) btn.innerHTML = ICONS.calendar;
  btn.classList.toggle('has-due', !!iso);
  $('#dn-due-label').textContent = iso ? formatDue(iso) : 'Aucune échéance';
}

$('#dn-due-btn').addEventListener('click', () => {
  openCalPopup($('#dn-due-btn'), $('#dn-due').value || null, (iso) => {
    $('#dn-due').value = iso || '';
    renderNoteDueBtn();
  });
});

/* Bascule entre texte libre et liste à cocher, pour une note déjà existante. */
function renderDialogMode() {
  $('#dn-content-field').hidden = state.editingIsChecklist;
  $('#dn-items-field').hidden = !state.editingIsChecklist;
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

/* Chips de libellés dans le dialogue d'édition : un clic bascule
   l'appartenance de la note au libellé. */
function renderNoteLabelChips() {
  const box = $('#dn-labels');
  box.innerHTML = '';
  for (const l of state.labels) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'label-chip' + (state.editingLabelIds.includes(l.id) ? ' active' : '');
    chip.textContent = l.name;
    chip.onclick = () => {
      if (state.editingLabelIds.includes(l.id)) {
        state.editingLabelIds = state.editingLabelIds.filter((id) => id !== l.id);
      } else {
        state.editingLabelIds.push(l.id);
      }
      renderNoteLabelChips();
    };
    box.appendChild(chip);
  }
  if (!state.labels.length) {
    box.innerHTML = '<span class="hint">Aucun libellé — créez-en un dans le menu latéral.</span>';
  }
}

$('#dn-add-item').addEventListener('click', () => {
  state.editingNoteItems.push({ text: '', checked: false, due_at: null });
  renderNoteItems();
});

$('#dn-cancel').addEventListener('click', () => $('#dlg-note').close());

$('#dn-save').addEventListener('click', async () => {
  const n = state.editingNote;
  const body = {
    title: $('#dn-title').value,
    color: n.color,
    due_at: $('#dn-due').value || null,
    is_checklist: state.editingIsChecklist,
    label_ids: state.editingLabelIds,
  };
  if (state.editingIsChecklist) {
    body.items = state.editingNoteItems.filter((i) => i.text.trim());
    body.content = '';
  } else {
    body.content = $('#dn-content').value;
    body.items = [];
  }

  try {
    await api('/notes/' + n.id, { method: 'PATCH', body });
    $('#dlg-note').close();
    // Le dialogue s'ouvre aussi depuis la vue Tâches : on rafraîchit la bonne vue.
    if (state.view in TASK_VIEWS) loadTasks(TASK_VIEWS[state.view]);
    else loadNotes();
  } catch (err) {
    alert(err.message);
  }
});

/* -------------------------------- Tâches --------------------------------
   Aucune création ici : une tâche est une note datée, ou une ligne à cocher
   datée à l'intérieur d'une note. On ne fait que les lister et les cocher. */

async function loadTasks(bucket) {
  const params = new URLSearchParams();
  if (bucket) params.set('bucket', bucket);
  state.tasks = await api('/tasks' + (params.toString() ? '?' + params : ''));
  renderTasks();
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
        ? `<button class="task-origin" title="Ouvrir la note">
             ${ICONS.noteRef}<span>${escapeHtml(t.note_title || 'Note sans titre')}</span>
           </button>`
        : '';

      card.innerHTML = `
        <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Terminer">
        <div class="task-main">
          <div class="task-text">${escapeHtml(t.text)}</div>
          <div class="task-meta">
            <span class="${b === 'late' ? 'late' : ''}">${ICONS.clock}${formatDue(t.due_at)}</span>
          </div>
          ${origine}
        </div>`;

      card.querySelector('input').onchange = async (e) => {
        await api(`/tasks/${t.kind}/${t.id}`, { method: 'PATCH', body: { done: e.target.checked } });
        loadTasks(TASK_VIEWS[state.view]);
      };

      const lien = card.querySelector('.task-origin');
      if (lien) lien.onclick = () => ouvrirNoteParId(t.note_id);

      liste.appendChild(card);
    }
    grid.appendChild(liste);
  }
}

async function ouvrirNoteParId(noteId) {
  const note = await api('/notes/' + noteId);
  openNoteDialog(note);
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
    state.user.must_change_password = false;
    $('#dlg-password').close();
  } catch (err) { msg($('#dp-msg'), err.message); }
});

boot();
