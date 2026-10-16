# School Timetable Generator (web)

A browser-based school timetabling tool modelled on the workflow of Peñalara GHC (planner → engine → editor): enter your school's data, generate an optimised clash-free timetable, then fine-tune it by hand. Original code; features were matched against GHC's public user's guide.

No build step, no server, no dependencies — open `index.html` in a browser.

## Workflow

1. **Week** – days and periods (with times).
2. **Teachers / Classes / Rooms** – availability template per element with three states: available, **~ non-preferred** (soft, weighted) and **✕ prohibited** (hard). Teachers also get **max periods/day** (hard) and **min periods/day** (soft). Rooms have a type; rooms of one type form a set of alternatives.
3. **Subjects** – name, short code, colour.
4. **Lessons** – subject × teacher × class(es), sessions per week, single/double/triple, room (specific / any of a type / none), "max one per day", and **parallel group**: rows with the same group name run simultaneously (split classes, electives, setted groups), each with its own teacher and room.
5. **Meetings & duties** – **teacher meetings** (members, sessions/week, single/double, optional room, allowed periods) and **on-call duties** (service such as library supervision, duty periods, max teachers per period, weekly hours per teacher).
6. **Generate** – data validation (errors/warnings), editable **weighted criteria**, several **attempts** with the best result kept, stop-any-time, statistics, a **not-placed list** and a **difficulty report** (most-rejected lessons and % of rejections per class/teacher, as in GHC).
7. **Timetables** – by class, teacher (including meetings and duties), room, **duty rota** (who is on call each period, uncovered periods flagged), or whole-school overview (classes or teachers). Drag to move (every hard rule is checked, with the reason shown when refused), drag from the **not-placed tray** to add lessons back, click to lock/unlock, **change room** or unschedule. Export CSV / standalone HTML, print one or all.

Data autosaves in the browser; **Save file / Open…** keep JSON backups. Files from v1 are migrated automatically.

## Engine (`solver.js`)

**Hard:** no teacher/class/room double-booking; ✕ periods; teacher max/day; contiguous multi-period lessons; "1/day"; parallel-group lessons share a slot with distinct rooms; meetings only in allowed periods with all members free; duty capacity per period; locked items stay.

**Soft (weights editable in the UI):** class gaps, teacher gaps, same lesson twice a day, non-preferred periods, teacher below min/day, late periods, uncovered duty periods.

Meetings and duties are placed by the same engine (most-constrained first); they may displace a lesson, which is then re-placed elsewhere, but at three times the price of the reverse, so lessons keep priority when something has to give.

1. **Construction** – most-constrained first; when no free slot exists, take the least-contested one and evict the clashing lessons back into the queue (often-evicted lessons get expensive to evict).
2. **Optimisation** – simulated annealing over clash-free moves, keeping the best timetable seen.
3. **Attempts** – repeated N times; the result with the most lessons placed, then lowest weighted score, wins.

The sample school (6 classes, 12 teachers, 12 rooms, 140 lesson sessions including a parallel language elective, a whole-staff meeting, a department meeting and a 10-hour library duty rota) solves fully — every duty period covered — in about 2 s per attempt.

## Not implemented (GHC has these)

Break-time supervision between periods (duties use teaching periods), complementary activities, multi-week and overlapping time frames, fractional periods, flexible weekly distributions (e.g. 4 = 2-2 or 3-1), group-assignment assistant, import from school-management systems / XML-GHC exchange.
