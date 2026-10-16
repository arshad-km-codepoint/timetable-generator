// Real-world timetable scenarios + an independent overlap auditor.
// Usage (from the app folder): node tests/scenarios.js . [scenarios]   — second arg re-writes the scenario JSON files
const fs = require('fs'), vm = require('vm'), path = require('path');
const dir = process.argv[2];
const outDir = process.argv[3];

const ctx = { window: {}, performance, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'solver.js'), 'utf8'), ctx);
const { Engine, Solver } = ctx.window.Timetable;

// ---------- helpers ----------
let seq = 0;
const id = (p) => `${p}${(++seq).toString(36)}`;
const PAL = ['#2f6fdb', '#d9534f', '#1f8a4c', '#b7791f', '#7b4fd6', '#0f8f99', '#c2417e', '#5c6f2b', '#8a5a44', '#4a6fa5', '#d0682f', '#3d8f6f'];
function school(name, days, periodTimes) {
  return {
    settings: { name, days, periods: periodTimes.map(([s, e, type], i) => ({ label: type ? type[0].toUpperCase() + type.slice(1) : String(i + 1), start: s, end: e, ...(type ? { type } : {}) })), weights: { classGap: 3, teacherGap: 1, sameDay: 4, late: 0.15, dispreferred: 2, teacherMin: 2, dutyUncovered: 1 }, attempts: 2 },
    teachers: [], classes: [], rooms: [], subjects: [], lessons: [], meetings: [], duties: [],
    timetable: { placements: [], generatedAt: null, difficulty: null },
  };
}
const add = {
  subject: (s, name, code) => { const x = { id: id('s'), name, code, color: PAL[s.subjects.length % PAL.length] }; s.subjects.push(x); return x; },
  teacher: (s, name, code, extra = {}) => { const x = { id: id('t'), name, code, unavailable: [], dispreferred: [], maxPerDay: 0, minPerDay: 0, ...extra }; s.teachers.push(x); return x; },
  cls: (s, name, extra = {}) => { const x = { id: id('c'), name, unavailable: [], dispreferred: [], ...extra }; s.classes.push(x); return x; },
  room: (s, name, type) => { const x = { id: id('r'), name, type, unavailable: [], dispreferred: [] }; s.rooms.push(x); return x; },
  lesson: (s, subj, teacher, classes, sessions, length, room, parallel = '', maxOne = sessions <= s.settings.days.length) => {
    const x = { id: id('l'), subjectId: subj.id, teacherId: teacher.id, classIds: classes.map((c) => c.id), sessions, length, room, maxOnePerDay: maxOne, parallel };
    s.lessons.push(x); return x;
  },
};
const slotsWhere = (s, fn) => s.settings.days.flatMap((_, d) => s.settings.periods.map((__, p) => [d, p])).filter(([d, p]) => fn(d, p)).map(([d, p]) => `${d}-${p}`);

