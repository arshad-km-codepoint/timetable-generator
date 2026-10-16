// Fast engine unit tests: period classes (teaching/break/lunch), the general template
// (settings.blocked), break-supervision duties, doubles that straddle a break, and gap
// counting by segment. Usage (from the app folder): node tests/engine.js
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');

const ctx = { window: {}, performance, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'solver.js'), 'utf8'), ctx);
const { Engine, Solver } = ctx.window.Timetable;

// ---------- builder (same state shape as tests/scenarios.js) ----------
let seq = 0;
const id = (p) => `${p}${(++seq).toString(36)}`;
const TYPES = { t: 'teaching', b: 'break', l: 'lunch' };
// school({ days: 2, periods: 'ttbtt' }) → periods typed by letter; a number means all teaching;
// an array of period objects is used as is.
function school({ days = 1, periods = 4, blocked = [], options } = {}) {
  const dayNames = Array.isArray(days) ? days : Array.from({ length: days }, (_, i) => `Day ${i + 1}`);
  const list = Array.isArray(periods) ? periods
    : typeof periods === 'number' ? Array.from({ length: periods }, () => 't')
      : periods.split('');
  const ps = list.map((p, i) => (typeof p === 'object' ? p : { label: String(i + 1), start: '', end: '', type: TYPES[p] || p }));
  const settings = { name: 'Engine test', days: dayNames, periods: ps, weights: {}, attempts: 1, blocked };
  if (options) settings.options = options;
  return { settings, teachers: [], classes: [], rooms: [], subjects: [], lessons: [], meetings: [], duties: [], timetable: { placements: [], generatedAt: null, difficulty: null } };
}
const add = {
  subject: (s, name = 'Subject') => { const x = { id: id('s'), name, code: name.slice(0, 3).toUpperCase(), color: '#2f6fdb' }; s.subjects.push(x); return x; },
  teacher: (s, name = 'Teacher', extra = {}) => { const x = { id: id('t'), name, code: name.slice(0, 3).toUpperCase(), unavailable: [], dispreferred: [], maxPerDay: 0, minPerDay: 0, ...extra }; s.teachers.push(x); return x; },
  cls: (s, name = 'Class', extra = {}) => { const x = { id: id('c'), name, unavailable: [], dispreferred: [], ...extra }; s.classes.push(x); return x; },
  room: (s, name = 'Room', type = 'Classroom') => { const x = { id: id('r'), name, type, unavailable: [], dispreferred: [] }; s.rooms.push(x); return x; },
  lesson: (s, subj, teacher, classes, sessions, length = 1, extra = {}) => {
    const x = { id: id('l'), subjectId: subj.id, teacherId: teacher.id, classIds: classes.map((c) => c.id), sessions, length, room: '', maxOnePerDay: false, parallel: '', ...extra };
    s.lessons.push(x); return x;
  },
  meeting: (s, name, teachers, extra = {}) => { const x = { id: id('m'), name, teacherIds: teachers.map((t) => t.id), sessions: 1, length: 1, room: '', allowed: [], ...extra }; s.meetings.push(x); return x; },
  duty: (s, name, assignments, extra = {}) => {
    const x = { id: id('d'), name, maxPerSlot: 1, allowed: [], assignments: assignments.map(([t, hours]) => ({ teacherId: t.id, hours })), ...extra };
    s.duties.push(x); return x;
  },
};
const keys = (s, fn) => s.settings.days.flatMap((_, d) => s.settings.periods.map((__, p) => [d, p])).filter(([d, p]) => fn(d, p)).map(([d, p]) => `${d}-${p}`);
const ptype = (s, p) => s.settings.periods[p].type || 'teaching';

function solveAll(s, keep = []) {
  const sv = new Solver(s, keep);
  let r; do { r = sv.run(5000); } while (r.phase !== 'done');
  return { engine: sv.e, placements: sv.e.placements(), solver: sv, placed: r.placed, total: r.total };
}
// Cells as the UI/auditor would derive them from a saved placement (independent of engine internals).
function cellsOf(s, pl, allowBreak) {
  const out = []; let p = pl.period;
  while (out.length < pl.len && p < s.settings.periods.length) {
    if (ptype(s, p) === 'teaching' || !allowBreak) out.push(p);
    p++;
  }
  return out;
}

// ---------- harness ----------
// Engine objects come from another vm realm; structuredClone re-creates them in this realm so
// deepStrictEqual compares values (Sets, Maps and typed arrays included) rather than prototypes.
const eq = (a, b, msg) => assert.deepStrictEqual(structuredClone(a), structuredClone(b), msg);
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${(e && e.message || String(e)).split('\n').join('\n       ')}`); }
}

// ---------- tests ----------
check('(a) lessons never sit on a break; doubles without allowBreakInside never straddle it', () => {
  const s = school({ days: 2, periods: 'tttbtt' });
  const subj = add.subject(s), t = add.teacher(s), c = add.cls(s);
  add.lesson(s, subj, t, [c], 4, 2); // only (0,1)/(1,2) and (4,5) are legal → exactly 2 per day
  const { placements, placed, total } = solveAll(s);
  assert.strictEqual(total, 4);
  assert.strictEqual(placed, 4, 'all four doubles fit around the break');
  for (const pl of placements) {
    const cells = cellsOf(s, pl, false);
    assert.strictEqual(cells.length, 2);
    for (const p of cells) assert.strictEqual(ptype(s, p), 'teaching', `${pl.unitId} uses period ${p}`);
  }
});

check('(b) a double with allowBreakInside straddles the break and skips it', () => {
  const s = school({ days: 1, periods: 'tttbtt' });
  const subj = add.subject(s), c = add.cls(s);
  const t = add.teacher(s, 'T', { unavailable: keys(s, (d, p) => p !== 2 && p !== 4) }); // only 2 and 4 are free
  const l = add.lesson(s, subj, t, [c], 1, 2, { allowBreakInside: true });
  const e0 = new Engine(s, []);
  eq(e0.units[0].starts, [2], 'the only legal start is period 2');
  eq(e0.cellsAt(0, 2), [2, 4]);
  assert.strictEqual(e0.cellsAt(0, 1), null);
  const { engine, placements, placed } = solveAll(s);
  assert.strictEqual(placed, 1);
  eq(placements.map((p) => [p.unitId, p.day, p.period, p.len]), [[`${l.id}#0`, 0, 2, 2]]);
  eq(engine.pos[0].cells, [2, 4]);
  eq(engine.pos[0].span, [2, 3, 4], 'the skipped break is held');
  const occ = engine.occ['t' + t.id];
  assert.strictEqual(occ[2], 0); assert.strictEqual(occ[3], 0); assert.strictEqual(occ[4], 0);
  assert.strictEqual(engine.occ['c' + c.id][3], 0);
  eq(engine.dayStats(occ, 0), { gaps: 0, n: 2 }, 'the held break is not a period');
});

check('(b2) without allowBreakInside the same double is impossible', () => {
  const s = school({ days: 1, periods: 'tttbtt' });
  const subj = add.subject(s), c = add.cls(s);
  const t = add.teacher(s, 'T', { unavailable: keys(s, (d, p) => p !== 2 && p !== 4) });
  add.lesson(s, subj, t, [c], 1, 2);
  const e = new Engine(s, []);
  eq(e.units[0].starts, []);
  assert.strictEqual(e.cellsAt(0, 2), null);
});

check('(b3) a flagged double may straddle a break but never lunch', () => {
  const s = school({ days: 1, periods: 'ttlttbt' });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T');
  add.lesson(s, subj, t, [c], 1, 2, { allowBreakInside: true });
  const e = new Engine(s, []);
  eq(e.units[0].starts, [0, 3, 4], 'starts 0-1, 3-4 and 4-6 (across the break); never 1-3 across lunch');
  assert.strictEqual(e.cellsAt(0, 1), null);
  eq(e.cellsAt(0, 4), [4, 6]);
  for (const st of e.units[0].starts) {
    const cells = e.cellsAt(0, st);
    for (let p = cells[0] + 1; p < cells[1]; p++) assert.notStrictEqual(ptype(s, p), 'lunch', `start ${st} puts lunch inside the double`);
  }
});

check('(c) general template: blocked keys are never used by lessons, meetings or teaching duties', () => {
  const s = school({ days: 2, periods: 4, blocked: ['0-1', '1-2'] });
  const subj = add.subject(s), c = add.cls(s), t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B');
  add.lesson(s, subj, t1, [c], 3, 1);            // t1: 3 lessons + 1 meeting = 4 of 6 free slots
  add.meeting(s, 'Dept', [t1, t2]);
  add.duty(s, 'On call', [[t2, 5]]);             // t2: 5 duty hours + 1 meeting = all 6 free slots
  const { engine, placements, placed, total } = solveAll(s);
  assert.strictEqual(total, 9);
  assert.strictEqual(placed, 9, 'everything fits in the non-blocked slots');
  for (const pl of placements) assert.ok(!['0-1', '1-2'].includes(`${pl.day}-${pl.period}`), `${pl.unitId} on blocked slot`);
  eq([...engine.general].sort(), [1, 6]);
  const svc = engine.services[s.duties[0].id];
  assert.ok(!svc.allowed.has(1) && !svc.allowed.has(6), 'duty coverage ignores general-blocked slots');
  for (const u of engine.units) for (const st of u.starts) assert.ok(st !== 1 && st !== 6, `${u.id} may start on a blocked slot`);
});

check('(d) break duties only on break periods, teaching duties never on break/lunch', () => {
  const s = school({ days: 2, periods: 'ttbtlt' });
  const t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B'), t3 = add.teacher(s, 'C');
  const bd = add.duty(s, 'Playground', [[t1, 2], [t2, 2]], { kind: 'break', maxPerSlot: 2 });
  const td = add.duty(s, 'On call', [[t3, 8]], { kind: 'teaching' });
  const { engine, placements, placed, total } = solveAll(s);
  assert.strictEqual(total, 12);
  assert.strictEqual(placed, 12);
  for (const pl of placements) {
    const did = pl.unitId.split(':')[1];
    if (did === bd.id) assert.strictEqual(ptype(s, pl.period), 'break', `${pl.unitId} on ${pl.period}`);
    else assert.strictEqual(ptype(s, pl.period), 'teaching', `${pl.unitId} on ${pl.period}`);
  }
  eq([...engine.services[bd.id].allowed].sort((a, b) => a - b), [2, 8]);
  eq([...engine.services[td.id].allowed].sort((a, b) => a - b), [0, 1, 3, 5, 6, 7, 9, 11]);
  assert.strictEqual(engine.totalCost().dutyUncovered, 0);
});

check('(d2) a break duty restricted by allowed keys and an empty break-less school', () => {
  const s = school({ days: 2, periods: 'ttbtlt' });
  const t1 = add.teacher(s, 'A');
  const bd = add.duty(s, 'Gate', [[t1, 1]], { kind: 'break', allowed: ['1-2', '1-3'] });
  const e = new Engine(s, []);
  eq([...e.services[bd.id].allowed], [8]);
  eq(e.units[0].starts, [8]);
  const s2 = school({ days: 1, periods: 4 });
  const t = add.teacher(s2, 'A');
  add.duty(s2, 'Gate', [[t, 1]], { kind: 'break' });
  const e2 = new Engine(s2, []);
  eq(e2.units[0].starts, [], 'no break periods → no legal slot');
});

function dayStatsSchool(periods, options) {
  const s = school({ days: 1, periods, options });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T');
  const a = add.lesson(s, subj, t, [c], 1, 1), b = add.lesson(s, subj, t, [c], 1, 1);
  return { s, t, c, a, b };
}
const put = (l, p) => ({ unitId: `${l.id}#0`, day: 0, period: p, len: 1, rooms: [null], locked: false });

check('(e) dayStats: lessons either side of a break make no gap', () => {
  const { s, t, c, a, b } = dayStatsSchool('ttbtt');
  const e = new Engine(s, [put(a, 1), put(b, 3)]);
  assert.strictEqual(e.placements().length, 2);
  eq(e.dayStats(e.occ['t' + t.id], 0), { gaps: 0, n: 2 });
  eq(e.dayStats(e.occ['c' + c.id], 0), { gaps: 0, n: 2 });
  const e2 = new Engine(s, [put(a, 0), put(b, 4)]);
  eq(e2.dayStats(e2.occ['t' + t.id], 0), { gaps: 2, n: 2 }, 'periods 1 and 3 are gaps, the break is not');
  assert.strictEqual(e2.totalCost().teacherGaps, 2);
});

check('(e2) dayStats: lunch splits the day unless countMiddayGap', () => {
  const { s, t, a, b } = dayStatsSchool('ttltt');
  const e = new Engine(s, [put(a, 1), put(b, 3)]);
  eq(e.dayStats(e.occ['t' + t.id], 0), { gaps: 0, n: 2 });
  eq(e.segments[0], [[0, 1], [3, 4]]);
  const m = dayStatsSchool('ttltt', { countMiddayGap: true });
  const e2 = new Engine(m.s, [put(m.a, 1), put(m.b, 3)]);
  assert.ok(e2.dayStats(e2.occ['t' + m.t.id], 0).gaps > 0, 'lunch between lessons counts when the option is on');
  assert.strictEqual(e2.dayStats(e2.occ['t' + m.t.id], 0).n, 2);
  const e3 = new Engine(m.s, [put(m.a, 0), put(m.b, 1)]);
  eq(e3.dayStats(e3.occ['t' + m.t.id], 0), { gaps: 0, n: 2 }, 'a free afternoon is not a gap');
});

check('(e3) a straddling double creates no gap and costs late periods by its last cell', () => {
  const s = school({ days: 1, periods: 'ttbtt' });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T');
  const l = add.lesson(s, subj, t, [c], 1, 2, { allowBreakInside: true });
  const e = new Engine(s, [{ unitId: `${l.id}#0`, day: 0, period: 1, len: 2, rooms: [null], locked: false }]);
  eq(e.pos[0].cells, [1, 3]);
  eq(e.dayStats(e.occ['t' + t.id], 0), { gaps: 0, n: 2 });
  assert.strictEqual(e.unitCost(0), e.W.late * 3);
});

check('(f) placements() round-trips through new Engine(data, placements), including straddling doubles', () => {
  // Every double here must straddle a break: the only double starts are 0 (cells 0,2) and 4 (cells 4,6).
  const s = school({ days: 3, periods: 'tbtltbt', blocked: ['2-5', '2-6'] });
  const subj = add.subject(s), r1 = add.room(s, 'R1', 'Lab'), r2 = add.room(s, 'R2', 'Lab');
  const c1 = add.cls(s, 'C1'), c2 = add.cls(s, 'C2');
  const t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B'), t3 = add.teacher(s, 'C');
  add.lesson(s, subj, t1, [c1], 2, 2, { allowBreakInside: true, room: 'type:Lab' });
  add.lesson(s, subj, t2, [c2], 2, 2, { allowBreakInside: true, room: 'type:Lab' });
  add.lesson(s, subj, t2, [c1], 3, 1);
  add.lesson(s, subj, t1, [c2], 3, 1);
  add.meeting(s, 'All', [t1, t2, t3]);
  add.duty(s, 'Playground', [[t3, 3]], { kind: 'break', maxPerSlot: 1 });
  add.duty(s, 'On call', [[t3, 4]]);
  const { engine, placements, placed, total } = solveAll(s);
  assert.strictEqual(placed, total, `all ${total} units placed`);
  const doubles = placements.filter((pl) => pl.len === 2);
  assert.strictEqual(doubles.length, 4);
  for (const pl of doubles) {
    assert.ok(pl.period === 0 || pl.period === 4, `${pl.unitId} starts at ${pl.period}`);
    assert.strictEqual(ptype(s, pl.period + 1), 'break');
    eq(engine.pos[engine.unitById[pl.unitId].i].cells, [pl.day * 7 + pl.period, pl.day * 7 + pl.period + 2]);
  }
  const e2 = new Engine(s, placements);
  const sort = (ps) => ps.slice().sort((x, y) => x.unitId.localeCompare(y.unitId));
  eq(sort(e2.placements()), sort(placements));
  engine.units.forEach((u, i) => {
    const j = e2.unitById[u.id].i;
    eq(e2.pos[j].cells, engine.pos[i].cells, `cells of ${u.id}`);
    eq(e2.pos[j].rooms, engine.pos[i].rooms);
  });
  for (const key in engine.occ) eq([...e2.occ[key]], [...engine.occ[key]], `occupancy ${key}`);
  eq(e2.totalCost(), engine.totalCost());
});

