// HKK MD Editor IR 模式上下文 popover (Phase 4.3)
// 监听光标变化,光标进入特定块 (链接 / 代码块 / 表格 / 图片 / 数学 / Mermaid / 任务) 时,
// 在块上方浮出小菜单,显示该块的操作按钮 (vditor wysiwyg 模式自带 popover,IR 没有,这里补)

import { openBlockEditor } from './block-editor.js';

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

// 自定义代码块复制按钮:vditor 原生 .vditor-copy 在 webview 里 execCommand 失效,
// 且 IR 模式下 mousedown 会把光标放进代码块触发节点 expand。直接做一个独立浮动按钮,
// 跟随鼠标当前 hover 的代码块,定位到右上角;mousedown preventDefault 不抢焦点。
// 配合 CSS 把原生 .vditor-copy 隐藏。
let codeCopyBtn = null;
let codeCopyTarget = null;
let codeCopyHideTimer = 0;

function installCodeCopyButton() {
  codeCopyBtn = document.createElement('button');
  codeCopyBtn.type = 'button';
  codeCopyBtn.className = 'hkk-code-copy hkk-code-copy--hidden';
  codeCopyBtn.setAttribute('aria-label', '复制代码');
  codeCopyBtn.innerHTML = '<svg><use xlink:href="#vditor-icon-copy"></use></svg>';
  document.body.appendChild(codeCopyBtn);

  codeCopyBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  codeCopyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!codeCopyTarget || !document.contains(codeCopyTarget)) return;
    const text = extractCodeText(codeCopyTarget);
    if (!text) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
    codeCopyBtn.setAttribute('aria-label', '已复制');
    setTimeout(() => codeCopyBtn?.setAttribute('aria-label', '复制代码'), 1500);
  });

  // hover 跟随:鼠标进入代码块 → 显示按钮并定位;离开后短延迟隐藏,允许移到按钮上
  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (t === codeCopyBtn || (t.nodeType === 1 && codeCopyBtn.contains(t))) {
      clearTimeout(codeCopyHideTimer);
      return;
    }
    const block = t.nodeType === 1 && t.closest
      ? t.closest('.vditor-ir__node[data-type="code-block"], pre[class*="language-"]')
      : null;
    if (block) {
      clearTimeout(codeCopyHideTimer);
      codeCopyTarget = block;
      // 展开态:不显示浮动复制按钮
      if (block.classList.contains('vditor-ir__node--expand')) {
        codeCopyBtn.classList.add('hkk-code-copy--hidden');
      } else {
        positionCodeCopyBtn(block);
        codeCopyBtn.classList.remove('hkk-code-copy--hidden');
      }
    } else {
      clearTimeout(codeCopyHideTimer);
      codeCopyHideTimer = setTimeout(() => {
        codeCopyBtn.classList.add('hkk-code-copy--hidden');
        codeCopyTarget = null;
      }, 120);
    }
  });
}

function positionCodeCopyBtn(block) {
  // 展开态不显示浮动复制按钮
  if (block.classList.contains('vditor-ir__node--expand')) {
    codeCopyBtn.classList.add('hkk-code-copy--hidden');
    return;
  }
  // 严格绑定到蓝色预览背景:按钮距其上边 / 右边固定 8px
  const preview = block.querySelector('.vditor-ir__preview') || block;
  const rect = preview.getBoundingClientRect();
  // 预览区滚出视口 → 隐藏
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    codeCopyBtn.classList.add('hkk-code-copy--hidden');
    return;
  }
  const margin = 8;
  const btnW = 28; // 与 CSS .hkk-code-copy 宽度一致
  codeCopyBtn.style.top = (rect.top + margin) + 'px';
  codeCopyBtn.style.left = (rect.right - btnW - margin) + 'px';
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
}

