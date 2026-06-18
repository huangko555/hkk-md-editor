import { openLink, hotKeys, imageParser, getToolbar, autoSymbol, onToolbarClick, createContextMenu, scrollEditor, initThemeToggle, updateThemeToggle } from "./util.js";
import { initTOC } from "./toc.js";
import { initSearch } from "./search.js";

let state;
function loadConfigs() {
  const elem = document.getElementById('configs')
  try {
    state = JSON.parse(elem.getAttribute('data-config'));
    const { platform } = state;
    document.getElementById('vditor').classList.add(platform)
  } catch (error) {
    console.log('loadConfigFail')
  }
  return state;
}
loadConfigs()

// ────────────── 调试日志辅助 (保留以备需要,默认沉默) ──────────────
// 取消注释 handler.emit 可启用,extension 会写到 test-samples/hkk-debug.log
function dlog(...args) {
  // try {
  //   const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  //   handler.emit('debug-log', msg);
  // } catch {}
}

// ────────────── 自维护撤销/重做栈 (vditor IR 模式自带 undo 失效) ──────────────
const UNDO_LIMIT = 200;
const undoStack = [];
const redoStack = [];
let currentSavedContent = '';

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
  return document.querySelector('.vditor-reset, .vditor-content');
}

function focusEditable() {
  const mode = getVisibleMode();
  if (!mode) return null;
  const editable = mode.querySelector('[contenteditable="true"]')
    || (mode.getAttribute('contenteditable') === 'true' ? mode : null)
    || mode.querySelector('.vditor-reset')
    || mode;
  try { editable.focus(); return editable; } catch { return null; }
}

let doCustomUndo = () => { };
let doCustomRedo = () => { };

// Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const isZ = e.key === 'z' || e.key === 'Z';
  const isY = e.key === 'y' || e.key === 'Y';
  if (isZ && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    doCustomUndo();
  } else if (isY || (isZ && e.shiftKey)) {
    e.preventDefault();
    e.stopPropagation();
    doCustomRedo();
  }
}, true);

