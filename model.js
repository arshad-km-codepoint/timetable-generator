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
    ends: 'Lesson in the first or last period of a day', roomPref: 'Lesson not in its preferred room',
    activityMin: 'Activity day with fewer periods than its minimum (per period short)',
    roomSame: 'Sessions of one lesson in different rooms', consecutiveDays: 'Sessions of one lesson on consecutive days',
    balance: 'Teacher load uneven across days (per period off)', consecutive: 'Teacher over their max periods in a row (per period)',
    presence: 'Teacher present longer than allowed (per period)', exclusive: 'Teacher’s last period then first period next day',
  };
  const RELATION_TYPES = {
    differentDays: 'On different days', notSameTime: 'Not at the same time', nonConsecutive: 'Not in consecutive periods',
    consecutive: 'In consecutive periods (same day)', daysApart: 'Days apart (min–max)',
  };
  // Week rules a teacher can carry (0 / false = none).
  const teacherDefaults = () => ({ maxPerDay: 0, minPerDay: 0, maxConsecutive: 0, freeDays: 0, maxPresenceDay: 0, maxPresenceWeek: 0, presenceStrict: false, noLastFirst: false });
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
      teachers: [], classes: [], grades: [], rooms: [], subjects: [], lessons: [], meetings: [], activities: [], duties: [], pins: [],
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
    const t = (name, code, extra = {}) => ({ id: uid(), name, code, unavailable: [], dispreferred: [], ...teacherDefaults(), maxPerDay: 6, ...extra });
    const T = {
      m1: t('Anita Rao', 'ARA'), m2: t('Brian Ochieng', 'BOC', { unavailable: ['4-7', '4-8'] }),
      e1: t('Chloe Martin', 'CMA'), e2: t('Daniel Kim', 'DKI', { dispreferred: ['0-0', '1-0', '2-0', '3-0', '4-0'] }),
      s1: t('Elena Petrova', 'EPE'), s2: t('Farid Haddad', 'FHA'),
      h1: t('Grace Liu', 'GLI', { unavailable: ['2-7', '2-8'], minPerDay: 2 }), pe: t('Hassan Ali', 'HAL', { dispreferred: ['4-7', '4-8'] }),
      ar: t('Isabel Costa', 'ICO', { unavailable: ['0-0', '0-1', '0-2', '0-4', '0-5', '0-7', '0-8'] }), ic: t('James Wright', 'JWR'),
      fr: t('Kofi Mensah', 'KME'), sp: t('Lucia Romero', 'LRO'),
    };
    s.teachers = Object.values(T);
    s.classes = ['6A', '6B', '7A', '7B', '8A', '8B'].map((n) => ({ id: uid(), name: n, unavailable: [], dispreferred: [], homeroom: '', gradeId: '' }));
    s.rooms = [
      ...['R101', 'R102', 'R103', 'R104', 'R105', 'R106'].map((n) => ({ id: uid(), name: n, type: 'Classroom', unavailable: [], dispreferred: [] })),
      ...[['Science Lab 1', 'Lab'], ['Science Lab 2', 'Lab'], ['Sports Hall', 'Gym'], ['Art Studio', 'Art'], ['Computer Lab', 'Computer']]
        .map(([name, type]) => ({ id: uid(), name, type, unavailable: [], dispreferred: [] })),
    ];
    const L = (subject, teacher, classes, sessions, length, room, parallel = '') => ({
      ...lessonDefaults(), id: uid(), subjectId: subject.id, teacherId: teacher.id, classIds: classes.map((c) => c.id), lengths: Array(sessions).fill(length), room, parallel,
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
    // A complementary activity: teacher-only periods, at most two a day and never back to back.
    s.activities = [{ id: uid(), name: 'Lab preparation', teacherId: T.s1.id, periods: 3, minPerDay: 0, maxPerDay: 1, nonConsecutive: true, countLoad: false, allowed: [] }];
    // A pin: the first Maths session of 6A is fixed on Tuesday, period 2, before generation.
    s.pins = [{ kind: 'lesson', id: s.lessons.find((l) => l.subjectId === S.math.id && l.classIds[0] === s.classes[0].id).id, k: 0, day: 1, period: 1 }];
    // One grade per year; its curriculum is what the year's first class is taught.
    s.grades = [['Year 6', '6'], ['Year 7', '7'], ['Year 8', '8']].map(([name, y]) => {
      const classes = s.classes.filter((c) => c.name.startsWith(y));
      classes.forEach((c) => { c.gradeId = ''; });
      const g = { id: uid(), name, curriculum: deriveCurriculum(s, classes[0].id) };
      classes.forEach((c) => { c.gradeId = g.id; });
      return g;
    });
    return s;
  }

  // ---------- Grades & curriculum ----------
  // A grade names a group of classes and the subjects each of them takes, with weekly periods:
  // grades: [{ id, name, curriculum: [{ subjectId, periods }] }], class.gradeId. Planning aid only —
  // the engine never reads it; validation compares each class's lessons with it.
  const gradeOf = (s, classId) => { const c = (s.classes || []).find((x) => x.id === classId); return (c && c.gradeId && (s.grades || []).find((g) => g.id === c.gradeId)) || null; };
  // Weekly periods per subject among the lesson rows a class attends.
  function classSubjectPeriods(s, classId) {
    const out = {};
    for (const l of s.lessons) if ((l.classIds || []).includes(classId)) out[l.subjectId] = (out[l.subjectId] || 0) + periodsOf(l);
    return out;
  }
  // The subjects a class is taught as a curriculum, in subject-list order.
  function deriveCurriculum(s, classId) {
    const have = classSubjectPeriods(s, classId);
    return s.subjects.filter((x) => have[x.id] > 0).map((x) => ({ subjectId: x.id, periods: have[x.id] }));
  }
  // Curriculum entries a class does not meet exactly: { subjectId, want, have }.
  function curriculumGaps(s, classId) {
    const g = gradeOf(s, classId); if (!g) return [];
    const have = classSubjectPeriods(s, classId);
    return g.curriculum.filter((e) => (have[e.subjectId] || 0) !== e.periods).map((e) => ({ subjectId: e.subjectId, want: e.periods, have: have[e.subjectId] || 0 }));
  }
  // The curriculum subject ids shared by the grade of all `classIds`, or null when they are not all
  // in one grade with a curriculum (the Lessons tab then offers every subject alike).
  function curriculumSubjects(s, classIds) {
    const grades = new Set((classIds || []).map((id) => { const g = gradeOf(s, id); return g ? g.id : ''; }));
    if (grades.size !== 1) return null;
    const g = (s.grades || []).find((x) => x.id === [...grades][0]);
    return g && g.curriculum.length ? new Set(g.curriculum.map((e) => e.subjectId)) : null;
  }
  // One new single-period row per curriculum subject the class has no lessons for (teacher left
  // blank; the row starts in the class homeroom). Returns how many rows it added.
  function applyCurriculum(s, classId) {
    const g = gradeOf(s, classId); if (!g) return 0;
    let n = 0;
    for (const gap of curriculumGaps(s, classId)) {
      if (gap.have) continue;
      const l = newLesson(gap.subjectId, [classId], s);
      l.lengths = Array(gap.want).fill(1);
      l.maxOnePerDay = gap.want <= s.settings.days.length;
      s.lessons.push(l); n++;
    }
    return n;
  }
  const missingLessons = (s, gradeId) => s.classes.filter((c) => c.gradeId === gradeId).reduce((n, c) => n + curriculumGaps(s, c.id).filter((x) => !x.have).length, 0);

  // ---------- Lessons ----------
  // Every field a lesson row carries besides its identity and references.
  function lessonDefaults() {
    return { room: '', roomAlt: '', sameRoom: false, lengths: [1], flexible: null, maxOnePerDay: true, parallel: '', allowBreakInside: false, penalizeEnds: false, avoidConsecutiveDays: false, relations: [] };
  }
  // A new row for one class that has a homeroom starts in it (pass the state `s` to enable that).
  function newLesson(subjectId, classIds = [], s = null) {
    const home = s && classIds.length === 1 ? homeroomOf(s, classIds) : '';
    return { ...lessonDefaults(), id: uid(), subjectId, teacherId: '', classIds, room: home ? 'home' : '' };
  }
  // The room all of `classIds` share as homeroom, or '' (none set, unknown room, or they differ).
  function homeroomOf(s, classIds) {
    const homes = (classIds || []).map((id) => { const c = (s.classes || []).find((x) => x.id === id); return c && (s.rooms || []).some((r) => r.id === c.homeroom) ? c.homeroom : ''; });
    return homes.length && homes.every((h) => h && h === homes[0]) ? homes[0] : '';
  }
  // Point the class's own rows at its homeroom: rows with no room, and rows asking for “Any <type>”
  // of the homeroom's type (they keep that type as the fallback). Rows with another room, shared
  // rows and rows that already use the homeroom are left alone.
  function applyHomeroom(s, classId) {
    const c = (s.classes || []).find((x) => x.id === classId); const room = c && (s.rooms || []).find((r) => r.id === c.homeroom);
    const out = { none: 0, type: 0 };
    if (!room) return out;
    for (const l of s.lessons) {
      if ((l.classIds || []).length !== 1 || l.classIds[0] !== classId) continue;
      if (!l.room) { l.room = 'home'; out.none++; }
      else if (room.type && l.room === 'type:' + room.type) { l.room = 'home'; l.roomAlt = l.roomAlt || 'type:' + room.type; out.type++; }
    }
    return out;
  }
  // "221", "2,2,1" or "2 2 1" → [2, 2, 1]; null when empty, non-numeric, zero or a block above `max`.
  function parseLengths(text, max = Infinity) {
    const t = String(text ?? '').trim();
    if (!t) return null;
    const parts = /[\s,;+]/.test(t) ? t.split(/[\s,;+]+/).filter(Boolean) : t.split('');
    if (!parts.length || !parts.every((x) => /^\d+$/.test(x))) return null;
    const out = parts.map(Number);
    return out.every((n) => n >= 1 && n <= max) ? out : null;
  }
  // Can `total` periods be split into blocks of min..max periods each?
  function canPartition(total, min, max) {
    total = Number(total); min = Number(min); max = Number(max);
    if (!(total >= 1 && min >= 1 && max >= min)) return false;
    for (let k = 1; k * min <= total; k++) if (total <= k * max) return true;
    return false;
  }
  // The most even split of `total` into the fewest blocks of min..max (largest first), or null.
  function partition(total, min, max) {
    if (!canPartition(total, min, max)) return null;
    const k = Math.ceil(total / max); const base = Math.floor(total / k); const extra = total - base * k;
    return Array.from({ length: k }, (_, i) => (i < extra ? base + 1 : base));
  }
  const isLengths = (a) => Array.isArray(a) && a.length > 0 && a.every((n) => Number.isInteger(n) && n >= 1);
  const sessionsOf = (l) => (isLengths(l.lengths) ? l.lengths.length : 0);
  const periodsOf = (l) => (isLengths(l.lengths) ? l.lengths.reduce((a, b) => a + b, 0) : 0);
  const lengthsText = (lengths) => (isLengths(lengths) ? lengths.join(' ') : '');
  // A valid flexible spec, or null.
  function flexibleOf(f) {
    if (!f || typeof f !== 'object') return null;
    const total = Number(f.total), min = Number(f.min), max = Number(f.max);
    return canPartition(total, min, max) ? { total, min, max } : null;
  }
  // Row defaults for files saved by older versions: sessions × length becomes `lengths`. A flexible
  // row keeps `lengths` as one valid partition of its total, so session and period counts stay
  // meaningful without the engine; the engine makes its own choice.
  function migrateLesson(l) {
    const d = lessonDefaults();
    if (!isLengths(l.lengths)) l.lengths = Array(Math.max(1, Math.floor(Number(l.sessions)) || 1)).fill(Math.max(1, Math.floor(Number(l.length)) || 1));
    delete l.sessions; delete l.length;
    l.flexible = flexibleOf(l.flexible);
    if (l.flexible && periodsOf(l) !== l.flexible.total) l.lengths = partition(l.flexible.total, l.flexible.min, l.flexible.max);
    for (const k of ['room', 'roomAlt', 'parallel']) if (typeof l[k] !== 'string') l[k] = d[k];
    // An alternative set without a room is just "any room of that type".
    if (!l.room && l.roomAlt) { l.room = l.roomAlt; l.roomAlt = ''; }
    for (const k of ['sameRoom', 'allowBreakInside', 'penalizeEnds', 'avoidConsecutiveDays']) l[k] = !!l[k];
    l.maxOnePerDay = l.maxOnePerDay === undefined ? d.maxOnePerDay : !!l.maxOnePerDay;
    l.classIds = Array.isArray(l.classIds) ? l.classIds : [];
    l.relations = (Array.isArray(l.relations) ? l.relations : []).filter((r) => r && RELATION_TYPES[r.type] && r.lessonId && r.lessonId !== l.id).map((r) => relationOf(r.type, r.lessonId, r));
    return l;
  }
  const relationOf = (type, lessonId, { min, max } = {}) => (type === 'daysApart'
    ? { type, lessonId, min: Math.max(0, Math.floor(Number(min)) || 0), max: Math.max(0, Math.floor(Number(max)) || 0) } : { type, lessonId });
  const sameRelation = (a, b) => a.type === b.type && a.lessonId === b.lessonId;
  // Relations pointing at rows that no longer exist are removed. Returns how many were dropped.
  function dropDeadRelations(s) {
    const ids = new Set(s.lessons.map((l) => l.id)); let n = 0;
    for (const l of s.lessons) {
      const keep = (l.relations || []).filter((r) => ids.has(r.lessonId) && r.lessonId !== l.id);
      n += (l.relations || []).length - keep.length; l.relations = keep;
    }
    return n;
  }
  // A relation is stored on both rows; whichever side is missing is added (min/max copied).
  function symmetrizeRelations(s) {
    for (const l of s.lessons) for (const r of l.relations || []) {
      const o = find(s, 'lessons', r.lessonId); if (!o) continue;
      o.relations = o.relations || [];
      const mirror = { ...r, lessonId: l.id };
      const i = o.relations.findIndex((x) => sameRelation(x, mirror));
      if (i < 0) o.relations.push(mirror); else o.relations[i] = mirror;
    }
  }
  // Add (or replace) a relation of `type` between rows a and b, on both of them.
  function addRelation(s, aId, bId, type, opts) {
    const a = find(s, 'lessons', aId), b = find(s, 'lessons', bId);
    if (!a || !b || a === b || !RELATION_TYPES[type]) return false;
    for (const [row, other] of [[a, bId], [b, aId]]) {
      const r = relationOf(type, other, opts);
      row.relations = (row.relations || []).filter((x) => !sameRelation(x, r)); row.relations.push(r);
    }
    return true;
  }
  function removeRelation(s, aId, bId, type) {
    for (const [x, y] of [[aId, bId], [bId, aId]]) { const row = find(s, 'lessons', x); if (row) row.relations = (row.relations || []).filter((r) => !(r.type === type && r.lessonId === y)); }
  }
  // Delete a lesson row together with every relation that points at it.
  function removeLesson(s, id) {
    s.lessons = s.lessons.filter((l) => l.id !== id);
    dropDeadRelations(s);
    dropDeadPins(s);
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
    s.teachers.forEach((t) => {
      for (const k of ['maxConsecutive', 'maxPresenceDay', 'maxPresenceWeek', 'freeDays']) t[k] = Math.max(0, Math.floor(Number(t[k])) || 0);
      t.presenceStrict = !!t.presenceStrict; t.noLastFirst = !!t.noLastFirst;
      for (const k of ['maxPerDay', 'minPerDay']) if (t[k] === undefined) t[k] = 0;
    });
    s.classes.forEach((c) => { if (!s.rooms.some((r) => r.id === c.homeroom)) c.homeroom = ''; });
    s.subjects = s.subjects || [];
    s.grades = Array.isArray(s.grades) ? s.grades.filter((g) => g && g.id) : [];
    s.grades.forEach((g) => {
      g.name = typeof g.name === 'string' ? g.name : 'Grade';
      const seen = new Set();
      g.curriculum = (Array.isArray(g.curriculum) ? g.curriculum : [])
        .map((e) => ({ subjectId: e && e.subjectId, periods: Math.floor(Number(e && e.periods)) }))
        .filter((e) => s.subjects.some((x) => x.id === e.subjectId) && e.periods >= 1 && !seen.has(e.subjectId) && seen.add(e.subjectId));
    });
    s.classes.forEach((c) => { if (!s.grades.some((g) => g.id === c.gradeId)) c.gradeId = ''; });
    s.lessons = s.lessons || [];
    s.lessons.forEach((l) => migrateLesson(l));
    dropDeadRelations(s);
    symmetrizeRelations(s);
    s.meetings = s.meetings || [];
    s.activities = (Array.isArray(s.activities) ? s.activities : []).filter((a) => a && a.id);
    s.activities.forEach((a) => {
      a.name = typeof a.name === 'string' ? a.name : 'Activity';
      a.teacherId = typeof a.teacherId === 'string' ? a.teacherId : '';
      for (const k of ['periods', 'minPerDay', 'maxPerDay']) a[k] = Math.max(0, Math.floor(Number(a[k])) || 0);
      a.nonConsecutive = !!a.nonConsecutive; a.countLoad = !!a.countLoad;
      a.allowed = Array.isArray(a.allowed) ? a.allowed : [];
    });
    s.duties = s.duties || [];
    dropDeadPins(s);
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

  // Plain-words name of a set of rooms: "Lab 1", "all 20 Classroom rooms", or a short list.
  function roomSetLabel(s, ids) {
    const rooms = ids.map((id) => find(s, 'rooms', id)).filter(Boolean);
    if (rooms.length === 1) return { label: rooms[0].name, plural: false };
    const types = [...new Set(rooms.map((r) => r.type || ''))];
    if (types.length === 1) {
      const ofType = s.rooms.filter((r) => (r.type || '') === types[0]).length;
      const kind = types[0] || 'untyped';
      if (ofType === rooms.length) return { label: `all ${rooms.length} ${kind} rooms`, plural: true };
      const names = rooms.map((r) => r.name);
      return { label: `${kind} rooms ${names.length > 3 ? `${names.slice(0, 3).join(', ')} … (${names.length} rooms)` : names.join(', ')}`, plural: true };
    }
    const names = rooms.map((r) => r.name);
    return { label: names.length > 3 ? `${names.slice(0, 3).join(', ')} … (${names.length} rooms)` : names.join(', '), plural: true };
  }

  // Per-teacher load in teaching periods (t: everything, tl: lessons only), per-class load (c),
  // and break-supervision periods (tb).
  function workload(s) {
    const t = {}, c = {}, tl = {}, tb = {};
    for (const l of s.lessons) {
      const n = periodsOf(l);
      t[l.teacherId] = (t[l.teacherId] || 0) + n;
      tl[l.teacherId] = (tl[l.teacherId] || 0) + n;
    }
    for (const m of s.meetings) for (const id of new Set(m.teacherIds || [])) t[id] = (t[id] || 0) + (Number(m.sessions) || 0) * (Number(m.length) || 1);
    for (const a of s.activities) {
      const n = Number(a.periods) || 0;
      t[a.teacherId] = (t[a.teacherId] || 0) + n;
      if (a.countLoad) tl[a.teacherId] = (tl[a.teacherId] || 0) + n;
    }
    for (const d of s.duties) {
      const tgt = dutyKind(d) === 'break' ? tb : t;
      for (const a of d.assignments || []) tgt[a.teacherId] = (tgt[a.teacherId] || 0) + (Number(a.hours) || 0);
    }
    // Parallel lessons share the same periods, so count each group once per class.
    const seen = new Set();
    for (const l of s.lessons) {
      const n = periodsOf(l);
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

  // Drop slot keys that no longer mean anything: keys outside the week, template keys on a
  // break/lunch period, break-duty keys off a break period. Teacher/class/room keys stay on break
  // periods (a ✕ there keeps a teacher off break duty); only lunch and out-of-week keys go.
  // Returns how many were removed.
  function pruneDeadKeys(s) {
    let n = 0;
    const keep = (list, dead) => {
      if (!Array.isArray(list)) return list;
      const out = list.filter((k) => !dead(k));
      n += list.length - out.length;
      return out;
    };
    const byKind = (kind) => (k) => !!slotDisabled(s, k, kind, { general: false });
    const unusable = (k) => slotDisabled(s, k, 'teaching', { general: false }) === 'Outside the week' || periodType(s, keyParts(k)[1]) === 'lunch';
    for (const list of ['teachers', 'classes', 'rooms']) for (const x of s[list]) { x.unavailable = keep(x.unavailable, unusable); x.dispreferred = keep(x.dispreferred, unusable); }
    s.settings.blocked = keep(s.settings.blocked, byKind('teaching'));
    for (const m of s.meetings) m.allowed = keep(m.allowed, byKind('teaching'));
    for (const a of s.activities) a.allowed = keep(a.allowed, byKind('teaching'));
    for (const d of s.duties) d.allowed = keep(d.allowed, byKind(dutyKind(d)));
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
    if (base.startsWith('a:')) { const a = find(s, 'activities', base.slice(2)); return `${a?.name || 'Activity'} · ${find(s, 'teachers', a?.teacherId)?.name || '?'}`; }
    if (base.startsWith('d:')) { const [, did, tid] = base.split(':'); return `${find(s, 'duties', did)?.name || 'Duty'} · ${find(s, 'teachers', tid)?.name || '?'}`; }
    return base.split('+').map((id) => describeLesson(s, id)).join('  ∥  ');
  }


  // Explain why unit u cannot start at slot s on engine e, or return null if it can.
  function unitBlockReason(st, e, u, s) {
    const p = s % e.P, ty = periodType(st, p);
    const brkDuty = u.kind === 'duty' && dutyKind(find(st, 'duties', u.service)) === 'break';
    if (brkDuty) { if (ty !== 'break') return 'Break supervision can only go on a break period.'; }
    else {
      if (ty !== 'teaching') return `That is a ${ty} period.`;
      const cells = e.spanCells(u.kind, u.len, u.allowBreak, s);
      if (!cells) {
        return !u.allowBreak && e.spanCells(u.kind, u.len, true, s) ? 'A multi-period lesson would run into a break there — tick “Break inside” on the lesson to allow that.' : 'A multi-period lesson does not fit there.';
      }
      if (cells.some((c) => e.general.has(c))) return 'The general template blocks that time for everyone.';
    }
    if (!u.starts.includes(s)) return 'A teacher or class is marked ✕ (prohibited) at that time.';
    const base = e.baseConflicts(u.i, s);
    if (base === null) return 'That would break a hard rule of a teacher (maximum periods per day, days off, strict presence or an activity limit).';
    if (base.size) {
      const who = [...base].map((o) => describeUnit(st, e.units[o].id));
      return `Clash with: ${who.slice(0, 2).join('; ')}${who.length > 2 ? ` (+${who.length - 2})` : ''}`;
    }
    return null;
  }

  // ---------- Pins (preset positions) ----------
  // state.pins: [{ kind: 'lesson' | 'meeting' | 'activity', id, k, day, period }] fixes session k
  // (0-based, in distribution order) of a lesson row, meeting or activity at a start slot before
  // generation. The generator places pinned sessions first and builds around them; a pin that
  // cannot be honoured is reported. Pins are planner data, separate from locks on a timetable.
  const PIN_KINDS = { lesson: 'lessons', meeting: 'meetings', activity: 'activities' };
  // How many sessions a pinnable thing has (the k range of its pins) and how long each is.
  function pinSessions(s, kind, id) {
    const x = PIN_KINDS[kind] && find(s, PIN_KINDS[kind], id); if (!x) return [];
    if (kind === 'lesson') return x.flexible ? [] : isLengths(x.lengths) ? x.lengths.slice() : [];
    if (kind === 'meeting') return Array.from({ length: Math.max(0, Math.floor(Number(x.sessions)) || 0) }, () => Math.max(1, Math.floor(Number(x.length)) || 1));
    return Array.from({ length: Math.max(0, Math.floor(Number(x.periods)) || 0) }, () => 1);
  }
  const pinName = (s, kind, id) => (kind === 'lesson' ? describeLesson(s, id) : (find(s, PIN_KINDS[kind], id) || {}).name || kind);
  const pinAt = (s, kind, id, k) => (s.pins || []).find((p) => p.kind === kind && p.id === id && p.k === k) || null;
  // Fix session k at (day, period); day null clears it.
  function setPin(s, kind, id, k, day, period) {
    s.pins = (s.pins || []).filter((p) => !(p.kind === kind && p.id === id && p.k === k));
    if (day !== null && day !== undefined) s.pins.push({ kind, id, k, day, period });
  }
  // Drop pins that no longer point at a session or a slot of the week; returns how many went.
  function dropDeadPins(s) {
    const D = s.settings.days.length, P = s.settings.periods.length; const seen = new Set();
    const before = (s.pins || []).length;
    s.pins = (Array.isArray(s.pins) ? s.pins : []).filter((p) => {
      if (!p || !PIN_KINDS[p.kind] || typeof p.id !== 'string') return false;
      const k = Math.floor(Number(p.k)), day = Math.floor(Number(p.day)), period = Math.floor(Number(p.period));
      if (!(k >= 0 && k < pinSessions(s, p.kind, p.id).length && day >= 0 && day < D && period >= 0 && period < P)) return false;
      const key = `${p.kind}|${p.id}|${k}`; if (seen.has(key)) return false; seen.add(key);
      p.k = k; p.day = day; p.period = period;
      return true;
    });
    return before - s.pins.length;
  }
  // Human messages for pins the engine cannot honour (an engine without placements is expected).
  function pinIssues(s) {
    const e = new (TT().Engine)(s);
    const days = s.settings.days;
    return e.applyPins(s.pins).map((pr) => {
      const p = pr.pin; const who = `${pinName(s, p.kind, p.id)}, session ${p.k + 1}`;
      const where = `${days[p.day]}, period ${s.settings.periods[p.period].label}`;
      let why;
      if (pr.why === 'flexible') why = 'a flexible row has no fixed sessions to pin — give it a fixed distribution';
      else if (pr.why === 'missing') why = 'that session was not generated (check the row for data problems)';
      else if (pr.why === 'twice') why = 'another pin already fixes this session elsewhere';
      else if (pr.why === 'room') why = 'no free room of the required kind at that time';
      else why = unitBlockReason(s, e, e.units[pr.unit], p.day * e.P + p.period) || 'it is not allowed there';
      return { lvl: 'err', msg: `Pin on ${who} (${where}) cannot be honoured: ${why}` };
    });
  }

  // ---------- Validation ----------
  function validate(s) {
    const issues = [];
    const D = s.settings.days.length;
    const e = new (TT().Engine)(s);
    issues.push(...pinIssues(s));
    e.problems.forEach((p) => issues.push({ lvl: 'err', msg: `${p.activityId ? `Activity “${find(s, 'activities', p.activityId)?.name}”` : p.meetingId ? `Meeting “${find(s, 'meetings', p.meetingId)?.name}”` : p.lessonIds.map((id) => describeLesson(s, id)).join(' & ')} ${p.msg}.` }));
    const w = workload(s);
    s.teachers.forEach((t) => {
      const n = w.t[t.id] || 0;
      if (n > availableSlots(s, t)) issues.push({ lvl: 'err', msg: `${t.name} has ${n} periods but only ${availableSlots(s, t)} free slots.` });
      const nb = w.tb[t.id] || 0;
      if (nb > availableSlots(s, t, 'break')) issues.push({ lvl: 'err', msg: `${t.name} has ${nb} break-supervision periods but only ${availableSlots(s, t, 'break')} free break slots.` });
      const nl = w.tl[t.id] || 0;
      if (t.maxPerDay && nl > t.maxPerDay * D) issues.push({ lvl: 'err', msg: `${t.name} teaches ${nl} periods but max ${t.maxPerDay}/day allows only ${t.maxPerDay * D}.` });
      if (t.maxPerDay && t.minPerDay > t.maxPerDay) issues.push({ lvl: 'warn', msg: `${t.name}: min/day is above max/day.` });
      const workDays = e.balDays[t.id].length;
      if (t.freeDays) {
        const usable = Math.max(0, workDays - t.freeDays);
        if (!usable && nl) issues.push({ lvl: 'err', msg: `${t.name} must have ${t.freeDays} free day(s) but can only work ${workDays}, so no lesson fits.` });
        else if (t.maxPerDay && nl > usable * t.maxPerDay) issues.push({ lvl: 'err', msg: `${t.name} teaches ${nl} periods; with ${t.freeDays} free day(s) and max ${t.maxPerDay}/day only ${usable * t.maxPerDay} fit.` });
        else if (nl > usable * teachingPeriods(s)) issues.push({ lvl: 'err', msg: `${t.name} teaches ${nl} periods but ${usable} working day(s) hold only ${usable * teachingPeriods(s)}.` });
      }
      if (t.presenceStrict && t.maxPresenceWeek && n > t.maxPresenceWeek) issues.push({ lvl: 'err', msg: `${t.name} has ${n} periods but the strict weekly presence limit is ${t.maxPresenceWeek}.` });
      if (t.maxPresenceDay && t.maxPresenceWeek && t.maxPresenceDay > t.maxPresenceWeek) issues.push({ lvl: 'warn', msg: `${t.name}: presence/day is above presence/week.` });
      if (t.presenceStrict && t.maxPresenceDay && n > t.maxPresenceDay * workDays) issues.push({ lvl: 'err', msg: `${t.name} has ${n} periods but presence ${t.maxPresenceDay}/day over ${workDays} day(s) allows only ${t.maxPresenceDay * workDays}.` });
    });
    s.classes.forEach((c) => {
      const n = w.c[c.id] || 0;
      if (n > availableSlots(s, c)) issues.push({ lvl: 'err', msg: `${c.name} has ${n} periods but only ${availableSlots(s, c)} free slots.` });
      else if (!n) issues.push({ lvl: 'warn', msg: `${c.name} has no lessons.` });
    });
    for (const r of e.roomDemand()) {
      const { label, plural } = roomSetLabel(s, r.rooms);
      const [be, have] = plural ? ['are', 'have'] : ['is', 'has'];
      const Label = label[0].toUpperCase() + label.slice(1);
      if (r.demand > r.capacity) issues.push({ lvl: 'err', msg: `${Label} ${be} needed for ${r.demand} periods but ${have} only ${r.capacity} usable slots.` });
      // Near-full room sets leave no freedom to keep class days compact — but only when several
      // classes (or meetings) compete for them; one class filling its own homeroom is fine.
      else if (r.users > 1 && r.demand > 0.9 * r.capacity) issues.push({ lvl: 'warn', msg: `${Label} ${be} ${Math.round(r.demand / r.capacity * 100)}% booked (${r.demand} of ${r.capacity} periods, ${r.users} classes and meetings competing) — expect free periods inside class days. Add rooms or move some lessons to other room types.` });
    }
    // Curriculum: each class should have exactly the periods its grade lists for every subject.
    s.classes.forEach((c) => {
      const g = gradeOf(s, c.id); if (!g) return;
      const total = g.curriculum.reduce((a, e) => a + e.periods, 0);
      if (total > availableSlots(s, c)) issues.push({ lvl: 'err', msg: `The ${g.name} curriculum asks for ${total} periods but ${c.name} has only ${availableSlots(s, c)} free slots.` });
      for (const gap of curriculumGaps(s, c.id)) {
        const subj = find(s, 'subjects', gap.subjectId).name;
        const pl = (n) => `${n} period${n === 1 ? '' : 's'}`;
        issues.push({ lvl: 'warn', msg: gap.have ? `${c.name} has ${pl(gap.have)} of ${subj} but the ${g.name} curriculum asks for ${gap.want}.` : `${c.name} has no ${subj} lessons but the ${g.name} curriculum asks for ${pl(gap.want)}.` });
      }
    });
    // Activities: the per-day limits must be able to hold the weekly periods.
    s.activities.forEach((a) => {
      const t = find(s, 'teachers', a.teacherId);
      if (!t || !(a.periods > 0)) return;     // the engine already reports these
      const slots = a.allowed && a.allowed.length ? a.allowed.filter((k) => !slotDisabled(s, k) && !(t.unavailable || []).includes(k)) : selectableKeys(s).filter((k) => !(t.unavailable || []).includes(k));
      const days = new Set(slots.map((k) => keyParts(k)[0])).size;
      if (a.minPerDay && a.maxPerDay && a.minPerDay > a.maxPerDay) issues.push({ lvl: 'warn', msg: `Activity “${a.name}”: min/day is above max/day.` });
      if (a.maxPerDay && a.periods > a.maxPerDay * days) issues.push({ lvl: 'err', msg: `Activity “${a.name}” has ${a.periods} periods but max ${a.maxPerDay}/day over the ${days} day(s) ${t.name} can be there holds only ${a.maxPerDay * days}.` });
      if (slots.length < a.periods) issues.push({ lvl: 'err', msg: `Activity “${a.name}” has ${a.periods} periods but only ${slots.length} usable slot(s) for ${t.name}.` });
    });
    // Homerooms: a room shared by several classes, and parallel rows that all want the same homeroom.
    const homeUsers = {};
    s.classes.forEach((c) => { if (c.homeroom) (homeUsers[c.homeroom] ||= []).push(c.name); });
    for (const rid in homeUsers) if (homeUsers[rid].length > 1) issues.push({ lvl: 'warn', msg: `Classes ${homeUsers[rid].join(' and ')} share the homeroom ${find(s, 'rooms', rid).name}, so their lessons compete for it.` });
    const homeRows = {};
    s.lessons.forEach((l) => { const g = (l.parallel || '').trim().toLowerCase(); const h = l.room === 'home' ? homeroomOf(s, l.classIds) : ''; if (g && h && !l.roomAlt) (homeRows[g + '|' + h] ||= []).push(l); });
    for (const k in homeRows) if (homeRows[k].length > 1) issues.push({ lvl: 'err', msg: `${homeRows[k].map((l) => describeLesson(s, l.id)).join(' & ')} run in parallel but all use the homeroom ${find(s, 'rooms', k.split('|')[1]).name} — give all but one an alternative room or another room.` });
    const seen = new Set();
    e.units.forEach((u) => { if (!u.starts.length && !seen.has(u.key)) { seen.add(u.key); issues.push({ lvl: 'err', msg: `${describeUnit(s, u.id)} has no period where all its teachers and classes are available.` }); } });
    // Longest run of consecutive teaching periods in a day (period types are the same every day).
    let maxRun = 0, run = 0;
    s.settings.periods.forEach((_, p) => { run = isTeachingPeriod(s, p) ? run + 1 : 0; maxRun = Math.max(maxRun, run); });
    const perDay = teachingPeriods(s);
    // Problems the engine already reported (by message pattern and rows) are not reported twice.
    const flagged = (re, ids) => e.problems.some((p) => re.test(p.msg) && ids.every((id) => (p.lessonIds || []).includes(id)));
    const byTag = {};
    s.lessons.forEach((l) => {
      const who = describeLesson(s, l.id);
      if (!isLengths(l.lengths)) { issues.push({ lvl: 'err', msg: `${who} has no valid distribution — enter the session lengths, e.g. “2 2 1”.` }); return; }
      const n = sessionsOf(l);
      if (l.maxOnePerDay && n > D) issues.push({ lvl: 'err', msg: `${who} has ${n} sessions marked “1/day” but the week has only ${D} days — untick 1/day or reduce sessions.` });
      if (l.flexible && !canPartition(l.flexible.total, l.flexible.min, l.flexible.max) && !flagged(/flexible/, [l.id])) issues.push({ lvl: 'err', msg: `${who}: ${l.flexible.total} periods cannot be split into blocks of ${l.flexible.min}–${l.flexible.max} periods.` });
      // The longest block the engine may build: the longest explicit one, or the flexible maximum.
      const longest = Math.max(...l.lengths, l.flexible ? l.flexible.max : 0);
      if (longest > perDay && !flagged(/session length/, [l.id])) issues.push({ lvl: 'err', msg: `${who} has a block of ${longest} periods but a day has only ${perDay} teaching periods.` });
      else if (!l.allowBreakInside && longest > 1 && longest > maxRun) issues.push({ lvl: 'err', msg: `${who} needs ${longest} consecutive teaching periods but no day has that many in a row — tick “Break inside” or change the period types on the Week tab.` });
      const tag = (l.parallel || '').trim().toLowerCase();
      if (tag) (byTag[tag] = byTag[tag] || []).push(l);
      if (l.sameRoom && (l.room || '').startsWith('type:') && n > 1 && s.rooms.filter((r) => (r.type || '') === l.room.slice(5)).length < 2) issues.push({ lvl: 'warn', msg: `${who}: “Same room for all sessions” has no effect — there is only one ${l.room.slice(5)} room.` });
      if (l.roomAlt && !l.room) issues.push({ lvl: 'warn', msg: `${who} has alternative rooms but no room — treated as “Any ${l.roomAlt.slice(5)}”.` });
      for (const r of l.relations || []) {
        const o = find(s, 'lessons', r.lessonId);
        if (!o) { issues.push({ lvl: 'err', msg: `${who} has a relation (${RELATION_TYPES[r.type]}) to a lesson row that no longer exists.` }); continue; }
        if (l.id > o.id) continue; // each pair once
        const pair = `${who} and ${describeLesson(s, o.id)}`; const m = sessionsOf(o);
        if (r.type === 'consecutive' && !l.flexible && !o.flexible && n !== m && !flagged(/consecutive/, [l.id, o.id])) issues.push({ lvl: 'err', msg: `${pair} must be in consecutive periods but have ${n} and ${m} sessions — consecutive rows need the same number of sessions.` });
        if ((r.type === 'differentDays' || (r.type === 'daysApart' && r.min >= 1)) && n + m > D) issues.push({ lvl: 'err', msg: `${pair} must be on different days but have ${n} + ${m} sessions and the week has only ${D} days.` });
        if (r.type === 'daysApart' && r.max && r.max < r.min) issues.push({ lvl: 'err', msg: `${pair}: days apart max (${r.max}) is below min (${r.min}).` });
      }
    });
    const signature = (l) => (l.flexible ? `flexible ${l.flexible.total} (${l.flexible.min}–${l.flexible.max})` : lengthsText([...l.lengths].sort((a, b) => b - a)));
    for (const tag in byTag) {
      const rows = byTag[tag];
      if (new Set(rows.map(signature)).size > 1 && !flagged(/length|distribution/, rows.map((l) => l.id))) issues.push({ lvl: 'err', msg: `${rows.map((l) => describeLesson(s, l.id)).join(' & ')} are in parallel group “${byTag[tag][0].parallel.trim()}” but have different distributions (${rows.map(signature).join(' vs ')}).` });
    }
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
    uid, esc, PALETTE, teacherDefaults, WEIGHT_LABELS, PERIOD_TYPES, RELATION_TYPES,
    emptyState, sampleState, migrate, find,
    unitBlockReason, PIN_KINDS, pinSessions, pinName, pinAt, setPin, dropDeadPins, pinIssues,
    lessonDefaults, newLesson, homeroomOf, applyHomeroom, gradeOf, classSubjectPeriods, deriveCurriculum, curriculumGaps, curriculumSubjects, applyCurriculum, missingLessons, parseLengths, canPartition, partition, isLengths, sessionsOf, periodsOf, lengthsText, flexibleOf,
    dropDeadRelations, symmetrizeRelations, addRelation, removeRelation, removeLesson,
    periodType, isTeachingPeriod, teachingPeriods, generalBlocked, dutyKind, slotDisabled, selectableKeys, cellsOf,
    availableSlots, dutySlots, workload, usesDispreferred, pruneDeadKeys, prunePlacements,
    describeLesson, describeUnit, validate,
  };
})();
