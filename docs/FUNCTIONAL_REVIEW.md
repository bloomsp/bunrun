# Bunrun — Functional Review

_Last reviewed: 2026-05-21_

## Executive summary

Bunrun is a focused roster and break-planning application. The strongest part of the system is the break planner: it models continuous work blocks across multiple same-day shifts, applies break entitlement rules, proposes break timings, then validates and ranks cover assignments against availability, area permissions, floater/preferred-coverer rules, and area minimum staffing.

The app is currently healthy from a local verification perspective: tests and production build pass.

## What the app does

Bunrun supports:

- daily and weekly roster management
- member administration
- area administration and area minimum staffing
- multi-shift days for the same member
- continuous-work-block calculation
- automatic break generation
- break cover assignment and validation
- read-only daily reports
- printable/PDF operational views

## User-facing workflows

### Admin workflow

The intended daily admin workflow is:

1. Open the schedule for a date.
2. Add members to shifts.
3. Set area, status, role, start time, and end time.
4. Review the runsheet.
5. Open break planning.
6. Auto-generate breaks for all work blocks or a specific work block.
7. Auto-fix covers where needed.
8. Review warnings and the break timeline.
9. Open the read-only/print view for operational use.

### Read-only workflow

Read-only/team users can:

- view daily runsheets
- view break reports
- view shift reports
- use print/PDF views

## Roles and access

Authentication is deliberately simple:

- `BUNRUN_VIEW_PASSWORD` grants team/read-only access.
- `BUNRUN_ADMIN_PASSWORD` grants admin access.
- Login sets a `bunrun_role` HttpOnly SameSite=Lax cookie for 12 hours.
- Admin API routes and admin pages call `requireRole(request, 'admin')`.
- Team/view routes require a logged-in role but do not grant admin mutation powers.

This is appropriate for a small internal operational tool, but it is not account-level identity management: there is no per-user audit trail, named login, password hashing inside the app, MFA, or granular permission model.

## Data model

The D1 schema centres on:

- `areas` — area key/label plus later `min_staff`
- `statuses` — shift status and whether the status blocks coverage
- `members` — active staff members; later migrations add area permissions, default area, and break preference
- `member_area_permissions` — explicit allowed areas when a member is not all-areas
- `schedules` — one row per date
- `shifts` — member/date/area/status/role/start/end records; later migrations allow multiple shifts per member per day
- `shift_cover_priorities` — preferred coverers for a shift in priority order
- `work_blocks` — continuous working periods derived from back-to-back working shifts
- `breaks` — planned/taken breaks, duration, actual time, source, work-block link, and optional cover member

## Break-planning logic

### Work blocks

`src/lib/work-blocks.ts` builds work blocks by:

- considering only `working` shifts
- excluding the dedicated breaks role
- sorting by member/start/end/id
- merging shifts only when the previous end time exactly equals the next start time
- creating a new work block whenever there is a gap, different member, or non-working status

This is the key functional design choice: break entitlement is based on continuous working time, not individual area segments.

### Break entitlement

`src/lib/autogen.ts` defines the break template:

- less than 4 hours: no break
- 4 to 5 hours: one 15-minute break
- more than 5 and less than 7 hours: one 15-minute and one 30-minute break
- 7 to less than 10 hours: two 15-minute breaks and one 30-minute break
- 10 hours or more: two 15-minute breaks and two 30-minute breaks

Member break preference (`15+30`, `30+15`, `30+30`) affects order, not entitlement count.

### Timing proposal

Breaks are proposed in 15-minute increments. The planner aims to place each break:

- at least roughly 2 hours after work start or previous break
- preferably around 2.5 hours after work start or previous break
- no later than roughly 3 hours after work start or previous break
- not inside the final hour of the work block
- with reduced overlap against existing area breaks

The generator tries multiple initial offsets around the default timing and picks the best plan by generated-count and missing/invalid-cover count.

### Cover validation and ranking

`src/lib/break-planner.ts` validates cover options by checking:

- coverer is currently on a working shift
- coverer is not the person taking the break
- coverer is not on break at the same time
- coverer is not already covering another overlapping break
- coverer can work the target area, or is already in that area
- assigning the coverer does not break minimum staffing in their own area or the target area

Ranking favours:

1. safe `Area covered` outcomes where no named cover is needed
2. dedicated breaks-role/floater-like coverage in the relevant area
3. floater shift role
4. preferred coverers in configured priority order
5. same-area/lower-disruption options
6. other valid staff

For multiple pending breaks, `assignBestCovers` does a search across combinations rather than greedily picking each cover independently. This avoids locally good choices blocking better overall plans.

## Admin mutations

Mutation routes cover:

- areas: add/update/delete/migrate
- members: add/update/toggle active/set area permissions
- shifts: upsert/update/delete
- breaks: add/delete/assign-cover/autogen/autogen-all/autofix/revalidate/record-taken
- schedule: copy day/copy week
- login/logout

Most domain mutations re-run relevant validation or recomputation, especially work-block recomputation and stale break/cover clearing when shifts materially change.

## Reporting and views

The app provides:

- admin schedule screen with shift table, runsheet, break timeline, and break planning panel
- read-only view screens
- print view under `src/pages/view/[date]/print.astro`
- break-focused pages under `src/pages/breaks`

## Test coverage observed

Current tests cover:

- break entitlement thresholds
- break preference ordering
- break time proposal and staggering
- work-block merging
- cover assignment validity
- floater/preferred-coverer priority
- area minimum staffing protection
- cross-area permission rules
- several route-integration validation cases
- actual/taken break time behaviour
- copy-day/week validation
- shift overlap rejection
- clearing cover assignments when marking shifts sick

Local verification on 2026-05-21:

- `npm test` passed 33/33
- `npm run build` passed

## Strengths

- Domain rules are documented in `USER_GUIDE.md` and reflected in tests.
- Break planning is not just simple scheduling; it handles continuous work blocks and combination search for cover assignment.
- D1/Worker deployment path is documented and buildable.
- Route tests exercise real mutation behaviour, not just pure helpers.
- User guide is operationally useful, not just technical.

## Risks / limitations

- Authentication is shared-password based; fine for a small internal tool, but no individual accountability or granular access.
- Local `astro dev` is not enough for realistic testing because D1 bindings require Worker preview.
- Break timing assumes same-day HH:MM ranges; overnight shifts do not appear to be a design target.
- Work-block merging requires exact touching times; even a small gap intentionally splits entitlement.
- There is no obvious CI status checked in this review; local tests/build pass.
- Generated `dist/` should remain ignored/not committed after builds.

## Recommended next improvements

1. Add a short admin smoke-test checklist to `USER_GUIDE.md` for validating a new deployment.
2. Add CI if not already configured: run `npm test` and `npm run build` on push/PR.
3. Consider a lightweight audit log for admin mutations if the app becomes operationally critical.
4. Consider a documented backup/export process for the D1 database.
5. If more people use it, consider moving from shared passwords to named users or Cloudflare Access.
