// School Timetable Generator — UI layer: rendering, events and generation. The data model
// (state shape, migration, slot arithmetic, validation) lives in model.js as window.Model; every
// Model function takes the state it works on. `state` is autosaved to localStorage.
const {
  uid, esc, PALETTE, teacherDefaults, WEIGHT_LABELS, PERIOD_TYPES, RELATION_TYPES: REL_LABELS, emptyState, sampleState, migrate,
  unitBlockReason, pinSessions, pinName, pinAt, setPin, dropDeadPins,
  newLesson, homeroomOf, applyHomeroom, gradeOf, curriculumGaps, curriculumSubjects, deriveCurriculum, applyCurriculum, missingLessons, parseLengths, canPartition, partition, sessionsOf, periodsOf, lengthsText, dropDeadRelations, addRelation, removeRelation, removeLesson,
  periodType, isTeachingPeriod, teachingPeriods, generalBlocked, dutyKind, slotDisabled, selectableKeys, cellsOf,
  availableSlots, dutySlots, workload, usesDispreferred, pruneDeadKeys, prunePlacements, describeLesson, describeUnit, validate,
} = window.Model;
const $ = (s, r = document) => r.querySelector(s);
const STORAGE_KEY = 'school-timetable.v1';
const MEETING_COLOR = '#64748b';
const ACTIVITY_COLOR = '#0e7490';
const DUTY_COLOR = '#a16207';

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
  const views = { setup: renderSetup, teachers: renderTeachers, classes: renderClasses, rooms: renderRooms, subjects: renderSubjects, grades: renderGrades, lessons: renderLessons, staff: renderStaff, generate: renderGenerate, timetable: renderTimetable };
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
  const p = panel(root, 'Week structure', 'Define teaching days and the periods in each day. Every lesson session occupies one or more consecutive teaching periods. Break and lunch periods are never used for lessons or meetings — only break supervision duties go there.');
  const st = state.settings;
  const nBlocked = (st.blocked || []).length;
  p.querySelector('[data-slot=actions]').innerHTML = `<button class="ghost" data-template title="Periods when nobody at all is scheduled (whole-school events, half days)">General template${nBlocked ? ` (${nBlocked} ✕)` : ''}</button>`;
  p.insertAdjacentHTML('beforeend', `
    <h3>Days</h3>
    <div class="table-wrap"><table class="edit"><thead><tr><th>#</th><th>Day name</th><th></th></tr></thead><tbody>
      ${st.days.map((d, i) => `<tr><td>${i + 1}</td><td><input data-day="${i}" value="${esc(d)}" aria-label="Day ${i + 1}"></td><td><button class="danger" data-del-day="${i}" title="Remove day">✕</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="row" style="margin:8px 0 16px"><button class="ghost" data-add-day>+ Add day</button></div>
    <h3>Periods</h3>
    <div class="table-wrap"><table class="edit"><thead><tr><th>Label</th><th>Start</th><th>End</th><th title="Break and lunch periods hold no lessons">Type</th><th></th></tr></thead><tbody>
      ${st.periods.map((pp, i) => `<tr class="${isTeachingPeriod(state, i) ? '' : 'brk'}">
        <td><input data-period="${i}" data-f="label" value="${esc(pp.label)}" aria-label="Period label"></td>
        <td><input type="time" data-period="${i}" data-f="start" value="${esc(pp.start)}" aria-label="Start"></td>
        <td><input type="time" data-period="${i}" data-f="end" value="${esc(pp.end)}" aria-label="End"></td>
        <td><select data-period="${i}" data-f="type" aria-label="Period type">${Object.keys(PERIOD_TYPES).map((ty) => `<option value="${ty}" ${periodType(state, i) === ty ? 'selected' : ''}>${PERIOD_TYPES[ty]}</option>`).join('')}</select></td>
        <td><button class="danger" data-del-period="${i}" title="Remove period">✕</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="row" style="margin-top:8px"><button class="ghost" data-add-period>+ Add period</button></div>
    <h3>Options</h3>
    <label class="row" style="gap:6px"><input type="checkbox" data-midday ${st.options.countMiddayGap ? 'checked' : ''}> Count free periods across lunch as a gap</label>
    <p class="hint" style="margin-top:4px">Off: a class or teacher who is free just before and just after lunch is not penalised for a gap. On: the gap counts like any other.</p>`);
  p.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.day) st.days[+t.dataset.day] = t.value;
    if (t.dataset.period) st.periods[+t.dataset.period][t.dataset.f] = t.value;
    if (t.dataset.midday !== undefined) st.options.countMiddayGap = t.checked;
    if (t.dataset.f === 'type') periodTypeChanged(+t.dataset.period);
    changed();
    if (t.dataset.f === 'type') render();
  });
  p.addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.template !== undefined) { editGeneralTemplate(); return; }
    if (t.dataset.addDay !== undefined) { st.days.push(`Day ${st.days.length + 1}`); resetTimetable('Week changed'); }
    else if (t.dataset.delDay) { if (st.days.length > 1) { st.days.splice(+t.dataset.delDay, 1); resetTimetable('Week changed'); } }
    else if (t.dataset.addPeriod !== undefined) { st.periods.push({ label: String(st.periods.length + 1), start: '', end: '', type: 'teaching' }); resetTimetable('Week changed'); }
    else if (t.dataset.delPeriod) { if (st.periods.length > 1) { st.periods.splice(+t.dataset.delPeriod, 1); resetTimetable('Week changed'); } }
    else return;
    render();
  });
}

// A period of a new type keeps the week shape, but placements and template keys on it may be dead now.
function periodTypeChanged(i) {
  const pp = state.settings.periods[i]; const ty = periodType(state, i);
  const removed = prunePlacements(state);
  pruneDeadKeys(state);
  if (removed) toast(`${removed} placement(s) removed because period ${pp.label} is now ${ty === 'teaching' ? 'a teaching period' : `a ${ty}`}.`, 4500);
}

// Changing the week shape invalidates slot indices, so availability and placements are cleared.
function resetTimetable(reason) {
  ['teachers', 'classes', 'rooms', 'subjects'].forEach((k) => state[k].forEach((x) => { x.unavailable = []; x.dispreferred = []; x.dispreferred2 = []; }));
  state.settings.blocked = [];
  state.timetable = { placements: [], generatedAt: null, difficulty: null };
  changed();
  toast(`${reason}: availability and timetable were reset.`);
}

function availLabel(x) {
  const b = (x.unavailable || []).length, s = (x.dispreferred || []).length, s2 = (x.dispreferred2 || []).length;
  return `Availability${b || s || s2 ? ` (${[b && `${b} ✕`, s2 && `${s2} ~~`, s && `${s} ~`].filter(Boolean).join(', ')})` : ''}`;
}

function entityEditor(root, { list, title, hint, cols, loadKey, extra }) {
  const p = panel(root, title, hint);
  p.querySelector('[data-slot=actions]').innerHTML = `<button data-add>+ Add</button>`;
  const load = loadKey ? workload(state)[loadKey] : null;
  const rows = state[list].map((x) => `<tr data-id="${x.id}">
      ${cols.map((c) => `<td>${c.input(x)}</td>`).join('')}
      ${load ? `<td class="load ${(load[x.id] || 0) > availableSlots(state, x) ? 'over' : ''}">${load[x.id] || 0} / ${availableSlots(state, x)}</td>` : ''}
      ${extra ? `<td>${extra.html(x)}</td>` : ''}
      <td><button class="ghost" data-avail>${availLabel(x)}</button></td>
      <td><button class="danger" data-del title="Delete">✕</button></td></tr>`).join('');
  p.insertAdjacentHTML('beforeend', state[list].length
    ? `<div class="table-wrap"><table class="edit"><thead><tr>${cols.map((c) => `<th>${c.label}</th>`).join('')}${load ? '<th>Periods / free</th>' : ''}${extra ? `<th>${extra.label}</th>` : ''}<th></th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="hint">Nothing here yet. Click “+ Add”.</p>`);
  p.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const x = find(list, tr.dataset.id);
    x[e.target.dataset.f] = e.target.type === 'number' ? Number(e.target.value) : e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    changed();
    if (cols.rerender && cols.rerender.includes(e.target.dataset.f)) render();
  });
  p.addEventListener('click', (e) => {
    if (e.target.dataset.add !== undefined) { state[list].push(cols.newItem()); changed(); render(); return; }
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const x = find(list, tr.dataset.id);
    if (e.target.dataset.del !== undefined) {
      if (!confirm(`Delete “${x.name}”? Lessons that use it will be updated.`)) return;
      state[list] = state[list].filter((y) => y !== x);
      cleanupRefs(); changed(); render();
    } else if (extra && e.target.dataset[extra.act] !== undefined) {
      extra.run(x);
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
    if (l.room && l.room !== 'home' && !l.room.startsWith('type:') && !r.has(l.room)) l.room = '';
  });
  state.classes.forEach((c) => { if (c.homeroom && !r.has(c.homeroom)) c.homeroom = ''; });
  state.grades.forEach((g) => { g.curriculum = g.curriculum.filter((e) => s.has(e.subjectId)); });
  state.lessons = state.lessons.filter((l) => s.has(l.subjectId));
  dropDeadRelations(state);
  dropDeadPins(state);
  state.activities.forEach((a) => { if (!t.has(a.teacherId)) a.teacherId = ''; });
  state.meetings.forEach((m) => {
    m.teacherIds = (m.teacherIds || []).filter((id) => t.has(id));
    if (m.room && !m.room.startsWith('type:') && !r.has(m.room)) m.room = '';
  });
  state.duties.forEach((d) => { d.assignments = (d.assignments || []).filter((a) => t.has(a.teacherId)); });
}

