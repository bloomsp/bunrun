# Bunrun — Project Summary

_Last reviewed: 2026-05-21_

## Purpose

Bunrun is a break coordination and roster management tool for a Service Desk/team operations environment. It helps admins build daily rosters, plan breaks, assign coverage, and produce read-only/printable operational reports.

## Stack

- Astro 6 server-rendered app
- React components where useful
- Tailwind CSS 4
- Cloudflare Worker deployment via `@astrojs/cloudflare` and Wrangler
- Cloudflare D1 database binding `DB`
- Simple password-based role login using Worker/env secrets

## Main user roles

- **Team/view role** — read-only access to runsheets, break reports, shift reports, and print/PDF views.
- **Admin role** — full schedule, member, area, shift, and break-planning management.

## Main areas

- `src/pages/admin` — admin dashboard, areas, members, and schedule screens
- `src/pages/view` — read-only daily view and print view
- `src/pages/breaks` — break-focused read-only views
- `src/pages/login` — login screens
- `src/pages/api` — form/API mutations for schedules, shifts, breaks, members, areas, login/logout
- `src/lib` — core scheduling, auth, break generation, work-block, D1, and reporting logic
- `migrations` — D1 schema migrations
- `tests` — Node test coverage for planner logic and route integration

## Core domain model

- `areas` define operational locations and minimum staffing levels.
- `members` define staff, active state, default area, allowed areas, and break preference.
- `schedules` define calendar days.
- `shifts` place members into areas/times/statuses/roles for a schedule.
- `work_blocks` group back-to-back working shifts for break entitlement.
- `breaks` store planned/taken breaks and optional cover assignments.

## Verification commands

```bash
npm test
npm run build
```

Last local verification on 2026-05-21:

- `npm test` passed 33/33
- `npm run build` passed
- Git status was clean before documentation changes

## Local development

Use `npm run dev` for frontend-only iteration.

Use `npm run preview:worker` for realistic testing with Cloudflare Worker/D1 bindings.

Production deploy uses:

```bash
npm run deploy:worker
```
