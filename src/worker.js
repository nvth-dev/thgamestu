import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initDb, pool, all, one } from './db.js';
import { planNext } from './handoff.js';
import { DEFAULT_WORKFLOW_POLICY, DESIGN_ROLES, isSeriousProjectRequest } from './workflow-policy.js';

const workspace = '/workspace';
const runtimeUrl = process.env.RUNTIME_URL || 'http://runtime:3001';
const maxActive = Math.max(1, Math.min(4, Number(process.env.MAX_ACTIVE_RUNS || 1)));
const active = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const designRoles = DESIGN_ROLES;
const roleInstructions = {
  lead: 'Bạn là Lead của enthstudio. Chia việc rõ, gọi đúng chuyên môn, kết luận ngắn. Với mọi yêu cầu tạo, sửa, refactor hoặc hardening project có tác động đến code, dữ liệu, UX hoặc bảo mật, bắt buộc đi theo pipeline Designer + Architect + Art / UX → Developer → Reviewer / QA → Lead; không giao thẳng Developer. Mỗi role phải để lại một quyết định hoặc kiểm tra cụ thể, tránh báo cáo hình thức và không giả vờ trao đổi. Với yêu cầu có tài khoản, tên người dùng, leaderboard hoặc điểm số, bắt buộc yêu cầu Architect và Reviewer kiểm tra chống trùng định danh, chống tin dữ liệu client và các đường sửa điểm. Không tự chốt khi chưa có báo cáo độc lập của các role. Với nhiệm vụ tạo web project, chỉ chốt khi Developer đã hoàn tất, Docker preview đang running và bạn có thể nêu báo cáo bàn giao gồm tên project, đường dẫn, URL/port, trạng thái Docker, file chính và kiểm tra đã thực hiện.',
  designer: 'Bạn là Game Designer. Thiết kế gameplay cụ thể, nêu tiêu chí có thể kiểm chứng. Với username/leaderboard, chốt quy tắc chuẩn hóa, duy nhất và hành vi khi trùng tên; với score, nêu nguồn dữ liệu và tiêu chí hợp lệ. Chỉ nhờ agent khác khi cần triển khai hoặc review. Nếu môi trường role không truy cập được Docker/browser, đọc runtime-verification.md do supervisor ghi và phân biệt rõ bằng chứng gián tiếp với phần cần kiểm tra trực tiếp; không request changes chỉ vì thiếu công cụ khi artifact hiện tại đủ trường và khớp metadata.',
  architect: 'Bạn là Architect. Đề xuất cấu trúc kỹ thuật gọn, đánh giá threat model, chống sửa điểm và chống trùng username ở nguồn dữ liệu có thẩm quyền; không coi localStorage hay input client là đáng tin. Nếu static-only không đủ an toàn, nêu runtime tối thiểu có thể chạy trong Docker. Giao Developer khi đặc tả đã đủ rõ.',
  developer: 'Bạn là Developer. Thực hiện trong workspace, kiểm tra thích hợp, báo file đã đổi và kết quả. Không tin username, score hoặc leaderboard do client gửi; mọi ràng buộc bảo mật phải được kiểm tra ở nguồn có thẩm quyền hoặc nêu rõ giới hạn. Với web game cần chạy được, tạo trong projects/<slug>/ gồm index.html và enthstudio.project.json hợp lệ (ít nhất {"name":"Tên project"}) để preview manager chạy trong Docker. Không tự phê duyệt sản phẩm của mình.',
  reviewer: 'Bạn là Reviewer / QA. Kiểm tra độc lập, nêu lỗi có bằng chứng. Bắt buộc thử username trùng khác hoa thường/khoảng trắng, payload điểm âm/rất lớn/được sửa sau khi kết thúc và các đường gọi API trực tiếp. Nếu không thấy vấn đề, vote approve; nếu thiếu thông tin, abstain. Khi runtime agent không có Docker hoặc browser, phải đọc artifact kiểm chứng supervisor tại `.enthstudio/runtime-verification.md` nếu có; coi đây là bằng chứng môi trường được ghi bằng lệnh host, nêu rõ phần nào là kiểm chứng gián tiếp, không tự nhận đã chạy Docker/browser. Artifact chỉ được dùng cho gate nếu có timestamp, image/container/port/health, HTTP UI+API, test trong image và persistence; thiếu trường nào thì tiếp tục abstain.',
  'art-ux': 'Bạn là Art / UX. Thiết kế luồng và giao diện rõ ràng, gắn với nhu cầu người chơi. Đặc biệt thiết kế thông báo trùng username, trạng thái lưu điểm và lỗi mạng mà không làm người chơi mất lượt. Chỉ giao Developer khi có đầu ra đủ cụ thể. Nếu browser adapter không có, đọc runtime-verification.md: artifact supervisor có timestamp, snapshot/accessibility, flow, console và giới hạn viewport được xem là bằng chứng runtime gián tiếp; nêu giới hạn đó nhưng không request changes lặp lại chỉ vì không thể mở browser trực tiếp.'
};

