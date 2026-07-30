/* notask — interface web. Vanilla JS, aucun framework. */

const TOKEN_KEY = 'notask_token';
const COLORS = ['default','red','orange','yellow','green','teal','blue','purple','pink','brown','grey'];

let state = {
  user: null,
  notes: [],
  showArchived: false,
  search: '',
  lists: [],
  currentListId: null,
  tasks: [],
  editingNote: null,
  editingNoteItems: [],
  editingTask: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

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

function todayISO() { return new Date().toISOString().slice(0, 10); }

function formatDue(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
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
  switchView('notes');
  if (state.user.must_change_password) {
    $('#dlg-password').showModal();
    msg($('#dp-msg'), 'Votre mot de passe a été défini par un administrateur. Choisissez-en un nouveau.', 'ok');
  }
}

function switchView(view) {
  $$('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#view-notes').hidden = view !== 'notes';
  $('#view-tasks').hidden = view !== 'tasks';
  $('#view-admin').hidden = view !== 'admin';
  if (view === 'notes') loadNotes();
  if (view === 'tasks') loadLists();
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
$$('nav.tabs button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

/* -------------------------------- Notes -------------------------------- */

async function loadNotes() {
  const params = new URLSearchParams({ archived: state.showArchived });
  if (state.search) params.set('q', state.search);
  state.notes = await api('/notes?' + params);
  renderNotes();
}

function renderNotes() {
  const grid = $('#notes-grid');
  grid.innerHTML = '';
  $('#notes-empty').hidden = state.notes.length > 0;

  for (const n of state.notes) {
    const el = document.createElement('article');
    el.className = 'note c-' + n.color;

    let inner = '';
    if (n.pinned) inner += '<span class="pin-mark">épinglée</span>';
    if (n.title) inner += `<h3>${escapeHtml(n.title)}</h3>`;

    if (n.is_checklist) {
      inner += '<ul class="check">';
      for (const it of n.items) {
        inner += `<li class="${it.checked ? 'done' : ''}" data-item="${it.id}">
          <input type="checkbox" ${it.checked ? 'checked' : ''}><span>${escapeHtml(it.text)}</span></li>`;
      }
      inner += '</ul>';
    } else if (n.content) {
      inner += `<div class="body">${escapeHtml(n.content)}</div>`;
    }

    inner += `<div class="actions">
      <button data-act="edit">Modifier</button>
      <button data-act="pin">${n.pinned ? 'Désépingler' : 'Épingler'}</button>
      <button data-act="archive">${n.archived ? 'Désarchiver' : 'Archiver'}</button>
      <button data-act="delete">Supprimer</button>
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

    el.querySelectorAll('ul.check li').forEach((li) => {
      li.querySelector('input').onchange = async (ev) => {
        const items = n.items.map((i) => ({
          id: i.id,
          text: i.text,
          checked: i.id === Number(li.dataset.item) ? ev.target.checked : i.checked,
        }));
        await api('/notes/' + n.id, { method: 'PATCH', body: { items } });
        loadNotes();
      };
    });

    grid.appendChild(el);
  }
}

$('#nc-add').addEventListener('click', async () => {
  const title = $('#nc-title').value.trim();
  const content = $('#nc-content').value.trim();
  const isChecklist = $('#nc-checklist').checked;
  if (!title && !content) return;

  const body = { title, content: isChecklist ? '' : content, is_checklist: isChecklist, items: [] };
  if (isChecklist) {
    body.items = content.split('\n').filter((l) => l.trim()).map((l) => ({ text: l.trim(), checked: false }));
  }
  await api('/notes', { method: 'POST', body });
  $('#nc-title').value = ''; $('#nc-content').value = ''; $('#nc-checklist').checked = false;
  loadNotes();
});

let searchTimer;
$('#notes-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = e.target.value.trim(); loadNotes(); }, 250);
});

$('#btn-archived').addEventListener('click', () => {
  state.showArchived = !state.showArchived;
  $('#btn-archived').textContent = state.showArchived ? 'Voir les notes actives' : 'Voir les archives';
  loadNotes();
});

/* --- Dialogue note --- */

function openNoteDialog(note) {
  state.editingNote = note;
  state.editingNoteItems = note.items.map((i) => ({ text: i.text, checked: i.checked }));

  $('#dn-title').value = note.title;
  $('#dn-content').value = note.content;
  $('#dn-content-field').hidden = note.is_checklist;
  $('#dn-items-field').hidden = !note.is_checklist;

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

function renderNoteItems() {
  const box = $('#dn-items');
  box.innerHTML = '';
  state.editingNoteItems.forEach((item, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:.4rem;align-items:center;margin-bottom:.35rem';
    row.innerHTML = `<input type="checkbox" ${item.checked ? 'checked' : ''}>
      <input type="text" value="${escapeHtml(item.text)}" style="flex:1">
      <button class="btn ghost sm" type="button">✕</button>`;
    row.children[0].onchange = (e) => { state.editingNoteItems[idx].checked = e.target.checked; };
    row.children[1].oninput = (e) => { state.editingNoteItems[idx].text = e.target.value; };
    row.children[2].onclick = () => { state.editingNoteItems.splice(idx, 1); renderNoteItems(); };
    box.appendChild(row);
  });
}

$('#dn-add-item').addEventListener('click', () => {
  state.editingNoteItems.push({ text: '', checked: false });
  renderNoteItems();
});

$('#dn-cancel').addEventListener('click', () => $('#dlg-note').close());

$('#dn-save').addEventListener('click', async () => {
  const n = state.editingNote;
  const body = { title: $('#dn-title').value, color: n.color };
  if (n.is_checklist) {
    body.items = state.editingNoteItems.filter((i) => i.text.trim());
  } else {
    body.content = $('#dn-content').value;
  }
  await api('/notes/' + n.id, { method: 'PATCH', body });
  $('#dlg-note').close();
  loadNotes();
});

/* -------------------------------- Tâches -------------------------------- */

async function loadLists() {
  state.lists = await api('/lists');
  if (!state.currentListId || !state.lists.some((l) => l.id === state.currentListId)) {
    state.currentListId = state.lists[0].id;
  }
  renderLists();
  loadTasks();
}

function renderLists() {
  const box = $('#lists-container');
  box.innerHTML = '';
  for (const l of state.lists) {
    const b = document.createElement('button');
    b.className = 'list-item' + (l.id === state.currentListId ? ' active' : '');
    b.textContent = l.title;
    b.onclick = () => { state.currentListId = l.id; renderLists(); loadTasks(); };
    box.appendChild(b);
  }
  const cur = state.lists.find((l) => l.id === state.currentListId);
  $('#list-title').textContent = cur ? cur.title : '';
}

async function loadTasks() {
  state.tasks = await api(`/lists/${state.currentListId}/tasks`);
  renderTasks();
}

function renderTasks() {
  const ul = $('#tasks-list');
  ul.innerHTML = '';
  $('#tasks-empty').hidden = state.tasks.length > 0;

  const parents = state.tasks.filter((t) => t.parent_id === null);
  const childrenOf = (id) => state.tasks.filter((t) => t.parent_id === id);

  const draw = (t, isSub) => {
    const li = document.createElement('li');
    li.className = 'task' + (t.completed ? ' done' : '') + (isSub ? ' sub' : '');

    const late = t.due_date && !t.completed && t.due_date < todayISO();
    let meta = '';
    if (t.due_date) meta += `<span class="${late ? 'late' : ''}">${formatDue(t.due_date)}${late ? ' — en retard' : ''}</span>`;
    if (t.details) meta += `<span>${escapeHtml(t.details.slice(0, 60))}${t.details.length > 60 ? '…' : ''}</span>`;

    li.innerHTML = `
      <input type="checkbox" ${t.completed ? 'checked' : ''}>
      <div class="t-main">
        <div class="t-title">${t.starred ? '★ ' : ''}${escapeHtml(t.title)}</div>
        ${meta ? `<div class="t-meta">${meta}</div>` : ''}
      </div>
      <div class="t-actions">
        <button data-act="star">${t.starred ? '★' : '☆'}</button>
        ${isSub ? '' : '<button data-act="sub">+ sous-tâche</button>'}
        <button data-act="edit">Modifier</button>
        <button data-act="del">✕</button>
      </div>`;

    li.querySelector('input').onchange = async (e) => {
      await api('/tasks/' + t.id, { method: 'PATCH', body: { completed: e.target.checked } });
      loadTasks();
    };
    li.querySelector('[data-act=star]').onclick = async () => {
      await api('/tasks/' + t.id, { method: 'PATCH', body: { starred: !t.starred } });
      loadTasks();
    };
    li.querySelector('[data-act=edit]').onclick = () => openTaskDialog(t);
    li.querySelector('[data-act=del]').onclick = async () => {
      await api('/tasks/' + t.id, { method: 'DELETE' });
      loadTasks();
    };
    const subBtn = li.querySelector('[data-act=sub]');
    if (subBtn) subBtn.onclick = async () => {
      const title = prompt('Titre de la sous-tâche :');
      if (!title || !title.trim()) return;
      await api(`/lists/${state.currentListId}/tasks`, {
        method: 'POST', body: { title: title.trim(), parent_id: t.id },
      });
      loadTasks();
    };

    ul.appendChild(li);
    if (!isSub) childrenOf(t.id).forEach((c) => draw(c, true));
  };

  parents.forEach((t) => draw(t, false));
}

$('#btn-add-task').addEventListener('click', async () => {
  const title = $('#task-input').value.trim();
  if (!title) return;
  const due = $('#task-due').value || null;
  await api(`/lists/${state.currentListId}/tasks`, { method: 'POST', body: { title, due_date: due } });
  $('#task-input').value = ''; $('#task-due').value = '';
  loadTasks();
});

$('#task-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-add-task').click(); });

$('#btn-new-list').addEventListener('click', async () => {
  const title = prompt('Nom de la nouvelle liste :');
  if (!title || !title.trim()) return;
  const tl = await api('/lists', { method: 'POST', body: { title: title.trim() } });
  state.currentListId = tl.id;
  loadLists();
});

$('#btn-rename-list').addEventListener('click', async () => {
  const cur = state.lists.find((l) => l.id === state.currentListId);
  const title = prompt('Nouveau nom :', cur.title);
  if (!title || !title.trim()) return;
  await api('/lists/' + cur.id, { method: 'PATCH', body: { title: title.trim() } });
  loadLists();
});

$('#btn-delete-list').addEventListener('click', async () => {
  if (!confirm('Supprimer cette liste et toutes ses tâches ?')) return;
  try {
    await api('/lists/' + state.currentListId, { method: 'DELETE' });
    state.currentListId = null;
    loadLists();
  } catch (err) { alert(err.message); }
});

$('#btn-clear-done').addEventListener('click', async () => {
  await api(`/lists/${state.currentListId}/clear-completed`, { method: 'POST' });
  loadTasks();
});

function openTaskDialog(task) {
  state.editingTask = task;
  $('#dt-title').value = task.title;
  $('#dt-details').value = task.details || '';
  $('#dt-due').value = task.due_date || '';
  $('#dlg-task').showModal();
}

$('#dt-cancel').addEventListener('click', () => $('#dlg-task').close());

$('#dt-save').addEventListener('click', async () => {
  await api('/tasks/' + state.editingTask.id, {
    method: 'PATCH',
    body: {
      title: $('#dt-title').value.trim(),
      details: $('#dt-details').value,
      due_date: $('#dt-due').value || null,
    },
  });
  $('#dlg-task').close();
  loadTasks();
});

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
