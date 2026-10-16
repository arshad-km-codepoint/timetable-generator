// Timetable engine: hard-constraint bookkeeping, conflict-driven construction
// (place a unit, evict whatever clashes, re-queue it) and a simulated-annealing
// pass that improves the weighted soft criteria without breaking any hard rule.
//
// A "unit" is one session to place. Lessons that share a parallel-group tag are
// merged into one unit with several parts (e.g. a class split across two teachers
// and rooms at the same time); each part keeps its own teacher, classes and room.
// A lesson row yields one unit per entry of its `lengths` (or a distribution the engine
// chooses for a `flexible` row); rows may be tied by relations (different days, not at the
// same time, (non-)consecutive, days apart) that are hard rules like any other clash.

const DEFAULT_WEIGHTS = { classGap: 3, teacherGap: 1, sameDay: 4, late: 0.15, dispreferred: 2, teacherMin: 2, dutyUncovered: 1, ends: 0.5, roomPref: 1, roomSame: 0.5, consecutiveDays: 1, balance: 0.25 };
const RELATION_TYPES = new Set(['differentDays', 'notSameTime', 'nonConsecutive', 'consecutive', 'daysApart']);

class Engine {
  constructor(data, placements = []) {
    const D = data.settings.days.length;
    const P = data.settings.periods.length;
    this.D = D; this.P = P; this.N = D * P;
    this.W = { ...DEFAULT_WEIGHTS, ...(data.settings.weights || {}) };

    // 'd-p' keys → slot numbers; malformed or out-of-range keys are ignored.
    const slots = (keys) => new Set((keys || []).map((k) => String(k).split('-'))
      .filter((parts) => parts.length === 2 && parts.every((x) => /^\d+$/.test(x)))
      .map(([d, p]) => [Number(d), Number(p)])
      .filter(([d, p]) => d < D && p < P)
      .map(([d, p]) => d * P + p));
    // Period classes: lessons/meetings/teaching duties use teaching periods only; break
    // duties use break periods; lunch is never scheduled. The general template
    // (settings.blocked) removes slots from everything except break duties.
    this.periodTypes = data.settings.periods.map((p) => (p && (p.type === 'break' || p.type === 'lunch') ? p.type : 'teaching'));
    this.teach = new Uint8Array(this.N);
    for (let s = 0; s < this.N; s++) this.teach[s] = this.periodTypes[s % P] === 'teaching' ? 1 : 0;
    this.general = slots(data.settings.blocked);
    this.options = { countMiddayGap: false, ...(data.settings.options || {}) };
    // Gap segments per day: runs of schedulable teaching slots. Breaks and template-blocked
    // slots are skipped; lunch splits the day, or counts as a gap slot when countMiddayGap is on.
    this.segments = [];
    for (let d = 0; d < D; d++) {
      const segs = []; let cur = [];
      for (let p = 0; p < P; p++) {
        const s = d * P + p; const ty = this.periodTypes[p];
        if (ty === 'teaching') { if (!this.general.has(s)) cur.push(s); }
        else if (ty === 'lunch') { if (this.options.countMiddayGap) cur.push(s); else { if (cur.length) segs.push(cur); cur = []; } }
      }
      if (cur.length) segs.push(cur);
      this.segments.push(segs);
    }
    // Teaching order: the next teaching period on the same day with only break periods in
    // between (lunch separates). Used by the consecutive/nonConsecutive relations.
    this.nextTeach = new Int32Array(this.N).fill(-1);
    for (let d = 0; d < D; d++) {
      let last = -1;
      for (let p = 0; p < P; p++) {
        const s = d * P + p; const ty = this.periodTypes[p];
        if (ty === 'teaching') { if (last >= 0) this.nextTeach[last] = s; last = s; }
        else if (ty === 'lunch') last = -1;
      }
    }
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
    // Days a teacher could work (at least one teaching slot outside the general template and their
    // own ✕ periods): the week the balance criterion spreads their load over.
    this.balDays = {};
    for (const t of data.teachers) {
      this.balDays[t.id] = [];
      for (let d = 0; d < D; d++) {
        for (let p = 0; p < P; p++) {
          const s = d * P + p;
          if (this.teach[s] && !this.general.has(s) && !this.blocked['t' + t.id].has(s)) { this.balDays[t.id].push(d); break; }
        }
      }
    }

    this.problems = [];
    const groups = new Map();
    for (const l of data.lessons) {
      const key = l.parallel && l.parallel.trim() ? 'p:' + l.parallel.trim().toLowerCase() : 'l:' + l.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l);
    }

