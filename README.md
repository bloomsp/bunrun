# bunrun

Break coordination tool for the Service Desk team.

## User documentation

See [USER_GUIDE.md](./USER_GUIDE.md) for end-user documentation, business-facing break logic notes, and day-to-day operating guidance.

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
