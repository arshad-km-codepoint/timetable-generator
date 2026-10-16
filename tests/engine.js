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

console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
