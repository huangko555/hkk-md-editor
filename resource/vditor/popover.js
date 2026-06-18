// HKK MD Editor IR 模式上下文 popover (Phase 4.3)
// 监听光标变化,光标进入特定块 (链接 / 代码块 / 表格 / 图片 / 数学 / Mermaid / 任务) 时,
// 在块上方浮出小菜单,显示该块的操作按钮 (vditor wysiwyg 模式自带 popover,IR 没有,这里补)

let popover = null;
let currentTarget = null;
let currentType = null;
let updateScheduled = false;
let suppressUntil = 0; // 暂时屏蔽更新 (用户在 popover 上操作时,防止光标变化引起隐藏)

function getEditorEl() {
  for (const sel of ['.vditor-ir', '.vditor-wysiwyg', '.vditor-sv']) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el.querySelector('.vditor-reset') || el;
  }
  return null;
}

export function initPopover() {
  if (popover) return;

  popover = document.createElement('div');
  popover.id = 'hkk-popover';
  popover.className = 'hkk-popover hkk-popover--hidden';
  document.body.appendChild(popover);

  // 点 popover 内部不要触发隐藏 (短暂屏蔽)
  popover.addEventListener('mousedown', () => { suppressUntil = Date.now() + 300; });

  document.addEventListener('selectionchange', schedule);
  document.addEventListener('mouseup', schedule);
  document.addEventListener('keyup', schedule);
  window.addEventListener('resize', schedule);
  // 编辑器滚动时重新定位
  setTimeout(() => {
    const editor = getEditorEl();
    if (editor) editor.addEventListener('scroll', () => {
      if (currentTarget) position(currentTarget);
    }, { passive: true });
  }, 1000);
}

function schedule() {
  if (Date.now() < suppressUntil) return;
  if (updateScheduled) return;
  updateScheduled = true;
  setTimeout(() => { updateScheduled = false; update(); }, 40);
}

function update() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { hide(); return; }
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el) { hide(); return; }

  // 光标必须在编辑器内部
  const editor = getEditorEl();
  if (!editor || !editor.contains(el)) { hide(); return; }

  const ctx = detectContext(el);
  if (!ctx) { hide(); return; }

  if (currentTarget === ctx.target && currentType === ctx.type) {
    position(ctx.target);
    return;
  }

  currentTarget = ctx.target;
  currentType = ctx.type;
  render(ctx);
  show(ctx.target);
}

// 找当前光标所在的特殊块,按优先级(更内层的先)
function detectContext(el) {
  // 图片优先 (一般是元素而非文本)
  const img = el.closest('img');
  if (img) return { type: 'image', target: img };

  // 链接
  const link = el.closest('.vditor-ir__node[data-type="a"], a[href]');
  if (link) return { type: 'link', target: link };

  // 代码块 (IR 节点 + wysiwyg 兼容)
  const codeBlock = el.closest('.vditor-ir__node[data-type="code-block"], pre[class*="language-"]');
  if (codeBlock) return { type: 'code-block', target: codeBlock };

  // 数学块
  const mathBlock = el.closest('.vditor-ir__node[data-type="math-block"], div[data-type="math-block"]');
  if (mathBlock) return { type: 'math-block', target: mathBlock };

  // 行内数学
  const mathInline = el.closest('.vditor-ir__node[data-type="math-inline"], span[data-type="math-inline"]');
  if (mathInline) return { type: 'math-inline', target: mathInline };

  // 表格
  const table = el.closest('table');
  if (table) return { type: 'table', target: table, cell: el.closest('td, th') };

  // 任务列表项
  const taskLi = el.closest('li.vditor-task');
  if (taskLi) return { type: 'task', target: taskLi };

  // 脚注引用
  const fnRef = el.closest('.vditor-ir__node[data-type="footnotes-ref"], sup[data-type="footnotes-ref"]');
  if (fnRef) return { type: 'footnote-ref', target: fnRef };

  // HTML 块
  const htmlBlock = el.closest('.vditor-ir__node[data-type="html-block"]');
  if (htmlBlock) return { type: 'html-block', target: htmlBlock };

  return null;
}

