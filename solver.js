// Timetable engine: hard-constraint bookkeeping, conflict-driven construction
// (place a unit, evict whatever clashes, re-queue it) and a simulated-annealing
// pass that improves the weighted soft criteria without breaking any hard rule.
//
// A "unit" is one session to place. Lessons that share a parallel-group tag are
// merged into one unit with several parts (e.g. a class split across two teachers
// and rooms at the same time); each part keeps its own teacher, classes and room.

const DEFAULT_WEIGHTS = { classGap: 3, teacherGap: 1, sameDay: 4, late: 0.15, dispreferred: 2, teacherMin: 2, dutyUncovered: 1 };

class Engine {
  constructor(data, placements = []) {
    const D = data.settings.days.length;
    const P = data.settings.periods.length;
    this.D = D; this.P = P; this.N = D * P;
    this.W = { ...DEFAULT_WEIGHTS, ...(data.settings.weights || {}) };

    const slots = (keys) => new Set((keys || []).map((k) => {
      const [d, p] = k.split('-').map(Number);
      return d * P + p;
    }));
    const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
    this.teachers = byId(data.teachers);
    this.classes = byId(data.classes);
    this.rooms = byId(data.rooms);
    this.subjects = byId(data.subjects);
    this.blocked = {}; this.soft = {};
    for (const [kind, list] of [['t', data.teachers], ['c', data.classes], ['r', data.rooms]]) {
      for (const x of list) {
        this.blocked[kind + x.id] = slots(x.unavailable);
        this.soft[kind + x.id] = slots(x.dispreferred);
      }
    }
    this.tMax = {}; this.tMin = {};
    data.teachers.forEach((t) => { this.tMax[t.id] = Number(t.maxPerDay) || 0; this.tMin[t.id] = Number(t.minPerDay) || 0; });

    this.problems = [];
    const groups = new Map();
    for (const l of data.lessons) {
      const key = l.parallel && l.parallel.trim() ? 'p:' + l.parallel.trim().toLowerCase() : 'l:' + l.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l);
    }

    this.units = [];
    this.groupUnits = {};
    for (const [key, lessons] of groups) {
      const parts = [];
      for (const l of lessons) {
        const classes = (l.classIds || []).filter((id) => this.classes[id]);
        const roomCands = this.roomCandidates(l.room, data.rooms);
        const bad = !this.subjects[l.subjectId] ? 'has no subject' : !this.teachers[l.teacherId] ? 'has no teacher'
          : !classes.length ? 'has no class' : roomCands && !roomCands.length ? 'needs a room type that has no rooms' : null;
        if (bad) { this.problems.push({ lessonIds: [l.id], msg: bad }); continue; }
        parts.push({ kind: 'lesson', ref: l.id, lessonId: l.id, teacher: l.teacherId, classes, roomCands, sessions: Number(l.sessions) || 0, len: Math.max(1, Math.min(P, Number(l.length) || 1)), maxOne: !!l.maxOnePerDay });
      }
      if (!parts.length) continue;
      const tag = key.startsWith('p:') ? lessons[0].parallel.trim() : null;
      if (parts.some((p) => p.sessions !== parts[0].sessions || p.len !== parts[0].len)) {
        this.problems.push({ lessonIds: parts.map((p) => p.lessonId), msg: `are in parallel group “${tag}” but have different sessions/length` });
        continue;
      }
      const teachers = [...new Set(parts.map((p) => p.teacher))];
      if (teachers.length < parts.length) {
        this.problems.push({ lessonIds: parts.map((p) => p.lessonId), msg: `are in parallel group “${tag}” but share a teacher` });
        continue;
      }
      this.addUnits(parts.map((p) => p.lessonId).join('+'), 'lesson', parts, parts[0].len, parts[0].sessions, parts.some((p) => p.maxOne), null);
    }

