// HKK MD Editor 自定义文档搜索 (Phase 4.2)
// 替代 VS Code 原生 find widget,只在编辑器主区搜,不搜 TOC / 工具栏
// 入口:Ctrl+F / Cmd+F
// 行为:打开时若有选中文字,自动预填到搜索框
// 快捷键:Enter 下一个、Shift+Enter 上一个、Esc 关闭

let bar = null;
let input = null;
let countLabel = null;
let minimap = null;
let isOpen = false;
let matches = [];   // [{ node, start, end }, ...]
let currentIdx = -1;
let lastQuery = '';
let inputDebounceTimer = 0;

function supportsHighlightAPI() {
  return typeof window.Highlight !== 'undefined' && window.CSS && CSS.highlights;
}

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
    <div class="hkk-search__input-wrap">
      <input type="text" class="hkk-search__input" placeholder="查找" spellcheck="false" />
      <button type="button" class="hkk-search__clear" data-action="clear-input" title="清空">
        <svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>
      </button>
    </div>
    <span class="hkk-search__count"></span>
    <button type="button" class="hkk-search__btn" data-action="prev" title="上一个 (Shift+Enter)">
      <svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M3 10l5-5 5 5"/></svg>
    </button>
    <button type="button" class="hkk-search__btn" data-action="next" title="下一个 (Enter)">
      <svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M3 6l5 5 5-5"/></svg>
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
    else if (action === 'clear-input') {
      input.value = '';
      lastQuery = '';
      matches = [];
      currentIdx = -1;
      clearHighlights();
      renderMinimap();
      updateCount();
      input.focus();
    }
  });

  // 输入变化:防抖 120ms (避免边打字边全量搜的卡顿),重算 + 跳第一个
  input.addEventListener('input', () => {
    clearTimeout(inputDebounceTimer);
    inputDebounceTimer = setTimeout(() => {
      const q = input.value;
      if (q === lastQuery) return;
      lastQuery = q;
      findAll(q);
      currentIdx = matches.length > 0 ? 0 : -1;
      showCurrent();
    }, 120);
  });

  // 搜索框内快捷键
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeBar(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      // Enter 前先 flush 防抖,避免还没搜到就跳
      if (inputDebounceTimer) {
        clearTimeout(inputDebounceTimer);
        inputDebounceTimer = 0;
        const q = input.value;
        if (q !== lastQuery) {
          lastQuery = q;
          findAll(q);
          currentIdx = matches.length > 0 ? 0 : -1;
          showCurrent();
        }
      }
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

  // 滚动条右侧的小色条 overlay (匹配位置 minimap)
  minimap = document.createElement('div');
  minimap.id = 'hkk-search-minimap';
  minimap.className = 'hkk-search__minimap';
  document.body.appendChild(minimap);
  window.addEventListener('resize', renderMinimap);

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
  clearHighlights();
  renderMinimap();
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
  buildHighlights();
  renderMinimap();
  if (currentIdx < 0 || !matches[currentIdx]) return;
  scrollToMatch(currentIdx);
}

// 把视口卷到 idx 对应的匹配处 (居中),不动焦点
function scrollToMatch(idx) {
  const m = matches[idx];
  if (!m) return;
  const editor = getEditorEl();
  if (!editor) return;
  try {
    const range = document.createRange();
    range.setStart(m.node, m.start);
    range.setEnd(m.node, m.end);
    const rect = range.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    const margin = 60;
    // 已经在视口内 (留一点边界)就不滚
    if (rect.top >= editorRect.top + margin && rect.bottom <= editorRect.bottom - margin) return;
    const targetTop = editor.scrollTop + (rect.top - editorRect.top) - editorRect.height / 2 + rect.height / 2;
    editor.scrollTo({ top: targetTop, behavior: 'instant' });
  } catch {}
}

// ───── Custom Highlight API:所有匹配 + 当前匹配,跟焦点无关,持续可见 ─────
function buildHighlights() {
  if (!supportsHighlightAPI()) return;
  const allRanges = [];
  let currentRange = null;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    try {
      const r = document.createRange();
      r.setStart(m.node, m.start);
      r.setEnd(m.node, m.end);
      allRanges.push(r);
      if (i === currentIdx) currentRange = r;
    } catch {}
  }
  if (allRanges.length > 0) {
    CSS.highlights.set('hkk-search-match', new Highlight(...allRanges));
  } else {
    CSS.highlights.delete('hkk-search-match');
  }
  if (currentRange) {
    CSS.highlights.set('hkk-search-current', new Highlight(currentRange));
  } else {
    CSS.highlights.delete('hkk-search-current');
  }
}

function clearHighlights() {
  if (!supportsHighlightAPI()) return;
  CSS.highlights.delete('hkk-search-match');
  CSS.highlights.delete('hkk-search-current');
}

// ───── 滚动条右侧 minimap:每个匹配位置一个小色条 ─────
function renderMinimap() {
  if (!minimap) return;
  if (!isOpen || matches.length === 0) {
    minimap.style.display = 'none';
    minimap.innerHTML = '';
    return;
  }
  const editor = getEditorEl();
  if (!editor) { minimap.style.display = 'none'; return; }
  const editorRect = editor.getBoundingClientRect();
  const scrollH = editor.scrollHeight;
  if (scrollH <= 0 || editorRect.height <= 0) {
    minimap.style.display = 'none';
    return;
  }
  // 位置:跨整个滚动条高度,贴在编辑区右侧 (覆盖在滚动条上)
  minimap.style.display = 'block';
  minimap.style.top = editorRect.top + 'px';
  minimap.style.left = (editorRect.right - 12) + 'px';
  minimap.style.width = '12px';
  minimap.style.height = editorRect.height + 'px';

  // 两阶段避免 layout thrashing:
  //   第一阶段只读 (批量 getBoundingClientRect, 浏览器可合并 reflow)
  //   第二阶段只写 (建 DocumentFragment, 末尾一次 append)
  const ratios = new Array(matches.length);
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    try {
      const r = document.createRange();
      r.setStart(m.node, m.start);
      r.setEnd(m.node, m.end);
      const rect = r.getBoundingClientRect();
      const matchYInContent = rect.top - editorRect.top + editor.scrollTop;
      ratios[i] = Math.max(0, Math.min(1, matchYInContent / scrollH));
    } catch {
      ratios[i] = -1;
    }
  }
  minimap.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < ratios.length; i++) {
    if (ratios[i] < 0) continue;
    const mark = document.createElement('div');
    mark.className = 'hkk-search__mark' + (i === currentIdx ? ' hkk-search__mark--current' : '');
    mark.style.top = (ratios[i] * 100) + '%';
    frag.appendChild(mark);
  }
  minimap.appendChild(frag);
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
