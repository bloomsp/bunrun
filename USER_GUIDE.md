# Bunrun User Guide

This guide explains how to use Bunrun as an administrator or read-only viewer. It is written for everyday operational use rather than technical setup.

## What Bunrun Does

Bunrun is used to:

- build daily and weekly staffing rosters
- assign people to areas and time slots
- plan break times
- assign break coverage
- show the runsheet and supporting reports
- provide a print/PDF version for operational use on the day

The system is designed around the idea that a person may move between areas during the day, but their break entitlement should still be based on their full continuous working time.

## Roles

### View

Read-only access for:

- viewing the runsheet
- viewing shift reports
- viewing break reports
- printing or saving PDF reports

### Admin

Full access for:

- editing schedules
- adding and modifying members
- managing areas
- generating and assigning breaks
- copying days and weeks

## Main Admin Areas

### Schedule

Use the Schedule section to:

- open a specific day
- move between days in a week
- move to the previous or next week
- add people to shifts
- modify or delete shifts
- mark roles such as `Floater`
- copy a day or a full week
- open break planning
- view the runsheet and break timeline

### Members

Use the Members section to:

- add a new member
- modify an existing member
- activate or deactivate a member
- choose their default area
- control which areas they are allowed to work in
- choose their break preference

### Areas

Use the Areas section to:

- add a new area
- modify an area name
- set minimum staffing for an area
- migrate members and shifts from one area to another
- delete an area if it has no members assigned to it

## Daily Scheduling Workflow

Recommended daily workflow:

1. Open the correct date in `Schedule`.
2. Add members to shifts using `Add to Shift`.
3. Set the correct area, status, role, start time, and end time.
4. Review the runsheet.
5. Open `Break planning`.
6. Use `Auto-generate ALL` or `Auto-generate` for a specific person.
7. Use `Auto-fix covers` if needed.
8. Review the break timeline and any warnings.
9. Open the View page and print the required report.

## Shifts

### Adding a Shift

When adding a member to a shift, you can set:

- member
- area
- status
- role
- start time
- end time

### Shift Roles

Current roles:

- `Normal`
- `Floater`

`Floater` means that shift is prioritised to cover other people’s breaks where possible.

### Area Permissions

A member cannot be added to an area unless their member profile explicitly allows them to work there.

This rule applies to:

- creating a shift
- modifying a shift

### Multiple Shifts in One Day

A member can have multiple shifts in one day across different areas, but:

- the times must not overlap

Example:

- `12:00-15:00` in Registers
- `15:00-21:00` in Door

This is valid because the shifts touch, but do not overlap.

## Areas and Minimum Staffing

Each area has a minimum staffing number. This is used during break planning to help decide whether a break:

- needs a specific named coverer, or
- can be treated as `Area covered`

If the area still remains at or above minimum staffing while someone is on break, the system may show `Area covered` instead of assigning a named person.

This is intentional and is usually the correct operational outcome.

## Break Planning

### Important Concept: Continuous Work Blocks

Break entitlement is not calculated separately for each area segment.

Instead, the system combines back-to-back working shifts for the same member into one continuous work block.

Example:

- `06:30-07:00` Tool Shop
- `07:00-10:00` Registers
- `10:00-11:00` Cafe
- `11:00-13:00` Registers

If these run continuously with no gap, the system treats them as one continuous work period for break purposes.

This is important because a person’s break entitlement should reflect the total time they are working, even if they move between areas.

### Break Entitlement Rules

Break entitlement is based on total continuous working time:

- Less than 4 hours: no break
- 4 hours up to 5 hours: one 15-minute break
- More than 5 hours and less than 7 hours: one 15-minute break and one 30-minute break
- 7 hours up to but not including 10 hours: two 15-minute breaks and one 30-minute break
- 10 hours or more: two 15-minute breaks and two 30-minute breaks

### Break Preference

Each member has a break preference in their profile:

- `15 + 30`
- `30 + 15`
- `30 + 30`

This does not create extra breaks. It changes the preferred order of breaks where the person’s entitlement allows it.

In practice:

- `15 + 30` is the standard/default pattern
- `30 + 15` means prefer the 30-minute break earlier
- `30 + 30` means prefer 30-minute breaks first where the entitlement allows it; if the shift is shorter, the system falls back to the normal entitlement pattern

### Break Timing Rules

The planner aims to keep breaks:

- about 2 to 3 hours apart
- not in the last hour of a shift
- staggered within an area so people are not all away at once

### Break Coverage Rules

When deciding who should cover a break, Bunrun prefers:

1. valid `Floater` shifts
2. preferred coverers set on the shift
3. other valid staff who can work the area

The system also checks:

- the coverer is actually working at that time
- the coverer is not already on break
- the coverer is not already covering someone else at that time
- area minimum staffing is not broken by moving that person

### Area Covered vs Named Cover

Not every break needs a named person.

If the member’s area still remains properly staffed during the break, the system can mark the break as:

- `Area covered`

## Planner Logic in Plain English

This section describes what the planner actually does today.

### Step 1. Build continuous work blocks

