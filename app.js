import { db } from './db.js';

const MOODS = [
  { id: 'great', emoji: '😄', label: '최고' },
  { id: 'good', emoji: '🙂', label: '좋음' },
  { id: 'okay', emoji: '😐', label: '보통' },
  { id: 'sad', emoji: '😢', label: '슬픔' },
  { id: 'angry', emoji: '😠', label: '화남' },
  { id: 'tired', emoji: '😴', label: '피곤' }
];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const $ = (sel) => document.querySelector(sel);
const el = {
  home: $('#home'), editor: $('#editor'), list: $('#list'), stats: $('#stats'),
  search: $('#search'), calendar: $('#calendar'), calGrid: $('#calGrid'), calTitle: $('#calTitle'),
  viewToggle: $('#viewToggle'), date: $('#date'), title: $('#title'), content: $('#content'),
  tags: $('#tags'), moods: $('#moods'), meta: $('#meta'), deleteBtn: $('#deleteBtn'),
  menu: $('#menu'), theme: $('#theme'), toast: $('#toast'), installBtn: $('#installBtn')
};

const state = {
  entries: [],
  query: '',
  calendarMode: false,
  calMonth: startOfMonth(new Date()),
  selectedDate: null,
  editing: null, // 편집 중인 일기 (새 일기는 id 없음)
  mood: null,
  dirty: false
};