check('(g) teacher, class and room stay busy during the break inside a straddling double', () => {
  const s = school({ days: 1, periods: 'ttttbt' }); // break at 4; the double sits at 3 and 5
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T'), r = add.room(s, 'Lab', 'Lab');
  const l = add.lesson(s, subj, t, [c], 1, 2, { allowBreakInside: true, room: 'type:Lab' });
  const bd = add.duty(s, 'Playground', [[t, 1]], { kind: 'break' });
  const lessonPl = { unitId: `${l.id}#0`, day: 0, period: 3, len: 2, rooms: [r.id], locked: false };
  const dutyPl = { unitId: `d:${bd.id}:${t.id}#0`, day: 0, period: 4, len: 1, rooms: [null], locked: false };
  const e = new Engine(s, [lessonPl]);
  const li = e.unitById[lessonPl.unitId].i, di = e.unitById[dutyPl.unitId].i;
  eq(e.pos[li].cells, [3, 5]); eq(e.pos[li].span, [3, 4, 5]);
  eq(e.cellsAt(li, 3), [3, 5]); eq(e.spanAt(li, 3), [3, 4, 5]); eq(e.spanAt(li, 0), [0, 1]);
  for (const key of ['t' + t.id, 'c' + c.id, 'r' + r.id]) assert.strictEqual(e.occ[key][4], li, `${key} held at the break`);
  eq([...e.baseConflicts(di, 4)], [li], 'the break duty must evict the lesson');
  e.locked[li] = true;
  assert.ok([...e.baseConflicts(di, 4)].some((o) => e.locked[o]), 'a locked lesson blocks the duty (Solver/UI refuse locked conflicts)');
  e.remove(li);
  for (const key of ['t' + t.id, 'c' + c.id, 'r' + r.id]) assert.strictEqual(e.occ[key][4], -1, `${key} freed at the break`);
  // The other way round: the duty is there first, so the straddling double must evict it.
  const e2 = new Engine(s, [dutyPl]);
  assert.strictEqual(e2.pos[di].s, 4);
  eq([...e2.baseConflicts(li, 3)], [di]);
  eq([...e2.baseConflicts(li, 0)], [], 'a non-straddling start does not touch the duty');
  // The solver never produces the combination: both doubles are forced to straddle, so the
  // teacher's break duty has no free break left and one unit stays unplaced.
  const s3 = school({ days: 2, periods: 'tttbtt' });
  const subj3 = add.subject(s3), t3 = add.teacher(s3, 'T');
  const c3 = add.cls(s3, 'C', { unavailable: keys(s3, (d, p) => p !== 2 && p !== 4) });
  add.lesson(s3, subj3, t3, [c3], 2, 2, { allowBreakInside: true, maxOnePerDay: true });
  add.duty(s3, 'Playground', [[t3, 1]], { kind: 'break' });
  const { placements, placed, total } = solveAll(s3);
  assert.strictEqual(total, 3); assert.strictEqual(placed, 2);
  const lessonDays = placements.filter((pl) => pl.len === 2).map((pl) => (assert.strictEqual(pl.period, 2), pl.day));
  for (const pl of placements.filter((pl) => pl.unitId.startsWith('d:'))) assert.ok(!lessonDays.includes(pl.day), 'break duty inside the straddling double');
});

check('(h) a straddling double counts as two periods for n and max/day, not three', () => {
  const s = school({ days: 1, periods: 'ttttbt' }); // break at 4; the double sits at 3 and 5
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T', { maxPerDay: 3, minPerDay: 3 });
  const dbl = add.lesson(s, subj, t, [c], 1, 2, { allowBreakInside: true });
  const single = add.lesson(s, subj, t, [c], 1, 1);
  const pl = [{ unitId: `${dbl.id}#0`, day: 0, period: 3, len: 2, rooms: [null], locked: false }];
  const e = new Engine(s, pl);
  const di = e.unitById[`${dbl.id}#0`].i, si = e.unitById[`${single.id}#0`].i;
  eq(e.dayStats(e.occ['t' + t.id], 0), { gaps: 0, n: 2 });
  eq(e.dayStats(e.occ['c' + c.id], 0), { gaps: 0, n: 2 });
  assert.strictEqual(e.totalCost().teacherMin, 1, 'n=2 is below min/day 3');
  eq([...e.baseConflicts(si, 0)], [], 'load 2 + 1 fits max/day 3');
  e.place(si, 0, [null]);
  eq(e.dayStats(e.occ['t' + t.id], 0), { gaps: 2, n: 3 });
  assert.strictEqual(e.totalCost().teacherMin, 0);
  t.maxPerDay = 2;
  const e2 = new Engine(s, pl);
  eq([...e2.baseConflicts(si, 0)], [di], 'with max/day 2 the double must leave');
  eq([...e2.baseConflicts(si, 5)], [di], 'a cell of the double is just as busy');
});

check('parallel group where only one row allows a break inside never straddles', () => {
  const s = school({ days: 1, periods: 'tttbtt' });
  const subj = add.subject(s), c1 = add.cls(s, 'C1'), c2 = add.cls(s, 'C2'), t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B');
  add.lesson(s, subj, t1, [c1], 1, 2, { parallel: 'opt', allowBreakInside: true });
  add.lesson(s, subj, t2, [c2], 1, 2, { parallel: 'opt' });
  const e = new Engine(s, []);
  assert.strictEqual(e.units.length, 1);
  assert.strictEqual(e.units[0].allowBreak, false);
  eq(e.units[0].starts, [0, 1, 4]);
});

check('a lesson longer than the longest teaching run has no starts and is reported impossible', () => {
  const s = school({ days: 1, periods: 'ttbt' });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T');
  add.lesson(s, subj, t, [c], 1, 3);
  const e = new Engine(s, []);
  eq(e.units[0].starts, []);
  const sv = new Solver(s, []);
  eq(sv.impossible, [0]);
  const { placed } = solveAll(s);
  assert.strictEqual(placed, 0);
});

check('a meeting whose allowed keys are all break/lunch has no starts', () => {
  const s = school({ days: 1, periods: 'ttbl' });
  const t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B');
  add.meeting(s, 'Staff', [t1, t2], { allowed: ['0-2', '0-3'] });
  const e = new Engine(s, []);
  eq(e.units[0].starts, []);
  add.meeting(s, 'Staff 2', [t1, t2], { allowed: ['0-1', '0-2'] });
  eq(new Engine(s, []).units[1].starts, [1], 'teaching keys among them still count');
});

check('slots() ignores malformed or out-of-range keys', () => {
  const s = school({ days: 1, periods: 4, blocked: ['0-1', 'x-y', '', '3-0', '0-9', '0-1-1'] });
  const t = add.teacher(s, 'T', { unavailable: ['0-2', undefined, 'bad', '-1-0'] });
  const e = new Engine(s, []);
  eq([...e.general], [1]);
  eq([...e.blocked['t' + t.id]], [2]);
});

check('legacy data (no period types, no blocked, no kinds) behaves as all-teaching', () => {
  const s = school({ days: 2, periods: 4 });
  delete s.settings.blocked;
  s.settings.periods.forEach((p) => delete p.type);
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T');
  add.lesson(s, subj, t, [c], 3, 2);
  add.duty(s, 'On call', [[t, 2]]);
  const e = new Engine(s, []);
  eq([...e.teach], [1, 1, 1, 1, 1, 1, 1, 1]);
  eq(e.units[0].starts, [0, 1, 2, 4, 5, 6]);
  assert.strictEqual(e.services[s.duties[0].id].allowed.size, 8);
  const { placed, total } = solveAll(s);
  assert.strictEqual(placed, total);
});

// ---------- Phase 2: lengths, flexible distributions, rooms, relations, row options ----------
const pl = (l, k, day, period, len, rooms = [null]) => ({ unitId: `${l.id}#${k}`, day, period, len, rooms, locked: false });
const unitsOf = (e, l) => e.groupUnits[e.lessonGroup[l.id]].map((i) => e.units[i]);
const placedOf = (placements, l) => placements.filter((p) => p.unitId.split('#')[0].split('+').includes(l.id));

check('lengths: one unit per entry, ids in entry order, legacy sessions/length still derived', () => {
  const s = school({ days: 2, periods: 6 });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T');
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [2, 2, 1] });
  const legacy = add.lesson(s, subj, t, [c], 3, 2);
  const e = new Engine(s, []);
  eq(e.problems, []);
  eq(unitsOf(e, l).map((u) => [u.id, u.len, u.k]), [[`${l.id}#0`, 2, 0], [`${l.id}#1`, 2, 1], [`${l.id}#2`, 1, 2]]);
  eq(e.groupLengths[l.id], [2, 2, 1]);
  eq(unitsOf(e, legacy).map((u) => u.len), [2, 2, 2], 'no lengths → sessions × length');
  const single = unitsOf(e, l)[2], dbl = unitsOf(e, l)[0];
  assert.strictEqual(single.starts.length, 12); assert.strictEqual(dbl.starts.length, 10);
  const { placed, total } = solveAll(s);
  assert.strictEqual(total, 6); assert.strictEqual(placed, total);
  s.lessons[0].lengths = [2, 0];
  assert.ok(new Engine(s, []).problems.some((p) => p.lessonIds[0] === l.id && /length/.test(p.msg)), 'a 0 length is a data problem');
  s.lessons[0].lengths = [7];
  assert.ok(new Engine(s, []).problems.some((p) => /length outside 1–6/.test(p.msg)), 'longer than the day is a data problem');
});

check('empty rows (0 sessions, lengths [], 0-session meeting) and a deleted preferred room stay harmless', () => {
  const s = school({ days: 1, periods: 3 });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T'), r = add.room(s, 'R', 'Classroom');
  add.lesson(s, subj, t, [c], 0, 1);
  add.lesson(s, subj, t, [c], 0, 1, { lengths: [] });
  const gone = add.lesson(s, subj, t, [c], 1, 1, { room: 'deleted-room', roomAlt: 'type:Classroom' });
  add.meeting(s, 'Never', [t], { sessions: 0 });
  const e = new Engine(s, []);
  eq(e.problems, []);
  assert.strictEqual(e.units.length, 1);
  assert.strictEqual(e.units[0].parts[0].prefRoom, null, 'a missing preferred room is not a preference');
  eq(e.units[0].parts[0].roomCands, [r.id]);
  const { placed, engine } = solveAll(s);
  assert.strictEqual(placed, 1);
  const st = engine.totalCost();
  assert.strictEqual(st.roomPref, 0); assert.strictEqual(st.roomSame, 0);
  void gone;
});

check('lengths: parallel rows need the same multiset; order does not matter', () => {
  const s = school({ days: 2, periods: 5 });
  const subj = add.subject(s), c1 = add.cls(s, 'C1'), c2 = add.cls(s, 'C2'), t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B');
  const a = add.lesson(s, subj, t1, [c1], 0, 1, { parallel: 'opt', lengths: [2, 1] });
  const b = add.lesson(s, subj, t2, [c2], 0, 1, { parallel: 'opt', lengths: [1, 2] });
  const e = new Engine(s, []);
  eq(e.problems, []);
  assert.strictEqual(e.units.length, 2);
  eq(e.units.map((u) => u.len), [2, 1]);
  b.lengths = [1, 1, 1];
  const e2 = new Engine(s, []);
  assert.strictEqual(e2.units.length, 0);
  eq(e2.problems.map((p) => p.lessonIds), [[a.id, b.id]]);
  assert.ok(/different session lengths/.test(e2.problems[0].msg));
});

check('flexible: a valid partition is chosen, exposed, and varies between attempts', () => {
  const s = school({ days: 3, periods: 4 });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T');
  const l = add.lesson(s, subj, t, [c], 0, 1, { flexible: { total: 5, min: 1, max: 2 } });
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const e = new Engine(s, []);
    eq(e.problems, []);
    const lens = e.groupLengths[l.id];
    assert.strictEqual(lens.reduce((a, b) => a + b, 0), 5);
    assert.ok(lens.every((n) => n >= 1 && n <= 2), `blocks within 1..2: ${lens}`);
    eq(unitsOf(e, l).map((u) => u.len), lens);
    seen.add(lens.join(','));
  }
  assert.ok(seen.size > 1, `attempts differ: ${[...seen]}`);
  assert.ok([...seen].some((k) => k.split(',').length === 3), 'three blocks (the fewest) is among the choices');
  const { placed, total, engine } = solveAll(s);
  assert.strictEqual(placed, total);
  assert.strictEqual(engine.placements().reduce((a, p) => a + p.len, 0), 5);
});

check('flexible: placements restore the distribution; a bad remainder restarts; an impossible total is reported', () => {
  const s = school({ days: 3, periods: 4 });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T');
  const l = add.lesson(s, subj, t, [c], 0, 1, { flexible: { total: 6, min: 1, max: 3 } });
  const keep = [pl(l, 0, 0, 0, 3), pl(l, 2, 1, 0, 2)];
  for (let i = 0; i < 20; i++) {
    const e = new Engine(s, keep);
    const lens = e.groupLengths[l.id];
    assert.strictEqual(lens[0], 3); assert.strictEqual(lens[2], 2); assert.strictEqual(lens[1], 1);
    eq(lens, [3, 1, 2]);
    eq(e.placements().map((p) => [p.unitId, p.day, p.period, p.len]), [[`${l.id}#0`, 0, 0, 3], [`${l.id}#2`, 1, 0, 2]], 'both kept placements are restored');
  }
  const full = solveAll(s).placements;
  const e2 = new Engine(s, full);
  eq(e2.placements().slice().sort((a, b) => a.unitId.localeCompare(b.unitId)), full.slice().sort((a, b) => a.unitId.localeCompare(b.unitId)));
  // Placed lengths exceeding the total cannot be completed: partition from scratch, nothing restored.
  const e3 = new Engine(s, [pl(l, 0, 0, 0, 3), pl(l, 1, 1, 0, 3), pl(l, 2, 2, 0, 3)]);
  assert.strictEqual(e3.groupLengths[l.id].reduce((a, b) => a + b, 0), 6);
  assert.ok(e3.placements().length < 3);
  // A kept unit with a high index: the remainder takes enough blocks for that index to exist.
  for (let i = 0; i < 20; i++) {
    const e6 = new Engine(s, [pl(l, 5, 2, 1, 1)]);
    eq(e6.groupLengths[l.id], [1, 1, 1, 1, 1, 1]);
    eq(e6.placements().map((p) => p.unitId), [`${l.id}#5`]);
    const e7 = new Engine(s, [pl(l, 3, 2, 1, 1)]);
    assert.strictEqual(e7.groupLengths[l.id][3], 1);
    assert.ok(e7.groupLengths[l.id].length >= 4 && e7.groupLengths[l.id].length <= 6);
    eq(e7.placements().map((p) => p.unitId), [`${l.id}#3`]);
  }
  // A remainder that cannot be split (total 6, one block of 1 placed, blocks must be 3): from scratch.
  l.flexible = { total: 6, min: 3, max: 3 };
  const e4 = new Engine(s, [pl(l, 0, 0, 0, 1)]);
  eq(e4.groupLengths[l.id], [3, 3]); eq(e4.placements(), []);
  l.flexible = { total: 5, min: 3, max: 4 };
  const e5 = new Engine(s, []);
  assert.strictEqual(e5.units.length, 0);
  assert.ok(e5.problems.some((p) => p.lessonIds[0] === l.id && /cannot be split/.test(p.msg)));
  l.flexible = { total: 4, min: 2, max: 1 };
  assert.ok(new Engine(s, []).problems.some((p) => /invalid flexible/.test(p.msg)));
});