function render(ctx) {
  switch (ctx.type) {
    case 'link': popover.innerHTML = renderLink(ctx); break;
    case 'code-block': popover.innerHTML = renderCodeBlock(ctx); break;
    case 'table': popover.innerHTML = renderTable(ctx); break;
    case 'image': popover.innerHTML = renderImage(ctx); break;
    case 'math-block': popover.innerHTML = renderMathBlock(ctx); break;
    case 'math-inline': popover.innerHTML = renderMathInline(ctx); break;
    case 'task': popover.innerHTML = renderTask(ctx); break;
    case 'footnote-ref': popover.innerHTML = renderFootnoteRef(ctx); break;
    case 'html-block': popover.innerHTML = renderHtmlBlock(ctx); break;
    default: popover.innerHTML = '';
  }
  bindActions(ctx);
}

function renderLink(ctx) {
  const url = extractLinkUrl(ctx.target);
  return `
    <span class="hkk-popover__label">链接</span>
    <span class="hkk-popover__url" title="${escapeAttr(url || '(空)')}">${escapeHtml(truncate(url || '(空)', 36))}</span>
    <button type="button" class="hkk-popover__btn" data-action="open" title="在浏览器中打开">打开</button>
    <button type="button" class="hkk-popover__btn" data-action="copy-url" title="复制 URL">复制</button>
  `;
}

function renderCodeBlock(ctx) {
  const lang = extractCodeLang(ctx.target);
  return `
    <span class="hkk-popover__label">代码块</span>
    <span class="hkk-popover__hint">${lang ? escapeHtml(lang) : '(无语言)'}</span>
    <button type="button" class="hkk-popover__btn" data-action="copy-code" title="复制代码">复制</button>
  `;
}

function renderTable(ctx) {
  return `
    <span class="hkk-popover__label">表格</span>
    <button type="button" class="hkk-popover__btn" data-action="row-above" title="上方插入行">↑行</button>
    <button type="button" class="hkk-popover__btn" data-action="row-below" title="下方插入行">↓行</button>
    <button type="button" class="hkk-popover__btn" data-action="col-left" title="左侧插入列">←列</button>
    <button type="button" class="hkk-popover__btn" data-action="col-right" title="右侧插入列">列→</button>
    <button type="button" class="hkk-popover__btn hkk-popover__btn--danger" data-action="row-del" title="删除当前行">删行</button>
    <button type="button" class="hkk-popover__btn hkk-popover__btn--danger" data-action="col-del" title="删除当前列">删列</button>
    <span class="hkk-popover__sep"></span>
    <button type="button" class="hkk-popover__btn" data-action="align-left" title="本列左对齐">←齐</button>
    <button type="button" class="hkk-popover__btn" data-action="align-center" title="本列居中">↔齐</button>
    <button type="button" class="hkk-popover__btn" data-action="align-right" title="本列右对齐">→齐</button>
  `;
}

function renderImage(ctx) {
  const src = ctx.target.getAttribute('src') || '';
  const alt = ctx.target.getAttribute('alt') || '';
  return `
    <span class="hkk-popover__label">图片</span>
    <span class="hkk-popover__hint" title="${escapeAttr(alt)}">alt: ${escapeHtml(truncate(alt || '(空)', 20))}</span>
    <span class="hkk-popover__url" title="${escapeAttr(src)}">${escapeHtml(truncate(src, 30))}</span>
    <button type="button" class="hkk-popover__btn" data-action="copy-src" title="复制图片地址">复制</button>
  `;
}

function renderMathBlock(ctx) {
  return `
    <span class="hkk-popover__label">数学块</span>
    <span class="hkk-popover__hint">$$ ... $$</span>
    <button type="button" class="hkk-popover__btn" data-action="copy-math" title="复制公式">复制</button>
  `;
}

function renderMathInline(ctx) {
  return `
    <span class="hkk-popover__label">行内数学</span>
    <button type="button" class="hkk-popover__btn" data-action="copy-math" title="复制公式">复制</button>
  `;
}

