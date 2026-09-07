import process from 'node:process'

function argument(name) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`${name} is required`)
  return value
}

function safeAbsolutePath(name, value) {
  if (!/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(value) || value.split('/').includes('..')) {
    throw new Error(`${name} must be a simple absolute Linux path`)
  }
  return value.replace(/\/$/u, '')
}

const repo = safeAbsolutePath('--repo', argument('--repo'))
const node = safeAbsolutePath('--node', argument('--node'))

process.stdout.write(`[Unit]
Description=DSHP Personal Growth Agent
Wants=network-online.target
After=network-online.target
ConditionPathExists=/etc/dshp/dshp.env

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${repo}/workspace
EnvironmentFile=/etc/dshp/dshp.env
ExecStart=${node} ${repo}/packages/dsh-host/dist/cli.js --live-qq
Restart=on-failure
RestartSec=10s
TimeoutStopSec=90s
KillSignal=SIGTERM
MemoryHigh=1000M
MemoryMax=1200M
CPUQuota=150%
TasksMax=256
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${repo}/runtime ${repo}/workspace

[Install]
WantedBy=multi-user.target
`)