export function initPopover() {
  if (popover) return;

  installCodeCopyButton();
  initCodeFold();

  popover = document.createElement('div');
  popover.id = 'hkk-popover';
  popover.className = 'hkk-popover hkk-popover--hidden';
  document.body.appendChild(popover);

  // 点 popover 内部不要触发隐藏 (短暂屏蔽);按钮 mousedown 阻止抢焦点
  popover.addEventListener('mousedown', (e) => {
    suppressUntil = Date.now() + 300;
    if (e.target.closest('[data-action]')) e.preventDefault();
  });
  // 事件委托:popover 内所有 [data-action] 共用一个 click 监听 (避免 render 时反复绑解绑)
  popover.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !currentCtx) return;
    handleAction(currentCtx, btn.dataset.action, e);
  });

  document.addEventListener('selectionchange', schedule);
  document.addEventListener('mouseup', schedule);
  document.addEventListener('keyup', schedule);
  window.addEventListener('resize', schedule);
  // 焦点切到编辑器和 popover 之外 → 隐藏 (失焦自动收起)
  document.addEventListener('focusin', (e) => {
    const editor = getEditorEl();
    if (!editor) return;
    if (editor.contains(e.target) || popover.contains(e.target)) return;
    hide();
  });
  // 兜底:点击在编辑器和 popover 之外(例如目录、工具栏、空白)→ 隐藏
  // focusin 只对 focusable 元素 (input/button/contenteditable) 触发,普通 div(目录项) 不触发
  document.addEventListener('pointerdown', (e) => {
    const editor = getEditorEl();
    if (!editor) return;
    if (editor.contains(e.target) || popover.contains(e.target)) return;
    hide();
  }, true);
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
  requestAnimationFrame(() => { updateScheduled = false; update(); scheduleFoldScan(); });
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

  // 光标在同一 target 内 (含表格跨 cell):只更新 cell + reposition,不重渲 innerHTML
  if (currentTarget === ctx.target && currentType === ctx.type) {
    currentCell = ctx.cell || null;
    currentCtx = ctx;
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
    <button type="button" class="hkk-popover__btn" data-action="edit-code" title="编辑代码 (打开独立编辑器)">${ICON('edit')}</button>
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
    <button type="button" class="hkk-popover__btn" data-action="edit-math" title="编辑公式 (打开独立编辑器)">${ICON('edit')}</button>
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
        if (action === 'edit-code') openBlockEditor('code', ctx.target);
        break;
      case 'image':
        if (action === 'copy-src') copyText(ctx.target.getAttribute('src') || '');
        break;
      case 'math-block':
        if (action === 'edit-math') openBlockEditor('math', ctx.target);
        if (action === 'copy-math') copyText(ctx.target.textContent.replace(/\$/g, ''));
        break;
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
      // 删行前先把光标移到相邻行,防止浏览器把光标推到表格外
      // 触发 input 时光标在表格外会导致 vditor/Lute 在表格上方插入空段落
      const sibRows = Array.from(cellRow.parentElement.children);
      const ri = sibRows.indexOf(cellRow);
      const fallback = sibRows[ri + 1] || sibRows[ri - 1];
      if (fallback) {
        const fc = fallback.querySelector('td, th');
        if (fc) {
          const r = document.createRange();
          r.setStart(fc, 0);
          r.collapse(true);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        }
      }
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
      // 删列前先把光标移到相邻列,防止浏览器把光标推到表格外触发 vditor 插空段落
      if (cellRow) {
        const fallbackCell = cellRow.children[cellIdx + 1] || cellRow.children[cellIdx - 1];
        if (fallbackCell) {
          const r = document.createRange();
          r.setStart(fallbackCell, 0);
          r.collapse(true);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        }
      }
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
  // target 完全滚出视口 → hide (与表格一致)
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    hide();
    return;
  }
  const pRect = popover.getBoundingClientRect();
  let top = rect.top - pRect.height - 6;
  let left = rect.left;                            // 左对齐 target
  if (top < 8) top = rect.bottom + 6;
  if (left < 8) left = 8;
  if (left + pRect.width > window.innerWidth - 8) left = window.innerWidth - pRect.width - 8;
  popover.style.top = top + 'px';
  popover.style.left = left + 'px';
}

