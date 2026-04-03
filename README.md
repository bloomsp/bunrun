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

Current production is still on **Cloudflare Pages**, and `npm run build` includes a Pages compatibility postbuild that restores `dist/_worker.js` and `dist/_routes.json`.

### Cloudflare Workers migration

The Astro 6 + `@astrojs/cloudflare` v13 stack is Worker-first. For a proper long-term deployment target, use:

```bash
npm run deploy:worker
```

This builds the app and deploys with the generated Worker config at `dist/server/wrangler.json`.

Cloudflare-side configuration needed:
- D1 binding: `DB`
- Environment variables / secrets: `BUNRUN_VIEW_PASSWORD`, `BUNRUN_ADMIN_PASSWORD`
- Session KV binding: `SESSION`
- `workers.dev` enabled for smoke testing
- Custom domain attached to the Worker for production cutover

Notes:
- `bunrun.pages.dev` is a Pages hostname and will not become the Worker URL.
- The Worker will instead be reachable on a `*.workers.dev` hostname unless you attach a custom domain.

Recommended cutover flow:
1. Deploy the Worker.
2. Verify `/`, `/view`, `/admin`, and login flows on the `*.workers.dev` URL.
3. Attach the production domain to the Worker.
4. Retire the Pages deployment once traffic is cut over.