// ---------- Scenario A: CBSE-style secondary, grades 6-10 × divisions A-D, 6-day week ----------
function scenarioA() {
  const s = school('Scenario A — Secondary 6–10, 4 divisions, 6-day week',
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    [['07:40', '08:20'], ['08:20', '09:00'], ['09:00', '09:40'], ['10:00', '10:40'], ['10:40', '11:20'], ['11:20', '12:00'], ['12:40', '13:20'], ['13:20', '14:00']]);
  const S = {
    eng: add.subject(s, 'English', 'ENG'), math: add.subject(s, 'Mathematics', 'MAT'), sci: add.subject(s, 'Science', 'SCI'),
    sst: add.subject(s, 'Social Science', 'SST'), hin: add.subject(s, 'Hindi', 'HIN'), fre: add.subject(s, 'French', 'FRE'),
    san: add.subject(s, 'Sanskrit', 'SAN'), cs: add.subject(s, 'Computer', 'CS'), pe: add.subject(s, 'Physical Ed.', 'PE'),
    art: add.subject(s, 'Art', 'ART'), mus: add.subject(s, 'Music', 'MUS'), lib: add.subject(s, 'Library', 'LIB'),
  };
  for (let i = 1; i <= 20; i++) add.room(s, `Room ${100 + i}`, 'Classroom'); // one per division
  ['Lab 1', 'Lab 2'].forEach((n) => add.room(s, n, 'ScienceLab'));
  ['Computer Lab 1', 'Computer Lab 2'].forEach((n) => add.room(s, n, 'ComputerLab'));
  add.room(s, 'Ground', 'Sports'); add.room(s, 'Indoor Gym', 'Sports');
  add.room(s, 'Library', 'Library'); add.room(s, 'Art Room', 'Art'); add.room(s, 'Music Room', 'Music');
  add.room(s, 'Staff Room', 'Staff');
  const satAfternoon = slotsWhere(s, (d, p) => d === 5 && p >= 4);
  const grades = [6, 7, 8, 9, 10];
  const div = {};
  grades.forEach((g) => { div[g] = ['A', 'B', 'C', 'D'].map((x) => add.cls(s, `${g}${x}`, { unavailable: satAfternoon })); });
  const all = grades.flatMap((g) => div[g]);
  const T = (n, code, extra) => add.teacher(s, n, code, { maxPerDay: 6, unavailable: satAfternoon, ...extra });
  // subject teachers, each covering 4 divisions (realistic 24–28 periods/week)
  const team = (prefix, n, extra = () => ({})) => Array.from({ length: n }, (_, i) => T(`${prefix} ${i + 1}`, `${prefix.slice(0, 2).toUpperCase()}${i + 1}`, extra(i)));
  const mathT = team('Maths', 5, (i) => (i === 0 ? { unavailable: [...satAfternoon, ...slotsWhere(s, (d) => d === 0)] } : {})); // part-timer off Monday
  const engT = team('English', 5, (i) => (i === 1 ? { dispreferred: slotsWhere(s, (d, p) => p === 0) } : {}));
  const sciT = team('Science', 5);
  const sstT = team('SocialSci', 4);
  const hinT = team('Hindi', 2), freT = team('French', 2), sanT = team('Sanskrit', 2);
  const csT = team('Computer', 2), peT = team('PE', 2), artT = T('Art 1', 'AR1'), musT = T('Music 1', 'MU1'), libT = T('Librarian', 'LIB');
  all.forEach((c, i) => {
    add.lesson(s, S.math, mathT[Math.floor(i / 4)], [c], 7, 1, 'type:Classroom', '', false);
    add.lesson(s, S.eng, engT[Math.floor(i / 4)], [c], 6, 1, 'type:Classroom');
    add.lesson(s, S.sci, sciT[Math.floor(i / 4)], [c], 4, 1, 'type:Classroom');
    add.lesson(s, S.sci, sciT[Math.floor(i / 4)], [c], 1, 2, 'type:ScienceLab');
    add.lesson(s, S.sst, sstT[i % 4], [c], 5, 1, 'type:Classroom');
    add.lesson(s, S.cs, csT[i % 2], [c], 2, 1, 'type:ComputerLab');
    add.lesson(s, S.pe, peT[i % 2], [c], 2, 1, 'type:Sports');
    add.lesson(s, S.art, artT, [c], 1, 1, 'type:Art');
    add.lesson(s, S.mus, musT, [c], 1, 1, 'type:Music');
    add.lesson(s, S.lib, libT, [c], 1, 1, 'type:Library');
  });
  // Second language: each grade's 4 divisions regroup into Hindi / French / Sanskrit at the same time.
  grades.forEach((g, gi) => {
    const tag = `Gr${g} 2nd language`;
    const k = gi < 3 ? 0 : 1;
    add.lesson(s, S.hin, hinT[k], div[g], 5, 1, 'type:Classroom', tag);
    add.lesson(s, S.fre, freT[k], div[g], 5, 1, 'type:Classroom', tag);
    add.lesson(s, S.san, sanT[k], div[g], 5, 1, 'type:Classroom', tag);
  });
  s.meetings.push(
    { id: id('m'), name: 'Staff meeting', teacherIds: s.teachers.map((t) => t.id), sessions: 1, length: 1, room: 'type:Staff', allowed: slotsWhere(s, (d, p) => d < 5 && p === 7) },
    { id: id('m'), name: 'Maths department', teacherIds: mathT.map((t) => t.id), sessions: 1, length: 1, room: '', allowed: [] },
    { id: id('m'), name: 'Science department', teacherIds: sciT.map((t) => t.id), sessions: 1, length: 2, room: '', allowed: [] },
  );
  s.duties.push({
    id: id('d'), name: 'Substitution on-call', maxPerSlot: 2, allowed: slotsWhere(s, (d) => d < 5),
    assignments: [...engT, ...sstT, ...hinT, ...freT, ...sanT, ...csT, ...peT].map((t) => ({ teacherId: t.id, hours: 2 })),
  });
  // Week rules by load: the lightest teachers get a day off, the heaviest a rest rule and a presence cap.
  const load = {}; for (const l of s.lessons) load[l.teacherId] = (load[l.teacherId] || 0) + (l.lengths || []).reduce((x, y) => x + y, 0) + (l.lengths ? 0 : l.sessions * l.length);
  const byLoad = s.teachers.slice().sort((x, y) => (load[x.id] || 0) - (load[y.id] || 0)).filter((t) => load[t.id]);
  byLoad.slice(0, 6).forEach((t) => { t.freeDays = 1; });
  byLoad.slice(-6).forEach((t) => { t.maxConsecutive = 4; t.noLastFirst = true; });
  byLoad.slice(-12, -6).forEach((t) => { t.maxPresenceWeek = 40; t.presenceStrict = true; });
  return s;
}