// 表格专用定位
//  - 折叠态 (…): 光标行的【左外侧】,不遮挡表格
//  - 展开态: 当前单元格的左上方 (左对齐 cell.left, 位于 cell 上方; 顶部塞不下时翻到下方)
function positionTable(cell) {
  const row = cell?.parentElement;
  if (!row?.getBoundingClientRect) return;
  // cell 完全滚出视口 → 直接 hide (清状态,不自动恢复;再次出现需光标动作触发)
  const cellRect = cell.getBoundingClientRect();
  if (cellRect.bottom < 0 || cellRect.top > window.innerHeight) {
    hide();
    return;
  }
  const rowRect = row.getBoundingClientRect();
  const pRect = popover.getBoundingClientRect();

  let top, left;
  if (tableExpanded) {
    left = cellRect.left;
    top = cellRect.top - pRect.height - 4;
    if (top < 8) {
      // 上方塞不下 → 翻到 cell 下方
      top = cellRect.bottom + 4;
    }
  } else {
    // 折叠态:始终在行的左外侧,不遮挡第一列(左侧空间不足也不翻到右边)
    top = rowRect.top + (rowRect.height - pRect.height) / 2;
    left = rowRect.left - pRect.width - 4;
  }
  // 边界 clamp:纵向始终生效
  if (top < 8) top = 8;
  if (top + pRect.height > window.innerHeight - 8) top = window.innerHeight - pRect.height - 8;
  // 横向 clamp 只对展开态生效;折叠态宁可超出视口左缘也保持在第一列左外侧,绝不翻到右边遮挡首列
  if (tableExpanded) {
    if (left < 4) left = 4;
    if (left + pRect.width > window.innerWidth - 8) left = window.innerWidth - pRect.width - 8;
  }
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

// ──── 代码块折叠 (超过 12 行截断 + 展开/收起按钮) ────

const CODE_FOLD_LINE_H = 18;          // px，与 hkk-theme.css line-height 一致
const CODE_FOLD_THRESHOLD = CODE_FOLD_LINE_H * 12 + 8; // 12行 + padding 余量

// 判断代码块是否有明确的语言标注(无语言块不走折叠流程)
// 只信 .vditor-ir__marker--info 的用户输入;fallback 的 pre.class 会被 hljs 自动标注,不可信
function blockHasLang(block) {
  const info = block.querySelector('.vditor-ir__marker--info');
  if (!info) return false;
  const cleaned = info.textContent.replace(/[\s​ ‌‍﻿]/g, '');
  return cleaned.length > 0;
}

let codeFoldScanTimer = 0;

function scheduleFoldScan() {
  clearTimeout(codeFoldScanTimer);
  codeFoldScanTimer = setTimeout(updateAllCodeFolds, 400);
}

function cleanupStaleFoldBtns() {
  for (const [block, btn] of foldBtns) {
    if (!document.contains(block)) {
      btn._cleanup?.();
      btn.remove();
      foldBtns.delete(block);
    }
  }
}

function updateAllCodeFolds() {
  cleanupStaleFoldBtns(); // 先清掉 vditor 重建 DOM 后遗留的孤立按钮
  document.querySelectorAll(
    '.vditor-ir__node[data-type="code-block"]:not([data-hkk-fold-init]):not(.vditor-ir__node--expand)'
  ).forEach(block => {
    const preview = block.querySelector('.vditor-ir__preview');
    if (preview) initCodeFoldForBlock(block, preview);
  });
}

// 测量 preview 自然高度（移除 folded class 避免 max-height 干扰）
function measurePreviewH(preview) {
  const wasFolded = preview.classList.contains('hkk-code-preview--folded');
  preview.classList.remove('hkk-code-preview--folded');
  const h = preview.scrollHeight;
  if (wasFolded) preview.classList.add('hkk-code-preview--folded');
  return h;
}

// 折叠按钮在文档流里（position: relative），随内容自然滚动，不需要 JS 同步位置。
// 防止 vditor 序列化污染的策略：代码块进入编辑模式（--expand）时摘走按钮，退出后装回。
const foldBtns = new Map(); // block → button

function makeFoldBtn(block, preview) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hkk-code-fold-btn';
  btn.textContent = preview.classList.contains('hkk-code-preview--folded') ? '展开全部' : '收起';

  const sp = btn.style;
  sp.setProperty('display', 'block', 'important');
  sp.setProperty('position', 'relative', 'important');
  sp.setProperty('z-index', '10', 'important');
  sp.setProperty('box-sizing', 'border-box', 'important');
  sp.setProperty('padding', '1px 0', 'important');
  sp.setProperty('background', '#435e84', 'important');
  sp.setProperty('color', '#e8f0fe', 'important');
  sp.setProperty('border', 'none', 'important');
  sp.setProperty('border-radius', '4px', 'important');
  sp.setProperty('font-size', '12px', 'important');
  sp.setProperty('line-height', '1.5', 'important');
  sp.setProperty('text-align', 'center', 'important');
  sp.setProperty('cursor', 'pointer', 'important');
  sp.setProperty('user-select', 'none', 'important');
  sp.setProperty('letter-spacing', '0.5px', 'important');
  sp.setProperty('margin-top', '1px', 'important');
  sp.setProperty('width', '100%', 'important');

  btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const nowFolded = preview.classList.toggle('hkk-code-preview--folded');
    btn.textContent = nowFolded ? '展开全部' : '收起';
  });
  btn.addEventListener('mouseover', () => { btn.style.setProperty('background', '#4f6e99', 'important'); });
  btn.addEventListener('mouseout',  () => { btn.style.setProperty('background', '#435e84', 'important'); });

  // 宽度对齐到 preview（preview 有左缩进，block 宽度比它大）
  const align = () => {
    const blockRect = block.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();
    if (previewRect.width > 0 && blockRect.width > 0) {
      sp.setProperty('margin-left', Math.max(0, Math.round(previewRect.left - blockRect.left)) + 'px', 'important');
      sp.setProperty('width', Math.round(previewRect.width) + 'px', 'important');
    }
  };
  requestAnimationFrame(align);
  const onResize = () => requestAnimationFrame(align);
  window.addEventListener('resize', onResize, { passive: true });
  btn._cleanup = () => window.removeEventListener('resize', onResize);

  block.appendChild(btn);
  foldBtns.set(block, btn);
}

