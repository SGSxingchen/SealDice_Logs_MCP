const API_BASE = './api';
const THEME_KEY = 'sealdice-logs-color-scheme';
const VIEW_STYLE_KEY = 'sealdice-logs-view-style';
const FONT_SIZE_KEY = 'sealdice-logs-font-size';
const SIDEBAR_KEY = 'sealdice-logs-sidebar-collapsed';
const POLL_INTERVAL_MS = 5000;
const GROUP_WINDOW_SEC = 180;
const AUTO_LOAD_THRESHOLD_PX = 240;

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

// 12 色色相充分拉开的浅/深双模式跑团染色调色盘
const SPEAKER_PALETTE = [
  'light-dark(#0f766e, #34d399)',
  'light-dark(#c2410c, #fb923c)',
  'light-dark(#1d4ed8, #60a5fa)',
  'light-dark(#be185d, #f472b6)',
  'light-dark(#7c3aed, #c084fc)',
  'light-dark(#a16207, #facc15)',
  'light-dark(#0e7490, #22d3ee)',
  'light-dark(#b91c1c, #f87171)',
  'light-dark(#4d7c0f, #a3e635)',
  'light-dark(#4338ca, #818cf8)',
  'light-dark(#9d174d, #fb7185)',
  'light-dark(#0369a1, #38bdf8)',
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
  hasNewer: false,
  loadingOlder: false,
  loadingNewer: false,
  readAnchor: 'latest', // 'latest' | 'oldest'
  unreadNewCount: 0,
  focusedMsgId: null,
  freshMsgIds: new Set(),
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
  speakerColorMap: new Map(),
  mentionNameMap: new Map(),
  dayBuckets: [], // [{ day, count, el }]
  viewStyle: 'script',
  fontSize: 'md',
  sidebarCollapsed: false,
  chapterPanelOpen: false,
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
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ========= 交互特效：Toast / 涟漪 / 滑动亮块 ========= */
function toast(message, isError = false) {
  const region = $('toast-region');
  const el = document.createElement('div');
  el.className = `toast${isError ? ' is-error' : ''}`;
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 210);
  }, 3000);
}

function attachRippleDelegate() {
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || prefersReducedMotion()) return;
    const target = event.target.closest('.has-ripple');
    if (!target || target.disabled) return;
    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 0.9;
    const wave = document.createElement('span');
    wave.className = 'click-ripple';
    wave.style.width = `${size}px`;
    wave.style.height = `${size}px`;
    wave.style.left = `${event.clientX - rect.left - size / 2}px`;
    wave.style.top = `${event.clientY - rect.top - size / 2}px`;
    target.appendChild(wave);
    setTimeout(() => wave.remove(), 540);
  });
}

function syncSlider(container) {
  if (!container) return;
  const slider = container.querySelector(':scope > .seg-slider');
  const active = container.querySelector(':scope > .is-active');
  if (!slider || !active) return;
  const width = active.offsetWidth;
  if (width === 0) return;
  slider.style.width = `${width}px`;
  slider.style.transform = `translate3d(${active.offsetLeft}px, 0, 0)`;
  container.classList.add('is-slider-ready');
}

function syncAllSliders() {
  document.querySelectorAll('.has-slider').forEach(syncSlider);
}

/* ========= 工具函数 ========= */
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

function hashSpeakerColor(name) {
  const text = String(name || '匿名');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return SPEAKER_PALETTE[Math.abs(hash) % SPEAKER_PALETTE.length];
}

function speakerColor(name) {
  const key = String(name || '匿名');
  return state.speakerColorMap.get(key) || hashSpeakerColor(key);
}

function rebuildSpeakerAndMentionMaps(participants = []) {
  const colorMap = new Map();
  const mentionMap = new Map();
  let slot = 0;

  const registerUid = (uid, nick) => {
    if (!uid || !nick) return;
    const raw = String(uid).trim();
    mentionMap.set(raw.toUpperCase(), nick);
    const dashIdx = raw.lastIndexOf('-');
    if (dashIdx !== -1 && dashIdx < raw.length - 1) {
      mentionMap.set(raw.slice(dashIdx + 1).toUpperCase(), nick);
    }
    const colonIdx = raw.lastIndexOf(':');
    if (colonIdx !== -1 && colonIdx < raw.length - 1) {
      const tail = raw.slice(colonIdx + 1);
      mentionMap.set(tail.toUpperCase(), nick);
      const subDash = tail.lastIndexOf('-');
      if (subDash !== -1 && subDash < tail.length - 1) {
        mentionMap.set(tail.slice(subDash + 1).toUpperCase(), nick);
      }
    }
  };

  for (const p of participants) {
    const nick = String(p.nickname || '').trim();
    if (nick && !colorMap.has(nick)) {
      colorMap.set(nick, SPEAKER_PALETTE[slot % SPEAKER_PALETTE.length]);
      slot += 1;
    }
    registerUid(p.im_userid, nick);
  }
  for (const m of state.messages) {
    const nick = String(m.nickname || '').trim();
    if (nick && !colorMap.has(nick)) {
      colorMap.set(nick, SPEAKER_PALETTE[slot % SPEAKER_PALETTE.length]);
      slot += 1;
    }
    registerUid(m.im_userid, nick);
  }

  state.speakerColorMap = colorMap;
  state.mentionNameMap = mentionMap;
}