    this.units = [];
    this.groupUnits = {};
    this.groupLengths = {}; // gkey → lengths actually used (flexible rows: the chosen distribution)
    this.lessonGroup = {};  // lessonId → gkey, for lessons that became units
    this.rel = {};          // gkey → [{ type, other, min, max }], stored on both groups
    // Session lengths of the placements being restored, so a flexible row keeps its distribution.
    const placedLens = new Map();
    for (const pl of placements) {
      const m = /^(.*)#(\d+)$/.exec(String(pl && pl.unitId || ''));
      if (!m || !(Number(pl.len) >= 1)) continue;
      if (!placedLens.has(m[1])) placedLens.set(m[1], new Map());
      placedLens.get(m[1]).set(Number(m[2]), Number(pl.len));
    }
    const specs = []; // [gkey, lesson rows] for relations, resolved once every group exists
    for (const [key, lessons] of groups) {
      const parts = []; const rows = [];
      for (const l of lessons) {
        const classes = (l.classIds || []).filter((id) => this.classes[id]);
        const roomCands = this.roomCandidates(l.room, data.rooms, l.roomAlt);
        const flex = l.flexible && typeof l.flexible === 'object' ? { total: Number(l.flexible.total), min: Number(l.flexible.min), max: Number(l.flexible.max) } : null;
        const lengths = flex ? null : Array.isArray(l.lengths) ? l.lengths.map(Number) : Array.from({ length: Math.max(0, Number(l.sessions) || 0) }, () => Math.max(1, Math.min(P, Number(l.length) || 1)));
        const bad = !this.subjects[l.subjectId] ? 'has no subject' : !this.teachers[l.teacherId] ? 'has no teacher'
          : !classes.length ? 'has no class' : roomCands && !roomCands.length ? 'needs a room type that has no rooms'
            : lengths && lengths.some((n) => !Number.isInteger(n) || n < 1 || n > P) ? `has a session length outside 1–${P}`
              : flex && !(Number.isInteger(flex.total) && flex.total >= 1 && Number.isInteger(flex.min) && Number.isInteger(flex.max) && flex.min >= 1 && flex.min <= flex.max && flex.max <= P) ? 'has an invalid flexible distribution' : null;
        if (bad) { this.problems.push({ lessonIds: [l.id], msg: bad }); continue; }
        const prefRoom = l.room && !String(l.room).startsWith('type:') && this.rooms[l.room] ? l.room : null;
        parts.push({ kind: 'lesson', ref: l.id, lessonId: l.id, teacher: l.teacherId, classes, roomCands, prefRoom, sameRoom: !!l.sameRoom });
        rows.push({ l, lengths, flex });
      }
      if (!parts.length) continue;
      const gkey = parts.map((p) => p.lessonId).join('+');
      const tag = key.startsWith('p:') ? lessons[0].parallel.trim() : null;
      // Flexible rows: adopt the group's reference lengths (a fixed row, or the first flexible
      // row's choice) when they fit the spec, otherwise choose a distribution of their own.
      let ref = (rows.find((r) => r.lengths) || {}).lengths || null;
      for (const r of rows) {
        if (!r.flex) continue;
        r.lengths = ref && this.fitsFlex(ref, r.flex) ? ref.slice() : this.flexLengths(r.flex, placedLens.get(gkey));
        if (!r.lengths) { this.problems.push({ lessonIds: [r.l.id], msg: `has a flexible distribution that cannot be split into blocks of ${r.flex.min}–${r.flex.max} periods` }); continue; }
        if (!ref) ref = r.lengths;
      }
      if (rows.some((r) => !r.lengths)) continue;
      const sortedLens = (ls) => ls.slice().sort((a, b) => a - b).join(',');
      if (rows.some((r) => sortedLens(r.lengths) !== sortedLens(rows[0].lengths))) {
        this.problems.push({ lessonIds: parts.map((p) => p.lessonId), msg: `are in parallel group “${tag}” but have different session lengths` });
        continue;
      }
      const teachers = [...new Set(parts.map((p) => p.teacher))];
      if (teachers.length < parts.length) {
        this.problems.push({ lessonIds: parts.map((p) => p.lessonId), msg: `are in parallel group “${tag}” but share a teacher` });
        continue;
      }
      const lengths = rows[0].lengths.slice();
      // A parallel unit may straddle a break only when every lesson in it allows that.
      this.addUnits(gkey, 'lesson', parts, lengths, {
        maxOne: rows.some((r) => r.l.maxOnePerDay), allowBreak: rows.every((r) => r.l.allowBreakInside),
        ends: rows.some((r) => r.l.penalizeEnds), avoidAdj: rows.some((r) => r.l.avoidConsecutiveDays) && lengths.length >= 2 && lengths.length <= 3,
      });
      this.groupLengths[gkey] = lengths;
      for (const p of parts) this.lessonGroup[p.lessonId] = gkey;
      this.rel[gkey] = [];
      specs.push([gkey, rows.map((r) => r.l)]);
    }
    // Relations between lesson rows, kept on both groups; declared on either side, deduplicated.
    const seenRel = new Set();
    for (const [gkey, rows] of specs) {
      for (const l of rows) {
        for (const r of Array.isArray(l.relations) ? l.relations : []) {
          const other = r && this.lessonGroup[r.lessonId];
          const type = r && String(r.type);
          if (!other || other === gkey || !RELATION_TYPES.has(type)) continue;
          const min = type === 'daysApart' && Number(r.min) > 0 ? Math.floor(Number(r.min)) : 0;
          const max = type === 'daysApart' && r.max !== '' && r.max !== null && r.max !== undefined && Number.isFinite(Number(r.max)) ? Math.floor(Number(r.max)) : null;
          if (type === 'daysApart' && !min && max === null) continue;
          const sig = `${type}|${[gkey, other].sort().join('|')}|${min}|${max}`;
          if (seenRel.has(sig)) continue;
          seenRel.add(sig);
          if (type === 'consecutive' && this.groupUnits[gkey].length !== this.groupUnits[other].length) {
            this.problems.push({ lessonIds: [...gkey.split('+'), ...other.split('+')], msg: 'must run consecutively but have different numbers of sessions' });
            continue;
          }
          this.rel[gkey].push({ type, other, min, max });
          this.rel[other].push({ type, other: gkey, min, max });
        }
      }
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
      const len = Math.max(1, Math.min(P, Number(m.length) || 1));
      this.addUnits('m:' + m.id, 'meeting', parts, Array.from({ length: sessions }, () => len), { maxOne: sessions > 1, allowed: allowedSet(m.allowed) });
    }

