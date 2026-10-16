# TODO

Open tasks from the code review of the solver-hardening and scenario commits (`c6407a0`, `c8858d5`).

## Room-capacity validation (`app.js`, `validate()`)

- [x] **Count only usable periods as room capacity.** Capacity is currently `days × periods − room.unavailable`, so periods in which no class can be scheduled (e.g. Saturday afternoon in scenario A) still count. With 12 classrooms scenario A computes 515/576 = 89% and the 90% warning never fires, although the real figure is 515/528 = 97%. Count a period only if at least one class is available in it. (Done: a period counts when a class that uses the set is available, or a meeting uses it.)
- [x] **Count nested room sets together.** Demand is bucketed by the exact candidate-room list, so lessons pinned to "Lab 1" and lessons asking for "Any ScienceLab" (which contains Lab 1) are checked separately and an overbooked set can pass. Count a lesson against every room set that contains its candidate rooms.
- [x] **Only warn when several classes compete for the set.** A dedicated homeroom used 33/35 periods by one class triggers "expect free periods … add rooms" although nothing else competes for it.
- [x] **Name the room type in the message.** "Rooms Room 101, Room 102, Room 103 … (20 rooms)" drops the one fact needed to act; say "all 20 Classroom rooms".
- [x] **Move the room-demand maths into the engine** (e.g. `Engine.roomDemand()`) so `tests/scenarios.js`, which loads only `solver.js`, can assert the warning. The 89%-vs-97% bug above went unnoticed because the check has no automated test.
- [x] Look up each room once in that loop instead of twice (minor).

## Tests (`tests/scenarios.js`)

- [x] **Reset the id counter per scenario.** One global `seq` is shared by all builders, so adding rooms to scenario A renumbered every id in B, C and D and rewrote ~14,000 fixture lines with no real change. Reset `seq` in `school()` or prefix ids per scenario.

## Known limitations (not bugs)

- Scenario B keeps 2–5 free periods inside class days: its option blocks need four teachers free at once and three of them teach in both grades' blocks. Needs different teachers per grade or allowing a block twice on some days.

## GHC feature gaps (compared against GHC 20.8.71.0, 2026-10-16)

Source: GHC's shipped help files (planner, editor, engine, file platform), the user's guide PDF and the `.xghc` data model. The installed edition is GHC Lite, which does not optimise; the app's annealing optimiser already goes beyond it. Items marked **(core)** change what timetables can be expressed and should come first; the rest are tooling.

### Time frame

- [x] **(core) Breaks and lunch break as frame elements.** Periods have a type (teaching / break / lunch) plus a general template; breaks hold break-time supervision, lunch splits the day and optionally counts as a gap (`countMiddayGap`). Not built: the after-break and afternoon criteria.
- [ ] **(core) Different schedule per weekday** (e.g. Saturday half day expressed in the frame rather than by prohibiting periods).
- [ ] Overlapping time frames (up to 4), each class assigned to one frame.
- [ ] Fractional periods (½, ¾) and class units with fractional duration.
- [ ] Multiple weeks (up to 6) sharing one frame, each element placed in one or several weeks, optionally at the same position.
- [x] External keys on days and periods (needed for export). Each day and period has a Key field on the Week tab (`settings.dayKeys`, `periods[].extKey`); duplicates are flagged in the data validation.

### Data lists

- [x] **(core) Grades/courses** with a curriculum (subject × weekly sessions) used to filter subject and class drop-downs and to warn when a class lacks a curriculum subject. Curriculum is subject × weekly *periods*; the Lessons subject drop-down lists the grade's subjects first (others stay selectable), Lessons can be filtered by grade, and the class picker groups classes by grade.
- [x] Departments (teacher and subject membership; filters in the lesson editor). Departments are managed on the Subjects tab; teachers and subjects have a Department column; in Lessons the teacher list starts with the subject's department and rows can be filtered by department.
- [ ] Tasks / activity types (teaching, on-call, meeting, management) assignable to lessons, meetings, duties and activities, with their own availability template.
- [x] **(core) Complementary activities:** teacher-only load with weekly periods, daily min/max and optional non-consecutive daily periods. Max/day and non-consecutive are hard, min/day is a weighted preference (`activityMin`); an activity may also count toward its teacher's max periods/day; allowed periods can be restricted.
- [ ] Elective subject sets (subjects of one class allowed to overlap, with a max-overlap limit and incompatible pairs).
- [ ] Group assistant (4-step wizard: electives per grade → enrolment per combination → groups → shared rooms).
- [ ] Individual students and subgroups profile (music schools, universities).
- [x] Abbreviation, full name and external key on every element. Teachers, classes, rooms and subjects have a code (the name is the full name) and an external key; grades and departments have a key; classes' codes show in the timetable blocks; duplicate codes or keys are warned about.
- [x] Per-subject availability template (e.g. PE never in period 1). Subjects have ✕ / ~ templates like teachers, classes and rooms; they apply to every lesson of the subject (engine start filter and non-preferred cost).

