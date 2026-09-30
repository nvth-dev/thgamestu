function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function planDecision(text) {
  let command = normalize(text);

  // A decision may include the task and Lead mention, but it must still be a
  // standalone command. This prevents project prompts such as “chờ tôi duyệt
  // plan” from being mistaken for an approval.
  for (let index = 0; index < 3; index += 1) {
    const stripped = command
      .replace(/^task\s*#?\s*\d+\s*[,;:-]?\s*/, '')
      .replace(/^@lead\b\s*[,;:-]?\s*/, '');
    if (stripped === command) break;
    command = stripped;
  }

  if (/^(?:duyet|approve|dong y|chap nhan)(?:\s+(?:plan|ke hoach))?(?:\s+va\s+(?:bat dau\s+)?trien khai)?[.!]?$/.test(command)
    || /^(?:bat dau|tien hanh)\s+trien khai(?:\s+(?:plan|ke hoach))?[.!]?$/.test(command)) return 'approve';

  if (/^(?:sua|chinh|yeu cau sua|can sua|request changes|feedback)(?:\s+(?:plan|ke hoach))?(?:\s*[:\-]\s*|\s+).+$/i.test(command)
    || /^(?:sua|chinh|yeu cau sua|can sua|request changes)(?:\s+(?:plan|ke hoach))?[.!]?$/.test(command)) return 'changes';

  return null;
}