function resolveOpenQqMentionsText(text) {
  return String(text || '').replace(/<@([0-9A-Fa-f]{16,64})>/g, (_full, id) => {
    const name = state.mentionNameMap.get(String(id).toUpperCase());
    return name ? `[@${name}]` : '[@成员]';
  });
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

/* ========= 阅读偏好持久化 ========= */
function loadReadingPrefs() {
  try {
    const view = localStorage.getItem(VIEW_STYLE_KEY);
    if (view === 'script' || view === 'cards') state.viewStyle = view;
    const size = localStorage.getItem(FONT_SIZE_KEY);
    if (size === 'sm' || size === 'md' || size === 'lg') state.fontSize = size;
    state.sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {}
  applyReadingPrefs();
}

function applyReadingPrefs() {
  const scroll = $('message-scroll');
  if (scroll) {
    scroll.dataset.viewStyle = state.viewStyle;
    scroll.dataset.fontSize = state.fontSize;
  }
  document.querySelectorAll('[data-view-style]').forEach((btn) => {
    const active = btn.dataset.viewStyle === state.viewStyle;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-font-size]').forEach((btn) => {
    const active = btn.dataset.fontSize === state.fontSize;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-read-anchor]').forEach((btn) => {
    const active = btn.dataset.readAnchor === state.readAnchor;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const layout = $('tab-reader');
  const collapseBtn = $('desktop-sidebar-btn');
  if (layout) layout.classList.toggle('is-sidebar-collapsed', state.sidebarCollapsed);
  if (collapseBtn) {
    collapseBtn.classList.toggle('is-active', state.sidebarCollapsed);
    collapseBtn.setAttribute('aria-pressed', String(state.sidebarCollapsed));
  }
  requestAnimationFrame(syncAllSliders);
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

/* ========= Dialog 顶层动画与回退 ========= */
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
  requestAnimationFrame(syncAllSliders);
  await Promise.all([loadOverview(), loadGroups(), loadLogs(true), loadLinks()]);
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });
  $('tab-reader').hidden = tab !== 'reader';
  $('tab-links').hidden = tab !== 'links';
  requestAnimationFrame(syncAllSliders);
  if (tab === 'links') {
    void loadOverview();
    void loadLinks();
  }
}

function setMobileSidebarOpen(open) {
  $('log-sidebar').classList.toggle('is-open', open);
  $('sidebar-backdrop').hidden = !open;
}

/* ========= 滚动进度、哨兵回退与章节导航 ========= */
function getScrollMetrics() {
  const isMobile = window.matchMedia('(max-width: 860px)').matches;
  const scroller = $('message-scroll');
  if (isMobile) {
    const doc = document.documentElement;
    const top = window.scrollY;
    const max = Math.max(0, doc.scrollHeight - window.innerHeight);
    return { isMobile, scroller, top, max, distBottom: Math.max(0, max - top) };
  }
  const top = scroller.scrollTop;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  return { isMobile, scroller, top, max, distBottom: Math.max(0, max - top) };
}

function smoothScrollTo(position) {
  const { isMobile, scroller } = getScrollMetrics();
  const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
  if (isMobile) {
    window.scrollTo({ top: position, behavior });
  } else {
    scroller.scrollTo({ top: position, behavior });
  }
}

let scrollRaf = 0;
function scheduleScrollSync() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    syncScrollProgressAndChapters();
  });
}

function syncScrollProgressAndChapters() {
  if (!state.activeLog || state.activeTab !== 'reader') return;
  const { scroller, top, max, distBottom } = getScrollMetrics();

  // 1. 顶部 2.5px 阅读进度条
  const ratio = max > 4 ? Math.min(1, Math.max(0, top / max)) : 1;
  const bar = $('read-progress-bar');
  if (bar) bar.style.transform = `scaleX(${ratio.toFixed(4)})`;

  const pctEl = $('dock-percent');
  if (pctEl) pctEl.textContent = `${Math.round(ratio * 100)}%`;

  // 2. 更新非 scroll-state 浏览器的悬浮回顶/回底可见类
  scroller.classList.toggle('can-scroll-top', top > 80);
  scroller.classList.toggle('can-scroll-bottom', distBottom > 90);

  if (distBottom < 90 && state.unreadNewCount > 0) {
    state.unreadNewCount = 0;
    updateUnreadDockBadge();
    $('jump-bottom-btn').hidden = true;
  }

  // 3. 当前阅读日期定位
  const scrollerRect = scroller.getBoundingClientRect();
  const anchorY = window.matchMedia('(max-width: 860px)').matches ? 140 : scrollerRect.top + 80;
  let currentDay = state.dayBuckets[0]?.day || '';
  for (const bucket of state.dayBuckets) {
    if (bucket.el && bucket.el.getBoundingClientRect().top <= anchorY) {
      currentDay = bucket.day;
    } else {
      break;
    }
  }
  if (currentDay) {
    $('dock-current-day').textContent = currentDay.slice(5); // MM-DD
    document.querySelectorAll('.chapter-day-btn').forEach((btn) => {
      btn.classList.toggle('is-current', btn.dataset.day === currentDay);
    });
  }

  // 4. 双向无感自动续载（距顶 < 240px 自动补更早，距底 < 240px 且有后续时自动补更新）
  if (top < AUTO_LOAD_THRESHOLD_PX && state.hasOlder && !state.loadingOlder && state.messages.length > 0) {
    void loadMessages({ mode: 'older' });
  }
  if (distBottom < AUTO_LOAD_THRESHOLD_PX && state.hasNewer && !state.loadingNewer && state.messages.length > 0) {
    void loadMessages({ mode: 'newer' });
  }
}