The planner starts by looking only at `working` shifts.

If the same member has back-to-back working shifts with no gap, Bunrun merges them into one continuous work block.

Example:

- `06:00-09:00` Registers
- `09:00-12:00` Service Desk

This becomes one continuous work block from `06:00-12:00`.

If there is any gap, Bunrun creates a new work block.

Example:

- `06:00-09:00` Registers
- `09:30-12:00` Service Desk

This becomes two separate work blocks.

### Step 2. Decide break entitlement from total continuous minutes

Once the work block is built, Bunrun calculates the total continuous working time and assigns the break entitlement from that total.

Current entitlement rules are:

- less than 4 hours → no break
- 4 hours up to 5 hours → one 15-minute break
- more than 5 hours and less than 7 hours → one 15-minute break and one 30-minute break
- 7 hours up to but not including 10 hours → two 15-minute breaks and one 30-minute break
- 10 hours or more → two 15-minute breaks and two 30-minute breaks

### Step 3. Apply the member’s break preference

Bunrun does not change how many breaks a person gets.

The break preference only changes the preferred order of those breaks.

Current options are:

- `15+30`
- `30+15`
- `30+30`

In practice:

- `15+30` keeps the standard ordering
- `30+15` tries to place the 30-minute break earlier
- `30+30` pushes 30-minute breaks earlier where the entitlement includes them

If the entitlement is too small for the preference to matter, Bunrun falls back naturally to the available pattern.

### Step 4. Propose break times inside the work block

For each planned break, Bunrun tries to place it in a sensible operating window.

The planner aims for each break to be:

- at least about 2 hours after the previous work start or break
- ideally about 2.5 hours after the previous work start or break
- no later than about 3 hours after the previous work start or break
- not inside the last hour of the work block

It evaluates candidate start times in 15-minute increments.

For each candidate time, it scores the option based on:

- how close it is to the preferred timing
- how much it overlaps with other already-planned breaks in the same area

The planner tries a range of offsets around the preferred timing so it can find a better fit if an area is already busy.

### Step 5. Attach each break to the active shift at that time

A work block can span multiple areas.

When Bunrun places a break, it attaches that break to whichever shift is active at the break start time.

That means a break in the middle of a multi-area day is associated with the area the person is actually working in when the break begins.

### Step 6. Work out whether the break can be left as `Area covered`

Before Bunrun assigns a named coverer, it checks whether the break can safely run without naming a specific person.

To do that, it calculates how many working shifts are active in each area during the break window, then subtracts the person who is going on break.

If the area still remains at or above its configured minimum staffing, Bunrun can leave the break as:

- `Area covered`

This is intentional. It means a named cover is not operationally necessary.

### Step 7. Find eligible named coverers

If a named cover may be needed, Bunrun builds a list of valid cover options.

A person is only eligible if all of these are true:

- they are on a `working` shift
- they are active during the break window
- they are not the person taking the break
- they are not already on break at that time
- they are not already covering another break at that time
- they can legally work the target area
- assigning them would not break area minimum staffing rules elsewhere

Area permission rules are:

- if the member has `all_areas = 1`, they can cover any area
- otherwise they must have an explicit permission for that area
- if they are already rostered in the same area as the break, no area transfer is needed

### Step 8. Rank valid coverers

Once Bunrun has the valid options, it ranks them.

The scoring intentionally prefers:

1. leaving the break as `Area covered` when that is safe
2. `Floater` shifts
3. preferred coverers configured on the shift
4. same-area or lower-disruption options
5. other valid staff

More specifically:

- floaters get a strong preference
- preferred coverers are ranked in the order stored on the shift
- moving someone across areas is treated as slightly worse than keeping them in their home area

### Step 9. Resolve multiple breaks together

When Bunrun auto-generates or auto-fixes a set of breaks, it does not just choose each cover independently.

It searches combinations of cover assignments across the pending breaks and tries to find the best overall result.

This matters because:

- the same coverer cannot be reused for overlapping breaks
- one locally good assignment can block a better overall plan
- a floater may need to be saved for the harder of two overlapping problems

The planner prefers solutions that:

- generate more of the required breaks
- leave fewer breaks with invalid or missing cover
- keep the overall assignment score lower

### Step 10. Revalidate after changes

Bunrun revalidates cover assignments whenever the relevant data changes.

A previously valid cover can become invalid if:

- a shift changes area, time, role, or status
- someone is marked sick or otherwise becomes non-working
- another break is added that overlaps
- staffing minimums change
- permissions change

If a shift is changed significantly, Bunrun can clear that member’s break plan and related cover assignments so stale planning does not survive after roster edits.

### Important practical behaviours

These points are often the ones operators notice most:

- only `working` shifts count for break generation and coverage
- back-to-back working shifts are treated as one continuous work block
- breaks are attached to the shift active at the break start time
- a named cover is optional when minimum staffing still holds
- preferred coverers help ranking, but they do not override validity rules
- floaters are preferred, but not if assigning them would create a conflict or break staffing minimums
- if no valid named cover exists, the break can remain uncovered or `Area covered` depending on staffing

