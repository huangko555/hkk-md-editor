// HKK MD Editor 自定义目录 (Phase 4.1)
// 入口:vditor 工具栏 TOC 按钮 → window.__hkkToc.toggle()
// 形态:浮动态 (左上角浮动面板) ↔ 固定态 (左侧侧栏,Step 3 引入)

let container = null;
let body = null;
let isOpen = false;
let mode = 'floating'; // 'floating' | 'fixed'
let stateReady = false;
let buildScheduled = false;
let observer = null;
let panelWidth = 260; // 当前面板宽度(浮动/固定共用),拖宽时更新
const MIN_W = 180;
const MAX_W = 480;

// 当前抓到的标题节点(扁平),index 对应 .hkk-toc-link 的 data-idx
let headings = [];
// 折叠状态:键是稳定的标题 path 字符串,值 true 表示折叠
let collapsedSet = new Set();
// 当前激活的 heading index (scroll spy 用)
let activeIdx = -1;
const ACTIVE_TOP_RATIO = 0.2; // 可见区高度 × 这个比例 = 当前段分界线 (20% 从顶起)
// 滚动事件绑定状态 (模式切换时重绑)
let scrollEl = null;
let scrollHandler = null;

// ───── 找当前可见模式的编辑器根 ─────
function getVisibleMode() {
  for (const sel of ['.vditor-ir', '.vditor-wysiwyg', '.vditor-sv']) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}
function getEditorEl() {
  const mode = getVisibleMode();
  if (mode) return mode.querySelector('.vditor-reset') || mode;
  return document.querySelector('.vditor-reset');
}

// ───── 初始化 ─────
export function initTOC(initialState) {
  if (container) return;

  const hasInitialState = !!initialState;
  mode = initialState?.mode === 'fixed' ? 'fixed' : 'floating';
  isOpen = !!initialState?.open;

  container = document.createElement('div');
  container.id = 'hkk-toc';
  container.className = `hkk-toc ${isOpen ? '' : 'hkk-toc--hidden'} hkk-toc--${mode}`;
  container.innerHTML = `
    <div class="hkk-toc__header">
      <span class="hkk-toc__label">目录</span>
      <span class="hkk-toc__spacer"></span>
      <button type="button" class="hkk-toc__btn hkk-toc__icon-btn" data-action="collapse-top2" title="只展开前两级">
        <svg><use xlink:href="#vditor-icon-up"></use></svg>
      </button>
      <button type="button" class="hkk-toc__btn hkk-toc__icon-btn" data-action="expand-all" title="展开全部">
        <svg><use xlink:href="#vditor-icon-down"></use></svg>
      </button>
      <button type="button" class="hkk-toc__btn hkk-toc__icon-btn" data-action="toggle-mode" title="切到固定">
        <svg viewBox="0 0 16 16"><path fill="currentColor" d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354Z"/></svg>
      </button>
      <button type="button" class="hkk-toc__btn hkk-toc__icon-btn hkk-toc__close" data-action="close" title="关闭">
        <svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>
      </button>
    </div>
    <div class="hkk-toc__body">(目录加载中)</div>
    <div class="hkk-toc__resizer" title="拖动调整宽度"></div>
  `;
  document.body.appendChild(container);
  body = container.querySelector('.hkk-toc__body');
  document.body.classList.toggle('hkk-toc-fixed-open', mode === 'fixed' && isOpen);
  applyWidth();
  updateModeButtonTitle();

  // 容器内点击:头部按钮 / 折叠按钮 / 标题链接
  container.addEventListener('click', (e) => {
    // 1. 折叠 ▶/▼ 按钮
    const fold = e.target.closest('.hkk-toc-fold');
    if (fold) {
      e.stopPropagation();
      const path = fold.dataset.path;
      if (collapsedSet.has(path)) collapsedSet.delete(path);
      else collapsedSet.add(path);
      renderTree();
      return;
    }
    // 2. 头部按钮
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const action = btn.dataset.action;
      if (action === 'close') setOpen(false);
      else if (action === 'expand-all') { collapsedSet.clear(); renderTree(); }
      else if (action === 'collapse-top2') collapseToTop2();
      else if (action === 'toggle-mode') setMode(mode === 'floating' ? 'fixed' : 'floating');
      return;
    }
    // 3. 标题链接 → 跳转
    const link = e.target.closest('.hkk-toc-link');
    if (link) {
      const idx = parseInt(link.dataset.idx, 10);
      jumpTo(idx);
      if (mode === 'floating') setOpen(false);
    }
  });

  // 浮动态:点窗外关闭(排除工具栏 TOC 按钮自己,否则 toggle 失效)
  document.addEventListener('mousedown', (e) => {
    if (!isOpen || mode !== 'floating') return;
    if (container.contains(e.target)) return;
    if (e.target.closest('[data-type="hkk-toc"]')) return;
    setOpen(false);
  }, true);

  // 暴露给工具栏按钮 / 调试
  window.__hkkToc = {
    toggle: () => setOpen(!isOpen),
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => isOpen,
    rebuild: () => scheduleBuild(),
  };

  // 右边界拖宽
  setupResizer();

  // 测工具栏高度,供固定态 TOC 的 top 用
  measureToolbar();
  window.addEventListener('resize', measureToolbar);

  // MutationObserver 监听编辑器 DOM 变化,触发重建
  setupObserver();
  scheduleBuild();

  handler.on('tocState', applySavedState);
  if (isOpen) build();
  stateReady = hasInitialState;
  if (!hasInitialState) handler.emit('getTocState');
}