async function setAuth() {
  let value = 'runtime-unavailable';
  try {
    const response = await fetch(`${runtimeUrl}/auth/status`);
    const result = await response.json();
    value = result.loggedIn ? 'chatgpt' : 'login-required';
  } catch { /* The runtime may be starting or restarting. */ }
  await pool.query(`INSERT INTO runtime_status(key,value) VALUES('codex_auth',$1)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [value]);
  return value === 'chatgpt';
}

async function syncModelCatalog() {
  try {
    const response = await fetch(`${runtimeUrl}/models`);
    if (!response.ok) return;
    const catalog = await response.json();
    await pool.query(`INSERT INTO runtime_status(key,value) VALUES('model_catalog',$1)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [JSON.stringify(catalog)]);
  } catch { /* Catalog becomes available on the next refresh after runtime starts. */ }
}

async function initWorkspace() {
  const memoryRoot = path.join(workspace, 'agent_memories');
  const globalMemoryRoot = path.join(memoryRoot, 'global');
  await mkdir(globalMemoryRoot, { recursive: true });
  await migrateLegacyMemories(memoryRoot, globalMemoryRoot);
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  for (const id of Object.keys(roleInstructions)) {
    const file = path.join(globalMemoryRoot, `${id}.md`);
    try { await readFile(file); } catch { await writeFile(file, `# ${id}\n\nGhi lại kiến thức bền vững và quyết định đã được xác nhận.\n`); }
  }
  const vision = path.join(workspace, 'docs', 'game-vision.md');
  try { await readFile(vision); } catch { await writeFile(vision, '# Tầm nhìn game\n\nChưa được xác định.\n'); }
}

async function migrateLegacyMemories(memoryRoot, globalMemoryRoot) {
  const legacyGlobal = path.join(workspace, 'agents');
  for (const entry of await readdir(legacyGlobal, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !roleInstructions[entry.name]) continue;
    const source = path.join(legacyGlobal, entry.name, 'MEMORY.md');
    const target = path.join(globalMemoryRoot, `${entry.name}.md`);
    try { await readFile(target); } catch {
      const content = await readFile(source, 'utf8').catch(() => '');
      if (content) await writeFile(target, content);
    }
  }
  const legacyTasks = path.join(workspace, 'tasks');
  for (const entry of await readdir(legacyTasks, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const targetRoot = path.join(memoryRoot, `task-${entry.name}`);
    await mkdir(targetRoot, { recursive: true });
    const summary = path.join(entry.name, 'SUMMARY.md');
    const oldSummary = path.join(legacyTasks, summary);
    const newSummary = path.join(targetRoot, 'SUMMARY.md');
    try { await readFile(newSummary); } catch {
      const content = await readFile(oldSummary, 'utf8').catch(() => '');
      if (content) await writeFile(newSummary, content);
    }
    const oldAgents = path.join(legacyTasks, entry.name, 'agents');
    for (const role of Object.keys(roleInstructions)) {
      const source = path.join(oldAgents, role, 'MEMORY.md');
      const target = path.join(targetRoot, `${role}.md`);
      try { await readFile(target); } catch {
        const content = await readFile(source, 'utf8').catch(() => '');
        if (content) await writeFile(target, content);
      }
    }
  }
}

function previewId(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50); }

async function taskProjects(taskId) {
  let registry = { previews:{} };
  try { registry = JSON.parse(await readFile(path.join(workspace, '.enthstudio', 'previews.json'), 'utf8')); } catch { /* Preview manager may not have written its registry yet. */ }
  const records = registry.previews || {};
  const projects = [];
  const root = path.join(workspace, 'projects');
  for (const entry of await readdir(root, { withFileTypes:true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(path.join(root, entry.name, 'enthstudio.project.json'), 'utf8'));
      if (String(manifest.taskId) !== String(taskId)) continue;
      const id = previewId(entry.name);
      const runtime = records[id] || {};
      const files = (await readdir(path.join(root, entry.name), { withFileTypes:true }))
        .filter(file => file.isFile())
        .map(file => file.name)
        .sort();
      projects.push({ id, name:String(manifest.name || entry.name), path:`projects/${entry.name}`, files, status:runtime.status || 'starting', url:runtime.url || null, port:runtime.port || null, error:runtime.error || null });
    } catch { /* Invalid manifests do not count as a deliverable project. */ }
  }
  return projects;
}

async function waitForTaskPreviews(taskId, timeoutMs = 12_000) {
  const initial = await taskProjects(taskId);
  if (!initial.length) return initial;
  const deadline = Date.now() + timeoutMs;
  let projects = initial;
  while (Date.now() < deadline) {
    projects = await taskProjects(taskId);
    if (projects.every(project => project.status === 'running' || project.status === 'failed')) return projects;
    await sleep(500);
  }
  return projects;
}

