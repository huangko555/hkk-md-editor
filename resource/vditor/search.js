// HKK MD Editor 自定义文档搜索 (Phase 4.2)
// 替代 VS Code 原生 find widget,只在编辑器主区搜,不搜 TOC / 工具栏
// 入口:Ctrl+F / Cmd+F
// 行为:打开时若有选中文字,自动预填到搜索框
// 快捷键:Enter 下一个、Shift+Enter 上一个、Esc 关闭

let bar = null;
let input = null;
let countLabel = null;
let isOpen = false;
let matches = [];   // [{ node, start, end }, ...]
let currentIdx = -1;
let lastQuery = '';

// ───── 找当前可见模式的编辑器内容区 (只在此处搜) ─────
function getEditorEl() {
  for (const sel of ['.vditor-ir', '.vditor-wysiwyg', '.vditor-sv']) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      return el.querySelector('.vditor-reset') || el;
    }
  }
  return null;
}

export function initSearch() {
  if (bar) return;

  bar = document.createElement('div');
  bar.id = 'hkk-search';
  bar.className = 'hkk-search hkk-search--hidden';
  bar.innerHTML = `
    <input type="text" class="hkk-search__input" placeholder="查找" spellcheck="false" />
    <span class="hkk-search__count"></span>
    <button type="button" class="hkk-search__btn" data-action="prev" title="上一个 (Shift+Enter)">
      <svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 4l5 6H3z"/></svg>
    </button>
    <button type="button" class="hkk-search__btn" data-action="next" title="下一个 (Enter)">
      <svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 12L3 6h10z"/></svg>
    </button>
    <button type="button" class="hkk-search__btn hkk-search__close" data-action="close" title="关闭 (Esc)">
      <svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>
    </button>
  `;
  document.body.appendChild(bar);
  input = bar.querySelector('.hkk-search__input');
  countLabel = bar.querySelector('.hkk-search__count');

  // 头部按钮点击委托
  bar.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset?.action;
    if (!action) return;
    if (action === 'prev') gotoMatch(-1);
    else if (action === 'next') gotoMatch(1);
    else if (action === 'close') closeBar();
  });

  // 输入变化:重算 + 跳第一个
  input.addEventListener('input', () => {
    const q = input.value;
    if (q === lastQuery) return;
    lastQuery = q;
    findAll(q);
    currentIdx = matches.length > 0 ? 0 : -1;
    showCurrent();
  });

  // 搜索框内快捷键
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeBar(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      gotoMatch(e.shiftKey ? -1 : 1);
      e.preventDefault();
    }
  });

  // 全局 Ctrl+F / Cmd+F 拦截
  document.addEventListener('keydown', (e) => {
    const isF = e.key === 'f' || e.key === 'F';
    if ((e.ctrlKey || e.metaKey) && isF && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      openBar();
    } else if (e.key === 'Escape' && isOpen) {
      closeBar();
      e.preventDefault();
    }
  }, true);

  // 外部 update / 模式切换会改 DOM,缓存的 matches 失效;关掉重来即可
  // (轻量处理:打开搜索时总是重新 findAll,所以缓存只在单次会话内有效)

  window.__hkkSearch = { open: openBar, close: closeBar };
}

function openBar() {
  // 只接受【编辑器内】的选中文字,排除搜索框自己 / TOC / 工具栏的 selection
  const sel = window.getSelection();
  const editor = getEditorEl();
  let initialText = '';
  if (sel && sel.rangeCount > 0 && editor && sel.anchorNode && editor.contains(sel.anchorNode)) {
    initialText = sel.toString().replace(/[\r\n]+/g, ' ').trim();
  }

  isOpen = true;
  bar.classList.remove('hkk-search--hidden');

  if (initialText) {
    // 有新的编辑器选中:覆盖搜索框
    input.value = initialText;
    if (initialText !== lastQuery) {
      lastQuery = initialText;
      findAll(initialText);
      currentIdx = matches.length > 0 ? 0 : -1;
      showCurrent();
    } else {
      updateCount();
    }
  } else {
    // 没有编辑器选中:保留搜索框原值 (首次打开为空),只刷新 UI
    updateCount();
  }

  input.focus();
  input.select();
}

function closeBar() {
  if (!isOpen) return;
  isOpen = false;
  bar.classList.add('hkk-search--hidden');
  matches = [];
  currentIdx = -1;
  // 选择保留 (用户关掉搜索后光标停留在最后一次匹配处),无需清
  // 把焦点还给编辑器
  const editor = getEditorEl();
  if (editor) {
    try { editor.focus(); } catch {}
  }
}

// 遍历可见编辑器内所有文本节点,找全部匹配 (大小写不敏感)
function findAll(query) {
  matches = [];
  if (!query) return;
  const editor = getEditorEl();
  if (!editor) return;
  const lowerQ = query.toLowerCase();
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      // 跳过 vditor 的 marker 节点 (##、** 这些符号),避免搜到不该搜的
      const p = n.parentElement;
      if (p && p.classList.contains('vditor-ir__marker')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent;
    if (!text) continue;
    const lower = text.toLowerCase();
    let pos = 0;
    while ((pos = lower.indexOf(lowerQ, pos)) !== -1) {
      matches.push({ node, start: pos, end: pos + query.length });
      pos += query.length;
    }
  }
}

function showCurrent() {
  updateCount();
  if (currentIdx < 0 || !matches[currentIdx]) return;
  const m = matches[currentIdx];
  try {
    const range = document.createRange();
    range.setStart(m.node, m.start);
    range.setEnd(m.node, m.end);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // 滚到视口中部
    const el = m.node.parentElement;
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    // 选完后焦点要还给搜索框,否则后续 Enter 不响应
    setTimeout(() => { if (isOpen) input.focus(); }, 0);
  } catch (e) {
    // node 可能在编辑过程中被销毁,忽略单个失败
  }
}

function gotoMatch(delta) {
  if (matches.length === 0) {
    // 若 lastQuery 不为空但 matches 空,可能 DOM 改了;重新找一次
    if (lastQuery) {
      findAll(lastQuery);
      if (matches.length === 0) { updateCount(); return; }
      currentIdx = delta > 0 ? 0 : matches.length - 1;
      showCurrent();
      return;
    }
    return;
  }
  currentIdx = (currentIdx + delta + matches.length) % matches.length;
  showCurrent();
}

function updateCount() {
  if (!lastQuery) { countLabel.textContent = ''; return; }
  if (matches.length === 0) { countLabel.textContent = '无结果'; countLabel.dataset.empty = '1'; return; }
  countLabel.removeAttribute('data-empty');
  countLabel.textContent = `${currentIdx + 1} / ${matches.length}`;
}
