// School Timetable Generator — UI layer. Data lives in `state`, autosaved to localStorage.
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STORAGE_KEY = 'school-timetable.v1';
const PALETTE = ['#2f6fdb', '#d9534f', '#1f8a4c', '#b7791f', '#7b4fd6', '#0f8f99', '#c2417e', '#5c6f2b', '#8a5a44', '#4a6fa5', '#d0682f', '#3d8f6f'];
const WEIGHT_LABELS = {
  classGap: 'Free gaps in a class day', teacherGap: 'Free gaps in a teacher day', sameDay: 'Same lesson twice on one day',
  dispreferred: 'Lesson in a non-preferred period', teacherMin: 'Teacher below minimum periods/day', late: 'Lesson late in the day (per period)',
  dutyUncovered: 'Duty period with nobody on call',
};
const MEETING_COLOR = '#64748b';
const DUTY_COLOR = '#a16207';

function emptyState() {
  return {
    settings: {
      name: 'My School',
      days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      periods: [
        { label: '1', start: '08:00', end: '08:45' }, { label: '2', start: '08:50', end: '09:35' },
        { label: '3', start: '09:40', end: '10:25' }, { label: '4', start: '10:45', end: '11:30' },
        { label: '5', start: '11:35', end: '12:20' }, { label: '6', start: '13:10', end: '13:55' },
        { label: '7', start: '14:00', end: '14:45' },
      ],
      weights: { ...Timetable.DEFAULT_WEIGHTS },
      attempts: 3,
    },
    teachers: [], classes: [], rooms: [], subjects: [], lessons: [], meetings: [], duties: [],
    timetable: { placements: [], generatedAt: null, difficulty: null },
  };
}

function sampleState() {
  const s = emptyState();
  s.settings.name = 'Greenfield Secondary School';
  const subj = (name, code, i) => ({ id: uid(), name, code, color: PALETTE[i % PALETTE.length] });
  const S = {
    math: subj('Mathematics', 'MAT', 0), eng: subj('English', 'ENG', 1), sci: subj('Science', 'SCI', 2),
    his: subj('History', 'HIS', 3), geo: subj('Geography', 'GEO', 4), pe: subj('Physical Ed.', 'PE', 5),
    art: subj('Art', 'ART', 6), mus: subj('Music', 'MUS', 7), ict: subj('Computing', 'ICT', 8),
    fre: subj('French', 'FRE', 9), spa: subj('Spanish', 'SPA', 10),
  };
  s.subjects = Object.values(S);
  const t = (name, code, extra = {}) => ({ id: uid(), name, code, unavailable: [], dispreferred: [], maxPerDay: 6, minPerDay: 0, ...extra });
  const T = {
    m1: t('Anita Rao', 'ARA'), m2: t('Brian Ochieng', 'BOC', { unavailable: ['4-5', '4-6'] }),
    e1: t('Chloe Martin', 'CMA'), e2: t('Daniel Kim', 'DKI', { dispreferred: ['0-0', '1-0', '2-0', '3-0', '4-0'] }),
    s1: t('Elena Petrova', 'EPE'), s2: t('Farid Haddad', 'FHA'),
    h1: t('Grace Liu', 'GLI', { unavailable: ['2-5', '2-6'], minPerDay: 2 }), pe: t('Hassan Ali', 'HAL', { dispreferred: ['4-5', '4-6'] }),
    ar: t('Isabel Costa', 'ICO', { unavailable: ['0-0', '0-1', '0-2', '0-3', '0-4', '0-5', '0-6'] }), ic: t('James Wright', 'JWR'),
    fr: t('Kofi Mensah', 'KME'), sp: t('Lucia Romero', 'LRO'),
  };
  s.teachers = Object.values(T);
  s.classes = ['6A', '6B', '7A', '7B', '8A', '8B'].map((n) => ({ id: uid(), name: n, unavailable: [], dispreferred: [] }));
  s.rooms = [
    ...['R101', 'R102', 'R103', 'R104', 'R105', 'R106'].map((n) => ({ id: uid(), name: n, type: 'Classroom', unavailable: [], dispreferred: [] })),
    ...[['Science Lab 1', 'Lab'], ['Science Lab 2', 'Lab'], ['Sports Hall', 'Gym'], ['Art Studio', 'Art'], ['Computer Lab', 'Computer']]
      .map(([name, type]) => ({ id: uid(), name, type, unavailable: [], dispreferred: [] })),
  ];
  const L = (subject, teacher, classes, sessions, length, room, parallel = '') => ({
    id: uid(), subjectId: subject.id, teacherId: teacher.id, classIds: classes.map((c) => c.id), sessions, length, room, maxOnePerDay: true, parallel,
  });
  s.classes.forEach((c, i) => {
    const half = i < 3;
    s.lessons.push(
      L(S.math, half ? T.m1 : T.m2, [c], 5, 1, 'type:Classroom'),
      L(S.eng, half ? T.e1 : T.e2, [c], 5, 1, 'type:Classroom'),
      L(S.sci, half ? T.s1 : T.s2, [c], 3, 1, 'type:Lab'),
      L(S.sci, half ? T.s1 : T.s2, [c], 1, 2, 'type:Lab'),
      L(S.his, T.h1, [c], 2, 1, 'type:Classroom'),
      L(S.geo, T.h1, [c], 2, 1, 'type:Classroom'),
      L(S.pe, T.pe, [c], 1, 2, 'type:Gym'),
      L(S.art, T.ar, [c], 1, 2, 'type:Art'),
      L(S.mus, T.ar, [c], 1, 1, 'type:Classroom'),
      L(S.ict, T.ic, [c], 2, 1, 'type:Computer'),
    );
  });
  // Year-8 language elective: 8A+8B students split into French and Spanish at the same time.
  const y8 = s.classes.slice(4);
  s.lessons.push(L(S.fre, T.fr, y8, 2, 1, 'type:Classroom', 'Y8 languages'), L(S.spa, T.sp, y8, 2, 1, 'type:Classroom', 'Y8 languages'));
  s.rooms.push({ id: uid(), name: 'Staff Room', type: 'Staff', unavailable: [], dispreferred: [] });
  const lastTwo = s.settings.days.flatMap((_, d) => [`${d}-5`, `${d}-6`]);
  s.meetings = [
    { id: uid(), name: 'Whole-staff meeting', teacherIds: s.teachers.map((x) => x.id), sessions: 1, length: 1, room: 'type:Staff', allowed: lastTwo },
    { id: uid(), name: 'Science department', teacherIds: [T.s1.id, T.s2.id], sessions: 1, length: 1, room: '', allowed: [] },
  ];
  s.duties = [{
    id: uid(), name: 'Library supervision', maxPerSlot: 1,
    allowed: s.settings.days.flatMap((_, d) => [`${d}-3`, `${d}-4`]),
    assignments: [T.h1, T.ic, T.ar, T.fr, T.sp].map((x) => ({ teacherId: x.id, hours: 2 })),
  }];
  return s;
}

function migrate(s) {
  const base = emptyState();
  s.settings.weights = { ...base.settings.weights, ...(s.settings.weights || {}) };
  s.settings.attempts = s.settings.attempts || base.settings.attempts;
  ['teachers', 'classes', 'rooms'].forEach((k) => s[k].forEach((x) => { x.unavailable = x.unavailable || []; x.dispreferred = x.dispreferred || []; }));
  s.meetings = s.meetings || [];
  s.duties = s.duties || [];
  s.timetable = s.timetable || base.timetable;
  // v1 placements stored a single roomId; v2 stores one room per parallel part.
  s.timetable.placements = (s.timetable.placements || []).map((p) => (p.rooms ? p : { ...p, rooms: [p.roomId || null] }));
  return s;
}

function load() {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? migrate(JSON.parse(raw)) : null; } catch { return null; }
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

let state = load() || sampleState();
let ui = { tab: 'setup', ttMode: 'class', ttEntity: null, masterKind: 'classes' };
try { ui.tab = localStorage.getItem(STORAGE_KEY + '.tab') || 'setup'; } catch { /* ignore */ }
let running = null;

const D = () => state.settings.days.length;
const P = () => state.settings.periods.length;
const find = (list, id) => state[list].find((x) => x.id === id);

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function changed() { save(); }

// ---------- Rendering ----------
function render() {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab)));
  $('#schoolName').value = state.settings.name;
  const views = { setup: renderSetup, teachers: renderTeachers, classes: renderClasses, rooms: renderRooms, subjects: renderSubjects, lessons: renderLessons, staff: renderStaff, generate: renderGenerate, timetable: renderTimetable };
  $('#main').innerHTML = '';
  views[ui.tab]($('#main'));
}

