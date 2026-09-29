import http from 'node:http';
import { spawn } from 'node:child_process';

const port = Number(process.env.RUNTIME_PORT || 3001);
const workspace = '/workspace';
const runTimeoutMs = Math.max(30_000, Number(process.env.RUNTIME_RUN_TIMEOUT_MS || 300_000));
const running = new Map();
let modelCache = null;

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function codex(args, input = '') {
  return new Promise(resolve => {
    const child = spawn('codex', args, { cwd: workspace, env: process.env, stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c.toString());
    child.stderr.on('data', c => stderr += c.toString());
    child.on('error', error => resolve({ code: -1, stdout, stderr: error.message }));
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function discoverModels() {
  if (modelCache && modelCache.expiresAt > Date.now()) return Promise.resolve(modelCache.value);
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd: workspace, env: process.env, stdio: ['pipe','pipe','pipe'] });
    let buffer = '';
    let accountPlan = null;
    let initialized = false;
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) reject(error); else resolve(value);
    };
    const send = message => { try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* process is already closing */ } };
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let position;
      while ((position = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, position).trim();
        buffer = buffer.slice(position + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method === 'account/updated') accountPlan = message.params?.planType || null;
        if (message.id === 1 && message.result && !initialized) {
          initialized = true;
          send({ jsonrpc:'2.0', method:'initialized', params:{} });
          send({ jsonrpc:'2.0', id:2, method:'model/list', params:{ limit:100, includeHidden:false } });
        }
        if (message.id === 2) {
          if (message.error) return finish(new Error(message.error.message || 'Không lấy được model catalog'));
          const value = { models:Array.isArray(message.result?.data) ? message.result.data : [], planType:accountPlan, nextCursor:message.result?.nextCursor ?? null };
          modelCache = { value, expiresAt:Date.now() + 60_000 };
          finish(null, value);
        }
      }
    });
    child.on('error', error => finish(error));
    child.on('close', code => { if (!settled) finish(new Error(`Codex app-server kết thúc với mã ${code}`)); });
    send({ jsonrpc:'2.0', id:1, method:'initialize', params:{ clientInfo:{ name:'enthstudio', title:'enthstudio', version:'0.1.0' }, capabilities:{} } });
    timer = setTimeout(() => finish(new Error('Hết thời gian lấy model catalog')), 10_000);
  });
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 30_000) throw new Error('Request quá dài');
  }
  return JSON.parse(raw || '{}');
}

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/auth/status') {
      const status = await codex(['login','status']);
      return send(res, 200, { loggedIn: status.code === 0 && /ChatGPT/i.test(status.stdout + status.stderr) });
    }
    if (req.method === 'GET' && req.url === '/models') {
      try { return send(res, 200, await discoverModels()); }
      catch (error) { return send(res, 502, { error:error.message }); }
    }
    if (req.method === 'POST' && req.url?.startsWith('/cancel/')) {
      const id = req.url.slice('/cancel/'.length);
      const child = running.get(id);
      if (child) child.kill('SIGTERM');
      return send(res, 200, { cancelled: Boolean(child) });
    }
    if (req.method === 'POST' && req.url === '/run') {
      const input = await readBody(req);
      const { jobId, model, effort, threadId, prompt } = input;
      if (!/^\d+$/.test(String(jobId)) || !/^[a-z0-9.-]{2,80}$/.test(model) || !['low','medium','high','xhigh','max','ultra'].includes(effort) || typeof prompt !== 'string' || prompt.length > 15_000 || (threadId && !/^[a-zA-Z0-9_-]{8,100}$/.test(threadId))) {
        return send(res, 400, { error: 'Thông số chạy không hợp lệ' });
      }
      const base = ['--json','--skip-git-repo-check','--ignore-user-config','--output-schema','/app/config/response.schema.json','-m',model,'-c',`model_reasoning_effort="${effort}"`,'--dangerously-bypass-approvals-and-sandbox'];
      const args = threadId ? ['exec','resume',...base,threadId,'-'] : ['exec',...base,'-C',workspace,'-'];
      const child = spawn('codex', args, { cwd: workspace, env: process.env, stdio: ['pipe','pipe','pipe'] });
      const spawnedAt = Date.now();
      let firstOutput = true;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (running.get(String(jobId)) === child) child.kill('SIGKILL');
        }, 5_000).unref();
      }, runTimeoutMs);
      running.set(String(jobId), child);
      res.writeHead(200, { 'content-type':'application/x-ndjson; charset=utf-8', 'cache-control':'no-store' });
      child.stdin.end(prompt);
      child.stdout.on('data', chunk => {
        if (firstOutput) {
          firstOutput = false;
          res.write(JSON.stringify({ type:'runtime.first_output', elapsed_ms:Date.now() - spawnedAt }) + '\n');
        }
        res.write(chunk);
      });
      let diagnostic = '';
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
      child.on('error', error => { res.write(JSON.stringify({ type:'runtime.error', message:error.message }) + '\n'); });
      child.on('close', code => {
        clearTimeout(timeout);
        running.delete(String(jobId));
        if (timedOut) diagnostic = `Codex runtime timeout sau ${runTimeoutMs}ms`;
        res.write(JSON.stringify({ type:'runtime.exit', code, diagnostic, elapsed_ms:Date.now() - spawnedAt }) + '\n');
        res.end();
      });
      return;
    }
    send(res, 404, { error:'Không tìm thấy' });
  } catch (error) { send(res, 500, { error:error.message }); }
}).listen(port, '0.0.0.0', () => console.log(`Codex runtime listening on ${port}`));
