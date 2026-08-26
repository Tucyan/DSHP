# Isolated DSH runtime

This project uses a separate DSH profile under `runtime/`. `init-runtime.ps1` creates the profile directories and `start-runtime.ps1 -DryRun` prints the exact environment and working directory without launching DSH. `verify-isolation.ps1` checks that no path resolves to the host user's `.dsh` or `.agents`.

The adapters pin DSH `@deepseek-ai/dsh@0.1.1-rc.2` and Tencent QQ `@tencent-connect/dsh-qqbot@0.4.0`. The QQ bundle remains the owner of the QQ protocol; this repository only applies its single-user gate and translates events to domain triggers.

QQ deployment has two gates: the package-level bundle layer is disabled by default, and the opt-in installer writes a profile-level, name-checked overlay for exactly one quoted peer before it installs the Tencent bundle. Until that overlay exists, no QQ user is reachable. Use only `install-runtime-bundles.ps1 -Install -PeerId ...`; installing the official Tencent package directly is unsupported. Non-live starts always add the checked-in disabled patch, while live starts require the managed overlay and matching `QQ_PEER_ID` (or `-PeerId`).

DSH schedules are session-local: a schedule binding is durable in this project, but DSH can fire it only while its target session is live. On restart, overdue bindings are surfaced for recovery and are not silently treated as a live-session fire. Live QQ receive/send requires user-provided credentials or QR authorization and is intentionally excluded from credential-free tests.