function projectRuntimeContext(projects) {
  if (!projects.length) return 'Không có web project gắn với task này.';
  return projects.map(project => `- ${project.name}: ${project.path}; Docker preview ${project.status}${project.url ? `; ${project.url}` : ''}${project.port ? `; port ${project.port}` : ''}${project.error ? `; lỗi: ${project.error}` : ''}`).join('\n');
}

function projectDelivery(projects) {
  const lines = ['**Bàn giao project**'];
  for (const project of projects) {
    lines.push(`- **${project.name}** — \`${project.path}\``);
    lines.push(`  - Docker preview: ${project.status}`);
    if (project.url) lines.push(`  - URL: ${project.url}`);
    if (project.port) lines.push(`  - Port: ${project.port}`);
    if (project.files.length) lines.push(`  - Files: ${project.files.map(file => `\`${file}\``).join(', ')}`);
    lines.push(`  - Kiểm tra runtime: Docker preview ${project.status}`);
    if (project.error) lines.push(`  - Lỗi runtime: ${project.error}`);
  }
  return lines.join('\n');
}

function isProjectPipelineStart(job) {
  return job.agent_id === 'lead' && (job.workflow_stage || 'normal') === 'normal' && Number(job.depth) === 0
    && isSeriousProjectRequest(job.prompt);
}

function workflowReport(rows) {
  return rows.map(row => `### ${row.name}\n${String(row.result || 'Chưa có báo cáo').slice(0, 4500)}`).join('\n\n');
}

function designPrompt(role, originalPrompt, leadReply) {
  const focus = {
    designer: 'Đặc tả mục tiêu người dùng, luồng chính, quy tắc nghiệp vụ, trạng thái, edge case và tiêu chí nghiệm thu. Với game, bao gồm gameplay; với công cụ/API, ghi rõ hành vi và dữ liệu.',
    architect: 'Đề xuất cấu trúc kỹ thuật, dữ liệu, module, cách chạy Docker, threat model, nguồn dữ liệu có thẩm quyền, ranh giới triển khai và trade-off phù hợp với project.',
    'art-ux': 'Đề xuất hướng hình ảnh, UI/UX, layout, feedback tương tác, khả năng tiếp cận và trạng thái lỗi. Nếu project không có UI, ghi rõ phần không áp dụng và rủi ro trải nghiệm tương ứng.'
  }[role];
  return `Chuẩn bị đầu vào bắt buộc cho dự án này với vai trò ${role}.\nYêu cầu gốc: ${originalPrompt}\nTóm tắt từ Lead: ${leadReply}\n\nPhạm vi chuyên môn: ${focus}\nNếu phần việc không áp dụng, phải nói rõ lý do và nêu rủi ro đã kiểm tra; không được tạo ý kiến chung chung. Đưa ra quyết định riêng, giả định, trade-off và tiêu chí kiểm chứng để Developer dùng được. Không tự viết code và không giao tiếp thêm agent.`;
}

async function claimJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT j.* FROM jobs j JOIN agents a ON a.id=j.agent_id
      WHERE j.status='queued' AND a.enabled=true
      AND NOT EXISTS (SELECT 1 FROM jobs other WHERE other.task_id=j.task_id AND other.status IN ('running','cancelling'))
      ORDER BY j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
    const job = rows[0];
    if (!job) { await client.query('COMMIT'); return null; }
    const started = (await client.query(`UPDATE jobs SET status='running',started_at=now(),
      idle_ms=(SELECT ROUND(EXTRACT(EPOCH FROM (now()-MAX(previous.finished_at)))*1000)::bigint
        FROM jobs previous WHERE previous.agent_id=$2 AND previous.finished_at IS NOT NULL AND previous.id<>$1)
      WHERE id=$1 RETURNING *`, [job.id, job.agent_id])).rows[0];
    await client.query("UPDATE tasks SET status='running',updated_at=now() WHERE id=$1", [job.task_id]);
    await client.query('COMMIT');
    return started;
  } catch (error) { console.error(`finishJob ${job.id} failed`, error.stack || error); await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

function parseAnswer(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.reply !== 'string') throw new Error('missing reply');
    const handoff = parsed.handoff && typeof parsed.handoff.agent === 'string' && typeof parsed.handoff.task === 'string'
      ? parsed.handoff : null;
    return { reply: parsed.reply, handoff, vote: parsed.vote || 'none', memory: typeof parsed.memory === 'string' ? parsed.memory.trim() : '' };
  } catch {
    return { reply: text, handoff: null, vote: 'none', memory: '' };
  }
}

async function readCompact(file, maxLength) {
  const content = await readFile(file, 'utf8').catch(() => '');
  return content.length > maxLength ? `${content.slice(0, maxLength)}\n[đã rút gọn]` : content;
}