/* ---------- 날짜 유틸 ---------- */
function toISO(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function fmtDateTime(ts) {
  return new Date(ts).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

/* ---------- 문자열 유틸 ---------- */
function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function highlight(text, q) {
  const safe = escapeHTML(text);
  if (!q) return safe;
  const re = new RegExp(escapeHTML(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}
function parseTags(s) {
  return [...new Set(s.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean))];
}
function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

/* ---------- 데이터 ---------- */
async function load() {
  state.entries = await db.all();
  sortEntries();
  render();
}
function sortEntries() {
  state.entries.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

/* ---------- 목록 렌더링 ---------- */
function filtered() {
  const q = state.query.trim().toLowerCase();
  return state.entries.filter((e) => {
    if (state.calendarMode && state.selectedDate && e.date !== state.selectedDate) return false;
    if (state.calendarMode && !state.selectedDate && !e.date.startsWith(toISO(state.calMonth).slice(0, 7))) return false;
    if (!q) return true;
    return [e.title, e.content, ...(e.tags || [])].some((f) => f.toLowerCase().includes(q));
  });
}

function render() {
  renderStats();
  if (state.calendarMode) renderCalendar();
  renderList();
}

function renderStats() {
  const n = state.entries.length;
  if (!n) { el.stats.textContent = ''; return; }
  // 연속 작성일 계산
  const days = new Set(state.entries.map((e) => e.date));
  let streak = 0;
  const d = new Date();
  if (!days.has(toISO(d))) d.setDate(d.getDate() - 1); // 오늘 아직 안 썼으면 어제부터
  while (days.has(toISO(d))) { streak++; d.setDate(d.getDate() - 1); }
  el.stats.textContent = `총 ${n}편의 일기` + (streak ? ` · 🔥 ${streak}일 연속 작성 중` : '');
}

function renderList() {
  const items = filtered();
  if (!items.length) {
    const msg = state.entries.length
      ? (state.query ? '검색 결과가 없어요.' : '이 기간에는 일기가 없어요.')
      : '아직 일기가 없어요.<br>오른쪽 아래 ✎ 버튼을 눌러 첫 일기를 써 보세요.';
    el.list.innerHTML = `<div class="empty"><div class="big">📖</div><p>${msg}</p></div>`;
    return;
  }
  const q = state.query.trim();
  let html = '';
  let lastMonth = '';
  for (const e of items) {
    const d = fromISO(e.date);
    const month = `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
    if (month !== lastMonth) { html += `<h2 class="month">${month}</h2>`; lastMonth = month; }
    const mood = MOODS.find((m) => m.id === e.mood);
    const tags = (e.tags || []).map((t) => `<span class="tag">#${highlight(t, q)}</span>`).join('');
    html += `
      <button class="card" data-id="${e.id}">
        <div class="day">
          <b>${d.getDate()}</b><small>${WEEKDAYS[d.getDay()]}요일</small>
          ${mood ? `<div class="mood">${mood.emoji}</div>` : ''}
        </div>
        <div class="body">
          <h3>${highlight(e.title || '제목 없음', q)}</h3>
          <p>${highlight(e.content.slice(0, 300), q)}</p>
          ${tags ? `<div class="tags">${tags}</div>` : ''}
        </div>
      </button>`;
  }
  el.list.innerHTML = html;
}

function renderCalendar() {
  const m = state.calMonth;
  el.calTitle.textContent = `${m.getFullYear()}년 ${m.getMonth() + 1}월`;
  const byDate = new Map();
  for (const e of state.entries) if (!byDate.has(e.date)) byDate.set(e.date, e);
  const start = new Date(m);
  start.setDate(1 - m.getDay());
  const today = toISO(new Date());
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = toISO(d);
    const entry = byDate.get(iso);
    const mood = entry && (MOODS.find((x) => x.id === entry.mood)?.emoji || '•');
    const cls = ['cal-day',
      d.getMonth() !== m.getMonth() && 'other',
      iso === today && 'today',
      iso === state.selectedDate && 'selected'].filter(Boolean).join(' ');
    html += `<button class="${cls}" data-date="${iso}"><span>${d.getDate()}</span><span class="dot">${mood || ''}</span></button>`;
  }
  el.calGrid.innerHTML = html;
}

/* ---------- 편집기 ---------- */
function renderMoods() {
  el.moods.innerHTML = MOODS.map((m) =>
    `<button type="button" class="mood-btn" role="radio" data-mood="${m.id}" aria-checked="${state.mood === m.id}">
      ${m.emoji}<small>${m.label}</small></button>`).join('');
}

function openEditor(entry, date) {
  state.editing = entry || { date: date || toISO(new Date()) };
  state.mood = state.editing.mood || null;
  state.dirty = false;
  el.date.value = state.editing.date;
  el.title.value = state.editing.title || '';
  el.content.value = state.editing.content || '';
  el.tags.value = (state.editing.tags || []).map((t) => '#' + t).join(' ');
  el.deleteBtn.hidden = !entry;
  el.meta.textContent = entry
    ? `작성 ${fmtDateTime(entry.createdAt)}` + (entry.updatedAt !== entry.createdAt ? ` · 수정 ${fmtDateTime(entry.updatedAt)}` : '')
    : '';
  renderMoods();
  el.home.hidden = true;
  el.editor.hidden = false;
  window.scrollTo(0, 0);
  history.pushState({ editor: true }, '');
  if (!entry) el.content.focus();
}

function closeEditor() {
  el.editor.hidden = true;
  el.home.hidden = false;
  state.editing = null;
  render();
}

async function save({ silent = false } = {}) {
  const title = el.title.value.trim();
  const content = el.content.value.trim();
  if (!title && !content) {
    if (!silent) toast('내용을 입력해 주세요.');
    return false;
  }
  const now = Date.now();
  const entry = {
    ...state.editing,
    id: state.editing.id || uid(),
    date: el.date.value || toISO(new Date()),
    title,
    content,
    mood: state.mood,
    tags: parseTags(el.tags.value),
    createdAt: state.editing.createdAt || now,
    updatedAt: now
  };
  await db.put(entry);
  const i = state.entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) state.entries[i] = entry; else state.entries.push(entry);
  sortEntries();
  state.editing = entry;
  state.dirty = false;
  toast('저장했어요 ✓');
  return true;
}

// 뒤로 가기 시 변경사항 자동 저장
async function goBack() {
  if (state.dirty) await save({ silent: true });
  if (history.state?.editor) history.back(); else closeEditor();
}

/* ---------- 이벤트 ---------- */
el.list.addEventListener('click', async (ev) => {
  const card = ev.target.closest('.card');
  if (card) openEditor(await db.get(card.dataset.id));
});

$('#newBtn').addEventListener('click', () => {
  openEditor(null, state.calendarMode && state.selectedDate ? state.selectedDate : undefined);
});

el.search.addEventListener('input', () => { state.query = el.search.value; renderList(); });

el.viewToggle.addEventListener('click', () => {
  state.calendarMode = !state.calendarMode;
  state.selectedDate = null;
  el.calendar.hidden = !state.calendarMode;
  el.viewToggle.textContent = state.calendarMode ? '☰' : '📅';
  el.viewToggle.title = state.calendarMode ? '목록 보기' : '달력 보기';
  render();
});

$('#calPrev').addEventListener('click', () => shiftMonth(-1));
$('#calNext').addEventListener('click', () => shiftMonth(1));
function shiftMonth(n) {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + n, 1);
  state.selectedDate = null;
  render();
}
el.calGrid.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.cal-day');
  if (!btn) return;
  const iso = btn.dataset.date;
  state.selectedDate = state.selectedDate === iso ? null : iso;
  const d = fromISO(iso);
  if (d.getMonth() !== state.calMonth.getMonth()) state.calMonth = startOfMonth(d);
  render();
});

