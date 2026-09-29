import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const workspace = '/workspace';
const projectsDir = path.join(workspace, 'projects');
const stateDir = path.join(workspace, '.enthstudio');
const registryFile = path.join(stateDir, 'previews.json');
const serverFile = path.join(stateDir, 'static-server.mjs');
const dockerSocket = '/var/run/docker.sock';
const containerSource = process.env.HOSTNAME;
const previewImage = process.env.PREVIEW_IMAGE || 'project_h-preview-manager';
const labels = { 'com.enthstudio.preview':'true', 'com.enthstudio.managed-by':'preview-manager' };
const execFileAsync = promisify(execFile);
const dockerContainerPort = 18808;

const staticServer = `import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.argv[2] || '.');
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.wasm':'application/wasm','.mp3':'audio/mpeg','.wav':'audio/wav','.ico':'image/x-icon' };
http.createServer(async (req, res) => {
  try {
    let target = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (target === '/') target = '/index.html';
    const file = path.resolve(root, '.' + target);
    if (!file.startsWith(root + path.sep) && file !== root) throw new Error('outside root');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not file');
    res.writeHead(200, { 'content-type':mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control':'no-store' });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404, { 'content-type':'text/plain; charset=utf-8' }); res.end('Not found'); }
}).listen(Number(process.env.PORT || 3000), '0.0.0.0');
`;

function docker(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : null;
    const request = http.request({ socketPath:dockerSocket, path:requestPath, method, headers:raw ? { 'content-type':'application/json', 'content-length':Buffer.byteLength(raw) } : {} }, response => {
      let text = '';
      response.on('data', chunk => text += chunk);
      response.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (response.statusCode >= 200 && response.statusCode < 300) resolve({ data, text });
        else reject(new Error(typeof data === 'object' && data?.message ? data.message : text || `Docker HTTP ${response.statusCode}`));
      });
    });
    request.on('error', reject);
    if (raw) request.write(raw);
    request.end();
  });
}

function dockerBinary(method, requestPath, body, contentType = 'application/x-tar') {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath:dockerSocket, path:requestPath, method, headers:{ 'content-type':contentType, 'content-length':body.length } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 200 && response.statusCode < 300) resolve({ text });
        else reject(new Error(text || `Docker HTTP ${response.statusCode}`));
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function exists(id) {
  try { return (await docker('GET', `/containers/${encodeURIComponent(id)}/json`)).data; }
  catch { return null; }
}

function ownedContainer(container, projectId) {
  const actual = container?.Config?.Labels || {};
  return actual['com.enthstudio.preview'] === 'true'
    && actual['com.enthstudio.managed-by'] === 'preview-manager'
    && (!projectId || actual['com.enthstudio.project'] === projectId);
}

async function removeOwned(id, projectId) {
  if (!id) return;
  const container = await exists(id);
  if (!container) return;
  if (!ownedContainer(container, projectId)) throw new Error(`Từ chối xóa container không thuộc preview-manager: ${id}`);
  try { await docker('DELETE', `/containers/${encodeURIComponent(id)}?force=true`); } catch { /* Already removed. */ }
}

async function inspectVolume(name) {
  try { return (await docker('GET', `/volumes/${encodeURIComponent(name)}`)).data; }
  catch { return null; }
}

async function ensureVolume(name, projectId) {
  const existing = await inspectVolume(name);
  if (existing) {
    const volumeLabels = existing.Labels || {};
    const legacyOwned = volumeLabels['com.enthstudio.preview'] === 'true'
      && volumeLabels['com.enthstudio.managed-by'] === 'preview-manager'
      && !volumeLabels['com.enthstudio.project']
      && name === `enthstudio-data-${projectId}`;
    if (!legacyOwned && (volumeLabels['com.enthstudio.managed-by'] !== 'preview-manager'
      || volumeLabels['com.enthstudio.project'] !== projectId)) {
      throw new Error(`Volume ${name} đã tồn tại nhưng không thuộc project này`);
    }
    return existing;
  }
  return (await docker('POST', '/volumes/create', { Name:name, Labels:{ ...labels, 'com.enthstudio.project':projectId } })).data;
}

function slug(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50); }
function randomPort(used) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = 10000 + Math.floor(Math.random() * 50000);
    if (!used.has(port)) return port;
  }
  throw new Error('Không tìm được port 5 chữ số còn trống');
}

async function loadRegistry() {
  try { return JSON.parse(await readFile(registryFile, 'utf8')); } catch { return { previews:{} }; }
}

async function saveRegistry(registry) {
  registry.updatedAt = new Date().toISOString();
  await writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
}