    // Teacher meetings: all members free at once; never evict lessons (see Solver).
    const allowedSet = (keys) => (keys && keys.length ? slots(keys) : null);
    for (const m of data.meetings || []) {
      const members = [...new Set((m.teacherIds || []).filter((t) => this.teachers[t]))];
      const roomCands = this.roomCandidates(m.room, data.rooms);
      const bad = !members.length ? 'has no members' : roomCands && !roomCands.length ? 'needs a room that does not exist' : null;
      if (bad) { this.problems.push({ meetingId: m.id, msg: bad }); continue; }
      const sessions = Number(m.sessions) || 0;
      const parts = members.map((t, k) => ({ kind: 'meeting', ref: m.id, teacher: t, classes: [], roomCands: k === 0 ? roomCands : null }));
      this.addUnits('m:' + m.id, 'meeting', parts, Math.max(1, Math.min(P, Number(m.length) || 1)), sessions, sessions > 1, allowedSet(m.allowed));
    }

    // On-call duties: one unit per assigned hour; capacity per period is hard, coverage is soft.
    this.services = {};
    for (const svc of data.duties || []) {
      const allowed = allowedSet(svc.allowed) || new Set([...Array(this.N).keys()]);
      this.services[svc.id] = { max: Math.max(1, Number(svc.maxPerSlot) || 1), allowed, occ: Array.from({ length: this.N }, () => new Set()) };
      for (const a of svc.assignments || []) {
        if (!this.teachers[a.teacherId] || !(Number(a.hours) > 0)) continue;
        const parts = [{ kind: 'duty', ref: svc.id, teacher: a.teacherId, classes: [], roomCands: null }];
        this.addUnits(`d:${svc.id}:${a.teacherId}`, 'duty', parts, 1, Number(a.hours), false, allowed, svc.id);
      }
    }

    this.occ = {};
    for (const t in this.teachers) this.occ['t' + t] = new Int32Array(this.N).fill(-1);
    for (const c in this.classes) this.occ['c' + c] = new Int32Array(this.N).fill(-1);
    for (const r in this.rooms) this.occ['r' + r] = new Int32Array(this.N).fill(-1);
    this.pos = new Array(this.units.length).fill(null);
    this.locked = new Array(this.units.length).fill(false);
    this.unitById = Object.fromEntries(this.units.map((u) => [u.id, u]));

