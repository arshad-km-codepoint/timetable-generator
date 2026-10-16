# GHC Feature Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the GHC feature gaps listed in `TODO.md` that fit a local, dependency-free web app: period types (breaks/lunch), general template, grades/departments, class and room attributes, mixed/flexible lesson distributions, lesson relations, preferred rooms, complementary activities, teacher presence/consecutive/free-day constraints, extra weighted criteria, engine controls (partial run, relaxed run, parallel attempts), editor views (free teachers/rooms, undo/redo, reports), CSV list import.

**Architecture:** Keep the three-layer shape: `solver.js` (pure engine, no DOM; loaded in the browser, in a Web Worker and in node tests), `app.js` (UI + state + migration), `tests/` (node, independent auditor). Every new hard rule is enforced in `Engine.baseConflicts`/`Engine.addUnits` and verified by the auditor; every new soft rule is a weight in `DEFAULT_WEIGHTS` and a term in `localCost`/`areaCost`/`totalCost`. Data model additions are backwards compatible through `migrate()`.

**Tech Stack:** Vanilla JS (ES2020), no build, node 24 for tests.

**Out of scope (documented in TODO):** overlapping/multiple time frames, fractional periods, multi-week, individual-student profile, group assistant, XML-GHC / management-system exchange, cloud file platform, absences manager, assessment-board planner, recombination wizard, Excel/PDF (CSV + print cover it).

---

## Data model (final shape)

```js
settings: {
  name, days: [..], periods: [{ label, start, end, type: 'teaching'|'break'|'lunch' }],
  blocked: ['d-p', ...],            // general template: nobody can be scheduled here
  weights: {...}, attempts, parallel: true,
  options: { countMiddayGap: false, discardUnplacedDuties: false, relaxHard: false, onlyClasses: [] },
}
grades: [{ id, name, curriculum: [{ subjectId, periods }] }]
departments: [{ id, name }]
teachers: [{ id, name, code, departmentId, unavailable, dispreferred,
  maxPerDay, minPerDay, countLoad: 'lessons'|'all', maxConsecutive, maxPresenceDay, maxPresenceWeek, presenceStrict,
  freeDays, noLastFirst }]
classes: [{ id, name, code, gradeId, homeroom, tutorId, size, maxPerDay, noGaps, unavailable, dispreferred }]
rooms: [{ id, name, code, type, capacity, unavailable, dispreferred }]
subjects: [{ id, name, code, color, departmentId, unavailable, dispreferred }]
lessons: [{ id, subjectId, teacherId, classIds, room, roomAlt, sameRoom, lengths: [2,2,1], flexible: { total, min, max } | null,
  maxOnePerDay, parallel, penalizeEnds, allowBreakInside, avoidConsecutiveDays,
  relations: [{ type: 'differentDays'|'notSameTime'|'nonConsecutive'|'consecutive'|'daysApart', lessonId, min, max }] }]
activities: [{ id, name, teacherId, periods, maxPerDay, split, allowed: [] }]
meetings: unchanged
duties: [{ id, name, kind: 'teaching'|'break', maxPerSlot, allowed, assignments, countLoad }]
timetable: { placements, undo: [], redo: [] }
```

---

## Phase 1 — Time frame: period types, general template, break duties

### Task 1.1: Engine slot classes
**Files:** Modify `solver.js` constructor; Test `tests/engine.js` (new)

- [ ] Add `tests/engine.js`: loads solver via vm, exports `mk()` helper building a tiny school, and `check(name, fn)` with `assert`.
- [ ] Test: a lesson is never placed on a period of type `break`/`lunch` nor on a `settings.blocked` key; a double never spans a break unless `allowBreakInside`.
- [ ] Engine: `this.teach = Uint8Array(N)` (1 = teaching); `this.general = slots(settings.blocked)`; `addUnits` skips starts touching a non-teaching or general-blocked slot for lesson/meeting/activity; for duties `kind==='break'` the allowed set is intersected with break slots, else with teaching slots.
- [ ] Engine: `segments[d]` = arrays of consecutive teaching slot indices, split at lunch when `!options.countMiddayGap`; `dayStats` counts gaps inside segments only.
- [ ] Run `node tests/engine.js` → PASS; `node tests/scenarios.js .` → still clean.

### Task 1.2: UI for period types and general template
**Files:** Modify `app.js` `renderSetup`, `emptyState`, `migrate`, `editAvailability`, timetable grid, `resetTimetable`.
- [ ] Period row gets a `type` select (Teaching/Break/Lunch). Break rows render as shaded, non-droppable rows in grids.
- [ ] "General template" button opens the ✕-only picker stored in `settings.blocked`; templates show general ✕ as disabled cells.
- [ ] Duties get a `kind` select (Teaching periods / Break supervision); "When" picker for break duties lists only break periods.
- [ ] Commit: `feat: period types, general template, break supervision duties`.

## Phase 2 — Lessons: mixed lengths, flexible distribution, preferred room, relations, options

### Task 2.1: `lengths` replaces `sessions × length`
- [ ] `migrate`: `l.lengths ??= Array(sessions).fill(length)`; keep `sessions`/`length` derived for display.
- [ ] Engine: one unit per entry of `lengths`; parallel rows must have identical sorted lengths.
- [ ] UI: "Distribution" text input accepting `221`, `2,2,1`, `2 2 1`; validation message for bad input.
- [ ] Auditor: `pl.len` must be one of the row's lengths and counts per length must not exceed.