// ---------- Scenario B: Senior secondary 11-12 with streams and option blocks ----------
// Period classes: a 15-minute break after period 3 (index 3) and an explicit lunch (index 7);
// teaching periods are indices 0-2, 4-6, 8-9.
function scenarioB() {
  const s = school('Scenario B — Grades 11–12, streams with option blocks',
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    [['08:00', '08:45'], ['08:45', '09:30'], ['09:30', '10:15'], ['10:15', '10:30', 'break'], ['10:30', '11:15'], ['11:15', '12:00'], ['12:00', '12:45'], ['12:45', '13:30', 'lunch'], ['13:30', '14:15'], ['14:15', '15:00']]);
  const sub = (n, c) => add.subject(s, n, c);
  const S = {
    eng: sub('English', 'ENG'), pe: sub('Health & PE', 'HPE'), phy: sub('Physics', 'PHY'), che: sub('Chemistry', 'CHE'), mat: sub('Mathematics', 'MAT'),
    bio: sub('Biology', 'BIO'), cs: sub('Computer Science', 'CS'), acc: sub('Accountancy', 'ACC'), bst: sub('Business Studies', 'BST'),
    eco: sub('Economics', 'ECO'), his: sub('History', 'HIS'), pol: sub('Political Science', 'POL'), geo: sub('Geography', 'GEO'),
    psy: sub('Psychology', 'PSY'), ped: sub('PE (elective)', 'PED'), ent: sub('Entrepreneurship', 'ENT'),
  };
  for (let i = 1; i <= 10; i++) add.room(s, `Room ${200 + i}`, 'Classroom');
  add.room(s, 'Physics Lab', 'PhysicsLab'); add.room(s, 'Chemistry Lab', 'ChemLab'); add.room(s, 'Biology Lab', 'BioLab');
  add.room(s, 'Computer Lab', 'ComputerLab'); add.room(s, 'Sports Hall', 'Sports'); add.room(s, 'Ground', 'Sports');
  const C = {};
  [11, 12].forEach((g) => { C[g] = { sciA: add.cls(s, `${g}-Sci A`), sciB: add.cls(s, `${g}-Sci B`), com: add.cls(s, `${g}-Commerce`), hum: add.cls(s, `${g}-Humanities`) }; });
  const T = (n, code, extra) => add.teacher(s, n, code, { maxPerDay: 6, ...extra });
  // Many teachers teach BOTH grades — the cross-grade clash test.
  const t = {
    eng1: T('Eng – Meera', 'MEE'), eng2: T('Eng – Thomas', 'THO'), pe1: T('PE – Arjun', 'ARJ'), pe2: T('PE – Sana', 'SAN'),
    phy: T('Physics – Ravi', 'RAV'), che: T('Chem – Fatima', 'FAT'), mat1: T('Maths – Ken', 'KEN'), mat2: T('Maths – Priya', 'PRI'),
    bio: T('Bio – Olu', 'OLU', { unavailable: ['4-8', '4-9'] }), cs: T('CS – Ahmed', 'AHM'), acc: T('Acc – Neha', 'NEH'), bst: T('BSt – John', 'JOH'),
    eco: T('Eco – Divya', 'DIV'), his: T('History – Li', 'LIW'), pol: T('PolSci – Omar', 'OMA', { dispreferred: ['0-0', '1-0', '2-0'] }), geo: T('Geo – Rosa', 'ROS'),
    psy: T('Psych – Ali', 'ALI'), ent: T('Entre – Kim', 'KIM'),
  };
  [11, 12].forEach((g) => {
    const c = C[g]; const all = [c.sciA, c.sciB, c.com, c.hum];
    all.forEach((x, i) => {
      add.lesson(s, S.eng, i < 2 ? t.eng1 : t.eng2, [x], 5, 1, 'type:Classroom');
      add.lesson(s, S.pe, i < 2 ? t.pe1 : t.pe2, [x], 2, 1, 'type:Sports');
    });
    // Block P (6/wk): Physics(SciA+SciB) ∥ Accountancy(Com) ∥ History(Hum)
    add.lesson(s, S.phy, t.phy, [c.sciA, c.sciB], 6, 1, 'type:Classroom', `G${g} Block P`);
    add.lesson(s, S.acc, t.acc, [c.com], 6, 1, 'type:Classroom', `G${g} Block P`);
    add.lesson(s, S.his, t.his, [c.hum], 6, 1, 'type:Classroom', `G${g} Block P`);
    // Block Q: Chemistry(Sci) ∥ Business Studies(Com) ∥ Political Science(Hum)
    add.lesson(s, S.che, t.che, [c.sciA, c.sciB], 6, 1, 'type:Classroom', `G${g} Block Q`);
    add.lesson(s, S.bst, t.bst, [c.com], 6, 1, 'type:Classroom', `G${g} Block Q`);
    add.lesson(s, S.pol, t.pol, [c.hum], 6, 1, 'type:Classroom', `G${g} Block Q`);
    // Block R: Maths(SciA) ∥ Biology(SciB) ∥ Economics(Com + half of Hum) ∥ Geography(other half of Hum) — Hum is split
    add.lesson(s, S.mat, g === 11 ? t.mat1 : t.mat2, [c.sciA], 6, 1, 'type:Classroom', `G${g} Block R`);
    add.lesson(s, S.bio, t.bio, [c.sciB], 6, 1, 'type:Classroom', `G${g} Block R`);
    add.lesson(s, S.eco, t.eco, [c.com, c.hum], 6, 1, 'type:Classroom', `G${g} Block R`);
    add.lesson(s, S.geo, t.geo, [c.hum], 6, 1, 'type:Classroom', `G${g} Block R`);
    // Block S (4/wk): CS(SciA+SciB) ∥ Psychology(Com+Hum) ∥ PE elective(students from all four)
    add.lesson(s, S.cs, t.cs, [c.sciA, c.sciB], 4, 1, 'type:ComputerLab', `G${g} Block S`);
    add.lesson(s, S.psy, t.psy, [c.com, c.hum], 4, 1, 'type:Classroom', `G${g} Block S`);
    add.lesson(s, S.ped, g === 11 ? t.pe2 : t.pe1, all, 4, 1, 'type:Sports', `G${g} Block S`);
    // Practicals (double periods in specialist labs); physics practicals may run across the break
    // and never on a day with physics theory (daysApart ≥ 1 from the Block P physics row).
    const phyTheory = s.lessons.find((l) => l.subjectId === S.phy.id && l.parallel === `G${g} Block P`);
    for (const x of [c.sciA, c.sciB]) {
      const pr = add.lesson(s, S.phy, t.phy, [x], 1, 2, 'type:PhysicsLab');
      pr.allowBreakInside = true;
      pr.relations = [{ type: 'daysApart', lessonId: phyTheory.id, min: 1 }];
    }
    add.lesson(s, S.che, t.che, [c.sciA], 1, 2, 'type:ChemLab'); add.lesson(s, S.che, t.che, [c.sciB], 1, 2, 'type:ChemLab');
    add.lesson(s, S.bio, t.bio, [c.sciB], 1, 2, 'type:BioLab');
    // Entrepreneurship prefers Room 201 (both grades, so one of them sometimes takes another classroom).
    add.lesson(s, S.ent, t.ent, [c.com], 3, 1, s.rooms[0].id).roomAlt = 'type:Classroom';
  });
  s.meetings.push({ id: id('m'), name: 'Senior-school team', teacherIds: s.teachers.map((x) => x.id), sessions: 1, length: 1, room: '', allowed: slotsWhere(s, (d, p) => p >= 8) });
  s.duties.push({ id: id('d'), name: 'Lab safety supervision', maxPerSlot: 1, allowed: slotsWhere(s, (d, p) => p >= 8), assignments: [t.cs, t.psy, t.ent, t.geo, t.acc].map((x) => ({ teacherId: x.id, hours: 2 })) });
  // Break supervision: 5 break periods × 2 teachers.
  s.duties.push({ id: id('d'), kind: 'break', name: 'Playground duty', maxPerSlot: 2, allowed: [], assignments: [t.eng1, t.eng2, t.pe1, t.pe2, t.his].map((x) => ({ teacherId: x.id, hours: 2 })) });
  return s;
}