check('flexible rows in a parallel group follow the fixed row (or each other)', () => {
  const s = school({ days: 3, periods: 4 });
  const subj = add.subject(s), c1 = add.cls(s, 'C1'), c2 = add.cls(s, 'C2'), t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B'), t3 = add.teacher(s, 'C');
  add.lesson(s, subj, t1, [c1], 0, 1, { parallel: 'g', lengths: [2, 1, 1] });
  add.lesson(s, subj, t2, [c2], 0, 1, { parallel: 'g', flexible: { total: 4, min: 1, max: 2 } });
  const e = new Engine(s, []);
  eq(e.problems, []); assert.strictEqual(e.units.length, 3);
  eq(e.units.map((u) => u.len), [2, 1, 1]);
  const s2 = school({ days: 3, periods: 4 });
  add.lesson(s2, subj, t1, [c1], 0, 1, { parallel: 'g', flexible: { total: 4, min: 1, max: 2 } });
  add.lesson(s2, subj, t3, [c2], 0, 1, { parallel: 'g', flexible: { total: 4, min: 1, max: 2 } });
  s2.subjects.push(subj); s2.classes.push(c1, c2); s2.teachers.push(t1, t3);
  for (let i = 0; i < 10; i++) { const e2 = new Engine(s2, []); eq(e2.problems, []); assert.ok(e2.units.length >= 2); }
});

check('rooms: the preferred room is used when free, the alternative set when busy, roomPref counted', () => {
  const s = school({ days: 1, periods: 2 });
  const subj = add.subject(s), c1 = add.cls(s, 'C1'), c2 = add.cls(s, 'C2'), t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B');
  const r1 = add.room(s, 'R1', 'Classroom'), r2 = add.room(s, 'R2', 'Classroom'), r3 = add.room(s, 'R3', 'Lab');
  const a = add.lesson(s, subj, t1, [c1], 1, 1, { room: r1.id, roomAlt: 'type:Classroom' });
  const b = add.lesson(s, subj, t2, [c2], 1, 1, { room: r1.id });
  const e = new Engine(s, []);
  eq(e.roomCandidates(r1.id, s.rooms, 'type:Classroom'), [r1.id, r2.id], 'preferred first, then the rest of the type');
  eq(e.roomCandidates('type:Lab', s.rooms, 'type:Classroom'), [r3.id, r1.id, r2.id]);
  eq(e.roomCandidates(r1.id, s.rooms, ''), [r1.id]);
  const ai = e.unitById[`${a.id}#0`].i, bi = e.unitById[`${b.id}#0`].i;
  eq(e.bestRooms(ai, 0, new Set()).rooms, [r1.id], 'free → preferred');
  e.place(bi, 0, [r1.id]);
  const pick = e.bestRooms(ai, 0, new Set());
  eq(pick.rooms, [r2.id]); assert.strictEqual(pick.conf.size, 0, 'the alternative is taken rather than evicting');
  e.place(ai, 0, pick.rooms);
  assert.strictEqual(e.unitCost(ai), e.W.roomPref);
  assert.strictEqual(e.unitCost(bi), 0);
  assert.strictEqual(e.totalCost().roomPref, 1);
  e.remove(ai);
  eq(e.bestRooms(ai, 1, new Set()).rooms, [r1.id], 'at another time the preferred room wins again');
  assert.ok(e.roomsValid(ai, 0, [r2.id]) && !e.roomsValid(ai, 0, [r3.id]));
  const { placements, placed } = solveAll(s);
  assert.strictEqual(placed, 2);
  assert.strictEqual(placedOf(placements, a)[0].rooms[0], r1.id, 'with two periods free, both rows get R1');
});

check('sameRoom: hard over a full solve (and in roomsValid/bestRooms); roomSame soft count', () => {
  const s = school({ days: 2, periods: 3 });
  const subj = add.subject(s), c1 = add.cls(s, 'C1'), c2 = add.cls(s, 'C2'), t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B');
  const l1 = add.room(s, 'Lab 1', 'Lab'), l2 = add.room(s, 'Lab 2', 'Lab');
  const a = add.lesson(s, subj, t1, [c1], 4, 1, { room: 'type:Lab', sameRoom: true });
  const b = add.lesson(s, subj, t2, [c2], 4, 1, { room: 'type:Lab' });
  for (let i = 0; i < 5; i++) {
    const { placements, placed, total, engine } = solveAll(s);
    assert.strictEqual(placed, total);
    assert.strictEqual(new Set(placedOf(placements, a).map((p) => p.rooms[0])).size, 1, 'all four sessions in one lab');
    assert.strictEqual(engine.groupStats(a.id).roomSame, 0);
  }
  const e = new Engine(s, [pl(a, 0, 0, 0, 1, [l1.id])]);
  const a1 = e.unitById[`${a.id}#1`].i;
  assert.ok(e.roomsValid(a1, 1, [l1.id]) && !e.roomsValid(a1, 1, [l2.id]));
  eq(e.bestRooms(a1, 1, new Set()).rooms, [l1.id]);
  e.place(e.unitById[`${b.id}#0`].i, 1, [l1.id]);
  const pick = e.bestRooms(a1, 1, new Set());
  eq(pick.rooms, [l1.id]); assert.strictEqual(pick.conf.size, 1, 'the only candidate is the group room, even if that means evicting');
  // Soft: a row without sameRoom still pays per extra room.
  const e2 = new Engine(s, [pl(b, 0, 0, 0, 1, [l1.id]), pl(b, 1, 0, 1, 1, [l2.id]), pl(b, 2, 1, 0, 1, [l1.id])]);
  assert.strictEqual(e2.placements().length, 3);
  assert.strictEqual(e2.totalCost().roomSame, 1);
  assert.strictEqual(e2.groupCost(b.id), e2.W.roomSame);
  assert.strictEqual(e2.areaCost([e2.unitById[`${b.id}#0`].i], [0]) - e2.localCost(e2.unitById[`${b.id}#0`].i, [0]), 0);
  const b3 = e2.unitById[`${b.id}#3`].i;
  eq(e2.bestRooms(b3, 4, new Set()).rooms, [l1.id], 'bestRooms prefers a room the group already uses');
  e2.place(b3, 4, [l2.id]);
  assert.strictEqual(e2.totalCost().roomSame, 1, 'distinct rooms − 1, not per unit');
});

check('relation differentDays holds after solveAll; baseConflicts names the violator', () => {
  const s = school({ days: 2, periods: 4 });
  const subj = add.subject(s), c = add.cls(s), t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B');
  const a = add.lesson(s, subj, t1, [c], 2, 1);
  const b = add.lesson(s, subj, t2, [c], 2, 1, { relations: [{ type: 'differentDays', lessonId: a.id }] });
  for (let i = 0; i < 5; i++) {
    const { placements, placed } = solveAll(s);
    assert.strictEqual(placed, 4);
    const da = new Set(placedOf(placements, a).map((p) => p.day)), db = placedOf(placements, b).map((p) => p.day);
    assert.ok(db.every((d) => !da.has(d)), `A days ${[...da]} vs B days ${db}`);
  }
  const e = new Engine(s, [pl(a, 0, 0, 0, 1)]);
  eq(e.rel[a.id], [{ type: 'differentDays', other: b.id, min: 0, max: null, strict: false, first: null }], 'stored on the row that did not declare it');
  const ai = e.unitById[`${a.id}#0`].i, bi = e.unitById[`${b.id}#0`].i;
  eq([...e.baseConflicts(bi, 1)], [ai]);
  eq([...e.baseConflicts(bi, 5)], []);
  e.locked[ai] = true;
  assert.strictEqual(e.baseConflicts(bi, 1), null, 'a locked violator makes the start impossible');
});

check('relation notSameTime: overlapping spans are refused', () => {
  const s = school({ days: 1, periods: 3 });
  const subj = add.subject(s), c1 = add.cls(s, 'C1'), c2 = add.cls(s, 'C2'), t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B');
  const a = add.lesson(s, subj, t1, [c1], 1, 2, { relations: [{ type: 'notSameTime', lessonId: 'nope' }] });
  const b = add.lesson(s, subj, t2, [c2], 1, 1, { relations: [{ type: 'notSameTime', lessonId: a.id }] });
  b.relations.push({ type: 'notSameTime', lessonId: b.id }, { type: 'bogus', lessonId: a.id });
  for (let i = 0; i < 5; i++) {
    const { placements, placed } = solveAll(s);
    assert.strictEqual(placed, 2);
    const pa = placedOf(placements, a)[0], pb = placedOf(placements, b)[0];
    assert.ok(pb.period < pa.period || pb.period >= pa.period + 2, `double at ${pa.period}, single at ${pb.period}`);
  }
  const e = new Engine(s, [pl(a, 0, 0, 0, 2)]);
  assert.strictEqual(e.rel[b.id].length, 1, 'unknown ids and self-relations are ignored');
  const ai = e.unitById[`${a.id}#0`].i, bi = e.unitById[`${b.id}#0`].i;
  eq([...e.baseConflicts(bi, 0)], [ai]); eq([...e.baseConflicts(bi, 1)], [ai]); eq([...e.baseConflicts(bi, 2)], []);
});

check('relation nonConsecutive: adjacent in teaching order (breaks skipped, lunch separates)', () => {
  const s = school({ days: 1, periods: 'tbtt' });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T');
  const a = add.lesson(s, subj, t, [c], 1, 1);
  const b = add.lesson(s, subj, t, [c], 1, 1, { relations: [{ type: 'nonConsecutive', lessonId: a.id }] });
  for (let i = 0; i < 5; i++) {
    const { placements, placed } = solveAll(s);
    assert.strictEqual(placed, 2);
    eq(placements.map((p) => p.period).sort(), [0, 3], 'periods 0 and 2 are adjacent across the break; only 0 and 3 are not');
  }
  const e = new Engine(s, [pl(a, 0, 0, 0, 1)]);
  const ai = e.unitById[`${a.id}#0`].i, bi = e.unitById[`${b.id}#0`].i;
  eq([...e.baseConflicts(bi, 2)], [ai]); eq([...e.baseConflicts(bi, 3)], []);
  eq([...e.baseConflicts(ai, 3)], [], 'the unit itself is never its own violator');
  const s2 = school({ days: 1, periods: 'tlt' });
  s2.subjects.push(subj); s2.classes.push(c); s2.teachers.push(t);
  const a2 = add.lesson(s2, subj, t, [c], 1, 1, { relations: [{ type: 'nonConsecutive', lessonId: 'later' }] });
  const b2 = add.lesson(s2, subj, t, [c], 1, 1); a2.relations[0].lessonId = b2.id;
  const e2 = new Engine(s2, [pl(a2, 0, 0, 0, 1)]);
  eq([...e2.baseConflicts(e2.unitById[`${b2.id}#0`].i, 2)], [], 'lunch between them: not consecutive');
  assert.strictEqual(solveAll(s2).placed, 2);
});

check('relation consecutive: unit #k of each row sits next to the other (same day, teaching order)', () => {
  const s = school({ days: 2, periods: 'ttbtt' });
  const subj = add.subject(s), c = add.cls(s), t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B');
  const a = add.lesson(s, subj, t1, [c], 2, 1, { maxOnePerDay: true });
  const b = add.lesson(s, subj, t2, [c], 2, 1, { relations: [{ type: 'consecutive', lessonId: a.id }] });
  const filler = add.lesson(s, subj, t1, [c], 2, 1); // competes for the slots so adjacency is not automatic
  for (let i = 0; i < 5; i++) {
    const { placements, placed, engine } = solveAll(s);
    assert.strictEqual(placed, 6, 'everything fits');
    for (let k = 0; k < 2; k++) {
      const pa = placements.find((p) => p.unitId === `${a.id}#${k}`), pb = placements.find((p) => p.unitId === `${b.id}#${k}`);
      assert.strictEqual(pa.day, pb.day);
      const ca = pa.day * 5 + pa.period, cb = pb.day * 5 + pb.period;
      assert.ok(engine.nextTeach[ca] === cb || engine.nextTeach[cb] === ca, `A#${k} at ${pa.period} and B#${k} at ${pb.period} on day ${pa.day}`);
    }
  }
  const e = new Engine(s, [pl(a, 0, 0, 1, 1)]);
  const a0 = e.unitById[`${a.id}#0`].i, b0 = e.unitById[`${b.id}#0`].i, b1 = e.unitById[`${b.id}#1`].i;
  eq([...e.baseConflicts(b0, 3)], [], 'period 3 follows period 1 across the break');
  eq([...e.baseConflicts(b0, 0)], []);
  eq([...e.baseConflicts(b0, 4)], [a0]); eq([...e.baseConflicts(b0, 6)], [a0], 'another day is a violation too');
  eq([...e.baseConflicts(b1, 4)], [], 'B#1 is tied to A#1, not A#0');
  e.locked[a0] = true;
  assert.strictEqual(e.baseConflicts(b0, 4), null);
  b.lengths = [1, 1, 1];
  const e2 = new Engine(s, []);
  assert.ok(e2.problems.some((p) => /consecutively/.test(p.msg) && p.lessonIds.includes(a.id) && p.lessonIds.includes(b.id)));
  eq(e2.rel[a.id], []); eq(e2.rel[b.id], []);
  assert.strictEqual(e2.units.length, 7, 'the rows still produce units');
  void filler;
});

check('relation daysApart: min and max distance in days', () => {
  const s = school({ days: 5, periods: 1 });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T');
  const a = add.lesson(s, subj, t, [c], 1, 1, { relations: [{ type: 'daysApart', lessonId: '', min: 2, max: 3 }] });
  const b = add.lesson(s, subj, t, [c], 1, 1, { relations: [{ type: 'daysApart', lessonId: a.id, min: 2, max: 3 }] });
  a.relations[0].lessonId = b.id; // declared on both sides with the same bounds → one relation
  for (let i = 0; i < 8; i++) {
    const { placements, placed } = solveAll(s);
    assert.strictEqual(placed, 2);
    const diff = Math.abs(placedOf(placements, a)[0].day - placedOf(placements, b)[0].day);
    assert.ok(diff >= 2 && diff <= 3, `days apart ${diff}`);
  }
  const e = new Engine(s, [pl(a, 0, 0, 0, 1)]);
  assert.strictEqual(e.rel[a.id].length, 1); assert.strictEqual(e.rel[b.id].length, 1);
  eq(e.rel[b.id], [{ type: 'daysApart', other: a.id, min: 2, max: 3, strict: false, first: null }]);
  const ai = e.unitById[`${a.id}#0`].i, bi = e.unitById[`${b.id}#0`].i;
  eq([...e.baseConflicts(bi, 1)], [ai]); eq([...e.baseConflicts(bi, 2)], []); eq([...e.baseConflicts(bi, 3)], []); eq([...e.baseConflicts(bi, 4)], [ai]);
  b.relations = [{ type: 'daysApart', lessonId: a.id, min: 0, max: '' }];
  a.relations = [];
  eq(new Engine(s, []).rel[a.id], [], 'no bounds → no relation');
  b.relations = [{ type: 'daysApart', lessonId: a.id, min: 1 }];
  const e3 = new Engine(s, [pl(a, 0, 0, 0, 1)]);
  eq([...e3.baseConflicts(e3.unitById[`${b.id}#0`].i, 0)], [e3.unitById[`${a.id}#0`].i]);
  eq([...e3.baseConflicts(e3.unitById[`${b.id}#0`].i, 4)], []);
});

