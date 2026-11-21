const API_BASE = './api';
const THEME_KEY = 'sealdice-logs-color-scheme';
const POLL_INTERVAL_MS = 5000;

const SYSTEM_LABELS = {
  coc7: '克苏鲁的呼唤 7版',
  dnd5e: '龙与地下城 5E',
  dx3: '双重十字 3',
  sw: '剑世界',
  shinobigami: '忍神',
  insane: 'inSANe',
  pf2e: '开拓者 2E',
  fate: 'Fate',
  wod: '黑暗世界',
  general: '通用规则',
};

const SPEAKER_PALETTE = [
  'light-dark(#0f766e, #2dd4bf)',
  'light-dark(#1d4ed8, #60a5fa)',
  'light-dark(#7c3aed, #a78bfa)',
  'light-dark(#be185d, #f472b6)',
  'light-dark(#b45309, #fbbf24)',
  'light-dark(#047857, #34d399)',
  'light-dark(#0369a1, #38bdf8)',
  'light-dark(#9333ea, #c084fc)',
];

const state = {
  authenticated: false,
  activeTab: 'reader',
  publicOrigin: null,
  groups: [],
  logs: [],
  logsTotal: 0,
  logsOffset: 0,
  logSearch: '',
  selectedGroupFilter: '',
  activeOnly: false,
  activeLog: null,
  messages: [],
  firstId: null,
  lastId: null,
  nextCursorId: null,
  hasOlder: false,
  scannedCount: 0,
  filteredOut: { ooc: 0, ic: 0, dice: 0, speaker: 0, query: 0 },
  msgFilterMode: 'all',
  includeDice: true,
  speakerFilter: '',
  timePreset: 'all',
  customStart: '',
  customEnd: '',
  msgQuery: '',
  autoPoll: false,
  pollTimer: null,
  pollInFlight: false,
  participantsCache: new Map(),
  links: [],
  editingLinkId: null,
  scopePickerTab: 'groups',
  scopeSelectedGroups: new Set(),
  scopeSelectedLogs: new Set(),
  scopeSearch: '',
  scopeLogsCatalog: [],
  guideLink: null,
};

const $ = (id) => document.getElementById(id);

/* ========= 工具函数 ========= */
function toast(message, isError = false) {
  const region = $('toast-region');
  const el = document.createElement('div');
  el.className = `toast${isError ? ' is-error' : ''}`;
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function copyText(text, successMsg = '已复制到剪贴板') {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMsg);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      toast(successMsg);
    } catch {
      toast('复制失败，请手动选中复制', true);
    } finally {
      area.remove();
    }
  }
}

function formatSystem(sys) {
  if (!sys) return '';
  const key = String(sys).toLowerCase();
  return SYSTEM_LABELS[key] || sys;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

function formatRelativeUnix(sec) {
  if (!sec) return '未知时间';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return formatDateShort(sec);
}

function formatDateShort(sec) {
  const d = new Date(sec * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDateTime(value) {
  if (!value) return '从未';
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(d.getTime())) return '未知';
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTimeHms(sec) {
  const d = new Date(sec * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function speakerColor(name) {
  const text = String(name || '匿名');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return SPEAKER_PALETTE[Math.abs(hash) % SPEAKER_PALETTE.length];
}

function firstChar(name) {
  const trimmed = String(name || '?').trim();
  return Array.from(trimmed)[0] || '?';
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    showLogin();
    throw new Error('会话已过期，请重新登录');
  }
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const errMsg = typeof data === 'object' && data?.error ? data.error : `请求失败 (${res.status})`;
    throw new Error(errMsg);
  }
  return data;
}

/* ========= 主题切换（遵循 dark-mode-toggle） ========= */
function getMetaColorScheme() {
  return document.querySelector('meta[name="color-scheme"]');
}

function getSystemScheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyThemeOverride(value) {
  const meta = getMetaColorScheme();
  if (meta) {
    meta.content = value === 'light' || value === 'dark' ? value : 'light dark';
  }
}

function toggleTheme() {
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch {}
  const system = getSystemScheme();
  const currentRendered = stored === 'light' || stored === 'dark' ? stored : system;
  const target = currentRendered === 'dark' ? 'light' : 'dark';
  if (target === system) {
    try { localStorage.removeItem(THEME_KEY); } catch {}
    applyThemeOverride(null);
  } else {
    try { localStorage.setItem(THEME_KEY, target); } catch {}
    applyThemeOverride(target);
  }
}

window.addEventListener('storage', (event) => {
  if (event.key === THEME_KEY) {
    applyThemeOverride(event.newValue);
  }
});

/* ========= Dialog 顶层动画与回退（遵循 light-dismiss + animate-to-from-top-layer） ========= */
let cachedDisplayTransition;
function canTransitionDisplay() {
  if (cachedDisplayTransition !== undefined) return cachedDisplayTransition;
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  cachedDisplayTransition = getComputedStyle(probe).display === 'block';
  probe.remove();
  return cachedDisplayTransition;
}

function supportsTopLayerExit() {
  return Boolean(window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay());
}

async function closeDialog(dialog) {
  if (!dialog || !dialog.open) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute('data-closing', '');
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    }
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }
  dialog.close();
}

function setupModalDialog(dialog) {
  if (!dialog) return;
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside = rect.top <= event.clientY && event.clientY <= rect.top + rect.height
        && rect.left <= event.clientX && event.clientX <= rect.left + rect.width;
      if (!inside) void closeDialog(dialog);
    });
  }
  dialog.addEventListener('cancel', (event) => {
    if (!supportsTopLayerExit()) {
      event.preventDefault();
      void closeDialog(dialog);
    }
  });
}