    for (const pl of placements) {
      const u = this.unitById[pl.unitId];
      if (!u || u.len !== pl.len) continue;
      const s = pl.day * P + pl.period;
      if (!u.starts.includes(s)) continue;
      const base = this.baseConflicts(u.i, s);
      if (base === null || base.size) continue;
      let rooms = Array.isArray(pl.rooms) && pl.rooms.length === u.parts.length ? pl.rooms : null;
      if (rooms && !this.roomsValid(u.i, s, rooms)) rooms = null;
      if (!rooms) { const pick = this.bestRooms(u.i, s, base); if (!pick || pick.conf.size) continue; rooms = pick.rooms; }
      this.place(u.i, s, rooms);
      this.locked[u.i] = !!pl.locked;
    }
  }

  addUnits(gkey, kind, parts, len, sessions, maxOne, allowed, service = null) {
    const { D, P } = this;
    const teachers = [...new Set(parts.map((p) => p.teacher))];
    const classes = [...new Set(parts.flatMap((p) => p.classes))];
    const starts = [];
    for (let d = 0; d < D; d++) {
      for (let p = 0; p + len <= P; p++) {
        let ok = true;
        for (let q = 0; q < len && ok; q++) {
          const s = d * P + p + q;
          if (allowed && !allowed.has(s)) ok = false;
          for (const t of teachers) if (this.blocked['t' + t].has(s)) ok = false;
          for (const c of classes) if (this.blocked['c' + c].has(s)) ok = false;
        }
        if (ok) starts.push(d * P + p);
      }
    }
    const idxs = [];
    for (let k = 0; k < sessions; k++) {
      idxs.push(this.units.length);
      this.units.push({ i: this.units.length, id: `${gkey}#${k}`, key: gkey, kind, service, len, parts, teachers, classes, maxOne, starts });
    }
    this.groupUnits[gkey] = idxs;
  }

  // null = lesson needs no room; [] = needs a room but none qualify.
  roomCandidates(spec, rooms) {
    if (!spec) return null;
    if (spec.startsWith('type:')) {
      const type = spec.slice(5);
      return rooms.filter((r) => (r.type || '') === type).map((r) => r.id);
    }
    return rooms.some((r) => r.id === spec) ? [spec] : [];
  }

  dayOf(s) { return Math.floor(s / this.P); }

  // Units that must leave for unit ui to start at s (rooms aside), or null if impossible.
  baseConflicts(ui, s) {
    const u = this.units[ui];
    const out = new Set();
    for (let q = 0; q < u.len; q++) {
      for (const t of u.teachers) { const o = this.occ['t' + t][s + q]; if (o >= 0 && o !== ui) out.add(o); }
      for (const c of u.classes) { const o = this.occ['c' + c][s + q]; if (o >= 0 && o !== ui) out.add(o); }
    }
    const d = this.dayOf(s);
    if (u.maxOne) {
      for (const vi of this.groupUnits[u.key]) if (vi !== ui && this.pos[vi] && this.dayOf(this.pos[vi].s) === d) out.add(vi);
    }
    if (u.service) {
      const svc = this.services[u.service];
      const here = [...svc.occ[s]].filter((o) => o !== ui && !out.has(o));
      if (here.length >= svc.max) {
        const movable = here.filter((o) => !this.locked[o]);
        const need = here.length - svc.max + 1;
        if (movable.length < need) return null;
        movable.slice(0, need).forEach((o) => out.add(o));
      }
    }
    // Max periods/day limits teaching only; meetings and duties don't count.
    for (const t of u.kind === 'lesson' ? u.teachers : []) {
      const max = this.tMax[t];
      if (!max) continue;
      if (u.len > max) return null;
      const occ = this.occ['t' + t];
      const onDay = new Map();
      for (let p = 0; p < this.P; p++) {
        const o = occ[d * this.P + p];
        if (o >= 0 && o !== ui && !out.has(o) && this.units[o].kind === 'lesson') onDay.set(o, (onDay.get(o) || 0) + 1);
      }
      let load = [...onDay.values()].reduce((a, b) => a + b, 0) + u.len;
      for (const [o, n] of [...onDay].sort((a, b) => a[1] - b[1])) {
        if (load <= max) break;
        if (this.locked[o]) continue;
        out.add(o); load -= n;
      }
      if (load > max) return null;
    }
    return out;
  }

  roomsValid(ui, s, rooms) {
    const u = this.units[ui];
    const used = new Set();
    for (let k = 0; k < u.parts.length; k++) {
      const part = u.parts[k]; const r = rooms[k];
      if (!part.roomCands) { if (r) return false; continue; }
      if (!part.roomCands.includes(r) || used.has(r)) return false;
      used.add(r);
      for (let q = 0; q < u.len; q++) if (this.blocked['r' + r].has(s + q)) return false;
    }
    return true;
  }

  roomConflicts(ui, s, rooms) {
    const u = this.units[ui]; const out = new Set();
    for (const r of rooms) if (r) for (let q = 0; q < u.len; q++) { const o = this.occ['r' + r][s + q]; if (o >= 0 && o !== ui) out.add(o); }
    return out;
  }

  // Greedy room choice per part: distinct rooms, fewest extra evictions. null if no valid rooms.
  bestRooms(ui, s, base) {
    const u = this.units[ui];
    const conf = new Set(base); const rooms = []; const used = new Set();
    for (const part of u.parts) {
      if (!part.roomCands) { rooms.push(null); continue; }
      let best = null;
      for (const r of part.roomCands) {
        if (used.has(r)) continue;
        let ok = true; const extra = new Set();
        for (let q = 0; q < u.len; q++) {
          if (this.blocked['r' + r].has(s + q)) { ok = false; break; }
          const o = this.occ['r' + r][s + q]; if (o >= 0 && o !== ui && !conf.has(o)) extra.add(o);
        }
        if (!ok) continue;
        const score = extra.size * 10 + (this.soft['r' + r].has(s) ? 1 : 0);
        if (!best || score < best.score) best = { r, extra, score };
        if (score === 0) break;
      }
      if (!best) return null;
      used.add(best.r); rooms.push(best.r); best.extra.forEach((o) => conf.add(o));
    }
    return { rooms, conf };
  }

  place(ui, s, rooms) {
    const u = this.units[ui];
    for (let q = 0; q < u.len; q++) {
      for (const t of u.teachers) this.occ['t' + t][s + q] = ui;
      for (const c of u.classes) this.occ['c' + c][s + q] = ui;
      for (const r of rooms) if (r) this.occ['r' + r][s + q] = ui;
      if (u.service) this.services[u.service].occ[s + q].add(ui);
    }
    this.pos[ui] = { s, rooms };
  }

  remove(ui) {
    const u = this.units[ui]; const p = this.pos[ui];
    if (!p) return;
    for (let q = 0; q < u.len; q++) {
      for (const t of u.teachers) this.occ['t' + t][p.s + q] = -1;
      for (const c of u.classes) this.occ['c' + c][p.s + q] = -1;
      for (const r of p.rooms) if (r) this.occ['r' + r][p.s + q] = -1;
      if (u.service) this.services[u.service].occ[p.s + q].delete(ui);
    }
    this.pos[ui] = null;
  }

  dayStats(occ, d) {
    let first = -1, last = -1, n = 0;
    for (let p = 0; p < this.P; p++) if (occ[d * this.P + p] >= 0) { if (first < 0) first = p; last = p; n++; }
    return { gaps: first < 0 ? 0 : last - first + 1 - n, n };
  }

  teacherDayCost(t, d) {
    const { gaps, n } = this.dayStats(this.occ['t' + t], d);
    const min = this.tMin[t];
    return this.W.teacherGap * gaps + (min && n > 0 && n < min ? this.W.teacherMin * (min - n) : 0);
  }

  // Duty periods on day d with nobody on call.
  uncovered(service, d) {
    const svc = this.services[service]; let n = 0;
    for (let p = 0; p < this.P; p++) { const k = d * this.P + p; if (svc.allowed.has(k) && !svc.occ[k].size) n++; }
    return n;
  }

  classDayCost(c, d) { return this.W.classGap * this.dayStats(this.occ['c' + c], d).gaps; }

  sameDayCount(key, d) {
    let n = 0;
    for (const vi of this.groupUnits[key]) if (this.pos[vi] && this.dayOf(this.pos[vi].s) === d) n++;
    return n;
  }

  // Cost that depends only on where this unit sits: late periods and non-preferred cells.
  unitCost(ui) {
    const u = this.units[ui]; const p = this.pos[ui];
    if (!p) return 0;
    let soft = 0;
    for (let q = 0; q < u.len; q++) {
      const k = p.s + q;
      for (const t of u.teachers) if (this.soft['t' + t].has(k)) soft++;
      for (const c of u.classes) if (this.soft['c' + c].has(k)) soft++;
      for (const r of p.rooms) if (r && this.soft['r' + r].has(k)) soft++;
    }
    return this.W.late * ((p.s % this.P) + u.len - 1) + this.W.dispreferred * soft;
  }

  // Soft cost restricted to the entities/days a unit touches.
  localCost(ui, days) {
    const u = this.units[ui];
    let c = 0;
    for (const d of days) {
      for (const t of u.teachers) c += this.teacherDayCost(t, d);
      for (const k of u.classes) c += this.classDayCost(k, d);
      c += this.W.sameDay * Math.max(0, this.sameDayCount(u.key, d) - 1);
      if (u.service) c += this.W.dutyUncovered * this.uncovered(u.service, d);
    }
    return c + this.unitCost(ui);
  }

  totalCost() {
    const st = { teacherGaps: 0, classGaps: 0, sameDay: 0, dispreferred: 0, teacherMin: 0, dutyUncovered: 0 };
    let c = 0;
    for (let d = 0; d < this.D; d++) {
      for (const t in this.teachers) {
        c += this.teacherDayCost(t, d);
        const { gaps, n } = this.dayStats(this.occ['t' + t], d);
        st.teacherGaps += gaps;
        if (this.tMin[t] && n > 0 && n < this.tMin[t]) st.teacherMin++;
      }
      for (const k in this.classes) { c += this.classDayCost(k, d); st.classGaps += this.dayStats(this.occ['c' + k], d).gaps; }
      for (const key in this.groupUnits) {
        const extra = Math.max(0, this.sameDayCount(key, d) - 1);
        st.sameDay += extra; c += this.W.sameDay * extra;
      }
      for (const id in this.services) { const n = this.uncovered(id, d); st.dutyUncovered += n; c += this.W.dutyUncovered * n; }
    }
    this.units.forEach((u, i) => {
      const p = this.pos[i]; if (!p) return;
      c += this.unitCost(i);
      for (let q = 0; q < u.len; q++) {
        const k = p.s + q;
        if (u.teachers.some((t) => this.soft['t' + t].has(k)) || u.classes.some((x) => this.soft['c' + x].has(k)) || p.rooms.some((r) => r && this.soft['r' + r].has(k))) st.dispreferred++;
      }
    });
    st.cost = Math.round(c * 10) / 10;
    return st;
  }

  placements() {
    return this.units.flatMap((u, i) => {
      const p = this.pos[i];
      if (!p) return [];
      return [{ unitId: u.id, day: this.dayOf(p.s), period: p.s % this.P, len: u.len, rooms: p.rooms, locked: this.locked[i] }];
    });
  }
}

