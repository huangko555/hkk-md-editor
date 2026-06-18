// HKK MD Editor IR 模式上下文 popover (Phase 4.3)
// 监听光标变化,光标进入特定块 (链接 / 代码块 / 表格 / 图片 / 数学 / Mermaid / 任务) 时,
// 在块上方浮出小菜单,显示该块的操作按钮 (vditor wysiwyg 模式自带 popover,IR 没有,这里补)

let popover = null;
let currentTarget = null;
let currentType = null;
let currentCell = null;       // 表格当前光标所在的 td/th
let currentCtx = null;        // 渲染/定位用 ctx 引用
let tableExpanded = false;    // 表格 popover 的折叠态 (true = 展开完整工具栏)
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
      if (currentCtx) position(currentCtx);
    }, { passive: true });
  }, 1000);
}

function schedule() {
  if (Date.now() < suppressUntil) return;
  if (updateScheduled) return;
  updateScheduled = true;
  // rAF 替代 setTimeout 40ms,响应几乎即时 (~16ms 上限) 同时合并同帧多次事件
  requestAnimationFrame(() => { updateScheduled = false; update(); });
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

  // 光标在同一 target + 同一 cell (表格特有) 时不重新 render
  if (currentTarget === ctx.target && currentType === ctx.type && currentCell === (ctx.cell || null)) {
    position(ctx);
    return;
  }

  // 只在离开表格类型时重置展开态;在表格内移动 / 操作后 DOM 重建 都保持展开
  if (ctx.type !== 'table') {
    tableExpanded = false;
  }

  currentTarget = ctx.target;
  currentCell = ctx.cell || null;
  currentType = ctx.type;
  render(ctx);
  show(ctx);
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

  // 脚注引用
  const fnRef = el.closest('.vditor-ir__node[data-type="footnotes-ref"], sup[data-type="footnotes-ref"]');
  if (fnRef) return { type: 'footnote-ref', target: fnRef };

  // HTML 块
  const htmlBlock = el.closest('.vditor-ir__node[data-type="html-block"]');
  if (htmlBlock) return { type: 'html-block', target: htmlBlock };

  return null;
}

function render(ctx) {
  currentCtx = ctx;
  popover.classList.toggle('hkk-popover--mini', ctx.type === 'table' && !tableExpanded);
  switch (ctx.type) {
    case 'link': popover.innerHTML = renderLink(ctx); break;
    case 'code-block': popover.innerHTML = renderCodeBlock(ctx); break;
    case 'table': popover.innerHTML = tableExpanded ? renderTableExpanded(ctx) : renderTableCollapsed(ctx); break;
    case 'image': popover.innerHTML = renderImage(ctx); break;
    case 'math-block': popover.innerHTML = renderMathBlock(ctx); break;
    case 'math-inline': popover.innerHTML = renderMathInline(ctx); break;
    case 'footnote-ref': popover.innerHTML = renderFootnoteRef(ctx); break;
    case 'html-block': popover.innerHTML = renderHtmlBlock(ctx); break;
    default: popover.innerHTML = '';
  }
  bindActions(ctx);
}

// 用 vditor 自带的 SVG symbol 做图标 (定义在 material.js,DOM 加载时已注入)
const ICON = (name) => `<svg><use xlink:href="#vditor-icon-${name}"></use></svg>`;

function renderLink(ctx) {
  const url = extractLinkUrl(ctx.target);
  return `
    <span class="hkk-popover__label">链接</span>
    <span class="hkk-popover__url" title="${escapeAttr(url || '(空)')}">${escapeHtml(truncate(url || '(空)', 36))}</span>
    <button type="button" class="hkk-popover__btn" data-action="open" title="在浏览器中打开">${ICON('link')}</button>
    <button type="button" class="hkk-popover__btn" data-action="copy-url" title="复制 URL">${ICON('copy')}</button>
  `;
}

function renderCodeBlock(ctx) {
  const lang = extractCodeLang(ctx.target);
  return `
    <span class="hkk-popover__label">代码块</span>
    <span class="hkk-popover__hint">${lang ? escapeHtml(lang) : '(无语言)'}</span>
    <button type="button" class="hkk-popover__btn" data-action="copy-code" title="复制代码">${ICON('copy')}</button>
  `;
}

function renderTableCollapsed(ctx) {
  return `
    <button type="button" class="hkk-popover__btn hkk-popover__btn--mini" data-action="expand-table" title="展开表格操作">…</button>
  `;
}