check('ends: first/last teaching period of the day by segments; consecutiveDays per adjacent-day pair', () => {
  const s = school({ days: 5, periods: 'ttltt', blocked: ['0-0'] });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T');
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1, 1], penalizeEnds: true, avoidConsecutiveDays: true });
  const plain = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1, 1, 1], avoidConsecutiveDays: true });
  const e = new Engine(s, []);
  const u0 = e.unitById[`${l.id}#0`].i;
  const endsAt = (day, period) => { e.remove(u0); e.place(u0, day * 5 + period, [null]); const r = e.unitCost(u0) - e.W.late * period; e.remove(u0); return Math.round(r * 1e6) / 1e6; };
  assert.strictEqual(endsAt(0, 1), e.W.ends, 'Monday period 0 is template-blocked, so period 1 opens the day');
  assert.strictEqual(endsAt(1, 0), e.W.ends);
  assert.strictEqual(endsAt(1, 1), 0, 'the end of the morning segment is not the end of the day');
  assert.strictEqual(endsAt(1, 3), 0);
  assert.strictEqual(endsAt(1, 4), e.W.ends);
  assert.strictEqual(e.unitById[`${plain.id}#0`] && e.units[e.unitById[`${plain.id}#0`].i].avoidAdj, false, 'the flag only applies to rows with 2–3 units');
  assert.strictEqual(e.units[u0].avoidAdj, true);
  const at = (days) => new Engine(s, days.map((d, k) => pl(l, k, d, 1, 1)));
  assert.strictEqual(at([0, 1, 3]).groupStats(l.id).consecutiveDays, 1);
  assert.strictEqual(at([0, 2, 4]).totalCost().consecutiveDays, 0);
  const e3 = at([1, 2, 3]);
  assert.strictEqual(e3.totalCost().consecutiveDays, 2);
  assert.strictEqual(e3.totalCost().ends, 0, 'period 1 ends the morning, not the day');
  assert.strictEqual(new Engine(s, [1, 2, 3].map((d, k) => pl(l, k, d, 4, 1))).totalCost().ends, 3);
  assert.strictEqual(e3.groupCost(l.id), 2 * e3.W.consecutiveDays);
  const ui = e3.unitById[`${l.id}#1`].i;
  assert.strictEqual(e3.localCost(ui, [2]) - e3.unitCost(ui) - e3.teacherDayCost(t.id, 2) - e3.classDayCost(c.id, 2), 2 * e3.W.consecutiveDays, 'localCost carries the group cost');
  const e4 = new Engine(s, [0, 1, 2, 3].map((d, k) => pl(plain, k, d, 1, 1)));
  assert.strictEqual(e4.totalCost().consecutiveDays, 0, '4 units: ignored');
  // Over a solve, the annealer avoids both ends and adjacent days when it can.
  const s2 = school({ days: 5, periods: 3 });
  const subj2 = add.subject(s2), c2 = add.cls(s2), t2 = add.teacher(s2, 'T');
  const l2 = add.lesson(s2, subj2, t2, [c2], 2, 1, { penalizeEnds: true, avoidConsecutiveDays: true, maxOnePerDay: true });
  const { placements, engine } = solveAll(s2);
  const st = engine.totalCost();
  assert.strictEqual(st.ends + st.consecutiveDays, 0, `ends ${st.ends}, consecutive days ${st.consecutiveDays}: ${placements.map((p) => `${p.day}/${p.period}`)}`);
  void l2;
});

check('placements round-trip with mixed and flexible lengths', () => {
  const s = school({ days: 4, periods: 'tttbtt' });
  const subj = add.subject(s), c1 = add.cls(s, 'C1'), c2 = add.cls(s, 'C2'), t1 = add.teacher(s, 'A'), t2 = add.teacher(s, 'B');
  const r1 = add.room(s, 'R1', 'Classroom'), r2 = add.room(s, 'R2', 'Classroom');
  const a = add.lesson(s, subj, t1, [c1], 0, 1, { lengths: [3, 2, 1, 1], room: r1.id, roomAlt: 'type:Classroom', sameRoom: true });
  const b = add.lesson(s, subj, t2, [c2], 0, 1, { flexible: { total: 7, min: 1, max: 3 }, room: 'type:Classroom', relations: [{ type: 'notSameTime', lessonId: a.id }] });
  const c = add.lesson(s, subj, t2, [c1], 2, 1, { relations: [{ type: 'differentDays', lessonId: a.id }] });
  const { engine, placements, placed, total } = solveAll(s);
  assert.strictEqual(placed, total, `all ${total} units placed`);
  eq(placedOf(placements, a).map((p) => p.len).sort(), [1, 1, 2, 3]);
  assert.strictEqual(placedOf(placements, b).reduce((x, p) => x + p.len, 0), 7);
  const e2 = new Engine(s, placements);
  eq(e2.groupLengths[b.id], engine.groupLengths[b.id]);
  const sort = (ps) => ps.slice().sort((x, y) => x.unitId.localeCompare(y.unitId));
  eq(sort(e2.placements()), sort(placements));
  for (const key in engine.occ) eq([...e2.occ[key]], [...engine.occ[key]], `occupancy ${key}`);
  eq(e2.totalCost(), engine.totalCost());
  assert.strictEqual(e2.totalCost().roomSame, 0);
  void r2; void c;
});

check('balance: periods off an even week over the days a teacher can work; carried by localCost/areaCost/totalCost', () => {
  const s = school({ days: 5, periods: 4, blocked: ['4-0', '4-1', '4-2', '4-3'] });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T', { unavailable: keys(s, (d) => d === 3) }), u = add.teacher(s, 'U');
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1, 1, 1, 1, 1] });
  const e0 = new Engine(s, []);
  eq(e0.balDays[t.id], [0, 1, 2], 'general-blocked Friday and ✕ Thursday are not working days');
  eq(e0.balDays[u.id], [0, 1, 2, 3], 'only the general-blocked day is dropped');
  assert.strictEqual(e0.teacherBalance(t.id), 0, 'empty week');
  const at = (days) => new Engine(s, days.map((d, k) => pl(l, k, d, k % 4, 1)));
  const bal = (days) => at(days).teacherBalance(t.id);
  assert.strictEqual(bal([0, 0, 1, 1, 2, 2]), 0, '2/2/2');
  assert.strictEqual(bal([0, 0, 0, 1, 1, 2]), 2, '3/2/1 around a mean of 2: one period above, one below');
  assert.strictEqual(bal([0, 0, 0, 0, 1, 2]), 4, '4/1/1 around a mean of 2: two periods above, two below');
  assert.strictEqual(new Engine(s, [0, 0, 1, 1, 2].map((d, k) => pl(l, k, d, k % 4, 1))).teacherBalance(t.id), 0, '2/2/1: uneven but as even as 5 periods allow');
  // Counted in totalCost / localCost / areaCost with the weight, and off at weight 0.
  const e = at([0, 0, 0, 1, 1, 2]);
  const st = e.totalCost();
  assert.strictEqual(st.balance, 2);
  const flat = new Engine({ ...s, settings: { ...s.settings, weights: { balance: 0 } } }, e.placements());
  assert.strictEqual(flat.totalCost().balance, 2, 'the count is reported even when unweighted');
  assert.ok(Math.abs(st.cost - flat.totalCost().cost - 2 * e.W.balance) < 0.11, 'cost carries W.balance × imbalance');
  const ui = e.unitById[`${l.id}#0`].i;
  assert.ok(Math.abs(e.localCost(ui, [0]) - flat.localCost(ui, [0]) - 2 * e.W.balance) < 1e-9, 'localCost');
  assert.ok(Math.abs(e.areaCost([ui], [0]) - flat.areaCost([ui], [0]) - 2 * e.W.balance) < 1e-9, 'areaCost');
  // Over a solve the annealer evens the week out: 6 sessions on 3 days → 2/2/2.
  const s2 = school({ days: 3, periods: 4 });
  const subj2 = add.subject(s2), ca = add.cls(s2, 'A'), cb = add.cls(s2, 'B'), t2 = add.teacher(s2, 'T');
  s2.settings.weights = { balance: 5 };
  add.lesson(s2, subj2, t2, [ca], 3, 1); add.lesson(s2, subj2, t2, [cb], 3, 1);
  const { engine, placed, total } = solveAll(s2);
  assert.strictEqual(placed, total);
  assert.strictEqual(engine.totalCost().balance, 0, `teacher load per day ${[0, 1, 2].map((d) => engine.dayStats(engine.occ['t' + t2.id], d).n)}`);
});

check('roomDemand: nested sets, usable periods, general template, meetings and competing users', () => {
  const s = school({ days: 2, periods: 4, blocked: ['1-3'] });
  const subj = add.subject(s), a = add.cls(s, 'A', { unavailable: ['0-0'] }), b = add.cls(s, 'B', { unavailable: ['0-0', '1-2'] });
  const l1 = add.room(s, 'Lab 1', 'Lab'), l2 = add.room(s, 'Lab 2', 'Lab'), hall = add.room(s, 'Hall', 'Sports');
  l2.unavailable = ['0-1'];
  const ta = add.teacher(s, 'TA'), tb = add.teacher(s, 'TB'), tc = add.teacher(s, 'TC');
  add.lesson(s, subj, ta, [a], 3, 1, { room: l1.id });                   // pinned
  add.lesson(s, subj, tb, [b], 0, 1, { room: 'type:Lab', lengths: [2, 1] }); // any Lab
  add.lesson(s, subj, tc, [a], 2, 1, { room: hall.id });
  const m = add.meeting(s, 'Staff', [ta, tb], { room: hall.id });
  const r = new Engine(s, []).roomDemand();
  assert.strictEqual(r.length, 3, 'sets {Lab 1}, {Lab 1, Lab 2}, {Hall}');
  const one = r.find((x) => x.rooms.length === 1 && x.rooms[0] === l1.id), labs = r.find((x) => x.rooms.length === 2), h = r.find((x) => x.rooms[0] === hall.id);
  // Lab 1 alone: its 3 periods, 1 class; usable = general-blocked 1-3 and class-A-away 0-0 removed → 6 slots.
  eq([one.demand, one.users], [3, 1]);
  assert.strictEqual(one.capacity, 6, '8 periods − 1-3 (template) − 0-0 (class A away) = 6');
  // All labs: 3 + 3 nested lessons, classes A and B; Lab 2 also ✕ on 0-1 → 6 + 5; 0-0 is away for both, 1-2 only for B.
  eq([labs.demand, labs.users], [6, 2]);
  assert.strictEqual(labs.capacity, 6 + 5);
  // Hall: class A's 2 periods plus the meeting (no classes): every non-template period counts, 7.
  eq([h.demand, h.users], [2 + 1, 2]);
  assert.strictEqual(h.capacity, 7);
  assert.ok(m, 'meeting added');
});

// ---------- class homeroom ----------
check("homeroom: room 'home' resolves to the class's room; no homeroom or clashing homerooms are reported", () => {
  const s = school({ days: 3, periods: 4 });
  const subj = add.subject(s), t = add.teacher(s, 'T');
  const r1 = add.room(s, 'R1'), r2 = add.room(s, 'R2');
  const a = add.cls(s, 'A', { homeroom: r1.id }), b = add.cls(s, 'B', { homeroom: r2.id }), none = add.cls(s, 'N');
  const la = add.lesson(s, subj, t, [a], 3, 1, { room: 'home' });
  const e = new Engine(s, []);
  eq(e.units[0].parts[0].roomCands, [r1.id]);
  assert.strictEqual(e.units[0].parts[0].prefRoom, r1.id);
  const r = solveAll(s);
  assert.strictEqual(r.placed, r.total);
  assert.ok(r.placements.every((p) => p.rooms[0] === r1.id), 'every session in the homeroom');
  // Moving the class's homeroom moves its lessons.
  a.homeroom = r2.id;
  assert.ok(solveAll(s).placements.every((p) => p.rooms[0] === r2.id));
  // No homeroom, a deleted room, mixed homerooms.
  a.homeroom = r1.id;
  const lb = add.lesson(s, subj, add.teacher(s, 'U'), [none], 1, 1, { room: 'home' });
  const lab = add.lesson(s, subj, add.teacher(s, 'V'), [a, b], 1, 1, { room: 'home' });
  const lc = add.lesson(s, subj, add.teacher(s, 'W'), [a, none], 1, 1, { room: 'home' });
  const bad = new Engine(s, []).problems;
  const msg = (l) => (bad.find((p) => p.lessonIds.includes(l.id)) || {}).msg;
  assert.strictEqual(msg(lb), 'uses the class homeroom but its class has no homeroom');
  assert.strictEqual(msg(lab), 'uses the class homeroom but its classes have different homerooms');
  assert.strictEqual(msg(lc), 'uses the class homeroom but one of its classes has no homeroom');
  b.homeroom = 'gone';
  assert.strictEqual(new Engine(s, []).problems.find((p) => p.lessonIds.includes(lab.id)).msg, 'uses the class homeroom but one of its classes has no homeroom', 'unknown room counts as none');
  void la;
});

check('homeroom with an alternative type: the homeroom is preferred, the type is the fallback (roomPref counted)', () => {
  const s = school({ days: 1, periods: 2 });
  const subj = add.subject(s);
  const r1 = add.room(s, 'R1'), r2 = add.room(s, 'R2');
  const a = add.cls(s, 'A', { homeroom: r1.id }), b = add.cls(s, 'B');
  // B's lessons are pinned to R1 and fill it, so A's homeroom lessons have to go to R2 (the fallback).
  const lb = add.lesson(s, subj, add.teacher(s, 'TB'), [b], 2, 1, { room: r1.id });
  const la = add.lesson(s, subj, add.teacher(s, 'TA'), [a], 2, 1, { room: 'home', roomAlt: 'type:Classroom' });
  const { engine, placements, placed, total } = solveAll(s);
  assert.strictEqual(placed, total);
  assert.ok(placedOf(placements, la).every((p) => p.rooms[0] === r2.id));
  assert.strictEqual(engine.totalCost().roomPref, 2, 'both sessions are outside the preferred room');
  // Without the fallback the same rows cannot all be placed.
  la.roomAlt = '';
  const r = solveAll(s);
  assert.ok(r.placed < r.total);
  void lb;
});

