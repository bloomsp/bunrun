# bunrun

Break coordination and roster management tool for the Service Desk team.

## User documentation

See [USER_GUIDE.md](./USER_GUIDE.md) for end-user documentation, break logic notes, and day-to-day operating guidance.

Current capabilities include:
- daily and weekly roster management
- member and area administration
- break generation for continuous work blocks
- cover assignment and validation
- read-only reporting plus print/PDF views

## Dev setup

### 1) Install

```bash
npm install
```

### 2) Configure passwords (local)

Copy the example file and fill in values:

```bash
cp .dev.vars.example .dev.vars
```

Set:
- `BUNRUN_VIEW_PASSWORD`
- `BUNRUN_ADMIN_PASSWORD`

### 3) Run

```bash
npm run dev
```

### Local Worker preview (recommended for real app testing)

Bunrun depends on Cloudflare bindings such as D1, so plain `npm run dev` is not enough for end-to-end local testing.

Use:

```bash
npm run preview:worker
```

This now automatically:
- rebuilds from a clean `dist/`
- copies `.dev.vars` into the generated Worker preview context
- copies SQL migrations into the generated Worker preview context
- applies local D1 migrations for the preview worker before starting Wrangler

If you are only changing frontend code, `npm run dev` is still fine. If you need auth, D1, or real workflow behaviour, use `npm run preview:worker`.

### 4) Test

```bash
npm test
```

## Deployment

Production is now deployed on **Cloudflare Workers**.

The Astro 6 + `@astrojs/cloudflare` v13 stack is Worker-first. Use:

```bash
npm run deploy:worker
```

This builds the app and deploys with the generated Worker config at `dist/server/wrangler.json`.

Cloudflare-side configuration needed:
- D1 binding: `DB`
- Environment variables / secrets: `BUNRUN_VIEW_PASSWORD`, `BUNRUN_ADMIN_PASSWORD`
- Session KV binding: `SESSION`
- `workers.dev` enabled for smoke testing
- Custom domain attached to the Worker for production

Notes:
- The Worker is reachable on a `*.workers.dev` hostname unless you attach a custom domain.
- The repo no longer includes Cloudflare Pages compatibility output.
