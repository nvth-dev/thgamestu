const state = {
  view: 'general', channels: [], agents: [], tasks: [], jobs: [], messages: [], auth: { value: 'unknown' },
  documentPath: null, documentContent: '', artifactPath:null, artifactFolder:null, artifactContent:'', models: [], modelPlan: null, modelLoaded: false, modelError: null,
  taskFilter: 'active', settings: null
};
const content = document.querySelector('#content');
const composer = document.querySelector('#composer');
const input = document.querySelector('#message-input');
const mobileNav = document.querySelector('#mobile-nav');
const mentionSuggestions = document.querySelector('#mention-suggestions');
let mentionItems = [];
let mentionIndex = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date(value));
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return null;
  const seconds = Number(ms) / 1000;
  if (seconds < 1) return `${Math.round(Number(ms))}ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function avatar(agent, fallback = '✦') {
  const node = element('span', 'member-avatar', agent?.name?.slice(0, 1) || fallback);
  node.style.background = agent?.color || '#34394b';
  return node;
}

function toast(message) {
  const node = document.querySelector('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 3000);
}

async function request(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Yêu cầu thất bại');
  return data;
}

function selectedTask() {
  const match = state.view.match(/^task-(\d+)$/);
  return match ? state.tasks.find(task => String(task.id) === match[1]) : null;
}
function currentChannel() { return state.channels.find(channel => channel.id === (selectedTask()?.channel_id || state.view)); }
function isChat() { return Boolean(currentChannel()); }

function setView(view) {
  if (state.view !== view) state.messages = [];
  if (view === 'artifacts' && state.view !== view) { state.artifactFolder = null; state.artifactPath = null; state.artifactContent = ''; }
  state.view = view;
  hideMentionSuggestions();
  history.replaceState({}, '', `#${view}`);
  const task = selectedTask();
  input.placeholder = task ? `Trả lời trong task #${task.id} · @agent để đổi người nhận` : `Nhắn #${view} · @agent để giao việc`;
  mobileNav.querySelectorAll('[data-dynamic]').forEach(node => node.remove());
  if (task) {
    const option = element('option', '', `Task #${task.id}`);
    option.value = view;
    option.dataset.dynamic = 'true';
    mobileNav.append(option);
  }
  mobileNav.value = view;
  for (const node of document.querySelectorAll('.nav-item')) node.classList.toggle('active', node.dataset.view === view);
  const channel = currentChannel();
  document.querySelector('#view-glyph').textContent = task ? '▦' : channel ? '#' : { tasks:'▦', runs:'◷', agents:'◎', documents:'▤', artifacts:'⌁', git:'⌘', previews:'◉', settings:'⚙' }[view] || '#';
  document.querySelector('#view-title').textContent = task ? `Task #${task.id}` : channel?.name || { tasks:'Công việc', runs:'Lượt chạy', agents:'Đội ngũ', documents:'Tài liệu', artifacts:'Agent memories', git:'Git diff', previews:'Previews', settings:'Settings' }[view] || view;
  document.querySelector('#view-description').textContent = task?.title || channel?.description || '';
  composer.hidden = !channel;
  render();
  if (channel) refreshMessages(true);
  if (view === 'runs') refreshJobs();
  if (view === 'agents') refreshModels();
  if (view === 'documents') refreshDocuments();
  if (view === 'settings') refreshSettings();
}

function renderNavigation() {
  const list = document.querySelector('#channel-list');
  list.replaceChildren();
  mobileNav.replaceChildren();
  for (const channel of state.channels) {
    const button = element('button', 'nav-item', channel.name);
    button.dataset.view = channel.id;
    button.prepend(element('span', 'nav-symbol', '#'));
    button.addEventListener('click', () => setView(channel.id));
    list.append(button);
    const option = element('option', '', `# ${channel.name}`);
    option.value = channel.id;
    mobileNav.append(option);
  }
  for (const [id, label] of [['tasks','Công việc'],['runs','Lượt chạy'],['agents','Agents'],['documents','Tài liệu'],['artifacts','Agent memories'],['git','Git diff'],['previews','Previews'],['settings','Settings']]) {
    const option = element('option', '', label);
    option.value = id;
    mobileNav.append(option);
  }
  const task = selectedTask();
  if (task) {
    const option = element('option', '', `Task #${task.id}`);
    option.value = state.view;
    option.dataset.dynamic = 'true';
    mobileNav.append(option);
  }
  mobileNav.value = state.view;
}

function renderMembers() {
  const list = document.querySelector('#member-list');
  list.replaceChildren();
  document.querySelector('#member-count').textContent = state.agents.filter(agent => agent.enabled).length;
  for (const agent of state.agents) {
    const button = element('button', 'member-card');
    button.append(avatar(agent));
    const label = element('span');
    label.append(element('strong', '', agent.name), element('small', '', `${agent.enabled ? agent.model : 'Tạm ngưng'} · ${agent.effort}`));
    button.append(label);
    button.addEventListener('click', () => setView('agents'));
    list.append(button);
  }
}