function renderTableExpanded(ctx) {
  return `
    <button type="button" class="hkk-popover__btn" data-action="row-above" title="上方插入行">${ICON('insert-rowb')}</button>
    <button type="button" class="hkk-popover__btn" data-action="row-below" title="下方插入行">${ICON('insert-row')}</button>
    <button type="button" class="hkk-popover__btn" data-action="col-left" title="左侧插入列">${ICON('insert-columnb')}</button>
    <button type="button" class="hkk-popover__btn" data-action="col-right" title="右侧插入列">${ICON('insert-column')}</button>
    <span class="hkk-popover__sep"></span>
    <button type="button" class="hkk-popover__btn hkk-popover__btn--danger" data-action="row-del" title="删除当前行">${ICON('delete-row')}</button>
    <button type="button" class="hkk-popover__btn hkk-popover__btn--danger" data-action="col-del" title="删除当前列">${ICON('delete-column')}</button>
    <span class="hkk-popover__sep"></span>
    <button type="button" class="hkk-popover__btn" data-action="align-left" title="本列左对齐">${ICON('align-left')}</button>
    <button type="button" class="hkk-popover__btn" data-action="align-center" title="本列居中">${ICON('align-center')}</button>
    <button type="button" class="hkk-popover__btn" data-action="align-right" title="本列右对齐">${ICON('align-right')}</button>
    <span class="hkk-popover__sep"></span>
    <button type="button" class="hkk-popover__btn" data-action="collapse-table" title="收起">
      <svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>
    </button>
  `;
}

function renderImage(ctx) {
  const src = ctx.target.getAttribute('src') || '';
  const alt = ctx.target.getAttribute('alt') || '';
  return `
    <span class="hkk-popover__label">图片</span>
    <span class="hkk-popover__hint" title="${escapeAttr(alt)}">alt: ${escapeHtml(truncate(alt || '(空)', 20))}</span>
    <span class="hkk-popover__url" title="${escapeAttr(src)}">${escapeHtml(truncate(src, 30))}</span>
    <button type="button" class="hkk-popover__btn" data-action="copy-src" title="复制图片地址">${ICON('copy')}</button>
  `;
}

function renderMathBlock(ctx) {
  return `
    <span class="hkk-popover__label">数学块</span>
    <span class="hkk-popover__hint">$$ ... $$</span>
    <button type="button" class="hkk-popover__btn" data-action="copy-math" title="复制公式">${ICON('copy')}</button>
  `;
}

function renderMathInline(ctx) {
  return `
    <span class="hkk-popover__label">行内数学</span>
    <button type="button" class="hkk-popover__btn" data-action="copy-math" title="复制公式">${ICON('copy')}</button>
  `;
}

