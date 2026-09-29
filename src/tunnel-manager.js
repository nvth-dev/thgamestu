import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const workspace = '/workspace';
const stateDir = path.join(workspace, '.enthstudio');
const previewsFile = path.join(stateDir, 'previews.json');
const tunnelsFile = path.join(stateDir, 'tunnels.json');
const port = Number(process.env.TUNNEL_PORT || 3002);
const originHost = process.env.TUNNEL_ORIGIN_HOST || 'host.docker.internal';
const children = new Map();

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_000) throw new Error('Request quá lớn');
  }
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('JSON không hợp lệ'); }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function saveState() {
  await mkdir(stateDir, { recursive: true });
  const tunnels = {};
  for (const [projectId, entry] of children) tunnels[projectId] = publicEntry(entry);
  await writeFile(tunnelsFile, `${JSON.stringify({ tunnels, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

function publicEntry(entry) {
  return {
    projectId: entry.projectId,
    port: entry.port,
    target: entry.target,
    status: entry.status,
    url: entry.url || null,
    error: entry.error || null,
    pid: entry.child?.pid || null,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt
  };
}

function projectId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 50) throw new Error('Project ID không hợp lệ');
  return id;
}

async function previewFor(id) {
  const registry = await readJson(previewsFile, { previews: {} });
  const preview = registry.previews?.[id];
  if (!preview || preview.status !== 'running' || !Number.isInteger(Number(preview.port))) {
    throw new Error('Project chưa có Docker preview đang chạy');
  }
  return { ...preview, port: Number(preview.port) };
}

function quickTunnelUrl(text) {
  const match = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/ig);
  return match?.[0] || null;
}

async function stopTunnel(id) {
  const entry = children.get(id);
  if (!entry) return false;
  entry.stopping = true;
  entry.cancelReady?.();
  entry.child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 2_000);
    entry.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
  children.delete(id);
  await saveState();
  return true;
}

async function startTunnel(id) {
  const existing = children.get(id);
  if (existing && ['starting', 'running'].includes(existing.status)) return publicEntry(existing);

  const preview = await previewFor(id);
  const target = `http://${originHost}:${preview.port}`;
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', target], {
    cwd: workspace,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const entry = {
    projectId: id,
    port: preview.port,
    target,
    child,
    status: 'starting',
    url: null,
    error: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  children.set(id, entry);
  await saveState();

  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      entry.error = 'Cloudflare Quick Tunnel không trả URL trong 30 giây';
      child.kill('SIGTERM');
      reject(new Error(entry.error));
    }, 30_000);
    entry.cancelReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Tunnel đã bị dừng'));
    };
    const onOutput = chunk => {
      const url = quickTunnelUrl(chunk.toString());
      if (!url || settled) return;
      settled = true;
      clearTimeout(timer);
      entry.status = 'running';
      entry.url = url;
      entry.updatedAt = new Date().toISOString();
      resolve(entry);
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      entry.error = error.message;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled || entry.stopping) return;
      entry.status = 'failed';
      entry.error = entry.error || `cloudflared kết thúc (code ${code ?? 'null'}, signal ${signal || 'unknown'})`;
      entry.updatedAt = new Date().toISOString();
      settled = true;
      clearTimeout(timer);
      reject(new Error(entry.error));
    });
  });

  try {
    const result = await ready;
    entry.cancelReady = null;
    await saveState();
    return publicEntry(result);
  } catch (error) {
    children.delete(id);
    await saveState();
    throw error;
  }
}

async function listTunnels() {
  const tunnels = {};
  for (const [id, entry] of children) tunnels[id] = publicEntry(entry);
  return { tunnels: Object.values(tunnels) };
}

async function cleanupOrphans() {
  const registry = await readJson(previewsFile, { previews: {} });
  for (const [id] of children) {
    if (registry.previews?.[id]?.status !== 'running') await stopTunnel(id);
  }
}

await mkdir(stateDir, { recursive: true });
await writeFile(tunnelsFile, `${JSON.stringify({ tunnels: {}, updatedAt: new Date().toISOString() }, null, 2)}\n`);

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/tunnels') return json(res, 200, await listTunnels());
    if (req.method === 'POST' && url.pathname === '/tunnels') {
      const input = await bodyJson(req);
      const id = projectId(input.projectId);
      return json(res, 200, { tunnel: await startTunnel(id) });
    }
    const match = url.pathname.match(/^\/tunnels\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
    if (req.method === 'DELETE' && match) {
      const id = projectId(match[1]);
      await stopTunnel(id);
      return json(res, 200, { stopped: true, projectId: id });
    }
    return json(res, 404, { error: 'Không tìm thấy' });
  } catch (error) {
    return json(res, 400, { error: error.message || 'Không thể xử lý tunnel' });
  }
}).listen(port, '0.0.0.0', () => console.log(`enthstudio tunnel manager listening on ${port}`));

async function shutdown() {
  await Promise.all([...children.keys()].map(id => stopTunnel(id).catch(() => {})));
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
setInterval(() => cleanupOrphans().catch(error => console.error(`tunnel cleanup: ${error.message}`)), 5_000);