function panel(root, title, hint) {
  const p = document.createElement('section');
  p.className = 'panel';
  p.innerHTML = `<div class="row"><h2>${esc(title)}</h2><span class="spacer"></span><div class="row" data-slot="actions"></div></div>${hint ? `<p class="hint">${hint}</p>` : ''}`;
  root.appendChild(p);
  return p;
}

function renderSetup(root) {
  const p = panel(root, 'Week structure', 'Define teaching days and the periods in each day. Every lesson session occupies one or more consecutive periods.');
  const st = state.settings;
  p.insertAdjacentHTML('beforeend', `
    <h3>Days</h3>
    <div class="table-wrap"><table class="edit"><thead><tr><th>#</th><th>Day name</th><th></th></tr></thead><tbody>
      ${st.days.map((d, i) => `<tr><td>${i + 1}</td><td><input data-day="${i}" value="${esc(d)}" aria-label="Day ${i + 1}"></td><td><button class="danger" data-del-day="${i}" title="Remove day">✕</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="row" style="margin:8px 0 16px"><button class="ghost" data-add-day>+ Add day</button></div>
    <h3>Periods</h3>
    <div class="table-wrap"><table class="edit"><thead><tr><th>Label</th><th>Start</th><th>End</th><th></th></tr></thead><tbody>
      ${st.periods.map((pp, i) => `<tr>
        <td><input data-period="${i}" data-f="label" value="${esc(pp.label)}" aria-label="Period label"></td>
        <td><input type="time" data-period="${i}" data-f="start" value="${esc(pp.start)}" aria-label="Start"></td>
        <td><input type="time" data-period="${i}" data-f="end" value="${esc(pp.end)}" aria-label="End"></td>
        <td><button class="danger" data-del-period="${i}" title="Remove period">✕</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="row" style="margin-top:8px"><button class="ghost" data-add-period>+ Add period</button></div>`);
  p.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.day) st.days[+t.dataset.day] = t.value;
    if (t.dataset.period) st.periods[+t.dataset.period][t.dataset.f] = t.value;
    changed();
  });
  p.addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.addDay !== undefined) { st.days.push(`Day ${st.days.length + 1}`); resetTimetable('Week changed'); }
    else if (t.dataset.delDay) { if (st.days.length > 1) { st.days.splice(+t.dataset.delDay, 1); resetTimetable('Week changed'); } }
    else if (t.dataset.addPeriod !== undefined) { st.periods.push({ label: String(st.periods.length + 1), start: '', end: '' }); resetTimetable('Week changed'); }
    else if (t.dataset.delPeriod) { if (st.periods.length > 1) { st.periods.splice(+t.dataset.delPeriod, 1); resetTimetable('Week changed'); } }
    else return;
    render();
  });
}

// Changing the week shape invalidates slot indices, so availability and placements are cleared.
function resetTimetable(reason) {
  ['teachers', 'classes', 'rooms'].forEach((k) => state[k].forEach((x) => { x.unavailable = []; x.dispreferred = []; }));
  state.timetable = { placements: [], generatedAt: null, difficulty: null };
  changed();
  toast(`${reason}: availability and timetable were reset.`);
}

function workload() {
  const t = {}, c = {}, tl = {};
  for (const l of state.lessons) {
    const n = (Number(l.sessions) || 0) * (Number(l.length) || 1);
    t[l.teacherId] = (t[l.teacherId] || 0) + n;
    tl[l.teacherId] = (tl[l.teacherId] || 0) + n;
  }
  for (const m of state.meetings) for (const id of new Set(m.teacherIds || [])) t[id] = (t[id] || 0) + (Number(m.sessions) || 0) * (Number(m.length) || 1);
  for (const d of state.duties) for (const a of d.assignments || []) t[a.teacherId] = (t[a.teacherId] || 0) + (Number(a.hours) || 0);
  // Parallel lessons share the same periods, so count each group once per class.
  const seen = new Set();
  for (const l of state.lessons) {
    const n = (Number(l.sessions) || 0) * (Number(l.length) || 1);
    for (const id of l.classIds || []) {
      const key = l.parallel && l.parallel.trim() ? `${id}|${l.parallel.trim().toLowerCase()}` : null;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      c[id] = (c[id] || 0) + n;
    }
  }
  return { t, c, tl };
}

function availableSlots(ent) { return D() * P() - (ent.unavailable || []).length; }

function availLabel(x) {
  const b = (x.unavailable || []).length, s = (x.dispreferred || []).length;
  return `Availability${b || s ? ` (${[b && `${b} ✕`, s && `${s} ~`].filter(Boolean).join(', ')})` : ''}`;
}

function entityEditor(root, { list, title, hint, cols, loadKey }) {
  const p = panel(root, title, hint);
  p.querySelector('[data-slot=actions]').innerHTML = `<button data-add>+ Add</button>`;
  const load = loadKey ? workload()[loadKey] : null;
  const rows = state[list].map((x) => `<tr data-id="${x.id}">
      ${cols.map((c) => `<td>${c.input(x)}</td>`).join('')}
      ${load ? `<td class="load ${(load[x.id] || 0) > availableSlots(x) ? 'over' : ''}">${load[x.id] || 0} / ${availableSlots(x)}</td>` : ''}
      <td><button class="ghost" data-avail>${availLabel(x)}</button></td>
      <td><button class="danger" data-del title="Delete">✕</button></td></tr>`).join('');
  p.insertAdjacentHTML('beforeend', state[list].length
    ? `<div class="table-wrap"><table class="edit"><thead><tr>${cols.map((c) => `<th>${c.label}</th>`).join('')}${load ? '<th>Periods / free</th>' : ''}<th></th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="hint">Nothing here yet. Click “+ Add”.</p>`);
  p.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const x = find(list, tr.dataset.id);
    x[e.target.dataset.f] = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
    changed();
  });
  p.addEventListener('click', (e) => {
    if (e.target.dataset.add !== undefined) { state[list].push(cols.newItem()); changed(); render(); return; }
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const x = find(list, tr.dataset.id);
    if (e.target.dataset.del !== undefined) {
      if (!confirm(`Delete “${x.name}”? Lessons that use it will be updated.`)) return;
      state[list] = state[list].filter((y) => y !== x);
      cleanupRefs(); changed(); render();
    } else if (e.target.dataset.avail !== undefined) {
      editAvailability(x, `${title.replace(/es$|s$/, '')}: ${x.name}`);
    }
  });
}

function cleanupRefs() {
  const ids = (k) => new Set(state[k].map((x) => x.id));
  const t = ids('teachers'), c = ids('classes'), r = ids('rooms'), s = ids('subjects');
  state.lessons.forEach((l) => {
    if (!t.has(l.teacherId)) l.teacherId = '';
    l.classIds = (l.classIds || []).filter((id) => c.has(id));
    if (l.room && !l.room.startsWith('type:') && !r.has(l.room)) l.room = '';
  });
  state.lessons = state.lessons.filter((l) => s.has(l.subjectId));
  state.meetings.forEach((m) => {
    m.teacherIds = (m.teacherIds || []).filter((id) => t.has(id));
    if (m.room && !m.room.startsWith('type:') && !r.has(m.room)) m.room = '';
  });
  state.duties.forEach((d) => { d.assignments = (d.assignments || []).filter((a) => t.has(a.teacherId)); });
}

const textCol = (label, f, ph = '') => ({ label, input: (x) => `<input data-f="${f}" value="${esc(x[f])}" placeholder="${ph}" aria-label="${label}">` });
const numCol = (label, f, title) => ({ label: `<span title="${title}">${label}</span>`, input: (x) => `<input type="number" min="0" max="${P()}" data-f="${f}" value="${x[f] || ''}" placeholder="—" style="max-width:80px" aria-label="${label}">` });

function renderTeachers(root) {
  const cols = [textCol('Name', 'name'), textCol('Code', 'code', 'e.g. ARA'),
    numCol('Max/day', 'maxPerDay', 'Hard limit: never more periods than this in one day'),
    numCol('Min/day', 'minPerDay', 'Preference: on days they teach, at least this many periods')];
  cols.newItem = () => ({ id: uid(), name: `Teacher ${state.teachers.length + 1}`, code: '', unavailable: [], dispreferred: [], maxPerDay: 0, minPerDay: 0 });
  entityEditor(root, { list: 'teachers', title: 'Teachers', hint: 'Availability: ✕ = prohibited (never scheduled), ~ = non-preferred (avoided when possible). Prefer ~ over ✕ — it keeps the timetable solvable. Load includes meetings and duties; red = more periods than free slots. Max/day counts teaching only.', cols, loadKey: 't' });
}