check('relations: consecutive can fix the order, a break can divide, and before/after compare matching sessions', () => {
  const s = school({ days: 2, periods: 'tttbtt' });
  const subj = add.subject(s), c = add.cls(s, 'A'), c2 = add.cls(s, 'B'), t = add.teacher(s, 'T'), u = add.teacher(s, 'U');
  const a = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1] }), b = add.lesson(s, subj, u, [c2], 0, 1, { lengths: [1, 1] });
  const link = (relA, relB) => { a.relations = relA ? [{ lessonId: b.id, ...relA }] : []; b.relations = relB ? [{ lessonId: a.id, ...relB }] : []; };
  const bad = (placeA, ua, uslot) => { const e = new Engine(s, placeA); const x = e.unitById[ua].i; return e.baseConflicts(x, uslot); };
  const A0 = `${a.id}#0`, B0 = `${b.id}#0`, B1 = `${b.id}#1`;
  // consecutive, order: A first. A at period 1 → B must be at period 2 (right after), not 0.
  link({ type: 'consecutive', order: 'first' }, { type: 'consecutive', order: 'second' });
  assert.strictEqual(bad([pl(a, 0, 0, 1, 1)], B0, 2).size, 0, 'B right after A');
  assert.ok(bad([pl(a, 0, 0, 1, 1)], B0, 0).size === 1, 'B right before A violates "A first"');
  // The same relation declared on only one row behaves identically.
  link({ type: 'consecutive', order: 'first' }, null);
  assert.ok(bad([pl(a, 0, 0, 1, 1)], B0, 0).size === 1);
  link(null, { type: 'consecutive', order: 'second' });
  assert.ok(bad([pl(a, 0, 0, 1, 1)], B0, 0).size === 1, 'declared on B as "second" = A first');
  // consecutive without an order: either side is fine.
  link({ type: 'consecutive', order: '' }, { type: 'consecutive', order: '' });
  assert.strictEqual(bad([pl(a, 0, 0, 1, 1)], B0, 0).size, 0); assert.strictEqual(bad([pl(a, 0, 0, 1, 1)], B0, 2).size, 0);
  // Breaks: periods 0,1,2 | break | 4,5. Across the break, A at 2 and B at 4 are adjacent in teaching order…
  assert.strictEqual(bad([pl(a, 0, 0, 2, 1)], B0, 4).size, 0, 'teaching-order adjacency ignores the break');
  link({ type: 'consecutive', breaks: true }, { type: 'consecutive', breaks: true });
  assert.strictEqual(bad([pl(a, 0, 0, 2, 1)], B0, 4).size, 1, '…but a dividing break separates them');
  assert.strictEqual(bad([pl(a, 0, 0, 1, 1)], B0, 2).size, 0, 'periods 1 and 2 are still next to each other');
  link({ type: 'nonConsecutive', breaks: true }, { type: 'nonConsecutive', breaks: true });
  assert.strictEqual(bad([pl(a, 0, 0, 2, 1)], B0, 4).size, 0, 'across a dividing break the sessions are not consecutive, so non-consecutive holds');
  link({ type: 'nonConsecutive' }, { type: 'nonConsecutive' });
  assert.strictEqual(bad([pl(a, 0, 0, 2, 1)], B0, 4).size, 1, 'without breaks-divide they are consecutive, so non-consecutive is violated');
  // before / after: session k of A earlier in the week than session k of B.
  link({ type: 'before' }, { type: 'after' });
  assert.strictEqual(bad([pl(a, 0, 0, 2, 1)], B0, 4).size, 0, 'later period, same day');
  assert.strictEqual(bad([pl(a, 0, 0, 2, 1)], B0, 1).size, 1, 'earlier period');
  assert.strictEqual(bad([pl(a, 0, 1, 0, 1)], B0, 5).size, 1, 'A on Tuesday, B on Monday');
  assert.strictEqual(bad([pl(a, 0, 0, 5, 1)], B0, 6).size, 0, 'A on Monday, B on Tuesday');
  assert.strictEqual(bad([pl(a, 1, 1, 0, 1)], B0, 5).size, 0, 'session 0 of B is compared with session 0 of A only (A#0 is unplaced)');
  link(null, { type: 'after' });
  assert.strictEqual(bad([pl(a, 0, 0, 2, 1)], B0, 1).size, 1, 'declared on B only: "B after A"');
  link({ type: 'after' }, { type: 'before' });
  assert.strictEqual(bad([pl(a, 0, 0, 2, 1)], B0, 4).size, 1, 'A after B: B#0 at 4 is after A#0 at 2, so that is wrong');
  assert.strictEqual(bad([pl(a, 0, 0, 2, 1)], B0, 1).size, 0);
  // Whole solve: every B session is after the matching A session.
  link({ type: 'before' }, { type: 'after' });
  const r = solveAll(s);
  assert.strictEqual(r.placed, r.total);
  for (const k of [0, 1]) {
    const pa = r.placements.find((x) => x.unitId === `${a.id}#${k}`), pb = r.placements.find((x) => x.unitId === `${b.id}#${k}`);
    assert.ok(pa.day * 6 + pa.period < pb.day * 6 + pb.period, `session ${k}: A ${pa.day}/${pa.period} before B ${pb.day}/${pb.period}`);
  }
  void B1;
});

check('alternative distributions: one is chosen per attempt, placements restore it, pinning is not offered', () => {
  const s = school({ days: 4, periods: 4 });
  const subj = add.subject(s), c = add.cls(s, 'A'), t = add.teacher(s, 'T');
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [2, 2], alternatives: [[2, 2], [3, 1], [1, 1, 1, 1]] });
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(new Engine(s, []).groupLengths[l.id].slice().sort().join(''));
  eq([...seen].sort(), ['1111', '22', '13'].sort(), 'every alternative is picked at some point');
  const r = solveAll(s);
  assert.strictEqual(r.placed, r.total);
  const lens = r.placements.map((p) => p.len).sort().join('');
  assert.ok(['22', '13', '1111'].includes(lens), lens);
  const again = new Engine(s, r.placements);
  eq(again.groupLengths[l.id], r.engine.groupLengths[l.id], 'placements restore the same alternative');
  // Restoring with k-indexed lengths prefers the alternative that agrees with them.
  const e3 = new Engine(s, [pl(l, 0, 0, 0, 3), pl(l, 1, 1, 0, 1)]);
  eq(e3.groupLengths[l.id], [3, 1]);
  assert.strictEqual(e3.flexRows.has(l.id), true, 'cannot be pinned');
  eq(new Engine(s, []).applyPins([{ kind: 'lesson', id: l.id, k: 0, day: 0, period: 0 }]).map((x) => x.why), ['flexible']);
  // Bad alternatives are reported; fewer than two alternatives mean a fixed row.
  l.alternatives = [[2, 2], [9, 1]];
  assert.ok(new Engine(s, []).problems.some((x) => x.msg === 'has an invalid alternative distribution'));
  l.alternatives = [[3, 1]];
  eq(new Engine(s, []).groupLengths[l.id], [2, 2], 'a single alternative is ignored');
});

check('row day limits: max periods a day (blocks count by length), min periods on used days, together and apart', () => {
  const s = school({ days: 3, periods: 5 });
  const subj = add.subject(s), c = add.cls(s, 'A'), t = add.teacher(s, 'T');
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [2, 1, 1], dayMax: 3 });
  const e = new Engine(s, [pl(l, 0, 0, 0, 2), pl(l, 1, 0, 3, 1)]);       // Monday: 2 + 1 = 3
  const u3 = e.unitById[`${l.id}#2`].i;
  assert.ok(e.baseConflicts(u3, 2) !== null && e.baseConflicts(u3, 2).size >= 1, 'a fourth period on Monday evicts the smaller session');
  assert.strictEqual(e.baseConflicts(u3, 5).size, 0);
  l.dayMax = 1;
  assert.strictEqual(new Engine(s, []).baseConflicts(0, 0), null, 'a double can never fit under a 1-period cap');
  // together / apart
  const g = add.lesson(s, subj, add.teacher(s, 'U'), [add.cls(s, 'B')], 0, 1, { lengths: [1, 1, 1], dayBlocks: 'together' });
  const eg = new Engine(s, [pl(g, 0, 0, 1, 1)]);
  const g1 = eg.unitById[`${g.id}#1`].i;
  assert.strictEqual(eg.baseConflicts(g1, 2).size, 0, 'next to the first session');
  assert.strictEqual(eg.baseConflicts(g1, 4), null, 'not next to it');
  assert.strictEqual(eg.baseConflicts(g1, 5).size, 0, 'another day is fine');
  const eg2 = new Engine(s, [pl(g, 0, 0, 1, 1), pl(g, 1, 0, 2, 1)]);
  assert.strictEqual(eg2.baseConflicts(eg2.unitById[`${g.id}#2`].i, 3), null, 'a third session on the day is refused');
  g.dayBlocks = 'apart';
  const ea = new Engine(s, [pl(g, 0, 0, 1, 1)]);
  eq([...ea.baseConflicts(ea.unitById[`${g.id}#1`].i, 2)], [ea.unitById[`${g.id}#0`].i], 'next to it: the neighbour is evicted');
  assert.strictEqual(ea.baseConflicts(ea.unitById[`${g.id}#1`].i, 4).size, 0);
  // min per day: 4 periods in 1+1+2 over days costs the shortfall of used days
  const m = add.lesson(s, subj, add.teacher(s, 'V'), [add.cls(s, 'C')], 0, 1, { lengths: [1, 1, 2], dayMin: 2 });
  const em = new Engine(s, [pl(m, 0, 0, 0, 1), pl(m, 1, 1, 0, 1), pl(m, 2, 2, 0, 2)]);
  assert.strictEqual(em.groupStats(m.id).activityMin, 2, 'Monday 1 and Tuesday 1 are each one short');
  assert.strictEqual(em.totalCost().activityMin, 2);
  // Over a solve everything respects the caps.
  const s2 = school({ days: 4, periods: 4 });
  const sub2 = add.subject(s2), c2 = add.cls(s2, 'A'), t2 = add.teacher(s2, 'T');
  const row = add.lesson(s2, sub2, t2, [c2], 0, 1, { lengths: [1, 1, 1, 1, 1, 1], dayMax: 2, dayBlocks: 'apart' });
  const r = solveAll(s2);
  assert.strictEqual(r.placed, r.total);
  for (let d = 0; d < 4; d++) {
    const ps = r.placements.filter((p) => p.day === d).map((p) => p.period).sort();
    assert.ok(ps.length <= 2, `day ${d}: ${ps}`);
    if (ps.length === 2) assert.ok(ps[1] - ps[0] > 1, `day ${d} apart: ${ps}`);
  }
  void row;
});

check('row options: first period after a break, afternoon and same-hour wishes are costed and met by the annealer', () => {
  const s = school({ days: 4, periods: 'ttbttlttt' });       // 0,1 | break | 3,4 | lunch | 6,7,8
  const subj = add.subject(s), c = add.cls(s, 'A'), t = add.teacher(s, 'T');
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1, 1], penalizeAfterBreak: true, penalizeAfternoon: true });
  const e0 = new Engine(s, []);
  eq([e0.afterBreakP.map(Number), e0.afternoonP.map(Number)], [[0, 0, 0, 1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 1, 1, 1]], 'after-break = period 3; afternoon = after the lunch period');
  const cost = (p) => { const e = new Engine(s, [pl(l, 0, 0, p, 1)]); return e.unitCost(0) - e.W.late * p; };
  assert.strictEqual(cost(0), 0); assert.strictEqual(cost(3), e0.W.afterBreak); assert.strictEqual(cost(7), e0.W.afternoon); assert.strictEqual(cost(4), 0);
  const e = new Engine(s, [pl(l, 0, 0, 3, 1), pl(l, 1, 1, 7, 1), pl(l, 2, 2, 0, 1)]);
  assert.strictEqual(e.totalCost().afterBreak, 1); assert.strictEqual(e.totalCost().afternoon, 1);
  const r = solveAll(s);
  assert.strictEqual(r.engine.totalCost().afterBreak + r.engine.totalCost().afternoon, 0, 'the lessons sit in the morning, not right after the break');
  // Without a lunch period the afternoon is the second half of the day.
  const nl = new Engine(school({ days: 1, periods: 6 }), []);
  eq(nl.afternoonP.map(Number), [0, 0, 0, 1, 1, 1]);
  // same hour: avoid charges repeated start periods, promote charges each extra distinct one.
  const s2 = school({ days: 4, periods: 4 });
  const sj = add.subject(s2), c2 = add.cls(s2, 'A'), t2 = add.teacher(s2, 'T');
  const row = add.lesson(s2, sj, t2, [c2], 0, 1, { lengths: [1, 1, 1], sameHour: 'avoid' });
  const at = (ps) => new Engine(s2, ps.map(([d, p], k) => pl(row, k, d, p, 1)));
  assert.strictEqual(at([[0, 1], [1, 1], [2, 1]]).groupStats(row.id).sameHour, 2, 'three sessions in period 2: two repeats');
  assert.strictEqual(at([[0, 1], [1, 2], [2, 3]]).groupStats(row.id).sameHour, 0);
  assert.strictEqual(at([[0, 1], [1, 1], [2, 2]]).groupStats(row.id).sameHour, 1);
  row.sameHour = 'promote';
  assert.strictEqual(at([[0, 1], [1, 1], [2, 1]]).groupStats(row.id).sameHour, 0, 'always the same hour: nothing to pay');
  assert.strictEqual(at([[0, 1], [1, 2], [2, 3]]).groupStats(row.id).sameHour, 2);
  const x = at([[0, 1], [1, 2], [2, 3]]);
  const cx = x.totalCost().cost, flat = new Engine({ ...s2, settings: { ...s2.settings, weights: { sameHour: 0 } } }, x.placements()).totalCost().cost;
  assert.ok(Math.abs(cx - flat - 2 * x.W.sameHour) < 0.11, 'carried by the cost');
  assert.ok(Math.abs(x.localCost(0, [0]) - new Engine({ ...s2, settings: { ...s2.settings, weights: { sameHour: 0 } } }, x.placements()).localCost(0, [0]) - 2 * x.W.sameHour) < 1e-9, 'and by localCost');
  const r2 = solveAll(s2);
  assert.strictEqual(new Set(r2.placements.map((p) => p.period)).size, 1, 'the annealer keeps the same hour every time when promoted');
  row.sameHour = 'avoid';
  assert.strictEqual(new Set(solveAll(s2).placements.map((p) => p.period)).size, 3, 'and varies it when avoided');
});

check('free half-days: the wish counts mornings or afternoons without lessons, and weighs the shortfall', () => {
  const s = school({ days: 3, periods: 'tttlttt' });       // morning 0-2, lunch, afternoon 4-6
  const subj = add.subject(s), c = add.cls(s, 'A'), t = add.teacher(s, 'T', { freeHalves: 3, unavailable: ['2-4', '2-5', '2-6'] });
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1, 1] });
  const e0 = new Engine(s, []);
  assert.strictEqual(e0.tHalves[t.id].length, 5, '3 mornings + 2 afternoons (Wednesday afternoon is ✕)');
  assert.strictEqual(e0.teacherFreeHalvesMissing(t.id), 0, 'an empty week has every half-day free');
  // Lessons in Mon morning, Mon afternoon, Tue morning: 2 of 5 halves are free, 3 wanted → 1 short.
  const e = new Engine(s, [pl(l, 0, 0, 0, 1), pl(l, 1, 0, 4, 1), pl(l, 2, 1, 1, 1)]);
  assert.strictEqual(e.teacherFreeHalvesMissing(t.id), 1);
  assert.strictEqual(e.totalCost().freeHalves, 1);
  assert.ok(Math.abs(e.teacherWeekCost(t.id) - e.W.balance * e.teacherBalance(t.id) - e.W.freeHalves) < 1e-9);
  // Meetings and duties do not count as lessons for this wish.
  const m = add.meeting(s, 'Sync', [t], { sessions: 1 });
  const e2 = new Engine(s, [pl(l, 0, 0, 0, 1), { unitId: `m:${m.id}#0`, day: 2, period: 1, len: 1, rooms: [null], locked: false }]);
  assert.strictEqual(e2.teacherFreeHalvesMissing(t.id), 0, '4 free halves of 5');
  // The annealer packs the lessons into few half-days.
  s.settings.weights = { freeHalves: 10, balance: 0 };
  const r = solveAll(s);
  assert.strictEqual(r.engine.totalCost().freeHalves, 0);
});