const textCol = (label, f, ph = '') => ({ label, input: (x) => `<input data-f="${f}" value="${esc(x[f])}" placeholder="${ph}" aria-label="${label}">` });
const numCol = (label, f, title, max = teachingPeriods(state)) => ({ label: `<span title="${title}">${label}</span>`, input: (x) => `<input type="number" min="0" max="${max}" data-f="${f}" value="${x[f] || ''}" placeholder="—" style="max-width:80px" aria-label="${label}">` });
const boolCol = (label, f, title) => ({ label: `<span title="${title}">${label}</span>`, input: (x) => `<input type="checkbox" data-f="${f}" ${x[f] ? 'checked' : ''} aria-label="${label}">` });

function renderTeachers(root) {
  const cols = [textCol('Name', 'name'), textCol('Code', 'code', 'e.g. ARA'),
    numCol('Max/day', 'maxPerDay', 'Hard limit: never more periods than this in one day'),
    numCol('Min/day', 'minPerDay', 'Preference: on days they teach, at least this many periods'),
    numCol('Max in a row', 'maxConsecutive', 'Preference: no more than this many teaching periods back to back (a break or lunch ends the run)'),
    numCol('Free days', 'freeDays', 'Hard limit: this many working days with no lessons at all (meetings and duties may still use them)', state.settings.days.length),
    numCol('Presence/day', 'maxPresenceDay', 'Time at school in a day, first to last period including free periods. Preference, or a hard limit when “Strict” is ticked', teachingPeriods(state)),
    numCol('Presence/week', 'maxPresenceWeek', 'Time at school in the week (sum of the daily presence). Preference, or a hard limit when “Strict” is ticked', teachingPeriods(state) * state.settings.days.length),
    boolCol('Strict', 'presenceStrict', 'Make the presence limits hard rules instead of preferences'),
    boolCol('No last→first', 'noLastFirst', 'Preference: not the last period of one day and the first period of the next')];
  cols.newItem = () => ({ id: uid(), name: `Teacher ${state.teachers.length + 1}`, code: '', unavailable: [], dispreferred: [], dispreferred2: [], ...teacherDefaults() });
  entityEditor(root, { list: 'teachers', title: 'Teachers', hint: 'Availability: ✕ = prohibited (never scheduled), ~ = non-preferred (avoided when possible). Prefer ~ over ✕ — it keeps the timetable solvable. Load includes meetings and teaching-period duties (break supervision is counted against break periods instead); red = more periods than free slots. Max/day counts teaching only.', cols, loadKey: 't' });
}

function renderClasses(root) {
  const cols = [textCol('Name', 'name', 'e.g. 7B'),
    { label: '<span title="The grade (year group) this class belongs to. Its curriculum lists the subjects and weekly periods the class should have — see the Grades tab.">Grade</span>',
      input: (x) => `<select data-f="gradeId" aria-label="Grade"><option value="">— none —</option>${state.grades.map((g) => `<option value="${g.id}" ${x.gradeId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>` },
    { label: '<span title="The room this class normally sits in. Lessons set to “Class homeroom” use it, and follow it when it changes.">Homeroom</span>',
      input: (x) => `<select data-f="homeroom" aria-label="Homeroom"><option value="">— none —</option>${state.rooms.map((r) => `<option value="${r.id}" ${x.homeroom === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>` }];
  cols.newItem = () => ({ id: uid(), name: `Class ${state.classes.length + 1}`, unavailable: [], dispreferred: [], dispreferred2: [], homeroom: '', gradeId: '' });
  cols.rerender = ['homeroom'];
  const extra = {
    label: 'Lessons', act: 'homeApply',
    html: (x) => { const n = state.lessons.filter((l) => l.room === 'home' && (l.classIds || []).includes(x.id)).length; return `<button class="ghost small" data-home-apply ${x.homeroom ? '' : 'disabled'} title="Set the room of this class’s own lessons that have none (or ask for any room of the homeroom’s type) to “Class homeroom”">Use in lessons${n ? ` (${n} now)` : ''}</button>`; },
    run: (x) => {
      const r = applyHomeroom(state, x.id);
      toast(r.none + r.type ? `${r.none + r.type} lesson row(s) of ${x.name} now use the homeroom${r.type ? ` (${r.type} keep “Any ${find('rooms', x.homeroom).type}” as a fallback)` : ''}.` : `No lesson row of ${x.name} needed changing.`, 4000);
      changed(); render();
    },
  };
  entityEditor(root, { list: 'classes', title: 'Classes', hint: 'Class groups of students. Use ✕ for fixed events (assembly), ~ for periods to leave free if possible. Give a class a homeroom once, then pick “Class homeroom” as the room of its lessons (or use the button) — changing the homeroom later moves all of them.', cols, loadKey: 'c', extra });
}

function renderRooms(root) {
  const cols = [textCol('Name', 'name'), textCol('Type', 'type', 'Classroom, Lab…')];
  cols.newItem = () => ({ id: uid(), name: `Room ${state.rooms.length + 1}`, type: 'Classroom', unavailable: [], dispreferred: [], dispreferred2: [] });
  entityEditor(root, { list: 'rooms', title: 'Rooms', hint: 'Rooms of the same type form a set of alternatives — a lesson asking for “Any Lab” gets whichever lab is free.', cols });
}

function renderSubjects(root) {
  const p = panel(root, 'Subjects', 'Colour and short code are used in the timetables. Availability: ✕ = the subject is never scheduled then (PE never in period 1), ~ = avoided when possible; it applies to every lesson of the subject.');
  p.querySelector('[data-slot=actions]').innerHTML = `<button data-add>+ Add</button>`;
  p.insertAdjacentHTML('beforeend', state.subjects.length ? `<div class="table-wrap"><table class="edit"><thead><tr><th>Colour</th><th>Name</th><th>Code</th><th></th><th></th></tr></thead><tbody>
    ${state.subjects.map((s) => `<tr data-id="${s.id}"><td><input type="color" data-f="color" value="${esc(s.color)}" aria-label="Colour"></td><td><input data-f="name" value="${esc(s.name)}" aria-label="Name"></td><td><input data-f="code" value="${esc(s.code)}" style="max-width:100px" aria-label="Code"></td><td><button class="ghost" data-avail title="Periods when this subject is never (✕) or preferably not (~) scheduled, for every class and teacher">${availLabel(s)}</button></td><td><button class="danger" data-del>✕</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="hint">Nothing here yet. Click “+ Add”.</p>');
  p.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    find('subjects', tr.dataset.id)[e.target.dataset.f] = e.target.value; changed();
  });
  p.addEventListener('click', (e) => {
    if (e.target.dataset.add !== undefined) {
      state.subjects.push({ id: uid(), name: `Subject ${state.subjects.length + 1}`, code: '', color: PALETTE[state.subjects.length % PALETTE.length], unavailable: [], dispreferred: [], dispreferred2: [] });
      changed(); render();
    } else if (e.target.dataset.avail !== undefined) {
      const sj = find('subjects', e.target.closest('tr').dataset.id); editAvailability(sj, `Subject: ${sj.name}`);
    } else if (e.target.dataset.del !== undefined) {
      const id = e.target.closest('tr').dataset.id;
      const n = state.lessons.filter((l) => l.subjectId === id).length;
      if (!confirm(`Delete subject${n ? ` and its ${n} lesson(s)` : ''}?`)) return;
      state.subjects = state.subjects.filter((s) => s.id !== id); cleanupRefs(); changed(); render();
    }
  });
}

// ---------- Grades & curriculum ----------
function renderGrades(root) {
  const p = panel(root, 'Grades & curriculum', 'A grade is a year group. Its curriculum lists the subjects every class of the grade takes, with the weekly periods. Generate → data validation warns when a class has too few, too many or no lessons of a curriculum subject; the Lessons tab offers the curriculum subjects first; and “Create missing lessons” adds one row for each subject a class has no lessons for (pick the teacher afterwards). Assign classes to a grade on the Classes tab.');
  p.querySelector('[data-slot=actions]').innerHTML = '<button data-add>+ Add grade</button>';
  p.insertAdjacentHTML('beforeend', state.grades.length ? `<div class="table-wrap"><table class="edit"><thead><tr><th>Name</th><th>Classes</th><th>Curriculum</th><th></th><th></th></tr></thead><tbody>
    ${state.grades.map((g) => {
    const classes = state.classes.filter((c) => c.gradeId === g.id);
    const total = g.curriculum.reduce((a, e) => a + e.periods, 0); const missing = missingLessons(state, g.id);
    return `<tr data-id="${g.id}"><td><input data-f="name" value="${esc(g.name)}" aria-label="Grade name"></td>
      <td>${classes.map((c) => `<span class="chip">${esc(c.name)}</span>`).join('') || '<span class="hint">none — set the grade on the Classes tab</span>'}</td>
      <td><button class="ghost" data-curr>${g.curriculum.length} subject(s), ${total} periods</button></td>
      <td><button class="ghost small" data-create ${missing ? '' : 'disabled'} title="Add a row for every curriculum subject a class of this grade has no lessons for">Create missing lessons${missing ? ` (${missing})` : ''}</button></td>
      <td><button class="danger" data-del title="Delete">✕</button></td></tr>`;
  }).join('')}</tbody></table></div>` : '<p class="hint">No grades yet. Click “+ Add grade”.</p>');
  p.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr || e.target.dataset.f !== 'name') return;
    state.grades.find((g) => g.id === tr.dataset.id).name = e.target.value; changed();
  });
  p.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.add !== undefined) { state.grades.push({ id: uid(), name: `Grade ${state.grades.length + 1}`, curriculum: [] }); changed(); render(); return; }
    const tr = btn.closest('tr[data-id]'); if (!tr) return;
    const g = state.grades.find((x) => x.id === tr.dataset.id);
    if (btn.dataset.curr !== undefined) editCurriculum(g);
    else if (btn.dataset.create !== undefined) {
      const n = state.classes.filter((c) => c.gradeId === g.id).reduce((a, c) => a + applyCurriculum(state, c.id), 0);
      toast(`${n} lesson row(s) added — choose a teacher for each on the Lessons tab.`, 4000); changed(); render();
    } else if (btn.dataset.del !== undefined) {
      if (!confirm(`Delete grade “${g.name}”? Its classes keep their lessons but lose the grade.`)) return;
      state.grades = state.grades.filter((x) => x !== g); state.classes.forEach((c) => { if (c.gradeId === g.id) c.gradeId = ''; });
      changed(); render();
    }
  });
}

