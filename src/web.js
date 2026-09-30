import http from 'node:http';
import { readFile, readdir, writeFile, mkdir, stat, realpath, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initDb, pool, all, one } from './db.js';
import { DEFAULT_WORKFLOW_POLICY, isSeriousProjectRequest } from './workflow-policy.js';
import { planDecision } from './plan-decision.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const port = Number(process.env.PORT || 3000);
const execFileAsync = promisify(execFile);
const tunnelManagerUrl = process.env.TUNNEL_MANAGER_URL || 'http://tunnel-manager:3002';

// The channel tabs are lightweight views over the shared task conversation.
// Project work starts in #general, so role channels need a projection instead
// of waiting for users to manually duplicate every message into another tab.
const channelProjections = Object.freeze({
  gameplay: "m.agent_id = 'designer'",
  engineering: "m.agent_id IN ('architect', 'developer')",
  'art-ux': "m.agent_id = 'art-ux'",
  qa: "m.agent_id = 'reviewer'",
  decisions: "m.agent_id = 'lead' OR m.vote <> 'none'"
});

function planReport(rows) {
  return rows.map(row => `### ${row.name}\n${String(row.result || 'Chưa có báo cáo').slice(0, 4500)}`).join('\n\n');
}

async function applyPlanDecision(client, { channel, task, text, decision }) {
  const userMessage = (await client.query(
    'INSERT INTO messages(channel_id,task_id,author,body) VALUES($1,$2,$3,$4) RETURNING *',
    [channel, task.id, 'Bạn', text]
  )).rows[0];
  const planJob = (await client.query(
    `SELECT id,depth FROM jobs WHERE task_id=$1 AND workflow_stage='plan_review' AND status='completed' ORDER BY id DESC LIMIT 1`,
    [task.id]
  )).rows[0];
  if (!planJob) throw new Error('Chưa có plan hoàn tất để review');
  const reports = (await client.query(
    `SELECT a.name,j.result FROM jobs j JOIN agents a ON a.id=j.agent_id
     WHERE j.task_id=$1 AND j.workflow_stage IN ('design','plan_review') AND j.status='completed' ORDER BY j.id`,
    [task.id]
  )).rows;
  const original = (await client.query(
    `SELECT prompt FROM jobs WHERE task_id=$1 AND parent_job_id IS NULL ORDER BY id LIMIT 1`,
    [task.id]
  )).rows[0]?.prompt || task.title;
  if (decision === 'approve') {
    const developer = await client.query("SELECT id FROM agents WHERE id='developer' AND enabled=true");
    if (!developer.rowCount) throw new Error('Developer đang tạm ngưng');
    const prompt = `Triển khai dự án theo kế hoạch đã được người dùng duyệt.\n\nYêu cầu gốc: ${original}\n\nKế hoạch và các ý kiến độc lập:\n${planReport(reports)}\n\nHợp nhất các quyết định, chỉ chọn giải pháp có lý do và ghi rõ phần không áp dụng. Tạo hoặc sửa project trong workspace, nếu là web project thì giữ manifest enthstudio.project.json có taskId ${task.id}; chạy kiểm tra phù hợp và báo cáo file đã đổi cùng bằng chứng.`;
    await client.query(`INSERT INTO jobs(task_id,channel_id,agent_id,prompt,depth,parent_job_id,return_chain,handoff_count,workflow_stage)
      VALUES($1,$2,'developer',$3,$4,$5,'[]'::jsonb,0,'implementation')`, [task.id, channel, prompt, Number(planJob.depth || 0) + 1, planJob.id]);
    await client.query("UPDATE tasks SET status='queued',plan_status='approved',updated_at=now() WHERE id=$1", [task.id]);
    await client.query(`INSERT INTO messages(channel_id,task_id,author,kind,body) VALUES($1,$2,'enthstudio','system',$3)`,
      [channel, task.id, 'Bạn đã duyệt plan; giao Developer triển khai.']);
  } else {
    const lead = await client.query("SELECT id FROM agents WHERE id='lead' AND enabled=true");
    if (!lead.rowCount) throw new Error('Lead đang tạm ngưng');
    const prompt = `Người dùng yêu cầu sửa plan trước khi triển khai.\n\nYêu cầu gốc: ${original}\n\nPlan và các ý kiến hiện tại:\n${planReport(reports)}\n\nPhản hồi của người dùng:\n${text}\n\nCập nhật plan cụ thể, chỉ rõ thay đổi, lý do, trade-off và tiêu chí nghiệm thu. Không giao Developer; kết thúc bằng plan mới chờ người dùng review lại.`;
    await client.query(`INSERT INTO jobs(task_id,channel_id,agent_id,prompt,depth,parent_job_id,return_chain,handoff_count,workflow_stage)
      VALUES($1,$2,'lead',$3,$4,$5,'[]'::jsonb,0,'plan_review')`, [task.id, channel, prompt, Number(planJob.depth || 0) + 1, planJob.id]);
    await client.query("UPDATE tasks SET status='queued',plan_status='planning',updated_at=now() WHERE id=$1", [task.id]);
    await client.query(`INSERT INTO messages(channel_id,task_id,author,kind,body) VALUES($1,$2,'enthstudio','system',$3)`,
      [channel, task.id, 'Đã nhận yêu cầu sửa plan; Lead sẽ cập nhật kế hoạch trước khi triển khai.']);
  }
  return userMessage;
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('Tin nhắn quá dài');
  }
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('JSON không hợp lệ'); }
}