handler.on("open", async (md) => {
  currentSavedContent = md.content;

  const { config, language } = md;
  addAutoTheme(md.rootPath, config.editorTheme)
  initThemeToggle(config.editorTheme)
  handler.on('theme', theme => {
    loadTheme(md.rootPath, theme)
  })
  const editor = new Vditor('vditor', {
    value: md.content,
    _lutePath: md.rootPath + '/lute.min.js',
    cdn: md.rootPath,
    height: document.documentElement.clientHeight,
    outline: { enable: config.openOutline, position: 'left' },
    toolbarConfig: { hide: config.hideToolbar },
    cache: { enable: false },
    mode: 'ir',
    lang: language == 'zh-cn' ? 'zh_CN' : config.editorLanguage,
    icon: "material",
    tab: '\t',
    preview: {
      theme: { path: `${md.rootPath}/css/content-theme` },
      markdown: { toc: true, codeBlockPreview: config.previewCode },
      hljs: { style: config.previewCodeHighlight.style, lineNumber: config.previewCodeHighlight.showLineNumber },
      extPath: md.rootPath,
      math: { engine: 'KaTeX', "inlineDigit": true }
    },
    toolbar: await getToolbar(md.rootPath),
    extPath: md.rootPath,
    input(content) {
      if (content === currentSavedContent) return;
      // 旧状态压栈 (光标位置不存,Ctrl+Z 时按 diff 找编辑位置)
      if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== currentSavedContent) {
        undoStack.push(currentSavedContent);
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      }
      redoStack.length = 0;
      currentSavedContent = content;
      handler.emit("save", content);
    },
    upload: {
      url: '/image', accept: 'image/*',
      handler(files) {
        let reader = new FileReader();
        reader.readAsBinaryString(files[0]);
        reader.onloadend = () => { handler.emit("img", reader.result) };
      }
    },
    hint: { emoji: {}, extend: hotKeys },
    after() {
      // 外部 update (zhfix / 文件 watcher):用新内容覆盖,撤销栈清空
      handler.on("update", content => {
        editor.setValue(content);
        currentSavedContent = content;
        undoStack.length = 0;
        redoStack.length = 0;
      })
      openLink()
      onToolbarClick(editor)
      initTOC()
      initSearch()

      // setValue 前先清空 selection + blur,防止 vditor 内部 addCaret 因 stale Range 崩溃
      const safeSetValue = (content) => {
        try {
          const sel = window.getSelection();
          if (sel) sel.removeAllRanges();
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        } catch { }
        try { editor.setValue(content); } catch (e) { dlog('[hkk] setValue threw:', String(e)); }
      };

      // 第一处不同字符位置 = 编辑发生的源码位置
      function findFirstDiffPos(a, b) {
        const len = Math.min(a.length, b.length);
        let i = 0;
        while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) i++;
        return i;
      }

      // Block 级定位:按 \n\n 切 markdown 成块,光标落到 DOM 里对应那块开头
      // 牺牲块内列精度,换取在引用块/列表/代码块/表格/HR 等下的稳定性
      function placeCursorAtSourcePos(sourcePos, sourceContent) {
        const editorEl = getEditorEl();
        if (!editorEl) return false;

        // 找到 sourcePos 属于第几个 markdown block
        let blockIdx = 0;
        let blockStart = 0;
        let pos = 0;
        while (pos < sourceContent.length) {
          let nextBreak = sourceContent.indexOf('\n\n', pos);
          if (nextBreak === -1) nextBreak = sourceContent.length;
          if (sourcePos >= pos && sourcePos <= nextBreak) {
            blockStart = pos;
            break;
          }
          pos = nextBreak + 2;
          blockIdx++;
        }
        const colInBlock = sourcePos - blockStart;

        // 找 DOM 里对应那个 block (top-level child of editor)
        const blocks = Array.from(editorEl.children);
        const targetBlock = blocks[blockIdx] || blocks[blocks.length - 1];
        if (!targetBlock) return false;

        // 在 block 内走文本节点找位置 (跳过行首列表/引用块/有序列表标记和 \n)
        let walkedSource = 0;
        const blockSource = sourceContent.slice(blockStart, sourcePos + 100);
        const walker = document.createTreeWalker(targetBlock, NodeFilter.SHOW_TEXT);
        let node;
        let lastNode = null;
        let lastDomI = 0;
        while ((node = walker.nextNode())) {
          const text = node.textContent;
          let domI = 0;
          while (domI < text.length && walkedSource < colInBlock) {
            if (blockSource[walkedSource] === '\n') { walkedSource++; continue; }
            const isLineStart = walkedSource === 0 || blockSource[walkedSource - 1] === '\n';
            if (isLineStart) {
              if (blockSource[walkedSource] === '>' && blockSource[walkedSource + 1] === ' ') { walkedSource += 2; continue; }
              if ((blockSource[walkedSource] === '-' || blockSource[walkedSource] === '*' || blockSource[walkedSource] === '+') && blockSource[walkedSource + 1] === ' ') { walkedSource += 2; continue; }
              let j = walkedSource;
              while (j < blockSource.length && blockSource.charCodeAt(j) >= 48 && blockSource.charCodeAt(j) <= 57) j++;
              if (j > walkedSource && blockSource[j] === '.' && blockSource[j + 1] === ' ') { walkedSource = j + 2; continue; }
            }
            if (blockSource[walkedSource] === text[domI]) {
              walkedSource++; domI++;
            } else {
              domI++;
            }
          }
          if (walkedSource >= colInBlock) {
            placeRangeAt(node, domI);
            return true;
          }
          lastNode = node;
          lastDomI = text.length;
        }
        if (lastNode) { placeRangeAt(lastNode, lastDomI); return true; }
        return false;
      }

      function placeRangeAt(node, domOffset) {
        try {
          const range = document.createRange();
          range.setStart(node, Math.min(domOffset, node.textContent.length));
          range.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          focusEditable();
          if (node.parentElement && node.parentElement.scrollIntoView) {
            node.parentElement.scrollIntoView({ block: 'center', behavior: 'instant' });
          }
          // 光标所在的 .vditor-ir__node 强制加 --expand,显示 markdown 源符号 (## ** 等)
          // 因为 vditor 不会因为我们手动设光标就自动展开
          const startEl = node.nodeType === 1 ? node : node.parentElement;
          const irNode = startEl?.closest('.vditor-ir__node');
          if (irNode) {
            document.querySelectorAll('.vditor-ir__node--expand').forEach(n => {
              if (n !== irNode) n.classList.remove('vditor-ir__node--expand');
            });
            irNode.classList.add('vditor-ir__node--expand');
          }
        } catch { }
      }

      const restoreAfterSetValue = (sourcePos, sourceContent) => {
        // 只放一次,多次调用会跟 vditor 内部 expand 逻辑打架把光标搞回原点
        setTimeout(() => placeCursorAtSourcePos(sourcePos, sourceContent), 120);
      };

      doCustomUndo = () => {
        if (undoStack.length === 0) return;
        const prevContent = undoStack.pop();
        const editPos = findFirstDiffPos(currentSavedContent, prevContent);
        redoStack.push(currentSavedContent);
        currentSavedContent = prevContent;
        safeSetValue(prevContent);
        handler.emit("save", prevContent);
        restoreAfterSetValue(editPos, prevContent);
      };
      doCustomRedo = () => {
        if (redoStack.length === 0) return;
        const nextContent = redoStack.pop();
        const editPos = findFirstDiffPos(currentSavedContent, nextContent);
        undoStack.push(currentSavedContent);
        currentSavedContent = nextContent;
        safeSetValue(nextContent);
        handler.emit("save", nextContent);
        restoreAfterSetValue(editPos, nextContent);
      };
    }
  })
  autoSymbol(handler, editor, config);
  createContextMenu(editor)
  imageParser(config.viewAbsoluteLocal)
  scrollEditor(md.scrollTop)
  zoomElement('.vditor-content')
}).emit("init")


function addAutoTheme(rootPath, theme) {
  loadCSS(rootPath, 'base.css')
  loadTheme(rootPath, theme)
}

function loadTheme(rootPath, theme) {
  loadCSS(rootPath, `theme/${theme}.css`)
  document.getElementById('vditor').setAttribute('data-editor-theme', theme)
  updateThemeToggle(theme)
}

function loadCSS(rootPath, path) {
  const style = document.createElement('link');
  style.rel = "stylesheet";
  style.type = "text/css";
  style.href = `${rootPath}/css/${path}`;
  document.documentElement.appendChild(style)
}