// 测 vditor 工具栏高度,写到 CSS 变量 --hkk-toolbar-h
function measureToolbar() {
  const tb = document.querySelector('.vditor-toolbar');
  if (!tb) { setTimeout(measureToolbar, 200); return; }
  const h = Math.round(tb.getBoundingClientRect().height);
  if (h > 0) document.body.style.setProperty('--hkk-toolbar-h', h + 'px');
}

// ───── 形态切换:floating ↔ fixed ─────
function setMode(next) {
  if (next !== 'floating' && next !== 'fixed') return;
  mode = next;
  container.classList.toggle('hkk-toc--floating', mode === 'floating');
  container.classList.toggle('hkk-toc--fixed', mode === 'fixed');
  document.body.classList.toggle('hkk-toc-fixed-open', mode === 'fixed' && isOpen);
  // 切换钮 title (图标不变,只换 tooltip 文字)
  updateModeButtonTitle();
  // 应用宽度
  applyWidth();
  saveState();
}

function updateModeButtonTitle() {
  const btn = container?.querySelector('[data-action="toggle-mode"]');
  if (btn) btn.title = mode === 'floating' ? '切到固定' : '切到浮动';
}

function applyWidth() {
  container.style.width = panelWidth + 'px';
  if (mode === 'fixed' && isOpen) {
    document.body.style.setProperty('--hkk-toc-width', panelWidth + 'px');
  }
}

// ───── 右边界拖宽 ─────
function setupResizer() {
  const handle = container.querySelector('.hkk-toc__resizer');
  if (!handle) return;
  let startX = 0;
  let startW = 0;
  let dragging = false;

  const onMove = (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    let w = startW + delta;
    if (w < MIN_W) w = MIN_W;
    if (w > MAX_W) w = MAX_W;
    panelWidth = w;
    applyWidth();
    e.preventDefault();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = container.getBoundingClientRect().width;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
    e.stopPropagation();
  });
}

function setupObserver() {
  const root = document.querySelector('.vditor-content') || document.getElementById('vditor');
  if (!root) { setTimeout(setupObserver, 200); return; }
  observer = new MutationObserver(() => scheduleBuild());
  observer.observe(root, { childList: true, subtree: true, characterData: true });
}