function renderHeader() {
  const pill = document.querySelector('#auth-pill');
  pill.className = `auth-pill ${state.auth.value}`;
  pill.querySelector('span').textContent = state.auth.value === 'chatgpt' ? 'Codex · ChatGPT' : state.auth.value === 'login-required' ? 'Cần đăng nhập Codex' : state.auth.value === 'runtime-unavailable' ? 'Runtime chưa sẵn sàng' : 'Đang kiểm tra Codex';
  document.querySelector('#task-count').textContent = state.tasks.filter(task => ['queued','running'].includes(task.status)).length;
}

function typingNames() {
  const channel = currentChannel();
  const task = selectedTask();
  if (!channel) return [];
  const active = state.jobs.filter(job => job.status === 'running' && job.channel_id === channel.id && (!task || String(job.task_id) === String(task.id)));
  return [...new Map(active.map(job => [job.agent_id, job.agent_name || state.agents.find(agent => agent.id === job.agent_id)?.name || job.agent_id])).values()];
}

function typingSignature() { return typingNames().join('|'); }

function typingLabel(names) {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are typing…`;
}

function paintTyping(node) {
  const names = typingNames();
  node.hidden = names.length === 0;
  node.replaceChildren();
  if (!names.length) return;
  const dots = element('span', 'typing-dots');
  dots.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 3; index += 1) dots.append(element('i'));
  node.append(dots, element('span', '', typingLabel(names)));
}

function typingIndicator() {
  const node = element('div', 'typing-indicator');
  node.id = 'typing-indicator';
  node.setAttribute('aria-live', 'polite');
  paintTyping(node);
  return node;
}

function updateTypingIndicator() {
  const node = content.querySelector('#typing-indicator');
  if (node) paintTyping(node);
}

function mentionContext() {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const match = before.match(/(^|\s)@([a-z0-9_-]*)$/i);
  if (!match) return null;
  return {
    start: before.length - match[0].length + match[1].length,
    end: caret,
    query: match[2].toLowerCase()
  };
}

function hideMentionSuggestions() {
  mentionItems = [];
  mentionIndex = 0;
  if (!mentionSuggestions) return;
  mentionSuggestions.hidden = true;
  mentionSuggestions.replaceChildren();
  input.removeAttribute('aria-activedescendant');
}

function renderMentionSuggestions() {
  mentionSuggestions.replaceChildren();
  mentionItems.forEach((agent, index) => {
    const option = element('button', `mention-suggestion ${index === mentionIndex ? 'active' : ''}`);
    option.type = 'button';
    option.role = 'option';
    option.id = `mention-option-${agent.id}`;
    option.setAttribute('aria-selected', String(index === mentionIndex));
    option.append(avatar(agent));
    const label = element('span', 'mention-suggestion-label');
    label.append(element('strong', '', agent.name), element('small', '', `@${agent.id} · ${agent.description}`));
    option.append(label);
    option.addEventListener('click', () => chooseMention(index));
    mentionSuggestions.append(option);
  });
  mentionSuggestions.hidden = mentionItems.length === 0;
  if (mentionItems.length) input.setAttribute('aria-activedescendant', `mention-option-${mentionItems[mentionIndex].id}`);
}

function updateMentionSuggestions() {
  if (!mentionSuggestions || !isChat()) return hideMentionSuggestions();
  const context = mentionContext();
  if (!context) return hideMentionSuggestions();
  const query = context.query;
  mentionItems = state.agents
    .filter(agent => agent.enabled)
    .filter(agent => !query || `${agent.id} ${agent.name}`.toLowerCase().includes(query))
    .sort((left, right) => (left.id === 'lead' ? -1 : right.id === 'lead' ? 1 : left.name.localeCompare(right.name, 'vi')));
  mentionIndex = Math.min(mentionIndex, Math.max(0, mentionItems.length - 1));
  renderMentionSuggestions();
}

function chooseMention(index = mentionIndex) {
  const agent = mentionItems[index];
  const context = mentionContext();
  if (!agent || !context) return;
  const mention = `@${agent.id}`;
  input.value = `${input.value.slice(0, context.start)}${mention} ${input.value.slice(context.end)}`;
  const caret = context.start + mention.length + 1;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  updateMentionSuggestions();
}

function renderChat() {
  const channel = currentChannel();
  const task = selectedTask();
  const wrap = element('div', 'chat-content');
  const intro = element('div', 'chat-intro');
  intro.append(element('div', 'channel-icon', task ? '▦' : '#'), element('h1', '', task ? `Task #${task.id}` : `Chào mừng đến #${channel.name}`), element('p', '', task ? task.title : channel.description));
  if (task) {
    const back = element('button', 'small-button secondary', `← #${channel.name}`);
    back.style.marginTop = '16px';
    back.addEventListener('click', () => setView(channel.id));
    intro.append(back);
  }
  wrap.append(intro);
  if (!state.messages.length) wrap.append(element('div', 'empty-chat', 'Chưa có tin nhắn. Bắt đầu bằng một yêu cầu hoặc gọi trực tiếp một agent.'));
  for (const message of state.messages) {
    const agent = state.agents.find(item => item.id === message.agent_id);
    const row = element('article', `message ${message.kind === 'system' ? 'system' : ''}`);
    const icon = element('span', `message-avatar ${message.author === 'Bạn' ? 'you' : message.kind === 'system' ? 'system' : ''}`, message.author === 'Bạn' ? 'B' : message.kind === 'system' ? '✦' : agent?.name?.slice(0, 1) || 'A');
    if (agent) icon.style.background = agent.color;
    const main = element('div', 'message-main');
    const head = element('div', 'message-head');
    head.append(element('strong', '', message.author), element('time', '', fmtTime(message.created_at)));
    main.append(head, element('div', 'message-body', message.body));
    if (message.vote && message.vote !== 'none') main.append(element('span', `vote-badge ${message.vote}`, { approve:'✓ Tán thành', request_changes:'↺ Cần sửa', abstain:'○ Chưa đủ thông tin' }[message.vote] || message.vote));
    if (message.task_id && message.kind !== 'system') main.append(element('div', 'message-task', `TASK #${message.task_id}`));
    row.append(icon, main);
    wrap.append(row);
  }
  wrap.append(typingIndicator());
  content.replaceChildren(wrap);
  content.scrollTop = content.scrollHeight;
}