class Solver {
  constructor(data, keepPlacements) {
    this.e = new Engine(data, keepPlacements);
    const e = this.e;
    // Discard every non-locked unit so construction starts clean around the locks.
    e.units.forEach((u, i) => { if (!e.locked[i]) e.remove(i); });
    this.rejections = new Array(e.units.length).fill(0);
    this.impossible = e.units.filter((u, i) => !e.locked[i] && !u.starts.length).map((u) => u.i);
    const order = e.units
      .filter((u, i) => !e.locked[i] && u.starts.length)
      .map((u) => ({ i: u.i, k: u.starts.length / (u.len * u.parts.length) + Math.random() * 2 }));
    order.sort((a, b) => a.k - b.k);
    this.queue = order.map((o) => o.i);
    this.iter = 0;
    this.maxIter = Math.max(20000, e.units.length * 400);
    this.phase = 'construct';
    this.saIter = 0;
    this.saMax = Math.min(600000, Math.max(40000, e.units.length * 1500));
    this.T0 = 3; this.T1 = 0.02;
  }

  constructStep() {
    const e = this.e;
    const ui = this.queue.shift();
    const u = e.units[ui];
    let bestFree = null, bestClash = null;
    for (const s of e.units[ui].starts) {
      const base = e.baseConflicts(ui, s);
      if (!base || [...base].some((o) => e.locked[o])) continue;
      const pick = e.bestRooms(ui, s, base);
      if (!pick || [...pick.conf].some((o) => e.locked[o])) continue;
      if (pick.conf.size === 0) {
        const d = e.dayOf(s);
        e.place(ui, s, pick.rooms);
        const score = e.localCost(ui, [d]) + Math.random() * 0.5;
        e.remove(ui);
        if (!bestFree || score < bestFree.score) bestFree = { s, rooms: pick.rooms, score };
      } else if (!bestFree) {
        // Meetings and duties may displace lessons, but at a higher price than the reverse.
        let score = Math.random();
        for (const o of pick.conf) score += (u.kind !== 'lesson' && e.units[o].kind === 'lesson' ? 3 : 1) * (1 + 2 * this.rejections[o]);
        if (!bestClash || score < bestClash.score) bestClash = { s, rooms: pick.rooms, conf: pick.conf, score };
      }
    }
    if (bestFree) { e.place(ui, bestFree.s, bestFree.rooms); return; }
    if (!bestClash) { this.impossible.push(ui); return; }
    for (const o of bestClash.conf) { e.remove(o); this.rejections[o]++; this.queue.unshift(o); }
    e.place(ui, bestClash.s, bestClash.rooms);
  }