// ---------- Scenario C: Primary 1-5 × 3 divisions, class teachers + specialists, nearly full week ----------
function scenarioC() {
  const s = school('Scenario C — Primary 1–5, class teachers + specialists',
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    [['07:45', '08:25'], ['08:25', '09:05'], ['09:05', '09:45'], ['10:05', '10:45'], ['10:45', '11:25'], ['11:45', '12:25'], ['12:25', '13:05']]);
  const sub = (n, c) => add.subject(s, n, c);
  const S = { eng: sub('English', 'ENG'), mat: sub('Maths', 'MAT'), evs: sub('EVS', 'EVS'), ara: sub('Arabic', 'ARA'), pe: sub('PE', 'PE'), mus: sub('Music', 'MUS'), art: sub('Art', 'ART'), ict: sub('ICT', 'ICT'), mor: sub('Moral Ed.', 'MOR'), lib: sub('Library', 'LIB') };
  for (let i = 1; i <= 15; i++) add.room(s, `Class ${i}`, 'Homeroom');
  add.room(s, 'Sports Hall', 'Sports'); add.room(s, 'Playground', 'Sports'); add.room(s, 'Music Room', 'Music'); add.room(s, 'Art Room', 'Art'); add.room(s, 'ICT Lab', 'ICT'); add.room(s, 'Library', 'Library');
  const assembly = ['0-0'];
  const cls = []; const ct = [];
  for (let g = 1; g <= 5; g++) for (const d of ['A', 'B', 'C']) {
    const c = add.cls(s, `${g}${d}`, { unavailable: assembly });
    cls.push(c);
    ct.push(add.teacher(s, `Class teacher ${g}${d}`, `CT${g}${d}`, { unavailable: assembly }));
  }
  const spec = (n, code, extra) => add.teacher(s, n, code, { maxPerDay: 7, ...extra });
  const ara = [spec('Arabic 1', 'AR1'), spec('Arabic 2', 'AR2')]; const pe = [spec('PE 1', 'PE1'), spec('PE 2', 'PE2')];
  const mus = spec('Music', 'MUS'), art = spec('Art', 'ART', { unavailable: ['4-5', '4-6'] }), ict = spec('ICT', 'ICT'), mor = spec('Moral Ed.', 'MOR'), lib = spec('Librarian', 'LIB');
  // Week rules on the specialists: a day off (the librarian), a rest rule, a strict presence cap, an overnight rule.
  lib.freeDays = 2; pe[0].maxConsecutive = 3; lib.maxPresenceDay = 6; lib.presenceStrict = true; mor.noLastFirst = true;
  cls.forEach((c, i) => {
    const t = ct[i]; const grade = Math.floor(i / 3) + 1;
    // homeroom: the class teacher's own room
    const home = s.rooms[i].id;
    // English: one double and four singles; Maths: 6 periods in blocks of 1–2, distribution chosen by the engine.
    add.lesson(s, S.eng, t, [c], 5, 1, home, '', false).lengths = [2, 1, 1, 1, 1];
    add.lesson(s, S.mat, t, [c], 6, 1, home, '', false).flexible = { total: 6, min: 1, max: 2 };
    const evs = add.lesson(s, S.evs, t, [c], 5, 1, home);
    add.lesson(s, S.ara, ara[i % 2], [c], 4, 1, home);
    const pel = add.lesson(s, S.pe, pe[i % 2], [c], 3, 1, 'type:Sports');
    pel.sameRoom = true; // all PE of a class in the same hall/ground
    const musl = add.lesson(s, S.mus, mus, [c], 2, 1, 'type:Music');
    const artl = add.lesson(s, S.art, art, [c], 2, 1, 'type:Art');
    artl.relations = [{ type: 'nonConsecutive', lessonId: musl.id }]; // no Art straight after Music or vice versa
    const ictl = add.lesson(s, S.ict, ict, [c], 2, 1, 'type:ICT');
    pel.relations = [{ type: 'differentDays', lessonId: ictl.id }]; // PE and ICT never on the same day
    const morl = add.lesson(s, S.mor, mor, [c], 2, 1, home);
    add.lesson(s, S.lib, lib, [c], 1, 1, 'type:Library');
    if (grade === 3) { // Grade 3: EVS not first/last period, and Moral Ed. (2 sessions) spread over non-adjacent days
      evs.penalizeEnds = true; evs.avoidConsecutiveDays = true;
      morl.avoidConsecutiveDays = true;
    }
  });
  // Grade-level planning: the 3 class teachers of a grade together — only possible when all 3 divisions are with specialists.
  for (let g = 0; g < 5; g++) s.meetings.push({ id: id('m'), name: `Grade ${g + 1} planning`, teacherIds: ct.slice(g * 3, g * 3 + 3).map((x) => x.id), sessions: 1, length: 1, room: '', allowed: [] });
  s.duties.push({ id: id('d'), name: 'Sick-bay cover', maxPerSlot: 1, allowed: [], assignments: [mus, art, ict, mor, lib, ...ara].map((x) => ({ teacherId: x.id, hours: 3 })) });
  return s;
}

