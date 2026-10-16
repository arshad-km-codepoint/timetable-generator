# School Timetable Generator (web)

A browser-based school timetabling tool modelled on the workflow of Peñalara GHC (planner → engine → editor): enter your school's data, generate an optimised clash-free timetable, then fine-tune it by hand. Original code; features were matched against GHC's public user's guide.

No build step, no server, no dependencies — open `index.html` in a browser.

## Workflow

1. **Week** – days and periods (with times).
2. **Teachers / Classes / Rooms** – availability template per element with three states: available, **~ non-preferred** (soft, weighted) and **✕ prohibited** (hard). Teachers also get **max periods/day** (hard), **min periods/day** (soft), **max periods in a row**, **free days**, **presence/day and /week** (soft, or hard with *Strict*) and a **no last→first period** rule. Rooms have a type; rooms of one type form a set of alternatives. Classes can have a **homeroom**, assigned once: lessons set to “Class homeroom” use it and follow it when it changes.
3. **Subjects** – name, short code, colour.
4. **Lessons** – subject × teacher × class(es), sessions per week, single/double/triple, room (specific / any of a type / none), "max one per day", and **parallel group**: rows with the same group name run simultaneously (split classes, electives, setted groups), each with its own teacher and room.
5. **Meetings & duties** – **teacher meetings** (members, sessions/week, single/double, optional room, allowed periods) and **on-call duties** (service such as library supervision, duty periods, max teachers per period, weekly hours per teacher).
6. **Generate** – data validation (errors/warnings), editable **weighted criteria**, several **attempts** with the best result kept, stop-any-time, statistics, a **not-placed list** and a **difficulty report** (most-rejected lessons and % of rejections per class/teacher, as in GHC).
7. **Timetables** – by class, teacher (including meetings and duties), room, **duty rota** (who is on call each period, uncovered periods flagged), or whole-school overview (classes or teachers). Drag to move (every hard rule is checked, with the reason shown when refused), drag from the **not-placed tray** to add lessons back, click to lock/unlock, **change room** or unschedule. Export CSV / standalone HTML, print one or all.

Data autosaves in the browser; **Save file / Open…** keep JSON backups. Files from v1 are migrated automatically.

## Engine (`solver.js`)

**Hard:** no teacher/class/room double-booking; ✕ periods; teacher max/day; teacher free days (no lessons on them) and strict presence limits; contiguous multi-period lessons; "1/day"; parallel-group lessons share a slot with distinct rooms; meetings only in allowed periods with all members free; duty capacity per period; locked items stay.

**Soft (weights editable in the UI):** class gaps, teacher gaps, same lesson twice a day, non-preferred periods, teacher below min/day, late periods, uncovered duty periods, uneven teacher week (periods above/below an even spread over the days the teacher can work), too many periods in a row, presence over its limit, last period followed by the first of the next day.

Meetings and duties are placed by the same engine (most-constrained first); they may displace a lesson, which is then re-placed elsewhere, but at three times the price of the reverse, so lessons keep priority when something has to give.

1. **Construction** – most-constrained first; when no free slot exists, take the least-contested one and evict the clashing lessons back into the queue (often-evicted lessons get expensive to evict).
2. **Optimisation** – simulated annealing over clash-free moves, keeping the best timetable seen.
3. **Attempts** – repeated N times; the result with the most lessons placed, then lowest weighted score, wins.

The sample school (6 classes, 12 teachers, 12 rooms, 140 lesson sessions including a parallel language elective, a whole-staff meeting, a department meeting and a 10-hour library duty rota) solves fully — every duty period covered — in about 2 s per attempt.

## Real-world test scenarios

`scenarios/` holds four schools you can load with **Open…**, each already generated:

| File | School | Size | Result |
|---|---|---|---|
| `scenario-A.json` | Secondary 6–10 × divisions A–D, 6-day week (Saturday half day), 2nd-language regrouping per grade (Hindi ∥ French ∥ Sanskrit), lab doubles, staff + department meetings, substitution on-call (2 per period) | 20 classes, 32 teachers, 666 units | all placed |
| `scenario-B.json` | Grades 11–12 Science/Commerce/Humanities with option blocks (parallel subjects, split Humanities class), practicals in specialist labs, teachers shared across both grades | 8 classes, 18 teachers, 127 units | all lessons placed |
| `scenario-C.json` | Primary 1–5 × 3 divisions, class teachers in their own homeroom + specialists, Monday assembly, grade-level planning meetings, sick-bay cover; classes 33/34 periods full | 15 classes, 24 teachers, 521 units | all lessons placed |
| `scenario-D.json` | C plus impossible demands (music teacher on 3 days for 30 periods, over-assigned duty, a meeting only at assembly time) | 542 units | validation flags each problem; only the impossible items stay unplaced |

`node tests/scenarios.js .` regenerates all four and runs an **independent auditor** (it does not reuse engine code) that checks every teacher, class, room and duty period for double-booking, prohibited periods, room types, parallel groups sharing one slot, 1/day, max/day, meeting members and duty capacity. It also re-generates with locked lessons and fires 400 random editor moves per school. Current result: **0 overlaps and 0 rule violations** in all scenarios.

## Not implemented (GHC has these)

Complementary activities, multi-week and overlapping time frames, fractional periods, explicit alternative weekly distributions and daily block limits, group-assignment assistant, import from school-management systems / XML-GHC exchange.
