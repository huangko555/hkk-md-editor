// 代码块 / 数学块的 modal 编辑器:绕开 vditor IR 模式行内编辑会丢字的 bug。
// 入口:popover 上的"编辑"按钮 → openBlockEditor('code' | 'math', targetEl)
// 流程:从 markdown 里按"第 N 个块"定位范围 → 弹 modal 编辑 → 整段替换 → safeSetValue

let overlay = null;
let panel = null;
let textarea = null;
let langInput = null;
let titleEl = null;
let currentSession = null;

function getEditorEl() {
  for (const sel of ['.vditor-ir', '.vditor-wysiwyg', '.vditor-sv']) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el.querySelector('.vditor-reset') || el;
  }
  return null;
}

// 在 markdown 里按顺序找第 n 个 fenced code block (``` 或 ~~~,允许 0-3 空格缩进)
function findNthFencedBlock(md, n) {
  const re = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*([^\n]*)\n([\s\S]*?)^\1\2[ \t]*$/gm;
  let m, i = 0;
  while ((m = re.exec(md))) {
    if (i === n) {
      return {
        start: m.index,
        end: m.index + m[0].length,
        indent: m[1] || '',
        fence: m[2],
        lang: (m[3] || '').trim(),
        code: m[4].replace(/\n$/, ''),
      };
    }
    i++;
  }
  return null;
}

// 在 markdown 里按顺序找第 n 个 $$ ... $$ 块 (块级数学,不是行内 $x$)
function findNthMathBlock(md, n) {
  const re = /^\$\$[ \t]*\n([\s\S]*?)\n\$\$[ \t]*$/gm;
  let m, i = 0;
  while ((m = re.exec(md))) {
    if (i === n) {
      return {
        start: m.index,
        end: m.index + m[0].length,
        content: m[1],
      };
    }
    i++;
  }
  return null;
}

export function initBlockEditor() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.className = 'hkk-block-modal hkk-block-modal--hidden';
  overlay.innerHTML = `
    <div class="hkk-block-modal__panel">
      <div class="hkk-block-modal__header">
        <span class="hkk-block-modal__title">编辑</span>
        <input type="text" class="hkk-block-modal__lang" placeholder="语言 (如 javascript / python)" spellcheck="false" />
      </div>
      <textarea class="hkk-block-modal__textarea" spellcheck="false"></textarea>
      <div class="hkk-block-modal__footer">
        <span class="hkk-block-modal__hint">Esc 取消,Ctrl+Enter 确认</span>
        <button type="button" class="hkk-block-modal__btn" data-action="cancel">取消</button>
        <button type="button" class="hkk-block-modal__btn hkk-block-modal__btn--primary" data-action="confirm">确认</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  panel = overlay.querySelector('.hkk-block-modal__panel');
  titleEl = overlay.querySelector('.hkk-block-modal__title');
  langInput = overlay.querySelector('.hkk-block-modal__lang');
  textarea = overlay.querySelector('.hkk-block-modal__textarea');

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset?.action;
    if (action === 'cancel') close();
    if (action === 'confirm') commit();
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { commit(); e.preventDefault(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      const s = textarea.selectionStart, n = textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, s) + '\t' + textarea.value.slice(n);
      textarea.selectionStart = textarea.selectionEnd = s + 1;
    }
  });
  langInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'Enter') { textarea.focus(); e.preventDefault(); }
  });
}

export function openBlockEditor(type, target) {
  const editor = window.__hkkEditor;
  if (!editor) return;
  const root = getEditorEl();
  if (!root) return;
  const md = editor.getValue();

  if (type === 'code') {
    const all = Array.from(root.querySelectorAll('.vditor-ir__node[data-type="code-block"]'));
    const idx = all.indexOf(target);
    if (idx < 0) return;
    const found = findNthFencedBlock(md, idx);
    if (!found) return;
    titleEl.textContent = '编辑代码块';
    langInput.style.display = '';
    langInput.value = found.lang;
    textarea.value = found.code;
    currentSession = {
      type: 'code',
      start: found.start, end: found.end,
      indent: found.indent, fence: found.fence,
    };
  } else if (type === 'math') {
    const all = Array.from(root.querySelectorAll('.vditor-ir__node[data-type="math-block"]'));
    const idx = all.indexOf(target);
    if (idx < 0) return;
    const found = findNthMathBlock(md, idx);
    if (!found) return;
    titleEl.textContent = '编辑数学块';
    langInput.style.display = 'none';
    langInput.value = '';
    textarea.value = found.content;
    currentSession = {
      type: 'math',
      start: found.start, end: found.end,
    };
  } else {
    return;
  }

  overlay.classList.remove('hkk-block-modal--hidden');
  // 让 modal 抢焦点,vditor 才不会还在响应键盘
  setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, 0);
}

function commit() {
  if (!currentSession) return;
  const editor = window.__hkkEditor;
  const apply = window.__hkkApplyMarkdown;
  if (!editor || !apply) { close(); return; }
  const md = editor.getValue();
  const newCode = textarea.value.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  let newBlock;
  if (currentSession.type === 'code') {
    const lang = langInput.value.trim();
    const fence = currentSession.fence || '```';
    const indent = currentSession.indent || '';
    newBlock = `${indent}${fence}${lang}\n${newCode}\n${indent}${fence}`;
  } else {
    newBlock = `$$\n${newCode}\n$$`;
  }
  const { start, end } = currentSession;
  // 用 modal 打开时记下来的 range 替换;期间 md 可能因撤销/外部 update 变化,
  // 简单兜底:如 start/end 越界就放弃 (不破坏文档)。
  if (start < 0 || end > md.length || start > end) { close(); return; }
  const newMd = md.slice(0, start) + newBlock + md.slice(end);
  if (newMd !== md) apply(newMd);
  close();
}

function close() {
  if (!overlay) return;
  overlay.classList.add('hkk-block-modal--hidden');
  currentSession = null;
}