// ---------- Scenario D: deliberately impossible pieces (must be reported, never overlapped) ----------
function scenarioD() {
  const s = scenarioC();
  s.settings.name = 'Scenario D — Primary with impossible demands';
  const music = s.teachers.find((x) => x.name === 'Music');
  music.unavailable = slotsWhere(s, (d) => d >= 3); // only 3 days → 21 slots for 30 periods
  const sb = s.duties[0]; sb.assignments.push(...s.teachers.slice(0, 5).map((x) => ({ teacherId: x.id, hours: 4 }))); // over capacity
  s.meetings.push({ id: id('m'), name: 'Impossible all-hands (period 1 Monday = assembly)', teacherIds: s.teachers.map((x) => x.id), sessions: 1, length: 1, room: '', allowed: ['0-0'] });
  return s;
}

// ---------- independent auditor (does not use the engine) ----------
// `chosen` (lessonId → lengths) is only used to count the expected sessions of flexible rows.
function audit(s, placements, chosen = {}) {
  const errs = []; const err = (m) => errs.push(m);
  const P = s.settings.periods.length, D = s.settings.days.length;
  const by = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
  const L = by(s.lessons), T = by(s.teachers), C = by(s.classes), R = by(s.rooms), M = by(s.meetings), DU = by(s.duties);
  const grid = {}; // entity@slot -> Set(unitId)
  const book = (ent, d, p, unit) => { const k = `${ent}@${d}-${p}`; (grid[k] ||= new Set()).add(unit); };
  const seenUnits = new Set();
  const placedPerLesson = {}, perDay = {}, tTeach = {};
  // Session lengths a row allows: its lengths list, or (legacy) sessions × length; null = flexible.
  const lensOf = (l) => (l.flexible ? null : Array.isArray(l.lengths) ? l.lengths : Array.from({ length: l.sessions }, () => l.length));
  const placedLens = {};   // lessonId -> [len]
  const roomsUsed = {};    // lessonId -> Set(roomId)
  const sessionsOf = {};   // lessonId -> [{ k, day, first, last }] teaching cells, for relations
  const straddleBreaks = new Set(); // 'teacher@d-p' break periods held inside a straddling lesson
  const breakDuties = []; // [teacherId, d, p, unitId]
  const parallelSlot = {}; // tag|session -> slot
  // Period classes and the general template (settings.blocked), read straight from the data.
  const ptype = (p) => (s.settings.periods[p] && s.settings.periods[p].type) || 'teaching';
  const general = new Set(s.settings.blocked || []);
  // Cells of a lesson/meeting placement: `len` consecutive periods, or — when the unit may
  // straddle a break — the next `len` teaching periods with break periods skipped (never lunch).
  const cellsOf = (pl, allowBreak) => {
    const out = []; let p = pl.period;
    while (out.length < pl.len && p < P) { if (!(allowBreak && ptype(p) === 'break')) out.push([pl.day, p]); p++; }
    if (out.length < pl.len) err(`out of bounds ${pl.unitId}`);
    return out;
  };
  const checkTeachingCells = (cells, what) => {
    for (const [d, p] of cells) {
      if (ptype(p) !== 'teaching') err(`${what} on ${ptype(p)} period ${d}-${p}`);
      if (general.has(`${d}-${p}`)) err(`${what} on general-blocked period ${d}-${p}`);
    }
  };
  for (const pl of placements) {
    if (seenUnits.has(pl.unitId)) err(`duplicate placement ${pl.unitId}`);
    seenUnits.add(pl.unitId);
    if (pl.day < 0 || pl.day >= D || pl.period < 0 || pl.period >= P) err(`out of bounds ${pl.unitId}`);
    const base = pl.unitId.split('#')[0];
    if (base.startsWith('m:')) {
      const m = M[base.slice(2)]; if (!m) { err('unknown meeting'); continue; }
      const cells = cellsOf(pl, false);
      checkTeachingCells(cells, `meeting ${m.name}`);
      for (const [d, p] of cells) {
        if (m.allowed.length && !m.allowed.includes(`${d}-${p}`)) err(`meeting ${m.name} outside allowed period`);
        for (const t of new Set(m.teacherIds)) { book('T' + t, d, p, pl.unitId); if (T[t].unavailable.includes(`${d}-${p}`)) err(`meeting member prohibited`); }
        if (pl.rooms[0]) book('R' + pl.rooms[0], d, p, pl.unitId);
      }
      continue;
    }
    if (base.startsWith('d:')) {
      const [, did, tid] = base.split(':'); const svc = DU[did];
      const [d, p] = [pl.day, pl.period];
      if (pl.len !== 1) err(`duty ${svc.name} longer than one period`);
      if (svc.allowed.length && !svc.allowed.includes(`${d}-${p}`)) err('duty outside duty periods');
      if (svc.kind === 'break') { if (ptype(p) !== 'break') err(`break duty ${svc.name} on ${ptype(p)} period ${d}-${p}`); breakDuties.push([tid, d, p, pl.unitId]); }
      else checkTeachingCells([[d, p]], `duty ${svc.name}`);
      book('T' + tid, d, p, pl.unitId); book('S' + did, d, p, pl.unitId);
      if (T[tid].unavailable.includes(`${d}-${p}`)) err('duty teacher prohibited');
      continue;
    }
    const ids = base.split('+'); const session = pl.unitId.split('#')[1];
    if (pl.rooms.length !== ids.length) err(`room count mismatch ${pl.unitId}`);
    const unitRooms = new Set(); const unitTeachers = new Set();
    ids.forEach((lid, k) => {
      const l = L[lid]; if (!l) { err('unknown lesson'); return; }
      const lens = lensOf(l);
      if (lens ? !lens.includes(pl.len) : !(pl.len >= l.flexible.min && pl.len <= l.flexible.max)) err(`wrong length ${pl.len} for ${lid}`);
      (placedLens[lid] ||= []).push(pl.len);
      // A lesson that may not straddle a break must occupy consecutive teaching periods.
      const cells = cellsOf(pl, !!l.allowBreakInside);
      if (!cells.length) return; // already reported as out of bounds
      checkTeachingCells(cells, `lesson ${lid}`);
      // A break skipped inside a straddling lesson still holds the teacher, the classes and the
      // room (hard rule: no break duty inside one's own double), so book it like a cell.
      for (let p = cells[0][1] + 1; p < cells[cells.length - 1][1]; p++) {
        if (cells.some(([, q]) => q === p)) continue;
        book('T' + l.teacherId, pl.day, p, pl.unitId); straddleBreaks.add(`${l.teacherId}@${pl.day}-${p}`);
        for (const c of l.classIds) book('C' + c, pl.day, p, pl.unitId);
        if (pl.rooms[k]) book('R' + pl.rooms[k], pl.day, p, pl.unitId);
      }
      placedPerLesson[lid] = (placedPerLesson[lid] || 0) + 1;
      if (l.parallel) {
        const key = `${l.parallel}|${session}`;
        if (parallelSlot[key] && parallelSlot[key] !== `${pl.day}-${pl.period}`) err(`parallel group ${l.parallel} split across times`);
        parallelSlot[key] = `${pl.day}-${pl.period}`;
      }
      if (unitTeachers.has(l.teacherId)) err('teacher twice in one parallel unit'); unitTeachers.add(l.teacherId);
      const room = pl.rooms[k];
      if (l.room) {
        if (!room) err(`missing room ${lid}`);
        else {
          const prefOk = l.room.startsWith('type:') ? R[room]?.type === l.room.slice(5) : room === l.room;
          const altOk = !!l.roomAlt && l.roomAlt.startsWith('type:') && R[room]?.type === l.roomAlt.slice(5);
          if (!prefOk && !altOk) err(`wrong room for ${lid}`);
          (roomsUsed[lid] ||= new Set()).add(room);
        }
        if (unitRooms.has(room)) err('same room twice in one parallel unit'); unitRooms.add(room);
      }
      (sessionsOf[lid] ||= []).push({ k: Number(session), day: pl.day, first: cells[0][1], last: cells[cells.length - 1][1] });
      const dk = `${lid}:${pl.day}`; perDay[dk] = (perDay[dk] || 0) + 1;
      if (l.maxOnePerDay && perDay[dk] > 1) err(`1/day broken for ${lid}`);
      for (const [d, p] of cells) {
        book('T' + l.teacherId, d, p, pl.unitId);
        if (T[l.teacherId].unavailable.includes(`${d}-${p}`)) err('teacher prohibited period used');
        tTeach[`${l.teacherId}:${d}`] = (tTeach[`${l.teacherId}:${d}`] || 0) + 1;
        for (const c of l.classIds) { book('C' + c, d, p, pl.unitId); if (C[c].unavailable.includes(`${d}-${p}`)) err('class prohibited period used'); }
        if (room) { book('R' + room, d, p, pl.unitId); if (R[room].unavailable.includes(`${d}-${p}`)) err('room prohibited'); }
      }
    });
  }
  for (const [tid, d, p, unit] of breakDuties) if (straddleBreaks.has(`${tid}@${d}-${p}`)) err(`break duty ${unit} inside the teacher's own straddling lesson at ${d}-${p}`);
  // overlaps: any teacher/class/room with two different units in one period; duty capacity
  let overlaps = 0;
  for (const k in grid) {
    const n = grid[k].size;
    if (k.startsWith('S')) { const did = k.slice(1).split('@')[0]; if (n > (DU[did].maxPerSlot || 1)) err(`duty over capacity ${k}`); continue; }
    if (n > 1) { overlaps++; err(`OVERLAP ${k}: ${[...grid[k]].join(', ')}`); }
  }
  for (const k in tTeach) { const [t] = k.split(':'); if (T[t].maxPerDay && tTeach[k] > T[t].maxPerDay) err(`max/day exceeded ${T[t].name}`); }
  // Teacher week rules, read straight from the placements: lesson days off (hard) and strict presence (lessons only).
  for (const t of s.teachers) {
    const worked = new Set(Object.keys(tTeach).filter((k) => k.startsWith(t.id + ':')).map((k) => Number(k.split(':')[1])));
    if (t.freeDays) {
      const open = [...Array(D).keys()].filter((d) => [...Array(P).keys()].some((p) => ptype(p) === 'teaching' && !general.has(`${d}-${p}`) && !t.unavailable.includes(`${d}-${p}`)));
      if (worked.size > Math.max(0, open.length - t.freeDays)) err(`${t.name} works ${worked.size} of ${open.length} days but needs ${t.freeDays} free`);
    }
    if (t.presenceStrict && (t.maxPresenceDay || t.maxPresenceWeek)) {
      let week = 0;
      for (let d = 0; d < D; d++) {
        const held = [...Array(P).keys()].filter((p) => ptype(p) === 'teaching' && grid[`T${t.id}@${d}-${p}`]);
        if (!held.length) continue;
        let pres = 0; for (let p = held[0]; p <= held[held.length - 1]; p++) if (ptype(p) === 'teaching') pres++;
        week += pres;
        if (t.maxPresenceDay && pres > t.maxPresenceDay) err(`${t.name} is present ${pres} periods on day ${d}, limit ${t.maxPresenceDay}`);
      }
      if (t.maxPresenceWeek && week > t.maxPresenceWeek) err(`${t.name} is present ${week} periods in the week, limit ${t.maxPresenceWeek}`);
    }
  }
  // Lengths: the placed multiset never exceeds the row's lengths; flexible rows stay within total.
  for (const lid in placedLens) {
    const l = L[lid]; const lens = lensOf(l); const got = placedLens[lid];
    if (lens) {
      const left = lens.slice();
      for (const n of got) { const i = left.indexOf(n); if (i < 0) err(`too many sessions of length ${n} for ${lid}`); else left.splice(i, 1); }
    } else if (got.reduce((a, b) => a + b, 0) > l.flexible.total) err(`flexible row ${lid} exceeds its total`);
  }
  for (const lid in roomsUsed) if (L[lid].sameRoom && roomsUsed[lid].size > 1) err(`sameRoom row ${lid} uses ${roomsUsed[lid].size} rooms`);
  // Relations, checked from both rows' point of view. Teaching order skips breaks, not lunch.
  const nextTeaching = (p) => { let q = p + 1; while (q < P && ptype(q) === 'break') q++; return q < P && ptype(q) === 'teaching' ? q : -1; };
  const adjacent = (a, b) => a.day === b.day && (nextTeaching(a.last) === b.first || nextTeaching(b.last) === a.first);
  for (const l of s.lessons) {
    for (const r of l.relations || []) {
      const o = L[r.lessonId]; if (!o || o === l) continue;
      for (const a of sessionsOf[l.id] || []) for (const b of sessionsOf[o.id] || []) {
        const what = `${r.type} ${l.id}#${a.k}/${o.id}#${b.k}`;
        if (r.type === 'differentDays' && a.day === b.day) err(`relation broken: ${what} on day ${a.day}`);
        if (r.type === 'notSameTime' && a.day === b.day && a.first <= b.last && b.first <= a.last) err(`relation broken: ${what} overlap`);
        if (r.type === 'nonConsecutive' && adjacent(a, b)) err(`relation broken: ${what} adjacent`);
        if (r.type === 'consecutive' && a.k === b.k && !adjacent(a, b)) err(`relation broken: ${what} not adjacent`);
        if (r.type === 'daysApart') {
          const diff = Math.abs(a.day - b.day);
          if (Number(r.min) > 0 && diff < Number(r.min)) err(`relation broken: ${what} only ${diff} days apart`);
          if (r.max !== '' && r.max !== null && r.max !== undefined && Number.isFinite(Number(r.max)) && diff > Number(r.max)) err(`relation broken: ${what} ${diff} days apart`);
        }
      }
    }
  }
  // coverage summary: sessions (flexible rows by the engine's chosen distribution) and periods
  const expectedLessons = s.lessons.reduce((a, l) => a + (lensOf(l) ? lensOf(l).length : (chosen[l.id] || placedLens[l.id] || []).length), 0);
  const placedLessons = Object.values(placedPerLesson).reduce((a, b) => a + b, 0);
  const expectedPeriods = s.lessons.reduce((a, l) => a + (lensOf(l) ? lensOf(l).reduce((x, y) => x + y, 0) : l.flexible.total), 0);
  const placedPeriods = Object.values(placedLens).reduce((a, ls) => a + ls.reduce((x, y) => x + y, 0), 0);
  return { errs, overlaps, expectedLessons, placedLessons, expectedPeriods, placedPeriods, cellsChecked: Object.keys(grid).length };
}