    // On-call duties: one unit per assigned hour; capacity per period is hard, coverage is soft.
    // kind 'break' duties live on break periods; teaching duties on teaching periods outside the template.
    this.services = {};
    for (const svc of data.duties || []) {
      const kind = svc.kind === 'break' ? 'break' : 'teaching';
      const fits = (s) => (kind === 'break' ? this.periodTypes[s % P] === 'break' : this.teach[s] === 1 && !this.general.has(s));
      const allowed = new Set([...(allowedSet(svc.allowed) || Array(this.N).keys())].filter(fits));
      this.services[svc.id] = { kind, max: Math.max(1, Number(svc.maxPerSlot) || 1), allowed, occ: Array.from({ length: this.N }, () => new Set()) };
      for (const a of svc.assignments || []) {
        if (!this.teachers[a.teacherId] || !(Number(a.hours) > 0)) continue;
        const parts = [{ kind: 'duty', ref: svc.id, teacher: a.teacherId, classes: [], roomCands: null }];
        this.addUnits(`d:${svc.id}:${a.teacherId}`, 'duty', parts, Array.from({ length: Number(a.hours) }, () => 1), { allowed, service: svc.id });
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
      if (!this.cellsAt(u.i, s)) continue;
      const base = this.baseConflicts(u.i, s);
      if (base === null || base.size) continue;
      let rooms = Array.isArray(pl.rooms) && pl.rooms.length === u.parts.length ? pl.rooms : null;
      if (rooms && !this.roomsValid(u.i, s, rooms)) rooms = null;
      if (!rooms) { const pick = this.bestRooms(u.i, s, base); if (!pick || pick.conf.size) continue; rooms = pick.rooms; }
      this.place(u.i, s, rooms);
      this.locked[u.i] = !!pl.locked;
    }
  }