async function tunnelRequest(pathname, options = {}) {
  const response = await fetch(`${tunnelManagerUrl}${pathname}`, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Tunnel manager không phản hồi hợp lệ');
  return data;
}

function normalizedTunnelText(text) {
  return String(text || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\bnunnel\b/g, 'tunnel')
    .replace(/\bfoward\b/g, 'forward')
    .replace(/\s+/g, ' ')
    .trim();
}

function isQuickTunnelCommand(text, taskId = null) {
  const normalized = normalizedTunnelText(text);
  const tunnelIntent = /(?:quick\s*tunnel|port\s*forward(?:ing)?|cloudflare\s+tunnel)/i.test(normalized);
  const addressedToLead = /@lead\b/i.test(normalized);
  return tunnelIntent && (addressedToLead || Boolean(taskId));
}

async function previewRecords() {
  try { return Object.values(JSON.parse(await readFile('/workspace/.enthstudio/previews.json', 'utf8')).previews || {}); }
  catch { return []; }
}

async function resolveTunnelProject(text, taskId) {
  const previews = (await previewRecords()).filter(preview => preview.status === 'running' && preview.port);
  if (!previews.length) throw new Error('Chưa có Docker preview đang chạy để tạo Quick Tunnel');
  const taskMatch = String(text).match(/task\s*#?\s*(\d+)/i);
  const requestedTaskId = taskId || taskMatch?.[1];
  if (requestedTaskId) {
    const match = previews.find(preview => String(preview.taskId) === String(requestedTaskId));
    if (match) return match;
  }
  const query = String(text).toLowerCase();
  const match = previews.find(preview => {
    const id = String(preview.id || '').toLowerCase();
    const name = String(preview.name || '').toLowerCase();
    return (id && query.includes(id)) || (name && query.includes(name));
  });
  if (match) return match;
  if (previews.length === 1) return previews[0];
  throw new Error(`Có ${previews.length} preview đang chạy; hãy nêu rõ tên project hoặc task #.`);
}

async function handleQuickTunnelCommand(channel, text, taskId) {
  const preview = await resolveTunnelProject(text, taskId);
  const client = await pool.connect();
  let task;
  let userMessage;
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT id FROM channels WHERE id=$1', [channel]);
    if (!exists.rowCount) throw new Error('Kênh không tồn tại');
    const existingTask = taskId
      ? (await client.query('SELECT * FROM tasks WHERE id=$1 AND channel_id=$2 FOR UPDATE', [taskId, channel])).rows[0]
      : null;
    if (taskId && !existingTask) throw new Error('Task không tồn tại trong kênh này');
    task = existingTask || (await client.query('INSERT INTO tasks(title,channel_id,status) VALUES($1,$2,\'running\') RETURNING *', [text.slice(0, 100), channel])).rows[0];
    userMessage = (await client.query('INSERT INTO messages(channel_id,task_id,author,body) VALUES($1,$2,$3,$4) RETURNING *', [channel, task.id, 'Bạn', text])).rows[0];
    await client.query("UPDATE tasks SET status='running',updated_at=now() WHERE id=$1", [task.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }

  try {
    const result = await tunnelRequest('/tunnels', { method: 'POST', body: JSON.stringify({ projectId: preview.id }) });
    const tunnel = result.tunnel;
    const reply = `Đã tạo Cloudflare Quick Tunnel cho **${preview.name}**.\n\n- URL public: ${tunnel.url}\n- Preview: ${preview.url}\n- Port local: ${preview.port}\n\nQuick Tunnel không cần đăng nhập Cloudflare và chỉ tồn tại khi tunnel đang chạy.`;
    await pool.query(`INSERT INTO messages(channel_id,task_id,agent_id,author,kind,body,vote)
      VALUES($1,$2,'lead','Lead','agent',$3,'approve')`, [channel, task.id, reply]);
    const completed = (await pool.query("UPDATE tasks SET status='completed',updated_at=now() WHERE id=$1 RETURNING *", [task.id])).rows[0];
    return { userMessage, task: completed, tunnel };
  } catch (error) {
    const detail = `Không tạo được Cloudflare Quick Tunnel cho ${preview.name}: ${error.message}`;
    await pool.query(`INSERT INTO messages(channel_id,task_id,author,kind,body)
      VALUES($1,$2,'enthstudio','system',$3)`, [channel, task.id, detail]);
    const failed = (await pool.query("UPDATE tasks SET status='failed',updated_at=now() WHERE id=$1 RETURNING *", [task.id])).rows[0];
    const failure = new Error(detail);
    failure.task = failed;
    throw failure;
  }
}

function firstMention(text) {
  const match = text.match(/@(?:lead|designer|architect|developer|reviewer|art-ux)\b/i);
  return match ? match[0].slice(1).toLowerCase() : 'lead';
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/models') {
    try {
      const row = await one("SELECT value,updated_at FROM runtime_status WHERE key='model_catalog'");
      if (!row) return json(res, 503, { error:'Model catalog chưa sẵn sàng; runtime đang đồng bộ subscription.' });
      return json(res, 200, { ...JSON.parse(row.value), updatedAt:row.updated_at });
    } catch (error) {
      return json(res, 502, { error:`Model catalog không hợp lệ: ${error.message}` });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    const row = await one("SELECT value,updated_at FROM settings WHERE key='cloudflare_tunnel_token'");
    return json(res, 200, {
      settings: { cloudflareTunnelTokenConfigured: Boolean(row?.value) },
      quickTunnelRequiresLogin: false,
      updatedAt: row?.updated_at || null
    });
  }
  if (req.method === 'PUT' && url.pathname === '/api/settings') {
    const input = await bodyJson(req);
    const token = String(input.cloudflareTunnelToken || '').trim();
    if (token.length > 2_000) return json(res, 400, { error: 'Cloudflare token quá dài' });
    await pool.query(`INSERT INTO settings(key,value,updated_at) VALUES('cloudflare_tunnel_token',$1,now())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [token]);
    return json(res, 200, { saved: true, configured: Boolean(token) });
  }
  if (req.method === 'GET' && url.pathname === '/api/artifacts') {
    const relative = url.searchParams.get('path');
    if (relative) {
      if (relative.startsWith('/') || relative.includes('..') || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(p => p === '.git' || p === 'node_modules' || p.startsWith('.env') || p === 'auth.json')) return json(res, 400, { error:'Đường dẫn không hợp lệ' });
      const file = path.resolve('/workspace', relative);
      if (!file.startsWith('/workspace/')) return json(res, 400, { error:'Đường dẫn không hợp lệ' });
      const resolved = await realpath(file).catch(() => null);
      if (!resolved?.startsWith('/workspace/')) return json(res, 400, { error:'Đường dẫn không hợp lệ' });
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) return json(res, 404, { error:'Không tìm thấy file' });
      const extension = path.extname(file).toLowerCase();
      const textTypes = new Set(['.md','.txt','.js','.ts','.tsx','.jsx','.json','.html','.css','.scss','.py','.cs','.cpp','.h','.hpp','.c','.toml','.yaml','.yml','.xml','.shader','.gd','.lua','.sql']);
      if (!textTypes.has(extension) || info.size > 300_000) return json(res, 200, { path:relative, size:info.size, content:null });
      return json(res, 200, { path:relative, size:info.size, content:await readFile(file, 'utf8') });
    }
    const files = [];
    async function walk(dir, depth) {
      if (depth > 6 || files.length >= 500) return;
      for (const entry of await readdir(dir, { withFileTypes:true }).catch(() => [])) {
        if (files.length >= 500) break;
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.env') || entry.name === '.codex') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile()) files.push(path.relative('/workspace', full).replaceAll('\\','/'));
      }
    }
    await walk('/workspace', 0);
    return json(res, 200, { files });
  }
  if (req.method === 'GET' && url.pathname === '/api/diff') {
    try {
      const { stdout } = await execFileAsync('git', ['-C','/workspace','diff','--no-ext-diff'], { timeout:5000, maxBuffer:300_000 });
      return json(res, 200, { diff:stdout || '' });
    } catch (error) {
      return json(res, 200, { diff:'', unavailable:String(error.stderr || '').includes('Not a git repository') ? 'Workspace chưa là Git repository.' : 'Không đọc được diff.' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/git') {
    const git = async args => (await execFileAsync('git', ['-C', '/workspace', ...args], { timeout:5000, maxBuffer:300_000 })).stdout.trim();
    try {
      await git(['rev-parse', '--is-inside-work-tree']);
    } catch {
      return json(res, 200, { repository:false, message:'Workspace chưa là Git repository.' });
    }
    const optional = async args => git(args).catch(() => '');
    const [branch, remote, status, diff, stagedDiff, commits] = await Promise.all([
      optional(['branch', '--show-current']),
      optional(['remote', 'get-url', 'origin']),
      optional(['status', '--short']),
      optional(['diff', '--no-ext-diff']),
      optional(['diff', '--cached', '--no-ext-diff']),
      optional(['log', '-5', '--date=short', '--format=%h%x1f%s%x1f%an%x1f%ad'])
    ]);
    return json(res, 200, {
      repository:true, branch:branch || 'HEAD (detached)', remote:remote || null, status, diff, stagedDiff,
      commits:commits ? commits.split('\n').map(line => { const [hash, subject, author, date] = line.split('\x1f'); return { hash, subject, author, date }; }) : []
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/previews') {
    try {
      const registry = JSON.parse(await readFile('/workspace/.enthstudio/previews.json', 'utf8'));
      const previews = Object.values(registry.previews || {}).map(({ id, name, port, url, status, error, updatedAt }) => ({ id, name, port, url, status, error, updatedAt }));
      return json(res, 200, { previews });
    } catch { return json(res, 200, { previews:[] }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/tunnels') {
    try { return json(res, 200, await tunnelRequest('/tunnels')); }
    catch (error) { return json(res, 503, { error: `Tunnel manager chưa sẵn sàng: ${error.message}` }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/tunnels') {
    const input = await bodyJson(req);
    const projectId = String(input.projectId || '').trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId) || projectId.length > 50) return json(res, 400, { error: 'Project ID không hợp lệ' });
    try { return json(res, 200, await tunnelRequest('/tunnels', { method: 'POST', body: JSON.stringify({ projectId }) })); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (req.method === 'DELETE' && /^\/api\/tunnels\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(url.pathname)) {
    const projectId = url.pathname.slice('/api/tunnels/'.length);
    try { return json(res, 200, await tunnelRequest(`/tunnels/${encodeURIComponent(projectId)}`, { method: 'DELETE' })); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (url.pathname === '/api/documents') {
    const relative = url.searchParams.get('path');
    if (!relative && req.method === 'GET') {
      const files = [];
      for (const dir of ['docs', 'agent_memories']) {
        const root = path.join('/workspace', dir);
        async function walk(current) {
          for (const item of await readdir(current, { withFileTypes: true }).catch(() => [])) {
            const full = path.join(current, item.name);
            if (item.isDirectory()) await walk(full);
            else if (item.isFile() && item.name.endsWith('.md')) files.push(path.relative('/workspace', full).replaceAll('\\', '/'));
          }
        }
        await walk(root);
      }
      return json(res, 200, { files });
    }
    if (!relative || !/^(?:docs\/[a-zA-Z0-9_-]+\.md|agent_memories\/(?:global|task-\d+)\/(?:SUMMARY\.md|(?:lead|designer|architect|developer|reviewer|art-ux)\.md))$/.test(relative)) return json(res, 400, { error: 'Đường dẫn không hợp lệ' });
    const file = path.join('/workspace', relative);
    const parent = await realpath(path.dirname(file)).catch(() => null);
    if (parent && !parent.startsWith('/workspace/')) return json(res, 400, { error:'Đường dẫn không hợp lệ' });
    if ((await lstat(file).catch(() => null))?.isSymbolicLink()) return json(res, 400, { error:'Đường dẫn không hợp lệ' });
    if (req.method === 'GET') {
      try { return json(res, 200, { path: relative, content: await readFile(file, 'utf8') }); }
      catch { return json(res, 404, { error: 'Không tìm thấy tài liệu' }); }
    }
    if (req.method === 'PUT') {
      const input = await bodyJson(req);
      const content = String(input.content || '');
      if (content.length > 100_000) return json(res, 400, { error: 'Tài liệu quá dài' });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      return json(res, 200, { path: relative, saved: true });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    const [channels, agents, tasks, status, workflow] = await Promise.all([
      all('SELECT * FROM channels ORDER BY CASE id WHEN \'general\' THEN 0 WHEN \'decisions\' THEN 5 ELSE 1 END, name'),
      all('SELECT * FROM agents ORDER BY CASE id WHEN \'lead\' THEN 0 ELSE 1 END, id'),
      all(`SELECT t.*, a.name AS current_agent FROM tasks t LEFT JOIN LATERAL
        (SELECT agents.name FROM jobs JOIN agents ON agents.id=jobs.agent_id WHERE jobs.task_id=t.id ORDER BY jobs.id DESC LIMIT 1) a ON true
        ORDER BY t.id DESC LIMIT 60`),
      one("SELECT value,updated_at FROM runtime_status WHERE key='codex_auth'"),
      one("SELECT value,updated_at FROM settings WHERE key='workflow_policy'")
    ]);
    let workflowPolicy = DEFAULT_WORKFLOW_POLICY;
    try {
      if (workflow?.value) workflowPolicy = { ...DEFAULT_WORKFLOW_POLICY, ...JSON.parse(workflow.value) };
      if (!Array.isArray(workflowPolicy.sequence) || !workflowPolicy.sequence.includes('plan_review')) workflowPolicy = { ...workflowPolicy, sequence: [...DEFAULT_WORKFLOW_POLICY.sequence] };
      if (workflowPolicy.requireUserPlanApproval !== true) workflowPolicy = { ...workflowPolicy, requireUserPlanApproval: true };
    } catch { /* Use the source default if a legacy value is malformed. */ }
    return json(res, 200, { channels, agents, tasks, auth: status || { value: 'unknown' }, workflowPolicy });
  }
  if (req.method === 'GET' && url.pathname === '/api/messages') {
    const channel = url.searchParams.get('channel') || 'general';
    const after = Number(url.searchParams.get('after') || 0);
    const taskId = url.searchParams.get('task');
    if (!/^[a-z-]+$/.test(channel) || !Number.isSafeInteger(after) || after < 0) return json(res, 400, { error: 'Tham số không hợp lệ' });
    if (taskId && !/^\d+$/.test(taskId)) return json(res, 400, { error: 'Task ID không hợp lệ' });
    const rows = taskId
      ? await all('SELECT * FROM messages WHERE task_id=$1 AND id>$2 ORDER BY id DESC LIMIT 200', [taskId, after])
      : await all(
        channelProjections[channel]
          ? `SELECT m.* FROM messages m WHERE (m.channel_id=$1 OR ${channelProjections[channel]}) AND m.id>$2 ORDER BY m.id DESC LIMIT 200`
          : 'SELECT * FROM messages WHERE channel_id=$1 AND id>$2 ORDER BY id DESC LIMIT 200',
        [channel, after]
      );
    rows.reverse();
    return json(res, 200, { messages: rows });
  }
  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    const jobs = await all(`SELECT j.*, a.name AS agent_name FROM jobs j JOIN agents a ON a.id=j.agent_id ORDER BY j.id DESC LIMIT 80`);
    return json(res, 200, { jobs });
  }
  if (req.method === 'POST' && url.pathname === '/api/messages') {
    const input = await bodyJson(req);
    const channel = String(input.channel || 'general');
    const text = String(input.body || '').trim();
    const taskId = input.taskId ? String(input.taskId) : null;
    const planChoice = planDecision(text);
    const taskHint = taskId || text.match(/\btask\s*#?\s*(\d+)\b/i)?.[1] || null;
    if (!text || text.length > 10_000) return json(res, 400, { error: 'Nội dung phải có từ 1 đến 10.000 ký tự' });
    if (taskId && !/^\d+$/.test(taskId)) return json(res, 400, { error: 'Task ID không hợp lệ' });
    if (isQuickTunnelCommand(text, taskId)) {
      try {
        return json(res, 201, await handleQuickTunnelCommand(channel, text, taskId));
      } catch (error) {
        return json(res, 400, { error: error.message, task: error.task || null });
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query('SELECT id FROM channels WHERE id=$1', [channel]);
      if (!exists.rowCount) throw new Error('Kênh không tồn tại');
      // Tasks opened through a role projection still belong to their original
      // channel. Resolve by ID and use the task's canonical channel below.
      let existingTask = taskId ? (await client.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [taskId])).rows[0] : null;
      if (!existingTask && planChoice) {
        const candidates = taskHint
          ? (await client.query("SELECT * FROM tasks WHERE id=$1 AND plan_status='awaiting_review' FOR UPDATE", [taskHint])).rows
          : (await client.query("SELECT * FROM tasks WHERE plan_status='awaiting_review' ORDER BY updated_at DESC FOR UPDATE")).rows;
        if (candidates.length > 1) throw new Error('Có nhiều task đang chờ duyệt plan; hãy nêu rõ task #.');
        existingTask = candidates[0] || null;
      }
      if (taskId && !existingTask) throw new Error('Task không tồn tại');
      const decision = existingTask ? planChoice : null;
      if (planChoice && !existingTask) throw new Error('Không tìm thấy task đang chờ duyệt plan; hãy nêu rõ task #.');
      if (decision && existingTask.plan_status !== 'awaiting_review') throw new Error('Task hiện không ở bước chờ duyệt plan');
      if (existingTask?.plan_status === 'awaiting_review') {
        if (decision) {
          const message = await applyPlanDecision(client, { channel: existingTask.channel_id || channel, task: existingTask, text, decision });
          await client.query('COMMIT');
          return json(res, 201, { message, task: { ...existingTask, status: decision === 'approve' ? 'queued' : 'queued', plan_status: decision === 'approve' ? 'approved' : 'planning' } });
        }
        const message = (await client.query(
          'INSERT INTO messages(channel_id,task_id,author,body) VALUES($1,$2,$3,$4) RETURNING *',
          [existingTask.channel_id || channel, existingTask.id, 'Bạn', text]
        )).rows[0];
        await client.query(`INSERT INTO messages(channel_id,task_id,author,kind,body) VALUES($1,$2,'enthstudio','system',$3)`,
          [existingTask.channel_id || channel, existingTask.id, 'Task đang chờ bạn review plan. Gửi \`@lead duyệt plan\` để triển khai hoặc \`@lead sửa plan: ...\` để yêu cầu chỉnh sửa.']);
        await client.query('UPDATE tasks SET updated_at=now() WHERE id=$1', [existingTask.id]);
        await client.query('COMMIT');
        return json(res, 201, { message, task: existingTask, awaitingPlanReview: true });
      }
      const requestedAgent = firstMention(text);
      const seriousProject = isSeriousProjectRequest(text, { existingTask: Boolean(existingTask) });
      const lastAgent = existingTask && !/@(?:lead|designer|architect|developer|reviewer|art-ux)\b/i.test(text)
        ? (await client.query('SELECT agent_id FROM jobs WHERE task_id=$1 ORDER BY id DESC LIMIT 1', [taskId])).rows[0]?.agent_id : null;
      const agent = seriousProject ? 'lead' : (lastAgent || requestedAgent);
      const active = await client.query('SELECT id FROM agents WHERE id=$1 AND enabled=true', [agent]);
      if (!active.rowCount) throw new Error('Agent đang tạm ngưng');
      const task = existingTask || (await client.query('INSERT INTO tasks(title,channel_id,plan_status) VALUES($1,$2,$3) RETURNING *', [text.slice(0, 100), channel, seriousProject ? 'planning' : 'not_required'])).rows[0];
      const message = (await client.query('INSERT INTO messages(channel_id,task_id,author,body) VALUES($1,$2,$3,$4) RETURNING *', [channel, task.id, 'Bạn', text])).rows[0];
      const prompt = seriousProject && requestedAgent !== 'lead'
        ? `${text}\n\n[System] Đây là project work nên phải mở serious pipeline. @${requestedAgent} là góc nhìn người dùng yêu cầu; Lead vẫn phải gọi Designer, Architect và Art / UX độc lập trước Developer.`
        : text;
      await client.query('INSERT INTO jobs(task_id,channel_id,agent_id,prompt) VALUES($1,$2,$3,$4)', [task.id, channel, agent, prompt]);
      if (existingTask) await client.query("UPDATE tasks SET status='queued',updated_at=now() WHERE id=$1", [task.id]);
      await client.query('COMMIT');
      return json(res, 201, { message, task });
    } catch (error) {
      await client.query('ROLLBACK');
      return json(res, 400, { error: error.message });
    } finally { client.release(); }
  }
  if (req.method === 'PATCH' && /^\/api\/agents\/[a-z-]+$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    const input = await bodyJson(req);
    const model = String(input.model || '').trim();
    const effort = String(input.effort || '').trim();
    if (!/^[a-z0-9.-]{2,80}$/.test(model) || !['low','medium','high','xhigh','max','ultra'].includes(effort)) return json(res, 400, { error: 'Model hoặc effort không hợp lệ' });
    const row = await one('UPDATE agents SET model=$1, effort=$2, enabled=$3 WHERE id=$4 RETURNING *', [model, effort, Boolean(input.enabled), id]);
    return row ? json(res, 200, { agent: row }) : json(res, 404, { error: 'Không tìm thấy agent' });
  }
  if (req.method === 'POST' && /^\/api\/jobs\/\d+\/cancel$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3];
    const row = await one("UPDATE jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END WHERE id=$1 AND status IN ('queued','running') RETURNING *", [id]);
    if (row?.status === 'cancelled') await pool.query("UPDATE tasks SET status='cancelled',updated_at=now() WHERE id=$1", [row.task_id]);
    return row ? json(res, 200, { job: row }) : json(res, 409, { error: 'Không thể dừng tác vụ này' });
  }
  if (req.method === 'POST' && /^\/api\/jobs\/\d+\/retry$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3];
    const row = await one("UPDATE jobs SET status='queued',error=NULL,started_at=NULL,finished_at=NULL WHERE id=$1 AND status IN ('rate_limited','failed','interrupted','cancelled') RETURNING *", [id]);
    if (row) await pool.query("UPDATE tasks SET status='queued',updated_at=now() WHERE id=$1", [row.task_id]);
    return row ? json(res, 200, { job: row }) : json(res, 409, { error: 'Không thể chạy lại tác vụ này' });
  }
  return json(res, 404, { error: 'Không tìm thấy' });
}

async function staticFile(req, res, url) {
  const safe = path.normalize(url.pathname).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '');
  const target = path.join(publicDir, safe === '' ? 'index.html' : safe);
  if (!target.startsWith(publicDir)) return json(res, 403, { error: 'Bị từ chối' });
  try {
    const data = await readFile(target);
    const ext = path.extname(target);
    const contentType = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml', '.ico':'image/x-icon' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store' });
    res.end(data);
  } catch { json(res, 404, { error: 'Không tìm thấy' }); }
}

await initDb();
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return json(res, 405, { error: 'Method không hợp lệ' });
    return await staticFile(req, res, url);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: 'Lỗi máy chủ' });
  }
}).listen(port, '0.0.0.0', () => console.log(`enthstudio listening on ${port}`));