const statusNames = { queued:'Đang chờ', running:'Đang chạy', completed:'Hoàn thành', failed:'Lỗi', interrupted:'Gián đoạn', cancelled:'Đã dừng', cancelling:'Đang dừng', rate_limited:'Hết hạn mức', waiting_limit:'Chờ hạn mức' };
function viewFrame(eyebrow, title, subtitle) {
  const wrap = element('div', 'view-pad management-view');
  const intro = element('div', 'view-intro');
  intro.append(element('div', 'channel-icon', document.querySelector('#view-glyph').textContent));
  const copy = element('div', 'view-intro-copy');
  copy.append(element('div', 'view-eyebrow', eyebrow), element('h1', 'view-title', title), element('p', 'view-subtitle', subtitle));
  intro.append(copy);
  wrap.append(intro);
  return wrap;
}

function renderTasks() {
  const activeStatuses = new Set(['queued','running','cancelling','interrupted','rate_limited','waiting_limit']);
  const active = state.tasks.filter(task => activeStatuses.has(task.status));
  const history = state.tasks.filter(task => !activeStatuses.has(task.status));
  const visible = state.taskFilter === 'history' ? history : active;
  const wrap = viewFrame('TIẾN ĐỘ', 'Công việc', 'Công việc đang mở được hiển thị trước; lịch sử hoàn thành nằm ở tab riêng để danh sách luôn gọn.');
  const toolbar = element('div', 'task-toolbar');
  for (const [filter, label, count] of [['active', 'Đang mở', active.length], ['history', 'Lịch sử', history.length]]) {
    const button = element('button', `small-button ${state.taskFilter === filter ? '' : 'secondary'}`, `${label} · ${count}`);
    button.type = 'button';
    button.addEventListener('click', () => { state.taskFilter = filter; renderTasks(); });
    toolbar.append(button);
  }
  wrap.append(toolbar);
  const cards = element('div', 'cards');
  if (!visible.length) cards.append(element('div', 'empty-state', state.taskFilter === 'active' ? 'Không có công việc đang mở.' : 'Chưa có công việc trong lịch sử.'));
  for (const task of visible) {
    const card = element('div', 'task-card');
    card.style.cursor = 'pointer'; card.tabIndex = 0; card.setAttribute('role','button');
    card.addEventListener('click', () => setView(`task-${task.id}`));
    card.addEventListener('keydown', event => { if (event.key === 'Enter') setView(`task-${task.id}`); });
    card.append(element('span', 'task-id', `#${task.id}`));
    const main = element('div', 'task-main');
    main.append(element('strong', '', task.title), element('small', '', `#${task.channel_id} · ${task.current_agent || 'Chưa phân công'} · ${fmtTime(task.created_at)}`));
    card.append(main, element('span', `status ${task.status}`, statusNames[task.status] || task.status));
    cards.append(card);
  }
  wrap.append(cards); content.replaceChildren(wrap);
}