  annealStep() {
    const e = this.e;
    const ui = Math.floor(Math.random() * e.units.length);
    const u = e.units[ui];
    const cur = e.pos[ui];
    if (!cur || e.locked[ui] || u.starts.length < 2) return;
    const s = u.starts[Math.floor(Math.random() * u.starts.length)];
    if (s === cur.s) return;
    e.remove(ui);
    const base = e.baseConflicts(ui, s);
    const pick = base && base.size === 0 ? e.bestRooms(ui, s, base) : null;
    if (!pick || pick.conf.size) { e.place(ui, cur.s, cur.rooms); return; }
    const days = [...new Set([e.dayOf(cur.s), e.dayOf(s)])];
    e.place(ui, cur.s, cur.rooms);
    const before = e.localCost(ui, days);
    e.remove(ui); e.place(ui, s, pick.rooms);
    const delta = e.localCost(ui, days) - before;
    const T = this.T0 * Math.pow(this.T1 / this.T0, this.saIter / this.saMax);
    if (delta <= 0 || Math.random() < Math.exp(-delta / T)) {
      this.cost += delta;
      if (this.cost < this.bestCost - 1e-9) { this.bestCost = this.cost; this.best = e.pos.slice(); }
    } else {
      e.remove(ui); e.place(ui, cur.s, cur.rooms);
    }
  }