// Gaps in class days (soft) — to show quality, not correctness. Free teaching periods between
// a class's first and last lesson, counted separately before and after lunch; breaks never count.
function classGaps(s, placements) {
  const P = s.settings.periods.length; const occ = {};
  const ptype = (p) => s.settings.periods[p].type || 'teaching';
  const general = new Set(s.settings.blocked || []);
  for (const pl of placements) {
    const base = pl.unitId.split('#')[0]; if (base.startsWith('m:') || base.startsWith('d:')) continue;
    for (const lid of base.split('+')) {
      const l = s.lessons.find((x) => x.id === lid);
      const cells = []; for (let p = pl.period; p < P && cells.length < pl.len; p++) if (!(l.allowBreakInside && ptype(p) === 'break')) cells.push(p);
      for (const c of l.classIds) for (const p of cells) (occ[`${c}:${pl.day}`] ||= new Set()).add(p);
    }
  }
  let gaps = 0;
  for (const k in occ) {
    const d = Number(k.split(':')[1]);
    let seg = [];
    const segs = [];
    for (let p = 0; p < P; p++) {
      if (ptype(p) === 'lunch') { if (seg.length) segs.push(seg); seg = []; }
      else if (ptype(p) === 'teaching' && !general.has(`${d}-${p}`)) seg.push(p);
    }
    if (seg.length) segs.push(seg);
    for (const sg of segs) { const idx = sg.map((p, i) => (occ[k].has(p) ? i : -1)).filter((i) => i >= 0); if (idx.length) gaps += Math.max(...idx) - Math.min(...idx) + 1 - idx.length; }
  }
  return gaps;
}