function renderRuns() {
  const wrap = viewFrame('HOẠT ĐỘNG', 'Lượt chạy Codex', 'Xem người đang làm, kết quả và những lượt cần xử lý.');
  const cards = element('div', 'cards');
  if (!state.jobs.length) cards.append(element('div', 'empty-state', 'Chưa có lượt chạy nào.'));
  for (const job of state.jobs) {
    const card = element('div', 'run-card');
    card.append(element('span', 'task-id', `#${job.id}`));
    const main = element('div', 'task-main');
    const timing = [];
    const queueMs = job.started_at ? new Date(job.started_at) - new Date(job.created_at) : null;
    if (job.idle_ms !== null && job.idle_ms !== undefined) timing.push(`Ngủ ${fmtDuration(job.idle_ms)}`);
    if (queueMs !== null) timing.push(`Chờ ${fmtDuration(queueMs)}`);
    if (job.wake_ms !== null && job.wake_ms !== undefined) timing.push(`Đánh thức ${fmtDuration(job.wake_ms)}`);
    if (job.runtime_ms !== null && job.runtime_ms !== undefined) timing.push(`Xử lý ${fmtDuration(Math.max(0, job.runtime_ms - (job.wake_ms || 0)))}`);
    const details = [`Task #${job.task_id}`, fmtTime(job.created_at), ...timing];
    if (job.error) details.push(job.error.slice(0, 180));
    main.append(element('strong', '', `@${job.agent_id} · ${job.prompt.slice(0, 180)}`), element('small', '', details.join(' · ')));
    card.append(main);
    const actions = element('div', 'run-actions');
    actions.append(element('span', `status ${job.status}`, statusNames[job.status] || job.status));
    if (['queued','running'].includes(job.status)) {
      const stop = element('button', 'small-button secondary', 'Dừng');
      stop.addEventListener('click', async () => { try { await request(`/api/jobs/${job.id}/cancel`, { method:'POST' }); await refreshJobs(); await refreshBootstrap(); } catch (error) { toast(error.message); } });
      actions.append(stop);
    } else if (['rate_limited','failed','interrupted'].includes(job.status)) {
      const retry = element('button', 'small-button secondary', 'Chạy lại');
      retry.addEventListener('click', async () => { try { await request(`/api/jobs/${job.id}/retry`, { method:'POST' }); await refreshJobs(); await refreshBootstrap(); } catch (error) { toast(error.message); } });
      actions.append(retry);
    }
    card.append(actions); cards.append(card);
  }
  wrap.append(cards); content.replaceChildren(wrap);
}

function modelReasoningOptions(model, fallback) {
  const values = (model?.supportedReasoningEfforts || []).map(item => item.reasoningEffort).filter(Boolean);
  if (fallback && !values.includes(fallback)) values.unshift(fallback);
  return values.length ? values : ['low','medium','high','xhigh','max','ultra'];
}

function renderAgents() {
  const suffix = state.modelLoaded ? ` · Codex subscription${state.modelPlan ? ` (${state.modelPlan})` : ''} · ${state.models.length} model khả dụng` : '';
  const wrap = viewFrame('CẤU HÌNH ĐỘI NGŨ', 'Agents', `Model và effort áp dụng cho lượt chạy tiếp theo. Mỗi role giữ phiên và bộ nhớ riêng.${suffix}`);
  const toolbar = element('div', 'agent-toolbar');
  const reload = element('button', 'small-button secondary', state.modelLoaded ? 'Làm mới model' : 'Tải model từ Codex');
  reload.addEventListener('click', () => refreshModels(true));
  toolbar.append(reload);
  if (state.modelError) toolbar.append(element('span', 'model-error', state.modelError));
  wrap.append(toolbar);
  const grid = element('div', 'agent-grid');
  for (const agent of state.agents) {
    const card = element('div', 'agent-card');
    const head = element('div', 'agent-top');
    head.append(avatar(agent));
    const text = element('div'); text.append(element('strong', '', agent.name), element('small', '', agent.description)); head.append(text);
    card.append(head);
    const form = element('form', 'agent-form');
    const modelField = element('div', 'field');
    modelField.append(element('label', '', 'Model'));
    let modelControl;
    let modelInput;
    if (state.models.length) {
      modelControl = element('select');
      const choices = [...state.models];
      if (!choices.some(model => model.model === agent.model)) choices.unshift({ model:agent.model, displayName:agent.model, supportedReasoningEfforts:[] });
      for (const model of choices) {
        const option = element('option', '', model.displayName && model.displayName !== model.model ? `${model.displayName} · ${model.model}` : model.model);
        option.value = model.model;
        modelControl.append(option);
      }
      modelControl.value = agent.model;
    } else {
      modelInput = element('input'); modelInput.value = agent.model; modelInput.required = true; modelInput.maxLength = 80;
      modelControl = modelInput;
    }
    modelField.append(modelControl);
    const effortField = element('div', 'field');
    effortField.append(element('label', '', 'Reasoning effort'));
    const effortSelect = element('select');
    const syncEfforts = () => {
      const selected = state.models.find(model => model.model === modelControl.value);
      effortSelect.replaceChildren();
      for (const value of modelReasoningOptions(selected, agent.effort)) {
        const option = element('option', '', value); option.value = value; effortSelect.append(option);
      }
      effortSelect.value = modelReasoningOptions(selected, agent.effort).includes(agent.effort) ? agent.effort : selected?.defaultReasoningEffort || effortSelect.options[0]?.value;
    };
    syncEfforts();
    if (modelControl.tagName === 'SELECT') modelControl.addEventListener('change', syncEfforts);
    effortField.append(effortSelect);
    const foot = element('div', 'agent-form-bottom');
    const enabledLabel = element('label');
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = agent.enabled;
    enabledLabel.append(checkbox, document.createTextNode(' Hoạt động'));
    const save = element('button', 'small-button', 'Lưu cấu hình'); save.type = 'submit';
    foot.append(enabledLabel, save);
    form.append(modelField, effortField, foot);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true;
      try {
        await request(`/api/agents/${agent.id}`, { method:'PATCH', body: JSON.stringify({ model:modelControl.value.trim(), effort:effortSelect.value, enabled:checkbox.checked }) });
        toast(`Đã lưu ${agent.name}`); await refreshBootstrap();
      } catch (error) { toast(error.message); }
      finally { save.disabled = false; }
    });
    card.append(form); grid.append(card);
  }
  wrap.append(grid); content.replaceChildren(wrap);
}