function setupScrollObservers() {
  const scroller = $('message-scroll');
  if (!scroller) return;

  // 遵循 scroll-position-aware-elements：非原生 scroll-state 浏览器使用 IntersectionObserver 回退
  if (!window.CSS?.supports?.('container-type', 'scroll-state')) {
    const topSentinel = $('scroll-top-sentinel');
    const bottomSentinel = $('scroll-bottom-sentinel');
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === topSentinel) {
          scroller.classList.toggle('can-scroll-top', !entry.isIntersecting);
        } else if (entry.target === bottomSentinel) {
          scroller.classList.toggle('can-scroll-bottom', !entry.isIntersecting);
        }
      }
    }, { root: scroller, threshold: 0 });
    if (topSentinel) io.observe(topSentinel);
    if (bottomSentinel) io.observe(bottomSentinel);
  }

  // 遵循指南：悬浮按钮隐藏导致失焦时把焦点还给滚动区
  const dock = document.querySelector('.scroll-dock');
  dock?.addEventListener('focusout', (event) => {
    if (!event.relatedTarget) scroller.focus({ preventScroll: true });
  });
}

function updateUnreadDockBadge() {
  const badge = $('dock-unread-badge');
  if (!badge) return;
  if (state.unreadNewCount > 0) {
    badge.textContent = state.unreadNewCount > 99 ? '99+' : String(state.unreadNewCount);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function setChapterPanelOpen(open) {
  state.chapterPanelOpen = open;
  $('chapter-panel').hidden = !open;
  $('chapter-toggle-btn').setAttribute('aria-expanded', String(open));
  if (open) renderChapterDaysList();
}

function renderChapterDaysList() {
  const wrap = $('chapter-days-list');
  wrap.innerHTML = '';
  $('chapter-loaded-hint').textContent = `已载 ${formatNumber(state.messages.length)} 条`;

  if (state.dayBuckets.length === 0) {
    wrap.innerHTML = '<div class="muted-text" style="padding:8px;text-align:center;">暂无日期节点</div>';
    return;
  }
  for (const bucket of state.dayBuckets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chapter-day-btn';
    btn.dataset.day = bucket.day;
    btn.innerHTML = `<span>${bucket.day}</span><span class="muted-text">${bucket.count} 条</span>`;
    btn.addEventListener('click', () => {
      setChapterPanelOpen(false);
      if (bucket.el) {
        bucket.el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
        bucket.el.classList.remove('is-flash');
        void bucket.el.offsetWidth;
        bucket.el.classList.add('is-flash');
        setTimeout(() => bucket.el.classList.remove('is-flash'), 1200);
      }
    });
    wrap.appendChild(btn);
  }
  syncScrollProgressAndChapters();
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
  if (reset) state.logsOffset = 0;
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
    btn.className = `log-item has-ripple${state.activeLog?.id === log.id ? ' is-selected' : ''}`;
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

/* ========= 单份日志阅览与双向消息流 ========= */
function buildMessageQueryParams(extra = {}) {
  const params = new URLSearchParams();
  params.set('filter_mode', state.msgFilterMode);
  params.set('include_dice', state.includeDice ? '1' : '0');
  params.set('limit', String(extra.limit || 120));

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

  if (extra.after_id !== undefined) params.set('after_id', String(extra.after_id));
  if (extra.before_id !== undefined) params.set('before_id', String(extra.before_id));
  return params;
}

async function selectLog(log) {
  state.activeLog = log;
  state.speakerFilter = '';
  state.focusedMsgId = null;
  state.unreadNewCount = 0;
  state.freshMsgIds.clear();
  state.speakerColorMap = new Map();
  state.mentionNameMap = new Map();
  setChapterPanelOpen(false);
  updateUnreadDockBadge();
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
  requestAnimationFrame(syncAllSliders);

  await Promise.all([loadSpeakerOptions(log.id, false), loadMessages({ mode: 'initial', animate: true })]);
  if (state.activeLog?.id === log.id) {
    rebuildSpeakerAndMentionMaps(state.participantsCache.get(log.id)?.participants || []);
    renderMessages({ animate: false });
    if (state.readAnchor === 'oldest') {
      scrollToEdge('top', true);
    } else {
      scrollToEdge('bottom', true);
    }
    syncScrollProgressAndChapters();
  }
}

function scrollToEdge(edge, instant = false) {
  const { isMobile, scroller } = getScrollMetrics();
  const behavior = instant || prefersReducedMotion() ? 'auto' : 'smooth';
  if (isMobile) {
    const target = edge === 'top' ? 0 : document.documentElement.scrollHeight;
    window.scrollTo({ top: target, behavior });
  } else {
    const target = edge === 'top' ? 0 : scroller.scrollHeight;
    scroller.scrollTo({ top: target, behavior });
  }
}

async function loadSpeakerOptions(logId, rerender = true) {
  try {
    const data = await apiFetch(`/logs/${logId}/participants`);
    state.participantsCache.set(logId, data);
    if (state.activeLog?.id !== logId) return;
    rebuildSpeakerAndMentionMaps(data.participants || []);
    const select = $('speaker-filter-select');
    const prev = state.speakerFilter;
    select.innerHTML = '<option value="">全部角色</option>';
    for (const p of data.participants || []) {
      const opt = document.createElement('option');
      opt.value = p.nickname;
      opt.textContent = `${p.nickname} (${p.total})`;
      select.appendChild(opt);
    }
    select.value = prev;
    if (rerender && state.messages.length > 0) renderMessages({ animate: false });
  } catch {}
}

function setEdgeButtonLoading(which, loading) {
  const btn = $(which === 'older' ? 'load-older-btn' : 'load-newer-btn');
  const label = $(which === 'older' ? 'load-older-label' : 'load-newer-label');
  if (!btn || !label) return;
  btn.disabled = loading;
  btn.classList.toggle('is-loading', loading);
  if (which === 'older') {
    label.textContent = loading ? '正在衔接更早剧情…' : '↑ 加载更早的跑团记录';
  } else {
    label.textContent = loading ? '正在衔接后续剧情…' : '↓ 加载后续跑团记录';
  }
}

function updateEdgeControls() {
  const hasMsgs = state.messages.length > 0;
  $('load-older-btn').hidden = !state.hasOlder;
  $('top-origin-mark').hidden = !hasMsgs || state.hasOlder;
  $('load-newer-btn').hidden = !state.hasNewer;
  $('bottom-end-mark').hidden = !hasMsgs || state.hasNewer;
}

async function loadMessages({ mode = 'initial', animate = false } = {}) {
  if (!state.activeLog) return;
  const logId = state.activeLog.id;
  const scrollEl = $('message-scroll');

  try {
    if (mode === 'older') {
      if (!state.firstId || state.loadingOlder) return;
      state.loadingOlder = true;
      setEdgeButtonLoading('older', true);
      try {
        const isMobile = window.matchMedia('(max-width: 860px)').matches;
        const prevHeight = isMobile ? document.documentElement.scrollHeight : scrollEl.scrollHeight;
        const prevTop = isMobile ? window.scrollY : scrollEl.scrollTop;

        const params = buildMessageQueryParams({ before_id: state.firstId, limit: 120 });
        const data = await apiFetch(`/logs/${logId}/messages?${params.toString()}`);
        if (state.activeLog?.id !== logId) return;
        const incoming = data.items || [];
        const existingIds = new Set(state.messages.map((m) => m.id));
        const fresh = incoming.filter((m) => !existingIds.has(m.id));
        state.messages = [...fresh, ...state.messages];
        state.firstId = data.first_id ?? state.firstId;
        state.hasOlder = Boolean(data.has_older);
        rebuildSpeakerAndMentionMaps(state.participantsCache.get(logId)?.participants || []);
        renderMessages({ animate: false });

        // 严格锁死当前阅读视线，零跳屏
        const nextHeight = isMobile ? document.documentElement.scrollHeight : scrollEl.scrollHeight;
        const delta = nextHeight - prevHeight;
        if (isMobile) window.scrollTo({ top: prevTop + delta, behavior: 'auto' });
        else scrollEl.scrollTop = prevTop + delta;

        updateStatusbar();
        syncScrollProgressAndChapters();
      } finally {
        state.loadingOlder = false;
        setEdgeButtonLoading('older', false);
      }
      return;
    }

    if (mode === 'newer') {
      if (!state.nextCursorId || state.loadingNewer) return;
      state.loadingNewer = true;
      setEdgeButtonLoading('newer', true);
      try {
        const params = buildMessageQueryParams({ after_id: state.nextCursorId, limit: 120 });
        const data = await apiFetch(`/logs/${logId}/messages?${params.toString()}`);
        if (state.activeLog?.id !== logId) return;
        const incoming = data.items || [];
        if (data.next_cursor_id && (!state.nextCursorId || data.next_cursor_id > state.nextCursorId)) {
          state.nextCursorId = data.next_cursor_id;
        }
        state.hasNewer = Boolean(data.has_newer);
        const existingIds = new Set(state.messages.map((m) => m.id));
        const fresh = incoming.filter((m) => !existingIds.has(m.id));
        if (fresh.length > 0) {
          state.messages = [...state.messages, ...fresh];
          state.lastId = fresh[fresh.length - 1].id;
          if (!state.firstId) state.firstId = fresh[0].id;
          rebuildSpeakerAndMentionMaps(state.participantsCache.get(logId)?.participants || []);
          renderMessages({ animate: false });
        } else {
          updateEdgeControls();
        }
        updateStatusbar();
        syncScrollProgressAndChapters();
      } finally {
        state.loadingNewer = false;
        setEdgeButtonLoading('newer', false);
      }
      return;
    }

    if (mode === 'incremental') {
      if (!state.nextCursorId || state.hasNewer) {
        if (state.hasNewer) {
          await loadMessages({ mode: 'newer' });
          return;
        }
        await loadMessages({ mode: 'initial', animate: false });
        return;
      }
      const { distBottom } = getScrollMetrics();
      const nearBottom = distBottom < 120;
      const params = buildMessageQueryParams({ after_id: state.nextCursorId, limit: 150 });
      const data = await apiFetch(`/logs/${logId}/messages?${params.toString()}`);
      if (state.activeLog?.id !== logId) return;
      const incoming = data.items || [];
      if (data.next_cursor_id && (!state.nextCursorId || data.next_cursor_id > state.nextCursorId)) {
        state.nextCursorId = data.next_cursor_id;
      }
      state.hasNewer = Boolean(data.has_newer);
      if (incoming.length > 0) {
        const existingIds = new Set(state.messages.map((m) => m.id));
        const fresh = incoming.filter((m) => !existingIds.has(m.id));
        if (fresh.length > 0) {
          state.messages = [...state.messages, ...fresh];
          state.lastId = fresh[fresh.length - 1].id;
          if (!state.firstId) state.firstId = fresh[0].id;
          state.freshMsgIds = new Set(fresh.map((m) => m.id));
          setTimeout(() => state.freshMsgIds.clear(), 2200);
          rebuildSpeakerAndMentionMaps(state.participantsCache.get(logId)?.participants || []);
          renderMessages({ animate: false });
          if (nearBottom) {
            scrollToEdge('bottom', false);
          } else {
            state.unreadNewCount += fresh.length;
            updateUnreadDockBadge();
            $('jump-bottom-btn').hidden = false;
            toast(`新增 ${fresh.length} 条跑团消息`);
          }
        }
      }
      updateStatusbar();
      syncScrollProgressAndChapters();
      return;
    }

    // initial reload（支持最新倒序起点与开篇首句起点）
    const extra = state.readAnchor === 'oldest' ? { after_id: 0, limit: 120 } : { limit: 120 };
    const params = buildMessageQueryParams(extra);
    const data = await apiFetch(`/logs/${logId}/messages?${params.toString()}`);
    if (state.activeLog?.id !== logId) return;
    state.messages = data.items || [];
    state.firstId = data.first_id;
    state.lastId = data.last_id;
    state.nextCursorId = data.next_cursor_id;
    state.hasOlder = Boolean(data.has_older);
    state.hasNewer = Boolean(data.has_newer);
    state.unreadNewCount = 0;
    state.scannedCount = data.scanned_count || 0;
    state.filteredOut = data.filtered_out || { ooc: 0, ic: 0, dice: 0, speaker: 0, query: 0 };
    updateUnreadDockBadge();
    rebuildSpeakerAndMentionMaps(state.participantsCache.get(logId)?.participants || []);
    renderMessages({ animate });
    updateStatusbar();
    scrollToEdge(state.readAnchor === 'oldest' ? 'top' : 'bottom', true);
    $('jump-bottom-btn').hidden = true;
    requestAnimationFrame(syncScrollProgressAndChapters);
  } catch (err) {
    toast(err.message, true);
  }
}

function detectDiceCritClass(msg) {
  if (msg.kind !== 'dice_result') return '';
  const text = String(msg.message || '');
  if (/大失败/.test(text)) return 'is-crit-fumble';
  if (/大成功|极难成功/.test(text)) return 'is-crit-success';
  return '';
}

function appendInlineChips(parent, text) {
  const tokenRe = /(\[(?:图片|语音|视频|表情|回复|合并转发|@[^\]]+)\]|<@[0-9A-Fa-f]{16,64}>)/g;
  const parts = String(text || '').split(tokenRe);
  for (const part of parts) {
    if (!part) continue;
    const openQqMatch = /^<@([0-9A-Fa-f]{16,64})>$/.exec(part);
    if (openQqMatch) {
      const rawId = openQqMatch[1];
      const resolved = state.mentionNameMap.get(rawId.toUpperCase());
      const chip = document.createElement('span');
      chip.className = 'cq-chip is-mention';
      chip.textContent = resolved ? `@${resolved}` : '@成员';
      chip.title = resolved ? `${resolved} (${rawId})` : `成员标识 ${rawId}`;
      parent.appendChild(chip);
    } else if (/^\[(?:图片|语音|视频|表情|回复|合并转发|@[^\]]+)\]$/.test(part)) {
      const chip = document.createElement('span');
      chip.className = `cq-chip${part.startsWith('[@') ? ' is-mention' : ''}`;
      chip.textContent = part.startsWith('[@') ? part.slice(1, -1) : part;
      parent.appendChild(chip);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

function renderStructuredMessageBody(container, text, isOocOrDice) {
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      const spacer = document.createElement('div');
      spacer.className = 'msg-line is-blank';
      container.appendChild(spacer);
      continue;
    }

    const p = document.createElement('p');
    p.className = 'msg-line';

    if (!isOocOrDice && /^[#＃](?!\d+\s*$)/.test(trimmed)) {
      p.classList.add('is-action');
      const hashSpan = document.createElement('span');
      hashSpan.className = 'action-hash';
      hashSpan.textContent = '#';
      p.appendChild(hashSpan);
      appendInlineChips(p, trimmed.slice(1).trimStart());
    } else if (!isOocOrDice && /^【[\s\S]+】$/.test(trimmed)) {
      p.classList.add('is-thought');
      appendInlineChips(p, trimmed);
    } else {
      appendInlineChips(p, rawLine);
    }
    container.appendChild(p);
  }
}

function shouldGroupWithPrevious(prev, curr, prevDay, currDay) {
  if (!prev) return false;
  if (prevDay !== currDay) return false;
  if (prev.channel !== curr.channel) return false;
  if (prev.kind === 'dice_result' || prev.kind === 'dice_command') return false;
  if (curr.kind === 'dice_result' || curr.kind === 'dice_command') return false;
  if ((prev.nickname || '') !== (curr.nickname || '')) return false;
  return Math.abs((curr.time || 0) - (prev.time || 0)) <= GROUP_WINDOW_SEC;
}

function renderMessages({ animate = false } = {}) {
  const list = $('message-list');
  list.innerHTML = '';
  $('message-empty').hidden = state.messages.length > 0;
  updateEdgeControls();

  const dayBuckets = [];
  let currentBucket = null;
  let prevDay = '';
  let prevMsg = null;
  const total = state.messages.length;
  // 按阅读起点避开首屏可见约 16 条的 content-visibility: auto
  const isFromTop = state.readAnchor === 'oldest';

  const frag = document.createDocumentFragment();
  state.messages.forEach((msg, index) => {
    const day = formatDateShort(msg.time);
    if (day !== prevDay) {
      const div = document.createElement('div');
      div.className = 'day-divider';
      div.textContent = day;
      frag.appendChild(div);
      currentBucket = { day, count: 0, el: div };
      dayBuckets.push(currentBucket);
    }
    if (currentBucket) currentBucket.count += 1;

    const grouped = shouldGroupWithPrevious(prevMsg, msg, prevDay, day);
    prevDay = day;
    prevMsg = msg;

    const isOffscreen = isFromTop ? index >= 16 : index < Math.max(0, total - 16);
    const animRank = isFromTop ? index : total - 1 - index;
    const shouldEnter = animate && animRank >= 0 && animRank < 14;

    const row = document.createElement('article');
    const isOoc = msg.channel === 'ooc';
    const isDice = msg.kind === 'dice_result' || msg.kind === 'dice_command';
    const critClass = detectDiceCritClass(msg);

    row.className = [
      'msg-row',
      isOoc ? 'is-ooc' : '',
      isDice ? 'is-dice' : '',
      msg.kind === 'dice_command' ? 'is-dice-cmd' : '',
      critClass,
      grouped ? 'is-grouped' : '',
      isOffscreen ? 'is-deferred' : '',
      shouldEnter ? 'is-enter' : '',
      state.freshMsgIds.has(msg.id) ? 'is-fresh' : '',
      state.focusedMsgId === msg.id ? 'is-focused' : '',
    ].filter(Boolean).join(' ');
    row.style.setProperty('--speaker-color', speakerColor(msg.nickname));
    if (shouldEnter) {
      row.style.setProperty('--enter-delay', `${animRank * 16}ms`);
    }

    row.addEventListener('click', (event) => {
      if (event.target.closest('button') || window.getSelection()?.toString()) return;
      const next = state.focusedMsgId === msg.id ? null : msg.id;
      document.querySelectorAll('.msg-row.is-focused').forEach((el) => el.classList.remove('is-focused'));
      state.focusedMsgId = next;
      if (next === msg.id) row.classList.add('is-focused');
    });

    const head = document.createElement('div');
    head.className = 'msg-head';

    const dot = document.createElement('span');
    dot.className = 'msg-speaker-dot';
    dot.setAttribute('aria-hidden', 'true');
    head.appendChild(dot);

    const speakerBtn = document.createElement('button');
    speakerBtn.type = 'button';
    speakerBtn.className = 'msg-speaker';
    speakerBtn.textContent = msg.nickname || '未命名角色';
    speakerBtn.title = '点击仅看该角色发言';
    speakerBtn.addEventListener('click', () => {
      state.speakerFilter = state.speakerFilter === msg.nickname ? '' : msg.nickname;
      $('speaker-filter-select').value = state.speakerFilter;
      void loadMessages({ mode: 'initial', animate: true });
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
      tag.textContent = critClass === 'is-crit-success' ? '大捷' : (critClass === 'is-crit-fumble' ? '大失败' : '检定');
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

    const makeTools = () => {
      const copyLineBtn = document.createElement('button');
      copyLineBtn.type = 'button';
      copyLineBtn.className = 'msg-tool-btn msg-copy-btn';
      copyLineBtn.textContent = '复制';
      copyLineBtn.title = '复制该条发言';
      copyLineBtn.addEventListener('click', () => {
        const cleanText = resolveOpenQqMentionsText(msg.message);
        void copyText(`${msg.nickname}: ${cleanText}`, '已复制本条发言');
      });

      const idBtn = document.createElement('button');
      idBtn.type = 'button';
      idBtn.className = 'msg-tool-btn';
      idBtn.textContent = `#${msg.id}`;
      idBtn.title = '点击复制消息游标 ID';
      idBtn.addEventListener('click', () => {
        void copyText(String(msg.id), `已复制消息游标 #${msg.id}`);
      });
      return [copyLineBtn, idBtn];
    };

    const toolsWrap = document.createElement('div');
    toolsWrap.className = 'msg-tools';
    toolsWrap.append(...makeTools());
    head.appendChild(toolsWrap);

    const inlineMeta = document.createElement('div');
    inlineMeta.className = 'msg-inline-meta';
    const miniTime = document.createElement('span');
    miniTime.className = 'msg-time';
    miniTime.textContent = formatTimeHms(msg.time);
    inlineMeta.append(miniTime, ...makeTools());

    const body = document.createElement('div');
    body.className = 'msg-body';
    renderStructuredMessageBody(body, msg.message, isOoc || isDice);

    row.append(head, inlineMeta, body);
    frag.appendChild(row);
  });

  list.appendChild(frag);
  state.dayBuckets = dayBuckets;
  if (state.chapterPanelOpen) renderChapterDaysList();
}

function updateStatusbar() {
  $('statusbar-summary').textContent = `当前已载 ${formatNumber(state.messages.length)} 条`;
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
    const cleanText = resolveOpenQqMentionsText(m.message);
    return `[${formatDateTime(m.time)} | ${tag}] ${m.nickname}: ${cleanText}`;
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
    rebuildSpeakerAndMentionMaps(data.participants || []);
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
      btn.className = 'participant-row has-ripple';
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
        void loadMessages({ mode: 'initial', animate: true });
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
    const modeBadge = document.createElement('span');
    const isLegacy = link.disclosure_mode === 'legacy';
    modeBadge.className = isLegacy ? 'badge badge-neutral' : 'badge badge-live';
    modeBadge.textContent = isLegacy ? '平铺兼容' : '渐进式 3 元工具';
    titleWrap.appendChild(scopeBadge);
    titleWrap.appendChild(modeBadge);

    const actions = document.createElement('div');
    actions.className = 'link-card-actions';

    const guideBtn = document.createElement('button');
    guideBtn.type = 'button';
    guideBtn.className = 'btn btn-secondary btn-sm has-ripple';
    guideBtn.textContent = '接入指引';
    guideBtn.addEventListener('click', () => openGuideDialog(link));

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-secondary btn-sm has-ripple';
    editBtn.textContent = '编辑范围';
    editBtn.addEventListener('click', () => void openLinkDialog(link));

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-secondary btn-sm has-ripple';
    toggleBtn.textContent = link.enabled ? '停用' : '启用';
    toggleBtn.addEventListener('click', () => void toggleLinkEnabled(link));

    const rotateBtn = document.createElement('button');
    rotateBtn.type = 'button';
    rotateBtn.className = 'btn btn-secondary btn-sm has-ripple';
    rotateBtn.textContent = '轮换令牌';
    rotateBtn.addEventListener('click', () => void rotateLink(link));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger btn-sm has-ripple';
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
    copyBtn.className = 'btn btn-primary btn-sm has-ripple';
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

  const disclosureSelect = $('link-disclosure-select');
  if (disclosureSelect) {
    disclosureSelect.value = editingLink?.disclosure_mode === 'legacy' ? 'legacy' : 'progressive';
  }

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
  const disclosure_mode = $('link-disclosure-select')?.value === 'legacy' ? 'legacy' : 'progressive';
  const payload = { label, scope, disclosure_mode };
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
  attachRippleDelegate();
  $('theme-toggle').addEventListener('click', toggleTheme);

  $('desktop-sidebar-btn').addEventListener('click', () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    try { localStorage.setItem(SIDEBAR_KEY, state.sidebarCollapsed ? '1' : '0'); } catch {}
    applyReadingPrefs();
  });

  document.querySelectorAll('[data-read-anchor]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.readAnchor;
      if (next === state.readAnchor) return;
      state.readAnchor = next;
      applyReadingPrefs();
      void loadMessages({ mode: 'initial', animate: true });
    });
  });

  document.querySelectorAll('[data-view-style]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.viewStyle = btn.dataset.viewStyle;
      try { localStorage.setItem(VIEW_STYLE_KEY, state.viewStyle); } catch {}
      applyReadingPrefs();
    });
  });

  document.querySelectorAll('[data-font-size]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.fontSize = btn.dataset.fontSize;
      try { localStorage.setItem(FONT_SIZE_KEY, state.fontSize); } catch {}
      applyReadingPrefs();
    });
  });

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
  document.querySelectorAll('[data-filter-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.msgFilterMode = btn.dataset.filterMode;
      document.querySelectorAll('[data-filter-mode]').forEach((b) => {
        const active = b.dataset.filterMode === state.msgFilterMode;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      requestAnimationFrame(syncAllSliders);
      void loadMessages({ mode: 'initial', animate: true });
    });
  });

  $('include-dice-btn').addEventListener('click', () => {
    state.includeDice = !state.includeDice;
    const btn = $('include-dice-btn');
    btn.classList.toggle('is-active', state.includeDice);
    btn.setAttribute('aria-pressed', String(state.includeDice));
    void loadMessages({ mode: 'initial', animate: true });
  });

  $('speaker-filter-select').addEventListener('change', (e) => {
    state.speakerFilter = e.target.value;
    void loadMessages({ mode: 'initial', animate: true });
  });

  $('time-preset-select').addEventListener('change', (e) => {
    state.timePreset = e.target.value;
    $('custom-time-row').hidden = state.timePreset !== 'custom';
    if (state.timePreset !== 'custom') {
      void loadMessages({ mode: 'initial', animate: true });
    }
  });
  $('apply-custom-time-btn').addEventListener('click', () => {
    state.customStart = $('custom-start-input').value;
    state.customEnd = $('custom-end-input').value;
    void loadMessages({ mode: 'initial', animate: true });
  });
  $('clear-custom-time-btn').addEventListener('click', () => {
    state.customStart = '';
    state.customEnd = '';
    $('custom-start-input').value = '';
    $('custom-end-input').value = '';
    state.timePreset = 'all';
    $('time-preset-select').value = 'all';
    $('custom-time-row').hidden = true;
    void loadMessages({ mode: 'initial', animate: true });
  });

  let msgSearchTimer;
  $('msg-search-input').addEventListener('input', (e) => {
    state.msgQuery = e.target.value;
    clearTimeout(msgSearchTimer);
    msgSearchTimer = setTimeout(() => void loadMessages({ mode: 'initial', animate: true }), 280);
  });

  $('reset-msg-filters-btn').addEventListener('click', () => {
    state.msgFilterMode = 'all';
    state.includeDice = true;
    state.speakerFilter = '';
    state.timePreset = 'all';
    state.customStart = '';
    state.customEnd = '';
    state.msgQuery = '';
    document.querySelectorAll('[data-filter-mode]').forEach((b) => {
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
    requestAnimationFrame(syncAllSliders);
    void loadMessages({ mode: 'initial', animate: true });
  });

  $('auto-poll-btn').addEventListener('click', toggleAutoPoll);
  $('refresh-messages-btn').addEventListener('click', () => {
    const btn = $('refresh-messages-btn');
    btn.classList.remove('is-spinning');
    void btn.offsetWidth;
    btn.classList.add('is-spinning');
    setTimeout(() => btn.classList.remove('is-spinning'), 600);
    void loadMessages({ mode: 'incremental' });
  });
  $('participants-btn').addEventListener('click', () => void openParticipantsDialog());
  $('copy-filtered-btn').addEventListener('click', () => void copyFilteredTranscript());
  $('export-txt-btn').addEventListener('click', exportFilteredTxt);
  $('load-older-btn').addEventListener('click', () => void loadMessages({ mode: 'older' }));
  $('load-newer-btn').addEventListener('click', () => void loadMessages({ mode: 'newer' }));

  // 滚动进度、悬浮控制舱与章节面板
  $('message-scroll').addEventListener('scroll', scheduleScrollSync, { passive: true });
  window.addEventListener('scroll', scheduleScrollSync, { passive: true });
  window.addEventListener('resize', () => {
    syncAllSliders();
    scheduleScrollSync();
  }, { passive: true });

  $('chapter-toggle-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    setChapterPanelOpen(!state.chapterPanelOpen);
  });
  document.addEventListener('click', (e) => {
    if (state.chapterPanelOpen && !e.target.closest('.scroll-dock-anchor')) {
      setChapterPanelOpen(false);
    }
  });
  $('jump-story-start-btn').addEventListener('click', () => {
    setChapterPanelOpen(false);
    state.readAnchor = 'oldest';
    applyReadingPrefs();
    void loadMessages({ mode: 'initial', animate: true });
  });
  $('jump-story-latest-btn').addEventListener('click', () => {
    setChapterPanelOpen(false);
    state.readAnchor = 'latest';
    applyReadingPrefs();
    void loadMessages({ mode: 'initial', animate: true });
  });
  $('dock-top-btn').addEventListener('click', () => smoothScrollTo(0));
  $('dock-bottom-btn').addEventListener('click', () => {
    if (state.hasNewer) {
      state.readAnchor = 'latest';
      applyReadingPrefs();
      void loadMessages({ mode: 'initial', animate: true });
    } else {
      scrollToEdge('bottom', false);
      state.unreadNewCount = 0;
      updateUnreadDockBadge();
    }
  });
  $('jump-bottom-btn').addEventListener('click', () => {
    scrollToEdge('bottom', false);
    $('jump-bottom-btn').hidden = true;
    state.unreadNewCount = 0;
    updateUnreadDockBadge();
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

  setupScrollObservers();
}

async function bootstrap() {
  loadReadingPrefs();
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