el.moods.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.mood-btn');
  if (!btn) return;
  state.mood = state.mood === btn.dataset.mood ? null : btn.dataset.mood;
  state.dirty = true;
  renderMoods();
});

for (const input of [el.date, el.title, el.content, el.tags]) {
  input.addEventListener('input', () => { state.dirty = true; });
}

$('#saveBtn').addEventListener('click', async () => {
  if (await save()) {
    if (history.state?.editor) history.back(); else closeEditor();
  }
});
$('#backBtn').addEventListener('click', goBack);

el.deleteBtn.addEventListener('click', async () => {
  if (!state.editing?.id || !confirm('이 일기를 삭제할까요? 되돌릴 수 없어요.')) return;
  await db.remove(state.editing.id);
  state.entries = state.entries.filter((e) => e.id !== state.editing.id);
  state.dirty = false;
  toast('삭제했어요');
  if (history.state?.editor) history.back(); else closeEditor();
});

// 브라우저/안드로이드 뒤로 가기
window.addEventListener('popstate', async () => {
  if (!el.editor.hidden) {
    if (state.dirty) await save({ silent: true });
    closeEditor();
  }
});

// Ctrl/Cmd + S 저장
document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 's' && !el.editor.hidden) {
    ev.preventDefault();
    save();
  }
});

// 앱이 백그라운드로 갈 때 작성 중인 내용 보존
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !el.editor.hidden && state.dirty) save({ silent: true });
});

/* ---------- 설정: 테마 / 백업 ---------- */
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#14131a' : '#6c5ce7';
}
const savedTheme = (() => { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } })();
el.theme.value = savedTheme;
applyTheme(savedTheme);
el.theme.addEventListener('change', () => {
  try { localStorage.setItem('theme', el.theme.value); } catch { /* 무시 */ }
  applyTheme(el.theme.value);
});

$('#menuBtn').addEventListener('click', () => el.menu.showModal());

$('#exportBtn').addEventListener('click', () => {
  const data = JSON.stringify({ app: 'diary', version: 1, exportedAt: new Date().toISOString(), entries: state.entries }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `diary-backup-${toISO(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`${state.entries.length}편을 내보냈어요`);
});

$('#importInput').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const list = (Array.isArray(parsed) ? parsed : parsed.entries || [])
      .filter((e) => e && typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
      .map((e) => ({
        id: String(e.id || uid()),
        date: e.date,
        title: String(e.title || ''),
        content: String(e.content || ''),
        mood: MOODS.some((m) => m.id === e.mood) ? e.mood : null,
        tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
        createdAt: Number(e.createdAt) || Date.now(),
        updatedAt: Number(e.updatedAt) || Date.now()
      }));
    if (!list.length) { toast('불러올 일기가 없어요'); return; }
    await db.bulkPut(list);
    await load();
    el.menu.close();
    toast(`${list.length}편을 불러왔어요`);
  } catch {
    toast('백업 파일을 읽을 수 없어요');
  }
});

/* ---------- PWA ---------- */
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  deferredPrompt = ev;
  el.installBtn.hidden = false;
});
el.installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  el.installBtn.hidden = true;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}
if (navigator.storage?.persist) navigator.storage.persist();

load();