async function refreshModels(showToast = false) {
  try {
    const data = await request('/api/models');
    state.models = Array.isArray(data.models) ? data.models : [];
    state.modelPlan = data.planType || null;
    state.modelLoaded = true;
    state.modelError = null;
    if (state.view === 'agents') renderAgents();
    if (showToast) toast(`Đã tải ${state.models.length} model từ Codex`);
  } catch (error) {
    state.modelError = error.message;
    if (state.view === 'agents') renderAgents();
    if (showToast) toast(error.message);
  }
}

async function renderSettings() {
  const wrap = viewFrame('CẤU HÌNH', 'Settings', 'Lưu tùy chọn tích hợp Cloudflare cho các yêu cầu port forward của Lead.');
  const card = element('section', 'settings-card');
  const heading = element('div', 'settings-heading');
  heading.append(element('strong', '', 'Cloudflare Quick Tunnel'), element('span', 'settings-badge', 'LOCAL'));
  card.append(heading);
  card.append(element('p', 'settings-note', 'Quick Tunnel tạo URL tạm thời dạng *.trycloudflare.com và không cần đăng nhập Cloudflare. Lead chỉ mở tunnel khi bạn yêu cầu rõ ràng trong chat, nên thao tác này không tạo thêm lượt Codex.'));
  const status = element('div', 'settings-status', 'Đang kiểm tra cấu hình…');
  card.append(status);
  const form = element('form', 'settings-form');
  const field = element('div', 'field');
  field.append(element('label', '', 'Cloudflare Tunnel token (tùy chọn)'));
  const token = element('input');
  token.type = 'password'; token.autocomplete = 'off'; token.placeholder = 'Chỉ cần cho named tunnel trong tương lai';
  token.setAttribute('aria-label', 'Cloudflare Tunnel token');
  field.append(token);
  const actions = element('div', 'settings-actions');
  const save = element('button', 'small-button', 'Lưu token'); save.type = 'submit';
  const clear = element('button', 'small-button secondary', 'Xóa token đã lưu'); clear.type = 'button';
  actions.append(save, clear);
  form.append(field, actions);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const value = token.value.trim();
    if (!value) return toast('Nhập token trước khi lưu, hoặc dùng Xóa token đã lưu.');
    save.disabled = true;
    try {
      await request('/api/settings', { method: 'PUT', body: JSON.stringify({ cloudflareTunnelToken: value }) });
      token.value = ''; state.settings = { ...(state.settings || {}), settings: { cloudflareTunnelTokenConfigured: true } };
      status.textContent = 'Đã lưu token cục bộ. Giá trị token không được hiển thị lại.';
      toast('Đã lưu cấu hình Cloudflare');
    } catch (error) { toast(error.message); }
    finally { save.disabled = false; }
  });
  clear.addEventListener('click', async () => {
    clear.disabled = true;
    try {
      await request('/api/settings', { method: 'PUT', body: JSON.stringify({ cloudflareTunnelToken: '' }) });
      state.settings = { ...(state.settings || {}), settings: { cloudflareTunnelTokenConfigured: false } };
      status.textContent = 'Chưa lưu Cloudflare token. Quick Tunnel vẫn dùng được mà không cần đăng nhập.';
      toast('Đã xóa token');
    } catch (error) { toast(error.message); }
    finally { clear.disabled = false; }
  });
  card.append(form);
  wrap.append(card);
  content.replaceChildren(wrap);
  try {
    const data = await request('/api/settings');
    state.settings = data;
    const configured = Boolean(data.settings?.cloudflareTunnelTokenConfigured);
    status.textContent = configured
      ? 'Đã lưu một token Cloudflare. Giá trị token không được hiển thị lại.'
      : 'Chưa lưu token. Quick Tunnel vẫn dùng được mà không cần đăng nhập.';
  } catch (error) {
    status.textContent = `Không đọc được cấu hình: ${error.message}`;
  }
}

