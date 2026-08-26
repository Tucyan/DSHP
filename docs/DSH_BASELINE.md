# DSH Baseline

| Item | Locked value |
|------|--------------|
| DSH npm package | `@deepseek-ai/dsh@0.1.1-rc.2` |
| DSH upstream commit | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| QQ bundle | `@tencent-connect/dsh-qqbot@0.4.0` |
| QQ repository baseline | `tencent-connect/dsh-qqbot` main at `99e2706` (reference only) |
| Node | `v24.11.1` locally; DSH requires `^22.19.0 || >=24.0.0` |
| pnpm | DSH upstream declares `11.7.0`; project invocation uses Corepack |
| First verified | `2026-08-26` (Asia/Singapore) |

## Stability policy

- Never use `latest`, `next`, `master`, or semver ranges in runtime scripts.
- Commit the project lockfile.
- Keep all DSH-facing code in adapter or Cordis entry-point files.
- Run contract and live smoke tests before changing either pinned package.
- Treat DSH as Developer Preview and record any compatibility exception here.

## Isolation policy

The Personal Agent launcher sets these absolute project-local paths before invoking DSH:

- `DSH_HOME=<repo>/runtime/dsh-home`
- `DSH_AGENTS_HOME=<repo>/runtime/agents-home`
- current directory `<repo>/workspace`
- Web port from validated project configuration, default `3180`

The launcher must reject a resolved DSH home or Agents home that equals the user's default `.dsh` or `.agents` directory.

## External verification boundary

Automated tests use local fake model, schedule, and QQ ports. A live DSH config dump can run without a model call after dependencies are installed. Live QQ send/receive requires the user's QR authorization or AppID/AppSecret and is documented as a separate smoke test.