function renderTask(ctx) {
  const cb = ctx.target.querySelector('input[type="checkbox"]');
  const checked = cb?.checked;
  return `
    <span class="hkk-popover__label">任务</span>
    <span class="hkk-popover__hint">${checked ? '已完成' : '未完成'}</span>
    <button type="button" class="hkk-popover__btn" data-action="toggle-task" title="切换勾选">${checked ? '取消' : '勾选'}</button>
  `;
}

function renderFootnoteRef(ctx) {
  return `
    <span class="hkk-popover__label">脚注</span>
    <button type="button" class="hkk-popover__btn" data-action="goto-footnote" title="跳到脚注定义">跳转</button>
  `;
}

function renderHtmlBlock(ctx) {
  return `
    <span class="hkk-popover__label">HTML 块</span>
    <span class="hkk-popover__hint">直接编辑源码</span>
  `;
}

function bindActions(ctx) {
  popover.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', e => handleAction(ctx, el.dataset.action, e));
  });
}

function handleAction(ctx, action, e) {
  e.stopPropagation();
  e.preventDefault();
  try {
    switch (ctx.type) {
      case 'link':
        if (action === 'open') openLink(extractLinkUrl(ctx.target));
        if (action === 'copy-url') copyText(extractLinkUrl(ctx.target));
        break;
      case 'code-block':
        if (action === 'copy-code') copyText(extractCodeText(ctx.target));
        break;
      case 'image':
        if (action === 'copy-src') copyText(ctx.target.getAttribute('src') || '');
        break;
      case 'math-block':
      case 'math-inline':
        if (action === 'copy-math') copyText(ctx.target.textContent.replace(/\$/g, ''));
        break;
      case 'task':
        if (action === 'toggle-task') toggleTask(ctx.target);
        break;
      case 'footnote-ref':
        if (action === 'goto-footnote') gotoFootnote(ctx.target);
        break;
      case 'table':
        handleTableAction(ctx, action);
        break;
    }
  } catch (err) {
    // 静默吞掉,避免破坏 editor
  }
}

// ───── 辅助提取 ─────

function extractLinkUrl(linkNode) {
  if (linkNode.tagName === 'A') return linkNode.getAttribute('href') || '';
  // IR 模式 .vditor-ir__node[data-type="a"]:URL 在 marker--link 元素里
  const urlMarker = linkNode.querySelector('.vditor-ir__marker--link');
  if (urlMarker) return urlMarker.textContent.trim();
  const a = linkNode.querySelector('a[href]');
  if (a) return a.getAttribute('href') || '';
  return '';
}

function extractCodeLang(codeNode) {
  // IR: code-block 节点下有 .vditor-ir__marker--info 显示语言
  const info = codeNode.querySelector('.vditor-ir__marker--info');
  if (info) return info.textContent.trim();
  // wysiwyg pre 上的 class language-xxx
  const pre = codeNode.tagName === 'PRE' ? codeNode : codeNode.querySelector('pre');
  if (pre) {
    const m = pre.className.match(/language-(\S+)/);
    if (m) return m[1];
  }
  return '';
}

function extractCodeText(codeNode) {
  // 优先找 code 元素
  const code = codeNode.querySelector('code');
  return code ? code.textContent : codeNode.textContent;
}

// ───── 动作实现 ─────