  // One unit per entry of `lengths` (unit k has that many periods); units of one group may differ
  // in length. Options: maxOne (one unit per day), allowed (slot set), service (duty id),
  // allowBreak, ends (penalise first/last period of a day), avoidAdj (penalise adjacent days).
  addUnits(gkey, kind, parts, lengths, { maxOne = false, allowed = null, service = null, allowBreak = false, ends = false, avoidAdj = false } = {}) {
    const teachers = [...new Set(parts.map((p) => p.teacher))];
    const classes = [...new Set(parts.flatMap((p) => p.classes))];
    // Legal starts, the teaching cells each occupies and the full span it holds (cells plus any
    // break skipped inside a straddling unit: teacher, classes and rooms stay busy during it).
    // Non-duty units need every cell to be a teaching period outside the general template;
    // duties get a pre-filtered `allowed`. Computed once per distinct length.
    const geo = new Map();
    const geometry = (len) => {
      if (geo.has(len)) return geo.get(len);
      const starts = []; const cells = new Map(); const span = new Map();
      for (let s = 0; s < this.N; s++) {
        const cs = this.spanCells(kind, len, allowBreak, s);
        if (!cs) continue;
        let ok = true;
        for (const c of cs) {
          if (allowed && !allowed.has(c)) ok = false;
          if (kind !== 'duty' && this.general.has(c)) ok = false;
          for (const t of teachers) if (this.blocked['t' + t].has(c)) ok = false;
          for (const k of classes) if (this.blocked['c' + k].has(c)) ok = false;
          if (!ok) break;
        }
        if (!ok) continue;
        starts.push(s); cells.set(s, cs);
        const last = cs[cs.length - 1];
        span.set(s, last - s + 1 === cs.length ? cs : Array.from({ length: last - s + 1 }, (_, q) => s + q));
      }
      const g = { starts, cells, span };
      geo.set(len, g);
      return g;
    };
    const idxs = [];
    lengths.forEach((len, k) => {
      idxs.push(this.units.length);
      this.units.push({ i: this.units.length, id: `${gkey}#${k}`, key: gkey, k, kind, service, len, parts, teachers, classes, maxOne, allowBreak, ends, avoidAdj, ...geometry(len) });
    });
    this.groupUnits[gkey] = idxs;
  }

  // True when `lengths` is a legal distribution for a flexible spec.
  fitsFlex(lengths, flex) {
    return lengths.length > 0 && lengths.reduce((a, b) => a + b, 0) === flex.total && lengths.every((n) => n >= flex.min && n <= flex.max);
  }

  // Lengths for a flexible row. Placed units (k → len) keep their length and index when the rest
  // of the total can still be partitioned (with enough blocks for every kept index to exist);
  // otherwise the total is partitioned from scratch. null when the total cannot be split into
  // blocks of min..max at all.
  flexLengths(flex, placed) {
    if (placed && placed.size) {
      const ks = [...placed.keys()].sort((a, b) => a - b);
      const lens = ks.map((k) => placed.get(k));
      if (lens.every((n) => Number.isInteger(n) && n >= flex.min && n <= flex.max)) {
        const rem = flex.total - lens.reduce((a, b) => a + b, 0);
        const need = ks[ks.length - 1] + 1 - lens.length;
        const rest = rem === 0 ? [] : rem > 0 ? this.partition(rem, flex.min, flex.max, need) || this.partition(rem, flex.min, flex.max) : null;
        if (rest) {
          const count = lens.length + rest.length; const out = new Array(count).fill(0); const spill = [];
          ks.forEach((k, i) => { if (k < count && !out[k]) out[k] = lens[i]; else spill.push(lens[i]); });
          const fill = [...spill, ...rest];
          for (let i = 0; i < count; i++) if (!out[i]) out[i] = fill.shift();
          return out;
        }
      }
    }
    return this.partition(flex.total, flex.min, flex.max);
  }

