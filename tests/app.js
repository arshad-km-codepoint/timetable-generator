// Model (UI-layer data) unit tests: migration defaults, validation of period types and break
// duties, slot arithmetic, the moved-lesson soft-hit check and pruning of dead slot keys.
// Usage (from the app folder): node tests/app.js
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');

const ctx = { window: {}, performance, console };
vm.createContext(ctx);
for (const f of ['solver.js', 'model.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
const M = ctx.window.Model;
const { Engine } = ctx.window.Timetable;

// ---------- helpers ----------
const clone = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const id = (p) => `${p}${(++seq).toString(36)}`;
const TYPES = { t: 'teaching', b: 'break', l: 'lunch' };
// Minimal school: `periods` typed by letter ('ttbtt'), one day unless `days` is given.
function school(periods, days = 1) {
  const s = M.emptyState();
  s.settings.days = Array.from({ length: days }, (_, i) => `Day ${i + 1}`);
  s.settings.periods = periods.split('').map((c, i) => ({ label: String(i + 1), start: '', end: '', type: TYPES[c] }));
  s.settings.attempts = 1;
  return s;
}
const add = {
  subject: (s, name = 'Subject') => { const x = { id: id('s'), name, code: name.slice(0, 3).toUpperCase(), color: '#2f6fdb' }; s.subjects.push(x); return x; },
  teacher: (s, name = 'Teacher', extra = {}) => { const x = { id: id('t'), name, code: name.slice(0, 3).toUpperCase(), unavailable: [], dispreferred: [], maxPerDay: 0, minPerDay: 0, ...extra }; s.teachers.push(x); return x; },
  cls: (s, name = 'Class') => { const x = { id: id('c'), name, unavailable: [], dispreferred: [] }; s.classes.push(x); return x; },
  lesson: (s, subj, teacher, classes, sessions, length = 1, extra = {}) => {
    const x = { id: id('l'), subjectId: subj.id, teacherId: teacher.id, classIds: classes.map((c) => c.id), sessions, length, room: '', maxOnePerDay: false, parallel: '', allowBreakInside: false, ...extra };
    s.lessons.push(x); return x;
  },
  duty: (s, name, assignments, extra = {}) => {
    const x = { id: id('d'), name, kind: 'teaching', maxPerSlot: 1, allowed: [], assignments: assignments.map(([t, hours]) => ({ teacherId: t.id, hours })), ...extra };
    s.duties.push(x); return x;
  },
};
const msgs = (s) => M.validate(s).issues.map((i) => `${i.lvl}: ${i.msg}`);
const hasMsg = (s, re) => msgs(s).some((m) => re.test(m));

// ---------- harness ----------
// Model objects come from another vm realm, so compare by value (JSON) rather than by prototype.
const eq = (a, b, msg) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), msg);
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${(e && e.message || String(e)).split('\n').join('\n       ')}`); }
}

// ---------- (a) migration ----------
check('(a) migrate() of a pre-1.2 file adds every default and keeps the rest', () => {
  const old = {
    settings: { name: 'Old School', days: ['Mon', 'Tue'], periods: [{ label: '1', start: '08:00', end: '08:45' }, { label: '2', start: '08:50', end: '09:35' }], weights: { classGap: 9 }, attempts: 2 },
    teachers: [{ id: 't1', name: 'A', code: 'A', unavailable: ['0-1'], maxPerDay: 4, minPerDay: 1 }],
    classes: [{ id: 'c1', name: '7A' }], rooms: [{ id: 'r1', name: 'R1', type: 'Classroom' }],
    subjects: [{ id: 's1', name: 'Maths', code: 'MAT', color: '#000' }],
    lessons: [{ id: 'l1', subjectId: 's1', teacherId: 't1', classIds: ['c1'], sessions: 2, length: 1, room: 'r1', maxOnePerDay: true, parallel: '' }],
    duties: [{ id: 'd1', name: 'Library', maxPerSlot: 2, allowed: ['0-0'], assignments: [{ teacherId: 't1', hours: 1 }] }],
    timetable: { placements: [{ unitId: 'l1#0', day: 0, period: 0, len: 1, roomId: 'r1', locked: true }] },
  };
  const s = M.migrate(clone(old));
  eq(s.settings.periods.map((p) => p.type), ['teaching', 'teaching']);
  eq(s.settings.blocked, []);
  eq(s.settings.options, { countMiddayGap: false });
  assert.strictEqual(s.settings.weights.classGap, 9, 'explicit weight kept');
  assert.strictEqual(typeof s.settings.weights.teacherGap, 'number', 'missing weights filled from defaults');
  assert.strictEqual(s.settings.attempts, 2);
  assert.strictEqual(s.settings.name, 'Old School');
  eq(s.teachers[0].unavailable, ['0-1']);
  eq(s.teachers[0].dispreferred, []);
  assert.strictEqual(s.teachers[0].maxPerDay, 4);
  eq(s.classes[0].unavailable, []);
  eq(s.rooms[0].dispreferred, []);
  assert.strictEqual(s.lessons[0].allowBreakInside, false);
  assert.strictEqual(s.lessons[0].maxOnePerDay, true);
  assert.strictEqual(s.duties[0].kind, 'teaching');
  eq(s.duties[0].allowed, ['0-0']);
  assert.strictEqual(s.duties[0].maxPerSlot, 2);
  eq(s.meetings, []);
  eq(s.timetable.placements[0].rooms, ['r1'], 'v1 roomId becomes rooms[]');
  assert.strictEqual(s.timetable.placements[0].locked, true);
  // A current file passes through unchanged.
  const cur = M.sampleState();
  eq(M.migrate(clone(cur)), cur);
});

// ---------- (b) validation ----------
check('(b) validate(sampleState()) reports no issues', () => {
  eq(msgs(M.sampleState()), []);
});
check('(b) a break duty without any break period is an error', () => {
  const s = M.sampleState();
  assert.ok(s.duties.some((d) => d.kind === 'break'));
  s.settings.periods.forEach((p) => { if (p.type === 'break') p.type = 'lunch'; });
  assert.ok(hasMsg(s, /err: Duty “Playground supervision” is break supervision but no period is typed “Break”/), msgs(s).join('\n'));
});
check('(b) a double with no two consecutive teaching periods is an error unless it may straddle the break', () => {
  const s = school('tbtbt');
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s);
  const l = add.lesson(s, subj, t, [c], 1, 2);
  assert.ok(hasMsg(s, /err: .*needs 2 consecutive teaching periods but no day has that many in a row/), msgs(s).join('\n'));
  l.allowBreakInside = true;
  assert.ok(!hasMsg(s, /consecutive teaching periods/), msgs(s).join('\n'));
  // A triple needs three teaching periods in a row; two runs of two are not enough.
  const s2 = school('ttbtt');
  add.lesson(s2, add.subject(s2), add.teacher(s2), [add.cls(s2)], 1, 3);
  assert.ok(hasMsg(s2, /err: .*needs 3 consecutive teaching periods/), msgs(s2).join('\n'));
});

// ---------- (c) slot arithmetic ----------
check('(c) selectableKeys(\'break\') excludes teaching, lunch and general-blocked keys', () => {
  const s = school('tbtlt', 2);
  s.settings.blocked = ['1-1', '0-0'];
  eq(M.selectableKeys(s, 'break'), ['0-1']);
  eq(M.selectableKeys(s, 'teaching'), ['0-2', '0-4', '1-0', '1-2', '1-4']);
  eq(M.selectableKeys(s, 'teaching', { general: false }), ['0-0', '0-2', '0-4', '1-0', '1-2', '1-4']);
  assert.strictEqual(M.slotDisabled(s, '0-3', 'break'), 'Lunch period — break supervision happens only in break periods');
  assert.strictEqual(M.slotDisabled(s, '1-1', 'break'), 'Blocked for everyone in the general template');
  assert.strictEqual(M.slotDisabled(s, '0-1', 'teaching'), 'Break period — nothing is scheduled here');
  assert.strictEqual(M.slotDisabled(s, '0-1', 'break'), '');
  assert.strictEqual(M.slotDisabled(s, '5-0', 'teaching'), 'Outside the week');
  assert.strictEqual(M.teachingPeriods(s), 3);
});
check('(c) dutySlots and availableSlots ignore keys of the wrong kind', () => {
  const s = school('tbtlt', 2);
  const t = add.teacher(s, 'T', { unavailable: ['0-0', '0-1', '1-3'] });
  const brk = add.duty(s, 'Yard', [[t, 1]], { kind: 'break', allowed: ['0-1', '0-0', '0-3'] });
  const lib = add.duty(s, 'Library', [[t, 1]], { allowed: ['0-0', '0-1', '1-4'] });
  const any = add.duty(s, 'Corridor', [[t, 1]], { kind: 'break' });
  assert.strictEqual(M.dutySlots(s, brk), 1, 'only the break key counts');
  assert.strictEqual(M.dutySlots(s, lib), 2, 'break key dropped from a teaching duty');
  assert.strictEqual(M.dutySlots(s, any), 2, 'no keys = every break slot');
  assert.strictEqual(M.availableSlots(s, t), 5, 'teaching slots minus ✕ (the ✕ on a break and lunch do not count)');
  assert.strictEqual(M.availableSlots(s, t, 'break'), 1);
  s.settings.blocked = ['0-2'];
  assert.strictEqual(M.availableSlots(s, t), 4, 'general template removes a slot');
  assert.strictEqual(M.dutySlots(s, lib), 2);
});

// ---------- (d) soft-hit regression ----------
check('(d) usesDispreferred is false for a straddling double with no non-preferred cells', () => {
  const s = school('ttbtt');
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s);
  add.lesson(s, subj, t, [c], 1, 2, { allowBreakInside: true });
  const e = new Engine(s, []);
  const u = e.units[0];
  assert.ok(u.starts.includes(1), 'may start at period 2 and straddle the break');
  e.place(0, 1, u.parts.map(() => null));
  eq([...e.pos[0].cells], [1, 3]);
  assert.strictEqual(M.usesDispreferred(e, 0), false);
  // The old formula late × (start + len − 1) under-counted the lateness term by one period here and
  // reported a false soft hit; the real last cell is period index 3.
  assert.ok(e.unitCost(0) - e.W.late * (1 + 2 - 1) > 0, 'regression guard: the old formula is wrong for this placement');
  // And a genuine non-preferred cell is still reported.
  t.dispreferred = ['0-3'];
  const e2 = new Engine(s, []);
  e2.place(0, 1, u.parts.map(() => null));
  assert.strictEqual(M.usesDispreferred(e2, 0), true);
  const e3 = new Engine(s, []);
  assert.strictEqual(M.usesDispreferred(e3, 0), false, 'unplaced unit');
});

// ---------- (e) pruning ----------
check('(e) pruneDeadKeys removes keys on a period turned into a break and keeps all others', () => {
  const s = M.sampleState();
  assert.strictEqual(M.pruneDeadKeys(s), 0, 'no-op on a clean file');
  const before = clone(s);
  eq(s, before);
  const m2 = s.teachers.find((t) => t.name === 'Brian Ochieng'), ar = s.teachers.find((t) => t.name === 'Isabel Costa');
  m2.unavailable.push('0-4', '3-4');
  assert.ok(ar.unavailable.includes('0-4'), 'the sample has a ✕ on Monday period 4 already');
  s.settings.blocked = ['0-4', '1-0'];
  s.meetings[1].allowed = ['2-4', '2-5'];
  const library = s.duties.find((d) => d.kind === 'teaching'), yard = s.duties.find((d) => d.kind === 'break');
  yard.allowed = ['0-3', '1-3'];
  s.settings.periods[4].type = 'break';
  const n = M.pruneDeadKeys(s);
  assert.strictEqual(n, 2 + 1 + 1 + 1 + 5, 'Brian 2, Isabel 1, blocked 1, meeting 1, library 5');
  eq(m2.unavailable, ['4-7', '4-8']);
  eq(ar.unavailable, ['0-0', '0-1', '0-2', '0-5', '0-7', '0-8']);
  eq(s.settings.blocked, ['1-0']);
  eq(s.meetings[1].allowed, ['2-5']);
  eq(library.allowed, s.settings.days.map((_, d) => `${d}-5`));
  eq(yard.allowed, ['0-3', '1-3'], 'break-duty keys on break periods survive');
  eq(s.meetings[0].allowed, before.meetings[0].allowed);
  eq(s.teachers.map((t) => t.dispreferred), before.teachers.map((t) => t.dispreferred));
  // Turning that break back into a teaching period makes the yard keys on it dead instead.
  s.settings.periods[4].type = 'teaching';
  yard.allowed.push('0-4');
  assert.strictEqual(M.pruneDeadKeys(s), 1);
  eq(yard.allowed, ['0-3', '1-3']);
});
check('(e) prunePlacements drops placements the engine cannot restore and reports how many', () => {
  const s = school('ttttt');
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s);
  add.lesson(s, subj, t, [c], 2, 1);
  const e = new Engine(s, []);
  e.place(0, 1, [null]); e.place(1, 3, [null]);
  s.timetable.placements = e.placements();
  assert.strictEqual(s.timetable.placements.length, 2);
  assert.strictEqual(M.prunePlacements(s), 0, 'nothing stale yet');
  s.settings.periods[3].type = 'break';
  assert.strictEqual(M.prunePlacements(s), 1);
  eq(s.timetable.placements.map((p) => p.period), [1]);
  s.timetable.placements = [];
  assert.strictEqual(M.prunePlacements(s), 0, 'empty is a no-op');
});

console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