function renderClasses(root) {
  const cols = [textCol('Name', 'name', 'e.g. 7B')];
  cols.newItem = () => ({ id: uid(), name: `Class ${state.classes.length + 1}`, unavailable: [], dispreferred: [] });
  entityEditor(root, { list: 'classes', title: 'Classes', hint: 'Class groups of students. Use ✕ for fixed events (assembly), ~ for periods to leave free if possible.', cols, loadKey: 'c' });
}

function renderRooms(root) {
  const cols = [textCol('Name', 'name'), textCol('Type', 'type', 'Classroom, Lab…')];
  cols.newItem = () => ({ id: uid(), name: `Room ${state.rooms.length + 1}`, type: 'Classroom', unavailable: [], dispreferred: [] });
  entityEditor(root, { list: 'rooms', title: 'Rooms', hint: 'Rooms of the same type form a set of alternatives — a lesson asking for “Any Lab” gets whichever lab is free.', cols });
}

function renderSubjects(root) {
  const p = panel(root, 'Subjects', 'Colour and short code are used in the timetables.');
  p.querySelector('[data-slot=actions]').innerHTML = `<button data-add>+ Add</button>`;
  p.insertAdjacentHTML('beforeend', state.subjects.length ? `<div class="table-wrap"><table class="edit"><thead><tr><th>Colour</th><th>Name</th><th>Code</th><th></th></tr></thead><tbody>
    ${state.subjects.map((s) => `<tr data-id="${s.id}"><td><input type="color" data-f="color" value="${esc(s.color)}" aria-label="Colour"></td><td><input data-f="name" value="${esc(s.name)}" aria-label="Name"></td><td><input data-f="code" value="${esc(s.code)}" style="max-width:100px" aria-label="Code"></td><td><button class="danger" data-del>✕</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="hint">Nothing here yet. Click “+ Add”.</p>');
  p.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    find('subjects', tr.dataset.id)[e.target.dataset.f] = e.target.value; changed();
  });
  p.addEventListener('click', (e) => {
    if (e.target.dataset.add !== undefined) {
      state.subjects.push({ id: uid(), name: `Subject ${state.subjects.length + 1}`, code: '', color: PALETTE[state.subjects.length % PALETTE.length] });
      changed(); render();
    } else if (e.target.dataset.del !== undefined) {
      const id = e.target.closest('tr').dataset.id;
      const n = state.lessons.filter((l) => l.subjectId === id).length;
      if (!confirm(`Delete subject${n ? ` and its ${n} lesson(s)` : ''}?`)) return;
      state.subjects = state.subjects.filter((s) => s.id !== id); cleanupRefs(); changed(); render();
    }
  });
}

