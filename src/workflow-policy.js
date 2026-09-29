export const DESIGN_ROLES = Object.freeze(['designer', 'architect', 'art-ux']);

export const DEFAULT_WORKFLOW_POLICY = Object.freeze({
  mode: 'serious',
  designRoles: [...DESIGN_ROLES],
  sequence: ['design', 'implementation', 'review', 'final'],
  requireIndependentDesign: true,
  requireReviewerApproval: true,
  requireRuntimeEvidenceForProjects: true,
  maxReviewRounds: 3
});

export const WORKFLOW_MODE = String(process.env.ENTHSTUDIO_WORKFLOW_MODE || 'serious').toLowerCase() === 'direct'
  ? 'direct'
  : 'serious';

// Keep this detector deliberately broad. A project task may be a game, a web
// app, an API, a data feature, or a security/UX change, and all of them need
// the same independent design and architecture gate before implementation.
const projectPattern = /\b(game|flappy|bird|gameplay|platformer|shooter|puzzle|runner|web\s*game|game\s*project|app|application|web|website|site|api|backend|frontend|service|dashboard|tool|module|plugin|feature|system|architecture|component|bug|code|source|repository|repo|test|testing|deploy|deployment|hệ\s*thống|dự\s*án|project|leaderboard|username|score|docker|container|preview|runtime|database|schema|security|bảo\s*mật|ux|ui)\b/i;
const projectIntentPattern = /\b(tạo|làm|xây|dựng|build|create|make|implement|develop|prototype|project|dự\s*án|sửa|fix|bug|refactor|cải\s*thiện|thêm|đổi|remove|update|audit|hardening|bảo\s*mật|security|review|kiểm\s*tra|kiểm\s*chứng|thiết\s*kế|design|plan|phân\s*tích)\b/i;
const projectContinuationPattern = /\b(tiếp\s*tục|review|kiểm\s*chứng|kiểm\s*tra\s*lại|pipeline|overview|gate|request\s*changes)\b/i;

export function isSeriousProjectRequest(text, { existingTask = false } = {}) {
  const value = String(text || '');
  if (WORKFLOW_MODE === 'direct') return false;
  if (projectPattern.test(value) && (projectIntentPattern.test(value) || projectContinuationPattern.test(value))) return true;
  // Once a task exists, a request to change, verify, or continue it should
  // re-enter the Lead gate even when the follow-up omits the project name.
  return Boolean(existingTask && projectIntentPattern.test(value));
}