function copyText(text) {
  if (!text) return;
  try {
    navigator.clipboard.writeText(text);
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
}

function openLink(url) {
  if (!url) return;
  try { handler.emit('openLink', url); } catch {}
}

function toggleTask(li) {
  const cb = li.querySelector('input[type="checkbox"]');
  if (!cb) return;
  cb.checked = !cb.checked;
  // 触发 vditor input 回调 (它会重新序列化)
  const ev = new Event('input', { bubbles: true });
  li.dispatchEvent(ev);
}

function gotoFootnote(refEl) {
  const id = refEl.textContent.match(/\[\^(.+?)\]/)?.[1] || refEl.getAttribute('data-footnotes-label');
  if (!id) return;
  const editor = getEditorEl();
  if (!editor) return;
  const defs = editor.querySelectorAll('[data-type="footnotes-def"], div[data-type="footnotes-block"] *');
  for (const d of defs) {
    if (d.textContent.includes(`[^${id}]`)) {
      d.scrollIntoView({ block: 'center', behavior: 'instant' });
      return;
    }
  }
}

// 表格操作:直接改 DOM,然后触发 vditor input 让它重新解析
function handleTableAction(ctx, action) {
  const table = ctx.target;
  const cell = ctx.cell;
  if (!cell && action !== 'row-above' && action !== 'row-below') return;

  const tbody = table.querySelector('tbody') || table;
  const thead = table.querySelector('thead');
  const rows = Array.from(table.querySelectorAll('tr'));
  const cellRow = cell ? cell.parentElement : null;
  const rowIdx = cellRow ? rows.indexOf(cellRow) : -1;
  const cellIdx = cell ? Array.from(cellRow.children).indexOf(cell) : -1;

  switch (action) {
    case 'row-above':
    case 'row-below': {
      if (rowIdx < 0) return;
      const isAfter = action === 'row-below';
      const refRow = rows[rowIdx];
      const colCount = refRow.children.length;
      const newRow = document.createElement('tr');
      for (let i = 0; i < colCount; i++) {
        const td = document.createElement('td');
        td.textContent = ' ';
        newRow.appendChild(td);
      }
      // 不能插到 thead 之前;若 refRow 在 thead 里强制插到 tbody 第一行
      if (refRow.parentElement.tagName === 'THEAD' && !isAfter) {
        // 不允许在表头上方插行
        return;
      }
      refRow.parentElement.insertBefore(newRow, isAfter ? refRow.nextSibling : refRow);
      break;
    }
    case 'row-del': {
      if (rowIdx < 0) return;
      // 不允许删表头
      if (cellRow.parentElement.tagName === 'THEAD') return;
      cellRow.remove();
      break;
    }
    case 'col-left':
    case 'col-right': {
      if (cellIdx < 0) return;
      const isAfter = action === 'col-right';
      rows.forEach(r => {
        const ref = r.children[cellIdx];
        if (!ref) return;
        const newCell = document.createElement(ref.tagName);
        newCell.textContent = ' ';
        r.insertBefore(newCell, isAfter ? ref.nextSibling : ref);
      });
      break;
    }
    case 'col-del': {
      if (cellIdx < 0) return;
      // 最少留一列
      if (rows[0]?.children.length <= 1) return;
      rows.forEach(r => {
        const c = r.children[cellIdx];
        if (c) c.remove();
      });
      break;
    }
    case 'align-left':
    case 'align-center':
    case 'align-right': {
      if (cellIdx < 0) return;
      const align = action.replace('align-', '');
      rows.forEach(r => {
        const c = r.children[cellIdx];
        if (c) c.setAttribute('align', align);
      });
      break;
    }
  }

  // 触发 vditor 重新序列化
  const ev = new Event('input', { bubbles: true });
  table.dispatchEvent(ev);
}

// ───── 显示 / 定位 ─────

function show(target) {
  popover.classList.remove('hkk-popover--hidden');
  // 等下一帧拿到准确尺寸再定位
  requestAnimationFrame(() => position(target));
}

function position(target) {
  if (!target.getBoundingClientRect) return;
  const rect = target.getBoundingClientRect();
  const pRect = popover.getBoundingClientRect();
  let top = rect.top - pRect.height - 8;
  let left = rect.left + (rect.width - pRect.width) / 2;
  // 上方放不下放下方
  if (top < 8) top = rect.bottom + 8;
  // 横向 clamp
  if (left < 8) left = 8;
  if (left + pRect.width > window.innerWidth - 8) left = window.innerWidth - pRect.width - 8;
  popover.style.top = top + 'px';
  popover.style.left = left + 'px';
}

function hide() {
  popover.classList.add('hkk-popover--hidden');
  currentTarget = null;
  currentType = null;
}

// ───── 字符串辅助 ─────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