check('exclusive periods: window of n at each end, Friday→Monday wrap, first+last of a day, morning+afternoon of a day', () => {
  const s = school({ days: 3, periods: 'tttlttt' });     // morning 0-2, lunch, afternoon 4-6
  const subj = add.subject(s), c = add.cls(s, 'A'), t = add.teacher(s, 'T', { noLastFirst: true });
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1, 1, 1] });
  const at = (cells) => new Engine(s, cells.map(([d, p], k) => pl(l, k, d, p, 1)));
  assert.strictEqual(at([[0, 6], [1, 0]]).teacherExclusive(t.id), 1, 'Mon last, Tue first');
  assert.strictEqual(at([[0, 5], [1, 1]]).teacherExclusive(t.id), 0, 'one period inside the window of 1 at each end');
  t.exclusiveWindow = 2;
  assert.strictEqual(at([[0, 5], [1, 1]]).teacherExclusive(t.id), 1, 'with a window of 2 the last two and first two periods count');
  assert.strictEqual(at([[0, 4], [1, 2]]).teacherExclusive(t.id), 0, 'period 4 is outside the last two (5, 6)');
  assert.strictEqual(at([[2, 6], [0, 0]]).teacherExclusive(t.id), 0, 'Wednesday → Monday is not a pair…');
  t.exclusiveWrap = true;
  assert.strictEqual(at([[2, 6], [0, 0]]).teacherExclusive(t.id), 1, '…unless the week wraps');
  t.exclusiveWindow = 1; t.exclusiveWrap = false; t.noLastFirst = false;
  assert.strictEqual(at([[0, 6], [1, 0]]).teacherExclusive(t.id), 0, 'rule off');
  t.noFirstLast = true;
  assert.strictEqual(at([[1, 0], [1, 6]]).teacherExclusive(t.id), 1, 'first and last period of Tuesday');
  assert.strictEqual(at([[1, 0], [1, 5]]).teacherExclusive(t.id), 0);
  t.noFirstLast = false; t.noSplitDay = true;
  assert.strictEqual(at([[1, 1], [1, 5], [2, 0], [2, 1]]).teacherExclusive(t.id), 1, 'Tuesday has both halves, Wednesday only the morning');
  // All three at once, and the cost / statistics.
  t.noLastFirst = true; t.noFirstLast = true;
  const e = at([[0, 6], [1, 0], [1, 6], [2, 1]]);
  assert.strictEqual(e.teacherExclusive(t.id), 3 + 0, 'Mon→Tue pair, Tue first+last, Tue am+pm');
  assert.strictEqual(e.totalCost().exclusive, 3);
  // The annealer finds a week with none of them when there is room.
  const s2 = school({ days: 3, periods: 'tttlttt' }); s2.settings.weights = { exclusive: 10, late: 0, balance: 0 };
  const sj = add.subject(s2), c2 = add.cls(s2, 'A'), t2 = add.teacher(s2, 'T', { noLastFirst: true, noFirstLast: true, noSplitDay: true });
  add.lesson(s2, sj, t2, [c2], 0, 1, { lengths: [1, 1, 1, 1, 1, 1] });
  const r = solveAll(s2);
  assert.strictEqual(r.placed, r.total);
  assert.strictEqual(r.engine.totalCost().exclusive, 0, `${r.placements.map((p) => `${p.day}/${p.period}`)}`);
});

// ---------- complementary activities ----------
const addActivity = (s, name, teacher, periods, extra = {}) => { const x = { id: id('a'), name, teacherId: teacher.id, periods, minPerDay: 0, maxPerDay: 0, nonConsecutive: false, countLoad: false, allowed: [], ...extra }; (s.activities ||= []).push(x); return x; };
const apl = (a, k, day, period) => ({ unitId: `a:${a.id}#${k}`, day, period, len: 1, rooms: [null], locked: false });

check('activity: one single-period unit per weekly period, teacher only; bad data is reported', () => {
  const s = school({ days: 3, periods: 4 });
  const t = add.teacher(s, 'T');
  const a = addActivity(s, 'Lab prep', t, 3);
  const e = new Engine(s, []);
  eq(e.units.map((u) => [u.id, u.kind, u.len, u.teachers, u.classes]), [0, 1, 2].map((k) => [`a:${a.id}#${k}`, 'activity', 1, [t.id], []]));
  eq(e.units[0].parts[0].roomCands, null);
  s.activities.push({ id: 'x1', name: 'No teacher', teacherId: 'gone', periods: 2 }, { id: 'x2', name: 'Empty', teacherId: t.id, periods: 0 });
  const bad = new Engine(s, []).problems.filter((p) => p.activityId);
  eq(bad.map((p) => [p.activityId, p.msg]), [['x1', 'has no teacher'], ['x2', 'has no periods per week']]);
});

check('activity: maxPerDay and nonConsecutive hold over a solve; activities and lessons never clash', () => {
  const s = school({ days: 4, periods: 'tttbttt' });
  const t = add.teacher(s, 'T'), subj = add.subject(s), c = add.cls(s, 'A');
  add.lesson(s, subj, t, [c], 8, 1, { maxOnePerDay: false });
  const a = addActivity(s, 'Coordination', t, 6, { maxPerDay: 2, nonConsecutive: true });
  const r = solveAll(s);
  assert.strictEqual(r.placed, r.total);
  const mine = r.placements.filter((p) => p.unitId.startsWith(`a:${a.id}#`));
  assert.strictEqual(mine.length, 6);
  for (let d = 0; d < 4; d++) {
    const ps = mine.filter((p) => p.day === d).map((p) => p.period).sort((x, y) => x - y);
    assert.ok(ps.length <= 2, `day ${d}: ${ps}`);
    // adjacent in teaching order: periods 2 and 4 are neighbours across the break
    for (let i = 1; i < ps.length; i++) assert.ok(!(ps[i] - ps[i - 1] === 1 || (ps[i - 1] === 2 && ps[i] === 4)), `adjacent on day ${d}: ${ps}`);
  }
  const occ = {}; for (const p of r.placements) { const k = `${p.day}-${p.period}`; assert.ok(!occ[k], `teacher double-booked at ${k}`); occ[k] = 1; }
});

check('activity: baseConflicts evicts to keep maxPerDay / nonConsecutive and refuses over locked units', () => {
  const s = school({ days: 2, periods: 5 });
  const t = add.teacher(s, 'T');
  const a = addActivity(s, 'Prep', t, 4, { maxPerDay: 2, nonConsecutive: true });
  const cap = new Engine(s, [apl(a, 0, 0, 0), apl(a, 1, 0, 2)]);
  const u3 = cap.unitById[`a:${a.id}#2`].i, u0 = cap.unitById[`a:${a.id}#0`].i, u1 = cap.unitById[`a:${a.id}#1`].i;
  eq([...cap.baseConflicts(u3, 4)], [u0], 'a third period on Monday evicts one of the two (the first movable)');
  assert.strictEqual(cap.baseConflicts(u3, 5 + 4).size, 0, 'Tuesday is free');
  const adj = new Engine(s, [apl(a, 0, 0, 0)]);
  eq([...adj.baseConflicts(adj.unitById[`a:${a.id}#1`].i, 1)], [adj.unitById[`a:${a.id}#0`].i], 'the neighbouring period is evicted');
  assert.strictEqual(adj.baseConflicts(adj.unitById[`a:${a.id}#1`].i, 2).size, 0, 'one period apart is fine');
  const locked = new Engine(s, [{ ...apl(a, 0, 0, 0), locked: true }, { ...apl(a, 1, 0, 2), locked: true }]);
  assert.strictEqual(locked.baseConflicts(locked.unitById[`a:${a.id}#2`].i, 4), null, 'both locked: refused');
  void u1;
});

check('activity: allowed slots, minPerDay as a soft cost, and countLoad for the teacher max/day', () => {
  const s = school({ days: 3, periods: 4 });
  const t = add.teacher(s, 'T', { maxPerDay: 2 }), subj = add.subject(s), c = add.cls(s, 'A');
  const a = addActivity(s, 'Meeting prep', t, 3, { minPerDay: 2, allowed: ['0-1', '1-1', '1-2', '2-3'] });
  const e = new Engine(s, []);
  eq(e.units[0].starts, [1, 5, 6, 11], 'only the allowed periods');
  const at = (cells) => new Engine(s, cells.map(([d, p], k) => apl(a, k, d, p)));
  assert.strictEqual(at([[1, 1], [1, 2], [0, 1]]).groupStats(`a:${a.id}`).activityMin, 1, 'Monday has 1 of 2');
  assert.strictEqual(at([[1, 1], [1, 2]]).groupStats(`a:${a.id}`).activityMin, 0);
  const e3 = at([[0, 1], [1, 1], [2, 3]]);
  assert.strictEqual(e3.totalCost().activityMin, 3, 'three days with 1 period each');
  const flat = new Engine({ ...s, settings: { ...s.settings, weights: { activityMin: 0 } } }, e3.placements());
  assert.ok(Math.abs(e3.totalCost().cost - flat.totalCost().cost - 3 * e3.W.activityMin) < 0.11, 'cost carries W.activityMin × shortfall');
  const ui = e3.unitById[`a:${a.id}#0`].i;
  assert.ok(Math.abs(e3.localCost(ui, [0]) - flat.localCost(ui, [0]) - 3 * e3.W.activityMin) < 1e-9, 'localCost carries the group cost');
  // countLoad: the activity counts toward the teacher's max 2/day only when it opts in.
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1] });
  const place = (opt) => { a.countLoad = opt; a.allowed = []; return new Engine(s, [pl(l, 0, 0, 0, 1), pl(l, 1, 0, 1, 1)]); };
  let e4 = place(false);
  assert.strictEqual(e4.baseConflicts(e4.unitById[`a:${a.id}#0`].i, 2).size, 0, 'without countLoad the third period is fine');
  e4 = place(true);
  assert.strictEqual(e4.baseConflicts(e4.unitById[`a:${a.id}#0`].i, 2).size, 1, 'with countLoad a lesson makes way (3 > max 2)');
});

check('activity: placements round-trip, locks survive, and the activity may be moved by a plain solve', () => {
  const s = school({ days: 3, periods: 4 });
  const t = add.teacher(s, 'T'), subj = add.subject(s), c = add.cls(s, 'A');
  add.lesson(s, subj, t, [c], 6, 1, { maxOnePerDay: false });
  const a = addActivity(s, 'Prep', t, 3, { maxPerDay: 1 });
  const r = solveAll(s);
  assert.strictEqual(r.placed, r.total);
  const e2 = new Engine(s, r.placements);
  eq(e2.placements().slice().sort((x, y) => x.unitId.localeCompare(y.unitId)), r.placements.slice().sort((x, y) => x.unitId.localeCompare(y.unitId)));
  const lock = r.placements.filter((p) => p.unitId.startsWith('a:')).map((p) => ({ ...p, locked: true }));
  const r2 = solveAll(s, lock);
  assert.strictEqual(r2.placed, r2.total);
  for (const p of lock) assert.ok(r2.placements.some((q) => q.unitId === p.unitId && q.day === p.day && q.period === p.period), 'locked activity period kept');
  void a;
});

// ---------- pins (preset positions) ----------
const pin = (kind, idv, k, day, period) => ({ kind, id: idv, k, day, period });
const at = (placements, l, k) => placements.find((p) => p.unitId.split('#')[0].split('+').includes(l.id) && p.unitId.endsWith('#' + k));

check('pins: pinned sessions sit at their slot after a full solve, unlocked, and the rest is built around them', () => {
  const s = school({ days: 4, periods: 'tttbttt' });
  const subj = add.subject(s), c = add.cls(s, 'A'), c2 = add.cls(s, 'B');
  const t = add.teacher(s, 'T'), u = add.teacher(s, 'U');
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [2, 1, 1] });
  const l2 = add.lesson(s, subj, u, [c2], 4, 1, { maxOnePerDay: false });
  const m = add.meeting(s, 'Sync', [t, u], { sessions: 2 });
  const a = addActivity(s, 'Prep', t, 3, { maxPerDay: 1 });
  s.pins = [pin('lesson', l.id, 0, 1, 4), pin('lesson', l.id, 2, 3, 0), pin('lesson', l2.id, 1, 0, 0), pin('meeting', m.id, 1, 2, 1), pin('activity', a.id, 0, 0, 5)];
  const sv = new Solver(s, []);
  eq(sv.pinProblems, []);
  let r; do { r = sv.run(5000); } while (r.phase !== 'done');
  assert.strictEqual(r.placed, r.total);
  const pls = sv.e.placements();
  const slotOf = (x) => [x.day, x.period];
  eq(slotOf(at(pls, l, 0)), [1, 4]); eq(slotOf(at(pls, l, 2)), [3, 0]); eq(slotOf(at(pls, l2, 1)), [0, 0]);
  eq(slotOf(pls.find((x) => x.unitId === `m:${m.id}#1`)), [2, 1]); eq(slotOf(pls.find((x) => x.unitId === `a:${a.id}#0`)), [0, 5]);
  assert.ok(pls.every((x) => !x.locked), 'pinned sessions are reported unlocked');
  assert.strictEqual(sv.e.pinned.size, 5);
  // Pins are applied on every generation, so a second run lands on the same slots.
  const again = solveAll(s);
  eq(slotOf(at(again.placements, l, 0)), [1, 4]);
  // Display engines (restoring placements) do not apply pins: they only show what is stored.
  assert.strictEqual(new Engine(s, []).pinned.size, 0);
});

check('pins: a pin on one row of a parallel group fixes the shared unit; conflicting pins in the group are reported', () => {
  const s = school({ days: 3, periods: 4 });
  const subj = add.subject(s), c = add.cls(s, 'A');
  const r1 = add.room(s, 'R1'), r2 = add.room(s, 'R2');
  const a = add.lesson(s, subj, add.teacher(s, 'T1'), [c], 2, 1, { parallel: 'G', room: r1.id });
  const b = add.lesson(s, subj, add.teacher(s, 'T2'), [c], 2, 1, { parallel: 'G', room: r2.id });
  s.pins = [pin('lesson', b.id, 0, 1, 2)];
  const sv = new Solver(s, []); eq(sv.pinProblems, []);
  let r; do { r = sv.run(5000); } while (r.phase !== 'done');
  const pls = sv.e.placements();
  assert.strictEqual(pls.filter((x) => x.day === 1 && x.period === 2).length, 1, 'one merged unit at the pin');
  eq(pls.find((x) => x.day === 1 && x.period === 2).rooms, [r1.id, r2.id]);
  s.pins = [pin('lesson', a.id, 0, 1, 2), pin('lesson', b.id, 0, 2, 1)];
  const bad = new Engine(s, []).applyPins(s.pins);
  eq(bad.map((x) => x.why), ['twice'], 'the second row asks for a different slot');
  s.pins = [pin('lesson', a.id, 0, 1, 2), pin('lesson', b.id, 0, 1, 2)];
  eq(new Engine(s, []).applyPins(s.pins), [], 'the same slot from both rows is fine');
});

check('pins: reasons a pin cannot be honoured, and the unit is left alone', () => {
  const s = school({ days: 2, periods: 'tttbtt' });
  const subj = add.subject(s), c = add.cls(s, 'A'), c2 = add.cls(s, 'B', { unavailable: ['1-0'] });
  const t = add.teacher(s, 'T', { unavailable: ['0-4'] }), u = add.teacher(s, 'U');
  const r1 = add.room(s, 'R1');
  const dbl = add.lesson(s, subj, t, [c], 0, 1, { lengths: [2] });
  const one = add.lesson(s, subj, u, [c2], 0, 1, { lengths: [1] });
  const flex = add.lesson(s, subj, u, [c], 0, 1, { flexible: { total: 3, min: 1, max: 2 } });
  const x1 = add.lesson(s, subj, add.teacher(s, 'X1'), [add.cls(s, 'C1')], 0, 1, { lengths: [1], room: r1.id });
  const x2 = add.lesson(s, subj, add.teacher(s, 'X2'), [add.cls(s, 'C2')], 0, 1, { lengths: [1], room: r1.id });
  const ty = add.teacher(s, 'Y');
  const y1 = add.lesson(s, subj, ty, [add.cls(s, 'C3')], 0, 1, { lengths: [1] });
  const y2 = add.lesson(s, subj, ty, [add.cls(s, 'C4')], 0, 1, { lengths: [1] });
  const why = (pins) => { const e = new Engine(s, []); return e.applyPins(pins).map((x) => x.why); };
  eq(why([pin('lesson', dbl.id, 0, 0, 2)]), ['invalid'], 'a double starting before the break would straddle it');
  eq(why([pin('lesson', one.id, 0, 1, 0)]), ['invalid'], 'the class is ✕ there');
  eq(why([pin('lesson', dbl.id, 0, 0, 4)]), ['invalid'], 'the teacher is ✕ there');
  eq(why([pin('lesson', one.id, 0, 0, 3)]), ['invalid'], 'a break period');
  eq(why([pin('lesson', flex.id, 0, 0, 0)]), ['flexible']);
  eq(why([pin('lesson', one.id, 5, 0, 0), pin('meeting', 'nope', 0, 0, 0)]), ['missing', 'missing']);
  eq(why([pin('lesson', y1.id, 0, 1, 1), pin('lesson', y2.id, 0, 1, 1)]), ['clash'], 'same teacher, same slot');
  eq(why([pin('lesson', x1.id, 0, 1, 2), pin('lesson', x2.id, 0, 1, 2)]), ['room'], 'teachers and classes differ, but the only room is taken');
  // Failed pins leave the unit as it was, and everything else still applies.
  const e = new Engine(s, [pl(one, 0, 0, 1, 1)]);
  const probs = e.applyPins([pin('lesson', one.id, 0, 1, 0), pin('lesson', dbl.id, 0, 1, 1)]);
  eq(probs.map((x) => x.why), ['invalid']);
  eq([e.pos[e.unitById[`${one.id}#0`].i].s], [1], 'the unit stays at its old slot');
  assert.ok(e.pinned.has(e.unitById[`${dbl.id}#0`].i));
});

