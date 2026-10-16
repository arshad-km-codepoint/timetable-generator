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
  // `sessions` may be a count (with `length`) or an explicit lengths array.
  lesson: (s, subj, teacher, classes, sessions, length = 1, extra = {}) => {
    const lengths = Array.isArray(sessions) ? sessions : Array(sessions).fill(length);
    const x = { ...M.lessonDefaults(), id: id('l'), subjectId: subj.id, teacherId: teacher.id, classIds: classes.map((c) => c.id), lengths, maxOnePerDay: false, ...extra };
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
// Model objects come from another vm realm, so compare by value rather than by prototype.
const eq = (a, b, msg) => assert.deepStrictEqual(structuredClone(a), structuredClone(b), msg);
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
  eq([s.teachers[0].maxConsecutive, s.teachers[0].freeDays, s.teachers[0].maxPresenceDay, s.teachers[0].maxPresenceWeek, s.teachers[0].presenceStrict, s.teachers[0].noLastFirst], [0, 0, 0, 0, false, false], 'week rules default to off');
  eq(s.classes[0].unavailable, []);
  eq(s.rooms[0].dispreferred, []);
  assert.strictEqual(s.lessons[0].allowBreakInside, false);
  assert.strictEqual(s.lessons[0].maxOnePerDay, true);
  eq(s.lessons[0].lengths, [1, 1], 'sessions × length → lengths');
  assert.ok(!('sessions' in s.lessons[0]) && !('length' in s.lessons[0]), 'legacy fields dropped');
  eq([s.lessons[0].flexible, s.lessons[0].roomAlt, s.lessons[0].sameRoom, s.lessons[0].penalizeEnds, s.lessons[0].avoidConsecutiveDays, s.lessons[0].relations], [null, '', false, false, false, []]);
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
  assert.strictEqual(n, 1 + 1 + 5, 'blocked 1, meeting 1, library 5 — teacher ✕ on the new break survive (they keep a teacher off break duty)');
  eq(m2.unavailable, ['4-7', '4-8', '0-4', '3-4']);
  eq(ar.unavailable, ['0-0', '0-1', '0-2', '0-4', '0-5', '0-7', '0-8']);
  assert.strictEqual(M.availableSlots(s, m2, 'break'), 2 * 5 - 2, 'the surviving ✕ count against break slots');
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
  // A lunch period is usable by nobody, so teacher keys on it do go; keys outside the week too.
  s.settings.periods[4].type = 'lunch';
  m2.dispreferred.push('9-0');
  assert.strictEqual(M.pruneDeadKeys(s), 4, 'Brian ✕ 0-4 and 3-4 and Isabel ✕ 0-4 on lunch, ~ 9-0 outside the week');
  eq(m2.unavailable, ['4-7', '4-8']);
  eq(m2.dispreferred, []);
  eq(ar.unavailable, ['0-0', '0-1', '0-2', '0-5', '0-7', '0-8']);
});