function roomOptions(sel) {
  const types = [...new Set(state.rooms.map((r) => r.type).filter(Boolean))];
  return `<option value="" ${!sel ? 'selected' : ''}>No room needed</option>
    <optgroup label="Any room of type">${types.map((t) => `<option value="type:${esc(t)}" ${sel === 'type:' + t ? 'selected' : ''}>Any ${esc(t)}</option>`).join('')}</optgroup>
    <optgroup label="Specific room">${state.rooms.map((r) => `<option value="${r.id}" ${sel === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</optgroup>`;
}

function renderLessons(root) {
  const p = panel(root, 'Lessons', 'Each row is “subject × teacher × class(es)” taught N times per week. Length 2 = double period. Several classes = joint lesson. Give rows the same <b>Parallel group</b> name to run them at the same time (split classes, electives, sets) — they need the same sessions and length.');
  p.querySelector('[data-slot=actions]').innerHTML = `<select data-filter aria-label="Filter by class"><option value="">All classes</option>${state.classes.map((c) => `<option value="${c.id}" ${ui.lessonFilter === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><button data-add>+ Add lesson</button>`;
  const list = state.lessons.filter((l) => !ui.lessonFilter || (l.classIds || []).includes(ui.lessonFilter));
  const opt = (arr, sel, empty) => `${empty ? `<option value="">${empty}</option>` : ''}${arr.map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}`;
  const groups = [...new Set(state.lessons.map((l) => (l.parallel || '').trim()).filter(Boolean))];
  p.insertAdjacentHTML('beforeend', list.length ? `<datalist id="parallelGroups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
    <div class="table-wrap"><table class="edit"><thead><tr><th>Subject</th><th>Teacher</th><th>Classes</th><th>Room</th><th>Sessions/wk</th><th>Length</th><th title="At most one session per day">1/day</th><th title="Rows with the same name are scheduled simultaneously">Parallel group</th><th></th></tr></thead><tbody>
    ${list.map((l) => `<tr data-id="${l.id}">
      <td><select data-f="subjectId" aria-label="Subject">${opt(state.subjects, l.subjectId)}</select></td>
      <td><select data-f="teacherId" aria-label="Teacher">${opt(state.teachers, l.teacherId, '— choose —')}</select></td>
      <td><button class="ghost" data-classes>${(l.classIds || []).map((id) => `<span class="chip">${esc(find('classes', id)?.name)}</span>`).join('') || '— choose —'}</button></td>
      <td><select data-f="room" aria-label="Room">${roomOptions(l.room)}</select></td>
      <td><input type="number" min="1" max="${D() * P()}" data-f="sessions" value="${l.sessions}" style="max-width:80px" aria-label="Sessions per week"></td>
      <td><select data-f="length" aria-label="Length">${[1, 2, 3].map((n) => `<option value="${n}" ${+l.length === n ? 'selected' : ''}>${n === 1 ? 'Single' : n === 2 ? 'Double' : 'Triple'}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-f="maxOnePerDay" ${l.maxOnePerDay ? 'checked' : ''} aria-label="At most one per day"></td>
      <td><input data-f="parallel" list="parallelGroups" value="${esc(l.parallel || '')}" placeholder="—" style="max-width:140px" aria-label="Parallel group"></td>
      <td><button class="danger" data-del>✕</button></td></tr>`).join('')}
    </tbody></table></div><p class="hint" style="margin-top:8px">${list.length} lesson rows${ui.lessonFilter ? ` · class load ${workload().c[ui.lessonFilter] || 0} of ${D() * P()} periods` : ''}</p>`
    : '<p class="hint">No lessons yet. Add subjects, teachers and classes first, then click “+ Add lesson”.</p>');
  p.addEventListener('change', (e) => {
    if (e.target.dataset.filter !== undefined) { ui.lessonFilter = e.target.value; render(); return; }
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const l = find('lessons', tr.dataset.id); const f = e.target.dataset.f;
    l[f] = e.target.type === 'checkbox' ? e.target.checked : (f === 'sessions' || f === 'length') ? Number(e.target.value) : e.target.value;
    changed();
  });
  p.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.add !== undefined) {
      if (!state.subjects.length) { toast('Add a subject first.'); return; }
      state.lessons.push({ id: uid(), subjectId: state.subjects[0].id, teacherId: '', classIds: ui.lessonFilter ? [ui.lessonFilter] : [], room: '', sessions: 1, length: 1, maxOnePerDay: true, parallel: '' });
      changed(); render(); return;
    }
    const tr = btn.closest('tr[data-id]'); if (!tr) return;
    const l = find('lessons', tr.dataset.id);
    if (btn.dataset.del !== undefined) { state.lessons = state.lessons.filter((x) => x !== l); changed(); render(); }
    if (btn.dataset.classes !== undefined) pickClasses(l);
  });
}

function pickClasses(l) {
  openModal('Classes attending this lesson', `<div class="class-picks">${state.classes.map((c) => `<label><input type="checkbox" value="${c.id}" ${(l.classIds || []).includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}</div>`, () => {
    l.classIds = [...$('#modalContent').querySelectorAll('input:checked')].map((i) => i.value);
    changed(); render();
  });
}

// Three-state template like GHC: available → non-preferred (~) → prohibited (✕).
function editAvailability(ent, title) {
  const st = state.settings;
  const off = new Set(ent.unavailable || []);
  const soft = new Set(ent.dispreferred || []);
  const stateOf = (k) => (off.has(k) ? 2 : soft.has(k) ? 1 : 0);
  const setState = (k, v) => { off.delete(k); soft.delete(k); if (v === 2) off.add(k); if (v === 1) soft.add(k); };
  const grid = () => `<p class="hint">Click to cycle: available → <b>~ non-preferred</b> → <b>✕ prohibited</b>. Click a day or period header to set the whole column/row.</p>
    <div class="table-wrap"><table class="avail"><thead><tr><th></th>${st.days.map((d, di) => `<th data-col="${di}" style="cursor:pointer">${esc(d.slice(0, 3))}</th>`).join('')}</tr></thead><tbody>
    ${st.periods.map((pp, pi) => `<tr><th data-row="${pi}" style="cursor:pointer">${esc(pp.label)}</th>${st.days.map((_, di) => {
      const k = `${di}-${pi}`; const v = stateOf(k);
      return `<td data-k="${k}" class="${['', 'pref', 'off'][v]}">${['', '~', '✕'][v]}</td>`;
    }).join('')}</tr>`).join('')}
    </tbody></table></div>`;
  openModal(title, grid(), () => { ent.unavailable = [...off]; ent.dispreferred = [...soft]; changed(); render(); });
  const box = $('#modalContent');
  box.onclick = (e) => {
    const t = e.target;
    const cycle = (keys) => { const next = (stateOf(keys[0]) + 1) % 3; keys.forEach((k) => setState(k, next)); };
    if (t.dataset.k) cycle([t.dataset.k]);
    else if (t.dataset.col) cycle(st.periods.map((_, pi) => `${t.dataset.col}-${pi}`));
    else if (t.dataset.row) cycle(st.days.map((_, di) => `${di}-${t.dataset.row}`));
    else return;
    box.innerHTML = grid();
  };
}

function openModal(title, html, onClose, actions) {
  const dlg = $('#modal');
  $('#modalTitle').textContent = title;
  $('#modalContent').innerHTML = html;
  $('#modalContent').onclick = null;
  $('#modalActions').innerHTML = actions || '<button value="close">Done</button>';
  dlg.returnValue = '';
  dlg.onclose = () => { if (onClose) onClose(dlg.returnValue); };
  dlg.showModal();
}

// ---------- Meetings & on-call duties ----------
function slotsLabel(keys) { return keys && keys.length ? `${keys.length} period(s)` : 'Any time'; }

function renderStaff(root) {
  const m = panel(root, 'Teacher meetings', 'All members must be free at the same time. The generator fits lessons around meetings; if no common period can be found the meeting is reported as not placed. Restrict “When” to the periods the meeting may use.');
  m.querySelector('[data-slot=actions]').innerHTML = '<button data-add-meeting>+ Add meeting</button>';
  m.insertAdjacentHTML('beforeend', state.meetings.length ? `<div class="table-wrap"><table class="edit"><thead><tr><th>Name</th><th>Members</th><th>Sessions/wk</th><th>Length</th><th>Room</th><th>When</th><th></th></tr></thead><tbody>
    ${state.meetings.map((x) => `<tr data-id="${x.id}">
      <td><input data-f="name" value="${esc(x.name)}" aria-label="Meeting name"></td>
      <td><button class="ghost" data-members>${(x.teacherIds || []).length === state.teachers.length && state.teachers.length ? 'All teachers' : `${(x.teacherIds || []).length} teacher(s)`}</button></td>
      <td><input type="number" min="1" max="${D()}" data-f="sessions" value="${x.sessions}" style="max-width:80px" aria-label="Sessions per week"></td>
      <td><select data-f="length" aria-label="Length">${[1, 2].map((n) => `<option value="${n}" ${+x.length === n ? 'selected' : ''}>${n === 1 ? 'Single' : 'Double'}</option>`).join('')}</select></td>
      <td><select data-f="room" aria-label="Room">${roomOptions(x.room)}</select></td>
      <td><button class="ghost" data-when>${slotsLabel(x.allowed)}</button></td>
      <td><button class="danger" data-del>✕</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="hint">No meetings yet.</p>');
  m.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const x = find('meetings', tr.dataset.id); const f = e.target.dataset.f;
    x[f] = f === 'sessions' || f === 'length' ? Number(e.target.value) : e.target.value;
    changed();
  });
  m.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.addMeeting !== undefined) {
      state.meetings.push({ id: uid(), name: `Meeting ${state.meetings.length + 1}`, teacherIds: [], sessions: 1, length: 1, room: '', allowed: [] });
      changed(); render(); return;
    }
    const tr = btn.closest('tr[data-id]'); if (!tr) return;
    const x = find('meetings', tr.dataset.id);
    if (btn.dataset.del !== undefined) { state.meetings = state.meetings.filter((y) => y !== x); changed(); render(); }
    if (btn.dataset.members !== undefined) pickTeachers(x);
    if (btn.dataset.when !== undefined) editSlots(`When can “${x.name}” take place?`, x);
  });

  const d = panel(root, 'On-call duties', 'Services such as library or corridor supervision. Mark the duty periods under “When”, set how many teachers may be on call at once, and give each teacher weekly hours. The engine tries to cover every duty period with at least one teacher.');
  d.querySelector('[data-slot=actions]').innerHTML = '<button data-add-duty>+ Add duty</button>';
  d.insertAdjacentHTML('beforeend', state.duties.length ? `<div class="table-wrap"><table class="edit"><thead><tr><th>Service</th><th title="Hard limit">Max teachers / period</th><th>When</th><th>Teachers &amp; hours</th><th>Hours / duty periods</th><th></th></tr></thead><tbody>
    ${state.duties.map((x) => {
      const hours = (x.assignments || []).reduce((a, y) => a + (Number(y.hours) || 0), 0);
      const periods = (x.allowed || []).length || D() * P();
      return `<tr data-id="${x.id}">
      <td><input data-f="name" value="${esc(x.name)}" aria-label="Duty name"></td>
      <td><input type="number" min="1" data-f="maxPerSlot" value="${x.maxPerSlot || 1}" style="max-width:80px" aria-label="Max teachers per period"></td>
      <td><button class="ghost" data-when>${slotsLabel(x.allowed)}</button></td>
      <td><button class="ghost" data-assign>${(x.assignments || []).length} teacher(s)</button></td>
      <td class="load ${hours > periods * (x.maxPerSlot || 1) ? 'over' : ''}">${hours} / ${periods}</td>
      <td><button class="danger" data-del>✕</button></td></tr>`;
    }).join('')}
    </tbody></table></div>` : '<p class="hint">No duties yet.</p>');
  d.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const x = find('duties', tr.dataset.id); const f = e.target.dataset.f;
    x[f] = f === 'maxPerSlot' ? Math.max(1, Number(e.target.value) || 1) : e.target.value;
    changed(); if (f === 'maxPerSlot') render();
  });
  d.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.addDuty !== undefined) {
      state.duties.push({ id: uid(), name: `Duty ${state.duties.length + 1}`, maxPerSlot: 1, allowed: [], assignments: [] });
      changed(); render(); return;
    }
    const tr = btn.closest('tr[data-id]'); if (!tr) return;
    const x = find('duties', tr.dataset.id);
    if (btn.dataset.del !== undefined) { state.duties = state.duties.filter((y) => y !== x); changed(); render(); }
    if (btn.dataset.assign !== undefined) editAssignments(x);
    if (btn.dataset.when !== undefined) editSlots(`Duty periods for “${x.name}”`, x);
  });
}