check('pins vs locks: a pin moves a user-locked unit; a pin that fails leaves the lock; pins respect other locks', () => {
  const s = school({ days: 3, periods: 4 });
  const subj = add.subject(s), c = add.cls(s, 'A'), d = add.cls(s, 'B');
  const t = add.teacher(s, 'T');
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1] });
  const other = add.lesson(s, subj, t, [d], 0, 1, { lengths: [1] });
  const locked = [{ ...pl(l, 0, 0, 0, 1), locked: true }, { ...pl(other, 0, 1, 2, 1), locked: true }];
  s.pins = [pin('lesson', l.id, 0, 2, 3)];
  let sv = new Solver(s, locked); eq(sv.pinProblems, []);
  let r; do { r = sv.run(5000); } while (r.phase !== 'done');
  const pls = sv.e.placements();
  eq([at(pls, l, 0).day, at(pls, l, 0).period], [2, 3], 'moved from its lock to the pin');
  eq([at(pls, other, 0).day, at(pls, other, 0).period, at(pls, other, 0).locked], [1, 2, true], 'other locks stay');
  s.pins = [pin('lesson', l.id, 1, 1, 2)];     // teacher T is held by the locked lesson at 1-2
  sv = new Solver(s, locked);
  eq(sv.pinProblems.map((x) => x.why), ['clash']);
  const e = sv.e; assert.strictEqual(e.pinned.size, 0);
  eq(e.pos[e.unitById[`${l.id}#0`].i].s, 0, 'the locked unit kept its slot');
});

check('subject templates: ✕ periods are never used by the subject\'s lessons, ~ periods cost like any non-preferred period', () => {
  const s = school({ days: 2, periods: 4 });
  const pe = add.subject(s, 'PE'), maths = add.subject(s, 'Maths');
  pe.unavailable = ['0-0', '1-0']; pe.dispreferred = ['0-1', '1-1'];
  const c = add.cls(s, 'A'), t = add.teacher(s, 'T'), u = add.teacher(s, 'U');
  const lp = add.lesson(s, pe, t, [c], 0, 1, { lengths: [1, 1] });
  const lm = add.lesson(s, maths, u, [c], 0, 1, { lengths: [1, 1] });
  const e = new Engine(s, []);
  assert.ok(!e.unitById[`${lp.id}#0`].starts.includes(0) && !e.unitById[`${lp.id}#0`].starts.includes(4), 'no PE in period 1');
  assert.ok(e.unitById[`${lm.id}#0`].starts.includes(0), 'maths is not affected');
  const at = (day, period) => { const x = new Engine(s, [pl(lp, 0, day, period, 1)]); return x.unitCost(x.unitById[`${lp.id}#0`].i) - x.W.late * period; };
  assert.strictEqual(at(0, 2), 0);
  assert.strictEqual(at(0, 1), e.W.dispreferred, 'PE in a ~ period');
  const x = new Engine(s, [pl(lp, 0, 0, 1, 1), pl(lm, 0, 0, 0, 1)]);
  assert.strictEqual(x.totalCost().dispreferred, 1, 'counted in the statistics; the maths lesson is not');
  const r = solveAll(s);
  assert.strictEqual(r.placed, r.total);
  assert.ok(r.placements.filter((p) => p.unitId.startsWith(lp.id)).every((p) => p.period !== 0 && p.period !== 1), 'the annealer avoids ✕ and ~ periods when it can');
});

check('two non-preferred levels: ~~ costs W.dispreferred2 and is avoided before ~; both count once in the statistics', () => {
  const s = school({ days: 1, periods: 4 });
  const subj = add.subject(s), c = add.cls(s, 'A'), t = add.teacher(s, 'T', { dispreferred: ['0-1'], dispreferred2: ['0-2'] });
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1] });
  const cost = (p) => { const e = new Engine(s, [pl(l, 0, 0, p, 1)]); return [e.unitCost(e.unitById[`${l.id}#0`].i) - e.W.late * p, e.totalCost().dispreferred]; };
  const W = new Engine(s, []).W;
  eq(cost(0), [0, 0]); eq(cost(1), [W.dispreferred, 1]); eq(cost(2), [W.dispreferred2, 1]);
  assert.ok(W.dispreferred2 > W.dispreferred, 'the strong level weighs more by default');
  // A class with ~ in the same period adds up with the teacher's ~~.
  s.classes[0].dispreferred = ['0-2'];
  eq(cost(2), [W.dispreferred + W.dispreferred2, 1]);
  s.classes[0].dispreferred = [];
  // With one free period at each level the lesson takes the plain ~ rather than ~~, and neither before free ones.
  t.dispreferred = ['0-0', '0-1']; t.dispreferred2 = ['0-2', '0-3']; t.unavailable = [];
  const free = solveAll(s);
  assert.strictEqual(free.engine.totalCost().dispreferred, 1, 'the lesson sits in a ~ period, never in ~~');
  assert.ok([0, 1].includes(free.placements[0].period));
  t.dispreferred = ['0-0', '0-1', '0-2']; t.dispreferred2 = ['0-3'];
  assert.ok(solveAll(s).placements[0].period !== 3);
});

check('room size: a lesson avoids rooms that seat fewer than its classes; parallel rows share a class size', () => {
  const s = school({ days: 2, periods: 4 });
  const subj = add.subject(s), t = add.teacher(s, 'T'), u = add.teacher(s, 'U');
  const a = add.cls(s, 'A', { size: 30 }), b = add.cls(s, 'B', { size: 20 }), none = add.cls(s, 'N');
  const small = add.room(s, 'Small', 'Room'), big = add.room(s, 'Big', 'Room'), free = add.room(s, 'Free', 'Room');
  small.capacity = 25; big.capacity = 35; free.capacity = 0;
  const la = add.lesson(s, subj, t, [a], 4, 1, { room: 'type:Room', maxOnePerDay: false });
  const e = new Engine(s, []);
  assert.strictEqual(e.units[0].parts[0].size, 30);
  assert.ok(e.tooSmall(e.units[0].parts[0], small.id) && !e.tooSmall(e.units[0].parts[0], big.id) && !e.tooSmall(e.units[0].parts[0], free.id), 'unknown capacity (0) never counts as too small');
  const r = solveAll(s);
  assert.strictEqual(r.placed, r.total);
  assert.ok(r.placements.every((p) => p.rooms[0] !== small.id), 'never the room that is too small while others are free');
  assert.strictEqual(r.engine.totalCost().roomTooSmall, 0);
  // Forced into the small room (only one room): counted and costed.
  const s2 = school({ days: 1, periods: 2 });
  const sub2 = add.subject(s2), t2 = add.teacher(s2, 'T'), c2 = add.cls(s2, 'A', { size: 30 });
  const r2 = add.room(s2, 'Only', 'Room'); r2.capacity = 20;
  const l2 = add.lesson(s2, sub2, t2, [c2], 0, 1, { lengths: [1], room: r2.id });
  const e2 = new Engine(s2, [pl(l2, 0, 0, 0, 1, [r2.id])]);
  assert.strictEqual(e2.totalCost().roomTooSmall, 1);
  assert.strictEqual(e2.unitCost(0) - e2.W.late * 0, e2.W.roomSize);
  // A class with no size (0) is never too big for a room.
  const e3 = new Engine({ ...s2, classes: [{ ...c2, size: 0 }] }, [pl(l2, 0, 0, 0, 1, [r2.id])]);
  assert.strictEqual(e3.totalCost().roomTooSmall, 0);
  // French ∥ Spanish for A+B: each row gets half of each class.
  const s3 = school({ days: 1, periods: 2 });
  const sub3 = add.subject(s3), A = add.cls(s3, 'A', { size: 30 }), B = add.cls(s3, 'B', { size: 20 });
  const lf = add.lesson(s3, sub3, add.teacher(s3, 'F'), [A, B], 1, 1, { parallel: 'Lang', room: 'type:Room' });
  const ls = add.lesson(s3, sub3, add.teacher(s3, 'S'), [A, B], 1, 1, { parallel: 'Lang', room: 'type:Room' });
  add.room(s3, 'R1', 'Room'); add.room(s3, 'R2', 'Room');
  const e4 = new Engine(s3, []);
  eq(e4.units[0].parts.map((p) => p.size), [25, 25], 'a share each, not 50');
  void none; void la; void lf; void ls; void b;
});

check('class rules: max periods/day is hard (evicts, then refuses), strict no-gaps weighs gaps heavily, free-in-~ multiplies the ~ cost', () => {
  const s = school({ days: 2, periods: 5 });
  const subj = add.subject(s), c = add.cls(s, 'A', { maxPerDay: 3 }), t = add.teacher(s, 'T'), u = add.teacher(s, 'U');
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1, 1, 1] });
  const dbl = add.lesson(s, subj, u, [c], 0, 1, { lengths: [4] });
  const e = new Engine(s, [pl(l, 0, 0, 0, 1), pl(l, 1, 0, 1, 1), pl(l, 2, 0, 2, 1)]);
  const u3 = e.unitById[`${l.id}#3`].i;
  const b = e.baseConflicts(u3, 3);
  assert.strictEqual(b.size, 1, 'a fourth period on Monday evicts one of the three');
  assert.strictEqual(e.baseConflicts(u3, 5).size, 0, 'Tuesday is free');
  assert.strictEqual(e.baseConflicts(e.unitById[`${dbl.id}#0`].i, 0), null, 'a block longer than the cap never fits');
  const locked = new Engine(s, [0, 1, 2].map((k) => ({ ...pl(l, k, 0, k, 1), locked: true })));
  assert.strictEqual(locked.baseConflicts(locked.unitById[`${l.id}#3`].i, 3), null, 'all locked: refused');
  s.lessons = [l]; l.lengths = [1, 1, 1, 1, 1, 1];
  const r = solveAll(s);
  assert.strictEqual(r.placed, r.total);
  for (let d = 0; d < 2; d++) assert.strictEqual(r.engine.dayStats(r.engine.occ['c' + c.id], d).n, 3);
  // Strict no-gaps.
  const g = school({ days: 1, periods: 5 });
  const gs = add.subject(g), gc = add.cls(g, 'A'), gt = add.teacher(g, 'T');
  const gl = add.lesson(g, gs, gt, [gc], 0, 1, { lengths: [1, 1] });
  const gap = () => new Engine(g, [pl(gl, 0, 0, 0, 1), pl(gl, 1, 0, 2, 1)]);
  assert.strictEqual(gap().classDayCost(gc.id, 0), gap().W.classGap);
  gc.noGaps = true;
  assert.strictEqual(gap().classDayCost(gc.id, 0), gap().W.classGapStrict, 'a no-gaps class pays the strict weight per gap');
  assert.ok(gap().W.classGapStrict > 3 * gap().W.classGap);
  // Free periods in ~ slots: a lesson in the class's ~ slot costs four times as much.
  const f = school({ days: 1, periods: 3 });
  const fs = add.subject(f), fc = add.cls(f, 'A'), ft = add.teacher(f, 'T');
  fc.dispreferred = ['0-1'];
  const fl = add.lesson(f, fs, ft, [fc], 0, 1, { lengths: [1] });
  const cost = () => { const x = new Engine(f, [pl(fl, 0, 0, 1, 1)]); return x.unitCost(0) - x.W.late * 1; };
  assert.strictEqual(cost(), new Engine(f, []).W.dispreferred);
  fc.forceFree = true;
  assert.strictEqual(cost(), 4 * new Engine(f, []).W.dispreferred);
});

check('class tutor: daily / first / last lesson wishes are counted per class day and carried by the costs', () => {
  const s = school({ days: 3, periods: 4 });
  const subj = add.subject(s), tutor = add.teacher(s, 'Tutor'), other = add.teacher(s, 'Other');
  const c = add.cls(s, 'A', { tutorId: tutor.id, tutorDaily: true, tutorEarly: true, tutorLate: true });
  const lt = add.lesson(s, subj, tutor, [c], 0, 1, { lengths: [1, 1, 1] }), lo = add.lesson(s, subj, other, [c], 0, 1, { lengths: [1, 1, 1] });
  // Monday: tutor first, other last → ok for daily and first, misses last. Tuesday: other only → misses all three. Wednesday: tutor first and last.
  const e = new Engine(s, [pl(lt, 0, 0, 0, 1), pl(lo, 0, 0, 3, 1), pl(lo, 1, 1, 1, 1), pl(lt, 1, 2, 0, 1), pl(lt, 2, 2, 3, 1)]);
  eq(e.tutorDay(c.id, 0), { daily: 0, early: 0, late: 1 });
  eq(e.tutorDay(c.id, 1), { daily: 1, early: 1, late: 1 });
  eq(e.tutorDay(c.id, 2), { daily: 0, early: 0, late: 0 });
  assert.strictEqual(e.totalCost().tutor, 4);
  const W = e.W;
  assert.strictEqual(e.classDayCost(c.id, 1) - W.classGap * e.dayStats(e.occ['c' + c.id], 1).gaps, W.tutorDaily + 2 * W.tutorEnds);
  // A day with no lessons at all costs nothing; wishes off cost nothing; an unknown tutor is ignored.
  const none = new Engine(s, []);
  eq(none.tutorDay(c.id, 0), { daily: 0, early: 0, late: 0 });
  c.tutorDaily = c.tutorEarly = c.tutorLate = false;
  assert.strictEqual(new Engine(s, e.placements()).totalCost().tutor, 0);
  c.tutorDaily = true; c.tutorId = 'gone';
  assert.strictEqual(new Engine(s, e.placements()).cRule[c.id].tutorRule, false);
  // Parallel parts: a part taught by the tutor for the class counts.
  c.tutorId = tutor.id;
  // Over a solve the tutor ends up with the class every day when that is possible.
  const s2 = school({ days: 4, periods: 4 }); s2.settings.weights = { tutorDaily: 8, late: 0 };
  const sj = add.subject(s2), tu = add.teacher(s2, 'Tutor'), ot = add.teacher(s2, 'Other');
  const c2 = add.cls(s2, 'A', { tutorId: tu.id, tutorDaily: true });
  add.lesson(s2, sj, tu, [c2], 4, 1, { maxOnePerDay: false }); add.lesson(s2, sj, ot, [c2], 8, 1, { maxOnePerDay: false });
  const r = solveAll(s2);
  assert.strictEqual(r.placed, r.total);
  assert.strictEqual(r.engine.totalCost().tutor, 0, 'the tutor teaches the class on each of the four days');
});