async function taskMemoryContext(job) {
  const root = path.join(workspace, 'agent_memories', `task-${job.task_id}`);
  const summary = await readCompact(path.join(root, 'SUMMARY.md'), 4_000);
  const role = await readCompact(path.join(root, `${job.agent_id}.md`), 2_000);
  if (!summary && !role) return '';
  return `\n\nTask memory bền vững (không phải toàn bộ lịch sử chat):\n${summary ? `## Tóm tắt task\n${summary}\n` : ''}${role ? `## Ghi chú của ${job.agent_id} trong task này\n${role}` : ''}`;
}

async function appendMemoryEntry(file, marker, heading, content) {
  const existing = await readFile(file, 'utf8').catch(() => '');
  if (existing.includes(marker)) return;
  await mkdir(path.dirname(file), { recursive: true });
  const initial = existing.trimEnd() || heading;
  const entry = `\n\n${marker}\n### ${new Date().toISOString()}\n- ${content}`;
  await writeFile(file, `${initial}${entry}\n`);
}

async function persistAgentMemory(job, answer) {
  const allowed = new Set(['lead', 'designer', 'architect', 'developer', 'reviewer', 'art-ux']);
  if (!allowed.has(job.agent_id)) return;
  const raw = String(answer.memory || answer.reply || '').replace(/\s+/g, ' ').trim();
  if (!raw) return;
  const content = raw.slice(0, 1200);
  const marker = `<!-- enthstudio-job:${job.id} -->`;
  const globalFile = path.join(workspace, 'agent_memories', 'global', `${job.agent_id}.md`);
  const taskRoot = path.join(workspace, 'agent_memories', `task-${job.task_id}`);
  const taskFile = path.join(taskRoot, `${job.agent_id}.md`);
  const summaryFile = path.join(taskRoot, 'SUMMARY.md');
  await appendMemoryEntry(globalFile, marker, `# ${job.agent_id}`, `Task #${job.task_id}: ${content}`);
  await appendMemoryEntry(taskFile, marker, `# Task #${job.task_id} · ${job.agent_id}`, content);
  await appendMemoryEntry(summaryFile, marker, `# Task #${job.task_id}`, `**${job.agent_id}:** ${content}`);
}