/* ========= 鉴权与视图切换 ========= */
function showLogin() {
  stopAutoPoll();
  state.authenticated = false;
  $('app-shell').hidden = true;
  $('login-view').hidden = false;
  $('login-password').focus();
}

async function showApp() {
  state.authenticated = true;
  $('login-view').hidden = true;
  $('app-shell').hidden = false;
  await Promise.all([loadOverview(), loadGroups(), loadLogs(true), loadLinks()]);
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });
  $('tab-reader').hidden = tab !== 'reader';
  $('tab-links').hidden = tab !== 'links';
  if (tab === 'links') {
    void loadOverview();
    void loadLinks();
  }
}

function setMobileSidebarOpen(open) {
  $('log-sidebar').classList.toggle('is-open', open);
  $('sidebar-backdrop').hidden = !open;
}

/* ========= 数据加载：总览 / 群 / 日志目录 ========= */
async function loadOverview() {
  try {
    const data = await apiFetch('/overview');
    state.publicOrigin = data.publicOrigin || null;
    const { stats, links } = data;
    $('stat-total-logs').textContent = formatNumber(stats.totalLogs);
    $('stat-active-recording').textContent = `${formatNumber(stats.activeRecordingCount)} 个群正在记录中`;
    $('stat-total-messages').textContent = formatNumber(stats.totalMessages);
    $('stat-group-count').textContent = `覆盖 ${formatNumber(stats.groupCount)} 个群聊`;
    $('stat-enabled-links').textContent = formatNumber(links.enabled);
    $('stat-total-links').textContent = `共 ${formatNumber(links.total)} 条已签发链接`;
    $('stat-total-calls').textContent = formatNumber(links.totalCalls);
    $('stat-latest-activity').textContent = stats.latestMessageAt
      ? `最新写入：${formatRelativeUnix(stats.latestMessageAt)}`
      : '暂无消息写入';
    $('nav-links-badge').textContent = String(links.enabled);

    const pill = $('recording-pill');
    if (stats.activeRecordingCount > 0) {
      $('recording-pill-text').textContent = `${stats.activeRecordingCount} 个团记录中`;
      pill.hidden = false;
    } else {
      pill.hidden = true;
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadGroups() {
  try {
    const data = await apiFetch('/groups');
    state.groups = data.items || [];
    const select = $('group-filter-select');
    const prev = state.selectedGroupFilter;
    select.innerHTML = '<option value="">全部群聊</option>';
    for (const g of state.groups) {
      const opt = document.createElement('option');
      opt.value = g.group_id;
      opt.textContent = `${g.display_name} (${g.log_count})`;
      select.appendChild(opt);
    }
    select.value = prev;
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadLogs(reset = true) {
  if (reset) {
    state.logsOffset = 0;
  }
  const params = new URLSearchParams();
  params.set('limit', '40');
  params.set('offset', String(state.logsOffset));
  if (state.logSearch.trim()) params.set('q', state.logSearch.trim());
  if (state.selectedGroupFilter) params.set('group_id', state.selectedGroupFilter);
  if (state.activeOnly) params.set('active_only', '1');

  try {
    const data = await apiFetch(`/logs?${params.toString()}`);
    state.logsTotal = data.total;
    const incoming = data.items || [];
    state.logs = reset ? incoming : [...state.logs, ...incoming];
    state.logsOffset = state.logs.length;
    renderLogList();

    if (reset && !state.activeLog && state.logs.length > 0) {
      void selectLog(state.logs[0]);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function renderLogList() {
  const list = $('log-list');
  $('sidebar-count-text').textContent = `共 ${formatNumber(state.logsTotal)} 份日志`;
  list.innerHTML = '';

  if (state.logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'message-empty';
    empty.textContent = '没有找到符合条件的跑团日志';
    list.appendChild(empty);
    $('log-list-footer').hidden = true;
    return;
  }

  for (const log of state.logs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `log-item${state.activeLog?.id === log.id ? ' is-selected' : ''}`;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(state.activeLog?.id === log.id));

    const top = document.createElement('div');
    top.className = 'log-item-top';
    const nameEl = document.createElement('span');
    nameEl.className = 'log-item-name';
    nameEl.textContent = log.name || `日志 #${log.id}`;
    const timeEl = document.createElement('span');
    timeEl.className = 'log-item-time';
    timeEl.textContent = formatRelativeUnix(log.updated_at);
    top.append(nameEl, timeEl);

    const bottom = document.createElement('div');
    bottom.className = 'log-item-bottom';
    const groupEl = document.createElement('span');
    groupEl.className = 'log-item-group';
    groupEl.textContent = log.display_group_name;

    const badges = document.createElement('span');
    badges.className = 'log-item-badges';
    if (log.is_recording) {
      const live = document.createElement('span');
      live.className = 'badge badge-live';
      live.textContent = '记录中';
      badges.appendChild(live);
    }
    const count = document.createElement('span');
    count.className = 'badge badge-neutral';
    count.textContent = `${formatNumber(log.size)} 条`;
    badges.appendChild(count);

    bottom.append(groupEl, badges);
    btn.append(top, bottom);
    btn.addEventListener('click', () => {
      setMobileSidebarOpen(false);
      void selectLog(log);
    });
    list.appendChild(btn);
  }

  $('log-list-footer').hidden = state.logs.length >= state.logsTotal;
}

/* ========= 单份日志阅览与消息流 ========= */
function buildMessageQueryParams(extra = {}) {
  const params = new URLSearchParams();
  params.set('filter_mode', state.msgFilterMode);
  params.set('include_dice', state.includeDice ? '1' : '0');
  params.set('limit', String(extra.limit || 100));

  if (state.speakerFilter) params.set('speaker', state.speakerFilter);
  if (state.msgQuery.trim()) params.set('q', state.msgQuery.trim());

  if (state.timePreset === '30' || state.timePreset === '120') {
    params.set('last_minutes', state.timePreset);
  } else if (state.timePreset === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    params.set('start_time', String(Math.floor(start.getTime() / 1000)));
  } else if (state.timePreset === 'custom') {
    if (state.customStart) params.set('start_time', String(Math.floor(new Date(state.customStart).getTime() / 1000)));
    if (state.customEnd) params.set('end_time', String(Math.floor(new Date(state.customEnd).getTime() / 1000)));
  }

  if (extra.after_id) params.set('after_id', String(extra.after_id));
  if (extra.before_id) params.set('before_id', String(extra.before_id));
  return params;
}

async function selectLog(log) {
  state.activeLog = log;
  state.speakerFilter = '';
  $('speaker-filter-select').value = '';
  renderLogList();

  $('reader-empty').hidden = true;
  $('reader-active').hidden = false;
  $('active-log-name').textContent = log.name || `日志 #${log.id}`;
  $('active-log-live').hidden = !log.is_recording;
  const sysText = formatSystem(log.system);
  $('active-log-system').hidden = !sysText;
  $('active-log-system').textContent = sysText;
  $('active-log-group').textContent = log.display_group_name;
  $('active-log-stats').textContent = `日志 #${log.id} · 共 ${formatNumber(log.size)} 条 · 更新于 ${formatDateTime(log.updated_at)}`;

  await Promise.all([loadMessages({ mode: 'initial' }), loadSpeakerOptions(log.id)]);
}

async function loadSpeakerOptions(logId) {
  try {
    const data = await apiFetch(`/logs/${logId}/participants`);
    state.participantsCache.set(logId, data);
    if (state.activeLog?.id !== logId) return;
    const select = $('speaker-filter-select');
    const prev = state.speakerFilter;
    select.innerHTML = '<option value="">全部发言人</option>';
    for (const p of data.participants || []) {
      const opt = document.createElement('option');
      opt.value = p.nickname;
      opt.textContent = `${p.nickname} (${p.total})`;
      select.appendChild(opt);
    }
    select.value = prev;
  } catch {
    // 发言人下拉加载失败不阻断正文阅读
  }
}

async function loadMessages({ mode = 'initial' } = {}) {
  if (!state.activeLog) return;
  const logId = state.activeLog.id;
  const scrollEl = $('message-scroll');

  try {
    if (mode === 'older') {
      if (!state.firstId) return;
      const prevHeight = scrollEl.scrollHeight;
      const prevTop = scrollEl.scrollTop;
      const params = buildMessageQueryParams({ before_id: state.firstId, limit: 100 });
      const data = await apiFetch(`/logs/${logId}/messages?${params.toString()}`);
      if (state.activeLog?.id !== logId) return;
      const incoming = data.items || [];
      const existingIds = new Set(state.messages.map((m) => m.id));
      const fresh = incoming.filter((m) => !existingIds.has(m.id));
      state.messages = [...fresh, ...state.messages];
      state.firstId = data.first_id ?? state.firstId;
      state.hasOlder = Boolean(data.has_older);
      renderMessages();
      scrollEl.scrollTop = prevTop + (scrollEl.scrollHeight - prevHeight);
      updateStatusbar();
      return;
    }

    if (mode === 'incremental') {
      if (!state.nextCursorId) {
        await loadMessages({ mode: 'initial' });
        return;
      }
      const nearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120;
      const params = buildMessageQueryParams({ after_id: state.nextCursorId, limit: 150 });
      const data = await apiFetch(`/logs/${logId}/messages?${params.toString()}`);
      if (state.activeLog?.id !== logId) return;
      const incoming = data.items || [];
      if (data.next_cursor_id && (!state.nextCursorId || data.next_cursor_id > state.nextCursorId)) {
        state.nextCursorId = data.next_cursor_id;
      }
      if (incoming.length > 0) {
        const existingIds = new Set(state.messages.map((m) => m.id));
        const fresh = incoming.filter((m) => !existingIds.has(m.id));
        if (fresh.length > 0) {
          state.messages = [...state.messages, ...fresh];
          state.lastId = fresh[fresh.length - 1].id;
          if (!state.firstId) state.firstId = fresh[0].id;
          renderMessages();
          if (nearBottom) {
            scrollEl.scrollTop = scrollEl.scrollHeight;
          } else {
            $('jump-bottom-btn').hidden = false;
            toast(`新增 ${fresh.length} 条跑团消息`);
          }
        }
      }
      updateStatusbar();
      return;
    }

    // initial reload
    const params = buildMessageQueryParams({ limit: 120 });
    const data = await apiFetch(`/logs/${logId}/messages?${params.toString()}`);
    if (state.activeLog?.id !== logId) return;
    state.messages = data.items || [];
    state.firstId = data.first_id;
    state.lastId = data.last_id;
    state.nextCursorId = data.next_cursor_id;
    state.hasOlder = Boolean(data.has_older);
    state.scannedCount = data.scanned_count || 0;
    state.filteredOut = data.filtered_out || { ooc: 0, ic: 0, dice: 0, speaker: 0, query: 0 };
    renderMessages();
    updateStatusbar();
    scrollEl.scrollTop = scrollEl.scrollHeight;
    $('jump-bottom-btn').hidden = true;
  } catch (err) {
    toast(err.message, true);
  }
}

function renderMessageBody(container, text) {
  const tokenRe = /(\[(?:图片|语音|视频|表情|回复|合并转发|@[^\]]+)\])/g;
  const parts = String(text || '').split(tokenRe);
  for (const part of parts) {
    if (!part) continue;
    if (tokenRe.test(part)) {
      const chip = document.createElement('span');
      chip.className = 'cq-chip';
      chip.textContent = part;
      container.appendChild(chip);
    } else {
      container.appendChild(document.createTextNode(part));
    }
    tokenRe.lastIndex = 0;
  }
}

function renderMessages() {
  const list = $('message-list');
  list.innerHTML = '';
  $('load-older-wrap').hidden = !state.hasOlder;
  $('message-empty').hidden = state.messages.length > 0;

  let prevDay = '';
  const total = state.messages.length;
  // 首屏底部可见约 15 条不施加 content-visibility: auto，避免影响首屏滚动落点与初始渲染
  const deferBeforeIndex = Math.max(0, total - 15);

  const frag = document.createDocumentFragment();
  state.messages.forEach((msg, index) => {
    const day = formatDateShort(msg.time);
    if (day !== prevDay) {
      prevDay = day;
      const div = document.createElement('div');
      div.className = 'day-divider';
      div.textContent = day;
      frag.appendChild(div);
    }

    const row = document.createElement('article');
    const isOoc = msg.channel === 'ooc';
    const isDice = msg.kind === 'dice_result' || msg.kind === 'dice_command';
    row.className = `msg-row${isOoc ? ' is-ooc' : ''}${isDice ? ' is-dice' : ''}${index < deferBeforeIndex ? ' is-deferred' : ''}`;
    row.style.setProperty('--speaker-color', speakerColor(msg.nickname));

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = isDice && msg.kind === 'dice_result' ? '骰' : firstChar(msg.nickname);

    const main = document.createElement('div');
    main.className = 'msg-main';

    const head = document.createElement('div');
    head.className = 'msg-head';

    const speakerBtn = document.createElement('button');
    speakerBtn.type = 'button';
    speakerBtn.className = 'msg-speaker';
    speakerBtn.textContent = msg.nickname || '未命名角色';
    speakerBtn.title = '点击仅看该角色发言';
    speakerBtn.addEventListener('click', () => {
      state.speakerFilter = state.speakerFilter === msg.nickname ? '' : msg.nickname;
      $('speaker-filter-select').value = state.speakerFilter;
      void loadMessages({ mode: 'initial' });
    });
    head.appendChild(speakerBtn);

    if (isOoc) {
      const tag = document.createElement('span');
      tag.className = 'msg-kind-tag tag-ooc';
      tag.textContent = '场外';
      head.appendChild(tag);
    } else if (msg.kind === 'dice_result') {
      const tag = document.createElement('span');
      tag.className = 'msg-kind-tag tag-dice';
      tag.textContent = '检定';
      head.appendChild(tag);
    } else if (msg.kind === 'dice_command') {
      const tag = document.createElement('span');
      tag.className = 'msg-kind-tag tag-dice';
      tag.textContent = '指令';
      head.appendChild(tag);
    }

    const timeEl = document.createElement('span');
    timeEl.className = 'msg-time';
    timeEl.textContent = formatTimeHms(msg.time);
    timeEl.title = formatDateTime(msg.time);
    head.appendChild(timeEl);

    const idBtn = document.createElement('button');
    idBtn.type = 'button';
    idBtn.className = 'msg-id-btn';
    idBtn.textContent = `#${msg.id}`;
    idBtn.title = '点击复制消息游标 ID';
    idBtn.addEventListener('click', () => {
      void copyText(String(msg.id), `已复制消息游标 #${msg.id}`);
    });
    head.appendChild(idBtn);

    const body = document.createElement('p');
    body.className = 'msg-body';
    renderMessageBody(body, msg.message);

    main.append(head, body);
    row.append(avatar, main);
    frag.appendChild(row);
  });

  list.appendChild(frag);
}

function updateStatusbar() {
  $('statusbar-summary').textContent = `当前展示 ${formatNumber(state.messages.length)} 条`;
  const f = state.filteredOut || {};
  const skips = [];
  if (f.ooc > 0) skips.push(`已隐藏 ${f.ooc} 条场外`);
  if (f.ic > 0) skips.push(`已隐藏 ${f.ic} 条场内`);
  if (f.dice > 0) skips.push(`已隐藏 ${f.dice} 条掷骰`);
  $('statusbar-filtered').textContent = skips.join(' · ');

  const cursorEl = $('statusbar-cursor');
  if (state.nextCursorId) {
    cursorEl.textContent = `最新游标 #${state.nextCursorId}`;
    cursorEl.hidden = false;
  } else {
    cursorEl.hidden = true;
  }
}

function stopAutoPoll() {
  state.autoPoll = false;
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  const btn = $('auto-poll-btn');
  if (btn) {
    btn.classList.remove('is-active');
    btn.setAttribute('aria-pressed', 'false');
  }
}

function toggleAutoPoll() {
  if (state.autoPoll) {
    stopAutoPoll();
    toast('已关闭自动追踪');
    return;
  }
  state.autoPoll = true;
  const btn = $('auto-poll-btn');
  btn.classList.add('is-active');
  btn.setAttribute('aria-pressed', 'true');
  toast('已开启自动追踪（每 5 秒同步新发言）');
  state.pollTimer = setInterval(async () => {
    if (!state.authenticated || state.activeTab !== 'reader' || !state.activeLog || state.pollInFlight) return;
    state.pollInFlight = true;
    try {
      await loadMessages({ mode: 'incremental' });
    } finally {
      state.pollInFlight = false;
    }
  }, POLL_INTERVAL_MS);
}

async function copyFilteredTranscript() {
  if (!state.activeLog) return;
  if (state.messages.length === 0) {
    toast('当前筛选结果为空', true);
    return;
  }
  const lines = state.messages.map((m) => {
    const tag = m.channel === 'ooc' ? '场外' : (m.kind === 'dice_result' ? '检定' : '场内');
    return `[${formatDateTime(m.time)} | ${tag}] ${m.nickname}: ${m.message}`;
  });
  await copyText(lines.join('\n'), `已复制 ${lines.length} 条筛选记录`);
}

function exportFilteredTxt() {
  if (!state.activeLog) return;
  const params = buildMessageQueryParams({ limit: 5000 });
  params.set('format', 'txt');
  params.set('download', '1');
  window.open(`${API_BASE}/logs/${state.activeLog.id}/export?${params.toString()}`, '_blank', 'noopener');
}

async function openParticipantsDialog() {
  if (!state.activeLog) return;
  const dialog = $('participants-dialog');
  $('participants-dialog-subtitle').textContent = `${state.activeLog.name} · 点击任意角色可快速筛选其发言`;
  $('participants-breakdown').innerHTML = '';
  $('participants-list').innerHTML = '<div class="muted-text">正在统计…</div>';
  dialog.showModal();

  try {
    const data = await apiFetch(`/logs/${state.activeLog.id}/participants`);
    state.participantsCache.set(state.activeLog.id, data);
    const b = data.breakdown || {};
    const cells = [
      ['总消息数', data.total],
      ['场内台词', b.dialogue || 0],
      ['场外发言', b.ooc || 0],
      ['掷骰与检定', (b.dice_result || 0) + (b.dice_command || 0)],
    ];
    $('participants-breakdown').innerHTML = cells.map(([label, val]) => `
      <div class="breakdown-cell">
        <span>${label}</span>
        <strong>${formatNumber(val)}</strong>
      </div>
    `).join('');

    const listEl = $('participants-list');
    listEl.innerHTML = '';
    for (const p of data.participants || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'participant-row';
      const name = document.createElement('span');
      name.className = 'participant-name';
      name.textContent = p.nickname || '未命名角色';
      name.style.color = speakerColor(p.nickname);
      const counts = document.createElement('span');
      counts.className = 'participant-counts';
      counts.textContent = `总 ${p.total} · 场内 ${p.ic} · 场外 ${p.ooc} · 骰 ${p.dice}`;
      btn.append(name, counts);
      btn.addEventListener('click', () => {
        state.speakerFilter = p.nickname;
        $('speaker-filter-select').value = p.nickname;
        void closeDialog(dialog);
        void loadMessages({ mode: 'initial' });
      });
      listEl.appendChild(btn);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

/* ========= MCP 链接管理与分级 Scope ========= */
async function loadLinks() {
  try {
    const data = await apiFetch('/links');
    state.links = data.items || [];
    const activeCount = state.links.filter((l) => l.enabled && !l.expired).length;
    $('nav-links-badge').textContent = String(activeCount);
    renderLinks();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderLinks() {
  const list = $('links-list');
  list.innerHTML = '';
  if (state.links.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-stage';
    empty.innerHTML = '<h2>尚未签发 MCP 接入链接</h2><p>点击右上角「新建 MCP 链接」，即可生成带独立令牌和访问范围的接入地址。</p>';
    list.appendChild(empty);
    return;
  }

  for (const link of state.links) {
    const card = document.createElement('article');
    card.className = 'link-card';

    const head = document.createElement('div');
    head.className = 'link-card-head';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'link-card-title';
    const h3 = document.createElement('h3');
    h3.textContent = link.label;
    titleWrap.appendChild(h3);

    const statusBadge = document.createElement('span');
    if (link.expired) {
      statusBadge.className = 'badge badge-warn';
      statusBadge.textContent = '已过期';
    } else if (link.enabled) {
      statusBadge.className = 'badge badge-live';
      statusBadge.textContent = '启用中';
    } else {
      statusBadge.className = 'badge badge-neutral';
      statusBadge.textContent = '已停用';
    }
    titleWrap.appendChild(statusBadge);

    const scopeBadge = document.createElement('span');
    if (link.scope?.type === 'restricted') {
      const gCount = link.scope.group_ids?.length || 0;
      const lCount = link.scope.log_ids?.length || 0;
      const parts = [];
      if (gCount > 0) parts.push(`${gCount} 个群`);
      if (lCount > 0) parts.push(`${lCount} 份日志`);
      scopeBadge.className = 'badge badge-accent';
      scopeBadge.textContent = parts.length > 0 ? `限定：${parts.join(' + ')}` : '限定范围（空）';
    } else {
      scopeBadge.className = 'badge badge-neutral';
      scopeBadge.textContent = '全部日志';
    }
    titleWrap.appendChild(scopeBadge);

    const actions = document.createElement('div');
    actions.className = 'link-card-actions';

    const guideBtn = document.createElement('button');
    guideBtn.type = 'button';
    guideBtn.className = 'btn btn-secondary btn-sm';
    guideBtn.textContent = '接入指引';
    guideBtn.addEventListener('click', () => openGuideDialog(link));

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-secondary btn-sm';
    editBtn.textContent = '编辑范围';
    editBtn.addEventListener('click', () => void openLinkDialog(link));

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-secondary btn-sm';
    toggleBtn.textContent = link.enabled ? '停用' : '启用';
    toggleBtn.addEventListener('click', () => void toggleLinkEnabled(link));

    const rotateBtn = document.createElement('button');
    rotateBtn.type = 'button';
    rotateBtn.className = 'btn btn-secondary btn-sm';
    rotateBtn.textContent = '轮换令牌';
    rotateBtn.addEventListener('click', () => void rotateLink(link));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => void deleteLink(link));

    actions.append(guideBtn, editBtn, toggleBtn, rotateBtn, delBtn);
    head.append(titleWrap, actions);

    const urlBox = document.createElement('div');
    urlBox.className = 'link-url-box';
    const urlText = document.createElement('code');
    urlText.className = 'link-url-text';
    urlText.textContent = link.url;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-primary btn-sm';
    copyBtn.textContent = '复制链接';
    copyBtn.addEventListener('click', () => void copyText(link.url, '已复制 MCP 接入链接'));
    urlBox.append(urlText, copyBtn);

    card.append(head, urlBox);

    if (link.scope?.type === 'restricted') {
      const scopeRow = document.createElement('div');
      scopeRow.className = 'link-scope-row';
      const prefix = document.createElement('span');
      prefix.className = 'muted-text';
      prefix.textContent = '授权对象：';
      scopeRow.appendChild(prefix);

      for (const g of link.scope_labels?.groups || []) {
        const chip = document.createElement('span');
        chip.className = 'badge badge-accent';
        chip.textContent = `群：${g.display_name}`;
        scopeRow.appendChild(chip);
      }
      for (const l of link.scope_labels?.logs || []) {
        const chip = document.createElement('span');
        chip.className = 'badge badge-neutral';
        chip.textContent = `日志：${l.name}（${l.display_group_name}）`;
        scopeRow.appendChild(chip);
      }
      card.appendChild(scopeRow);
    }

    const meta = document.createElement('div');
    meta.className = 'link-meta-row';
    meta.innerHTML = [
      `调用次数：${formatNumber(link.call_count)}`,
      `最近使用：${link.last_used_at ? formatDateTime(link.last_used_at) : '尚未使用'}`,
      `有效期：${link.expires_at ? formatDateTime(link.expires_at) : '长期有效'}`,
      `创建于：${formatDateTime(link.created_at)}`,
    ].map((t) => `<span>${t}</span>`).join('');

    card.appendChild(meta);
    list.appendChild(card);
  }
}

async function ensureScopeLogsCatalog() {
  if (state.scopeLogsCatalog.length > 0) return;
  try {
    const data = await apiFetch('/logs?limit=200&offset=0');
    state.scopeLogsCatalog = data.items || [];
  } catch {
    state.scopeLogsCatalog = [...state.logs];
  }
}

async function openLinkDialog(editingLink = null) {
  state.editingLinkId = editingLink ? editingLink.id : null;
  $('link-dialog-title').textContent = editingLink ? '编辑 MCP 链接与范围' : '新建 MCP 链接';
  $('link-dialog-subtitle').textContent = editingLink
    ? '修改名称、有效期或访问范围后，现有旧会话将自动刷新权限'
    : '为自己、队友或特定跑团工作流签发独立接入地址';
  $('link-form-submit').textContent = editingLink ? '保存修改' : '保存并签发链接';
  $('link-form-error').hidden = true;

  $('link-label-input').value = editingLink ? editingLink.label : '';
  const expirySelect = $('link-expiry-select');
  const keepOpt = expirySelect.querySelector('option[value="keep"]');
  keepOpt.hidden = !editingLink;
  expirySelect.value = editingLink ? 'keep' : 'never';

  const scopeType = editingLink?.scope?.type === 'restricted' ? 'restricted' : 'all';
  document.querySelectorAll('input[name="scope_type"]').forEach((r) => {
    r.checked = r.value === scopeType;
  });

  state.scopeSelectedGroups = new Set(editingLink?.scope?.group_ids || []);
  state.scopeSelectedLogs = new Set((editingLink?.scope?.log_ids || []).map(Number));
  state.scopeSearch = '';
  $('scope-search-input').value = '';
  state.scopePickerTab = 'groups';

  updateScopePickerVisibility();
  $('link-dialog').showModal();
  await ensureScopeLogsCatalog();
  renderScopeLists();
}

function updateScopePickerVisibility() {
  const checked = document.querySelector('input[name="scope_type"]:checked')?.value || 'all';
  $('scope-picker-section').hidden = checked !== 'restricted';
}

function renderScopeLists() {
  $('selected-groups-count').textContent = String(state.scopeSelectedGroups.size);
  $('selected-logs-count').textContent = String(state.scopeSelectedLogs.size);

  document.querySelectorAll('.picker-tab').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.pickerTab === state.scopePickerTab);
  });
  $('scope-groups-list').hidden = state.scopePickerTab !== 'groups';
  $('scope-logs-list').hidden = state.scopePickerTab !== 'logs';

  const q = state.scopeSearch.trim().toLowerCase();

  // 渲染群列表
  const groupsWrap = $('scope-groups-list');
  groupsWrap.innerHTML = '';
  const filteredGroups = state.groups.filter((g) => !q
    || g.display_name.toLowerCase().includes(q)
    || g.group_id.toLowerCase().includes(q));

  for (const g of filteredGroups) {
    const label = document.createElement('label');
    label.className = 'scope-check-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.scopeSelectedGroups.has(g.group_id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.scopeSelectedGroups.add(g.group_id);
      else state.scopeSelectedGroups.delete(g.group_id);
      $('selected-groups-count').textContent = String(state.scopeSelectedGroups.size);
    });
    const main = document.createElement('div');
    main.className = 'scope-check-main';
    const t = document.createElement('div');
    t.className = 'scope-check-title';
    t.textContent = g.display_name;
    const sub = document.createElement('div');
    sub.className = 'scope-check-sub';
    sub.textContent = `${g.log_count} 份日志${g.log_on ? ' · 当前记录中' : ''}`;
    main.append(t, sub);
    label.append(cb, main);
    groupsWrap.appendChild(label);
  }
  if (filteredGroups.length === 0) {
    groupsWrap.innerHTML = '<div class="muted-text" style="padding:12px;text-align:center;">未匹配到群聊</div>';
  }

  // 渲染日志列表
  const logsWrap = $('scope-logs-list');
  logsWrap.innerHTML = '';
  const filteredLogs = state.scopeLogsCatalog.filter((l) => !q
    || (l.name || '').toLowerCase().includes(q)
    || (l.display_group_name || '').toLowerCase().includes(q)
    || String(l.id) === q);

  for (const l of filteredLogs.slice(0, 120)) {
    const label = document.createElement('label');
    label.className = 'scope-check-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.scopeSelectedLogs.has(l.id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.scopeSelectedLogs.add(l.id);
      else state.scopeSelectedLogs.delete(l.id);
      $('selected-logs-count').textContent = String(state.scopeSelectedLogs.size);
    });
    const main = document.createElement('div');
    main.className = 'scope-check-main';
    const t = document.createElement('div');
    t.className = 'scope-check-title';
    t.textContent = `${l.name || `日志 #${l.id}`}${l.is_recording ? '（记录中）' : ''}`;
    const sub = document.createElement('div');
    sub.className = 'scope-check-sub';
    sub.textContent = `${l.display_group_name} · ${formatNumber(l.size)} 条 · 更新于 ${formatRelativeUnix(l.updated_at)}`;
    main.append(t, sub);
    label.append(cb, main);
    logsWrap.appendChild(label);
  }
  if (filteredLogs.length === 0) {
    logsWrap.innerHTML = '<div class="muted-text" style="padding:12px;text-align:center;">未匹配到跑团日志</div>';
  }
}

async function submitLinkForm(event) {
  event.preventDefault();
  const errEl = $('link-form-error');
  errEl.hidden = true;

  const label = $('link-label-input').value.trim();
  if (!label) {
    errEl.textContent = '请填写链接备注名称';
    errEl.hidden = false;
    return;
  }

  const scopeType = document.querySelector('input[name="scope_type"]:checked')?.value || 'all';
  const scope = scopeType === 'restricted'
    ? {
        type: 'restricted',
        group_ids: [...state.scopeSelectedGroups],
        log_ids: [...state.scopeSelectedLogs],
      }
    : { type: 'all', group_ids: [], log_ids: [] };

  if (scope.type === 'restricted' && scope.group_ids.length === 0 && scope.log_ids.length === 0) {
    errEl.textContent = '限定范围模式下，请至少勾选 1 个群或 1 份日志';
    errEl.hidden = false;
    return;
  }

  const expiryVal = $('link-expiry-select').value;
  const payload = { label, scope };
  if (expiryVal === 'never') payload.expires_in_hours = null;
  else if (expiryVal !== 'keep') payload.expires_in_hours = Number(expiryVal);

  const btn = $('link-form-submit');
  btn.disabled = true;
  try {
    if (state.editingLinkId) {
      await apiFetch(`/links/${state.editingLinkId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast('MCP 链接已更新');
    } else {
      const res = await apiFetch('/links', { method: 'POST', body: JSON.stringify(payload) });
      toast('已签发新的 MCP 链接');
      if (res.item?.url) {
        void copyText(res.item.url, '已创建并复制新 MCP 链接');
      }
    }
    await closeDialog($('link-dialog'));
    await Promise.all([loadLinks(), loadOverview()]);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function toggleLinkEnabled(link) {
  try {
    await apiFetch(`/links/${link.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !link.enabled }),
    });
    toast(link.enabled ? '已停用该链接' : '已启用该链接');
    await Promise.all([loadLinks(), loadOverview()]);
  } catch (err) {
    toast(err.message, true);
  }
}

async function rotateLink(link) {
  if (!window.confirm(`确认轮换「${link.label}」的令牌吗？旧地址会立即失效，需要把新地址同步到客户端。`)) return;
  try {
    const data = await apiFetch(`/links/${link.id}/rotate`, { method: 'POST' });
    toast('令牌已轮换，旧连接已断开');
    if (data.item?.url) {
      void copyText(data.item.url, '已复制轮换后的新 MCP 链接');
    }
    await loadLinks();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteLink(link) {
  if (!window.confirm(`确认删除 MCP 链接「${link.label}」吗？此操作不可恢复。`)) return;
  try {
    await apiFetch(`/links/${link.id}`, { method: 'DELETE' });
    toast('已删除 MCP 链接');
    await Promise.all([loadLinks(), loadOverview()]);
  } catch (err) {
    toast(err.message, true);
  }
}

function openGuideDialog(link) {
  state.guideLink = link;
  $('guide-dialog-subtitle').textContent = `当前链接：${link.label}`;
  $('guide-url-text').textContent = link.url;
  const snippet = JSON.stringify({
    mcpServers: {
      'sealdice-logs': {
        type: 'streamableHttp',
        url: link.url,
      },
    },
  }, null, 2);
  $('guide-json-code').textContent = snippet;
  $('guide-dialog').showModal();
}

/* ========= 事件绑定与启动 ========= */
function bindEvents() {
  $('theme-toggle').addEventListener('click', toggleTheme);

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errEl = $('login-error');
    errEl.hidden = true;
    const submitBtn = $('login-submit');
    submitBtn.disabled = true;
    try {
      await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: $('login-password').value }),
      });
      $('login-password').value = '';
      await showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  $('logout-btn').addEventListener('click', async () => {
    try { await apiFetch('/auth/logout', { method: 'POST' }); } catch {}
    showLogin();
  });

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('mobile-drawer-btn').addEventListener('click', () => {
    setMobileSidebarOpen(!$('log-sidebar').classList.contains('is-open'));
  });
  $('sidebar-backdrop').addEventListener('click', () => setMobileSidebarOpen(false));

  // 左侧目录筛选
  let logSearchTimer;
  $('log-search-input').addEventListener('input', (e) => {
    state.logSearch = e.target.value;
    clearTimeout(logSearchTimer);
    logSearchTimer = setTimeout(() => void loadLogs(true), 240);
  });
  $('group-filter-select').addEventListener('change', (e) => {
    state.selectedGroupFilter = e.target.value;
    void loadLogs(true);
  });
  $('active-only-btn').addEventListener('click', () => {
    state.activeOnly = !state.activeOnly;
    const btn = $('active-only-btn');
    btn.classList.toggle('is-active', state.activeOnly);
    btn.setAttribute('aria-pressed', String(state.activeOnly));
    void loadLogs(true);
  });
  $('refresh-logs-btn').addEventListener('click', () => {
    void Promise.all([loadGroups(), loadLogs(true), loadOverview()]);
  });
  $('load-more-logs-btn').addEventListener('click', () => void loadLogs(false));

  // 右侧阅读工具条
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.msgFilterMode = btn.dataset.filterMode;
      document.querySelectorAll('.seg-btn').forEach((b) => {
        const active = b.dataset.filterMode === state.msgFilterMode;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      void loadMessages({ mode: 'initial' });
    });
  });

  $('include-dice-btn').addEventListener('click', () => {
    state.includeDice = !state.includeDice;
    const btn = $('include-dice-btn');
    btn.classList.toggle('is-active', state.includeDice);
    btn.setAttribute('aria-pressed', String(state.includeDice));
    void loadMessages({ mode: 'initial' });
  });

  $('speaker-filter-select').addEventListener('change', (e) => {
    state.speakerFilter = e.target.value;
    void loadMessages({ mode: 'initial' });
  });

  $('time-preset-select').addEventListener('change', (e) => {
    state.timePreset = e.target.value;
    $('custom-time-row').hidden = state.timePreset !== 'custom';
    if (state.timePreset !== 'custom') {
      void loadMessages({ mode: 'initial' });
    }
  });
  $('apply-custom-time-btn').addEventListener('click', () => {
    state.customStart = $('custom-start-input').value;
    state.customEnd = $('custom-end-input').value;
    void loadMessages({ mode: 'initial' });
  });
  $('clear-custom-time-btn').addEventListener('click', () => {
    state.customStart = '';
    state.customEnd = '';
    $('custom-start-input').value = '';
    $('custom-end-input').value = '';
    state.timePreset = 'all';
    $('time-preset-select').value = 'all';
    $('custom-time-row').hidden = true;
    void loadMessages({ mode: 'initial' });
  });

  let msgSearchTimer;
  $('msg-search-input').addEventListener('input', (e) => {
    state.msgQuery = e.target.value;
    clearTimeout(msgSearchTimer);
    msgSearchTimer = setTimeout(() => void loadMessages({ mode: 'initial' }), 280);
  });

  $('reset-msg-filters-btn').addEventListener('click', () => {
    state.msgFilterMode = 'all';
    state.includeDice = true;
    state.speakerFilter = '';
    state.timePreset = 'all';
    state.customStart = '';
    state.customEnd = '';
    state.msgQuery = '';
    document.querySelectorAll('.seg-btn').forEach((b) => {
      const active = b.dataset.filterMode === 'all';
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    $('include-dice-btn').classList.add('is-active');
    $('include-dice-btn').setAttribute('aria-pressed', 'true');
    $('speaker-filter-select').value = '';
    $('time-preset-select').value = 'all';
    $('custom-time-row').hidden = true;
    $('msg-search-input').value = '';
    void loadMessages({ mode: 'initial' });
  });

  $('auto-poll-btn').addEventListener('click', toggleAutoPoll);
  $('refresh-messages-btn').addEventListener('click', () => void loadMessages({ mode: 'incremental' }));
  $('participants-btn').addEventListener('click', () => void openParticipantsDialog());
  $('copy-filtered-btn').addEventListener('click', () => void copyFilteredTranscript());
  $('export-txt-btn').addEventListener('click', exportFilteredTxt);
  $('load-older-btn').addEventListener('click', () => void loadMessages({ mode: 'older' }));

  $('jump-bottom-btn').addEventListener('click', () => {
    const scrollEl = $('message-scroll');
    scrollEl.scrollTop = scrollEl.scrollHeight;
    $('jump-bottom-btn').hidden = true;
  });
  $('message-scroll').addEventListener('scroll', (e) => {
    const el = e.target;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) $('jump-bottom-btn').hidden = true;
  });

  // MCP 链接与弹窗
  $('create-link-btn').addEventListener('click', () => void openLinkDialog(null));
  $('link-form').addEventListener('submit', (e) => void submitLinkForm(e));

  document.querySelectorAll('input[name="scope_type"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      updateScopePickerVisibility();
      if (radio.value === 'restricted') renderScopeLists();
    });
  });

  document.querySelectorAll('.picker-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.scopePickerTab = btn.dataset.pickerTab;
      renderScopeLists();
    });
  });
  $('scope-search-input').addEventListener('input', (e) => {
    state.scopeSearch = e.target.value;
    renderScopeLists();
  });
  $('clear-scope-btn').addEventListener('click', () => {
    state.scopeSelectedGroups.clear();
    state.scopeSelectedLogs.clear();
    renderScopeLists();
  });

  $('guide-copy-url').addEventListener('click', () => {
    if (state.guideLink?.url) void copyText(state.guideLink.url, '已复制接入地址');
  });
  $('guide-copy-json').addEventListener('click', () => {
    void copyText($('guide-json-code').textContent || '', '已复制 JSON 配置');
  });

  document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void closeDialog($(btn.dataset.closeDialog));
    });
  });

  ['link-dialog', 'guide-dialog', 'participants-dialog'].forEach((id) => {
    setupModalDialog($(id));
  });
}

async function bootstrap() {
  bindEvents();
  try {
    const status = await apiFetch('/auth/status');
    state.publicOrigin = status.publicOrigin || null;
    if (status.authenticated) {
      await showApp();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

void bootstrap();