### Task 2.2: Flexible distribution
- [ ] `flexible: { total, min, max }` → Engine builds a random valid partition per construction (seeded per attempt): greedy from max down to min summing to total. Store chosen lengths on the units; placements carry `len` so re-load works.
- [ ] Validation: total must be reachable with min..max blocks.

### Task 2.3: Preferred room with alternative set, same room
- [ ] `roomAlt` (type) + `room` (specific) → `roomCands = [room, ...type rooms]` (ordered); `bestRooms` adds `W.roomPref` when choosing a non-first candidate; `sameRoom` restricts candidates to the room already used by a placed unit of the same group (hard).

### Task 2.4: Relations between rows (hard)
- [ ] `relations` symmetric by construction in UI; engine `relHard[ui] = [{type, units:[...], min, max}]`; `baseConflicts` evicts/rejects: differentDays, notSameTime, nonConsecutive, consecutive (adjacent same day, pairwise by session index), daysApart (min/max day distance).
- [ ] Auditor checks each relation on the final placements.

### Task 2.5: Row options
- [ ] `penalizeEnds` (soft, `W.ends`), `allowBreakInside` (Task 1.1), `avoidConsecutiveDays` (soft, `W.consecutiveDays`, only rows with 2–3 units).
- [ ] Commit: `feat: lesson distributions, preferred rooms, relations and options`.

## Phase 3 — Lists and attributes

### Task 3.1: Grades, departments, subject templates, codes
- [ ] `grades` with curriculum; class `gradeId`; "Apply curriculum" creates missing lesson rows for a class; validation warns on mismatch; lesson filter by grade.
- [ ] `departments`; teacher/subject `departmentId`; teacher dropdown in lessons filtered by the subject's department when set.
- [ ] Subjects get availability templates (engine: blocked/soft per subject applied to its lessons).
- [ ] `code` on classes and rooms.

### Task 3.2: Classes and rooms
- [ ] Class: `homeroom` (default room for new lesson rows + "apply to all rows"), `tutorId` (soft: tutor teaches the class every day → `W.tutorDaily`), `size`, `maxPerDay` (hard, like teachers), `noGaps` (class gap weight ×10).
- [ ] Room: `capacity` → validation warning when a fixed room is smaller than the class total; `bestRooms` skips too-small rooms when an alternative fits.

### Task 3.3: Complementary activities
- [ ] New list `activities`; engine units kind `activity`, len 1, `maxPerDay` hard, contiguity hard when `!split`; counts toward teacher load when `countLoad==='all'`.
- [ ] UI panel under Meetings & duties; timetable shows them (teacher view) with their own colour; auditor checks maxPerDay and contiguity.

### Task 3.4: Teacher constraints
- [ ] `countLoad` ('lessons' | 'all') for max/day and min/day; `maxConsecutive` (soft `W.consecutive`); `maxPresenceDay`/`maxPresenceWeek` with `presenceStrict` (hard reject) else soft `W.presence`; `freeDays` (hard: at least n days with nothing); `noLastFirst` (soft `W.exclusive`: last period one day then first period next day); `W.balance` (soft: spread of teaching periods across days).
- [ ] "Auto min/max" button: GHC formula max = floor((weekly-1)/days)+2, min = floor((weekly-1)/days)-1.
- [ ] Commit: `feat: grades, departments, class/room attributes, activities, teacher constraints`.

## Phase 4 — Criteria and engine controls

### Task 4.1: Weights
- [ ] `DEFAULT_WEIGHTS` += `ends, roomPref, roomSame, consecutiveDays, consecutive, presence, exclusive, balance, breakDuty, tutorDaily, subjectPref`; labels in UI; stats show counts.

### Task 4.2: Controls
- [ ] Partial run: `options.onlyClasses` → Solver excludes lesson units not touching those classes (others kept as locked if placed).
- [ ] Relaxed run: `options.relaxHard` → teacher/class ✕ treated as ~ (engine builds `blocked` from general template only) so the not-placed list shows what truly blocks.
- [ ] `discardUnplacedDuties`: unplaced duty units are not counted in "sessions placed" and are not listed as failures.
- [ ] Parallel attempts: `worker.js` imports `solver.js`, runs one attempt and posts result; `startGenerate` spawns `min(attempts, navigator.hardwareConcurrency||2)` workers when `settings.parallel`; falls back to the inline loop (file:// may block workers).
- [ ] Commit: `feat: new criteria, partial and relaxed runs, parallel attempts`.

## Phase 5 — Editor

- [ ] Views: "Free teachers" and "Free rooms" grids (names per period); "Activities" in teacher view.
- [ ] Undo/redo of editor changes (Ctrl+Z / Ctrl+Y and buttons): snapshot `timetable.placements` before each mutation.
- [ ] Lesson menu: "Change teacher for all sessions of this lesson" (edits the row, re-validates placements, drops clashing ones with a toast).
- [ ] Reports panel in Generate: teaching assignments per teacher (periods by subject/class), staff per class, tutors.
- [ ] CSV list import (paste or file) for teachers, classes, rooms, subjects.
- [ ] Commit: `feat: editor views, undo/redo, reports, CSV list import`.

## Phase 6 — Docs
- [ ] README: document new features and the remaining out-of-scope list; TODO: tick done items.
- [ ] Commit and push.