async function projectFingerprint(projectRoot, manifestRaw) {
  const files = [];
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes:true })) {
      const childRelative = path.join(relative, entry.name);
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) {
        const info = await stat(child);
        files.push(`${childRelative.replaceAll(path.sep, '/')}:${info.size}:${info.mtimeMs}`);
      }
    }
  }
  await visit(projectRoot);
  return createHash('sha256').update(`${manifestRaw}\n${files.sort().join('\n')}`).digest('hex');
}

async function discoverProjects() {
  const found = [];
  for (const entry of await readdir(projectsDir, { withFileTypes:true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const id = slug(entry.name);
    if (!id) continue;
    const manifestPath = path.join(projectsDir, entry.name, 'enthstudio.project.json');
    try {
      const raw = await readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      if (manifest.enabled === false) continue;
      const projectRoot = path.join(projectsDir, entry.name);
      let runtime = 'static';
      try { await stat(path.join(projectRoot, 'Dockerfile')); runtime = 'docker'; } catch { /* Static projects remain supported. */ }
      found.push({ id, dir:entry.name, manifest, runtime, signature:await projectFingerprint(projectRoot, raw) });
    } catch { /* A project becomes previewable only after it has a valid manifest. */ }
  }
  return found;
}

function containerNetworkIp(container) {
  const networks = Object.values(container?.NetworkSettings?.Networks || {});
  return networks.find(network => network?.IPAddress)?.IPAddress || null;
}

async function httpCheck(container, internalPort, pathname, expectEntries = false) {
  const ip = containerNetworkIp(container);
  if (!ip) throw new Error('Docker container chưa có địa chỉ mạng');
  const response = await fetch(`http://${ip}:${internalPort}${pathname}`, { signal:AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`${pathname} trả HTTP ${response.status}`);
  if (!expectEntries) return;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error(`${pathname} không trả JSON`);
  const data = await response.json();
  if (!data || !Array.isArray(data.entries)) throw new Error(`${pathname} không có entries[]`);
}

function validateContainer(container, project, image, internalPort, hostPort, volume) {
  if (!ownedContainer(container, project.id)) throw new Error('Container preview thiếu label ownership');
  if (container.Config?.Image !== image) throw new Error('Container preview chạy sai image');
  const portBinding = container.HostConfig?.PortBindings?.[`${internalPort}/tcp`] || [];
  if (!portBinding.some(binding => String(binding.HostPort) === String(hostPort))) throw new Error('Container preview bind sai port');
  if (project.runtime === 'docker') {
    const mount = (container.Mounts || []).find(item => item.Destination === '/data');
    if (!mount || mount.Name !== volume || mount.RW !== true) throw new Error('Container preview thiếu volume /data đúng project');
    if (container.State?.Health?.Status !== 'healthy') throw new Error('Docker HEALTHCHECK chưa healthy');
  }
}

async function startPreview(project, port) {
  const name = `enthstudio-preview-${project.id}`;
  await removeOwned(name, project.id);
  let image = previewImage;
  let internalPort = 3000;
  let volume = null;
  let hostConfig;
  let exposedPorts;
  let env = ['PORT=3000'];
  if (project.runtime === 'docker') {
    image = `enthstudio-project-${project.id}:${project.signature.slice(0, 16)}`;
    const tar = (await execFileAsync('tar', ['-C', path.join(projectsDir, project.dir), '-cf', '-', '.'], { encoding:'buffer', maxBuffer:50 * 1024 * 1024 })).stdout;
    const build = await dockerBinary('POST', `/build?t=${encodeURIComponent(image)}&pull=false`, tar);
    const buildErrors = build.text.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(item => item?.error);
    if (buildErrors.length) throw new Error(`Build Docker thất bại: ${buildErrors.at(-1).error}`);
    internalPort = Number(project.manifest.containerPort || project.manifest.port || dockerContainerPort);
    if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535) throw new Error('containerPort không hợp lệ');
    volume = `enthstudio-data-${project.id}`;
    await ensureVolume(volume, project.id);
    exposedPorts = { [`${internalPort}/tcp`]:{} };
    env = [`PORT=${internalPort}`, 'DATA_DIR=/data'];
    hostConfig = { Binds:[`${volume}:/data`], PortBindings:{ [`${internalPort}/tcp`]:[{ HostIp:'127.0.0.1', HostPort:String(port) }] }, CapDrop:['ALL'], SecurityOpt:['no-new-privileges:true'], PidsLimit:128, Memory:268435456 };
  } else {
    exposedPorts = { '3000/tcp':{} };
    hostConfig = { VolumesFrom:[`${containerSource}:ro`], PortBindings:{ '3000/tcp':[{ HostIp:'127.0.0.1', HostPort:String(port) }] }, CapDrop:['ALL'], SecurityOpt:['no-new-privileges:true'], PidsLimit:128, Memory:268435456 };
  }
  const body = {
    Image:image,
    ...(project.runtime === 'static' ? { Cmd:['node', '/workspace/.enthstudio/static-server.mjs', `/workspace/projects/${project.dir}`], WorkingDir:`/workspace/projects/${project.dir}` } : {}),
    Env:env,
    Labels:{ ...labels, 'com.enthstudio.project':project.id, 'com.enthstudio.runtime':project.runtime },
    ExposedPorts:exposedPorts,
    HostConfig:hostConfig
  };
  const created = await docker('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
  const id = created.data.Id;
  try {
    await docker('POST', `/containers/${encodeURIComponent(id)}/start`);
    if (project.runtime === 'docker') {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const container = await exists(id);
        if (!container?.State?.Running) throw new Error('Docker project container đã dừng sau khi khởi động');
        const health = container.State.Health?.Status;
        if (health === 'healthy') {
          validateContainer(container, project, image, internalPort, port, volume);
          await httpCheck(container, internalPort, '/');
          if (project.manifest.readinessPath) await httpCheck(container, internalPort, project.manifest.readinessPath, project.manifest.readinessJson === true);
          return { id, image, internalPort, volume, health };
        }
        if (!health) {
          validateContainer(container, project, image, internalPort, port, volume);
          await httpCheck(container, internalPort, '/');
          if (project.manifest.readinessPath) await httpCheck(container, internalPort, project.manifest.readinessPath, project.manifest.readinessJson === true);
          return { id, image, internalPort, volume, health:'none' };
        }
        if (health === 'unhealthy') throw new Error('Docker HEALTHCHECK báo unhealthy');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('Docker HEALTHCHECK chưa healthy sau 45 giây');
    }
    return { id, image, internalPort, volume, health:'none' };
  } catch (error) {
    await removeOwned(id, project.id).catch(() => {});
    throw error;
  }
}

async function sync() {
  const registry = await loadRegistry();
  registry.previews ||= {};
  const projects = await discoverProjects();
  const activeIds = new Set(projects.map(project => project.id));
  for (const [id, preview] of Object.entries(registry.previews)) {
    if (!activeIds.has(id)) {
      await removeOwned(preview.containerId, id).catch(error => console.error(`cleanup ${id}: ${error.message}`));
      delete registry.previews[id];
    }
  }
  const usedPorts = new Set(Object.values(registry.previews).map(preview => Number(preview.port)).filter(Boolean));
  for (const project of projects) {
    const previous = registry.previews[project.id];
    const container = previous?.containerId ? await exists(previous.containerId) : null;
    const healthy = project.runtime !== 'docker' || !container?.State?.Health || container.State.Health.Status === 'healthy';
    if (previous?.signature === project.signature && container?.State?.Running) {
      if (healthy) continue;
      registry.previews[project.id] = { ...previous, status:'starting', health:container.State.Health?.Status || 'starting', updatedAt:new Date().toISOString() };
      continue;
    }
    try {
      await removeOwned(previous?.containerId, project.id);
    } catch (error) {
      registry.previews[project.id] = { id:project.id, name:String(project.manifest.name || project.dir), taskId:project.manifest.taskId ?? null, runtime:project.runtime, status:'failed', error:error.message, signature:project.signature, updatedAt:new Date().toISOString() };
      continue;
    }
    let error = null;
    let started = null;
    let port = previous?.port;
    for (let attempt = 0; attempt < 20 && !started; attempt += 1) {
      if (!port || attempt) port = randomPort(usedPorts);
      try { started = await startPreview(project, port); }
      catch (failure) { error = failure.message; port = null; }
    }
    if (started) {
      usedPorts.add(Number(port));
      registry.previews[project.id] = { id:project.id, name:String(project.manifest.name || project.dir), taskId:project.manifest.taskId ?? null, runtime:project.runtime, image:started.image, containerPort:started.internalPort, volume:started.volume, health:started.health, port:Number(port), url:`http://127.0.0.1:${port}`, status:'running', containerId:started.id, signature:project.signature, updatedAt:new Date().toISOString() };
    } else {
      registry.previews[project.id] = { id:project.id, name:String(project.manifest.name || project.dir), taskId:project.manifest.taskId ?? null, status:'failed', error:error || 'Không khởi động được preview', signature:project.signature, updatedAt:new Date().toISOString() };
    }
  }
  await saveRegistry(registry);
}

await mkdir(projectsDir, { recursive:true });
await mkdir(stateDir, { recursive:true });
await writeFile(serverFile, staticServer);
console.log('enthstudio preview manager ready');
while (true) {
  try { await sync(); } catch (error) { console.error(`preview sync: ${error.message}`); }
  await new Promise(resolve => setTimeout(resolve, 2500));
}