async function renderDocuments() {
  const wrap = viewFrame('TRÍ NHỚ DÀI HẠN', 'Tài liệu Markdown', 'Chỉ thông tin liên quan mới được agent đọc vào context. Bạn có thể sửa tài liệu tại đây.');
  const files = await request('/api/documents');
  const list = element('div', 'doc-list');
  for (const file of files.files) {
    const button = element('button', `doc-card ${state.documentPath === file ? 'active' : ''}`, `▤  ${file}`);
    button.addEventListener('click', async () => {
      state.documentPath = file;
      try {
        const data = await request(`/api/documents?path=${encodeURIComponent(file)}`);
        state.documentContent = data.content;
        await renderDocuments();
      } catch (error) { toast(error.message); }
    });
    list.append(button);
  }
  wrap.append(list);
  if (state.documentPath) {
    const bar = element('div', 'doc-toolbar'); bar.append(element('strong', '', state.documentPath));
    const save = element('button', 'small-button', 'Lưu tài liệu');
    const editor = element('textarea', 'doc-editor'); editor.value = state.documentContent; editor.setAttribute('aria-label', 'Nội dung tài liệu');
    save.addEventListener('click', async () => {
      try { await request(`/api/documents?path=${encodeURIComponent(state.documentPath)}`, { method:'PUT', body:JSON.stringify({ content:editor.value }) }); state.documentContent = editor.value; toast('Đã lưu tài liệu'); }
      catch (error) { toast(error.message); }
    });
    bar.append(save); wrap.append(bar, editor);
  }
  content.replaceChildren(wrap);
}

async function renderArtifacts() {
  const wrap = viewFrame('BỘ NHỚ ĐỘI NGŨ', 'Agent memories', 'Memory dài hạn theo agent và memory riêng theo từng task. Worker tự lưu quyết định bền vững sau mỗi lượt; không lưu toàn bộ lịch sử chat.');
  const files = await request('/api/artifacts');
  const memories = files.files.filter(file => /^agent_memories\/(?:global|task-\d+)\/(?:SUMMARY\.md|(?:lead|designer|architect|developer|reviewer|art-ux)\.md)$/.test(file));
  const groups = new Map();
  for (const file of memories) {
    const scope = file.split('/')[1];
    if (!groups.has(scope)) groups.set(scope, []);
    groups.get(scope).push(file);
  }
  if (!memories.length) {
    wrap.append(element('div', 'empty-state', 'Chưa có bộ nhớ agent.'));
    content.replaceChildren(wrap);
    return;
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a === 'global' ? -1 : b === 'global' ? 1 : a.localeCompare(b, undefined, { numeric: true }));
  if (!state.artifactFolder || !groups.has(state.artifactFolder)) {
    const folders = element('div', 'memory-folder-tree');
    for (const [scope, groupFiles] of orderedGroups) {
      const label = scope === 'global' ? 'global' : scope;
      const description = scope === 'global' ? 'Kiến thức dùng chung của đội ngũ' : `Bộ nhớ riêng của task #${scope.slice('task-'.length)}`;
      const folder = element('button', 'memory-folder-card');
      folder.setAttribute('aria-label', `Mở thư mục ${label}`);
      folder.dataset.memoryScope = scope;
      folder.append(element('span', 'memory-folder-icon', '▰'));
      const meta = element('span', 'memory-folder-meta');
      meta.append(element('strong', '', label), element('small', '', description));
      folder.append(meta, element('span', 'memory-folder-count', `${groupFiles.length} file${groupFiles.length === 1 ? '' : 's'}`));
      folder.addEventListener('click', async () => {
        state.artifactFolder = folder.dataset.memoryScope;
        state.artifactPath = null;
        state.artifactContent = '';
        const firstFile = (groups.get(state.artifactFolder) || []).slice().sort()[0];
        if (firstFile) {
          state.artifactPath = firstFile;
          try {
            const data = await request(`/api/artifacts?path=${encodeURIComponent(firstFile)}`);
            state.artifactContent = data.content ?? `File ${data.size} bytes. Xem bằng ứng dụng phù hợp trong workspace.`;
          } catch (error) { toast(error.message); }
        }
        renderArtifacts().catch(error => toast(error.message));
      });
      folders.append(folder);
    }
    wrap.append(folders);
    content.replaceChildren(wrap);
    return;
  }
  const [scope, groupFiles] = [state.artifactFolder, groups.get(state.artifactFolder).sort()];
  const label = scope === 'global' ? 'global' : scope;
  const breadcrumb = element('div', 'memory-breadcrumb');
  const back = element('button', 'small-button secondary memory-back', '← Agent memories');
  back.addEventListener('click', () => { state.artifactFolder = null; state.artifactPath = null; renderArtifacts().catch(error => toast(error.message)); });
  breadcrumb.append(back, element('span', '', `agent_memories / ${label}`));
  const groupList = element('div', 'memory-folder-files doc-list');
  for (const file of groupFiles) {
    const button = element('button', `doc-card ${state.artifactPath === file ? 'active' : ''}`, `▱  ${file.split('/').at(-1)}`);
    button.title = file;
    button.addEventListener('click', async () => {
      state.artifactPath = file;
      state.artifactContent = '';
      try {
        const data = await request(`/api/artifacts?path=${encodeURIComponent(file)}`);
        state.artifactContent = data.content ?? `File ${data.size} bytes. Xem bằng ứng dụng phù hợp trong workspace.`;
        await renderArtifacts();
      } catch (error) { toast(error.message); }
    });
    groupList.append(button);
  }
  const browser = element('div', 'memory-browser');
  const preview = element('section', 'memory-preview');
  if (state.artifactPath && groupFiles.includes(state.artifactPath)) {
    const fileName = state.artifactPath.split('/').at(-1);
    preview.append(element('div', 'memory-preview-heading', fileName));
    preview.append(element('div', 'memory-preview-path', state.artifactPath));
    preview.append(element('pre', 'artifact-viewer', state.artifactContent || 'Đang tải nội dung Markdown…'));
  } else {
    preview.append(element('div', 'memory-preview-empty', 'Chọn một file Markdown để xem nội dung.'));
  }
  browser.append(groupList, preview);
  wrap.append(breadcrumb, browser);
  content.replaceChildren(wrap);
}