function solve(s, keep = [], attempts = 2) {
  let best = null;
  for (let a = 0; a < attempts; a++) {
    const sv = new Solver(s, keep);
    let r; do { r = sv.run(5000); } while (r.phase !== 'done');
    const res = { placed: r.placed, total: r.total, cost: sv.e.totalCost(), placements: sv.e.placements(), sv };
    if (!best || res.placed > best.placed || (res.placed === best.placed && res.cost.cost < best.cost.cost)) best = res;
  }
  return best;
}

// Editor fuzz: random drag-moves validated exactly as the UI does; every accepted move must keep the timetable clean.
function fuzzMoves(s, placements, n = 400) {
  const e = new Engine(s, placements);
  let accepted = 0, refused = 0;
  for (let k = 0; k < n; k++) {
    const placed = e.units.filter((u, i) => e.pos[i]);
    const u = placed[Math.floor(Math.random() * placed.length)];
    const d = Math.floor(Math.random() * e.D), p = Math.floor(Math.random() * e.P); const sl = d * e.P + p;
    const old = e.pos[u.i]; e.remove(u.i);
    let ok = p + u.len <= e.P && u.starts.includes(sl);
    const base = ok ? e.baseConflicts(u.i, sl) : null;
    ok = ok && base && base.size === 0;
    const pick = ok ? e.bestRooms(u.i, sl, new Set()) : null;
    if (ok && pick && !pick.conf.size) { e.place(u.i, sl, pick.rooms); accepted++; } else { e.place(u.i, old.s, old.rooms); refused++; }
  }
  return { placements: e.placements(), accepted, refused };
}