  // Random partition of n into at least `atLeast` blocks of min..max, or null. Fewer blocks are
  // preferred (each extra block is about a third as likely); the extra periods and the order are
  // shuffled so repeated attempts try different distributions.
  partition(n, min, max, atLeast = 1) {
    const bMin = Math.max(1, atLeast, Math.ceil(n / max)), bMax = Math.floor(n / min);
    if (!(n >= 1) || bMin > bMax) return null;
    let b = bMin;
    while (b < bMax && Math.random() < 0.35) b++;
    const out = new Array(b).fill(min);
    for (let extra = n - b * min; extra > 0; extra--) {
      const open = out.map((v, i) => (v < max ? i : -1)).filter((i) => i >= 0);
      out[open[Math.floor(Math.random() * open.length)]]++;
    }
    for (let i = b - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }

  // Slots a `len`-period unit of `kind` occupies when it starts at s, or null if it cannot start
  // there. Duties take any single slot. Other units need `len` teaching periods on one day:
  // consecutive ones, or — with allowBreak — the next teaching periods with break periods
  // skipped. Lunch is never inside a unit.
  spanCells(kind, len, allowBreak, s) {
    if (kind === 'duty') return [s];
    const { P } = this; const d = Math.floor(s / P);
    if (!this.teach[s]) return null;
    const out = [];
    for (let p = s % P; p < P && out.length < len; p++) {
      if (this.teach[d * P + p]) out.push(d * P + p);
      else if (!allowBreak || this.periodTypes[p] !== 'break') return null;
    }
    return out.length === len ? out : null;
  }

  // Teaching cells of unit ui when it starts at s; null when s is not a legal start.
  cellsAt(ui, s) { return this.units[ui].cells.get(s) || null; }
  // Every slot unit ui holds when it starts at s (cells plus breaks skipped inside it).
  spanAt(ui, s) { return this.units[ui].span.get(s) || null; }

  // null = lesson needs no room; [] = needs a room but none qualify. Ordered: the preferred
  // room (or rooms of its type) first, then the rooms of the alternative type `alt` ('type:X').
  roomCandidates(spec, rooms, alt = '') {
    if (!spec) return null;
    const ofType = (type) => rooms.filter((r) => (r.type || '') === type).map((r) => r.id);
    const out = spec.startsWith('type:') ? ofType(spec.slice(5)) : rooms.some((r) => r.id === spec) ? [spec] : [];
    if (alt && String(alt).startsWith('type:')) for (const r of ofType(String(alt).slice(5))) if (!out.includes(r)) out.push(r);
    return out;
  }

  // Room part k of another placed unit of ui's group uses (sameRoom rows must follow it), or null.
  groupRoom(ui, k) {
    for (const vi of this.groupUnits[this.units[ui].key]) {
      if (vi !== ui && this.pos[vi] && this.pos[vi].rooms[k]) return this.pos[vi].rooms[k];
    }
    return null;
  }

  // Teaching cells a and b are adjacent in teaching order on one day (breaks between them ignored).
  adjacent(a, b) {
    return this.nextTeach[a[a.length - 1]] === b[0] || this.nextTeach[b[b.length - 1]] === a[0];
  }

  dayOf(s) { return Math.floor(s / this.P); }

  // Units that must leave for unit ui to start at s (rooms aside), or null if impossible.
  baseConflicts(ui, s) {
    const u = this.units[ui];
    const span = this.spanAt(ui, s);
    if (!span) return null;
    const out = new Set();
    for (const k of span) {
      for (const t of u.teachers) { const o = this.occ['t' + t][k]; if (o >= 0 && o !== ui) out.add(o); }
      for (const c of u.classes) { const o = this.occ['c' + c][k]; if (o >= 0 && o !== ui) out.add(o); }
    }
    const d = this.dayOf(s);
    if (u.maxOne) {
      for (const vi of this.groupUnits[u.key]) if (vi !== ui && this.pos[vi] && this.dayOf(this.pos[vi].s) === d) out.add(vi);
    }
    // Relations with other rows: every placed unit of the related group that the start would
    // violate must leave; a locked one makes the start impossible.
    const cells = this.cellsAt(ui, s);
    for (const r of this.rel[u.key] || []) {
      const others = r.type === 'consecutive' ? [this.groupUnits[r.other][u.k]] : this.groupUnits[r.other];
      for (const vi of others) {
        if (vi === undefined || vi === ui || !this.pos[vi]) continue;
        const pv = this.pos[vi]; const dv = this.dayOf(pv.s); const diff = Math.abs(d - dv);
        let bad = false;
        if (r.type === 'differentDays') bad = dv === d;
        else if (r.type === 'notSameTime') bad = span[0] <= pv.span[pv.span.length - 1] && pv.span[0] <= span[span.length - 1];
        else if (r.type === 'nonConsecutive') bad = dv === d && this.adjacent(cells, pv.cells);
        else if (r.type === 'consecutive') bad = dv !== d || !this.adjacent(cells, pv.cells);
        else if (r.type === 'daysApart') bad = (r.min > 0 && diff < r.min) || (r.max !== null && diff > r.max);
        if (!bad) continue;
        if (this.locked[vi]) return null;
        out.add(vi);
      }
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
        const k = d * this.P + p;
        if (!this.teach[k]) continue; // a break held inside a straddling double is not a period
        const o = occ[k];
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
      if (part.sameRoom) { const g = this.groupRoom(ui, k); if (g && g !== r) return false; }
      used.add(r);
      for (const c of this.cellsAt(ui, s) || []) if (this.blocked['r' + r].has(c)) return false;
    }
    return true;
  }

  roomConflicts(ui, s, rooms) {
    const out = new Set();
    for (const r of rooms) if (r) for (const k of this.spanAt(ui, s) || []) { const o = this.occ['r' + r][k]; if (o >= 0 && o !== ui) out.add(o); }
    return out;
  }

  // Greedy room choice per part: distinct rooms, fewest extra evictions, then fewest
  // non-preferred cells, the preferred room over an alternative, and a room the group already
  // uses over a new one. A sameRoom part may only take the room its group already uses.
  // null if no valid rooms.
  bestRooms(ui, s, base) {
    const u = this.units[ui];
    const cells = this.cellsAt(ui, s), span = this.spanAt(ui, s);
    if (!cells) return null;
    const conf = new Set(base); const rooms = []; const used = new Set();
    for (let k = 0; k < u.parts.length; k++) {
      const part = u.parts[k];
      if (!part.roomCands) { rooms.push(null); continue; }
      let groupRooms = null; let cands = part.roomCands;
      if (u.kind === 'lesson') {
        groupRooms = new Set(this.groupUnits[u.key].filter((vi) => vi !== ui && this.pos[vi] && this.pos[vi].rooms[k]).map((vi) => this.pos[vi].rooms[k]));
        if (part.sameRoom && groupRooms.size) cands = [this.groupRoom(ui, k)];
      }
      let best = null;
      for (const r of cands) {
        if (used.has(r)) continue;
        let ok = true; const extra = new Set();
        for (const c of cells) if (this.blocked['r' + r].has(c)) { ok = false; break; }
        if (!ok) continue;
        for (const c of span) { const o = this.occ['r' + r][c]; if (o >= 0 && o !== ui && !conf.has(o)) extra.add(o); }
        let soft = 0; for (const c of cells) if (this.soft['r' + r].has(c)) soft++;
        let score = extra.size * 10 + soft;
        if (part.prefRoom && r !== part.prefRoom) score += this.W.roomPref;
        if (groupRooms && groupRooms.size && !groupRooms.has(r)) score += this.W.roomSame;
        if (!best || score < best.score) best = { r, extra, score };
        if (score === 0) break;
      }
      if (!best) return null;
      used.add(best.r); rooms.push(best.r); best.extra.forEach((o) => conf.add(o));
    }
    return { rooms, conf };
  }

  // Teacher, classes and rooms are held for the whole span (a break skipped inside a
  // straddling double included); the service rota only for the duty's own cell.
  place(ui, s, rooms) {
    const u = this.units[ui];
    const cells = this.cellsAt(ui, s), span = this.spanAt(ui, s);
    for (const k of span) {
      for (const t of u.teachers) this.occ['t' + t][k] = ui;
      for (const c of u.classes) this.occ['c' + c][k] = ui;
      for (const r of rooms) if (r) this.occ['r' + r][k] = ui;
    }
    if (u.service) for (const k of cells) this.services[u.service].occ[k].add(ui);
    this.pos[ui] = { s, rooms, cells, span };
  }

  remove(ui) {
    const u = this.units[ui]; const p = this.pos[ui];
    if (!p) return;
    for (const k of p.span) {
      for (const t of u.teachers) this.occ['t' + t][k] = -1;
      for (const c of u.classes) this.occ['c' + c][k] = -1;
      for (const r of p.rooms) if (r) this.occ['r' + r][k] = -1;
    }
    if (u.service) for (const k of p.cells) this.services[u.service].occ[k].delete(ui);
    this.pos[ui] = null;
  }

  // n = occupied teaching slots on day d (lessons, meetings and teaching duties alike — duty
  // periods count toward min/day deliberately; Task 3.4 countLoad will refine this); gaps =
  // free slots between the first and last occupied slot of each segment (breaks never count;
  // lunch only with countMiddayGap).
  dayStats(occ, d) {
    let n = 0, gaps = 0;
    for (let p = 0; p < this.P; p++) { const k = d * this.P + p; if (this.teach[k] && occ[k] >= 0) n++; }
    for (const seg of this.segments[d]) {
      let first = -1, last = -1, m = 0;
      for (let i = 0; i < seg.length; i++) if (occ[seg[i]] >= 0) { if (first < 0) first = i; last = i; m++; }
      if (first >= 0) gaps += last - first + 1 - m;
    }
    return { gaps, n };
  }

  teacherDayCost(t, d) {
    const { gaps, n } = this.dayStats(this.occ['t' + t], d);
    const min = this.tMin[t];
    return this.W.teacherGap * gaps + (min && n > 0 && n < min ? this.W.teacherMin * (min - n) : 0);
  }

  // Imbalance of a teacher's week: periods above ceil(mean) or below floor(mean) of the load
  // (lessons, meetings and duties, as for min/day) over the days they can work. 0 when the load
  // is as even as whole periods allow, so a perfect week costs nothing.
  teacherBalance(t) {
    const days = this.balDays[t];
    if (days.length < 2) return 0;
    const occ = this.occ['t' + t]; const loads = [];
    let total = 0;
    for (const d of days) {
      let n = 0;
      for (let p = 0; p < this.P; p++) { const k = d * this.P + p; if (this.teach[k] && occ[k] >= 0) n++; }
      loads.push(n); total += n;
    }
    const lo = Math.floor(total / days.length), hi = Math.ceil(total / days.length);
    let off = 0;
    for (const n of loads) off += n > hi ? n - hi : n < lo ? lo - n : 0;
    return off;
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

  // The unit's first cell opens its day or its last cell closes it (gap segments, so the general
  // template and lunch handling are respected).
  atDayEnd(cells) {
    const segs = this.segments[this.dayOf(cells[0])];
    if (!segs.length) return false;
    const last = segs[segs.length - 1];
    return cells[0] === segs[0][0] || cells[cells.length - 1] === last[last.length - 1];
  }

  // Non-preferred rooms used by a placed lesson unit (parts with a specific preferred room only).
  roomPrefCount(ui) {
    const u = this.units[ui]; const p = this.pos[ui];
    if (!p || u.kind !== 'lesson') return 0;
    return u.parts.filter((part, k) => part.prefRoom && p.rooms[k] !== part.prefRoom).length;
  }

  // Cost that depends only on where this unit sits: late periods, non-preferred cells, a
  // non-preferred room and (when the row asks for it) the first/last period of a day.
  unitCost(ui) {
    const u = this.units[ui]; const p = this.pos[ui];
    if (!p) return 0;
    let soft = 0;
    for (const k of p.cells) {
      for (const t of u.teachers) if (this.soft['t' + t].has(k)) soft++;
      for (const c of u.classes) if (this.soft['c' + c].has(k)) soft++;
      for (const r of p.rooms) if (r && this.soft['r' + r].has(k)) soft++;
    }
    return this.W.late * (p.cells[p.cells.length - 1] % this.P) + this.W.dispreferred * soft
      + this.W.roomPref * this.roomPrefCount(ui) + (u.ends && this.atDayEnd(p.cells) ? this.W.ends : 0);
  }

  // Group-level counts over the placed units of a lesson group: roomSame = extra distinct rooms
  // per part beyond one; consecutiveDays = pairs of units on adjacent days (avoidConsecutiveDays
  // rows with 2–3 units only).
  groupStats(key) {
    const uis = this.groupUnits[key]; const u = this.units[uis[0]];
    let roomSame = 0, consecutiveDays = 0;
    if (!u || u.kind !== 'lesson') return { roomSame, consecutiveDays };
    const placed = uis.filter((vi) => this.pos[vi]);
    if (placed.length < 2) return { roomSame, consecutiveDays };
    for (let k = 0; k < u.parts.length; k++) {
      if (!u.parts[k].roomCands) continue;
      const rs = new Set(); for (const vi of placed) if (this.pos[vi].rooms[k]) rs.add(this.pos[vi].rooms[k]);
      roomSame += Math.max(0, rs.size - 1);
    }
    if (u.avoidAdj) {
      const days = placed.map((vi) => this.dayOf(this.pos[vi].s));
      for (let i = 0; i < days.length; i++) for (let j = i + 1; j < days.length; j++) if (Math.abs(days[i] - days[j]) === 1) consecutiveDays++;
    }
    return { roomSame, consecutiveDays };
  }

  groupCost(key) {
    const g = this.groupStats(key);
    return this.W.roomSame * g.roomSame + this.W.consecutiveDays * g.consecutiveDays;
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
    if (this.W.balance) for (const t of u.teachers) c += this.W.balance * this.teacherBalance(t);
    return c + this.unitCost(ui) + this.groupCost(u.key);
  }

  // Soft cost of everything a set of units touches on the given days, each entity counted once.
  areaCost(uis, days) {
    const ts = new Set(), cs = new Set(), keys = new Set(), svcs = new Set();
    for (const ui of uis) { const u = this.units[ui]; u.teachers.forEach((t) => ts.add(t)); u.classes.forEach((c) => cs.add(c)); keys.add(u.key); if (u.service) svcs.add(u.service); }
    let c = 0;
    for (const d of days) {
      for (const t of ts) c += this.teacherDayCost(t, d);
      for (const k of cs) c += this.classDayCost(k, d);
      for (const key of keys) c += this.W.sameDay * Math.max(0, this.sameDayCount(key, d) - 1);
      for (const sv of svcs) c += this.W.dutyUncovered * this.uncovered(sv, d);
    }
    for (const key of keys) c += this.groupCost(key);
    if (this.W.balance) for (const t of ts) c += this.W.balance * this.teacherBalance(t);
    for (const ui of uis) c += this.unitCost(ui);
    return c;
  }

  totalCost() {
    const st = { teacherGaps: 0, classGaps: 0, sameDay: 0, dispreferred: 0, teacherMin: 0, dutyUncovered: 0, ends: 0, roomPref: 0, roomSame: 0, consecutiveDays: 0, balance: 0 };
    let c = 0;
    for (const key in this.groupUnits) {
      const g = this.groupStats(key);
      st.roomSame += g.roomSame; st.consecutiveDays += g.consecutiveDays;
      c += this.W.roomSame * g.roomSame + this.W.consecutiveDays * g.consecutiveDays;
    }
    for (const t in this.teachers) { const b = this.teacherBalance(t); st.balance += b; c += this.W.balance * b; }
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
      st.roomPref += this.roomPrefCount(i);
      if (u.ends && this.atDayEnd(p.cells)) st.ends++;
      for (const k of p.cells) {
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
    // How often a unit may still push others out. Once spent it only takes free slots, so one
    // impossible demand is reported as unplaced instead of churning the whole timetable.
    this.evictBudget = e.units.map((u) => (u.kind === 'lesson' ? 40 : 8));
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
    this.saMax = Math.min(300000, Math.max(40000, e.units.length * 600));
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
      } else if (!bestFree && this.evictBudget[ui] > 0) {
        // Meetings and duties may displace lessons, but at a higher price than the reverse.
        let score = Math.random();
        for (const o of pick.conf) score += (u.kind !== 'lesson' && e.units[o].kind === 'lesson' ? 3 : 1) * (1 + 2 * this.rejections[o]);
        if (!bestClash || score < bestClash.score) bestClash = { s, rooms: pick.rooms, conf: pick.conf, score };
      }
    }
    if (bestFree) { e.place(ui, bestFree.s, bestFree.rooms); return; }
    if (!bestClash) { this.impossible.push(ui); return; }
    this.evictBudget[ui]--;
    for (const o of bestClash.conf) { e.remove(o); this.rejections[o]++; this.queue.unshift(o); }
    e.place(ui, bestClash.s, bestClash.rooms);
  }

  // After construction: drop any leftover unit into a free slot if one has opened up.
  fillFree() {
    const e = this.e;
    for (const ui of [...this.queue, ...this.impossible]) {
      if (e.pos[ui]) continue;
      for (const s of e.units[ui].starts) {
        const base = e.baseConflicts(ui, s);
        if (!base || base.size) continue;
        const pick = e.bestRooms(ui, s, base);
        if (pick && !pick.conf.size) { e.place(ui, s, pick.rooms); break; }
      }
    }
    this.queue = [];
  }

  // Exchange two same-length lessons of one class — closes gaps that single moves cannot.
  swapStep() {
    const e = this.e;
    const ui = Math.floor(Math.random() * e.units.length);
    const u = e.units[ui]; const pu = e.pos[ui];
    if (!pu || e.locked[ui] || u.kind !== 'lesson' || !u.classes.length) return;
    const c = u.classes[Math.floor(Math.random() * u.classes.length)];
    const occ = e.occ['c' + c];
    const k = Math.floor(Math.random() * e.N);
    const vi = occ[k];
    if (vi < 0 || vi === ui || e.locked[vi]) return;
    const v = e.units[vi]; const pv = e.pos[vi];
    if (v.len !== u.len || v.kind !== 'lesson' || pv.s === pu.s) return;
    if (!u.starts.includes(pv.s) || !v.starts.includes(pu.s)) return;
    const days = [...new Set([e.dayOf(pu.s), e.dayOf(pv.s)])];
    const before = e.areaCost([ui, vi], days);
    e.remove(ui); e.remove(vi);
    const undo = () => { e.remove(ui); e.remove(vi); e.place(ui, pu.s, pu.rooms); e.place(vi, pv.s, pv.rooms); };
    const bu = e.baseConflicts(ui, pv.s);
    const ru = bu && !bu.size ? e.bestRooms(ui, pv.s, bu) : null;
    if (!ru || ru.conf.size) { undo(); return; }
    e.place(ui, pv.s, ru.rooms);
    const bv = e.baseConflicts(vi, pu.s);
    const rv = bv && !bv.size ? e.bestRooms(vi, pu.s, bv) : null;
    if (!rv || rv.conf.size) { undo(); return; }
    e.place(vi, pu.s, rv.rooms);
    const delta = e.areaCost([ui, vi], days) - before;
    const T = this.T0 * Math.pow(this.T1 / this.T0, this.saIter / this.saMax);
    if (delta <= 0 || Math.random() < Math.exp(-delta / T)) {
      this.cost += delta;
      if (this.cost < this.bestCost - 1e-9) { this.bestCost = this.cost; this.best = e.pos.slice(); }
    } else undo();
  }

  annealStep() {
    if (Math.random() < 0.4) { this.swapStep(); return; }
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
          this.fillFree();
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