check('anonymous rooms (count N) become N interchangeable instances; dedicated rooms stay out of "any <type>"', () => {
  const s = school({ days: 1, periods: 3 });
  const subj = add.subject(s), t1 = add.teacher(s, 'T1'), t2 = add.teacher(s, 'T2'), t3 = add.teacher(s, 'T3');
  const gen = add.room(s, 'General', 'Classroom'); gen.count = 2; gen.capacity = 30;
  const own = add.room(s, 'Mrs Lee’s room', 'Classroom'); own.dedicated = true;
  eq(ctx.window.Timetable.expandRooms(s.rooms).map((r) => [r.id, r.name]), [[gen.id, 'General 1'], [`${gen.id}~2`, 'General 2'], [own.id, 'Mrs Lee’s room']]);
  assert.strictEqual(ctx.window.Timetable.expandRooms(s.rooms)[1].capacity, 30, 'instances copy the record');
  const l1 = add.lesson(s, subj, t1, [add.cls(s, 'A')], 1, 1, { room: 'type:Classroom' });
  const l2 = add.lesson(s, subj, t2, [add.cls(s, 'B')], 1, 1, { room: 'type:Classroom' });
  const l3 = add.lesson(s, subj, t3, [add.cls(s, 'C')], 1, 1, { room: 'type:Classroom' });
  const e = new Engine(s, []);
  eq(e.units[0].parts[0].roomCands, [gen.id, `${gen.id}~2`], 'any Classroom: the two general rooms, not the dedicated one');
  // Three lessons at one time need three rooms; only two non-dedicated exist, so one cannot share the slot.
  const pls = [pl(l1, 0, 0, 0, 1, [gen.id]), pl(l2, 0, 0, 0, 1, [`${gen.id}~2`]), pl(l3, 0, 0, 0, 1, [gen.id])];
  const e2 = new Engine(s, pls);
  assert.strictEqual(e2.pos.filter(Boolean).length, 2, 'the third booking of General 1 is refused');
  // Naming the record asks for any instance; a pinned dedicated room is allowed by name.
  l1.room = gen.id; l2.room = own.id;
  const e3 = new Engine(s, []);
  eq(e3.units[0].parts[0].roomCands, [gen.id, `${gen.id}~2`], 'the record by id = any of its instances');
  assert.strictEqual(e3.units[0].parts[0].prefRoom, null, 'no favourite instance of an anonymous group');
  eq(e3.units[1].parts[0].roomCands, [own.id]);
  assert.strictEqual(e3.units[1].parts[0].prefRoom, own.id, 'a single named room is still preferred');
  // Solving puts three simultaneous lessons into the two instances plus ... only two fit: the solver needs three slots.
  const r = solveAll(s);
  assert.strictEqual(r.placed, r.total);
  assert.ok(new Set(r.placements.filter((p) => p.rooms[0] && p.rooms[0].startsWith(gen.id)).map((p) => `${p.day}-${p.period}-${p.rooms[0]}`)).size === r.placements.filter((p) => p.rooms[0] && p.rooms[0].startsWith(gen.id)).length, 'no instance double-booked');
  // Demand and capacity count instances.
  const d = new Engine(s, []).roomDemand().find((x) => x.rooms.length === 2);
  assert.ok(d && d.capacity === 6, '2 instances × 3 periods');
});

// ---------- teacher week rules (maxConsecutive, presence, freeDays, noLastFirst) ----------
const heldDays = (engine, t) => Array.from({ length: engine.D }, (_, d) => engine.heldPeriods(t.id, d, () => false).length);

check('maxConsecutive: runs over the limit cost per extra period; a break ends the run unless a lesson straddles it', () => {
  const s = school({ days: 1, periods: 'tttbtt' });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T', { maxConsecutive: 2 });
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1, 1, 1, 1], allowBreakInside: true });
  const e = new Engine(s, [[0, 0], [1, 1], [2, 2], [3, 4], [4, 5]].map(([k, p]) => pl(l, k, 0, p, 1)));
  eq(e.teacherDayRules(t.id, 0), { consecutive: 1, presence: 0 }, '0,1,2 | break | 4,5');
  assert.strictEqual(e.totalCost().consecutive, 1);
  assert.strictEqual(e.teacherDayCost(t.id, 0) - e.W.teacherGap * e.dayStats(e.occ['t' + t.id], 0).gaps, e.W.consecutive);
  const s2 = school({ days: 1, periods: 'tttbtt' });
  const subj2 = add.subject(s2), c2 = add.cls(s2), t2 = add.teacher(s2, 'T', { maxConsecutive: 2 });
  const l2 = add.lesson(s2, subj2, t2, [c2], 0, 1, { lengths: [1, 1, 2], allowBreakInside: true });
  const e2 = new Engine(s2, [pl(l2, 0, 0, 0, 1), pl(l2, 1, 0, 1, 1), pl(l2, 2, 0, 2, 2)]);
  assert.strictEqual(e2.units[2].len, 2); eq(e2.pos[2].span, [2, 3, 4], 'the double straddles the break');
  assert.strictEqual(e2.teacherDayRules(t2.id, 0).consecutive, 2, '0,1,2,(break held),4 is one run of four');
  assert.strictEqual(new Engine(s2, []).teacherDayRules(t2.id, 0).consecutive, 0);
  // Over a solve: five single lessons for different classes fit in 2+2+… only around the break.
  const s3 = school({ days: 1, periods: 'tttbtt' }); s3.settings.weights = { consecutive: 5, teacherGap: 0.01 };
  const subj3 = add.subject(s3), t3 = add.teacher(s3, 'T', { maxConsecutive: 2 });
  for (let i = 0; i < 4; i++) add.lesson(s3, subj3, t3, [add.cls(s3, 'C' + i)], 1, 1);
  const { engine, placed, total } = solveAll(s3);
  assert.strictEqual(placed, total);
  assert.strictEqual(engine.totalCost().consecutive, 0, `held ${engine.heldPeriods(t3.id, 0, () => false)}`);
});

check('presence: first to last period (gaps included), lunch only with countMiddayGap; day and week excess', () => {
  const s = school({ days: 2, periods: 'ttltt', options: {} });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T', { maxPresenceDay: 2, maxPresenceWeek: 3 });
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1, 1, 1] });
  const at = (cells, opts) => new Engine(opts ? { ...s, settings: { ...s.settings, options: opts } } : s, cells.map(([d, p], k) => pl(l, k, d, p, 1)));
  let e = at([[0, 1], [0, 3], [1, 0]]);
  assert.strictEqual(e.presenceOf(0, [1, 3]), 2, 'lunch is not counted');
  assert.strictEqual(e.teacherDayRules(t.id, 0).presence, 0);
  assert.strictEqual(at([[0, 1], [0, 3]], { countMiddayGap: true }).presenceOf(0, [1, 3]), 3, 'lunch counted');
  eq(heldDays(e, t), [2, 1]);
  assert.strictEqual(e.teacherPresenceWeek(t.id), 0, 'presence 2 + 1 = 3');
  e = at([[0, 0], [0, 4], [1, 0]]);
  assert.strictEqual(e.teacherDayRules(t.id, 0).presence, 2, 'periods 0..4 without lunch = 4, limit 2');
  assert.strictEqual(e.teacherPresenceWeek(t.id), 2, 'week 4 + 1 = 5, limit 3');
  const st = e.totalCost();
  assert.strictEqual(st.presence, 4, 'day excess 2 + week excess 2');
  assert.strictEqual(e.teacherWeekCost(t.id) - e.W.balance * e.teacherBalance(t.id), 2 * e.W.presence);
});

check('presenceStrict is hard for every unit in teaching periods: a start that widens the day past the limit is refused', () => {
  const s = school({ days: 2, periods: 5 });
  const subj = add.subject(s), c1 = add.cls(s, 'A'), c2 = add.cls(s, 'B'), t = add.teacher(s, 'T', { maxPresenceDay: 3, presenceStrict: true });
  const l1 = add.lesson(s, subj, t, [c1], 1, 1), l2 = add.lesson(s, subj, t, [c2], 1, 1);
  const e = new Engine(s, [pl(l1, 0, 0, 0, 1)]);
  const u2 = e.unitById[`${l2.id}#0`].i;
  for (const [p, ok] of [[1, true], [2, true], [3, false], [4, false]]) assert.strictEqual(e.baseConflicts(u2, p) !== null, ok, `Monday period ${p}`);
  assert.notStrictEqual(e.baseConflicts(u2, 5 + 4), null, 'a fresh day is always fine');
  const soft = new Engine({ ...s, teachers: [{ ...t, presenceStrict: false }] }, [pl(l1, 0, 0, 0, 1)]);
  assert.notStrictEqual(soft.baseConflicts(soft.unitById[`${l2.id}#0`].i, 4), null, 'soft limit only costs');
  // A weekly strict limit counts the other days.
  const sw = school({ days: 2, periods: 5 });
  const sub = add.subject(sw), a = add.cls(sw, 'A'), b = add.cls(sw, 'B'), tw = add.teacher(sw, 'T', { maxPresenceWeek: 3, presenceStrict: true });
  const w1 = add.lesson(sw, sub, tw, [a], 1, 1, { lengths: [1, 1] }), w2 = add.lesson(sw, sub, tw, [b], 1, 1);
  const ew = new Engine(sw, [pl(w1, 0, 0, 0, 1), pl(w1, 1, 0, 2, 1)]); // Monday presence 3
  const v = ew.unitById[`${w2.id}#0`].i;
  assert.strictEqual(ew.baseConflicts(v, 5 + 0), null, 'Tuesday would make 4 in the week');
  assert.notStrictEqual(ew.baseConflicts(v, 1), null, 'inside Monday\'s span the week stays 3');
  // Meetings and duties are bound too (a break duty holds no teaching period, so it is not).
  const sm = school({ days: 1, periods: 'tttbttt' });
  const sj = add.subject(sm), cm = add.cls(sm, 'A'), tm = add.teacher(sm, 'T', { maxPresenceDay: 3, presenceStrict: true }), um = add.teacher(sm, 'U');
  const lm = add.lesson(sm, sj, tm, [cm], 1, 1);
  const mt = add.meeting(sm, 'Sync', [tm, um]); const dt = add.duty(sm, 'Yard', [[tm, 1]], { kind: 'break' });
  const em = new Engine(sm, [pl(lm, 0, 0, 0, 1)]);
  const mi = em.unitById[`m:${mt.id}#0`].i, di = em.unitById[`d:${dt.id}:${tm.id}#0`].i;
  assert.strictEqual(em.baseConflicts(mi, 4), null, 'a meeting in the 4th teaching period would stretch the day to 4');
  assert.notStrictEqual(em.baseConflicts(mi, 2), null);
  assert.notStrictEqual(em.baseConflicts(di, 3), null, 'break supervision is not teaching presence');
  // Over a solve all lessons are placed and every day stays within the limit.
  const s3 = school({ days: 3, periods: 6 });
  const sub3 = add.subject(s3), t3 = add.teacher(s3, 'T', { maxPresenceDay: 3, presenceStrict: true });
  for (let i = 0; i < 6; i++) add.lesson(s3, sub3, t3, [add.cls(s3, 'C' + i)], 1, 1);
  const r = solveAll(s3);
  assert.strictEqual(r.placed, r.total);
  for (let d = 0; d < 3; d++) assert.ok(r.engine.presenceOf(d, r.engine.heldPeriods(t3.id, d, () => false)) <= 3, `day ${d}`);
});

check('freeDays is hard for lessons (meetings do not count); balance spreads over the remaining days', () => {
  const s = school({ days: 5, periods: 4 });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T', { freeDays: 2 }), u = add.teacher(s, 'U');
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1, 1, 1] });
  const other = add.lesson(s, subj, t, [add.cls(s, 'B')], 1, 1);
  const e = new Engine(s, [pl(l, 0, 0, 0, 1), pl(l, 1, 1, 0, 1), pl(l, 2, 2, 0, 1)]);
  const o = e.unitById[`${other.id}#0`].i;
  for (const d of [0, 1, 2]) assert.notStrictEqual(e.baseConflicts(o, d * 4 + 1), null, `day ${d} is already worked`);
  for (const d of [3, 4]) {
    const b = e.baseConflicts(o, d * 4);
    assert.strictEqual(b.size, 1, `day ${d}: opening it clears the lightest worked day`);
    assert.ok([0, 1, 2].includes(e.dayOf(e.pos[[...b][0]].s)));
  }
  const locked = new Engine(s, [0, 1, 2].map((k) => ({ ...pl(l, k, k, 0, 1), locked: true })));
  for (const d of [3, 4]) assert.strictEqual(locked.baseConflicts(locked.unitById[`${other.id}#0`].i, d * 4), null, `day ${d} must stay free when every worked day is locked`);
  // Freeing a day by eviction is taken into account: the lesson on Monday is the only one there.
  const m = add.meeting(s, 'Staff', [t, u]);
  const em = new Engine(s, [pl(l, 0, 0, 0, 1), pl(l, 1, 1, 0, 1), pl(l, 2, 2, 0, 1)]);
  assert.notStrictEqual(em.baseConflicts(em.unitById[`m:${m.id}#0`].i, 3 * 4), null, 'a meeting may use a lesson-free day');
  // Balance ignores the free days: 2/1/1 over three working days is even.
  const e2 = new Engine(s, [pl(l, 0, 0, 0, 1), pl(l, 1, 0, 1, 1), pl(l, 2, 1, 0, 1), pl(l, 3, 2, 0, 1)]);
  assert.strictEqual(e2.teacherBalance(t.id), 0, '2/1/1 and two empty days');
  assert.strictEqual(new Engine(s, [0, 1, 2, 3].map((k) => pl(l, k, 0, k, 1))).teacherBalance(t.id), 4, '4/0/0 over three working days (mean 1.33): 2 above 2, 2 below 1');
  // Over a solve: everything is placed on three days or fewer.
  const s3 = school({ days: 5, periods: 4 });
  const sub3 = add.subject(s3), t3 = add.teacher(s3, 'T', { freeDays: 2 });
  for (let i = 0; i < 8; i++) add.lesson(s3, sub3, t3, [add.cls(s3, 'C' + i)], 1, 1);
  const r = solveAll(s3);
  assert.strictEqual(r.placed, r.total);
  assert.ok(heldDays(r.engine, t3).filter(Boolean).length <= 3, `days held ${heldDays(r.engine, t3)}`);
});

check('noLastFirst: last period one day and first the next, soft; the annealer avoids it', () => {
  const s = school({ days: 3, periods: 'ttltt', blocked: [] });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T', { noLastFirst: true });
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1, 1] });
  const e = new Engine(s, [pl(l, 0, 0, 4, 1), pl(l, 1, 1, 0, 1), pl(l, 2, 1, 4, 1)]);
  assert.strictEqual(e.teacherExclusive(t.id), 1, 'Mon last → Tue first');
  assert.strictEqual(e.totalCost().exclusive, 1);
  assert.strictEqual(e.teacherWeekCost(t.id) - e.W.balance * e.teacherBalance(t.id), e.W.exclusive);
  assert.strictEqual(new Engine(s, [pl(l, 0, 0, 3, 1), pl(l, 1, 1, 0, 1), pl(l, 2, 1, 4, 1)]).teacherExclusive(t.id), 0, 'period 3 is not the last');
  assert.strictEqual(new Engine(s, [pl(l, 0, 1, 4, 1), pl(l, 1, 0, 0, 1)]).teacherExclusive(t.id), 0, 'first one day then last the next day is allowed');
  const off = new Engine({ ...s, teachers: [{ ...t, noLastFirst: false }] }, e.placements());
  assert.strictEqual(off.totalCost().exclusive, 0, 'rule off');
  // Over a solve (forced onto the ends when the weight is 0, avoided when it is high).
  const s2 = school({ days: 3, periods: 3 }); s2.settings.weights = { exclusive: 10, late: 0, balance: 0 };
  const sub2 = add.subject(s2), t2 = add.teacher(s2, 'T', { noLastFirst: true });
  for (let i = 0; i < 5; i++) add.lesson(s2, sub2, t2, [add.cls(s2, 'C' + i)], 1, 1);
  const r = solveAll(s2);
  assert.strictEqual(r.placed, r.total);
  assert.strictEqual(r.engine.totalCost().exclusive, 0);
});

check('teachers without week rules cost and behave as before', () => {
  const s = school({ days: 3, periods: 4 });
  const subj = add.subject(s), c = add.cls(s), t = add.teacher(s, 'T');
  const l = add.lesson(s, subj, t, [c], 0, 1, { lengths: [1, 1, 1] });
  const e = new Engine(s, [pl(l, 0, 0, 0, 1), pl(l, 1, 0, 1, 1), pl(l, 2, 0, 2, 1)]);
  eq(Object.entries(e.tRule[t.id]).filter(([k, v]) => v && !['priority', 'exWindow'].includes(k)), [], 'every week rule is off by default');
  const st = e.totalCost();
  assert.strictEqual(st.consecutive + st.presence + st.exclusive, 0);
});

console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