function pickTeachers(meeting) {
  const sel = new Set(meeting.teacherIds || []);
  openModal(`Members of “${meeting.name}”`, `<div class="row" style="margin-bottom:8px"><button type="button" class="ghost" data-all>Select all</button><button type="button" class="ghost" data-none>Clear</button></div>
    <div class="class-picks">${state.teachers.map((t) => `<label><input type="checkbox" value="${t.id}" ${sel.has(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div>`, () => {
    meeting.teacherIds = [...$('#modalContent').querySelectorAll('input:checked')].map((i) => i.value);
    changed(); render();
  });
  $('#modalContent').onclick = (e) => {
    const all = e.target.dataset.all !== undefined, none = e.target.dataset.none !== undefined;
    if (all || none) $('#modalContent').querySelectorAll('input[type=checkbox]').forEach((i) => { i.checked = all; });
  };
}

function editAssignments(duty) {
  const hours = Object.fromEntries((duty.assignments || []).map((a) => [a.teacherId, a.hours]));
  openModal(`Teachers on “${duty.name}”`, `<p class="hint">Weekly on-call hours per teacher (0 = not on this duty).</p>
    <div class="table-wrap"><table class="edit"><tbody>${state.teachers.map((t) => `<tr><td>${esc(t.name)}</td><td><input type="number" min="0" max="${D() * P()}" data-t="${t.id}" value="${hours[t.id] || 0}" style="max-width:90px" aria-label="Hours for ${esc(t.name)}"></td></tr>`).join('')}</tbody></table></div>`, () => {
    duty.assignments = [...$('#modalContent').querySelectorAll('input[data-t]')]
      .map((i) => ({ teacherId: i.dataset.t, hours: Math.max(0, Number(i.value) || 0) })).filter((a) => a.hours > 0);
    changed(); render();
  });
}

// Two-state template of allowed periods; stored empty when every period is allowed.
function editSlots(title, obj) {
  const st = state.settings;
  const all = st.days.flatMap((_, d) => st.periods.map((__, p) => `${d}-${p}`));
  const on = new Set(obj.allowed && obj.allowed.length ? obj.allowed : all);
  const grid = () => `<p class="hint">✓ = allowed. Click a cell, or a day/period header to toggle the whole column/row.</p>
    <div class="table-wrap"><table class="avail"><thead><tr><th></th>${st.days.map((d, di) => `<th data-col="${di}" style="cursor:pointer">${esc(d.slice(0, 3))}</th>`).join('')}</tr></thead><tbody>
    ${st.periods.map((pp, pi) => `<tr><th data-row="${pi}" style="cursor:pointer">${esc(pp.label)}</th>${st.days.map((_, di) => {
      const k = `${di}-${pi}`;
      return `<td data-k="${k}" class="${on.has(k) ? 'yes' : ''}">${on.has(k) ? '✓' : ''}</td>`;
    }).join('')}</tr>`).join('')}
    </tbody></table></div>`;
  openModal(title, grid(), () => { obj.allowed = on.size === all.length ? [] : [...on]; changed(); render(); });
  const box = $('#modalContent');
  box.onclick = (e) => {
    const t = e.target;
    const toggle = (keys) => { const allOn = keys.every((k) => on.has(k)); keys.forEach((k) => (allOn ? on.delete(k) : on.add(k))); };
    if (t.dataset.k) toggle([t.dataset.k]);
    else if (t.dataset.col) toggle(st.periods.map((_, pi) => `${t.dataset.col}-${pi}`));
    else if (t.dataset.row) toggle(st.days.map((_, di) => `${di}-${t.dataset.row}`));
    else return;
    box.innerHTML = grid();
  };
}

// ---------- Generate ----------
function validate() {
  const issues = [];
  const e = new Timetable.Engine(state);
  e.problems.forEach((p) => issues.push({ lvl: 'err', msg: `${p.meetingId ? `Meeting “${find('meetings', p.meetingId)?.name}”` : p.lessonIds.map(describeLesson).join(' & ')} ${p.msg}.` }));
  const w = workload();
  state.teachers.forEach((t) => {
    const n = w.t[t.id] || 0;
    if (n > availableSlots(t)) issues.push({ lvl: 'err', msg: `${t.name} has ${n} periods but only ${availableSlots(t)} free slots.` });
    const nl = w.tl[t.id] || 0;
    if (t.maxPerDay && nl > t.maxPerDay * D()) issues.push({ lvl: 'err', msg: `${t.name} teaches ${nl} periods but max ${t.maxPerDay}/day allows only ${t.maxPerDay * D()}.` });
    if (t.maxPerDay && t.minPerDay > t.maxPerDay) issues.push({ lvl: 'warn', msg: `${t.name}: min/day is above max/day.` });
  });
  state.classes.forEach((c) => {
    const n = w.c[c.id] || 0;
    if (n > availableSlots(c)) issues.push({ lvl: 'err', msg: `${c.name} has ${n} periods but only ${availableSlots(c)} free slots.` });
    else if (!n) issues.push({ lvl: 'warn', msg: `${c.name} has no lessons.` });
  });
  const need = {};
  e.units.forEach((u) => u.parts.forEach((p) => { if (p.roomCands && p.roomCands.length) { const k = p.roomCands.join(','); need[k] = (need[k] || 0) + u.len; } }));
  for (const k in need) {
    const cap = k.split(',').reduce((a, id) => a + availableSlots(find('rooms', id)), 0);
    if (need[k] > cap) issues.push({ lvl: 'err', msg: `Rooms ${k.split(',').map((id) => find('rooms', id).name).join(', ')} are needed for ${need[k]} periods but have ${cap} slots.` });
  }
  const seen = new Set();
  e.units.forEach((u) => { if (!u.starts.length && !seen.has(u.key)) { seen.add(u.key); issues.push({ lvl: 'err', msg: `${describeUnit(u.id)} has no period where all its teachers and classes are available.` }); } });
  state.lessons.forEach((l) => {
    if (l.maxOnePerDay && Number(l.sessions) > D()) issues.push({ lvl: 'err', msg: `${describeLesson(l.id)} has ${l.sessions} sessions marked “1/day” but the week has only ${D()} days — untick 1/day or reduce sessions.` });
  });
  state.duties.forEach((d) => {
    const hours = (d.assignments || []).reduce((a, x) => a + (Number(x.hours) || 0), 0);
    const periods = (d.allowed || []).length || D() * P();
    const cap = periods * Math.max(1, Number(d.maxPerSlot) || 1);
    if (hours > cap) issues.push({ lvl: 'err', msg: `Duty “${d.name}” has ${hours} assigned hours but only ${cap} places (${periods} periods × ${d.maxPerSlot || 1}); ${hours - cap} will stay unplaced.` });
    else if (hours < periods) issues.push({ lvl: 'warn', msg: `Duty “${d.name}”: ${hours} hours assigned for ${periods} duty periods — ${periods - hours} period(s) will be uncovered.` });
  });
  if (!e.units.length) issues.push({ lvl: 'warn', msg: 'There are no lessons to schedule.' });
  return { issues, units: e.units.length };
}

function describeLesson(lessonId) {
  const l = find('lessons', lessonId);
  if (!l) return 'Unknown lesson';
  return `${find('subjects', l.subjectId)?.name || '?'} · ${(l.classIds || []).map((id) => find('classes', id)?.name).join('+')} · ${find('teachers', l.teacherId)?.name || 'no teacher'}`;
}
function describeUnit(unitId) {
  const base = unitId.split('#')[0];
  if (base.startsWith('m:')) { const m = find('meetings', base.slice(2)); return `${m?.name || 'Meeting'} · ${(m?.teacherIds || []).length} teacher(s)`; }
  if (base.startsWith('d:')) { const [, did, tid] = base.split(':'); return `${find('duties', did)?.name || 'Duty'} · ${find('teachers', tid)?.name || '?'}`; }
  return base.split('+').map(describeLesson).join('  ∥  ');
}

// Display data for one part of a unit: lesson subject, meeting or duty.
function partInfo(part) {
  if (part.kind === 'meeting') { const m = find('meetings', part.ref); return { title: m?.name || 'Meeting', code: 'MTG', color: MEETING_COLOR }; }
  if (part.kind === 'duty') { const d = find('duties', part.ref); return { title: d?.name || 'Duty', code: 'DUTY', color: DUTY_COLOR }; }
  const s = find('subjects', find('lessons', part.lessonId)?.subjectId);
  return { title: s?.name || '?', code: s?.code || s?.name?.slice(0, 3) || '?', color: s?.color };
}
const describePart = (part) => (part.kind === 'lesson' ? describeLesson(part.lessonId) : partInfo(part).title);

function renderGenerate(root) {
  const p = panel(root, 'Generate timetable', 'Hard rules are always respected: no teacher, class or room double-booked, ✕ periods never used, teacher max/day, double periods kept together, “1/day” lessons on different days, parallel lessons at the same time, locked lessons kept. The weighted criteria below are then minimised.');
  const { issues, units } = validate();
  const locked = state.timetable.placements.filter((x) => x.locked).length;
  const W = state.settings.weights;
  p.insertAdjacentHTML('beforeend', `
    <div class="row">
      <button data-run ${running ? 'disabled' : ''}>${running ? 'Generating…' : 'Generate timetable'}</button>
      ${running ? '<button class="ghost" data-stop>Stop (keep best so far)</button>' : ''}
      <label class="row" style="gap:6px">Attempts <input type="number" id="attempts" min="1" max="50" value="${state.settings.attempts}" style="width:70px" ${running ? 'disabled' : ''}></label>
      <label class="row" style="gap:6px"><input type="checkbox" id="keepLocked" checked> Keep ${locked} locked lesson(s)</label>
    </div>
    <div class="progress"><div id="prog"></div></div>
    <div id="genStatus" class="hint">${units} sessions to place. Each attempt builds and optimises a full timetable; the best one is kept.</div>
    ${issues.length ? `<h3>Data validation</h3><ul class="issues">${issues.map((i) => `<li class="${i.lvl}">${esc(i.msg)}</li>`).join('')}</ul>` : '<p style="color:var(--ok)">✓ Data validation passed.</p>'}
    <details class="weights"><summary>Weighted optimisation criteria</summary>
      <p class="hint">Higher weight = avoided more strongly. What matters is the weight of one criterion relative to the others.</p>
      <div class="weight-grid">${Object.keys(WEIGHT_LABELS).map((k) => `<label>${WEIGHT_LABELS[k]}<input type="number" step="0.05" min="0" data-w="${k}" value="${W[k]}"></label>`).join('')}</div>
      <button class="ghost" data-reset-w>Reset to defaults</button>
    </details>
    <div id="genStats"></div>`);
  renderStats($('#genStats'));
  p.addEventListener('change', (e) => {
    if (e.target.dataset.w) { W[e.target.dataset.w] = Math.max(0, Number(e.target.value) || 0); changed(); }
    if (e.target.id === 'attempts') { state.settings.attempts = Math.max(1, Math.min(50, Number(e.target.value) || 1)); changed(); }
  });
  p.addEventListener('click', (e) => {
    if (e.target.dataset.run !== undefined) startGenerate($('#keepLocked').checked);
    if (e.target.dataset.stop !== undefined) running.stop = true;
    if (e.target.dataset.resetW !== undefined) { state.settings.weights = { ...Timetable.DEFAULT_WEIGHTS }; changed(); render(); }
  });
}

// Better = more sessions placed, then lower weighted cost.
const better = (a, b) => !b || a.placed > b.placed || (a.placed === b.placed && a.cost < b.cost);

function startGenerate(keepLocked) {
  const keep = keepLocked ? state.timetable.placements.filter((x) => x.locked) : [];
  const attempts = state.settings.attempts;
  running = { stop: false };
  render();
  const t0 = performance.now();
  let attempt = 0, best = null, solver = null;
  const finishAttempt = () => {
    solver.restoreBest();
    const res = { placed: solver.e.pos.filter(Boolean).length, total: solver.e.units.length, cost: solver.e.totalCost().cost, placements: solver.e.placements(), difficulty: solver.difficulty() };
    if (better(res, best)) best = res;
  };
  const tick = () => {
    if (!solver) solver = new Timetable.Solver(state, keep);
    const r = solver.run(40);
    const overall = (attempt + r.progress) / attempts;
    const bar = $('#prog'); if (bar) bar.style.width = `${Math.round(overall * 100)}%`;
    const st = $('#genStatus');
    if (st) st.textContent = `Attempt ${attempt + 1}/${attempts} — ${r.phase === 'construct' ? 'placing lessons' : 'optimising'} ${r.placed}/${r.total}` +
      `${best ? ` · best so far: ${best.placed}/${best.total} placed, score ${best.cost}` : ''} · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    if (r.phase === 'done' || running.stop) {
      finishAttempt();
      attempt++; solver = null;
      if (attempt < attempts && !running.stop) { setTimeout(tick, 0); return; }
      state.timetable = { placements: best.placements, generatedAt: new Date().toISOString(), difficulty: best.difficulty, attempts: attempt };
      running = null; changed();
      const missing = best.total - best.placed;
      toast(missing ? `Best of ${attempt} attempt(s) leaves ${missing} session(s) unplaced — see below.` : `Best of ${attempt} attempt(s): every lesson placed, score ${best.cost}.`, 4500);
      render();
      return;
    }
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
}

function currentEngine() { return new Timetable.Engine(state, state.timetable.placements); }

function renderStats(box) {
  if (!state.timetable.generatedAt && !state.timetable.placements.length) { box.innerHTML = ''; return; }
  const e = currentEngine();
  const s = e.totalCost();
  const placed = e.pos.filter(Boolean).length;
  const unplaced = e.units.filter((u, i) => !e.pos[i]);
  const dif = state.timetable.difficulty;
  const name = (list, id) => esc(find(list, id)?.name || '?');
  box.innerHTML = `<div class="stats">
    <div class="stat"><b>${placed}/${e.units.length}</b><span>sessions placed</span></div>
    <div class="stat"><b>${s.classGaps}</b><span>class free gaps</span></div>
    <div class="stat"><b>${s.teacherGaps}</b><span>teacher free gaps</span></div>
    <div class="stat"><b>${s.dispreferred}</b><span>non-preferred periods used</span></div>
    <div class="stat"><b>${s.teacherMin}</b><span>teacher days below minimum</span></div>
    ${state.duties.length ? `<div class="stat"><b>${s.dutyUncovered}</b><span>duty periods uncovered</span></div>` : ''}
    <div class="stat"><b>${s.cost}</b><span>weighted score (lower is better)</span></div>
  </div>
  ${unplaced.length ? `<div class="unplaced"><h3>Not placed (${unplaced.length})</h3><ul class="issues">${unplaced.map((u) => `<li class="err">${esc(describeUnit(u.id))}</li>`).join('')}</ul>
    <p class="hint">Turn ✕ into ~, add rooms, or reduce sessions, then generate again — or place them by hand from the tray in Timetables (the message tells you what blocks each slot).</p></div>` : ''}
  ${dif && dif.total ? `<details class="difficulty"><summary>Difficulty report (${dif.total} rejections while building)</summary>
    <div class="dif-grid">
      <div><h4>Most rejected lessons</h4><ol>${dif.units.map((x) => `<li>${esc(describeUnit(x.id))} <span class="hint">×${x.n}</span></li>`).join('') || '<li>none</li>'}</ol></div>
      <div><h4>Classes</h4><ol>${dif.classes.map((x) => `<li>${name('classes', x.id)} <span class="hint">${x.pct}%</span></li>`).join('') || '<li>none</li>'}</ol></div>
      <div><h4>Teachers</h4><ol>${dif.teachers.map((x) => `<li>${name('teachers', x.id)} <span class="hint">${x.pct}%</span></li>`).join('') || '<li>none</li>'}</ol></div>
    </div><p class="hint">High percentages point to the classes/teachers whose constraints make the timetable hard — relax those first.</p></details>` : ''}
  ${state.timetable.generatedAt ? `<p class="hint">Last generated ${new Date(state.timetable.generatedAt).toLocaleString()}${state.timetable.attempts ? ` · best of ${state.timetable.attempts} attempt(s)` : ''}.</p>` : ''}`;
}

// ---------- Timetable views ----------
const MODES = { class: 'classes', teacher: 'teachers', room: 'rooms', duty: 'duties' };

// Parts of a placed unit that belong to the viewed entity.
function partsFor(e, u, mode, id) {
  const rooms = e.pos[u.i]?.rooms || [];
  return u.parts.map((p, k) => ({ ...p, room: rooms[k] })).filter((p) =>
    mode === 'class' ? p.classes.includes(id) : mode === 'teacher' ? p.teacher === id : mode === 'duty' ? p.kind === 'duty' && p.ref === id : p.room === id);
}

function unitsFor(e, mode, id) {
  return e.units.filter((u, i) => e.pos[i] && partsFor(e, u, mode, id).length);
}

function blockHtml(e, u, mode, id) {
  const parts = partsFor(e, u, mode, id);
  const color = partInfo(parts[0]).color;
  const body = parts.map((p) => {
    const info = partInfo(p);
    const room = p.room ? find('rooms', p.room)?.name : '';
    if (p.kind !== 'lesson') {
      const meta = p.kind === 'meeting' ? [room, `${u.teachers.length} teacher(s)`] : ['On call'];
      return `<div class="s">${esc(info.title)}</div><div class="m">${meta.filter(Boolean).map(esc).join(' · ')}</div>`;
    }
    const cls = p.classes.map((c) => find('classes', c)?.name).join('+');
    const tch = find('teachers', p.teacher); const tName = tch?.code || tch?.name || '';
    const meta = mode === 'class' ? [tName, room] : mode === 'teacher' ? [cls, room] : [cls, tName];
    return `<div class="s">${esc(info.title)}</div><div class="m">${meta.filter(Boolean).map(esc).join(' · ')}</div>`;
  }).join('');
  return `<div class="block${u.parts.length > 1 ? ' par' : ''}" draggable="true" data-unit="${esc(u.id)}" style="--c:${esc(color)}" title="${esc(describeUnit(u.id))}">
    ${e.locked[u.i] ? '<span class="lock" title="Locked">🔒</span>' : ''}${u.parts.length > 1 ? '<span class="partag" title="Lessons in this parallel group run at the same time">parallel</span>' : ''}${body}</div>`;
}

// Duty rota: every teacher on call in each period; empty duty periods are flagged.
function dutyGridHtml(e, id) {
  const st = state.settings;
  const svc = e.services[id]; if (!svc) return '<p class="hint">Nothing to show.</p>';
  let html = `<div class="table-wrap"><table class="tt duty"><thead><tr><th class="pcol">Period</th>${st.days.map((d) => `<th>${esc(d)}</th>`).join('')}</tr></thead><tbody>`;
  st.periods.forEach((pp, p) => {
    html += `<tr><th class="pcol">${esc(pp.label)}<small>${esc(pp.start)}${pp.end ? '–' + esc(pp.end) : ''}</small></th>`;
    st.days.forEach((_, d) => {
      const k = d * e.P + p;
      const on = [...svc.occ[k]];
      const cls = !svc.allowed.has(k) ? 'off' : on.length ? '' : 'uncov';
      html += `<td data-d="${d}" data-p="${p}" class="${cls}">${on.map((ui) => {
        const u = e.units[ui]; const t = find('teachers', u.teachers[0]);
        return `<div class="block mini" draggable="true" data-unit="${esc(u.id)}" style="--c:${DUTY_COLOR}" title="${esc(describeUnit(u.id))}">${e.locked[ui] ? '🔒 ' : ''}${esc(t?.name)}</div>`;
      }).join('')}${cls === 'uncov' ? '<span class="m">uncovered</span>' : ''}</td>`;
    });
    html += '</tr>';
  });
  return html + '</tbody></table></div>';
}

const gridFor = (e, mode, id) => (mode === 'duty' ? dutyGridHtml(e, id) : gridHtml(e, mode, id));

function gridHtml(e, mode, id) {
  const st = state.settings;
  const ent = find(MODES[mode], id);
  const off = new Set(ent?.unavailable || []); const soft = new Set(ent?.dispreferred || []);
  const at = {};
  unitsFor(e, mode, id).forEach((u) => { const s = e.pos[u.i].s; at[s] = u; for (let q = 1; q < u.len; q++) at[s + q] = 'cov'; });
  let html = `<div class="table-wrap"><table class="tt"><thead><tr><th class="pcol">Period</th>${st.days.map((d) => `<th>${esc(d)}</th>`).join('')}</tr></thead><tbody>`;
  st.periods.forEach((pp, p) => {
    html += `<tr><th class="pcol">${esc(pp.label)}<small>${esc(pp.start)}${pp.end ? '–' + esc(pp.end) : ''}</small></th>`;
    st.days.forEach((_, d) => {
      const k = d * e.P + p; const u = at[k];
      if (u === 'cov') return;
      const key = `${d}-${p}`;
      const cls = off.has(key) ? 'off' : soft.has(key) ? 'pref' : '';
      html += u ? `<td rowspan="${u.len}" data-d="${d}" data-p="${p}" class="${cls}">${blockHtml(e, u, mode, id)}</td>`
        : `<td data-d="${d}" data-p="${p}" class="${cls}"></td>`;
    });
    html += '</tr>';
  });
  return html + '</tbody></table></div>';
}

function masterHtml(e, kind = 'classes') {
  const st = state.settings;
  const mode = kind === 'classes' ? 'class' : 'teacher';
  let html = `<div class="table-wrap"><table class="master"><thead><tr><th rowspan="2">${kind === 'classes' ? 'Class' : 'Teacher'}</th>${st.days.map((d) => `<th class="day-start" colspan="${e.P}">${esc(d)}</th>`).join('')}</tr><tr>${st.days.map(() => st.periods.map((pp, i) => `<th class="${i === 0 ? 'day-start' : ''}">${esc(pp.label)}</th>`).join('')).join('')}</tr></thead><tbody>`;
  state[kind].forEach((x) => {
    const at = {};
    unitsFor(e, mode, x.id).forEach((u) => { for (let q = 0; q < u.len; q++) at[e.pos[u.i].s + q] = u; });
    html += `<tr><td class="name">${esc(x.code || x.name)}</td>`;
    for (let d = 0; d < e.D; d++) for (let p = 0; p < e.P; p++) {
      const u = at[d * e.P + p];
      if (!u) { html += `<td class="${p === 0 ? 'day-start' : ''}"></td>`; continue; }
      const parts = partsFor(e, u, mode, x.id);
      const info = partInfo(parts[0]);
      const label = parts.length > 1 ? parts.map((pp) => partInfo(pp).code).join('/')
        : kind === 'classes' || parts[0].kind !== 'lesson' ? info.code : parts[0].classes.map((c) => find('classes', c)?.name).join('+');
      html += `<td class="${p === 0 ? 'day-start' : ''}"><span class="cc" style="--c:${esc(info.color)}" title="${esc(describeUnit(u.id))}">${esc(label)}</span></td>`;
    }
    html += '</tr>';
  });
  return html + '</tbody></table></div>';
}

function renderTimetable(root) {
  const p = panel(root, 'Timetables', 'Drag a lesson, meeting or duty to another cell to move it — the move is checked against every hard rule. Drag from the “Not placed” tray to add one back. Click it to lock it, change its room or unschedule it.');
  const e = currentEngine();
  const master = ui.ttMode === 'master';
  const list = master ? [] : state[MODES[ui.ttMode]];
  if (!master && !list.some((x) => x.id === ui.ttEntity)) ui.ttEntity = list[0]?.id || null;
  const modes = ['class', 'teacher', 'room', ...(state.duties.length ? ['duty'] : []), 'master'];
  p.insertAdjacentHTML('beforeend', `<div class="tt-controls">
    <div class="seg">${modes.map((m) => `<button data-mode="${m}" class="${ui.ttMode === m ? 'on' : ''}">${{ class: 'By class', teacher: 'By teacher', room: 'By room', duty: 'Duty rota', master: 'Overview' }[m]}</button>`).join('')}</div>
    ${master ? `<select data-master aria-label="Overview rows"><option value="classes" ${ui.masterKind === 'classes' ? 'selected' : ''}>All classes</option><option value="teachers" ${ui.masterKind === 'teachers' ? 'selected' : ''}>All teachers</option></select>`
      : `<select data-entity aria-label="Choose">${list.map((x) => `<option value="${x.id}" ${x.id === ui.ttEntity ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`}
    <span class="spacer"></span>
    ${!master ? '<button class="ghost" data-csv>Export CSV</button><button class="ghost" data-print-one>Print</button>' : ''}
    <button class="ghost" data-html>Export HTML</button>
    <button class="ghost" data-print-all>Print all</button>
  </div>
  <div id="ttBody"></div><div id="tray"></div>`);
  const body = $('#ttBody', p);
  if (!e.pos.some(Boolean) && !state.timetable.generatedAt) body.innerHTML = '<p class="hint">No timetable yet — go to “8 · Generate”.</p>';
  else body.innerHTML = master ? masterHtml(e, ui.masterKind) : ui.ttEntity ? gridFor(e, ui.ttMode, ui.ttEntity) : '<p class="hint">Nothing to show.</p>';

  const unplaced = e.units.filter((u, i) => !e.pos[i] && (master || !ui.ttEntity || u.parts.some((pp) =>
    ui.ttMode === 'class' ? pp.classes.includes(ui.ttEntity) : ui.ttMode === 'teacher' ? pp.teacher === ui.ttEntity
      : ui.ttMode === 'duty' ? pp.kind === 'duty' && pp.ref === ui.ttEntity : (pp.roomCands || []).includes(ui.ttEntity))));
  if (unplaced.length && !master) {
    $('#tray', p).innerHTML = `<h3>Not placed (${unplaced.length})</h3><div class="tray">${unplaced.map((u) => {
      const title = u.kind === 'lesson' ? u.parts.map((pp) => partInfo(pp).title).join(' ∥ ') : partInfo(u.parts[0]).title;
      const sub = u.kind === 'lesson' ? u.classes.map((c) => find('classes', c)?.name).join('+') : u.teachers.map((t) => find('teachers', t)?.code || find('teachers', t)?.name).join(', ');
      return `<div class="block chip-block" draggable="true" data-unit="${esc(u.id)}" style="--c:${esc(partInfo(u.parts[0]).color)}" title="${esc(describeUnit(u.id))}"><div class="s">${esc(title)}${u.len > 1 ? ` ×${u.len}` : ''}</div><div class="m">${esc(sub)}</div></div>`;
    }).join('')}</div>`;
  }

  p.addEventListener('click', (ev) => {
    const t = ev.target.closest('button, .block'); if (!t) return;
    if (t.dataset.mode) { ui.ttMode = t.dataset.mode; render(); }
    else if (t.dataset.csv !== undefined) exportCsv(e);
    else if (t.dataset.printOne !== undefined) printGrids([ui.ttEntity]);
    else if (t.dataset.printAll !== undefined) printGrids(master ? null : list.map((x) => x.id));
    else if (t.dataset.html !== undefined) exportHtml();
    else if (t.dataset.unit && !t.classList.contains('chip-block')) lessonMenu(t.dataset.unit);
  });
  p.addEventListener('change', (ev) => {
    if (ev.target.dataset.entity !== undefined) { ui.ttEntity = ev.target.value; render(); }
    if (ev.target.dataset.master !== undefined) { ui.masterKind = ev.target.value; render(); }
  });
  p.addEventListener('dragstart', (ev) => { const b = ev.target.closest('.block'); if (b) ev.dataTransfer.setData('text/plain', b.dataset.unit); });
  body.addEventListener('dragover', (ev) => { const td = ev.target.closest('td[data-d]'); if (td) { ev.preventDefault(); td.classList.add('drop'); } });
  body.addEventListener('dragleave', (ev) => { const td = ev.target.closest('td[data-d]'); if (td) td.classList.remove('drop'); });
  body.addEventListener('drop', (ev) => {
    const td = ev.target.closest('td[data-d]'); if (!td) return;
    ev.preventDefault(); td.classList.remove('drop');
    moveUnit(ev.dataTransfer.getData('text/plain'), +td.dataset.d, +td.dataset.p);
  });
}

// Explain why unit u cannot start at s, or return null if it can.
function blockReason(e, u, s) {
  const p = s % e.P;
  if (p + u.len > e.P) return 'A multi-period lesson does not fit there.';
  if (!u.starts.includes(s)) return 'A teacher or class is marked ✕ (prohibited) at that time.';
  const base = e.baseConflicts(u.i, s);
  if (base === null) return 'That would exceed a teacher’s maximum periods per day.';
  if (base.size) {
    const who = [...base].map((o) => describeUnit(e.units[o].id));
    return `Clash with: ${who.slice(0, 2).join('; ')}${who.length > 2 ? ` (+${who.length - 2})` : ''}`;
  }
  return null;
}

function moveUnit(unitId, d, p) {
  const e = currentEngine();
  const u = e.unitById[unitId]; if (!u) return;
  const s = d * e.P + p;
  const old = e.pos[u.i];
  e.remove(u.i);
  const why = blockReason(e, u, s);
  if (why) { toast(why, 4500); return; }
  let rooms = old && e.roomsValid(u.i, s, old.rooms) && e.roomConflicts(u.i, s, old.rooms).size === 0 ? old.rooms : null;
  if (!rooms) { const pick = e.bestRooms(u.i, s, new Set()); if (pick && !pick.conf.size) rooms = pick.rooms; }
  if (!rooms) { toast('No free room of the required kind at that time.', 4000); return; }
  e.place(u.i, s, rooms); e.locked[u.i] = true;
  state.timetable.placements = e.placements();
  changed(); render();
  const softHit = e.unitCost(u.i) - e.W.late * ((s % e.P) + u.len - 1) > 0;
  toast(`${old ? 'Moved' : 'Placed'} and locked.${softHit ? ' Note: uses a non-preferred period.' : ''}`);
}

function lessonMenu(unitId) {
  const e = currentEngine();
  const u = e.unitById[unitId]; const pos = u && e.pos[u.i];
  if (!pos) return;
  const pl = state.timetable.placements.find((x) => x.unitId === unitId);
  const st = state.settings; const day = e.dayOf(pos.s); const per = pos.s % e.P;
  e.remove(u.i);
  const roomRows = u.parts.map((part, k) => {
    if (!part.roomCands) return '';
    const opts = part.roomCands.map((r) => {
      const busy = e.roomConflicts(u.i, pos.s, u.parts.map((_, j) => (j === k ? r : null))).size > 0 || [...Array(u.len).keys()].some((q) => e.blocked['r' + r].has(pos.s + q));
      return `<option value="${r}" ${pos.rooms[k] === r ? 'selected' : ''} ${busy && pos.rooms[k] !== r ? 'disabled' : ''}>${esc(find('rooms', r)?.name)}${busy && pos.rooms[k] !== r ? ' (busy)' : ''}</option>`;
    }).join('');
    return `<label class="row" style="margin:6px 0">${esc(describePart(part))}: <select data-part="${k}">${opts}</select></label>`;
  }).join('');
  e.place(u.i, pos.s, pos.rooms);
  openModal(describeUnit(unitId), `<p>${esc(st.days[day])}, period ${esc(st.periods[per].label)}${u.len > 1 ? `–${esc(st.periods[per + u.len - 1].label)}` : ''}</p>
    ${roomRows ? `<h4>Room</h4>${roomRows}` : '<p class="hint">No room needed.</p>'}
    <p class="hint">${pl.locked ? '🔒 Locked — kept in place when regenerating.' : 'Not locked — may move when regenerating.'}</p>`,
  (v) => {
    if (v === 'lock') pl.locked = !pl.locked;
    else if (v === 'remove') state.timetable.placements = state.timetable.placements.filter((x) => x !== pl);
    else if (v === 'rooms') {
      const rooms = u.parts.map((_, k) => $(`#modalContent [data-part="${k}"]`)?.value || null);
      e.remove(u.i);
      if (!e.roomsValid(u.i, pos.s, rooms) || e.roomConflicts(u.i, pos.s, rooms).size) { toast('Those rooms are not free or are used twice.'); return; }
      pl.rooms = rooms;
    } else return;
    changed(); render();
  },
  `<button value="remove" class="ghost">Unschedule</button>${roomRows ? '<button value="rooms" class="ghost">Apply room</button>' : ''}<button value="lock" class="ghost">${pl.locked ? 'Unlock' : 'Lock'}</button><button value="close">Close</button>`);
}

function exportCsv(e) {
  const st = state.settings;
  const ent = find(MODES[ui.ttMode], ui.ttEntity); if (!ent) return;
  const at = {};
  unitsFor(e, ui.ttMode, ent.id).forEach((u) => { for (let q = 0; q < u.len; q++) at[e.pos[u.i].s + q] = u; });
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Period', 'Time', ...st.days].map(q).join(',')];
  st.periods.forEach((pp, p) => {
    rows.push([pp.label, `${pp.start}-${pp.end}`, ...st.days.map((_, d) => {
      const u = at[d * e.P + p]; if (!u) return '';
      return partsFor(e, u, ui.ttMode, ent.id).map((part) => [partInfo(part).title, find('teachers', part.teacher)?.name,
        part.classes.map((id) => find('classes', id)?.name).join('+'), part.room && find('rooms', part.room)?.name].filter(Boolean).join(' / ')).join(' | ');
    })].map(q).join(','));
  });
  download(`${ent.name}-timetable.csv`, rows.join('\r\n'), 'text/csv');
}

function allPagesHtml(e) {
  const title = esc(state.settings.name);
  if (ui.ttMode === 'master') return `<div class="print-page"><h2>${title} — all ${esc(ui.masterKind)}</h2>${masterHtml(e, ui.masterKind)}</div>`;
  return state[MODES[ui.ttMode]].map((x) => `<div class="print-page"><h2>${title} — ${esc(x.name)}</h2>${gridFor(e, ui.ttMode, x.id)}</div>`).join('');
}

function printGrids(ids) {
  const e = currentEngine();
  const title = esc(state.settings.name);
  $('#printArea').innerHTML = ids === null || ui.ttMode === 'master' ? allPagesHtml(e)
    : ids.filter(Boolean).map((id) => `<div class="print-page"><h2>${title} — ${esc(find(MODES[ui.ttMode], id)?.name)}</h2>${gridFor(e, ui.ttMode, id)}</div>`).join('');
  window.print();
}

// Standalone page with every timetable of the current view, for sharing or a school website.
function exportHtml() {
  const e = currentEngine();
  const css = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules].map((r) => r.cssText); } catch { return []; } }).join('\n');
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(state.settings.name)} timetables</title><style>${css}
    body{padding:16px} .print-page{margin-bottom:28px} .block{cursor:default}</style></head><body>${allPagesHtml(e).replace(/draggable="true"/g, '')}</body></html>`;
  download(`${state.settings.name || 'school'}-${ui.ttMode === 'master' ? ui.masterKind : MODES[ui.ttMode]}.html`, doc, 'text/html');
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Global wiring ----------
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  ui.tab = b.dataset.tab;
  try { localStorage.setItem(STORAGE_KEY + '.tab', ui.tab); } catch { /* ignore */ }
  render();
});
$('#schoolName').addEventListener('change', (e) => { state.settings.name = e.target.value; changed(); });
document.querySelector('.top-actions').addEventListener('click', (e) => {
  const a = e.target.dataset.action;
  if (a === 'sample' && confirm('Replace current data with the sample school?')) { state = sampleState(); changed(); render(); }
  if (a === 'new' && confirm('Start a new, empty school? Unsaved data will be lost.')) { state = emptyState(); changed(); ui.tab = 'setup'; render(); }
  if (a === 'export') download(`${state.settings.name || 'school'}-timetable.json`, JSON.stringify(state, null, 2), 'application/json');
  if (a === 'import') $('#importFile').click();
});
$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data.settings || !Array.isArray(data.lessons)) throw new Error('not a timetable file');
    state = migrate(Object.assign(emptyState(), data)); changed(); render(); toast('File loaded.');
  } catch (err) { toast(`Could not open file: ${err.message}`); }
  e.target.value = '';
});

render();
