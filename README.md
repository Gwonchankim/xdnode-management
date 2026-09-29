# XDnode management

경영지원실(인사·임금 계산·감사 기록) 사내 도구. [vinext](https://github.com/cloudflare/vinext)
위에서 로컬 D1/R2로 사무실 PC 한 대에서 돈다. 개편 계획과 결정 사항은
`docs/00-pm/xdnode-management.prd.md`, `docs/01-plan/features/xdnode-management.plan.md`,
`docs/02-design/features/xdnode-management.design.md`에 있다. 사무실 PC에서는
`scripts/Start-XDNodeManagement.ps1`로 앱과 AI 브리지를 함께 띄운다.

아래는 이 저장소가 시작한 vinext 템플릿의 일반 안내다.

## Prerequisites

- Node.js `>=22.15.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Sign-in

Sign-in is local accounts with a 30-day session cookie (`xdm_session`), not Sign in with ChatGPT.
The first administrator is created once, from the server PC only (`POST /api/auth/bootstrap`); later accounts are
created by an administrator (`/api/admin/accounts`). See `app/auth-session.ts`, `app/erp-platform.ts` and
the xdnode-management Design document (§4.2, §7).

## Useful Commands

- `npm run dev`: start local development (`127.0.0.1:3100`)
- `npm run build`: verify the vinext build output
- `npm run start` / `npm run serve:lan`: serve the build with `vite preview` on `127.0.0.1:3000` / `0.0.0.0:3000`
  (operations: `scripts/Start-XDNodeManagement.ps1`, `docs/lan-operations-runbook.md`)
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