// Curriculum of one grade: weekly periods per subject (blank or 0 = not taught).
function editCurriculum(g) {
  const per = Object.fromEntries(g.curriculum.map((e) => [e.subjectId, e.periods]));
  const classes = state.classes.filter((c) => c.gradeId === g.id);
  const rows = state.subjects.map((x) => `<tr data-sid="${x.id}"><td><span class="chip" style="background:${esc(x.color)};color:#fff">${esc(x.code || x.name.slice(0, 3))}</span> ${esc(x.name)}</td><td><input type="number" min="0" max="${teachingPeriods(state) * D()}" value="${per[x.id] || ''}" placeholder="—" style="max-width:80px" aria-label="Periods per week of ${esc(x.name)}"></td></tr>`).join('');
  openModal(`Curriculum — ${g.name}`, `
    ${state.subjects.length ? `<div class="table-wrap"><table class="edit"><thead><tr><th>Subject</th><th>Periods / week</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">Add subjects first.</p>'}
    <p class="hint" id="currTotal"></p>
    ${classes.length ? `<label class="row" style="gap:6px;margin-top:8px">Fill from the lessons of <select id="currFrom">${classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select> <button type="button" class="ghost small" id="currFill">Fill</button></label>` : ''}`, (v) => {
    if (v !== 'save') return;
    g.curriculum = [...$('#modalContent').querySelectorAll('tr[data-sid]')]
      .map((tr) => ({ subjectId: tr.dataset.sid, periods: Math.floor(Number(tr.querySelector('input').value)) }))
      .filter((e) => e.periods >= 1);
    changed(); render();
  }, '<button value="cancel" class="ghost">Cancel</button><button value="save">Save</button>');
  const total = () => { const n = [...$('#modalContent').querySelectorAll('tr[data-sid] input')].reduce((a, i) => a + (Math.floor(Number(i.value)) || 0), 0); $('#currTotal').textContent = `${n} periods per week in total (a class has ${classes.length ? availableSlots(state, classes[0]) : selectableKeys(state).length} free slots).`; };
  total();
  $('#modalContent').oninput = total;
  const fill = $('#currFill');
  if (fill) fill.onclick = () => {
    const cur = Object.fromEntries(deriveCurriculum(state, $('#currFrom').value).map((e) => [e.subjectId, e.periods]));
    $('#modalContent').querySelectorAll('tr[data-sid]').forEach((tr) => { tr.querySelector('input').value = cur[tr.dataset.sid] || ''; });
    total();
  };
}

function roomOptions(sel, lesson = null) {
  const types = [...new Set(state.rooms.map((r) => r.type).filter(Boolean))];
  const homeName = lesson && find('rooms', homeroomOf(state, lesson.classIds))?.name;
  const home = lesson ? `<option value="home" ${sel === 'home' ? 'selected' : ''}>Class homeroom${homeName ? ` (${esc(homeName)})` : sel === 'home' ? ' (none set!)' : ''}</option>` : '';
  return `<option value="" ${!sel ? 'selected' : ''}>No room needed</option>${home}
    <optgroup label="Any room of type">${types.map((t) => `<option value="type:${esc(t)}" ${sel === 'type:' + t ? 'selected' : ''}>Any ${esc(t)}</option>`).join('')}</optgroup>
    <optgroup label="Specific room">${state.rooms.map((r) => `<option value="${r.id}" ${sel === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</optgroup>`;
}

// "Any <type>" choices for the alternative room set of a lesson row.
function roomAltOptions(sel) {
  const types = [...new Set(state.rooms.map((r) => r.type).filter(Boolean))];
  return `<option value="" ${!sel ? 'selected' : ''}>— none —</option>${types.map((t) => `<option value="type:${esc(t)}" ${sel === 'type:' + t ? 'selected' : ''}>Any ${esc(t)}</option>`).join('')}`;
}

const ROW_OPTIONS = [
  ['sameRoom', 'Same room for all sessions', 'Hard rule: every session of this row uses one and the same room.'],
  ['penalizeEnds', 'Avoid the first and last period of the day', 'Soft: weighted by “Lesson in the first or last period of a day”.'],
  ['avoidConsecutiveDays', 'Avoid consecutive days', 'Soft, for rows with 2–3 sessions only: spread them across the week. Ignored for other rows.'],
  ['allowBreakInside', 'Break inside', 'A multi-period session may straddle a break (never lunch).'],
  ['maxOnePerDay', 'At most one session per day', 'Hard rule: the sessions of this row go on different days.'],
];

// The distribution cell of a row: the session lengths, or — for a flexible row — the engine's
// current choice when a timetable exists, else the flexible spec. `eng` is null without a timetable.
function distributionCell(l, eng) {
  if (!l.flexible) return `<input data-f="lengths" value="${esc(lengthsText(l.lengths))}" placeholder="e.g. 2 2 1" class="dist" aria-label="Distribution" title="Session lengths, e.g. “2 2 1” = two doubles and a single">`;
  const f = l.flexible;
  const chosen = eng && eng.groupLengths && eng.lessonGroup && eng.groupLengths[eng.lessonGroup[l.id]];
  const text = chosen ? `${lengthsText(chosen)} (flexible ${f.total}, ${f.min}–${f.max})` : `flexible: total ${f.total} (${f.min}–${f.max})`;
  return `<input value="${esc(text)}" readonly class="dist flex" aria-label="Distribution" title="The engine chooses blocks of ${f.min}–${f.max} periods adding up to ${f.total}">`;
}

function renderLessons(root) {
  const p = panel(root, 'Lessons', 'Each row is “subject × teacher × class(es)”. <b>Distribution</b> lists the length of every weekly session: “2 2 1” = two doubles and a single; <b>Flexible</b> lets the engine choose the split. Several classes = joint lesson. Give rows the same <b>Parallel group</b> name to run them at the same time (split classes, electives, sets) — they need the same distribution. <b>Room</b> is the preferred (or only) room; <b>Alternatives</b> adds every room of a type as fallback. <b>Options</b> holds the per-row rules (1/day, break inside, same room, …); <b>Relations</b> ties rows together (different days, consecutive, …).');
  if (ui.gradeFilter && !state.grades.some((g) => g.id === ui.gradeFilter)) ui.gradeFilter = '';
  const gradeClasses = state.classes.filter((c) => !ui.gradeFilter || c.gradeId === ui.gradeFilter);
  if (ui.lessonFilter && !gradeClasses.some((c) => c.id === ui.lessonFilter)) ui.lessonFilter = '';
  p.querySelector('[data-slot=actions]').innerHTML = `${state.grades.length ? `<select data-gfilter aria-label="Filter by grade"><option value="">All grades</option>${state.grades.map((g) => `<option value="${g.id}" ${ui.gradeFilter === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>` : ''}<select data-filter aria-label="Filter by class"><option value="">All classes</option>${gradeClasses.map((c) => `<option value="${c.id}" ${ui.lessonFilter === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><button data-add>+ Add lesson</button>`;
  const inGrade = (l) => !ui.gradeFilter || (l.classIds || []).some((id) => find('classes', id)?.gradeId === ui.gradeFilter);
  const list = state.lessons.filter((l) => inGrade(l) && (!ui.lessonFilter || (l.classIds || []).includes(ui.lessonFilter)));
  // Subjects of the row's grade curriculum come first; every other subject stays selectable.
  const subjectOptions = (l) => {
    const cur = curriculumSubjects(state, l.classIds);
    const o = (x) => `<option value="${x.id}" ${x.id === l.subjectId ? 'selected' : ''}>${esc(x.name)}</option>`;
    if (!cur) return state.subjects.map(o).join('');
    const inC = state.subjects.filter((x) => cur.has(x.id)), rest = state.subjects.filter((x) => !cur.has(x.id));
    return `<optgroup label="In the ${esc(gradeOf(state, l.classIds[0]).name)} curriculum">${inC.map(o).join('')}</optgroup>${rest.length ? `<optgroup label="Other subjects">${rest.map(o).join('')}</optgroup>` : ''}`;
  };
  const opt = (arr, sel, empty) => `${empty ? `<option value="">${empty}</option>` : ''}${arr.map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}`;
  const groups = [...new Set(state.lessons.map((l) => (l.parallel || '').trim()).filter(Boolean))];
  const eng = state.lessons.some((l) => l.flexible) && state.timetable.placements.length ? currentEngine() : null;
  const nOpts = (l) => ROW_OPTIONS.filter(([k]) => l[k]).length;
  p.insertAdjacentHTML('beforeend', list.length ? `<datalist id="parallelGroups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
    <div class="table-wrap"><table class="edit lessons"><thead><tr><th>Subject</th><th>Teacher</th><th>Classes</th><th title="Preferred room, or any room of a type">Room</th><th title="Fallback: any room of this type">Alternatives</th><th title="Length of every weekly session, e.g. 2 2 1">Distribution</th><th title="Rows with the same name are scheduled simultaneously">Parallel group</th><th></th><th></th><th></th><th></th></tr></thead><tbody>
    ${list.map((l) => `<tr data-id="${l.id}">
      <td><select data-f="subjectId" aria-label="Subject">${subjectOptions(l)}</select></td>
      <td><select data-f="teacherId" aria-label="Teacher">${opt(state.teachers, l.teacherId, '— choose —')}</select></td>
      <td><button class="ghost" data-classes>${(l.classIds || []).map((id) => `<span class="chip">${esc(find('classes', id)?.name)}</span>`).join('') || '— choose —'}</button></td>
      <td><select data-f="room" aria-label="Room">${roomOptions(l.room, l)}</select></td>
      <td><select data-f="roomAlt" aria-label="Alternative rooms" ${l.room.startsWith('type:') ? 'disabled title="Room is already any room of a type"' : ''}>${roomAltOptions(l.roomAlt)}</select></td>
      <td><div class="row dist-cell">${distributionCell(l, eng)}<small class="hint" title="Periods per week">= ${periodsOf(l)}</small><button class="ghost small ${l.flexible ? 'on' : ''}" data-flex title="Let the engine choose the distribution">Flexible</button></div></td>
      <td><input data-f="parallel" list="parallelGroups" value="${esc(l.parallel || '')}" placeholder="—" style="max-width:140px" aria-label="Parallel group"></td>
      <td><button class="ghost small" data-options>Options${nOpts(l) ? ` (${nOpts(l)})` : ''}</button></td>
      <td><button class="ghost small" data-relations>Relations (${(l.relations || []).length})</button></td>
      <td>${pinButton('lesson', l)}</td>
      <td><button class="danger" data-del>✕</button></td></tr>`).join('')}
    </tbody></table></div><p class="hint" style="margin-top:8px">${list.length} lesson rows${ui.lessonFilter ? ` · class load ${workload(state).c[ui.lessonFilter] || 0} of ${availableSlots(state, find('classes', ui.lessonFilter) || {})} periods` : ''}</p>`
    : '<p class="hint">No lessons yet. Add subjects, teachers and classes first, then click “+ Add lesson”.</p>');
  p.addEventListener('change', (e) => {
    if (e.target.dataset.gfilter !== undefined) { ui.gradeFilter = e.target.value; render(); return; }
    if (e.target.dataset.filter !== undefined) { ui.lessonFilter = e.target.value; render(); return; }
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const l = find('lessons', tr.dataset.id); const f = e.target.dataset.f;
    if (f === 'lengths') {
      const max = teachingPeriods(state);
      const lens = parseLengths(e.target.value, max);
      if (!lens) { toast(`Enter the length of every session, e.g. “2 2 1” — whole numbers from 1 to ${max}.`, 4000); e.target.value = lengthsText(l.lengths); return; }
      l.lengths = lens; changed(); render(); return;
    }
    l[f] = e.target.value;
    // An alternative set without a room is just "any room of that type"; a type as room has no alternatives.
    if (f === 'roomAlt' && !l.room) { l.room = l.roomAlt; l.roomAlt = ''; }
    if (f === 'room' && l.room.startsWith('type:')) l.roomAlt = '';
    changed();
    if (f === 'room' || f === 'roomAlt') render();
  });
  p.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.add !== undefined) {
      if (!state.subjects.length) { toast('Add a subject first.'); return; }
      // With a class selected, the next curriculum subject it has no lessons for comes pre-filled.
      const gap = ui.lessonFilter ? curriculumGaps(state, ui.lessonFilter).find((x) => !x.have) : null;
      const row = newLesson(gap ? gap.subjectId : state.subjects[0].id, ui.lessonFilter ? [ui.lessonFilter] : [], state);
      if (gap) { row.lengths = Array(gap.want).fill(1); row.maxOnePerDay = gap.want <= D(); }
      state.lessons.push(row);
      changed(); render(); return;
    }
    const tr = btn.closest('tr[data-id]'); if (!tr) return;
    const l = find('lessons', tr.dataset.id);
    if (btn.dataset.del !== undefined) { removeLesson(state, l.id); changed(); render(); }
    if (btn.dataset.classes !== undefined) pickClasses(l);
    if (btn.dataset.flex !== undefined) editFlexible(l);
    if (btn.dataset.options !== undefined) editRowOptions(l);
    if (btn.dataset.relations !== undefined) editRelations(l);
    if (btn.dataset.pins !== undefined) editPins('lesson', l.id);
  });
}

// Flexible distribution: the engine chooses blocks of min..max periods adding up to total.
function editFlexible(l) {
  const max = teachingPeriods(state);
  const f = l.flexible || { total: periodsOf(l), min: Math.min(...l.lengths), max: Math.max(...l.lengths) };
  openModal(`Flexible distribution — ${describeLesson(state, l.id)}`, `
    <label class="row" style="gap:6px;margin-bottom:10px"><input type="checkbox" id="flexOn" ${l.flexible ? 'checked' : ''}> Let the engine choose the distribution</label>
    <div class="form-grid" id="flexFields">
      <label>Periods per week <input type="number" id="flexTotal" min="1" max="${max * D()}" value="${f.total}"></label>
      <label>Shortest block <input type="number" id="flexMin" min="1" max="${max}" value="${f.min}"></label>
      <label>Longest block <input type="number" id="flexMax" min="1" max="${max}" value="${f.max}"></label>
    </div>
    <p class="hint" id="flexHint"></p>`, (v) => {
    if (v !== 'save') return;
    const on = $('#flexOn').checked;
    if (!on) { l.flexible = null; changed(); render(); return; }
    const spec = { total: Number($('#flexTotal').value), min: Number($('#flexMin').value), max: Number($('#flexMax').value) };
    l.flexible = spec;
    // Keep `lengths` as one valid split so session and period counts stay meaningful.
    l.lengths = partition(spec.total, spec.min, spec.max);
    changed(); render();
  }, '<button value="cancel" class="ghost">Cancel</button><button value="save">Save</button>');
  const refresh = () => {
    const on = $('#flexOn').checked;
    $('#flexFields').querySelectorAll('input').forEach((i) => { i.disabled = !on; });
    const total = Number($('#flexTotal').value), mn = Number($('#flexMin').value), mx = Number($('#flexMax').value);
    const ok = !on || (Number.isInteger(total) && Number.isInteger(mn) && Number.isInteger(mx) && mn >= 1 && mx <= max && canPartition(total, mn, mx));
    $('#flexHint').textContent = !on ? `Off — the row keeps its distribution “${lengthsText(l.lengths)}”.`
      : ok ? `For example ${lengthsText(partition(total, mn, mx))}; the engine may pick any split into blocks of ${mn}–${mx} periods.`
        : `${total || 0} periods cannot be split into blocks of ${mn || '?'}–${mx || '?'} periods (blocks of 1 to ${max}).`;
    $('#flexHint').style.color = ok ? '' : 'var(--danger)';
    return ok;
  };
  refresh();
  $('#modalContent').onchange = refresh;
  $('#modalForm').onsubmit = (ev) => { if (ev.submitter?.value === 'save' && !refresh()) { ev.preventDefault(); toast('Fix the flexible distribution first, or cancel.'); } };
}

function editRowOptions(l) {
  openModal(`Options — ${describeLesson(state, l.id)}`, `<div class="opts">${ROW_OPTIONS.map(([k, label, hint]) => `<label><input type="checkbox" data-opt="${k}" ${l[k] ? 'checked' : ''}> <span>${label}<small class="hint">${hint}</small></span></label>`).join('')}</div>`, () => {
    $('#modalContent').querySelectorAll('input[data-opt]').forEach((i) => { l[i.dataset.opt] = i.checked; });
    changed(); render();
  });
}

// Relations with other lesson rows; each is stored on both rows (model.addRelation / removeRelation).
function editRelations(l) {
  const mine = new Set(l.classIds || []);
  const others = state.lessons.filter((x) => x !== l);
  const same = others.filter((x) => (x.classIds || []).some((c) => mine.has(c))), rest = others.filter((x) => !same.includes(x));
  const rowOpt = (x) => `<option value="${x.id}">${esc(describeLesson(state, x.id))}</option>`;
  const listHtml = () => ((l.relations || []).length ? `<table class="edit rel"><tbody>${l.relations.map((r, i) => `<tr><td>${esc(REL_LABELS[r.type] || r.type)}${r.type === 'daysApart' ? ` <small class="hint">(${r.min}–${r.max || '∞'} days)</small>` : ''}</td><td>${esc(describeLesson(state, r.lessonId))}</td><td><button type="button" class="danger" data-del-rel="${i}" title="Remove on both rows">✕</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="hint">No relations yet.</p>');
  openModal(`Relations — ${describeLesson(state, l.id)}`, `<div id="relList">${listHtml()}</div>
    ${others.length ? `<h4>Add a relation</h4><div class="row rel-add">
      <select id="relType" aria-label="Relation type">${Object.keys(REL_LABELS).map((k) => `<option value="${k}">${REL_LABELS[k]}</option>`).join('')}</select>
      <select id="relOther" aria-label="Other lesson row">${same.length ? `<optgroup label="Same class">${same.map(rowOpt).join('')}</optgroup>` : ''}${rest.length ? `<optgroup label="${same.length ? 'Other rows' : 'All rows'}">${rest.map(rowOpt).join('')}</optgroup>` : ''}</select>
      <label class="row" id="relRange" style="gap:4px" hidden>min <input type="number" id="relMin" min="0" max="${D()}" value="1" style="width:64px"> max <input type="number" id="relMax" min="0" max="${D()}" value="" placeholder="∞" style="width:64px"></label>
      <button type="button" data-add-rel>Add</button></div>
      <p class="hint">Relations are symmetric: they appear on both rows and are removed from both.</p>` : '<p class="hint">Add another lesson row to relate this one to.</p>'}`,
  () => render());
  const box = $('#modalContent');
  box.onchange = (e) => { if (e.target.id === 'relType') $('#relRange').hidden = e.target.value !== 'daysApart'; };
  box.onclick = (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.delRel !== undefined) {
      const r = l.relations[+t.dataset.delRel];
      removeRelation(state, l.id, r.lessonId, r.type);
    } else if (t.dataset.addRel !== undefined) {
      const type = $('#relType').value, other = $('#relOther').value;
      const min = Number($('#relMin').value) || 0, max = $('#relMax').value === '' ? 0 : Number($('#relMax').value) || 0;
      if (type === 'daysApart' && !min && !max) { toast('Give a minimum and/or maximum number of days apart.'); return; }
      if (type === 'daysApart' && max && max < min) { toast('Max days apart is below min.'); return; }
      addRelation(state, l.id, other, type, { min, max });
    } else return;
    changed();
    $('#relList').innerHTML = listHtml();
  };
}

// Pins: fix individual sessions of a lesson row, meeting or activity at a day and period before
// generation. Flexible rows have no fixed sessions, so they cannot be pinned.
function pinButton(kind, x) {
  const n = pinSessions(state, kind, x.id).length;
  const pinned = state.pins.filter((p) => p.kind === kind && p.id === x.id).length;
  if (!n) return `<button class="ghost small" disabled title="${kind === 'lesson' && x.flexible ? 'Flexible rows cannot be pinned — give the row a fixed distribution first' : 'Nothing to pin'}">📌 —</button>`;
  return `<button class="ghost small ${pinned ? 'on' : ''}" data-pins title="Fix sessions at a day and period before generating">📌 Pins${pinned ? ` (${pinned})` : ''}</button>`;
}
function editPins(kind, id) {
  const st = state.settings; const sessions = pinSessions(state, kind, id);
  const periods = st.periods.map((pp, i) => [i, pp]).filter(([i]) => isTeachingPeriod(state, i));
  const rows = sessions.map((len, k) => {
    const pn = pinAt(state, kind, id, k);
    return `<tr data-k="${k}"><td>Session ${k + 1}${len > 1 ? ` <span class="hint">(${len} periods)</span>` : ''}</td>
      <td><select data-day aria-label="Day of session ${k + 1}"><option value="">— free —</option>${st.days.map((d, i) => `<option value="${i}" ${pn && pn.day === i ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select></td>
      <td><select data-period aria-label="Period of session ${k + 1}" ${pn ? '' : 'disabled'}>${periods.map(([i, pp]) => `<option value="${i}" ${pn && pn.period === i ? 'selected' : ''}>${esc(pp.label)}${pp.start ? ` · ${esc(pp.start)}` : ''}</option>`).join('')}</select></td></tr>`;
  }).join('');
  openModal(`Pin sessions — ${pinName(state, kind, id)}`, `<p class="hint">A pinned session is placed first and the rest of the timetable is built around it. A session that would clash with another pin or break a hard rule is reported when you generate. Meetings and activities pin the start period.</p>
    <div class="table-wrap"><table class="edit"><thead><tr><th>Session</th><th>Day</th><th>Period</th></tr></thead><tbody>${rows}</tbody></table></div>`, (v) => {
    if (v !== 'save') return;
    $('#modalContent').querySelectorAll('tr[data-k]').forEach((tr) => {
      const day = tr.querySelector('[data-day]').value;
      setPin(state, kind, id, Number(tr.dataset.k), day === '' ? null : Number(day), Number(tr.querySelector('[data-period]').value));
    });
    changed(); render();
  }, '<button value="cancel" class="ghost">Cancel</button><button value="save">Save</button>');
  $('#modalContent').onchange = (ev) => {
    const tr = ev.target.closest('tr[data-k]'); if (!tr || !ev.target.matches('[data-day]')) return;
    tr.querySelector('[data-period]').disabled = ev.target.value === '';
  };
}

function pickClasses(l) {
  const pick = (c) => `<label><input type="checkbox" value="${c.id}" ${(l.classIds || []).includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`;
  const byGrade = [...state.grades.map((g) => [g.name, state.classes.filter((c) => c.gradeId === g.id)]), ['No grade', state.classes.filter((c) => !gradeOf(state, c.id))]].filter(([, cs]) => cs.length);
  const body = state.grades.length ? byGrade.map(([name, cs]) => `<h4 style="margin:8px 0 2px">${esc(name)}</h4><div class="class-picks">${cs.map(pick).join('')}</div>`).join('') : `<div class="class-picks">${state.classes.map(pick).join('')}</div>`;
  openModal('Classes attending this lesson', body, () => {
    l.classIds = [...$('#modalContent').querySelectorAll('input:checked')].map((i) => i.value);
    changed(); render();
  });
}

// Day × period picker shared by every template. `cell(k)` gives { cls, text } for a usable slot;
// `disabled(k)` gives the reason a slot cannot be picked (rendered hatched, never clickable).
// A row whose cells are all unusable gets no row toggle.
function templateGrid(hint, cell, disabled) {
  const st = state.settings;
  const rows = st.periods.map((pp, pi) => {
    const cells = st.days.map((_, di) => { const k = `${di}-${pi}`; return { k, why: disabled(k) }; });
    const rowOn = cells.some((c) => !c.why);
    return `<tr><th ${rowOn ? `data-row="${pi}" style="cursor:pointer"` : ''}>${esc(pp.label)}${isTeachingPeriod(state, pi) ? '' : `<small>${PERIOD_TYPES[periodType(state, pi)]}</small>`}</th>${cells.map(({ k, why }) => {
      if (why) return `<td class="dis" title="${esc(why)}"></td>`;
      const c = cell(k);
      return `<td data-k="${k}" class="${c.cls}">${c.text}</td>`;
    }).join('')}</tr>`;
  }).join('');
  return `<p class="hint">${hint} Hatched cells cannot be used here — hover for the reason.</p>
    <div class="table-wrap"><table class="avail"><thead><tr><th></th>${st.days.map((d, di) => `<th data-col="${di}" style="cursor:pointer">${esc(d.slice(0, 3))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
// Cell and header clicks on a template grid: `apply(keys)` receives only usable keys, then the grid is redrawn.
function bindTemplate(redraw, disabled, apply) {
  const st = state.settings; const box = $('#modalContent');
  box.onclick = (e) => {
    const t = e.target.closest('[data-k], [data-col], [data-row]'); if (!t) return;
    const keys = t.dataset.k ? [t.dataset.k]
      : t.dataset.col ? st.periods.map((_, pi) => `${t.dataset.col}-${pi}`)
        : st.days.map((_, di) => `${di}-${t.dataset.row}`);
    const usable = keys.filter((k) => !disabled(k));
    if (!usable.length) return;
    apply(usable);
    box.innerHTML = redraw();
  };
}

// Template like GHC, with two non-preferred levels: available → ~ non-preferred → ~~ strongly
// non-preferred (higher weight) → ✕ prohibited.
function editAvailability(ent, title) {
  const off = new Set(ent.unavailable || []);
  const soft = new Set(ent.dispreferred || []);
  const soft2 = new Set(ent.dispreferred2 || []);
  const stateOf = (k) => (off.has(k) ? 3 : soft2.has(k) ? 2 : soft.has(k) ? 1 : 0);
  const setState = (k, v) => { off.delete(k); soft.delete(k); soft2.delete(k); if (v === 3) off.add(k); if (v === 2) soft2.add(k); if (v === 1) soft.add(k); };
  const disabled = (k) => slotDisabled(state, k, 'teaching');
  const grid = () => templateGrid('Click to cycle: available → <b>~ non-preferred</b> → <b>~~ strongly non-preferred</b> → <b>✕ prohibited</b>. Click a day or period header to set the whole column/row.',
    (k) => { const v = stateOf(k); return { cls: ['', 'pref', 'pref2', 'off'][v], text: ['', '~', '~~', '✕'][v] }; }, disabled);
  openModal(title, grid(), () => { ent.unavailable = [...off]; ent.dispreferred = [...soft]; ent.dispreferred2 = [...soft2]; changed(); render(); });
  bindTemplate(grid, disabled, (keys) => { const next = (stateOf(keys[0]) + 1) % 4; keys.forEach((k) => setState(k, next)); });
}

// General template: periods when nobody at all is scheduled (✕ only). Stored in settings.blocked.
function editGeneralTemplate() {
  const st = state.settings;
  const off = new Set(st.blocked || []);
  const disabled = (k) => slotDisabled(state, k, 'teaching', { general: false });
  const grid = () => templateGrid('Click to toggle <b>✕ blocked for everyone</b> — no lesson, meeting or duty is placed there (whole-school events, half days). Click a day or period header to set the whole column/row.',
    (k) => (off.has(k) ? { cls: 'off', text: '✕' } : { cls: '', text: '' }), disabled);
  openModal('General template', grid(), () => { st.blocked = [...off].filter((k) => !disabled(k)); changed(); render(); });
  bindTemplate(grid, disabled, (keys) => { const allOff = keys.every((k) => off.has(k)); keys.forEach((k) => (allOff ? off.delete(k) : off.add(k))); });
}

function openModal(title, html, onClose, actions) {
  const dlg = $('#modal');
  $('#modalTitle').textContent = title;
  $('#modalContent').innerHTML = html;
  $('#modalContent').onclick = null;
  $('#modalContent').onchange = null;
  $('#modalContent').oninput = null;
  $('#modalForm').onsubmit = null;
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
  m.insertAdjacentHTML('beforeend', state.meetings.length ? `<div class="table-wrap"><table class="edit"><thead><tr><th>Name</th><th>Members</th><th>Sessions/wk</th><th>Length</th><th>Room</th><th>When</th><th></th><th></th></tr></thead><tbody>
    ${state.meetings.map((x) => `<tr data-id="${x.id}">
      <td><input data-f="name" value="${esc(x.name)}" aria-label="Meeting name"></td>
      <td><button class="ghost" data-members>${(x.teacherIds || []).length === state.teachers.length && state.teachers.length ? 'All teachers' : `${(x.teacherIds || []).length} teacher(s)`}</button></td>
      <td><input type="number" min="1" max="${D()}" data-f="sessions" value="${x.sessions}" style="max-width:80px" aria-label="Sessions per week"></td>
      <td><select data-f="length" aria-label="Length">${[1, 2].map((n) => `<option value="${n}" ${+x.length === n ? 'selected' : ''}>${n === 1 ? 'Single' : 'Double'}</option>`).join('')}</select></td>
      <td><select data-f="room" aria-label="Room">${roomOptions(x.room)}</select></td>
      <td><button class="ghost" data-when>${slotsLabel(x.allowed)}</button></td>
      <td>${pinButton('meeting', x)}</td>
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
    if (btn.dataset.del !== undefined) { state.meetings = state.meetings.filter((y) => y !== x); dropDeadPins(state); changed(); render(); }
    if (btn.dataset.pins !== undefined) editPins('meeting', x.id);
    if (btn.dataset.members !== undefined) pickTeachers(x);
    if (btn.dataset.when !== undefined) editSlots(`When can “${x.name}” take place?`, x);
  });

  const a = panel(root, 'Complementary activities', 'Work that belongs to one teacher but no class — preparation, coordination, tutoring time. Set the periods per week; <b>Max/day</b> is a hard limit, <b>Min/day</b> a preference for days the activity is used, and <b>Not consecutive</b> keeps its periods on a day apart. The activity is scheduled around the lessons and fills free periods; tick <b>Counts</b> to include it in the teacher’s max periods/day.');
  a.querySelector('[data-slot=actions]').innerHTML = '<button data-add-activity>+ Add activity</button>';
  a.insertAdjacentHTML('beforeend', state.activities.length ? `<div class="table-wrap"><table class="edit"><thead><tr><th>Name</th><th>Teacher</th><th>Periods/wk</th><th title="Preference: on days it is used, at least this many">Min/day</th><th title="Hard limit">Max/day</th><th title="No two periods of it next to each other on a day">Not consecutive</th><th title="Counts toward the teacher’s max periods/day">Counts</th><th>When</th><th></th><th></th></tr></thead><tbody>
    ${state.activities.map((x) => `<tr data-id="${x.id}">
      <td><input data-f="name" value="${esc(x.name)}" aria-label="Activity name"></td>
      <td><select data-f="teacherId" aria-label="Teacher"><option value="">— choose —</option>${state.teachers.map((t) => `<option value="${t.id}" ${t.id === x.teacherId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></td>
      <td><input type="number" min="1" max="${teachingPeriods(state) * D()}" data-f="periods" value="${x.periods || ''}" style="max-width:80px" aria-label="Periods per week"></td>
      <td><input type="number" min="0" max="${teachingPeriods(state)}" data-f="minPerDay" value="${x.minPerDay || ''}" placeholder="—" style="max-width:70px" aria-label="Minimum per day"></td>
      <td><input type="number" min="0" max="${teachingPeriods(state)}" data-f="maxPerDay" value="${x.maxPerDay || ''}" placeholder="—" style="max-width:70px" aria-label="Maximum per day"></td>
      <td><input type="checkbox" data-f="nonConsecutive" ${x.nonConsecutive ? 'checked' : ''} aria-label="Not consecutive"></td>
      <td><input type="checkbox" data-f="countLoad" ${x.countLoad ? 'checked' : ''} aria-label="Counts toward max periods per day"></td>
      <td><button class="ghost" data-when>${slotsLabel(x.allowed)}</button></td>
      <td>${pinButton('activity', x)}</td>
      <td><button class="danger" data-del>✕</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="hint">No activities yet.</p>');
  a.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const x = find('activities', tr.dataset.id); const f = e.target.dataset.f;
    x[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Math.max(0, Math.floor(Number(e.target.value)) || 0) : e.target.value;
    changed();
  });
  a.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.addActivity !== undefined) {
      state.activities.push({ id: uid(), name: `Activity ${state.activities.length + 1}`, teacherId: '', periods: 2, minPerDay: 0, maxPerDay: 0, nonConsecutive: false, countLoad: false, allowed: [] });
      changed(); render(); return;
    }
    const tr = btn.closest('tr[data-id]'); if (!tr) return;
    const x = find('activities', tr.dataset.id);
    if (btn.dataset.del !== undefined) { state.activities = state.activities.filter((y) => y !== x); dropDeadPins(state); changed(); render(); }
    if (btn.dataset.pins !== undefined) editPins('activity', x.id);
    if (btn.dataset.when !== undefined) editSlots(`When can “${x.name}” take place?`, x);
  });

  const d = panel(root, 'On-call duties', 'Services such as library or corridor supervision. Mark the duty periods under “When”, set how many teachers may be on call at once, and give each teacher weekly hours. The engine tries to cover every duty period with at least one teacher. Kind <b>Teaching periods</b> uses free teaching periods and counts toward a teacher’s load; <b>Break supervision</b> (playground, corridors) uses only the periods typed “Break” on the Week tab and is counted separately.');
  d.querySelector('[data-slot=actions]').innerHTML = '<button data-add-duty>+ Add duty</button>';
  d.insertAdjacentHTML('beforeend', state.duties.length ? `<div class="table-wrap"><table class="edit"><thead><tr><th>Service</th><th title="Teaching periods, or supervision during breaks">Kind</th><th title="Hard limit">Max teachers / period</th><th>When</th><th>Teachers &amp; hours</th><th>Hours / duty periods</th><th></th></tr></thead><tbody>
    ${state.duties.map((x) => {
      const hours = (x.assignments || []).reduce((a, y) => a + (Number(y.hours) || 0), 0);
      const periods = dutySlots(state, x);
      return `<tr data-id="${x.id}">
      <td><input data-f="name" value="${esc(x.name)}" aria-label="Duty name"></td>
      <td><select data-f="kind" aria-label="Duty kind"><option value="teaching" ${dutyKind(x) === 'teaching' ? 'selected' : ''}>Teaching periods</option><option value="break" ${dutyKind(x) === 'break' ? 'selected' : ''}>Break supervision</option></select></td>
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
    // A new kind means a different set of usable periods; "When" keys that no longer apply are dropped.
    if (f === 'kind') pruneDeadKeys(state);
    changed(); if (f === 'maxPerSlot' || f === 'kind') render();
  });
  d.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.addDuty !== undefined) {
      state.duties.push({ id: uid(), name: `Duty ${state.duties.length + 1}`, kind: 'teaching', maxPerSlot: 1, allowed: [], assignments: [] });
      changed(); render(); return;
    }
    const tr = btn.closest('tr[data-id]'); if (!tr) return;
    const x = find('duties', tr.dataset.id);
    if (btn.dataset.del !== undefined) { state.duties = state.duties.filter((y) => y !== x); changed(); render(); }
    if (btn.dataset.assign !== undefined) editAssignments(x);
    if (btn.dataset.when !== undefined) editSlots(`Duty periods for “${x.name}”`, x, dutyKind(x));
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
  // One teacher can hold at most one unit per duty period.
  const maxHours = Math.max(1, dutySlots(state, duty));
  openModal(`Teachers on “${duty.name}”`, `<p class="hint">Weekly on-call hours per teacher (0 = not on this duty).</p>
    <div class="table-wrap"><table class="edit"><tbody>${state.teachers.map((t) => `<tr><td>${esc(t.name)}</td><td><input type="number" min="0" max="${maxHours}" data-t="${t.id}" value="${hours[t.id] || 0}" style="max-width:90px" aria-label="Hours for ${esc(t.name)}"></td></tr>`).join('')}</tbody></table></div>`, () => {
    duty.assignments = [...$('#modalContent').querySelectorAll('input[data-t]')]
      .map((i) => ({ teacherId: i.dataset.t, hours: Math.max(0, Number(i.value) || 0) })).filter((a) => a.hours > 0);
    changed(); render();
  });
}

// Two-state template of allowed periods; stored empty when every usable period is allowed.
// `kind` is 'break' for break-supervision duties (only break periods are usable), else 'teaching'.
function editSlots(title, obj, kind = 'teaching') {
  const all = selectableKeys(state, kind); const usable = new Set(all);
  const on = new Set((obj.allowed && obj.allowed.length ? obj.allowed : all).filter((k) => usable.has(k)));
  const disabled = (k) => slotDisabled(state, k, kind);
  const grid = () => templateGrid(`✓ = allowed${kind === 'break' ? ' (break periods only)' : ''}. Click a cell, or a day/period header to toggle the whole column/row.`,
    (k) => (on.has(k) ? { cls: 'yes', text: '✓' } : { cls: '', text: '' }), disabled);
  openModal(title, grid(), () => { obj.allowed = all.every((k) => on.has(k)) ? [] : [...on]; changed(); render(); });
  bindTemplate(grid, disabled, (keys) => { const allOn = keys.every((k) => on.has(k)); keys.forEach((k) => (allOn ? on.delete(k) : on.add(k))); });
}

// ---------- Generate ----------
// Display data for one part of a unit: lesson subject, meeting or duty.
function partInfo(part) {
  if (part.kind === 'meeting') { const m = find('meetings', part.ref); return { title: m?.name || 'Meeting', code: 'MTG', color: MEETING_COLOR }; }
  if (part.kind === 'activity') { const a = find('activities', part.ref); return { title: a?.name || 'Activity', code: 'ACT', color: ACTIVITY_COLOR }; }
  if (part.kind === 'duty') { const d = find('duties', part.ref); return { title: d?.name || 'Duty', code: 'DUTY', color: DUTY_COLOR }; }
  const s = find('subjects', find('lessons', part.lessonId)?.subjectId);
  return { title: s?.name || '?', code: s?.code || s?.name?.slice(0, 3) || '?', color: s?.color };
}
const describePart = (part) => (part.kind === 'lesson' ? describeLesson(state, part.lessonId) : partInfo(part).title);

function renderGenerate(root) {
  const p = panel(root, 'Generate timetable', 'Hard rules are always respected: no teacher, class or room double-booked, ✕ periods never used, teacher max/day, double periods kept together, “1/day” lessons on different days, parallel lessons at the same time, locked lessons kept. The weighted criteria below are then minimised.');
  const { issues, units } = validate(state);
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
    <div id="genStatus" class="hint">${units} sessions to place${state.pins.length ? ` (${state.pins.length} pinned in place)` : ''}. Each attempt builds and optimises a full timetable; the best one is kept.</div>
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
    if (!solver) {
      solver = new Timetable.Solver(state, keep);
      if (attempt === 0 && solver.pinProblems.length) toast(`${solver.pinProblems.length} pin(s) could not be honoured — see the data validation list.`, 5000);
    }
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
    ${s.ends ? `<div class="stat"><b>${s.ends}</b><span>lessons in a first/last period</span></div>` : ''}
    ${s.roomPref ? `<div class="stat"><b>${s.roomPref}</b><span>lessons not in their preferred room</span></div>` : ''}
    ${s.roomSame ? `<div class="stat"><b>${s.roomSame}</b><span>room changes within one lesson</span></div>` : ''}
    ${s.consecutiveDays ? `<div class="stat"><b>${s.consecutiveDays}</b><span>sessions on consecutive days</span></div>` : ''}
    ${s.consecutive ? `<div class="stat"><b>${s.consecutive}</b><span>teacher periods over their max in a row</span></div>` : ''}
    ${s.presence ? `<div class="stat"><b>${s.presence}</b><span>teacher presence periods over the limit</span></div>` : ''}
    ${s.exclusive ? `<div class="stat"><b>${s.exclusive}</b><span>teacher last→first period pairs</span></div>` : ''}
    ${s.activityMin ? `<div class="stat"><b>${s.activityMin}</b><span>activity periods short of the daily minimum</span></div>` : ''}
    ${s.balance ? `<div class="stat"><b>${s.balance}</b><span>teacher periods off an even week</span></div>` : ''}
    <div class="stat"><b>${s.cost}</b><span>weighted score (lower is better)</span></div>
  </div>
  ${unplaced.length ? `<div class="unplaced"><h3>Not placed (${unplaced.length})</h3><ul class="issues">${unplaced.map((u) => `<li class="err">${esc(describeUnit(state, u.id))}</li>`).join('')}</ul>
    <p class="hint">Turn ✕ into ~, add rooms, or reduce sessions, then generate again — or place them by hand from the tray in Timetables (the message tells you what blocks each slot).</p></div>` : ''}
  ${dif && dif.total ? `<details class="difficulty"><summary>Difficulty report (${dif.total} rejections while building)</summary>
    <div class="dif-grid">
      <div><h4>Most rejected lessons</h4><ol>${dif.units.map((x) => `<li>${esc(describeUnit(state, x.id))} <span class="hint">×${x.n}</span></li>`).join('') || '<li>none</li>'}</ol></div>
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

// The planner pins that point at each unit of engine e (unit index → slot), cached on the engine.
function pinSlots(e) {
  if (!e._pins) e._pins = new Map(state.pins.map((p) => [e.resolvePin(p), p.day * e.P + p.period]).filter(([i]) => i >= 0));
  return e._pins;
}
const pinnedHere = (e, u) => e.pos[u.i] && pinSlots(e).get(u.i) === e.pos[u.i].s;
// What a unit can be pinned as in the planner, or null (duties and flexible rows have no pins).
function pinTarget(u) {
  const part = u.parts[0];
  if (u.kind === 'lesson') return find('lessons', part.lessonId)?.flexible ? null : { kind: 'lesson', id: part.lessonId };
  if (u.kind === 'meeting') return { kind: 'meeting', id: part.ref };
  if (u.kind === 'activity') return { kind: 'activity', id: part.ref };
  return null;
}

function blockHtml(e, u, mode, id) {
  const parts = partsFor(e, u, mode, id);
  const color = partInfo(parts[0]).color;
  const body = parts.map((p) => {
    const info = partInfo(p);
    const room = p.room ? find('rooms', p.room)?.name : '';
    if (p.kind !== 'lesson') {
      const meta = p.kind === 'meeting' ? [room, `${u.teachers.length} teacher(s)`] : p.kind === 'activity' ? ['Activity'] : ['On call'];
      return `<div class="s">${esc(info.title)}</div><div class="m">${meta.filter(Boolean).map(esc).join(' · ')}</div>`;
    }
    const cls = p.classes.map((c) => find('classes', c)?.name).join('+');
    const tch = find('teachers', p.teacher); const tName = tch?.code || tch?.name || '';
    const meta = mode === 'class' ? [tName, room] : mode === 'teacher' ? [cls, room] : [cls, tName];
    return `<div class="s">${esc(info.title)}</div><div class="m">${meta.filter(Boolean).map(esc).join(' · ')}</div>`;
  }).join('');
  return `<div class="block${u.parts.length > 1 ? ' par' : ''}" draggable="true" data-unit="${esc(u.id)}" style="--c:${esc(color)}" title="${esc(describeUnit(state, u.id))}">
    ${pinnedHere(e, u) ? '<span class="pin" title="Pinned in the planner — regenerating keeps it here">📌</span>' : ''}${e.locked[u.i] ? '<span class="lock" title="Locked">🔒</span>' : ''}${u.parts.length > 1 ? '<span class="partag" title="Lessons in this parallel group run at the same time">parallel</span>' : ''}${body}</div>`;
}

// Row header for period p: label, type for break/lunch rows, and the time.
function periodHeader(p) {
  const pp = state.settings.periods[p]; const ty = periodType(state, p);
  const time = `${esc(pp.start)}${pp.end ? '–' + esc(pp.end) : ''}`;
  return `<th class="pcol">${esc(pp.label)}<small>${ty === 'teaching' ? '' : `${PERIOD_TYPES[ty]}${time ? ' · ' : ''}`}${time}</small></th>`;
}

// Duty rota: every teacher on call in each period; empty duty periods are flagged.
function dutyGridHtml(e, id) {
  const st = state.settings;
  const svc = e.services[id]; if (!svc) return '<p class="hint">Nothing to show.</p>';
  const brkDuty = dutyKind(find('duties', id)) === 'break'; const gen = generalBlocked(state);
  let html = `<div class="table-wrap"><table class="tt duty"><thead><tr><th class="pcol">Period</th>${st.days.map((d) => `<th>${esc(d)}</th>`).join('')}</tr></thead><tbody>`;
  st.periods.forEach((pp, p) => {
    const ty = periodType(state, p);
    const usable = brkDuty ? ty === 'break' : ty === 'teaching';
    html += `<tr class="${ty === 'teaching' ? '' : 'brk'}">${periodHeader(p)}`;
    st.days.forEach((_, d) => {
      const k = d * e.P + p;
      const on = [...svc.occ[k]];
      // Rows of the wrong kind are shaded and are not drop targets (unless a stale placement sits there and must be movable).
      if (!usable && !on.length) { html += `<td class="${ty === 'teaching' ? 'off' : 'brk'}"></td>`; return; }
      const cls = !svc.allowed.has(k) || (!brkDuty && gen.has(`${d}-${p}`)) ? 'off' : on.length ? '' : 'uncov';
      html += `<td data-d="${d}" data-p="${p}" class="${cls}">${on.map((ui) => {
        const u = e.units[ui]; const t = find('teachers', u.teachers[0]);
        return `<div class="block mini" draggable="true" data-unit="${esc(u.id)}" style="--c:${DUTY_COLOR}" title="${esc(describeUnit(state, u.id))}">${e.locked[ui] ? '🔒 ' : ''}${esc(t?.name)}</div>`;
      }).join('')}${cls === 'uncov' ? '<span class="m">uncovered</span>' : ''}</td>`;
    });
    html += '</tr>';
  });
  return html + '</tbody></table></div>';
}

const gridFor = (e, mode, id) => (mode === 'duty' ? dutyGridHtml(e, id) : gridHtml(e, mode, id));

// Layout of one entity's grid: at[slot] is { u, span, extra } on the first cell of a block and
// { cov: firstSlot } on every cell down to its last one (a straddled break row included). A unit
// whose first cell is already covered is drawn inside the covering block, never as its own cell.
function gridLayout(e, mode, id) {
  const at = {};
  // Extend block `entry` (first cell `first`) down to `end`, swallowing any block that starts
  // inside it and reaching its last cell too, so every covered cell points at `first`.
  const extend = (entry, first, end) => {
    for (let k = first + 1; k <= end; k++) {
      const o = at[k];
      if (o && o.cov === undefined) { entry.extra.push(o.u, ...o.extra); end = Math.max(end, k + o.span - 1); }
      at[k] = { cov: first };
    }
    entry.span = end - first + 1;
  };
  unitsFor(e, mode, id).forEach((u) => {
    const cells = cellsOf(e, u); const first = cells[0], last = cells[cells.length - 1];
    const taken = at[first];
    if (taken) {
      const hostFirst = taken.cov === undefined ? first : taken.cov; const host = at[hostFirst];
      host.extra.push(u);
      extend(host, hostFirst, Math.max(last, hostFirst + host.span - 1));
      return;
    }
    const entry = { u, span: 1, extra: [] };
    at[first] = entry;
    extend(entry, first, last);
  });
  return at;
}

function gridHtml(e, mode, id) {
  const st = state.settings;
  const ent = find(MODES[mode], id);
  const off = new Set(ent?.unavailable || []); const soft = new Set([...(ent?.dispreferred || []), ...(ent?.dispreferred2 || [])]); const gen = generalBlocked(state);
  const at = gridLayout(e, mode, id);
  let html = `<div class="table-wrap"><table class="tt"><thead><tr><th class="pcol">Period</th>${st.days.map((d) => `<th>${esc(d)}</th>`).join('')}</tr></thead><tbody>`;
  st.periods.forEach((pp, p) => {
    const brk = !isTeachingPeriod(state, p);
    html += `<tr class="${brk ? 'brk' : ''}">${periodHeader(p)}`;
    st.days.forEach((_, d) => {
      const k = d * e.P + p; const a = at[k];
      if (a && a.cov !== undefined) return;
      if (brk && !a) { html += '<td class="brk"></td>'; return; }
      const key = `${d}-${p}`;
      const cls = off.has(key) || gen.has(key) ? 'off' : soft.has(key) ? 'pref' : '';
      html += a ? `<td rowspan="${a.span}" data-d="${d}" data-p="${p}" class="${cls}">${[a.u, ...a.extra].map((u) => blockHtml(e, u, mode, id)).join('')}</td>`
        : `<td data-d="${d}" data-p="${p}" class="${cls}"></td>`;
    });
    html += '</tr>';
  });
  return html + '</tbody></table></div>';
}

function masterHtml(e, kind = 'classes') {
  const st = state.settings;
  const mode = kind === 'classes' ? 'class' : 'teacher';
  const gen = generalBlocked(state);
  const colCls = (p) => `${p === 0 ? 'day-start' : ''}${isTeachingPeriod(state, p) ? '' : ' brk'}`;
  let html = `<div class="table-wrap"><table class="master"><thead><tr><th rowspan="2">${kind === 'classes' ? 'Class' : 'Teacher'}</th>${st.days.map((d) => `<th class="day-start" colspan="${e.P}">${esc(d)}</th>`).join('')}</tr><tr>${st.days.map(() => st.periods.map((pp, i) => `<th class="${colCls(i)}" title="${esc(PERIOD_TYPES[periodType(state, i)])}">${esc(pp.label)}</th>`).join('')).join('')}</tr></thead><tbody>`;
  state[kind].forEach((x) => {
    const at = {};
    unitsFor(e, mode, x.id).forEach((u) => { for (const k of cellsOf(e, u)) at[k] = u; });
    html += `<tr><td class="name">${esc(x.code || x.name)}</td>`;
    for (let d = 0; d < e.D; d++) for (let p = 0; p < e.P; p++) {
      const u = at[d * e.P + p];
      if (!u) { html += `<td class="${colCls(p)}${gen.has(`${d}-${p}`) ? ' off' : ''}"></td>`; continue; }
      const parts = partsFor(e, u, mode, x.id);
      const info = partInfo(parts[0]);
      const label = parts.length > 1 ? parts.map((pp) => partInfo(pp).code).join('/')
        : kind === 'classes' || parts[0].kind !== 'lesson' ? info.code : parts[0].classes.map((c) => find('classes', c)?.name).join('+');
      html += `<td class="${p === 0 ? 'day-start' : ''}"><span class="cc" style="--c:${esc(info.color)}" title="${esc(describeUnit(state, u.id))}">${esc(label)}</span></td>`;
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
      return `<div class="block chip-block" draggable="true" data-unit="${esc(u.id)}" style="--c:${esc(partInfo(u.parts[0]).color)}" title="${esc(describeUnit(state, u.id))}"><div class="s">${esc(title)}${u.len > 1 ? ` ×${u.len}` : ''}</div><div class="m">${esc(sub)}</div></div>`;
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
const blockReason = (e, u, s) => unitBlockReason(state, e, u, s);

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
  // A pinned session takes its pin along, otherwise the next generation would put it back.
  const moved = state.pins.filter((pn) => e.resolvePin(pn) === u.i);
  moved.forEach((pn) => { pn.day = d; pn.period = p; });
  state.timetable.placements = e.placements();
  changed(); render();
  toast(`${old ? 'Moved' : 'Placed'} and locked${moved.length ? ' — its 📌 pin moved too' : ''}.${usesDispreferred(e, u.i) ? ' Note: uses a non-preferred period.' : ''}`);
}

function lessonMenu(unitId) {
  const e = currentEngine();
  const u = e.unitById[unitId]; const pos = u && e.pos[u.i];
  if (!pos) return;
  const pl = state.timetable.placements.find((x) => x.unitId === unitId);
  const st = state.settings; const day = e.dayOf(pos.s); const per = pos.s % e.P;
  const cells = cellsOf(e, u); const lastPer = cells[cells.length - 1] % e.P;
  const target = pinTarget(u); const pinned = target ? state.pins.filter((p) => e.resolvePin(p) === u.i) : [];
  e.remove(u.i);
  const roomRows = u.parts.map((part, k) => {
    if (!part.roomCands) return '';
    // With an alternative set, the first candidate is the row's preferred room.
    const lesson = part.kind === 'lesson' ? find('lessons', part.lessonId) : null;
    const pref = lesson && lesson.roomAlt && lesson.room && !lesson.room.startsWith('type:') ? (lesson.room === 'home' ? homeroomOf(state, lesson.classIds) : lesson.room) : null;
    const opts = part.roomCands.map((r) => {
      const busy = e.roomConflicts(u.i, pos.s, u.parts.map((_, j) => (j === k ? r : null))).size > 0 || cells.some((c) => e.blocked['r' + r].has(c));
      return `<option value="${r}" ${pos.rooms[k] === r ? 'selected' : ''} ${busy && pos.rooms[k] !== r ? 'disabled' : ''}>${esc(find('rooms', r)?.name)}${r === pref ? ' (preferred)' : ''}${busy && pos.rooms[k] !== r ? ' (busy)' : ''}</option>`;
    }).join('');
    return `<label class="row" style="margin:6px 0">${esc(describePart(part))}: <select data-part="${k}">${opts}</select></label>`;
  }).join('');
  e.place(u.i, pos.s, pos.rooms);
  openModal(describeUnit(state, unitId), `<p>${esc(st.days[day])}, period ${esc(st.periods[per].label)}${u.len > 1 ? `–${esc(st.periods[lastPer]?.label)}` : ''}</p>
    ${roomRows ? `<h4>Room</h4>${roomRows}` : '<p class="hint">No room needed.</p>'}
    <p class="hint">${pl.locked ? '🔒 Locked — kept in place when regenerating.' : 'Not locked — may move when regenerating.'}${pinTarget(u) ? (pinned.length ? ' 📌 Pinned in the planner — regenerating always puts it back.' : '') : ''}</p>`,
  (v) => {
    if (v === 'pin') {
      if (pinned.length) pinned.forEach((p) => setPin(state, p.kind, p.id, p.k, null));
      else setPin(state, target.kind, target.id, u.k, day, per);
    } else if (v === 'lock') pl.locked = !pl.locked;
    else if (v === 'remove') state.timetable.placements = state.timetable.placements.filter((x) => x !== pl);
    else if (v === 'rooms') {
      const rooms = u.parts.map((_, k) => $(`#modalContent [data-part="${k}"]`)?.value || null);
      e.remove(u.i);
      if (!e.roomsValid(u.i, pos.s, rooms) || e.roomConflicts(u.i, pos.s, rooms).size) { toast('Those rooms are not free or are used twice.'); return; }
      pl.rooms = rooms;
    } else return;
    changed(); render();
  },
  `<button value="remove" class="ghost">Unschedule</button>${roomRows ? '<button value="rooms" class="ghost">Apply room</button>' : ''}${target ? `<button value="pin" class="ghost" title="Fix this session at this day and period in the planner, so every generation keeps it here">${pinned.length ? '📌 Unpin' : '📌 Pin here'}</button>` : ''}<button value="lock" class="ghost">${pl.locked ? 'Unlock' : 'Lock'}</button><button value="close">Close</button>`);
}

function exportCsv(e) {
  const st = state.settings;
  const ent = find(MODES[ui.ttMode], ui.ttEntity); if (!ent) return;
  const at = {};
  unitsFor(e, ui.ttMode, ent.id).forEach((u) => { for (const k of cellsOf(e, u)) at[k] = u; });
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Period', 'Time', ...st.days].map(q).join(',')];
  st.periods.forEach((pp, p) => {
    const ty = periodType(state, p);
    rows.push([pp.label, `${pp.start}-${pp.end}`, ...st.days.map((_, d) => {
      const u = at[d * e.P + p]; if (!u) return ty === 'teaching' ? '' : PERIOD_TYPES[ty];
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