function setOpen(open) {
  isOpen = !!open;
  container.classList.toggle('hkk-toc--hidden', !isOpen);
  // 固定态打开时给 body 加 class,让 #vditor 通过 CSS 获得 margin-left
  document.body.classList.toggle('hkk-toc-fixed-open', mode === 'fixed' && isOpen);
  if (isOpen) {
    applyWidth();
    build(); // 立即重建,避免被节流吞掉显示旧目录
  }
  saveState();
}

function applySavedState(state) {
  const nextMode = state?.mode === 'fixed' ? 'fixed' : 'floating';
  const nextOpen = !!state?.open;
  setMode(nextMode);
  setOpen(nextOpen);
  stateReady = true;
}

function saveState() {
  if (!stateReady) return;
  handler.emit('setTocState', { open: isOpen, mode });
}

// ───── 树构建与渲染 ─────
function scheduleBuild() {
  if (buildScheduled) return;
  buildScheduled = true;
  setTimeout(() => {
    buildScheduled = false;
    if (!isOpen) return; // 关着的时候不浪费,打开时 setOpen 里再触发
    build();
  }, 150);
}

function build() {
  const editorEl = getEditorEl();
  if (!editorEl) { headings = []; body.innerHTML = '<div class="hkk-toc__empty">编辑器未就绪</div>'; return; }
  headings = Array.from(editorEl.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .filter(h => h.offsetParent !== null); // 忽略隐藏 mode 里的标题
  renderTree();
  bindScroll();
  updateActive();
}

// 把扁平 headings 渲染成嵌套树
// 每个节点:可折叠按钮 + 标题链接,缩进按 level 来
// path:稳定折叠标识,用 "idx-level-text" 组合,内容大改时旧 path 自然失效
function renderTree() {
  if (headings.length === 0) { body.innerHTML = '<div class="hkk-toc__empty">暂无标题</div>'; return; }

  const items = headings.map((h, idx) => ({
    idx,
    level: parseInt(h.tagName.slice(1), 10),
    text: extractHeadingText(h),
    path: `${idx}-${h.tagName}-${(h.textContent || '').slice(0, 32)}`,
    children: [],
  }));
  // 把扁平 items 串成嵌套树:用栈匹配 level
  const roots = [];
  const stack = []; // 栈顶 level 严格小于即将入栈的 level
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
    if (stack.length === 0) roots.push(it);
    else stack[stack.length - 1].children.push(it);
    stack.push(it);
  }

  body.innerHTML = `<ul class="hkk-toc-tree">${roots.map(renderNode).join('')}</ul>`;
  highlightActive(); // 重渲染后重新应用 active(支持折叠场景下高亮祖先)
}

function renderNode(n) {
  const hasChildren = n.children.length > 0;
  const collapsed = collapsedSet.has(n.path);
  const foldBtn = hasChildren
    ? `<span class="hkk-toc-fold" data-path="${escapeAttr(n.path)}" aria-label="${collapsed ? '展开' : '折叠'}"><span class="hkk-toc-fold__icon">${collapsed ? '▶' : '▼'}</span></span>`
    : '<span class="hkk-toc-fold-placeholder"></span>';
  // active class 不在这里加,交给 highlightActive 统一处理,以便支持"折叠时高亮可见祖先"
  const link = `<a class="hkk-toc-link hkk-toc-link--h${n.level}" data-idx="${n.idx}" title="${escapeAttr(n.text)}">${escapeHtml(n.text)}</a>`;
  const childrenHtml = (hasChildren && !collapsed)
    ? `<ul class="hkk-toc-tree">${n.children.map(renderNode).join('')}</ul>`
    : '';
  return `<li class="hkk-toc-node"><div class="hkk-toc-row">${foldBtn}${link}</div>${childrenHtml}</li>`;
}