// ---------- run ----------
const scenarios = [['A', scenarioA()], ['B', scenarioB()], ['C', scenarioC()], ['D', scenarioD()]];
let allClean = true;
for (const [key, s] of scenarios) {
  const e0 = new Engine(s, []);
  const t0 = Date.now();
  const best = solve(s);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const chosenOf = (e) => Object.fromEntries(s.lessons.filter((l) => e.lessonGroup[l.id]).map((l) => [l.id, e.groupLengths[e.lessonGroup[l.id]]]));
  const a = audit(s, best.placements, chosenOf(best.sv.e));
  const unplaced = best.sv.e.units.filter((u, i) => !best.sv.e.pos[i]);
  const unplacedKinds = unplaced.reduce((m, u) => { m[u.kind] = (m[u.kind] || 0) + 1; return m; }, {});
  console.log(`\n=== ${s.settings.name}`);
  console.log(`  size: ${s.classes.length} classes, ${s.teachers.length} teachers, ${s.rooms.length} rooms, ${s.lessons.length} lesson rows, ${e0.units.length} units to place (${e0.problems.length} data problems)`);
  console.log(`  result: ${best.placed}/${best.total} placed in ${secs}s (2 attempts) · lesson sessions ${a.placedLessons}/${a.expectedLessons} (periods ${a.placedPeriods}/${a.expectedPeriods}) · unplaced by kind ${JSON.stringify(unplacedKinds)}`);
  console.log(`  quality: class gaps ${best.cost.classGaps} (independent count ${classGaps(s, best.placements)}), teacher gaps ${best.cost.teacherGaps}, non-preferred used ${best.cost.dispreferred}, duty uncovered ${best.cost.dutyUncovered}, day ends ${best.cost.ends}, non-preferred rooms ${best.cost.roomPref}, extra rooms ${best.cost.roomSame}, adjacent days ${best.cost.consecutiveDays}, teacher week imbalance ${best.cost.balance}, over-long runs ${best.cost.consecutive}, presence over ${best.cost.presence}, last→first ${best.cost.exclusive}`);
  console.log(`  AUDIT: ${a.overlaps} overlaps, ${a.errs.length} rule violations across ${a.cellsChecked} entity-periods${a.errs.length ? '\n   ' + [...new Set(a.errs)].slice(0, 8).join('\n   ') : ''}`);
  if (a.errs.length) allClean = false;
  if (unplaced.length) console.log(`  not placed: ${[...new Set(unplaced.map((u) => u.key))].slice(0, 6).map((k) => {
    if (k.startsWith('m:')) return 'meeting ' + s.meetings.find((m) => m.id === k.slice(2)).name;
    if (k.startsWith('d:')) return 'duty hours of ' + s.teachers.find((t) => t.id === k.split(':')[2]).name;
    return 'lesson ' + k.split('+').map((lid) => { const l = s.lessons.find((x) => x.id === lid); return `${s.subjects.find((x) => x.id === l.subjectId).name}/${l.classIds.map((c) => s.classes.find((x) => x.id === c).name).join('+')}`; }).join(' ∥ ');
  }).join('; ')}`);

  // Locks survive regeneration; then editor fuzz keeps everything clean.
  const locked = best.placements.filter((_, i) => i % 7 === 0).map((p) => ({ ...p, locked: true }));
  const re = solve(s, locked, 1);
  const lockKept = locked.every((l) => re.placements.some((p) => p.unitId === l.unitId && p.day === l.day && p.period === l.period));
  const a2 = audit(s, re.placements, chosenOf(re.sv.e));
  const fz = fuzzMoves(s, best.placements);
  const a3 = audit(s, fz.placements, chosenOf(best.sv.e));
  console.log(`  regenerate with ${locked.length} locked: locks kept=${lockKept}, placed ${re.placed}/${re.total}, audit ${a2.overlaps} overlaps/${a2.errs.length} violations`);
  console.log(`  editor fuzz: ${fz.accepted} moves accepted, ${fz.refused} refused → audit ${a3.overlaps} overlaps/${a3.errs.length} violations`);
  if (!lockKept || a2.errs.length || a3.errs.length) allClean = false;

  if (outDir) {
    s.timetable = { placements: best.placements, generatedAt: new Date().toISOString(), difficulty: best.sv.difficulty(), attempts: 2 };
    fs.writeFileSync(path.join(outDir, `scenario-${key}.json`), JSON.stringify(s, null, 2));
  }
}
console.log(`\nOVERALL: ${allClean ? 'NO overlaps or rule violations in any scenario' : 'PROBLEMS FOUND'}`);
