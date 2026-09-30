import pg from 'pg';
import { DEFAULT_WORKFLOW_POLICY } from './workflow-policy.js';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const roles = [
  { id: 'lead', name: 'Lead', model: 'gpt-5.6-sol', effort: 'medium', description: 'Điều phối và kết luận', color: '#c7a8ff' },
  { id: 'designer', name: 'Designer', model: 'gpt-5.6-luna', effort: 'xhigh', description: 'Thiết kế gameplay', color: '#ffb86b' },
  { id: 'architect', name: 'Architect', model: 'gpt-5.6-luna', effort: 'xhigh', description: 'Thiết kế kỹ thuật', color: '#7dcfff' },
  { id: 'developer', name: 'Developer', model: 'gpt-5.6-luna', effort: 'xhigh', description: 'Lập trình và kiểm tra', color: '#7fe3b3' },
  { id: 'reviewer', name: 'Reviewer / QA', model: 'gpt-5.6-luna', effort: 'xhigh', description: 'Review và kiểm thử', color: '#ff8c9b' },
  { id: 'art-ux', name: 'Art / UX', model: 'gpt-5.6-luna', effort: 'xhigh', description: 'Hình ảnh và trải nghiệm', color: '#e5a6e8' }
];

export const channels = [
  ['general', 'general', 'Thảo luận chung'],
  ['gameplay', 'gameplay', 'Thiết kế gameplay'],
  ['engineering', 'engineering', 'Lập trình và kiến trúc'],
  ['art-ux', 'art-ux', 'Hình ảnh và giao diện'],
  ['qa', 'qa', 'Kiểm thử'],
  ['decisions', 'decisions', 'Quyết định đã chốt']
];

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(5192026)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL,
        effort TEXT NOT NULL, description TEXT NOT NULL, color TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id),
        status TEXT NOT NULL DEFAULT 'queued', plan_status TEXT NOT NULL DEFAULT 'not_required', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id),
        task_id BIGINT REFERENCES tasks(id), agent_id TEXT REFERENCES agents(id),
        author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat', body TEXT NOT NULL,
        vote TEXT NOT NULL DEFAULT 'none',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS task_sessions (
        agent_id TEXT NOT NULL REFERENCES agents(id), task_id BIGINT NOT NULL REFERENCES tasks(id),
        codex_thread_id TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(agent_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id BIGSERIAL PRIMARY KEY, task_id BIGINT NOT NULL REFERENCES tasks(id),
        channel_id TEXT NOT NULL REFERENCES channels(id), agent_id TEXT NOT NULL REFERENCES agents(id),
        prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        depth INTEGER NOT NULL DEFAULT 0, parent_job_id BIGINT REFERENCES jobs(id),
        return_agent_id TEXT REFERENCES agents(id),
        return_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
        handoff_count INTEGER NOT NULL DEFAULT 0,
        codex_thread_id TEXT, result TEXT, error TEXT,
        idle_ms BIGINT, wake_ms INTEGER, runtime_ms INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
        workflow_stage TEXT NOT NULL DEFAULT 'normal'
      );
      CREATE TABLE IF NOT EXISTS runtime_status (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS messages_channel_id_id_idx ON messages(channel_id, id);
      CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
    `);
    await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS return_chain JSONB NOT NULL DEFAULT '[]'::jsonb");
    await client.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_status TEXT NOT NULL DEFAULT 'not_required'");
    await client.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS handoff_count INTEGER NOT NULL DEFAULT 0');
    await client.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS idle_ms BIGINT');
    await client.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS wake_ms INTEGER');
    await client.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS runtime_ms INTEGER');
    await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workflow_stage TEXT NOT NULL DEFAULT 'normal'");
    await client.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS vote TEXT NOT NULL DEFAULT 'none'");
    for (const [id, name, description] of channels) {
      await client.query('INSERT INTO channels(id,name,description) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [id, name, description]);
    }
    for (const role of roles) {
      await client.query(`INSERT INTO agents(id,name,model,effort,description,color)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`, Object.values(role));
    }
    await client.query(`INSERT INTO settings(key,value)
      VALUES('workflow_policy',$1) ON CONFLICT(key) DO NOTHING`, [JSON.stringify(DEFAULT_WORKFLOW_POLICY)]);
    await client.query(`INSERT INTO task_sessions(agent_id,task_id,codex_thread_id)
      SELECT DISTINCT ON (agent_id,task_id) agent_id,task_id,codex_thread_id
      FROM jobs WHERE status='completed' AND codex_thread_id IS NOT NULL
      ORDER BY agent_id,task_id,id DESC ON CONFLICT(agent_id,task_id) DO NOTHING`);
    await client.query("UPDATE jobs SET status='rate_limited' WHERE status='failed' AND error ILIKE '%usage limit%'");
    await client.query("UPDATE tasks SET status='waiting_limit' WHERE status='failed' AND id IN (SELECT task_id FROM jobs WHERE status='rate_limited')");
  } finally {
    await client.query('SELECT pg_advisory_unlock(5192026)').catch(() => {});
    client.release();
  }
}

export async function one(sql, args = []) {
  const { rows } = await pool.query(sql, args);
  return rows[0] ?? null;
}

export async function all(sql, args = []) {
  const { rows } = await pool.query(sql, args);
  return rows;
}