async function finishJob(job, answer, threadId, timings) {
  let projects = job.agent_id === 'lead' ? await taskProjects(job.task_id) : [];
  // A static preview is usually ready a few seconds after its manifest appears.
  // Let that local process settle before spending another Codex turn on a repair.
  if (job.agent_id === 'lead' && projects.length && projects.some(project => project.status !== 'running')) {
    projects = await waitForTaskPreviews(job.task_id);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query('SELECT status FROM jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
    if (current.status === 'cancelling') {
      await client.query("UPDATE jobs SET status='cancelled',finished_at=now() WHERE id=$1", [job.id]);
      await client.query("UPDATE tasks SET status='cancelled',updated_at=now() WHERE id=$1", [job.task_id]);
      await client.query('COMMIT');
      return;
    }
    await client.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [job.task_id]);
    const stage = job.workflow_stage || 'normal';
    const rootRow = (await client.query(`WITH RECURSIVE ancestors AS (
      SELECT id,parent_job_id FROM jobs WHERE id=$1::bigint
      UNION ALL
      SELECT parent.id,parent.parent_job_id FROM jobs parent JOIN ancestors child ON parent.id=child.parent_job_id
    ) SELECT id FROM ancestors WHERE parent_job_id IS NULL LIMIT 1`, [job.id])).rows[0];
    const rootId = rootRow?.id || job.id;
    const pipelineScope = (await client.query(`WITH RECURSIVE descendants AS (
      SELECT id FROM jobs WHERE id=$1::bigint
      UNION ALL
      SELECT child.id FROM jobs child JOIN descendants parent ON child.parent_job_id=parent.id
    ) SELECT id FROM descendants`, [rootId])).rows.map(row => row.id);
    let next = null;
    const pipelineJobs = [];
    const pipelineMessages = [];
    const reports = async stages => (await client.query(`SELECT a.name,j.result FROM jobs j JOIN agents a ON a.id=j.agent_id
      WHERE j.task_id=$1 AND j.id = ANY($3::bigint[]) AND j.workflow_stage = ANY($2::text[]) AND j.status='completed' ORDER BY j.id`, [job.task_id, stages, pipelineScope])).rows;
    const original = async () => (await client.query('SELECT prompt FROM jobs WHERE id=$1', [rootId])).rows[0]?.prompt || job.prompt;

    if (isProjectPipelineStart(job)) {
      const enabled = (await client.query('SELECT id FROM agents WHERE id = ANY($1::text[]) AND enabled=true', [designRoles])).rows.map(row => row.id);
      const missing = designRoles.filter(role => !enabled.includes(role));
      if (missing.length) throw new Error(`Pipeline game cần bật agent: ${missing.join(', ')}`);
      for (const role of designRoles) {
        pipelineJobs.push({
          agent: role,
          prompt: designPrompt(role, job.prompt, answer.reply),
          returnChain: [],
          handoffCount: 0,
          workflowStage: 'design'
        });
      }
      pipelineMessages.push('Đã mở pipeline dự án: Designer, Architect và Art / UX đưa ra đánh giá độc lập trước khi Developer triển khai.');
    } else if (stage === 'design') {
      const designState = (await client.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status='completed' OR id=$2)::int AS completed
        FROM jobs WHERE task_id=$1 AND workflow_stage='design' AND id=ANY($3::bigint[])`, [job.task_id, job.id, pipelineScope])).rows[0];
      const implementationExists = (await client.query("SELECT 1 FROM jobs WHERE task_id=$1 AND workflow_stage='implementation' AND id=ANY($2::bigint[])", [job.task_id, pipelineScope])).rowCount > 0;
      if (Number(designState.total) === designRoles.length && Number(designState.completed) === Number(designState.total) && !implementationExists) {
        const designRows = await reports(['design']);
        designRows.push({ name: job.agent_id, result: answer.reply });
        pipelineJobs.push({
          agent: 'developer',
          prompt: `Triển khai dự án theo yêu cầu gốc và đặc tả đã được chuẩn bị.\n\nYêu cầu gốc: ${await original()}\n\nĐặc tả thiết kế và kiến trúc độc lập:\n${workflowReport(designRows)}\n\nHợp nhất các quyết định, chỉ chọn giải pháp có lý do và ghi rõ phần không áp dụng. Tạo hoặc sửa project trong workspace, nếu là web project thì giữ manifest enthstudio.project.json có taskId ${job.task_id}; chạy kiểm tra phù hợp và báo cáo file đã đổi cùng bằng chứng.`,
          returnChain: [],
          handoffCount: 0,
          workflowStage: 'implementation'
        });
        pipelineMessages.push('Đã đủ đặc tả Designer, Architect và Art / UX; giao Developer triển khai.');
      }
    } else if (stage === 'implementation') {
      const reviewerExists = (await client.query("SELECT 1 FROM jobs WHERE task_id=$1 AND workflow_stage='review' AND id=ANY($2::bigint[])", [job.task_id, pipelineScope])).rowCount > 0;
      if (!reviewerExists) {
        const reviewRows = await reports(['design']);
        reviewRows.push({ name: job.agent_id, result: answer.reply });
        pipelineJobs.push({
          agent: 'reviewer',
          prompt: `Review độc lập bản triển khai dự án theo yêu cầu gốc.\n\nYêu cầu gốc: ${await original()}\n\nĐặc tả, kiến trúc và báo cáo Developer:\n${workflowReport(reviewRows)}\n\nKiểm tra hành vi, code, trải nghiệm, dữ liệu, ranh giới bảo mật, manifest và preview nếu có. Thử các đầu vào bất thường và đường gọi trực tiếp phù hợp. Đọc .enthstudio/runtime-verification.md nếu runtime của bạn không có Docker/browser; phân biệt rõ bằng chứng host được ghi trong artifact với kiểm tra trực tiếp. Không tự sửa code; báo lỗi có bằng chứng, tiêu chí còn thiếu và vote approve/request_changes/abstain.`,
          returnChain: [],
          handoffCount: 0,
          workflowStage: 'review'
        });
        pipelineMessages.push('Developer đã hoàn tất; giao Reviewer / QA kiểm tra độc lập.');
      }
    } else if (stage === 'review') {
      const reviewCount = Number((await client.query("SELECT COUNT(*)::int AS count FROM jobs WHERE task_id=$1 AND workflow_stage='review' AND id=ANY($2::bigint[])", [job.task_id, pipelineScope])).rows[0]?.count || 0);
      const finalExists = (await client.query("SELECT 1 FROM jobs WHERE task_id=$1 AND workflow_stage='final' AND id=ANY($2::bigint[])", [job.task_id, pipelineScope])).rowCount > 0;
      if (!finalExists && answer.vote !== 'approve' && reviewCount < DEFAULT_WORKFLOW_POLICY.maxReviewRounds) {
        const changeRows = await reports(['design', 'implementation']);
        changeRows.push({ name: job.agent_id, result: answer.reply });
        pipelineJobs.push({
          agent: 'developer',
          prompt: `Reviewer gate chưa đạt (vote: ${answer.vote}). Hoàn thiện hoặc sửa project theo bằng chứng của Reviewer / QA.\n\nYêu cầu gốc: ${await original()}\n\nBáo cáo và lỗi cần xử lý:\n${workflowReport(changeRows)}\n\nKhông được bỏ qua thiếu sót bằng cách tuyên bố đã xong. Bổ sung test thực thi, tài liệu hoặc runtime evidence khi đó là nguyên nhân bị chặn; chỉ sửa code khi cần. Chạy lại kiểm tra hồi quy và báo cáo file, lệnh và kết quả.`,
          returnChain: [],
          handoffCount: 0,
          workflowStage: 'rework'
        });
        pipelineMessages.push(`Reviewer chưa approve (vote: ${answer.vote}); giao Developer hoàn thiện bằng chứng ở vòng ${reviewCount}.`);
      } else if (!finalExists && answer.vote === 'approve') {
        const finalRows = await reports(['design', 'implementation', 'rework']);
        finalRows.push({ name: job.agent_id, result: answer.reply });
        pipelineJobs.push({
          agent: 'lead',
          prompt: `REVIEW_GATE_APPROVED=true\nTổng hợp và chốt dự án theo đúng quy trình.\n\nYêu cầu gốc: ${await original()}\n\nBáo cáo các vai trò:\n${workflowReport(finalRows)}\n\nNêu quyết định thiết kế và kiến trúc cuối, thay đổi của Developer, bằng chứng Reviewer, rủi ro còn lại và trạng thái project/preview/file/kiểm tra. Chỉ approve khi các role đã đưa ra ý kiến riêng và các lỗi có bằng chứng đã được xử lý; không giao thêm việc nếu mọi tiêu chí đã đạt.`,
          returnChain: [],
          handoffCount: 0,
          workflowStage: 'final'
        });
        pipelineMessages.push('Reviewer đã approve; giao Lead tổng hợp và chốt kết quả.');
      } else if (!finalExists) {
        const finalRows = await reports(['design', 'implementation', 'rework']);
        finalRows.push({ name: job.agent_id, result: answer.reply });
        pipelineJobs.push({
          agent: 'lead',
          prompt: `REVIEW_GATE_APPROVED=false\nReviewer chưa approve sau ${reviewCount} vòng. Tổng hợp trạng thái bị chặn, bằng chứng còn thiếu và rủi ro; không được tuyên bố project đã hoàn tất hay Docker đã được nghiệm thu nếu chưa có bằng chứng.\n\nYêu cầu gốc: ${await original()}\n\nBáo cáo các vai trò:\n${workflowReport(finalRows)}`,
          returnChain: [],
          handoffCount: 0,
          workflowStage: 'final'
        });
        pipelineMessages.push('Đã hết số vòng review; giao Lead báo cáo rõ trạng thái chưa đạt, không tự approve.');
      }
    } else if (stage === 'rework') {
      const reviewRows = await reports(['design', 'implementation', 'review']);
      reviewRows.push({ name: job.agent_id, result: answer.reply });
      pipelineJobs.push({
        agent: 'reviewer',
        prompt: `Kiểm tra lại project sau vòng sửa của Developer.\n\nYêu cầu gốc: ${await original()}\n\nBáo cáo trước và vòng sửa mới:\n${workflowReport(reviewRows)}\n\nXác nhận từng lỗi cũ đã được xử lý bằng kiểm tra lặp lại, kiểm tra preview nếu có. Nếu không có Docker/browser, đọc .enthstudio/runtime-verification.md và kiểm tra artifact có đủ trường bắt buộc hay không; không biến thiếu bằng chứng thành approve. Vote approve/request_changes/abstain.`,
        returnChain: [],
        handoffCount: 0,
        workflowStage: 'review'
      });
      pipelineMessages.push('Developer đã sửa theo phản hồi; giao Reviewer / QA kiểm tra lại.');
    } else if (stage !== 'final') {
      next = planNext(job, answer);
      if (next) {
        const enabled = (await client.query('SELECT id FROM agents WHERE id=$1 AND enabled=true', [next.agent])).rowCount > 0;
        if (!enabled) next = planNext(job, { ...answer, handoff:null });
      }
    }
    if (!next && pipelineJobs.length === 0 && stage !== 'design' && stage !== 'implementation' && stage !== 'review' && job.agent_id === 'lead' && projects.length && projects.some(project => project.status !== 'running') && job.handoff_count < 5 && job.depth < 9) {
      const chain = Array.isArray(job.return_chain) ? job.return_chain : [];
      next = {
        agent:'developer',
        prompt:`Project preview chưa sẵn sàng. Sửa manifest hoặc project, rồi xác nhận Docker preview đang running.\n\nTrạng thái runtime:\n${projectRuntimeContext(projects)}`,
        returnChain:chain.at(-1) === 'lead' ? chain : [...chain, 'lead'], handoffCount:job.handoff_count + 1, workflowStage:'normal'
      };
    }
    const finalGateApproved = !/REVIEW_GATE_APPROVED=false/.test(job.prompt);
    const finalAnswer = !next && pipelineJobs.length === 0 && finalGateApproved && job.agent_id === 'lead' && projects.length && projects.every(project => project.status === 'running')
      ? { ...answer, reply:`${projectDelivery(projects)}\n\nKết luận Lead: các lượt được giao cho task này đã hoàn tất; Docker preview đã sẵn sàng và dự án có thể mở từ URL ở trên.` }
      : answer;
    await client.query("UPDATE jobs SET status='completed',result=$1,codex_thread_id=$2,wake_ms=$3,runtime_ms=$4,finished_at=now() WHERE id=$5", [finalAnswer.reply, threadId, timings.wakeMs, timings.runtimeMs, job.id]);
    await client.query(`INSERT INTO messages(channel_id,task_id,agent_id,author,kind,body,vote)
      SELECT $1,$2,id,name,'agent',$3,$4 FROM agents WHERE id=$5`, [job.channel_id, job.task_id, finalAnswer.reply, finalAnswer.vote, job.agent_id]);
    if (threadId) await client.query(`INSERT INTO task_sessions(agent_id,task_id,codex_thread_id) VALUES($1,$2,$3)
      ON CONFLICT(agent_id,task_id) DO UPDATE SET codex_thread_id=EXCLUDED.codex_thread_id,updated_at=now()`, [job.agent_id, job.task_id, threadId]);
    const scheduled = next ? [{ ...next, workflowStage: next.workflowStage || 'normal' }, ...pipelineJobs] : pipelineJobs;
    for (const item of scheduled) {
      await client.query(`INSERT INTO jobs(task_id,channel_id,agent_id,prompt,depth,parent_job_id,return_chain,handoff_count,workflow_stage)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [job.task_id, job.channel_id, item.agent, item.prompt, job.depth + 1, job.id, JSON.stringify(item.returnChain || []), item.handoffCount || 0, item.workflowStage || 'normal']);
      await client.query(`INSERT INTO messages(channel_id,task_id,author,kind,body) VALUES($1,$2,'enthstudio','system',$3)`,
        [job.channel_id, job.task_id, `Đã giao tiếp cho @${item.agent}.`]);
    }
    for (const message of pipelineMessages) {
      await client.query(`INSERT INTO messages(channel_id,task_id,author,kind,body) VALUES($1,$2,'enthstudio','system',$3)`, [job.channel_id, job.task_id, message]);
    }
    const waiting = (await client.query("SELECT 1 FROM jobs WHERE task_id=$1 AND status IN ('queued','running','cancelling') LIMIT 1", [job.task_id])).rowCount > 0;
    await client.query('UPDATE tasks SET status=$1,updated_at=now() WHERE id=$2', [scheduled.length || waiting ? 'queued' : 'completed', job.task_id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function failJob(job, message, timings = {}) {
  const limited = /usage limit|rate limit|hạn mức/i.test(message);
  await pool.query('UPDATE jobs SET status=$1,error=$2,wake_ms=COALESCE($3,wake_ms),runtime_ms=COALESCE($4,runtime_ms),finished_at=now() WHERE id=$5', [limited ? 'rate_limited' : 'failed', message.slice(0, 2000), timings.wakeMs ?? null, timings.runtimeMs ?? null, job.id]);
  await pool.query('UPDATE tasks SET status=$1,updated_at=now() WHERE id=$2', [limited ? 'waiting_limit' : 'failed', job.task_id]);
  await pool.query(`INSERT INTO messages(channel_id,task_id,author,kind,body) VALUES($1,$2,'enthstudio','system',$3)`,
    [job.channel_id, job.task_id, `Tác vụ bị lỗi: ${message.slice(0, 300)}`]);
}

async function execute(job) {
  const agent = await one('SELECT * FROM agents WHERE id=$1', [job.agent_id]);
  const session = await one('SELECT codex_thread_id FROM task_sessions WHERE agent_id=$1 AND task_id=$2', [job.agent_id, job.task_id]);
  const first = !session;
  const contract = `\n\nTrả lời bằng JSON theo schema: reply là nội dung hiển thị trong nhóm chat; handoff là null hoặc {agent,task} khi thật sự cần giao tiếp; vote là none/approve/request_changes/abstain; memory là một ghi chú bền vững tối đa 1200 ký tự để lưu vào MEMORY.md. memory chỉ chứa quyết định, quy tắc, trade-off hoặc kiến thức đã xác nhận có ích cho task sau; nếu không có điều mới thì dùng chuỗi rỗng. Báo cáo ngắn, có file và kết quả kiểm tra nếu đã làm. Không chèn lịch sử chat vào câu trả lời.`;
  const projectRule = job.agent_id === 'developer'
    ? `\n\nNếu tạo web project cho task này, manifest enthstudio.project.json phải có \"taskId\": ${job.task_id} để hệ thống chỉ bàn giao khi Docker preview đã chạy.`
    : '';
  const leadRuntime = job.agent_id === 'lead'
    ? `\n\nTrạng thái project thực tế của task này:\n${projectRuntimeContext(await taskProjects(job.task_id))}`
    : '';
  // Load compact task memory only when opening an agent/task session. Resume
  // turns already carry the previous prompt in the Codex thread, avoiding a
  // second copy of the same context while still sharing it with new roles.
  const taskMemory = first ? await taskMemoryContext(job) : '';
  const globalMemory = first ? await readCompact(path.join(workspace, 'agent_memories', 'global', `${job.agent_id}.md`), 2_000) : '';
  const prompt = (first
    ? `${roleInstructions[job.agent_id]}\nĐọc docs/game-vision.md khi liên quan. Chỉ ghi điều bền vững, đã xác nhận vào Markdown.\n${globalMemory ? `\nMemory dài hạn hiện có của bạn:\n${globalMemory}` : ''}${contract}\n\nYêu cầu mới:\n${job.prompt}`
    : job.prompt) + taskMemory + projectRule + leadRuntime;
  const response = await fetch(`${runtimeUrl}/run`, {
    method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ jobId:job.id, model:agent.model, effort:agent.effort, threadId:session?.codex_thread_id || null, prompt })
  });
  if (!response.ok) throw new Error(`Runtime: ${response.status}`);
  let buffer = '', lastMessage = '', threadId = session?.codex_thread_id || null, errorText = '', exitCode = -1, wakeMs = null, runtimeMs = null;
  const consumeLine = line => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started') threadId = event.thread_id;
      if (event.type === 'runtime.first_output') wakeMs = Number(event.elapsed_ms) || 0;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') lastMessage = event.item.text || '';
      if (event.type === 'turn.failed' || event.type === 'error' || event.type === 'runtime.error') errorText = event.error?.message || event.message || errorText;
      if (event.type === 'runtime.exit') { exitCode = event.code; runtimeMs = Number(event.elapsed_ms) || 0; errorText = errorText || event.diagnostic || ''; }
    } catch { /* Ignore malformed diagnostic lines. */ }
  };
  const timer = setInterval(async () => {
    try {
      const state = await one('SELECT status FROM jobs WHERE id=$1', [job.id]);
      if (state?.status === 'cancelling') await fetch(`${runtimeUrl}/cancel/${job.id}`, { method:'POST' });
    } catch { /* Retry on the next poll. */ }
  }, 1000);
  try {
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString();
      let pos;
      while ((pos = buffer.indexOf('\n')) >= 0) {
        consumeLine(buffer.slice(0, pos));
        buffer = buffer.slice(pos + 1);
      }
    }
    if (buffer.trim()) consumeLine(buffer);
  } finally { clearInterval(timer); }
  active.delete(String(job.id));
  const status = await one('SELECT status FROM jobs WHERE id=$1', [job.id]);
  if (status?.status === 'cancelling') {
    await pool.query("UPDATE jobs SET status='cancelled',finished_at=now() WHERE id=$1", [job.id]);
    await pool.query("UPDATE tasks SET status='cancelled',updated_at=now() WHERE id=$1", [job.task_id]);
  } else if (exitCode === 0 && lastMessage) {
    if (job.agent_id === 'developer') await waitForTaskPreviews(job.task_id);
    const answer = parseAnswer(lastMessage);
    await persistAgentMemory(job, answer);
    await finishJob(job, answer, threadId, { wakeMs, runtimeMs });
  } else {
    await failJob(job, errorText || `Codex kết thúc với mã ${exitCode}`, { wakeMs, runtimeMs });
  }
}