// ---------- (f) lesson distributions, flexible rows, relations ----------
check('(f) parseLengths accepts 221, 2,2,1 and 2 2 1; rejects empty, text, zero and too-long blocks', () => {
  eq(M.parseLengths('221'), [2, 2, 1]);
  eq(M.parseLengths('2,2,1'), [2, 2, 1]);
  eq(M.parseLengths(' 2 2  1 '), [2, 2, 1]);
  eq(M.parseLengths('2, 2 ,1'), [2, 2, 1]);
  eq(M.parseLengths('1'), [1]);
  eq(M.parseLengths('10,1'), [10, 1], 'multi-digit blocks need a separator');
  for (const bad of ['', '   ', 'abc', '2x1', '201', '0', '2-2', null, undefined]) assert.strictEqual(M.parseLengths(bad), null, `"${bad}" → null`);
  assert.strictEqual(M.parseLengths('8', 7), null, 'a block above max is rejected');
  eq(M.parseLengths('7', 7), [7]);
  assert.strictEqual(M.parseLengths('3 1', 2), null);
});
check('(f) canPartition and partition', () => {
  assert.strictEqual(M.canPartition(6, 1, 2), true);
  assert.strictEqual(M.canPartition(7, 3, 3), false);
  assert.strictEqual(M.canPartition(0, 1, 2), false);
  assert.strictEqual(M.canPartition(5, 2, 3), true);
  assert.strictEqual(M.canPartition(1, 2, 2), false);
  assert.strictEqual(M.canPartition(4, 3, 2), false, 'min above max');
  assert.strictEqual(M.canPartition('6', '2', '2'), true, 'numeric strings from inputs');
  eq(M.partition(6, 1, 2), [2, 2, 2]);
  eq(M.partition(7, 2, 3), [3, 2, 2]);
  eq(M.partition(5, 1, 5), [5]);
  assert.strictEqual(M.partition(7, 3, 3), null);
});
check('(f) migrate converts legacy rows, keeps lengths rows, mirrors relations and drops dangling ones', () => {
  const base = M.emptyState();
  base.subjects = [{ id: 's1', name: 'Maths', code: 'MAT', color: '#000' }];
  base.teachers = [{ id: 't1', name: 'A', code: 'A' }];
  base.classes = [{ id: 'c1', name: '7A' }];
  base.lessons = [
    { id: 'l1', subjectId: 's1', teacherId: 't1', classIds: ['c1'], sessions: 3, length: 2, room: '', maxOnePerDay: true, parallel: '' },
    { id: 'l2', subjectId: 's1', teacherId: 't1', classIds: ['c1'], lengths: [1, 3], sessions: 9, length: 9, room: '', relations: [{ type: 'differentDays', lessonId: 'l1' }, { type: 'daysApart', lessonId: 'l3', min: 1, max: 2 }, { type: 'bogus', lessonId: 'l1' }, { type: 'notSameTime', lessonId: 'l2' }] },
    { id: 'l3', subjectId: 's1', teacherId: 't1', classIds: ['c1'], lengths: [2], relations: [{ type: 'consecutive', lessonId: 'gone' }], flexible: { total: 5, min: 2, max: 3 }, roomAlt: 'type:Lab' },
  ];
  const s = M.migrate(clone(base));
  const [l1, l2, l3] = s.lessons;
  eq(l1.lengths, [2, 2, 2], 'sessions 3 × length 2');
  assert.ok(!('sessions' in l1) && !('length' in l1));
  eq(l2.lengths, [1, 3], 'an explicit lengths array wins over stale sessions/length');
  assert.ok(!('sessions' in l2));
  eq(l2.relations, [{ type: 'differentDays', lessonId: 'l1' }, { type: 'daysApart', lessonId: 'l3', min: 1, max: 2 }], 'unknown type and self-relation dropped');
  eq(l1.relations, [{ type: 'differentDays', lessonId: 'l2' }], 'mirrored onto the other row');
  eq(l3.relations, [{ type: 'daysApart', lessonId: 'l2', min: 1, max: 2 }], 'dangling relation dropped, mirror added with min/max');
  eq(l3.flexible, { total: 5, min: 2, max: 3 });
  eq(l3.lengths, [3, 2], 'a flexible row keeps one valid partition of its total');
  assert.strictEqual(l3.room, 'type:Lab'); assert.strictEqual(l3.roomAlt, '', 'alternatives without a room become the room');
  // Already-migrated data passes through unchanged.
  eq(M.migrate(clone(s)), s);
  const s2 = clone(s); s2.lessons[0].flexible = { total: 7, min: 3, max: 3 };
  assert.strictEqual(M.migrate(s2).lessons[0].flexible, null, 'an impossible flexible spec is dropped');
});
check('(f) removeLesson / addRelation / removeRelation keep both rows in step', () => {
  const s = school('ttttt', 5);
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s);
  const a = add.lesson(s, subj, t, [c], 2), b = add.lesson(s, subj, t, [c], 2), d = add.lesson(s, subj, t, [c], 1);
  assert.ok(M.addRelation(s, a.id, b.id, 'daysApart', { min: 1, max: '' }));
  assert.ok(M.addRelation(s, a.id, d.id, 'notSameTime'));
  assert.ok(!M.addRelation(s, a.id, a.id, 'notSameTime'), 'no self relation');
  assert.ok(!M.addRelation(s, a.id, b.id, 'bogus'));
  eq(b.relations, [{ type: 'daysApart', lessonId: a.id, min: 1, max: 0 }]);
  eq(a.relations.map((r) => r.lessonId), [b.id, d.id]);
  M.addRelation(s, b.id, a.id, 'daysApart', { min: 2, max: 3 });
  eq(a.relations.find((r) => r.type === 'daysApart'), { type: 'daysApart', lessonId: b.id, min: 2, max: 3 }, 'same type replaces');
  M.removeRelation(s, d.id, a.id, 'notSameTime');
  eq(a.relations.length, 1); eq(d.relations, []);
  M.removeLesson(s, b.id);
  eq(s.lessons.map((l) => l.id), [a.id, d.id]); eq(a.relations, []);
});
check('(f) workload uses lengths', () => {
  const s = school('ttttt', 5);
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s), c2 = add.cls(s, 'B');
  add.lesson(s, subj, t, [c], [2, 2, 1]);
  add.lesson(s, subj, add.teacher(s, 'U'), [c, c2], [3]);
  const w = M.workload(s);
  assert.strictEqual(w.t[t.id], 5); assert.strictEqual(w.c[c.id], 8); assert.strictEqual(w.c[c2.id], 3);
});
check('(f) validate: distribution and relation errors', () => {
  const mk = () => { const s = school('tttbtt', 5); return { s, subj: add.subject(s), t: add.teacher(s), c: add.cls(s) }; };
  let { s, subj, t, c } = mk();
  const l = add.lesson(s, subj, t, [c], 2);
  l.lengths = [];
  assert.ok(hasMsg(s, /err: .*has no valid distribution/), msgs(s).join('\n'));
  l.lengths = [2, 0];
  assert.ok(hasMsg(s, /err: .*has no valid distribution/));
  // A block longer than the longest run of teaching periods (3 here), unless it may straddle the break.
  l.lengths = [4, 1];
  assert.ok(hasMsg(s, /err: .*needs 4 consecutive teaching periods/), msgs(s).join('\n'));
  l.allowBreakInside = true;
  assert.ok(!hasMsg(s, /consecutive teaching periods/));
  l.lengths = [6];
  assert.ok(hasMsg(s, /err: .*block of 6 periods but a day has only 5 teaching periods/), msgs(s).join('\n'));
  // Parallel rows need the same multiset of lengths.
  ({ s, subj, t, c } = mk());
  const p1 = add.lesson(s, subj, t, [c], [2, 1], 1, { parallel: 'G' });
  const p2 = add.lesson(s, subj, add.teacher(s, 'U'), [c], [1, 2], 1, { parallel: 'g' });
  assert.ok(!hasMsg(s, /different/), msgs(s).join('\n'));
  p2.lengths = [1, 1, 1];
  const m = msgs(s).filter((x) => /different (session lengths|distributions)/.test(x));
  assert.strictEqual(m.length, 1, `reported exactly once:\n${msgs(s).join('\n')}`);
  p2.lengths = [1, 2];
  // Flexible total that no split reaches.
  p1.flexible = { total: 7, min: 3, max: 3 }; p1.parallel = ''; p2.parallel = '';
  assert.strictEqual(msgs(s).filter((x) => /cannot be split into blocks of 3–3/.test(x)).length, 1, msgs(s).join('\n'));
  p1.flexible = { total: 4, min: 2, max: 2 };
  assert.ok(!hasMsg(s, /cannot be split/), msgs(s).join('\n'));
  // Relations.
  ({ s, subj, t, c } = mk());
  const a = add.lesson(s, subj, t, [c], 3), b = add.lesson(s, subj, t, [c], 2), d = add.lesson(s, subj, t, [c], 3);
  M.addRelation(s, a.id, b.id, 'consecutive');
  assert.strictEqual(msgs(s).filter((x) => /consecutive.*(have 3 and 2 sessions|different numbers of sessions)/.test(x)).length, 1, `reported once (by the engine or the model):\n${msgs(s).join('\n')}`);
  M.removeRelation(s, a.id, b.id, 'consecutive');
  M.addRelation(s, a.id, d.id, 'differentDays');
  assert.ok(hasMsg(s, /err: .*different days but have 3 \+ 3 sessions and the week has only 5 days/), msgs(s).join('\n'));
  M.removeRelation(s, a.id, d.id, 'differentDays');
  M.addRelation(s, a.id, b.id, 'differentDays');
  assert.ok(!hasMsg(s, /different days/), msgs(s).join('\n'));
  M.addRelation(s, a.id, d.id, 'daysApart', { min: 1, max: 0 });
  assert.ok(hasMsg(s, /err: .*different days but have 3 \+ 3 sessions/), msgs(s).join('\n'));
  M.addRelation(s, a.id, d.id, 'daysApart', { min: 0, max: 2 });
  assert.ok(!hasMsg(s, /different days but have 3 \+ 3/), 'a max-only daysApart does not need distinct days');
  M.addRelation(s, a.id, d.id, 'daysApart', { min: 3, max: 2 });
  assert.ok(hasMsg(s, /err: .*days apart max \(2\) is below min \(3\)/), msgs(s).join('\n'));
  a.relations.push({ type: 'notSameTime', lessonId: 'nope' });
  assert.ok(hasMsg(s, /err: .*relation \(Not at the same time\) to a lesson row that no longer exists/), msgs(s).join('\n'));
  assert.strictEqual(M.dropDeadRelations(s), 1);
  assert.ok(!hasMsg(s, /no longer exists/));
});
check('(f) validate: same-room and alternative-room warnings', () => {
  const s = school('ttttt', 5);
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s);
  s.rooms.push({ id: 'r1', name: 'Lab', type: 'Lab', unavailable: [], dispreferred: [] }, { id: 'r2', name: 'Room', type: 'Classroom', unavailable: [], dispreferred: [] }, { id: 'r3', name: 'Room 2', type: 'Classroom', unavailable: [], dispreferred: [] });
  const l = add.lesson(s, subj, t, [c], 2, 1, { room: 'type:Lab', sameRoom: true });
  assert.ok(hasMsg(s, /warn: .*“Same room for all sessions” has no effect — there is only one Lab room/), msgs(s).join('\n'));
  l.room = 'type:Classroom';
  assert.ok(!hasMsg(s, /Same room/));
  l.room = 'type:Lab'; l.lengths = [2];
  assert.ok(!hasMsg(s, /Same room/), 'one session: nothing to keep together');
  l.sameRoom = false; l.room = ''; l.roomAlt = 'type:Lab';
  assert.ok(hasMsg(s, /warn: .*alternative rooms but no room — treated as “Any Lab”/), msgs(s).join('\n'));
  l.room = 'r2';
  assert.ok(!hasMsg(s, /warn/), msgs(s).join('\n'));
});
check('(g) validate: teacher week rules', () => {
  const s = school('ttttt', 5);
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s);
  add.lesson(s, subj, t, [c], 10, 1, { maxOnePerDay: false });
  assert.ok(!hasMsg(s, /err/), msgs(s).join('\n'));
  t.freeDays = 1; t.maxPerDay = 0;
  assert.ok(!hasMsg(s, /err/), 'ten periods fit in four days');
  t.freeDays = 3;
  assert.ok(!hasMsg(s, /err/), 'ten periods exactly fit two days');
  t.freeDays = 4;
  assert.ok(hasMsg(s, /err: .*teaches 10 periods but 1 working day\(s\) hold only 5/), msgs(s).join('\n'));
  t.freeDays = 5;
  assert.ok(hasMsg(s, /err: .*must have 5 free day\(s\) but can only work 5/), msgs(s).join('\n'));
  t.freeDays = 1; t.maxPerDay = 2;
  assert.ok(hasMsg(s, /err: .*with 1 free day\(s\) and max 2\/day only 8 fit/), msgs(s).join('\n'));
  t.freeDays = 0; t.maxPerDay = 0; t.presenceStrict = true; t.maxPresenceWeek = 8;
  assert.ok(hasMsg(s, /err: .*strict weekly presence limit is 8/), msgs(s).join('\n'));
  t.maxPresenceWeek = 0; t.maxPresenceDay = 1;
  assert.ok(hasMsg(s, /err: .*presence 1\/day over 5 day\(s\) allows only 5/), msgs(s).join('\n'));
  t.presenceStrict = false;
  assert.ok(!hasMsg(s, /err/), 'soft limits never block');
  t.maxPresenceDay = 6; t.maxPresenceWeek = 3;
  assert.ok(hasMsg(s, /warn: .*presence\/day is above presence\/week/), msgs(s).join('\n'));
});
// ---------- (h) room demand ----------
const addRoom = (s, name, type = 'Classroom') => { const x = { id: id('r'), name, type, unavailable: [], dispreferred: [] }; s.rooms.push(x); return x; };
const rooms = (s) => msgs(s).filter((m) => /booked|usable slots/.test(m));
check('(h) capacity counts only periods in which a class using the rooms is available', () => {
  const s = school('tttt', 6);
  const subj = add.subject(s), a = add.cls(s, 'A'), b = add.cls(s, 'B');
  [a, b].forEach((c) => { c.unavailable = ['5-2', '5-3']; });   // half-day Saturday
  addRoom(s, 'R1'); addRoom(s, 'R2');
  for (const c of [a, b]) add.lesson(s, subj, add.teacher(s, 'T' + c.name), [c], 21, 1, { room: 'type:Classroom' });
  // 2 rooms × (24 − 2 unused periods) = 44; 42 of 44 is 95%, but 42 of 48 would only be 88%.
  eq(rooms(s), ['warn: All 2 Classroom rooms are 95% booked (42 of 44 periods, 2 classes and meetings competing) — expect free periods inside class days. Add rooms or move some lessons to other room types.']);
});
check('(h) a lone class in its own dedicated room is never warned about', () => {
  const s = school('tttt', 5);
  const subj = add.subject(s), a = add.cls(s, 'A'); const r = addRoom(s, 'Home A');
  add.lesson(s, subj, add.teacher(s, 'T'), [a], 19, 1, { room: r.id });
  eq(rooms(s), []);
  // ...but two classes sharing that room are.
  const b = add.cls(s, 'B'); add.lesson(s, subj, add.teacher(s, 'U'), [b], 1, 1, { room: r.id });
  eq(rooms(s), ['warn: Home A is 100% booked (20 of 20 periods, 2 classes and meetings competing) — expect free periods inside class days. Add rooms or move some lessons to other room types.']);
});
check('(h) nested room sets are counted together: a pinned Lab and "any Lab" share the labs', () => {
  const s = school('tttt', 5);
  const subj = add.subject(s), a = add.cls(s, 'A'), b1 = add.cls(s, 'B1'), b2 = add.cls(s, 'B2');
  const l1 = addRoom(s, 'Lab 1', 'Lab'); addRoom(s, 'Lab 2', 'Lab');
  add.lesson(s, subj, add.teacher(s, 'TA'), [a], 19, 1, { room: l1.id });
  add.lesson(s, subj, add.teacher(s, 'TB1'), [b1], 10, 1, { room: 'type:Lab' });
  add.lesson(s, subj, add.teacher(s, 'TB2'), [b2], 9, 1, { room: 'type:Lab' });
  // Pinned 19 + any-Lab 19 = 38 of 40 lab periods; each set looked at alone is fine (19/20, 19/40).
  eq(rooms(s), ['warn: All 2 Lab rooms are 95% booked (38 of 40 periods, 3 classes and meetings competing) — expect free periods inside class days. Add rooms or move some lessons to other room types.']);
  s.lessons[0].lengths = Array(20).fill(1); s.lessons[1].lengths = Array(12).fill(1);
  assert.ok(hasMsg(s, /err: All 2 Lab rooms are needed for 41 periods but have only 40 usable slots\./), rooms(s).join('\n'));
});
check('(h) a room set with no usable slot is an error naming the room', () => {
  const s = school('tttt', 2);
  const subj = add.subject(s), a = add.cls(s, 'A'); const r = addRoom(s, 'Hall', 'Sports');
  r.unavailable = ['0-0', '0-1', '0-2', '0-3', '1-0', '1-1', '1-2', '1-3'];
  add.lesson(s, subj, add.teacher(s, 'T'), [a], 1, 1, { room: r.id });
  assert.ok(hasMsg(s, /err: Hall is needed for 1 periods but has only 0 usable slots\./), rooms(s).join('\n'));
});
// ---------- (i) class homeroom ----------
check('(i) migrate gives every class a homeroom and drops one that no longer exists', () => {
  const s = school('tttt', 2);
  const r = addRoom(s, 'R1'); const a = add.cls(s, 'A'); const b = add.cls(s, 'B');
  delete a.homeroom; b.homeroom = 'gone';
  M.migrate(s);
  eq([a.homeroom, b.homeroom], ['', '']);
  b.homeroom = r.id; M.migrate(s);
  assert.strictEqual(b.homeroom, r.id, 'a real homeroom is kept');
});
check('(i) homeroomOf, newLesson and applyHomeroom', () => {
  const s = school('tttt', 5);
  const subj = add.subject(s), t = add.teacher(s);
  const home = addRoom(s, 'Home A'), other = addRoom(s, 'Hall', 'Sports'); addRoom(s, 'R2');
  const a = add.cls(s, 'A'), b = add.cls(s, 'B'); a.homeroom = home.id; b.homeroom = home.id;
  assert.strictEqual(M.homeroomOf(s, [a.id]), home.id);
  assert.strictEqual(M.homeroomOf(s, [a.id, b.id]), home.id, 'classes sharing one homeroom');
  b.homeroom = other.id;
  assert.strictEqual(M.homeroomOf(s, [a.id, b.id]), '', 'different homerooms');
  assert.strictEqual(M.homeroomOf(s, [add.cls(s, 'N').id]), '', 'no homeroom');
  assert.strictEqual(M.newLesson(subj.id, [a.id], s).room, 'home', 'a new row for a class with a homeroom starts in it');
  assert.strictEqual(M.newLesson(subj.id, [a.id]).room, '', 'without the state nothing changes');
  assert.strictEqual(M.newLesson(subj.id, [a.id, b.id], s).room, '', 'shared rows are left alone');
  const none = add.lesson(s, subj, t, [a], 2, 1, { room: '' });
  const anyType = add.lesson(s, subj, t, [a], 2, 1, { room: 'type:Classroom' });
  const hall = add.lesson(s, subj, t, [a], 2, 1, { room: other.id });
  const shared = add.lesson(s, subj, t, [a, b], 2, 1, { room: '' });
  const bRow = add.lesson(s, subj, t, [b], 2, 1, { room: '' });
  eq(M.applyHomeroom(s, a.id), { none: 1, type: 1 });
  eq([none.room, anyType.room, anyType.roomAlt, hall.room, shared.room, bRow.room], ['home', 'home', 'type:Classroom', other.id, '', ''], 'only A’s own rows with no room or any Classroom change');
  eq(M.applyHomeroom(s, a.id), { none: 0, type: 0 }, 'idempotent');
  eq(M.applyHomeroom(s, add.cls(s, 'N2').id), { none: 0, type: 0 }, 'a class without a homeroom changes nothing');
});
check('(i) validate: shared homeroom warning, parallel rows on one homeroom, a row whose class has none', () => {
  const s = school('tttt', 5);
  const subj = add.subject(s), a = add.cls(s, 'A'), b = add.cls(s, 'B'); const home = addRoom(s, 'Home'); addRoom(s, 'Spare');
  a.homeroom = home.id; b.homeroom = home.id;
  add.lesson(s, subj, add.teacher(s, 'T'), [a], 2, 1, { room: 'home' });
  assert.ok(hasMsg(s, /warn: Classes A and B share the homeroom Home/), msgs(s).join('\n'));
  b.homeroom = '';
  assert.ok(!hasMsg(s, /share the homeroom/));
  const split = add.lesson(s, subj, add.teacher(s, 'U'), [a], 2, 1, { room: 'home', parallel: 'Split' });
  const split2 = add.lesson(s, subj, add.teacher(s, 'V'), [a], 2, 1, { room: 'home', parallel: 'Split' });
  assert.ok(hasMsg(s, /err: .*run in parallel but all use the homeroom Home/), msgs(s).join('\n'));
  split2.roomAlt = 'type:Classroom';
  split.roomAlt = 'type:Classroom';
  assert.ok(!hasMsg(s, /run in parallel but all use the homeroom/), 'with a fallback they can take different rooms');
  const orphan = add.lesson(s, subj, add.teacher(s, 'W'), [b], 1, 1, { room: 'home' });
  assert.ok(hasMsg(s, /err: .*uses the class homeroom but its class has no homeroom/), msgs(s).join('\n'));
  void orphan;
});
// ---------- (j) grades & curriculum ----------
const mkGrade = (s, name, curriculum = []) => { const g = { id: id('g'), name, curriculum }; s.grades.push(g); return g; };
check('(j) migrate cleans grades: dangling subjects, bad or duplicate periods, unknown grade ids', () => {
  const s = school('tttt', 5);
  const m = add.subject(s, 'Maths'), e = add.subject(s, 'English');
  const g = mkGrade(s, 'G1', [{ subjectId: m.id, periods: 4.7 }, { subjectId: m.id, periods: 2 }, { subjectId: e.id, periods: 0 }, { subjectId: 'gone', periods: 3 }, { subjectId: e.id, periods: 'x' }, null]);
  const a = add.cls(s, 'A'); a.gradeId = g.id; const b = add.cls(s, 'B'); b.gradeId = 'nope';
  M.migrate(s);
  eq(g.curriculum, [{ subjectId: m.id, periods: 4 }], 'only the first valid entry per subject, whole periods');
  eq([a.gradeId, b.gradeId], [g.id, ''], 'unknown grade id cleared');
  const old = M.migrate({ settings: M.emptyState().settings, teachers: [], classes: [{ id: 'c', name: 'C' }], rooms: [], subjects: [], lessons: [] });
  eq([old.grades, old.classes[0].gradeId], [[], ''], 'files without grades get them');
});
check('(j) curriculum helpers: periods per subject, gaps, derive, subjects shared by a row’s classes', () => {
  const s = school('tttt', 5);
  const m = add.subject(s, 'Maths'), e = add.subject(s, 'English'), h = add.subject(s, 'History'), t = add.teacher(s);
  const g = mkGrade(s, 'Year 7', [{ subjectId: m.id, periods: 5 }, { subjectId: e.id, periods: 4 }, { subjectId: h.id, periods: 2 }]);
  const a = add.cls(s, 'A'), b = add.cls(s, 'B'), other = add.cls(s, 'O'); a.gradeId = g.id; b.gradeId = g.id;
  add.lesson(s, m, t, [a], 5, 1); add.lesson(s, e, t, [a], [2, 1]); add.lesson(s, e, t, [a, b], 1, 1);  // A: Maths 5, English 4 (3 + a joint 1)
  add.lesson(s, m, t, [b], 3, 1);                                                                     // B: Maths 3, no English, no History
  eq(M.classSubjectPeriods(s, a.id), { [m.id]: 5, [e.id]: 4 });
  eq(M.curriculumGaps(s, a.id), [{ subjectId: h.id, want: 2, have: 0 }]);
  eq(M.curriculumGaps(s, b.id), [{ subjectId: m.id, want: 5, have: 3 }, { subjectId: e.id, want: 4, have: 1 }, { subjectId: h.id, want: 2, have: 0 }]);
  eq(M.curriculumGaps(s, other.id), [], 'a class without a grade has no gaps');
  eq(M.deriveCurriculum(s, a.id), [{ subjectId: m.id, periods: 5 }, { subjectId: e.id, periods: 4 }], 'subject-list order, only subjects with lessons');
  eq([...M.curriculumSubjects(s, [a.id])].sort(), [m.id, e.id, h.id].sort());
  eq([...M.curriculumSubjects(s, [a.id, b.id])].length, 3, 'two classes of one grade');
  assert.strictEqual(M.curriculumSubjects(s, [a.id, other.id]), null, 'mixed grades: no filtering');
  assert.strictEqual(M.curriculumSubjects(s, []), null);
  g.curriculum = [];
  assert.strictEqual(M.curriculumSubjects(s, [a.id]), null, 'an empty curriculum filters nothing');
});
check('(j) applyCurriculum adds one row per subject with no lessons, in the homeroom, and nothing else', () => {
  const s = school('tttt', 5);
  const m = add.subject(s, 'Maths'), e = add.subject(s, 'English'), h = add.subject(s, 'History'), t = add.teacher(s);
  const g = mkGrade(s, 'Year 7', [{ subjectId: m.id, periods: 5 }, { subjectId: e.id, periods: 4 }, { subjectId: h.id, periods: 7 }]);
  const room = { id: id('r'), name: 'R1', type: 'Classroom', unavailable: [], dispreferred: [] }; s.rooms.push(room);
  const a = add.cls(s, 'A'); a.gradeId = g.id; a.homeroom = room.id;
  add.lesson(s, m, t, [a], 3, 1);  // Maths has lessons (3 of 5): reported, not topped up
  assert.strictEqual(M.missingLessons(s, g.id), 2);
  assert.strictEqual(M.applyCurriculum(s, a.id), 2);
  const added = s.lessons.slice(1);
  eq(added.map((l) => [l.subjectId, M.periodsOf(l), l.maxOnePerDay, l.room, l.teacherId]), [[e.id, 4, true, 'home', ''], [h.id, 7, false, 'home', '']], '7 periods cannot be one per day in a 5-day week');
  eq(s.lessons[0].lengths, [1, 1, 1], 'existing rows are untouched');
  assert.strictEqual(M.applyCurriculum(s, a.id), 0, 'idempotent');
  assert.strictEqual(M.applyCurriculum(s, add.cls(s, 'Z').id), 0, 'a class without a grade');
});
check('(j) validate: missing, short and over-long subjects, and a curriculum bigger than the week', () => {
  const s = school('tttt', 5);    // 20 slots per class
  const m = add.subject(s, 'Maths'), e = add.subject(s, 'English'), t = add.teacher(s);
  const g = mkGrade(s, 'Year 7', [{ subjectId: m.id, periods: 5 }, { subjectId: e.id, periods: 1 }]);
  const a = add.cls(s, 'A'); a.gradeId = g.id;
  assert.ok(hasMsg(s, /warn: A has no Maths lessons but the Year 7 curriculum asks for 5 periods\./), msgs(s).join('\n'));
  add.lesson(s, m, t, [a], 4, 1);
  assert.ok(hasMsg(s, /warn: A has 4 periods of Maths but the Year 7 curriculum asks for 5\./), msgs(s).join('\n'));
  assert.ok(hasMsg(s, /warn: A has no English lessons but the Year 7 curriculum asks for 1 period\./), 'singular');
  add.lesson(s, m, t, [a], 1, 1); add.lesson(s, e, t, [a], 1, 1);
  assert.ok(!hasMsg(s, /curriculum/), msgs(s).join('\n'));
  g.curriculum[0].periods = 20;
  assert.ok(hasMsg(s, /err: The Year 7 curriculum asks for 21 periods but A has only 20 free slots\./), msgs(s).join('\n'));
  a.gradeId = '';
  assert.ok(!hasMsg(s, /curriculum/), 'classes outside a grade are not checked');
});
// ---------- (k) complementary activities ----------
check('(k) migrate cleans activities; workload counts them (max/day only when countLoad)', () => {
  const s = school('tttt', 5);
  const t = add.teacher(s, 'T');
  s.activities = [{ id: 'a1', name: 5, teacherId: t.id, periods: '3.9', minPerDay: -1, maxPerDay: 'x', nonConsecutive: 1, allowed: 'no' }, null, { name: 'no id' }, { id: 'a2', name: 'B', teacherId: t.id, periods: 2, countLoad: true, allowed: ['0-0'] }];
  M.migrate(s);
  eq(s.activities.map((a) => a.id), ['a1', 'a2']);
  eq(s.activities[0], { id: 'a1', name: 'Activity', teacherId: t.id, periods: 3, minPerDay: 0, maxPerDay: 0, nonConsecutive: true, countLoad: false, allowed: [] });
  const w = M.workload(s);
  eq([w.t[t.id], w.tl[t.id] || 0], [5, 2], 'all five periods load the teacher; only the opted-in two count toward max/day');
  const old = M.migrate({ settings: M.emptyState().settings, teachers: [], classes: [], rooms: [], subjects: [], lessons: [] });
  eq(old.activities, [], 'files without activities get an empty list');
});
check('(k) validate: engine problems, impossible daily limits, too few usable slots, load over free slots', () => {
  const s = school('tttt', 3);   // 12 slots
  const t = add.teacher(s, 'T');
  const a = { id: id('a'), name: 'Prep', teacherId: t.id, periods: 4, minPerDay: 0, maxPerDay: 0, nonConsecutive: false, countLoad: false, allowed: [] };
  s.activities.push(a);
  assert.ok(!hasMsg(s, /err/), msgs(s).join('\n'));
  a.maxPerDay = 1;
  assert.ok(hasMsg(s, /err: Activity “Prep” has 4 periods but max 1\/day over the 3 day\(s\) T can be there holds only 3\./), msgs(s).join('\n'));
  a.maxPerDay = 2; a.minPerDay = 3;
  assert.ok(hasMsg(s, /warn: Activity “Prep”: min\/day is above max\/day\./), msgs(s).join('\n'));
  a.minPerDay = 0; a.allowed = ['0-0', '0-1', '1-0'];
  assert.ok(hasMsg(s, /err: Activity “Prep” has 4 periods but only 3 usable slot\(s\) for T\./), msgs(s).join('\n'));
  a.allowed = []; t.unavailable = Array.from({ length: 12 }, (_, i) => `${Math.floor(i / 4)}-${i % 4}`).filter((k) => !k.startsWith('2-'));
  a.maxPerDay = 0;
  assert.ok(!hasMsg(s, /only 4 usable/) && !hasMsg(s, /err/), 'four slots fit four periods');
  a.periods = 5;
  assert.ok(hasMsg(s, /err: .*T has 5 periods but only 4 free slots\./) && hasMsg(s, /Activity “Prep” has 5 periods but only 4 usable slot\(s\) for T\./), msgs(s).join('\n'));
  a.teacherId = 'gone';
  assert.ok(hasMsg(s, /err: Activity “Prep” has no teacher\./), msgs(s).join('\n'));
  a.teacherId = t.id; a.periods = 0;
  assert.ok(hasMsg(s, /err: Activity “Prep” has no periods per week\./), msgs(s).join('\n'));
  assert.strictEqual(M.describeUnit(s, `a:${a.id}#2`), 'Prep · T');
});
// ---------- (l) pins ----------
const pinMsgs = (s) => msgs(s).filter((m) => /Pin on/.test(m));
check('(l) pinSessions, setPin / pinAt and dropDeadPins (migrate) keep only pins that point at a session and a slot', () => {
  const s = school('tttt', 5);
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s);
  const l = add.lesson(s, subj, t, [c], [2, 1, 1]);
  const fl = add.lesson(s, subj, t, [c], 2, 1, { flexible: { total: 4, min: 1, max: 2 } });
  const m = { id: 'm1', name: 'Sync', teacherIds: [t.id], sessions: 2, length: 2, room: '', allowed: [] }; s.meetings.push(m);
  const a = { id: 'a1', name: 'Prep', teacherId: t.id, periods: 3, minPerDay: 0, maxPerDay: 0, nonConsecutive: false, countLoad: false, allowed: [] }; s.activities.push(a);
  eq(M.pinSessions(s, 'lesson', l.id), [2, 1, 1]); eq(M.pinSessions(s, 'lesson', fl.id), [], 'flexible rows have no fixed sessions');
  eq(M.pinSessions(s, 'meeting', 'm1'), [2, 2]); eq(M.pinSessions(s, 'activity', 'a1'), [1, 1, 1]); eq(M.pinSessions(s, 'lesson', 'gone'), []);
  M.setPin(s, 'lesson', l.id, 0, 1, 2); M.setPin(s, 'lesson', l.id, 0, 3, 1);
  eq(s.pins, [{ kind: 'lesson', id: l.id, k: 0, day: 3, period: 1 }], 'setting a pin again replaces it');
  assert.deepStrictEqual({ ...M.pinAt(s, 'lesson', l.id, 0) }, { kind: 'lesson', id: l.id, k: 0, day: 3, period: 1 });
  M.setPin(s, 'lesson', l.id, 0, null);
  eq(s.pins, [], 'null clears');
  s.pins = [
    { kind: 'lesson', id: l.id, k: 2, day: 4, period: 3 },           // fine
    { kind: 'lesson', id: l.id, k: 2, day: 0, period: 0 },           // duplicate session
    { kind: 'lesson', id: l.id, k: 3, day: 0, period: 0 },           // session out of range
    { kind: 'lesson', id: 'gone', k: 0, day: 0, period: 0 },         // deleted row
    { kind: 'meeting', id: 'm1', k: 1, day: 5, period: 0 },          // day out of the week
    { kind: 'activity', id: 'a1', k: 0, day: 0, period: 4 },         // period out of the week
    { kind: 'activity', id: 'a1', k: 1, day: '2', period: '3' },     // numeric strings are accepted
    { kind: 'room', id: 'x', k: 0, day: 0, period: 0 }, null, { kind: 'lesson', k: 0, day: 0, period: 0 },
  ];
  M.migrate(s);
  eq(s.pins, [{ kind: 'lesson', id: l.id, k: 2, day: 4, period: 3 }, { kind: 'activity', id: 'a1', k: 1, day: 2, period: 3 }]);
  eq(M.migrate({ settings: M.emptyState().settings, teachers: [], classes: [], rooms: [], subjects: [], lessons: [] }).pins, [], 'files without pins');
  M.removeLesson(s, l.id);
  eq(s.pins, [{ kind: 'activity', id: 'a1', k: 1, day: 2, period: 3 }], 'deleting a row drops its pins');
});
check('(l) validate: pins that cannot be honoured are errors that say why', () => {
  const s = school('tttbtt', 3);
  const subj = add.subject(s), c = add.cls(s, 'A'), c2 = add.cls(s, 'B'), t = add.teacher(s, 'Ann'), u = add.teacher(s, 'Bob');
  c2.unavailable = ['1-0'];
  const dbl = add.lesson(s, subj, t, [c], [2]), one = add.lesson(s, subj, u, [c2], [1]);
  const fl = add.lesson(s, subj, u, [c], 2, 1, { flexible: { total: 3, min: 1, max: 2 } });
  eq(pinMsgs(s), []);
  s.pins = [{ kind: 'lesson', id: dbl.id, k: 0, day: 0, period: 1 }];
  eq(pinMsgs(s), [], 'a valid pin is silent');
  s.pins = [{ kind: 'lesson', id: dbl.id, k: 0, day: 0, period: 2 }];
  assert.ok(hasMsg(s, /err: Pin on .*, session 1 \(Day 1, period 3\) cannot be honoured: A multi-period lesson would run into a break there/), msgs(s).join('\n'));
  s.pins = [{ kind: 'lesson', id: one.id, k: 0, day: 1, period: 0 }];
  assert.ok(hasMsg(s, /Pin on .* \(Day 2, period 1\) cannot be honoured: A teacher, class or subject is marked ✕/), msgs(s).join('\n'));
  s.pins = [{ kind: 'lesson', id: one.id, k: 0, day: 0, period: 3 }];
  assert.ok(hasMsg(s, /cannot be honoured: That is a break period\./), msgs(s).join('\n'));
  s.pins = [{ kind: 'lesson', id: fl.id, k: 0, day: 0, period: 0 }];
  M.migrate(s);   // flexible rows have no pinnable sessions, so migrate drops the pin
  eq(s.pins, []);
  s.pins = [{ kind: 'lesson', id: dbl.id, k: 0, day: 0, period: 0 }, { kind: 'lesson', id: one.id, k: 0, day: 0, period: 1 }];
  eq(pinMsgs(s), [], 'two pins that do not collide');
  const cc = add.cls(s, 'C'); const three = add.lesson(s, subj, t, [cc], [1]);   // same teacher as dbl
  s.pins = [{ kind: 'lesson', id: dbl.id, k: 0, day: 0, period: 0 }, { kind: 'lesson', id: three.id, k: 0, day: 0, period: 1 }];
  assert.ok(hasMsg(s, /Pin on .*, session 1 \(Day 1, period 2\) cannot be honoured: Clash with: .*Ann/), msgs(s).join('\n'));
});
// ---------- (m) subject templates ----------
check('(m) migrate gives subjects availability lists; pruneDeadKeys and validation see them', () => {
  const s = school('ttlt', 2);
  const subj = add.subject(s, 'PE'); delete subj.unavailable;
  M.migrate(s);
  eq([subj.unavailable, subj.dispreferred], [[], []]);
  subj.unavailable = ['0-0', '0-2', '1-9']; subj.dispreferred = ['1-1', '0-2'];
  assert.strictEqual(M.availableSlots(s, subj), 5, 'a subject has a template like any element: 6 teaching slots minus the one ✕ on a teaching period');
  const removed = M.pruneDeadKeys(s);
  assert.ok(removed >= 1);
  assert.ok(!subj.unavailable.includes('1-9') && !subj.unavailable.includes('0-2'), 'keys on lunch / outside the week are dropped');
  const t = add.teacher(s), c = add.cls(s);
  add.lesson(s, subj, t, [c], 2, 1);
  subj.unavailable = s.settings.days.flatMap((_, d) => [0, 1, 3].map((p) => `${d}-${p}`));
  assert.ok(hasMsg(s, /err: .*has no period where all its teachers and classes are available/), msgs(s).join('\n'));
});
check('(n) strongly non-preferred lists migrate, count in slot arithmetic and are pruned like the others', () => {
  const s = school('ttlt', 2);
  const t = add.teacher(s); delete t.dispreferred2; t.dispreferred2 = undefined;
  M.migrate(s);
  eq(t.dispreferred2, []);
  t.dispreferred2 = ['0-0', '0-2', '1-9'];
  M.pruneDeadKeys(s);
  eq(t.dispreferred2, ['0-0'], 'lunch and out-of-week keys are dropped from ~~ too');
  assert.strictEqual(typeof M.WEIGHT_LABELS.dispreferred2, 'string');
});
check('(o) migrate sets sizes and capacities; validate warns only when no usable room seats the class', () => {
  const s = school('tttt', 3);
  const subj = add.subject(s), t = add.teacher(s), u = add.teacher(s, 'U'); const a = add.cls(s, 'A'); a.size = '28.6';
  const r1 = addRoom(s, 'R1'), r2 = addRoom(s, 'R2'); r1.capacity = 20; r2.capacity = undefined;
  M.migrate(s);
  eq([a.size, r1.capacity, r2.capacity], [28, 20, 0]);
  add.lesson(s, subj, t, [a], 2, 1, { room: 'type:Classroom' });
  assert.ok(!hasMsg(s, /students/), 'R2 has no capacity set, so it may be big enough');
  r2.capacity = 25;
  assert.ok(hasMsg(s, /warn: Subject · A · Teacher has 28 students but no room it can use seats that many \(largest: R2, 25\)\./), msgs(s).join('\n'));
  const l2 = add.lesson(s, subj, u, [a], 2, 1, { room: r1.id });
  assert.ok(hasMsg(s, /Subject · A · U has 28 students but R1 seats only 20\./), msgs(s).join('\n'));
  r2.capacity = 40; l2.room = r2.id;
  assert.ok(!hasMsg(s, /students/));
});
check('(p) class rules migrate to numbers/booleans and a daily cap below the load is an error', () => {
  const s = school('tttt', 2);
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s, 'A');
  c.maxPerDay = '3.7'; c.noGaps = 1; delete c.forceFree;
  M.migrate(s);
  eq([c.maxPerDay, c.noGaps, c.forceFree], [3, true, false]);
  add.lesson(s, subj, t, [c], 7, 1, { maxOnePerDay: false });
  assert.ok(hasMsg(s, /err: A has 7 periods but max 3\/day allows only 6\./), msgs(s).join('\n'));
  c.maxPerDay = 4;
  assert.ok(!hasMsg(s, /max 4\/day/));
  eq(Object.keys(M.classDefaults()).sort(), ['code', 'extKey', 'forceFree', 'gradeId', 'homeroom', 'maxPerDay', 'noGaps', 'size', 'tutorDaily', 'tutorEarly', 'tutorId', 'tutorLate']);
});
check('(q) copyLessons clones a class’s own rows, keeps relations among the copies and renames parallel groups', () => {
  const s = school('tttt', 5);
  const subj = add.subject(s, 'Maths'), eng = add.subject(s, 'English'), t = add.teacher(s), u = add.teacher(s, 'U');
  const a = add.cls(s, 'A'), b = add.cls(s, 'B'), c = add.cls(s, 'C');
  const home = addRoom(s, 'Home A'); a.homeroom = home.id;
  const l1 = add.lesson(s, subj, t, [a], [2, 1], 1, { room: 'home', penalizeEnds: true });
  const l2 = add.lesson(s, eng, u, [a], 3, 1, { flexible: null, roomAlt: 'type:Classroom', room: 'type:Classroom' });
  const g1 = add.lesson(s, subj, t, [a], 2, 1, { parallel: 'Split' }), g2 = add.lesson(s, eng, u, [a], 2, 1, { parallel: 'Split' });
  const shared = add.lesson(s, subj, t, [a, b], 1, 1);
  M.addRelation(s, l1.id, l2.id, 'differentDays');
  M.addRelation(s, l1.id, shared.id, 'notSameTime');
  s.pins = [{ kind: 'lesson', id: l1.id, k: 0, day: 0, period: 0 }];
  const before = s.lessons.length;
  const out = M.copyLessons(s, a.id, c.id);
  assert.strictEqual(out.length, 4, 'four single-class rows; the shared row stays out');
  assert.strictEqual(s.lessons.length, before + 4);
  assert.ok(out.every((l) => l.classIds.length === 1 && l.classIds[0] === c.id));
  const cl1 = out.find((l) => l.subjectId === subj.id && M.periodsOf(l) === 3);
  eq([cl1.lengths, cl1.room, cl1.penalizeEnds, cl1.teacherId], [[2, 1], 'home', true, t.id], 'subject, distribution, room spec, options and teacher are copied');
  assert.notStrictEqual(cl1.id, l1.id);
  const cl2 = out.find((l) => l.subjectId === eng.id && !l.parallel);
  eq(cl1.relations.map((r) => [r.type, r.lessonId]), [['differentDays', cl2.id]], 'relation between copies kept; the one to the shared row is not');
  eq(cl2.relations.map((r) => [r.type, r.lessonId]), [['differentDays', cl1.id]]);
  eq(out.filter((l) => l.parallel).map((l) => l.parallel), ['Split C', 'Split C'], 'the copied group is named after the new class');
  eq(s.lessons.find((l) => l.id === g1.id).parallel, 'Split', 'the original group is untouched');
  eq(s.pins.length, 1, 'pins are not copied');
  assert.strictEqual(M.homeroomOf(s, [c.id]), '', 'the new class has no homeroom yet, so a “Class homeroom” row reports it when validating');
  assert.ok(hasMsg(s, /err: .*uses the class homeroom but its class has no homeroom/), msgs(s).join('\n'));
  eq(M.copyLessons(s, a.id, a.id), [], 'a class cannot copy to itself');
  eq(M.copyLessons(s, 'nope', c.id), [], 'unknown class');
  void g2;
});
check('(r) tutors: migrate, new rows and applyTutor start with the tutor, and a tutor who cannot teach every day is flagged', () => {
  const s = school('tttt', 5);
  const subj = add.subject(s), tutor = add.teacher(s, 'Tutor'), other = add.teacher(s, 'Other'); const c = add.cls(s, 'A'), d = add.cls(s, 'B');
  c.tutorId = 'gone'; c.tutorDaily = 1;
  M.migrate(s);
  eq([c.tutorId, c.tutorDaily, c.tutorEarly], ['', true, false], 'unknown tutor cleared, flags normalised');
  c.tutorId = tutor.id;
  assert.strictEqual(M.newLesson(subj.id, [c.id], s).teacherId, tutor.id);
  assert.strictEqual(M.newLesson(subj.id, [c.id]).teacherId, '', 'without state nothing changes');
  assert.strictEqual(M.newLesson(subj.id, [c.id, d.id], s).teacherId, '', 'shared rows have no tutor default');
  const blank = add.lesson(s, subj, { id: '' }, [c], 2, 1), taught = add.lesson(s, subj, other, [c], 2, 1), shared = add.lesson(s, subj, { id: '' }, [c, d], 1, 1);
  assert.strictEqual(M.applyTutor(s, c.id), 1);
  eq([blank.teacherId, taught.teacherId, shared.teacherId], [tutor.id, other.id, ''], 'only the class’s own rows without a teacher');
  assert.strictEqual(M.applyTutor(s, d.id), 0, 'a class without a tutor');
  // Tutor teaches 2 periods a week; "every day" needs five.
  assert.ok(hasMsg(s, /warn: Tutor teaches A only 2 period\(s\) a week, fewer than the 5 days/), msgs(s).join('\n'));
  blank.lengths = [1, 1, 1, 1, 1];
  assert.ok(!hasMsg(s, /fewer than the 5 days/));
});
check('(s) departments: migrate drops dangling references; the sample puts every teacher and subject in one', () => {
  const s = school('tttt', 2);
  const subj = add.subject(s), t = add.teacher(s);
  subj.departmentId = 'gone'; t.departmentId = 'gone';
  s.departments = [{ id: 'd1', name: 'Maths' }, null, { name: 'no id' }, { id: 'd2', name: 7 }];
  M.migrate(s);
  eq(s.departments, [{ id: 'd1', name: 'Maths', extKey: '' }, { id: 'd2', name: 'Department', extKey: '' }]);
  eq([subj.departmentId, t.departmentId], ['', '']);
  subj.departmentId = 'd1'; t.departmentId = 'd2'; M.migrate(s);
  eq([subj.departmentId, t.departmentId], ['d1', 'd2'], 'real references are kept');
  eq(M.migrate({ settings: M.emptyState().settings, teachers: [{ id: 't', name: 'T' }], classes: [], rooms: [], subjects: [], lessons: [] }).departments, [], 'files without departments');
  const sample = M.sampleState();
  assert.ok(sample.departments.length >= 4);
  assert.ok(sample.teachers.every((x) => x.departmentId) && sample.subjects.every((x) => x.departmentId), 'everyone is in a department');
  assert.strictEqual(sample.subjects.find((x) => x.name === 'Mathematics').departmentId, sample.teachers.find((x) => x.name === 'Anita Rao').departmentId);
});
check('(t) codes and external keys: migrate defaults, days and periods carry keys, duplicates are warned about', () => {
  const s = school('ttt', 3);
  const t1 = add.teacher(s, 'Ann'), t2 = add.teacher(s, 'Bob'), c1 = add.cls(s, 'A'), c2 = add.cls(s, 'B');
  const r1 = addRoom(s, 'R1'), r2 = addRoom(s, 'R2');
  delete t1.extKey; c1.code = 5; delete r1.code; s.settings.dayKeys = ['mon'];
  M.migrate(s);
  eq([t1.extKey, c1.code, c1.extKey, r1.code, r1.extKey], ['', '', '', '', '']);
  eq(s.settings.dayKeys, ['mon', '', ''], 'one key per day, padded');
  assert.ok(s.settings.periods.every((p) => p.extKey === ''));
  eq(msgs(s).filter((m) => /share the/.test(m)), [], 'empty keys never collide');
  t1.extKey = 'T-1'; t2.extKey = 't-1'; c1.code = '7A'; c2.code = '7A'; r1.extKey = 'X'; r2.extKey = 'Y';
  s.settings.dayKeys = ['d', 'd', 'e']; s.settings.periods[0].extKey = 'p'; s.settings.periods[1].extKey = 'p';
  const dups = msgs(s).filter((m) => /share the/.test(m));
  assert.ok(dups.some((m) => /2 teachers share the external key “t-1”: Ann, Bob/.test(m)), dups.join('\n'));
  assert.ok(dups.some((m) => /2 classes share the code “7a”: A, B/.test(m)), dups.join('\n'));
  assert.ok(dups.some((m) => /2 days share the external key “d”/.test(m)) && dups.some((m) => /2 periods share the external key “p”/.test(m)), dups.join('\n'));
  assert.ok(!dups.some((m) => /rooms/.test(m)), 'distinct keys are fine');
  const sample = M.sampleState();
  assert.ok(sample.classes.every((c) => c.code) && sample.rooms.every((r) => r.code), 'the sample has codes');
  eq(M.migrate(JSON.parse(JSON.stringify(sample))), sample);
});
check('(u) anonymous rooms: migrate, labels and demand count instances; dedicated rooms are not "any" rooms', () => {
  const s = school('tttt', 5);
  const subj = add.subject(s), c = add.cls(s, 'A'), d = add.cls(s, 'B'), t = add.teacher(s, 'T'), u = add.teacher(s, 'U');
  const gen = addRoom(s, 'General'); gen.count = '3.9'; gen.dedicated = 0;
  const own = addRoom(s, 'Own'); own.dedicated = true; delete own.count;
  M.migrate(s);
  eq([gen.count, gen.dedicated, own.count, own.dedicated], [3, false, 1, true]);
  eq(M.roomList(s).map((r) => r.name), ['General 1', 'General 2', 'General 3', 'Own']);
  assert.strictEqual(M.roomById(s, `${gen.id}~3`).name, 'General 3');
  assert.strictEqual(M.roomById(s, 'nope'), null);
  // "Any Classroom" = the three General instances (Own is dedicated): 3 × 20 periods = 60.
  add.lesson(s, subj, t, [c], 20, 1, { room: 'type:Classroom', maxOnePerDay: false });
  add.lesson(s, subj, u, [d], 17, 1, { room: 'type:Classroom', maxOnePerDay: false });
  assert.ok(!hasMsg(s, /booked|usable/), 'the classes need 37 of 60 room-periods: ' + msgs(s).join('\n'));
  const big = add.lesson(s, subj, add.teacher(s, 'V'), [add.cls(s, 'C')], 20, 1, { room: 'type:Classroom', maxOnePerDay: false });
  assert.ok(hasMsg(s, /warn: All 3 Classroom rooms are 95% booked \(57 of 60 periods, 3 classes and meetings competing\)/), msgs(s).join('\n'));
  big.lengths = Array(23).fill(1);
  assert.ok(hasMsg(s, /warn: All 3 Classroom rooms are 100% booked \(60 of 60 periods/), msgs(s).join('\n'));
  big.lengths = Array(24).fill(1);
  assert.ok(hasMsg(s, /err: All 3 Classroom rooms are needed for 61 periods but have only 60 usable slots/), msgs(s).join('\n'));
  // Naming the record asks for any instance, and a room that is only dedicated has no "any" set at all.
  eq(M.roomList(s).filter((r) => !r.dedicated && r.type === 'Classroom').length, 3);
  gen.dedicated = true;
  assert.ok(hasMsg(s, /needs a room type that has no rooms/), msgs(s).join('\n'));
});
check('(v) relations: before/after and order mirror between the rows, break-divides is kept, remove clears both', () => {
  const s = school('tttt', 5);
  const subj = add.subject(s), t = add.teacher(s), u = add.teacher(s, 'U'), c = add.cls(s, 'A'), d = add.cls(s, 'B');
  const a = add.lesson(s, subj, t, [c], 2, 1), b = add.lesson(s, subj, u, [d], 2, 1);
  const rel = (row) => row.relations.map((r) => ({ ...r }));
  M.addRelation(s, a.id, b.id, 'before');
  eq(rel(a), [{ type: 'before', lessonId: b.id }]); eq(rel(b), [{ type: 'after', lessonId: a.id }]);
  M.addRelation(s, b.id, a.id, 'consecutive', { order: 'first', breaks: true });
  eq(rel(b).find((r) => r.type === 'consecutive'), { type: 'consecutive', lessonId: a.id, order: 'first', breaks: true });
  eq(rel(a).find((r) => r.type === 'consecutive'), { type: 'consecutive', lessonId: b.id, order: 'second', breaks: true }, 'the order flips on the other row');
  M.addRelation(s, a.id, b.id, 'nonConsecutive', { breaks: 1 });
  eq(rel(b).find((r) => r.type === 'nonConsecutive'), { type: 'nonConsecutive', lessonId: a.id, breaks: true });
  M.removeRelation(s, a.id, b.id, 'before');
  assert.ok(!a.relations.some((r) => r.type === 'before') && !b.relations.some((r) => r.type === 'after'), 'removing before also removes the mirrored after');
  // Declared on one row only: migrate adds the mirrored record to the other.
  a.relations = [{ type: 'after', lessonId: b.id }]; b.relations = [];
  M.migrate(s);
  eq(rel(b), [{ type: 'before', lessonId: a.id }]);
  a.relations = [{ type: 'consecutive', lessonId: b.id, order: 'first', breaks: 0 }]; b.relations = [{ type: 'consecutive', lessonId: a.id, order: 'bogus' }];
  M.migrate(s);
  eq([rel(a), rel(b)], [[{ type: 'consecutive', lessonId: b.id, order: 'first', breaks: false }], [{ type: 'consecutive', lessonId: a.id, order: 'second', breaks: false }]], 'rows that disagree: the earlier row wins and is mirrored (order normalised, flag coerced)');
  assert.ok(M.RELATION_TYPES.before && M.RELATION_TYPES.after);
});
check('(w) alternatives and row day limits: migrate, pinning, validation', () => {
  const s = school('tttt', 5);
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s);
  const l = add.lesson(s, subj, t, [c], 4, 1, { alternatives: [[2, 2], [3, 1], 'x', [9], [1, 1, 1, 1], [4]], dayMax: '2.9', dayMin: -1, dayBlocks: 'sideways' });
  M.migrate(s);
  eq(l.alternatives, [[2, 2], [3, 1], [9], [1, 1, 1, 1]], 'well-formed alternatives only (a block longer than the day is for validation), at most four');
  eq([l.lengths, l.dayMax, l.dayMin, l.dayBlocks], [[2, 2], 2, 0, ''], 'lengths mirrors the first alternative; limits are normalised');
  l.alternatives = [[2, 2]]; M.migrate(s);
  eq(l.alternatives, [], 'one alternative is not a choice');
  l.alternatives = [[2, 2], [3, 1]]; l.flexible = { total: 4, min: 1, max: 2 }; M.migrate(s);
  eq(l.alternatives, [], 'flexible wins over alternatives');
  l.flexible = null; l.alternatives = [[2, 2], [3, 1]]; M.migrate(s);
  eq(M.pinSessions(s, 'lesson', l.id), [], 'rows whose distribution the engine chooses cannot be pinned');
  l.alternatives = []; l.dayMax = 0; M.migrate(s);
  eq(M.pinSessions(s, 'lesson', l.id), [2, 2]);
  // Validation
  l.alternatives = [[2, 2], [2, 1]]; l.lengths = [2, 2];
  assert.ok(hasMsg(s, /warn: .*the alternative distributions add up to different numbers of periods \(4 \/ 3\)/), msgs(s).join('\n'));
  l.alternatives = []; l.dayMax = 1;
  assert.ok(hasMsg(s, /err: .*has a block of 2 periods but max 1 periods\/day/), msgs(s).join('\n'));
  l.lengths = [1, 1, 1, 1]; l.dayMax = 0; s.settings.days = ['a', 'b']; s.settings.dayKeys = ['', ''];
  l.dayMax = 1;
  assert.ok(hasMsg(s, /err: .*has 4 periods but max 1\/day over 2 days holds only 2/), msgs(s).join('\n'));
  l.dayMax = 1; l.dayMin = 3;
  assert.ok(hasMsg(s, /warn: .*min periods\/day \(3\) is above max \(1\)/), msgs(s).join('\n'));
  // Parallel rows with the same alternatives agree; different ones do not.
  const a = add.lesson(s, subj, add.teacher(s, 'U'), [c], 2, 1, { parallel: 'G', alternatives: [[2], [1, 1]] }), b = add.lesson(s, subj, add.teacher(s, 'V'), [c], 2, 1, { parallel: 'G', alternatives: [[1, 1], [2]] });
  assert.ok(!hasMsg(s, /parallel group “G” but have different distributions/), 'identical alternative lists agree');
  b.alternatives = [[1, 1], [2, 0]]; M.migrate(s);
  b.alternatives = [[1, 1], [1, 2]];
  assert.ok(hasMsg(s, /parallel group “G” but have different (distributions|session lengths)/), msgs(s).join('\n'));   // reported by validation or, when its random pick cannot agree, by the engine
});
check('(x) row options: migrate normalises, validation notes options with no effect', () => {
  const s = school('tttt', 5);
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s);
  const l = add.lesson(s, subj, t, [c], 1, 1, { penalizeAfterBreak: 1, penalizeAfternoon: 'yes', sameHour: 'sometimes' });
  M.migrate(s);
  eq([l.penalizeAfterBreak, l.penalizeAfternoon, l.sameHour], [true, true, '']);
  l.sameHour = 'avoid';
  assert.ok(hasMsg(s, /warn: .*“Same hour” needs a row with at least two sessions/), msgs(s).join('\n'));
  assert.ok(hasMsg(s, /warn: .*“Avoid the first period after a break” has no effect — no period is typed “Break”/), msgs(s).join('\n'));
  l.lengths = [1, 1]; s.settings.periods[1].type = 'break'; s.settings.periods[1].label = 'Break';
  assert.ok(!hasMsg(s, /Same hour|first period after a break/), msgs(s).join('\n'));
});
check('(y) free half-days migrate and are checked against the half-days a teacher can teach in', () => {
  const s = school('ttltt', 2);
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s);
  t.freeHalves = '2.8'; add.lesson(s, subj, t, [c], 1, 1);
  M.migrate(s);
  assert.strictEqual(t.freeHalves, 2);
  assert.ok(!hasMsg(s, /free half-day/));
  t.freeHalves = 5;
  assert.ok(hasMsg(s, /warn: Teacher asks for 5 free half-day\(s\) but can only teach in 4 half-days/), msgs(s).join('\n'));
  t.unavailable = ['0-0', '0-1', '0-3', '0-4'];
  assert.ok(hasMsg(s, /can only teach in 2 half-days/), msgs(s).join('\n'));
});
check('(z2) the concentrate flag migrates to a boolean', () => {
  const s = school('tttt', 2); const t = add.teacher(s); t.concentrate = 'yes'; M.migrate(s); assert.strictEqual(t.concentrate, true); delete t.concentrate; M.migrate(s); assert.strictEqual(t.concentrate, false);
});
check('(z) exclusive-period settings migrate with safe defaults', () => {
  const s = school('tttt', 2);
  const t = add.teacher(s);
  t.exclusiveWindow = '0'; t.exclusiveWrap = 1; delete t.noFirstLast; t.noSplitDay = 'x';
  M.migrate(s);
  eq([t.exclusiveWindow, t.exclusiveWrap, t.noFirstLast, t.noSplitDay], [1, true, false, true]);
  t.exclusiveWindow = '3.9'; M.migrate(s);
  assert.strictEqual(t.exclusiveWindow, 3);
});
check('(aa) associations: migrate drops unknown teachers; a set with fewer than two is flagged', () => {
  const s = school('tttt', 2);
  const t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B');
  s.associations = [{ id: 'a1', name: 'Team', teacherIds: [t1.id, 'gone', t1.id, t2.id] }, null, { name: 'no id' }, { id: 'a2', name: 7, teacherIds: 'x' }];
  M.migrate(s);
  eq(s.associations, [{ id: 'a1', name: 'Team', teacherIds: [t1.id, t2.id] }, { id: 'a2', name: 'Association', teacherIds: [] }]);
  assert.ok(hasMsg(s, /warn: Associated timetable “Association” needs at least two teachers/), msgs(s).join('\n'));
  assert.ok(!hasMsg(s, /“Team” needs/));
  eq(M.migrate({ settings: M.emptyState().settings, teachers: [], classes: [], rooms: [], subjects: [], lessons: [] }).associations, []);
  assert.ok(M.sampleState().associations.length === 1);
});
check('(ab) meetings and duties with Counts add to the teacher’s load against max periods/day', () => {
  const s = school('tttt', 2);
  const subj = add.subject(s), t = add.teacher(s, 'T'), c = add.cls(s);
  t.maxPerDay = 2;
  add.lesson(s, subj, t, [c], 3, 1);
  s.meetings.push({ id: 'm1', name: 'Sync', teacherIds: [t.id], sessions: 1, length: 1, room: '', allowed: [] });
  s.duties.push({ id: 'd1', name: 'Library', kind: 'teaching', maxPerSlot: 1, allowed: [], assignments: [{ teacherId: t.id, hours: 1 }] });
  M.migrate(s);
  eq([s.meetings[0].countLoad, s.duties[0].countLoad], [false, false]);
  eq([M.workload(s).tl[t.id]], [3]);
  s.meetings[0].countLoad = true; s.duties[0].countLoad = true;
  eq([M.workload(s).tl[t.id]], [5], '3 lessons + a meeting + a duty hour');
  assert.ok(hasMsg(s, /err: T teaches 5 periods but max 2\/day allows only 4/), msgs(s).join('\n'));
  s.duties[0].kind = 'break'; s.settings.periods[1].type = 'break'; s.settings.periods[1].label = 'Break'; M.migrate(s);
  eq([M.workload(s).tl[t.id]], [4], 'break supervision does not count');
});
check('(f) sampleState() still validates clean and has lengths on every row', () => {
  const s = M.sampleState();
  assert.ok(s.lessons.every((l) => M.isLengths(l.lengths) && !('sessions' in l)));
  eq(msgs(s), []);
  assert.strictEqual(M.validate(s).units, s.lessons.reduce((n, l) => n + l.lengths.length, 0) - 2 + s.meetings.length + 2 * 5 + 2 * 6 + s.activities.reduce((n, x) => n + x.periods, 0), 'one unit per length (the parallel pair merges), plus meetings, duty hours and activity periods');
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