function removeFoldBtn(block) {
  const btn = foldBtns.get(block);
  if (btn) {
    btn._cleanup?.();
    btn.remove();
    foldBtns.delete(block);
  }
}

// 首次初始化：默认折叠 + 加按钮（无语言的代码块不折叠）
function initCodeFoldForBlock(block, preview) {
  if (!blockHasLang(block) || measurePreviewH(preview) <= CODE_FOLD_THRESHOLD) {
    block.dataset.hkkFoldInit = '1';
    return;
  }
  preview.classList.add('hkk-code-preview--folded');
  if (!foldBtns.has(block)) makeFoldBtn(block, preview);
  block.dataset.hkkFoldInit = '1';
}

// 退出编辑时重新验证：只处理内容缩减（≤12行）的情况，不改变用户选择的展开/折叠状态
function revalidateCodeFold(block) {
  if (!document.contains(block)) return;
  const preview = block.querySelector('.vditor-ir__preview');
  if (!preview) return;

  // 无语言代码块：确保折叠和按钮都清掉
  if (!blockHasLang(block)) {
    preview.classList.remove('hkk-code-preview--folded');
    removeFoldBtn(block);
    block.dataset.hkkFoldInit = '1';
    return;
  }

  if (measurePreviewH(preview) <= CODE_FOLD_THRESHOLD) {
    preview.classList.remove('hkk-code-preview--folded');
    removeFoldBtn(block);
    block.dataset.hkkFoldInit = '1';
    return;
  }

  if (!foldBtns.has(block)) makeFoldBtn(block, preview);
  block.dataset.hkkFoldInit = '1';
}

function initCodeFold() {
  const classObserver = new MutationObserver(mutations => {
    mutations.forEach(m => {
      if (m.type !== 'attributes') return;
      const el = m.target;
      if (!el.matches?.('.vditor-ir__node[data-type="code-block"]')) return;
      if (el.classList.contains('vditor-ir__node--expand')) {
        // 进入编辑：摘走按钮，防止 vditor 把它序列化进代码内容
        removeFoldBtn(el);
        return;
      }
      // 退出编辑：给 vditor 150ms 完成 preview 重渲，再重新验证
      setTimeout(() => revalidateCodeFold(el), 150);
    });
  });

  setTimeout(() => {
    const root = document.querySelector('#vditor') || document.body;
    classObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ['class'] });
    updateAllCodeFolds();
  }, 600);
}
