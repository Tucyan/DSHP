# Web admin findings

## Server deployment (active)

- User's server is accessed through the currently open Alibaba Cloud ECS Workbench browser tab.
- Target capacity is 2 CPU / 2GB RAM; deployment must avoid concurrent builds/tests and use explicit memory limits.
- Existing Nginx must remain unaffected; prefer the app's loopback-only port 3182 and an SSH tunnel for admin access.
- GitHub source repository is public at https://github.com/Tucyan/DSHP and local `main` tracks `origin/main`.
- Server audit: Ubuntu 22.04.5 LTS x86_64, 2 CPUs, 1608MB RAM (about 301MB available during audit), 4095MB swap unused, and about 16GB free on `/`.
- Nginx is active and `nginx -t` succeeds. It owns public ports 80/443; other current listeners include 22, 3306, 8080 and 18080 plus loopback 3030/8000. Port 3182 is free.
- Installed tools: Git 2.34.1, Node v18.20.8, Corepack 0.32.0, no globally active pnpm. The repository requires Node >=24, so the active Node must be switched or installed before deployment.
- Root has an existing `.nvm` directory, so inspect available NVM versions before choosing an installation path.
- NVM 0.40.3 is installed, but only Node v18.20.8 is present; no Node 24 installation exists yet.
- Explicitly authorized old-service shutdown identified three Docker containers: `yuncang-frontend` (18080), `yuncang-backend` (8080), and `yuncang-mysql` (3306).
- The three containers stopped cleanly without deletion. Available RAM rose from about 301MB to 936MB, swap remained unused, and ports 8080/18080/3306 were released.
- Nginx remained active and `nginx -t` still succeeded after the old containers stopped.
- Capacity conclusion: adequate for one bounded DSHP runtime if dependencies/build run serially, Node heap is capped around 768MB, server tests are skipped, and Nginx remains separate.
- First systemd start reached DSH composition but failed because the Host overlay inserted `@deepseek-ai/dsh-schedule` as a bare package name. The loader resolves Host-overlay entries from the isolated profile directory, which has no node_modules. Host itself already uses an absolute file URL, establishing the correct pattern.
- A direct diagnostic initially reported an invalid Peer ID because the audit shell retained old empty exported values and Node `--env-file` does not override inherited variables. Removing inherited variables reproduced the true systemd error; no credential value was printed.
- Root-cause fix: resolve the installed Schedule entry with `createRequire(import.meta.url)` and pass its absolute `file:` URL in the Host patch.

## Previous implementation findings

- DSH 0.1.1-rc.2 public SessionPersistence.inspect/readFrom are read-only; load commits recovery and is forbidden for browsing.
- Public SystemPrompt.section supports scoped dynamic providers; snapshots must be frozen per turn, since assembly runs per model step.
- Public schedule tools schedule_create/list/delete own durable changes. Do not write schedule events manually.
- Host foreground is derived from configured QQ peer; hidden roles decision/dream/maintenance share ID prefix.
- Existing Host wakeForeground drops the WakeResult, preventing Bridge proactive send. Fix and regression-test it.
- MemoryService supplies controlled apply/list/read/search/projections and safe filesystem boundaries; revisions contain metadata, not full historical snapshots.
- Existing architecture page on 3181 is static and must remain separate from live admin.
- Existing dirty changes are README/package scripts, Host and Runtime CLI fixes, architecture explorer, and operational workspace state. Never read credential contents or overwrite operational data.