This means:

- the area is still safe and compliant
- a separate named coverer is not operationally required

If the area would fall below minimum staffing, the system will try to assign a named coverer.

### Break Planning Actions

Available actions include:

- `Auto-generate ALL (overwrite)`
- `Auto-generate missing only`
- `Auto-generate` for a specific work block
- `Auto-fix covers`
- manual cover assignment
- delete a break
- revalidate

## Preferred Coverers

For each shift, you can choose one or more preferred coverers in priority order.

The planner will try those people first when appropriate, but it will still respect:

- availability
- permissions
- no double-booking
- area minimum staffing

## Floater Role

The recommended design is already in place:

- `Floater` is a shift role, not an area

This keeps area reporting clean and makes future analysis easier.

A floater:

- still works in a real area
- can still appear on runsheets and reports normally
- is prioritised for break cover where possible

## Reports

The View page includes multiple reports:

- Runsheet
- Shifts by Area
- Shifts by Member
- Breaks by Area
- Breaks by Time
- Breaks by Member
- Breaks Taken

Each report has:

- day and week navigation
- a Print/PDF option

The print page also includes a `Back` button to return to the same report view.

### Breaks Taken report

The `Breaks Taken` report compares the planned break time against the actual time the break was taken.

It shows:

- member
- area
- scheduled break time
- actual break time, if recorded
- variance from plan, such as on time, early, or late
- break duration
- cover arrangement

It also includes a summary so you can quickly see:

- how many breaks were planned
- how many actual break times were recorded
- how many are still missing actual times
- how many were taken on time
- how many were early or late
- the average variance from the scheduled time

This is useful for spotting whether the day ran roughly to plan, where break timing drifted, and whether certain areas regularly push breaks earlier or later than intended.

## Runsheet

The runsheet shows:

- areas
- members
- shift times
- shift length
- break markers

When hovering over a break marker on-screen, the tooltip includes:

- break time
- duration
- assigned coverer if one exists

## Area Management

### Adding an Area

When creating an area, set:

- area name
- optional key
- minimum staffing

### Modifying an Area

You can update:

- area name
- minimum staffing

### Deleting an Area

An area cannot be deleted if it still has members attached to it.

If deletion is blocked, Bunrun shows a warning dialog instead of deleting it.

### Migrating an Area

Use the migration feature to move from one area to another. This updates:

- member default area
- member permissions
- shift history using that area

## Member Management

Members are managed using modal dialogs so you do not need to scroll to a long form.

For each member you can manage:

- active/inactive status
- default area
- allowed areas
- break preference

## Scheduling Statuses

Shift statuses can affect whether the person is counted for coverage. In practice, only working shifts participate in normal break planning and staffing coverage checks.

If someone is marked with a non-working status, Bunrun will not treat them as available to cover others.

## Operating Hours

The system uses these operating hours:

- Weekdays: `06:00-21:15`
- Weekends: `06:00-19:15`

Shifts outside these times can be flagged for review.

## Printing and PDF

Use the View page for operational printing.

The print/PDF output is designed for:

- sharing with team leaders
- day-of-use printouts
- quick reference on the floor

## Business Summary for Non-Technical Stakeholders

Here is the simplest way to explain the system in business terms:

### 1. Breaks are based on the person’s real working day

If someone moves between areas through the day, Bunrun still treats that as one continuous work period when calculating breaks.

This avoids under-allocating breaks for staff who are moved around the business.

### 2. Breaks are placed to support operations, not just compliance

The system tries to:

- keep breaks spaced sensibly
- avoid the last hour of a shift
- avoid sending too many people from the same area at once

### 3. Coverage can be explicit or operational

Sometimes a break needs a named person to cover it.

Sometimes it does not, because the area still has enough staff working.

In that case, the system shows `Area covered`, which is a more accurate business outcome than forcing a named cover.

### 4. Floaters are a staffing role, not an area

This is important for reporting and future analysis.

A floater is a person assigned to help cover breaks and support the operation, but they still work in a real area and are reported properly.

### 5. Minimum staffing protects service levels

Every area can have a minimum staff requirement. Break planning respects that number so the system does not recommend break arrangements that would leave an area understaffed.

### 6. The system supports future reporting

The design keeps areas, roles, permissions, work blocks, shifts, and breaks as separate concepts. That makes future reporting more reliable, for example:

- how many floaters were used
- where break coverage pressure occurs
- which areas are usually close to minimum staffing
- staffing patterns by area and day

## Practical Recommendations

For best results:

1. Keep member area permissions up to date.
2. Set realistic minimum staffing on each area.
3. Use `Floater` only for shifts that are genuinely intended to support other staff.
4. Re-run break generation after major roster changes.
5. Use the View reports for printouts and operational sharing.

## Known Operational Behaviours

- If shifts change for a member, their break plan for that day may be cleared and regenerated so stale break plans do not remain attached to the wrong work pattern.
- Back-to-back working shifts are merged into one continuous work block for break entitlement.
- A break may display as `Area covered` instead of showing a named coverer if staffing remains sufficient.

