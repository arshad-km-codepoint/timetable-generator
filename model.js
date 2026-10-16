// School Timetable Generator — data model. State shape, defaults, migration, slot arithmetic,
// workload and validation; no DOM. Every function takes the state `s` it works on, so the same
// file runs in the browser (as window.Model) and under node's vm for tests (tests/app.js).
(function () {
  const TT = () => (typeof Timetable !== 'undefined' ? Timetable : window.Timetable);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PALETTE = ['#2f6fdb', '#d9534f', '#1f8a4c', '#b7791f', '#7b4fd6', '#0f8f99', '#c2417e', '#5c6f2b', '#8a5a44', '#4a6fa5', '#d0682f', '#3d8f6f'];
  const WEIGHT_LABELS = {
    classGap: 'Free gaps in a class day', teacherGap: 'Free gaps in a teacher day', sameDay: 'Same lesson twice on one day',
    dispreferred: 'Lesson in a non-preferred period', teacherMin: 'Teacher below minimum periods/day', late: 'Lesson late in the day (per period)',
    dutyUncovered: 'Duty period with nobody on call',
  };
  const PERIOD_TYPES = { teaching: 'Teaching', break: 'Break', lunch: 'Lunch' };

  // ---------- State ----------
  function emptyState() {
    return {
      settings: {
        name: 'My School',
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        periods: [
          { label: '1', start: '08:00', end: '08:45', type: 'teaching' }, { label: '2', start: '08:50', end: '09:35', type: 'teaching' },
          { label: '3', start: '09:40', end: '10:25', type: 'teaching' }, { label: '4', start: '10:45', end: '11:30', type: 'teaching' },
          { label: '5', start: '11:35', end: '12:20', type: 'teaching' }, { label: '6', start: '13:10', end: '13:55', type: 'teaching' },
          { label: '7', start: '14:00', end: '14:45', type: 'teaching' },
        ],
        blocked: [],
        options: { countMiddayGap: false },
        weights: { ...TT().DEFAULT_WEIGHTS },
        attempts: 3,
      },
      teachers: [], classes: [], rooms: [], subjects: [], lessons: [], meetings: [], duties: [],
      timetable: { placements: [], generatedAt: null, difficulty: null },
    };
  }

  function sampleState() {
    const s = emptyState();
    s.settings.name = 'Greenfield Secondary School';
    // Nine periods a day: 1–3, morning break, 4–5, lunch, 6–7.
    s.settings.periods.splice(3, 0, { label: 'Break', start: '10:25', end: '10:45', type: 'break' });
    s.settings.periods.splice(6, 0, { label: 'Lunch', start: '12:20', end: '13:10', type: 'lunch' });
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
      m1: t('Anita Rao', 'ARA'), m2: t('Brian Ochieng', 'BOC', { unavailable: ['4-7', '4-8'] }),
      e1: t('Chloe Martin', 'CMA'), e2: t('Daniel Kim', 'DKI', { dispreferred: ['0-0', '1-0', '2-0', '3-0', '4-0'] }),
      s1: t('Elena Petrova', 'EPE'), s2: t('Farid Haddad', 'FHA'),
      h1: t('Grace Liu', 'GLI', { unavailable: ['2-7', '2-8'], minPerDay: 2 }), pe: t('Hassan Ali', 'HAL', { dispreferred: ['4-7', '4-8'] }),
      ar: t('Isabel Costa', 'ICO', { unavailable: ['0-0', '0-1', '0-2', '0-4', '0-5', '0-7', '0-8'] }), ic: t('James Wright', 'JWR'),
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
      id: uid(), subjectId: subject.id, teacherId: teacher.id, classIds: classes.map((c) => c.id), sessions, length, room, maxOnePerDay: true, parallel, allowBreakInside: false,
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
    const lastTwo = s.settings.days.flatMap((_, d) => [`${d}-7`, `${d}-8`]);
    s.meetings = [
      { id: uid(), name: 'Whole-staff meeting', teacherIds: s.teachers.map((x) => x.id), sessions: 1, length: 1, room: 'type:Staff', allowed: lastTwo },
      { id: uid(), name: 'Science department', teacherIds: [T.s1.id, T.s2.id], sessions: 1, length: 1, room: '', allowed: [] },
    ];
    s.duties = [{
      id: uid(), name: 'Library supervision', kind: 'teaching', maxPerSlot: 1,
      allowed: s.settings.days.flatMap((_, d) => [`${d}-4`, `${d}-5`]),
      assignments: [T.h1, T.ic, T.ar, T.fr, T.sp].map((x) => ({ teacherId: x.id, hours: 2 })),
    }, {
      id: uid(), name: 'Playground supervision', kind: 'break', maxPerSlot: 3, allowed: [],
      assignments: [T.m1, T.m2, T.e1, T.e2, T.s1, T.s2].map((x) => ({ teacherId: x.id, hours: 2 })),
    }];
    return s;
  }

  // Backwards-compatible defaults for files saved by older versions.
  function migrate(s) {
    const base = emptyState();
    s.settings.weights = { ...base.settings.weights, ...(s.settings.weights || {}) };
    s.settings.attempts = s.settings.attempts || base.settings.attempts;
    (s.settings.periods || []).forEach((p) => { if (!PERIOD_TYPES[p.type]) p.type = 'teaching'; });
    s.settings.blocked = Array.isArray(s.settings.blocked) ? s.settings.blocked : [];
    s.settings.options = { ...base.settings.options, ...(s.settings.options || {}) };
    ['teachers', 'classes', 'rooms'].forEach((k) => { s[k] = s[k] || []; s[k].forEach((x) => { x.unavailable = x.unavailable || []; x.dispreferred = x.dispreferred || []; }); });
    s.subjects = s.subjects || [];
    s.lessons = s.lessons || [];
    s.lessons.forEach((l) => { l.allowBreakInside = !!l.allowBreakInside; });
    s.meetings = s.meetings || [];
    s.duties = s.duties || [];
    s.duties.forEach((d) => { if (d.kind !== 'break') d.kind = 'teaching'; });
    s.timetable = s.timetable || base.timetable;
    // v1 placements stored a single roomId; v2 stores one room per parallel part.
    s.timetable.placements = (s.timetable.placements || []).map((p) => (p.rooms ? p : { ...p, rooms: [p.roomId || null] }));
    return s;
  }

  // ---------- Slots ----------
  const find = (s, list, id) => s[list].find((x) => x.id === id);
  const periodType = (s, p) => (PERIOD_TYPES[s.settings.periods[p]?.type] ? s.settings.periods[p].type : 'teaching');
  const isTeachingPeriod = (s, p) => periodType(s, p) === 'teaching';
  const teachingPeriods = (s) => s.settings.periods.filter((_, p) => isTeachingPeriod(s, p)).length;
  const generalBlocked = (s) => new Set(s.settings.blocked || []);
  const dutyKind = (d) => (d && d.kind === 'break' ? 'break' : 'teaching');
  const keyParts = (k) => k.split('-').map(Number);

  // Why slot key k cannot be used by something of `kind` ('teaching' work or 'break' supervision),
  // or '' if it can. `general: false` ignores the general template (used when editing it).
  function slotDisabled(s, k, kind = 'teaching', { general = true } = {}) {
    const [d, p] = keyParts(k);
    if (!(d >= 0 && d < s.settings.days.length && p >= 0 && p < s.settings.periods.length)) return 'Outside the week';
    const ty = periodType(s, p);
    if (kind === 'break' && ty !== 'break') return `${PERIOD_TYPES[ty]} period — break supervision happens only in break periods`;
    if (kind !== 'break' && ty !== 'teaching') return `${PERIOD_TYPES[ty]} period — nothing is scheduled here`;
    if (general && (s.settings.blocked || []).includes(k)) return 'Blocked for everyone in the general template';
    return '';
  }
  // Every slot key usable by `kind`, in day-major order.
  function selectableKeys(s, kind = 'teaching', opts) {
    const st = s.settings; const out = [];
    st.days.forEach((_, d) => st.periods.forEach((__, p) => { const k = `${d}-${p}`; if (!slotDisabled(s, k, kind, opts)) out.push(k); }));
    return out;
  }
  // Slots a placed unit occupies (its first cell first; a straddled break is not among them).
  const cellsOf = (e, u) => e.pos[u.i].cells;

  // Slots an entity can actually be scheduled in: usable periods of `kind`, not marked ✕.
  function availableSlots(s, ent, kind = 'teaching') {
    const off = new Set(ent.unavailable || []);
    return selectableKeys(s, kind).filter((k) => !off.has(k)).length;
  }
  // Duty periods of a duty: its allowed keys of the matching kind, or every slot of that kind.
  function dutySlots(s, d) {
    const sel = selectableKeys(s, dutyKind(d));
    if (!d.allowed || !d.allowed.length) return sel.length;
    const set = new Set(sel);
    return d.allowed.filter((k) => set.has(k)).length;
  }

  // Per-teacher load in teaching periods (t: everything, tl: lessons only), per-class load (c),
  // and break-supervision periods (tb).
  function workload(s) {
    const t = {}, c = {}, tl = {}, tb = {};
    for (const l of s.lessons) {
      const n = (Number(l.sessions) || 0) * (Number(l.length) || 1);
      t[l.teacherId] = (t[l.teacherId] || 0) + n;
      tl[l.teacherId] = (tl[l.teacherId] || 0) + n;
    }
    for (const m of s.meetings) for (const id of new Set(m.teacherIds || [])) t[id] = (t[id] || 0) + (Number(m.sessions) || 0) * (Number(m.length) || 1);
    for (const d of s.duties) {
      const tgt = dutyKind(d) === 'break' ? tb : t;
      for (const a of d.assignments || []) tgt[a.teacherId] = (tgt[a.teacherId] || 0) + (Number(a.hours) || 0);
    }
    // Parallel lessons share the same periods, so count each group once per class.
    const seen = new Set();
    for (const l of s.lessons) {
      const n = (Number(l.sessions) || 0) * (Number(l.length) || 1);
      for (const id of l.classIds || []) {
        const key = l.parallel && l.parallel.trim() ? `${id}|${l.parallel.trim().toLowerCase()}` : null;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        c[id] = (c[id] || 0) + n;
      }
    }
    return { t, c, tl, tb };
  }

  // True when a placed unit sits on a non-preferred cell (its cost beyond the lateness term).
  function usesDispreferred(e, ui) {
    const p = e.pos[ui]; if (!p) return false;
    return e.unitCost(ui) - e.W.late * (p.cells[p.cells.length - 1] % e.P) > 0;
  }

  // Drop slot keys that no longer mean anything: keys outside the week, teaching-only keys on a
  // break/lunch period, break-duty keys off a break period. Returns how many were removed.
  function pruneDeadKeys(s) {
    let n = 0;
    const keep = (list, kind) => {
      if (!Array.isArray(list)) return list;
      const out = list.filter((k) => !slotDisabled(s, k, kind, { general: false }));
      n += list.length - out.length;
      return out;
    };
    for (const list of ['teachers', 'classes', 'rooms']) for (const x of s[list]) { x.unavailable = keep(x.unavailable, 'teaching'); x.dispreferred = keep(x.dispreferred, 'teaching'); }
    s.settings.blocked = keep(s.settings.blocked, 'teaching');
    for (const m of s.meetings) m.allowed = keep(m.allowed, 'teaching');
    for (const d of s.duties) d.allowed = keep(d.allowed, dutyKind(d));
    return n;
  }
  // Drop placements the engine can no longer restore (e.g. on a period that became a break).
  // Returns how many were removed.
  function prunePlacements(s) {
    const before = s.timetable.placements.length;
    if (!before) return 0;
    s.timetable.placements = new (TT().Engine)(s, s.timetable.placements).placements();
    return before - s.timetable.placements.length;
  }

  // ---------- Descriptions ----------
  function describeLesson(s, lessonId) {
    const l = find(s, 'lessons', lessonId);
    if (!l) return 'Unknown lesson';
    return `${find(s, 'subjects', l.subjectId)?.name || '?'} · ${(l.classIds || []).map((id) => find(s, 'classes', id)?.name).join('+')} · ${find(s, 'teachers', l.teacherId)?.name || 'no teacher'}`;
  }
  function describeUnit(s, unitId) {
    const base = unitId.split('#')[0];
    if (base.startsWith('m:')) { const m = find(s, 'meetings', base.slice(2)); return `${m?.name || 'Meeting'} · ${(m?.teacherIds || []).length} teacher(s)`; }
    if (base.startsWith('d:')) { const [, did, tid] = base.split(':'); return `${find(s, 'duties', did)?.name || 'Duty'} · ${find(s, 'teachers', tid)?.name || '?'}`; }
    return base.split('+').map((id) => describeLesson(s, id)).join('  ∥  ');
  }

  // ---------- Validation ----------
  function validate(s) {
    const issues = [];
    const D = s.settings.days.length;
    const e = new (TT().Engine)(s);
    e.problems.forEach((p) => issues.push({ lvl: 'err', msg: `${p.meetingId ? `Meeting “${find(s, 'meetings', p.meetingId)?.name}”` : p.lessonIds.map((id) => describeLesson(s, id)).join(' & ')} ${p.msg}.` }));
    const w = workload(s);
    s.teachers.forEach((t) => {
      const n = w.t[t.id] || 0;
      if (n > availableSlots(s, t)) issues.push({ lvl: 'err', msg: `${t.name} has ${n} periods but only ${availableSlots(s, t)} free slots.` });
      const nb = w.tb[t.id] || 0;
      if (nb > availableSlots(s, t, 'break')) issues.push({ lvl: 'err', msg: `${t.name} has ${nb} break-supervision periods but only ${availableSlots(s, t, 'break')} free break slots.` });
      const nl = w.tl[t.id] || 0;
      if (t.maxPerDay && nl > t.maxPerDay * D) issues.push({ lvl: 'err', msg: `${t.name} teaches ${nl} periods but max ${t.maxPerDay}/day allows only ${t.maxPerDay * D}.` });
      if (t.maxPerDay && t.minPerDay > t.maxPerDay) issues.push({ lvl: 'warn', msg: `${t.name}: min/day is above max/day.` });
    });
    s.classes.forEach((c) => {
      const n = w.c[c.id] || 0;
      if (n > availableSlots(s, c)) issues.push({ lvl: 'err', msg: `${c.name} has ${n} periods but only ${availableSlots(s, c)} free slots.` });
      else if (!n) issues.push({ lvl: 'warn', msg: `${c.name} has no lessons.` });
    });
    const need = {};
    e.units.forEach((u) => u.parts.forEach((p) => { if (p.roomCands && p.roomCands.length) { const k = p.roomCands.join(','); need[k] = (need[k] || 0) + u.len; } }));
    for (const k in need) {
      const cap = k.split(',').reduce((a, id) => a + availableSlots(s, find(s, 'rooms', id)), 0);
      const names = k.split(',').map((id) => find(s, 'rooms', id).name);
      const label = names.length > 3 ? `${names.slice(0, 3).join(', ')} … (${names.length} rooms)` : names.join(', ');
      if (need[k] > cap) issues.push({ lvl: 'err', msg: `Rooms ${label} are needed for ${need[k]} periods but have ${cap} slots.` });
      // Near-full room sets leave no freedom to keep class days compact.
      else if (need[k] > 0.9 * cap) issues.push({ lvl: 'warn', msg: `Rooms ${label} are ${Math.round(need[k] / cap * 100)}% booked (${need[k]} of ${cap} periods) — expect free periods inside class days. Add rooms or move some lessons to other room types.` });
    }
    const seen = new Set();
    e.units.forEach((u) => { if (!u.starts.length && !seen.has(u.key)) { seen.add(u.key); issues.push({ lvl: 'err', msg: `${describeUnit(s, u.id)} has no period where all its teachers and classes are available.` }); } });
    // Longest run of consecutive teaching periods in a day (period types are the same every day).
    let maxRun = 0, run = 0;
    s.settings.periods.forEach((_, p) => { run = isTeachingPeriod(s, p) ? run + 1 : 0; maxRun = Math.max(maxRun, run); });
    s.lessons.forEach((l) => {
      if (l.maxOnePerDay && Number(l.sessions) > D) issues.push({ lvl: 'err', msg: `${describeLesson(s, l.id)} has ${l.sessions} sessions marked “1/day” but the week has only ${D} days — untick 1/day or reduce sessions.` });
      if (!l.allowBreakInside && Number(l.length) > 1 && Number(l.length) > maxRun) issues.push({ lvl: 'err', msg: `${describeLesson(s, l.id)} needs ${l.length} consecutive teaching periods but no day has that many in a row — tick “Break inside” or change the period types on the Week tab.` });
    });
    const hasBreak = s.settings.periods.some((pp) => pp.type === 'break');
    s.duties.forEach((d) => {
      if (dutyKind(d) === 'break' && !hasBreak) { issues.push({ lvl: 'err', msg: `Duty “${d.name}” is break supervision but no period is typed “Break” on the Week tab.` }); return; }
      const hours = (d.assignments || []).reduce((a, x) => a + (Number(x.hours) || 0), 0);
      const periods = dutySlots(s, d);
      const cap = periods * Math.max(1, Number(d.maxPerSlot) || 1);
      if (hours > cap) issues.push({ lvl: 'err', msg: `Duty “${d.name}” has ${hours} assigned hours but only ${cap} places (${periods} periods × ${d.maxPerSlot || 1}); ${hours - cap} will stay unplaced.` });
      else if (hours < periods) issues.push({ lvl: 'warn', msg: `Duty “${d.name}”: ${hours} hours assigned for ${periods} duty periods — ${periods - hours} period(s) will be uncovered.` });
    });
    if (!e.units.length) issues.push({ lvl: 'warn', msg: 'There are no lessons to schedule.' });
    return { issues, units: e.units.length };
  }

  window.Model = {
    uid, esc, PALETTE, WEIGHT_LABELS, PERIOD_TYPES,
    emptyState, sampleState, migrate, find,
    periodType, isTeachingPeriod, teachingPeriods, generalBlocked, dutyKind, slotDisabled, selectableKeys, cellsOf,
    availableSlots, dutySlots, workload, usesDispreferred, pruneDeadKeys, prunePlacements,
    describeLesson, describeUnit, validate,
  };
})();