await initDb();
await initWorkspace();
await pool.query("UPDATE jobs SET status='interrupted',error='Worker khởi động lại trước khi xác nhận kết quả' WHERE status IN ('running','cancelling')");
await pool.query("UPDATE tasks SET status='interrupted' WHERE id IN (SELECT task_id FROM jobs WHERE status='interrupted')");
console.log('enthstudio worker ready');
let lastAuthCheck = 0;
let lastModelSync = 0;
while (true) {
  try {
    if (Date.now() - lastAuthCheck > 15_000) {
      const loggedIn = await setAuth();
      if (loggedIn && Date.now() - lastModelSync > 300_000) {
        await syncModelCatalog();
        lastModelSync = Date.now();
      }
      lastAuthCheck = Date.now();
    }
    const auth = await one("SELECT value FROM runtime_status WHERE key='codex_auth'");
    if (auth?.value === 'chatgpt' && active.size < maxActive) {
      const job = await claimJob();
      if (job) {
        active.set(String(job.id), null);
        execute(job).catch(async error => {
          active.delete(String(job.id));
          console.error(`execute job ${job.id} failed`, error.stack || error);
          await failJob(job, error.message).catch(console.error);
        });
      }
    }
  } catch (error) { console.error(error); }
  await sleep(1200);
}