// 抓标题文本(去掉 IR marker 里的 ## 等符号)
function extractHeadingText(h) {
  // 优先 textContent,过滤行首的 #/空格
  const raw = (h.textContent || '').trim();
  return raw.replace(/^#+\s*/, '').trim() || '(空标题)';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ───── 跳转 ─────
function jumpTo(idx) {
  const node = headings[idx];
  if (!node) return;
  // 直接操作 scrollTop,避免 scrollIntoView 向上冒泡影响 webview 根节点
  const sc = scrollEl
    || (getVisibleMode()?.querySelector('.vditor-reset'))
    || document.querySelector('.vditor-reset');
  if (!sc) return;
  const scRect = sc.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  sc.scrollTop += nodeRect.top - scRect.top;
}

// ───── Scroll spy:高亮当前段标题 ─────
function bindScroll() {
  // 当前可见模式下的滚动容器
  const newEl = (getVisibleMode()?.querySelector('.vditor-reset')) || document.querySelector('.vditor-reset');
  if (newEl === scrollEl) return;
  if (scrollEl && scrollHandler) scrollEl.removeEventListener('scroll', scrollHandler);
  scrollEl = newEl;
  if (!scrollEl) return;
  let raf = 0;
  scrollHandler = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; updateActive(); });
  };
  scrollEl.addEventListener('scroll', scrollHandler, { passive: true });
}

function updateActive() {
  if (headings.length === 0 || !scrollEl) { setActive(-1); return; }
  const rect = scrollEl.getBoundingClientRect();
  const triggerLine = rect.height * ACTIVE_TOP_RATIO;
  // 从上到下找最后一个【相对容器 top】<= 触发线 的标题
  let active = -1;
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const top = h.getBoundingClientRect().top - rect.top;
    if (top <= triggerLine) active = i;
    else break;
  }
  setActive(active);
}

function setActive(idx) {
  if (idx === activeIdx) return;
  activeIdx = idx;
  highlightActive();
}

function highlightActive() {
  if (!body) return;
  body.querySelectorAll('.hkk-toc-link--active').forEach(el => el.classList.remove('hkk-toc-link--active'));
  if (activeIdx < 0) return;
  // 从 activeIdx 起往上找第一个【真正渲染出来】的祖先,确保始终有高亮
  let cur = activeIdx;
  let link = null;
  while (cur >= 0) {
    link = body.querySelector(`.hkk-toc-link[data-idx="${cur}"]`);
    if (link) break;
    cur = findParentIdx(cur);
  }
  if (!link) return;
  link.classList.add('hkk-toc-link--active');
  scrollLinkIntoBodyView(link);
}

// 按 level 找父节点 idx,跟 build 树的栈逻辑一致
function findParentIdx(i) {
  if (i <= 0 || i >= headings.length) return -1;
  const level = parseInt(headings[i].tagName.slice(1), 10);
  for (let j = i - 1; j >= 0; j--) {
    const jl = parseInt(headings[j].tagName.slice(1), 10);
    if (jl < level) return j;
  }
  return -1;
}

function scrollLinkIntoBodyView(link) {
  const bodyRect = body.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();
  if (linkRect.top < bodyRect.top) {
    body.scrollTop -= (bodyRect.top - linkRect.top) + 8;
  } else if (linkRect.bottom > bodyRect.bottom) {
    body.scrollTop += (linkRect.bottom - bodyRect.bottom) + 8;
  }
}

// ───── 收起:按树深度算,顶级 + 第二级可见,第二级节点的孩子全折叠 ─────
// (不按 level 数值算,这样跳级标题如 H1 → H3 也能正确"显示前两层")
function collapseToTop2() {
  if (headings.length === 0) return;
  collapsedSet.clear();
  // 模拟 renderTree 的栈逻辑算每个 heading 的树深度 (0 = 顶级)
  const items = headings.map((h, idx) => ({
    idx,
    level: parseInt(h.tagName.slice(1), 10),
    path: `${idx}-${h.tagName}-${(h.textContent || '').slice(0, 32)}`,
    depth: 0,
  }));
  const stack = [];
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
    it.depth = stack.length;
    stack.push(it);
  }
  // 折叠 depth >= 1 的节点 (第二级及以下),其子节点 (depth >= 2) 全隐藏
  for (const it of items) {
    if (it.depth >= 1) collapsedSet.add(it.path);
  }
  renderTree();
}