function gitPanel(title, value, empty = 'Không có dữ liệu.') {
  const panel = element('section', 'git-panel');
  panel.append(element('strong', '', title), element('pre', 'artifact-viewer', value || empty));
  return panel;
}

async function renderGit() {
  const wrap = viewFrame('MÃ NGUỒN', 'Git diff', 'Thông tin chỉ đọc về Git repository của game workspace.');
  const data = await request('/api/git');
  if (!data.repository) {
    wrap.append(element('div', 'empty-state', `${data.message} Khởi tạo Git trong game-workspace để xem branch, diff và commit.`));
    return content.replaceChildren(wrap);
  }
  const meta = element('div', 'git-meta');
  meta.append(element('span', 'git-chip', `Branch: ${data.branch}`));
  if (data.remote) meta.append(element('span', 'git-chip', `Origin: ${data.remote}`));
  wrap.append(meta, gitPanel('Working tree', data.status, 'Working tree sạch.'));
  if (data.diff) wrap.append(gitPanel('Thay đổi chưa stage', data.diff));
  if (data.stagedDiff) wrap.append(gitPanel('Thay đổi đã stage', data.stagedDiff));
  const commitText = data.commits.map(commit => `${commit.hash}  ${commit.date}  ${commit.subject} — ${commit.author}`).join('\n');
  wrap.append(gitPanel('5 commit gần nhất', commitText));
  content.replaceChildren(wrap);
}

async function renderPreviews() {
  const wrap = viewFrame('CHẠY TRONG DOCKER', 'Previews', 'Mỗi web project có manifest hợp lệ sẽ được chạy trong container riêng và nhận port local 5 chữ số. Port forward chỉ được tạo khi bạn bấm yêu cầu.');
  const [data, tunnelData] = await Promise.all([request('/api/previews'), request('/api/tunnels')]);
  const tunnels = new Map((tunnelData.tunnels || []).map(tunnel => [tunnel.projectId, tunnel]));
  const cards = element('div', 'cards');
  if (!data.previews.length) {
    cards.append(element('div', 'empty-state', 'Chưa có preview. Developer cần tạo projects/<tên>/enthstudio.project.json cùng index.html.'));
  }
  for (const preview of data.previews) {
    const card = element('article', `preview-card ${preview.status}`);
    const main = element('div', 'task-main');
    const tunnel = tunnels.get(preview.id);
    main.append(element('strong', '', preview.name), element('small', '', preview.status === 'running' ? `Docker · port ${preview.port} · ${fmtTime(preview.updatedAt)}` : preview.error || 'Không thể chạy preview'));
    if (tunnel?.status === 'starting') main.append(element('small', 'tunnel-status', 'Đang tạo Cloudflare Quick Tunnel…'));
    if (tunnel?.status === 'failed') main.append(element('small', 'tunnel-status failed', tunnel.error || 'Không tạo được port forward'));
    card.append(main);
    if (preview.status === 'running' && preview.url) {
      const link = element('a', 'preview-url', 'Mở preview ↗');
      link.href = preview.url; link.target = '_blank'; link.rel = 'noreferrer';
      card.append(link);
      if (tunnel?.status === 'running' && tunnel.url) {
        const publicLink = element('a', 'preview-url tunnel-url', 'Mở public ↗');
        publicLink.href = tunnel.url; publicLink.target = '_blank'; publicLink.rel = 'noreferrer';
        card.append(publicLink);
      }
      const tunnelButton = element('button', 'small-button secondary', tunnel?.status === 'running' ? 'Dừng port forward' : tunnel?.status === 'starting' ? 'Đang tạo…' : 'Port forward');
      tunnelButton.disabled = tunnel?.status === 'starting';
      tunnelButton.addEventListener('click', async () => {
        tunnelButton.disabled = true;
        try {
          if (tunnel?.status === 'running' || tunnel?.status === 'starting') {
            await request(`/api/tunnels/${encodeURIComponent(preview.id)}`, { method: 'DELETE' });
            toast('Đã dừng port forward');
          } else {
            await request('/api/tunnels', { method: 'POST', body: JSON.stringify({ projectId: preview.id }) });
            toast('Cloudflare Quick Tunnel đã sẵn sàng');
          }
          await renderPreviews();
        } catch (error) {
          toast(error.message);
          tunnelButton.disabled = false;
        }
      });
      card.append(tunnelButton);
    }
    cards.append(card);
  }
  wrap.append(cards);
  content.replaceChildren(wrap);
}