  restoreBest() {
    if (!this.best) return;
    const e = this.e;
    e.units.forEach((u, i) => e.remove(i));
    this.best.forEach((p, i) => { if (p) e.place(i, p.s, p.rooms); });
  }

  // Runs for roughly `ms` milliseconds; returns progress (0..1 within this attempt).
  run(ms) {
    const e = this.e;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (this.phase === 'construct') {
        if (!this.queue.length || this.iter >= this.maxIter) {
          this.phase = 'optimize';
          this.cost = e.totalCost().cost;
          this.bestCost = this.cost; this.best = e.pos.slice();
          continue;
        }
        this.iter++;
        this.constructStep();
      } else if (this.phase === 'optimize') {
        for (let k = 0; k < 200; k++) { this.annealStep(); this.saIter++; }
        if (this.saIter >= this.saMax) { this.restoreBest(); this.phase = 'done'; }
      } else break;
    }
    const placed = e.pos.filter(Boolean).length;
    return {
      phase: this.phase, placed, total: e.units.length,
      progress: this.phase === 'construct' ? Math.min(0.5, placed / Math.max(1, e.units.length) * 0.5)
        : this.phase === 'optimize' ? 0.5 + 0.5 * this.saIter / this.saMax : 1,
    };
  }

  // GHC-style difficulty report: most-rejected units and share of rejections per class/teacher.
  difficulty() {
    const e = this.e;
    const total = this.rejections.reduce((a, b) => a + b, 0) || 1;
    const byT = {}, byC = {};
    e.units.forEach((u, i) => {
      const r = this.rejections[i]; if (!r) return;
      u.teachers.forEach((t) => { byT[t] = (byT[t] || 0) + r; });
      u.classes.forEach((c) => { byC[c] = (byC[c] || 0) + r; });
    });
    const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({ id, pct: Math.round(n / total * 100) }));
    const units = e.units.map((u, i) => ({ id: u.id, n: this.rejections[i] })).filter((x) => x.n).sort((a, b) => b.n - a.n).slice(0, 5);
    return { units, teachers: top(byT), classes: top(byC), total: this.rejections.reduce((a, b) => a + b, 0) };
  }
}

window.Timetable = { Engine, Solver, DEFAULT_WEIGHTS };
