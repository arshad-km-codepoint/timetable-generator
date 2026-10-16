# TODO

Open tasks from the code review of the solver-hardening and scenario commits (`c6407a0`, `c8858d5`).

## Room-capacity validation (`app.js`, `validate()`)

- [ ] **Count only usable periods as room capacity.** Capacity is currently `days × periods − room.unavailable`, so periods in which no class can be scheduled (e.g. Saturday afternoon in scenario A) still count. With 12 classrooms scenario A computes 515/576 = 89% and the 90% warning never fires, although the real figure is 515/528 = 97%. Count a period only if at least one class is available in it.
- [ ] **Count nested room sets together.** Demand is bucketed by the exact candidate-room list, so lessons pinned to "Lab 1" and lessons asking for "Any ScienceLab" (which contains Lab 1) are checked separately and an overbooked set can pass. Count a lesson against every room set that contains its candidate rooms.
- [ ] **Only warn when several classes compete for the set.** A dedicated homeroom used 33/35 periods by one class triggers "expect free periods … add rooms" although nothing else competes for it.
- [ ] **Name the room type in the message.** "Rooms Room 101, Room 102, Room 103 … (20 rooms)" drops the one fact needed to act; say "all 20 Classroom rooms".
- [ ] **Move the room-demand maths into the engine** (e.g. `Engine.roomDemand()`) so `tests/scenarios.js`, which loads only `solver.js`, can assert the warning. The 89%-vs-97% bug above went unnoticed because the check has no automated test.
- [ ] Look up each room once in that loop instead of twice (minor).

## Tests (`tests/scenarios.js`)

- [ ] **Reset the id counter per scenario.** One global `seq` is shared by all builders, so adding rooms to scenario A renumbered every id in B, C and D and rewrote ~14,000 fixture lines with no real change. Reset `seq` in `school()` or prefix ids per scenario.

## Known limitations (not bugs)

- Scenario B keeps 2–5 free periods inside class days: its option blocks need four teachers free at once and three of them teach in both grades' blocks. Needs different teachers per grade or allowing a block twice on some days.
- Duties use teaching periods only; break-time supervision between periods needs the breaks added as periods.