### Classes and rooms

- [x] **(core) Class homeroom** assigned once and applied to all its lessons. A class has a `homeroom`; a lesson row whose room is “Class homeroom” follows it (with an optional “Any <type>” fallback). “Use in lessons” on the class converts its own rows with no room, or with “Any <type>” of the homeroom's type; new rows for a class start in its homeroom.
- [x] Tutor/advisory teacher per class, "add class units with tutor" (primary), and tutor-every-day / early / late preferences. A class has a tutor; new rows (and curriculum rows) start with the tutor as teacher, “Tutor lessons” fills rows with no teacher, and three soft wishes (every day, first lesson, last lesson) weigh `tutorDaily` / `tutorEnds`.
- [x] Class size and room capacity, with a validation warning when the assigned room is too small. Classes have a size and rooms a capacity (0 = unknown); a lesson avoids rooms that seat fewer than its classes (soft `roomSize`, default 3) and validation warns when no room it can use is big enough. Rows of a parallel group share the size of a class they split.
- [x] Max daily occupancy per class; strict "no gaps" per class; force free periods into non-preferred slots. Per class: `Max/day` (hard, evicts to make room), `No gaps` (gaps weigh `classGapStrict`, default 30, instead of 3) and `Free in ~` (lessons in the class's ~ / ~~ slots cost four times as much). The no-gaps rule is a very heavy preference, not an absolute guarantee.
- [x] Dedicated-room flag and anonymous (unnamed) general-purpose rooms counted by number only. A room record has a `Count` (N identical unnamed rooms, expanded into instances `R 1…N` by the engine, timetables and validation) and a `Dedicated` flag (left out of “Any <type>” sets, still usable by name or as a homeroom).
- [x] **(core) Preferred room with an alternative set as fallback** (today: a specific room or any of a type, never both).
- [x] "All units of this subject in the same room" as a hard rule, with a soft "room changes" criterion. (Per lesson row: `sameRoom` and the `roomSame` weight.)

### Lessons (class units)

- [x] **(core) Mixed lengths in one row** (GHC "221" = one single and two doubles) instead of one row per length.
- [x] **(core) Flexible weekly distributions:** 4 periods as 2-2 or 3-1, daily min/max block length with optional penalties, discontinuous daily blocks, up to 4 explicit alternative distributions, blocks up to 7 periods. A row can be fixed, split by the engine (total, min and max block), or one of up to four alternative distributions picked per attempt; Options adds max periods of the row per day (hard), min periods on days it is used (weighted `activityMin`) and “several sessions on one day: next to each other (at most two) / never next to each other”. Blocks may be as long as the day has teaching periods. Rows whose distribution the engine chooses cannot be pinned.
- [x] Relations between lesson rows: must be on different days, consecutive (with order and "breaks divide consecutive"), non-consecutive, non-overlapping, min/max days apart, before/after. Consecutive can fix which row comes first and, with non-consecutive, say that a break between two sessions divides them; before/after compare matching sessions (session k of one row against session k of the other) across the week. Relations stay symmetric (before ↔ after, order flips).
- [ ] Interchangeable teachers (teachers P and Q may swap between rows A and B).
- [x] Per-row soft options: penalise concentration in first/last periods, after the break, in the afternoon; avoid or promote same-hour coincidence; no break inside a double; penalise consecutive days for 2–3 session subjects. Options now also has “avoid the first period after a break” (`afterBreak`), “avoid the afternoon” (`afternoon`, after the lunch period, else the second half of the day) and “same hour on different days: avoid / promote” (`sameHour`).
- [x] Preset positions before generation (pin a session to a slot in the planner, shown with a thumbtack); today locking only exists on an already generated timetable. Lesson rows, meetings and activities (per session) can be pinned from a Pins button; pinned sessions are placed first, shown with 📌 in the timetables, and a pin that cannot be honoured is listed in the data validation with the reason. Not built: pinning duty hours, pinning flexible rows (they have no fixed sessions).
- [x] Two non-preferred levels (lower and higher weight) in all templates. Templates cycle available → ~ → ~~ → ✕; `~~` is weighted by `dispreferred2` (default 6, against 2 for `~`). Applies to teachers, classes, rooms and subjects.
- [x] Copy all lessons from one class to another. “Copy lessons from…” on the Classes tab copies every row only that class attends (teacher, room spec, distribution, options, relations among the copies); a “Class homeroom” row follows the new class.

### Teachers

- [x] Max consecutive teaching periods (rest period required). Soft: periods over the limit are weighted (`consecutive`); a break or lunch ends a run unless a lesson straddles it.
- [x] Daily and weekly presence (first to last period, including gaps) limits, hard (`Strict`, for lessons, meetings and teaching duties) or soft (`presence` weight); lunch counts only with the existing `countMiddayGap` option.
- [x] Minimum free days, or free mornings/afternoons, in non-preset positions. Free days are hard (days without lessons; meetings and duties may still use them; opening an extra day evicts the teacher's lightest day). Free mornings/afternoons (`Free halves`) are a weighted wish (`freeHalves`, default 4 per missing half-day); a half-day is a morning (before the lunch period) or an afternoon and only counts where the teacher can teach at all.
- [ ] Mutually exclusive periods: last period then first next day (n periods apart), first and last on the same day, morning/afternoon combinations, Friday→Monday option. *Done:* last period then first period of the next day (soft, `noLastFirst`). *Open:* the rest.
- [ ] Concentrate load in the fewest days.
- [ ] Associated timetables (a named set of teachers who should start and finish together).
- [ ] Count meetings, duties and activities toward daily min/max load (per item). *Done:* activities can opt in to the teacher's max periods/day (`Counts`). *Open:* meetings and duties, and the min/day side.
- [ ] Auto-calculated daily min/max from weekly load and available days, with per-teacher override.
- [ ] Teacher priority for timetable choice (university profile).

### Meetings and duties

- [x] **(core) Break-time supervision duties** on break periods with their own template.
- [ ] Per-period teacher count for a duty (detail per hour instead of one number).
- [ ] "No teaching on both sides of a break duty" criterion.
- [ ] Option to discard unplaceable duty hours instead of failing.
- [ ] Meetings 1–5 times per week placed on distinct days; task type per meeting.
- [ ] Teacher-by-duty-position detail view.

### Weighted criteria (GHC has ~20, app has 12)

- [ ] Non-preferred positions in subject/task templates and in lesson templates (separate weights).
- [ ] Consecutive days; non-preferred room; same room; first/last-period concentration; afternoon coincidence; same-hour coincidence; elective overlap. *Done:* all but elective overlap (`consecutiveDays`, `roomPref`, `roomSame`, `ends`, `afternoon`, `sameHour`, `afterBreak`). *Open:* elective overlap (needs elective subject sets).
- [x] Teacher balanced week (engine `W.balance`: periods above/below an even spread over the days the teacher can work; counts lessons, meetings and duties like min/day).
- [ ] Teacher: exclusive periods, continuous hours, presence, followed by the same group, duties at the ends of the day, priority order. *Done:* exclusive periods (last→first), continuous hours (`consecutive`), presence. *Open:* followed by the same group, duties at the ends of the day, priority order.
- [ ] Priority warnings (e.g. class gaps) minimised before the global weight.

### Engine controls

- [ ] Partial outcome: run with a subset of elements (e.g. only one grade).
- [ ] Debugging run that drops hard constraints to find what blocks a result.
- [ ] Conflict analyser and "update conditions between days" maintenance command.
- [ ] Project a result back onto the planner as preset positions (today: lock + regenerate on the timetable tab only). *Done:* one session at a time (“Pin here” in the block menu). *Open:* project a whole timetable or a selection at once.
- [ ] Several attempts in parallel (Web Workers) instead of sequential.
- [ ] Engine caution messages on the best result (non-optimal warnings).

### Editor views and editing

- [ ] Free teachers per period and free rooms per period views.
- [ ] Teacher × class junction view; general view in rows and in columns; table with member list; break-supervisors view.
- [ ] Undo/redo; cut/copy/paste; search/replace in tables.
- [ ] Change the teacher (or other assignment) across all units of a subject; create new lessons, activities, meetings and duties inside the editor; rename and add elements.
- [ ] Edit header signs and labels; add a new weekly timetable by copying another.
- [ ] Insert break supervision directly on the timetable.
- [ ] Recombination wizard (automatic search for a chain of moves to free a slot).

### Output, import and files

- [ ] Excel and PDF export (PDF with proportional period heights); print a chosen list of tables; headers/footers and page setup; cell styling and colour palette.
- [ ] Independent table documents (GHC `.gri`) that can be edited freely.
- [ ] Reports: teaching assignments per teacher, staff per class, tutors, preferences, engine messages, outcome weight breakdown.
- [ ] Import lists from CSV / clipboard and from school-management systems; XML-GHC exchange format in and out.
- [ ] Merge two configuration files; backup recovery; notes attached to a file.
- [ ] Preference capture per department (teachers submit subject and slot preferences).
- [ ] Absences and substitutions manager; assessment-board meeting planning.
- [ ] File platform / cloud publishing (out of scope for a local web app; listed for completeness).
