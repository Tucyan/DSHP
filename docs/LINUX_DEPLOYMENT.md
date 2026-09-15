# Linux deployment

This deployment targets a small Ubuntu server with systemd, 2 CPUs and 2GB or less RAM.
It does not create, edit, reload or restart Nginx. The admin server remains bound to
`127.0.0.1:3182` and should be reached through an SSH tunnel.

## Paths

- Application: `/opt/dshp`
- Secrets and runtime settings: `/etc/dshp/dshp.env` (`root:root`, mode `0600`)
- Service unit: `/etc/systemd/system/dshp.service`
- Durable application state: `/opt/dshp/runtime` and `/opt/dshp/workspace`

## First deployment

Use Node 24. On a small Chinese-region server, NVM and pnpm can use domestic mirrors:

```sh
export NVM_DIR=/root/.nvm
. "$NVM_DIR/nvm.sh"
export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
nvm install 24
nvm use 24
export COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
corepack pnpm@11.7.0 --version

git clone https://github.com/Tucyan/DSHP.git /opt/dshp
cd /opt/dshp
corepack pnpm@11.7.0 config set registry https://registry.npmmirror.com
NODE_OPTIONS=--max-old-space-size=768 corepack pnpm@11.7.0 install --frozen-lockfile --child-concurrency=1 --network-concurrency=4
NODE_OPTIONS=--max-old-space-size=768 corepack pnpm@11.7.0 exec tsc -b
NODE_OPTIONS=--max-old-space-size=768 corepack pnpm@11.7.0 --filter @personal-growth/admin-web build

install -d -m 0700 /etc/dshp
install -m 0600 .env.server.example /etc/dshp/dshp.env
node scripts/render-systemd.mjs --repo /opt/dshp --node "$(command -v node)" > /etc/systemd/system/dshp.service
systemctl daemon-reload
```

Fill `/etc/dshp/dshp.env` before enabling the service. The required values are
`QQBOT_APP_ID`, `QQBOT_APP_SECRET`, `QQBOT_ALLOWED_PEER_ID`, and `DEEPSEEK_API_KEY`.

```sh
systemctl enable --now dshp
systemctl status dshp --no-pager
journalctl -u dshp -n 100 --no-pager
```

## Admin access

Create a tunnel from the operator computer without changing Nginx:

```sh
ssh -L 3182:127.0.0.1:3182 root@SERVER_IP
```

Then open `http://127.0.0.1:3182`. On the server, obtain the generated login token with:

```sh
cd /opt/dshp
PGA_REPO_ROOT=/opt/dshp corepack pnpm@11.7.0 admin:token
```

## Model configuration

The default model is stored by DSH in `/opt/dshp/runtime/dsh-home/settings.yaml`
under the `agent-default-model` namespace. The authenticated management page writes
this file through DSH's locked, atomic, revision-checked settings service. Do not put
an API key in this file; `DEEPSEEK_API_KEY` remains in `/etc/dshp/dshp.env`.

```yaml
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4.1-flash-expires-on-0910
```

An admin save drains the current Agents after any in-flight turn finishes. The next
request resumes the same durable session with the new model. Valid direct file edits
are watched by DSH, but using the management page is preferred because it also
performs the cached-Agent handover immediately.

## Update

### Heartbeat / delivery update (2026-09-15)

The management page now exposes **系统提示词 → Heartbeat 指令** for foreground
and background instructions. Saves apply at the next wake; running work keeps its
captured instruction. `runtime/admin/prompts.json` migrates version 1 to version 2
without replacing SOUL/Mission or changing pause/cadence settings. When rolling
back to an older binary, restore the matching stopped-service prompts file as well.

Foreground heartbeat wakes the fixed main agent. It can work silently during quiet
hours; proactive `send_message` delivery is checked against quiet hours, cooldown,
and daily limits. Busy foreground work is serialized; overlapping wakes are merged.
Official Schedule completion retains its separate policy path.

User requests require a final delivery. `send_message` accepts optional `purpose`
(`progress` or `final`, default `final`). If a final message is missing, the Host
allows one correction with only the send tool; continued omission uses a fixed
failure notice, never arbitrary internal assistant text. Unknown transport outcomes
are retained for operator reconciliation and are not automatically sent again.
Diagnostics distinguish `repairing`, `delivery_fallback`, and `delivery_unknown`.
Heartbeat turns may end silently; user-message turns use the delivery guarantee.

Run `corepack pnpm@11.7.0 verify` locally. Test files run serially because their
filesystem/process integration deadlines are sensitive to parallel load. Server
updates only run bounded builds and small isolated smoke checks.

Stop the service before changing application files so runtime state stays consistent:

```sh
systemctl stop dshp
cd /opt/dshp
git pull --ff-only
NODE_OPTIONS=--max-old-space-size=768 corepack pnpm@11.7.0 install --frozen-lockfile --child-concurrency=1 --network-concurrency=4
NODE_OPTIONS=--max-old-space-size=768 corepack pnpm@11.7.0 exec tsc -b
NODE_OPTIONS=--max-old-space-size=768 corepack pnpm@11.7.0 --filter @personal-growth/admin-web build
systemctl start dshp
```

Back up `/opt/dshp/runtime` and `/opt/dshp/workspace` from the same stopped-service point.
