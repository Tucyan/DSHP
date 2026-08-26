import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.env.PGA_REPO_ROOT || process.cwd());
const port = Number(process.env.PGA_WEB_PORT || 3180);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PGA_WEB_PORT must be an integer between 1024 and 65535');
const runtime = path.join(root, 'runtime');
const paths = { root, dshHome: path.join(runtime, 'dsh-home'), agentsHome: path.join(runtime, 'agents-home'), workspace: path.join(root, 'workspace'), plugins: path.join(runtime, 'plugins'), skills: path.join(runtime, 'skills'), sessions: path.join(runtime, 'sessions'), storage: path.join(runtime, 'storage'), credentials: path.join(runtime, 'credentials'), webPort: port };
const home = process.env.USERPROFILE || process.env.HOME;
if (home && [path.join(home, '.dsh'), path.join(home, '.agents')].some((p) => path.resolve(p).toLowerCase() === path.resolve(paths.dshHome).toLowerCase() || path.resolve(p).toLowerCase() === path.resolve(paths.agentsHome).toLowerCase())) throw new Error('refusing default DSH/Agents home');
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(paths) + '\n');
else process.stdout.write(`DSH_HOME=${paths.dshHome}\nDSH_AGENTS_HOME=${paths.agentsHome}\nDSH_WORKSPACE=${paths.workspace}\nPGA_WEB_PORT=${paths.webPort}\n`);
