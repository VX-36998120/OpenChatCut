// Runnable check: `npx tsx server/plugins/external-agent-startup.verify.ts`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'openchatcut-mcp-startup-'));
try {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.OPENCHATCUT_MCP_TOKEN;
  delete env.OPENCHATCUT_DEV_PROFILE_ID;
  delete env.OPENCHATCUT_DATA_DIR;
  const child = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    "import { externalAgentPlugin } from './server/plugins/external-agent.ts';\n"
      + "externalAgentPlugin().configureServer({ middlewares: { use() {} } });\n",
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout || 'startup process failed');
  const tokenPath = join(home, '.openchatcut', 'mcp-token');
  const token = readFileSync(tokenPath, 'utf8').trim();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('OpenChatCut startup creates a persistent MCP token.');
