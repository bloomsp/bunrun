# bunrun

Break coordination tool for the Service Desk team.

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

Intended deployment target: **Cloudflare Pages** (repo: https://github.com/bloomsp/bunrun).

Environment variables required in Cloudflare:
- `BUNRUN_VIEW_PASSWORD`
- `BUNRUN_ADMIN_PASSWORD`