function renderFootnoteRef(ctx) {
  return `
    <span class="hkk-popover__label">脚注</span>
    <button type="button" class="hkk-popover__btn" data-action="goto-footnote" title="跳到脚注定义">${ICON('preview')}</button>
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
    // mousedown preventDefault 阻止按钮抢焦点 (保住编辑器光标不丢)
    el.addEventListener('mousedown', e => e.preventDefault());
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
      case 'footnote-ref':
        if (action === 'goto-footnote') gotoFootnote(ctx.target);
        break;
      case 'table':
        if (action === 'expand-table') {
          tableExpanded = true;
          render(ctx);
          requestAnimationFrame(() => position(ctx));
          return;
        }
        if (action === 'collapse-table') {
          tableExpanded = false;
          render(ctx);
          requestAnimationFrame(() => position(ctx));
          return;
        }
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
  // 找最新的 table/cell — vditor 上次操作后会重建 DOM,ctx.target 可能 stale
  let table = ctx.target;
  let cell = ctx.cell;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const sn = sel.getRangeAt(0).startContainer;
    const sEl = sn.nodeType === 1 ? sn : sn.parentElement;
    if (sEl) {
      const fT = sEl.closest('table');
      const fC = sEl.closest('td, th');
      if (fT && document.contains(fT)) { table = fT; cell = fC; }
    }
  }
  if (!table || !document.contains(table)) return;

  const rows = Array.from(table.querySelectorAll('tr'));
  const cellRow = cell ? cell.parentElement : null;
  const cellIdx = cell ? Array.from(cellRow.children).indexOf(cell) : -1;

  switch (action) {
    case 'row-above':
    case 'row-below': {
      if (!cellRow) return;
      const isAfter = action === 'row-below';
      const colCount = cellRow.children.length;
      const newRow = document.createElement('tr');
      for (let i = 0; i < colCount; i++) {
        const td = document.createElement('td');
        td.innerHTML = '&nbsp;';
        newRow.appendChild(td);
      }
      const inThead = cellRow.parentElement.tagName === 'THEAD';
      let tbody = table.querySelector('tbody');
      if (inThead) {
        // 表头里不允许往上插 (markdown 只支持 1 个表头);往下插 = tbody 第一行前面
        if (!isAfter) return;
        if (!tbody) {
          tbody = document.createElement('tbody');
          table.appendChild(tbody);
        }
        tbody.insertBefore(newRow, tbody.firstChild);
      } else {
        cellRow.parentElement.insertBefore(newRow, isAfter ? cellRow.nextSibling : cellRow);
      }
      break;
    }
    case 'row-del': {
      if (!cellRow) return;
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
        newCell.innerHTML = '&nbsp;';
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

  // 通知 vditor:dispatch 到编辑器内层 (contenteditable) 而非 table,vditor 在 reset 上挂的 input 监听
  const editor = getEditorEl();
  if (editor) {
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    table.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 操作完成后,主动重新探查 (这次 ctx 会从 selection 找到新 table)
  setTimeout(() => {
    currentTarget = null;
    currentCell = null;
    suppressUntil = 0;
    update();
  }, 30);
}

// ───── 显示 / 定位 ─────

function show(ctx) {
  popover.classList.remove('hkk-popover--hidden');
  position(ctx); // getBoundingClientRect 会强制 layout,无需等下一帧
}

function position(ctx) {
  if (!ctx) ctx = currentCtx;
  if (!ctx) return;
  if (ctx.type === 'table' && ctx.cell) {
    positionTable(ctx.cell);
  } else {
    positionDefault(ctx.target);
  }
}

function positionDefault(target) {
  if (!target?.getBoundingClientRect) return;
  const rect = target.getBoundingClientRect();
  const pRect = popover.getBoundingClientRect();
  let top = rect.top - pRect.height - 6;
  let left = rect.left;                            // 左对齐 target
  if (top < 8) top = rect.bottom + 6;
  if (left < 8) left = 8;
  if (left + pRect.width > window.innerWidth - 8) left = window.innerWidth - pRect.width - 8;
  popover.style.top = top + 'px';
  popover.style.left = left + 'px';
}

// 表格专用定位:跟随光标所在行 (不是整个表格),避开"表头/表尾固定位置"的远距离问题
//  - 折叠态 (…): 光标行的【左外侧】,不遮挡表格
//  - 展开态: 光标【上一行的最左边】,遮挡上一行 (留给用户操作)
function positionTable(cell) {
  const row = cell?.parentElement;
  if (!row?.getBoundingClientRect) return;
  const rowRect = row.getBoundingClientRect();
  const pRect = popover.getBoundingClientRect();

  let top, left;
  if (tableExpanded) {
    // 上一行的位置 = 上一行的 top + 上一行的 left
    let prevRow = row.previousElementSibling;
    if (!prevRow && row.parentElement) {
      // 跨 thead/tbody:取 thead/tbody 同级 section 的最后一行
      const section = row.parentElement;
      const prevSection = section.previousElementSibling;
      if (prevSection && prevSection.children.length > 0) {
        prevRow = prevSection.children[prevSection.children.length - 1];
      }
    }
    if (prevRow?.getBoundingClientRect) {
      const prevRect = prevRow.getBoundingClientRect();
      top = prevRect.top;
      left = prevRect.left;
    } else {
      // 没有上一行 (光标在表格首行) → 放当前行上方
      top = rowRect.top - pRect.height - 4;
      left = rowRect.left;
    }
  } else {
    // 折叠态:行的左外侧,不遮挡表格
    top = rowRect.top + (rowRect.height - pRect.height) / 2;
    left = rowRect.left - pRect.width - 4;
    if (left < 8) {
      // 左边不够 → 放在行内最左边(此时会轻微遮挡第一个单元格)
      left = rowRect.left + 4;
    }
  }
  // 边界 clamp (横纵)
  if (top < 8) top = 8;
  if (top + pRect.height > window.innerHeight - 8) top = window.innerHeight - pRect.height - 8;
  if (left < 4) left = 4;
  if (left + pRect.width > window.innerWidth - 8) left = window.innerWidth - pRect.width - 8;
  popover.style.top = top + 'px';
  popover.style.left = left + 'px';
}

function hide() {
  popover.classList.add('hkk-popover--hidden');
  currentTarget = null;
  currentType = null;
  currentCell = null;
  tableExpanded = false; // 离开特殊块 → 重置表格展开态,下次进表格回到折叠态
}

// ───── 字符串辅助 ─────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