function render() {
  if (isChat()) return renderChat();
  if (state.view === 'tasks') return renderTasks();
  if (state.view === 'runs') return renderRuns();
  if (state.view === 'agents') return renderAgents();
  if (state.view === 'documents') return renderDocuments().catch(error => toast(error.message));
  if (state.view === 'artifacts') return renderArtifacts().catch(error => toast(error.message));
  if (state.view === 'git') return renderGit().catch(error => toast(error.message));
  if (state.view === 'previews') return renderPreviews().catch(error => toast(error.message));
  if (state.view === 'settings') return renderSettings().catch(error => toast(error.message));
}

async function refreshBootstrap() {
  const data = await request('/api/bootstrap');
  state.channels = data.channels; state.agents = data.agents; state.tasks = data.tasks; state.auth = data.auth;
  renderNavigation(); renderMembers(); renderHeader();
  updateMentionSuggestions();
  if (!state.channels.find(channel => channel.id === state.view) && !['tasks','runs','agents','documents','artifacts','git','previews','settings'].includes(state.view) && !selectedTask()) {
    setView('general');
  } else if (state.view === 'tasks') {
    renderTasks();
  }
}

async function refreshMessages(initial = false) {
  if (!isChat()) return;
  const view = state.view;
  const task = selectedTask();
  const channel = currentChannel().id;
  const data = await request(`/api/messages?channel=${encodeURIComponent(channel)}${task ? `&task=${task.id}` : ''}`);
  if (state.view !== view) return;
  const lastOld = state.messages.at(-1)?.id;
  const lastNew = data.messages.at(-1)?.id;
  state.messages = data.messages;
  if (initial || lastOld !== lastNew) renderChat();
}

async function refreshJobs() {
  const before = typingSignature();
  const data = await request('/api/jobs'); state.jobs = data.jobs;
  if (state.view === 'runs') renderRuns();
  else if (isChat() && before !== typingSignature()) updateTypingIndicator();
}

async function refreshDocuments() { if (state.view === 'documents') await renderDocuments(); }
async function refreshSettings() { if (state.view === 'settings') await renderSettings(); }

document.addEventListener('click', event => {
  const item = event.target.closest('[data-view]');
  if (item) setView(item.dataset.view);
});
mobileNav.addEventListener('change', event => setView(event.target.value));
document.querySelector('#refresh-button').addEventListener('click', async () => {
  try { await refreshBootstrap(); await refreshMessages(); await refreshJobs(); toast('Đã làm mới'); } catch (error) { toast(error.message); }
});
composer.addEventListener('submit', async event => {
  event.preventDefault();
  const body = input.value.trim();
  if (!body) return;
  const send = document.querySelector('#send-button'); send.disabled = true;
  document.querySelector('#send-state').textContent = 'Đang gửi…';
  try {
    await request('/api/messages', { method:'POST', body:JSON.stringify({ channel:currentChannel().id, taskId:selectedTask()?.id, body }) });
    input.value = ''; input.style.height = '';
    await refreshMessages(); await refreshBootstrap();
  } catch (error) { toast(error.message); }
  finally { send.disabled = false; document.querySelector('#send-state').textContent = ''; }
});
input.addEventListener('keydown', event => {
  if (!mentionSuggestions.hidden && mentionItems.length) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      mentionIndex = (mentionIndex + 1) % mentionItems.length;
      renderMentionSuggestions();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      mentionIndex = (mentionIndex - 1 + mentionItems.length) % mentionItems.length;
      renderMentionSuggestions();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideMentionSuggestions();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      chooseMention();
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); }
});
input.addEventListener('input', () => {
  input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  updateMentionSuggestions();
});
input.addEventListener('click', updateMentionSuggestions);
input.addEventListener('keyup', updateMentionSuggestions);
document.addEventListener('click', event => {
  if (!event.target.closest('#composer')) hideMentionSuggestions();
});

state.view = (location.hash || '#general').slice(1);
refreshBootstrap().then(() => {
  setView(state.view);
  return refreshJobs();
}).catch(error => toast(error.message));
setInterval(() => { refreshMessages().catch(() => {}); refreshJobs().catch(() => {}); }, 2500);
setInterval(() => refreshBootstrap().catch(() => {}), 10_000);
