import { openLink, hotKeys, imageParser, getToolbar, autoSymbol, onToolbarClick, createContextMenu, scrollEditor, initThemeToggle, updateThemeToggle } from "./util.js";
import { initTOC } from "./toc.js";
import { initSearch } from "./search.js";
import { initPopover } from "./popover.js";
import { initBlockEditor } from "./block-editor.js";

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

// 调试日志 (需要时取消注释 handler.emit,extension 会写到 test-samples/hkk-debug.log)
function dlog(...args) {
  try {
    // const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    // handler.emit('debug-log', msg);
  } catch {}
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

// ── B':可见文字偏移 ↔ DOM 光标位置 (撤销/重做光标定位的统一坐标系) ──
// 遍历可见 IR 的文本节点时,统一跳过 .vditor-ir__marker 内的文本 (## ** > 等源符号)。
// "编辑前记录" 与 "撤销后恢复" 用同一规则,不再依赖 markdown 源码↔DOM 的脆弱换算。
// 排除"不算可见正文"的区域:源符号 marker (## ** ``` 等) + 预览区 (代码块/图片/数学的渲染副本)。
// 注意:用精确类名 contains('vditor-ir__marker') —— 不会误伤 marker--pre / marker--link
// 这类"内容容器"(它们包裹的是可编辑正文,要计入),只命中真正的源符号节点。
function isExcluded(node, root) {
  let el = node.nodeType === 1 ? node : node.parentElement;
  while (el && el !== root) {
    const c = el.classList;
    if (c) {
      if (c.contains('vditor-ir__preview')) return true;        // 渲染预览副本:排除 (优先,避免代码被算两遍)
      if (c.contains('vditor-ir__marker--pre')) return false;   // 代码块 source:里面的代码是可编辑正文,保留
      if (c.contains('vditor-ir__marker')) return true;         // 其它源符号 (## ** 语言info 等):排除
    }
    const dt = el.getAttribute && el.getAttribute('data-type');
    if (dt === 'code-block-open-marker' || dt === 'code-block-close-marker') return true;  // ``` 围栏:排除
    el = el.parentElement;
  }
  return false;
}
function makeVisWalker(root) {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return isExcluded(n, root) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
}
// 文本节点所属的"行/格/块"单元:表格格(td/th)、列表项(li) 或顶层块。
// 相邻文本节点跨单元时,getVisText 与落点都插一个分隔位,消除单元边界偏移二义
// (否则:表格里单元格开头会落到上一格尾、句首会落到上一行尾)。
function blockUnitOf(node, root) {
  let el = node.nodeType === 1 ? node : node.parentElement;
  while (el && el !== root) {
    const tag = el.tagName;
    if (tag === 'TD' || tag === 'TH' || tag === 'LI') return el;
    if (el.parentElement === root) return el;
    el = el.parentElement;
  }
  return el || root;
}
// 当前可见全文 (跳过 marker/preview),按"单元"插 '\n':撤销/重做时比对前后两份定位变化区
function getVisText() {
  const root = getEditorEl();
  if (!root) return '';
  const walker = makeVisWalker(root);
  let s = '', node, prevUnit = null, first = true;
  while ((node = walker.nextNode())) {
    const unit = blockUnitOf(node, root);
    if (!first && unit !== prevUnit) s += '\n';
    s += node.textContent;
    prevUnit = unit; first = false;
  }
  return s;
}
function placeCaretAtVisOffset(target) {
  if (target < 0) return false;
  const root = getEditorEl();
  if (!root) return false;
  const walker = makeVisWalker(root);
  let node, acc = 0, lastNode = null, prevUnit = null, first = true;
  while ((node = walker.nextNode())) {
    const unit = blockUnitOf(node, root);
    if (!first && unit !== prevUnit) acc += 1;   // 跨单元分隔,与 getVisText 完全对齐
    const len = node.textContent.length;
    // 单元内边界落前节点末尾(同格/同段连续,视觉无差);跨单元因分隔不再重合,各归各位。
    if (acc + len >= target) { placeRangeAt(node, target - acc); return true; }
    acc += len;
    lastNode = node; prevUnit = unit; first = false;
  }
  if (lastNode) { placeRangeAt(lastNode, lastNode.textContent.length); return true; }
  return false;
}
// 降级:可见文字 diff 看不到变化 (变化在代码块/公式等 marker/preview 区) 时,
// 用 markdown diff 找出变化所在的顶层块,光标落到该块,至少不跳文档末尾。
function placeCaretAtChangedBlock(fromMd, toMd) {
  const root = getEditorEl();
  if (!root) return false;
  const minL = Math.min(fromMd.length, toMd.length);
  let d = 0;
  while (d < minL && fromMd.charCodeAt(d) === toMd.charCodeAt(d)) d++;
  // d 落在 toMd 的第几个块 (按空行 \n\n 切)
  let blockIdx = 0, pos = 0;
  while (pos < toMd.length) {
    let nb = toMd.indexOf('\n\n', pos);
    if (nb === -1) nb = toMd.length;
    if (d >= pos && d <= nb) break;
    pos = nb + 2; blockIdx++;
  }
  const block = root.children[blockIdx] || root.children[root.children.length - 1];
  if (!block) return false;
  // 降级优先:块内若有 IR 节点 (链接/公式/强调等可见坐标系盲区),落进它的文字。
  // placeRangeAt 落进 .vditor-ir__node 会自动给它加 --expand → 顺带解决"不展开"。
  const irNode = block.querySelector && block.querySelector('.vditor-ir__node');
  if (irNode) {
    const w = document.createTreeWalker(irNode, NodeFilter.SHOW_TEXT);
    const tn = w.nextNode();
    if (tn) { placeRangeAt(tn, 0); return true; }
  }
  // 否则落到块内最后一个可见文本节点末尾;整块都是 marker/preview 就落块开头
  const walker = makeVisWalker(block);
  let node, last = null;
  while ((node = walker.nextNode())) last = node;
  if (last) placeRangeAt(last, last.textContent.length);
  else placeRangeAt(block, 0);
  return true;
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
    // 光标所在的 .vditor-ir__node 强制 --expand,显示 markdown 源符号 (## ** 等)
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

let doCustomUndo = () => { };
let doCustomRedo = () => { };

// Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  // block editor modal 开着时,undo/redo 不触发,防止 baseMd 快照与 session 不一致
  if (document.activeElement?.closest?.('.hkk-block-modal:not(.hkk-block-modal--hidden)')) return;
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
  // 归一换行符:Windows 文件常是 CRLF,代码块折叠预览会把 \r 也当一次换行 → 每行后多一条空行。
  // 统一成 \n;保存时 provider 的 applyEdit 会按文档原有 EOL 重新规范化,不改动磁盘文件的换行风格。
  md.content = (md.content ?? '').replace(/\r\n?/g, '\n');
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
    outline: { enable: false, position: 'left' },   // 原生大纲彻底关闭 (已由自定义 TOC 替代),不再读 config
    toolbarConfig: { hide: config.hideToolbar },
    cache: { enable: false },
    undoDelay: 200,   // input 防抖:默认 800ms 太长,会把"分别编辑的多处"合并成一个撤销步;改 200ms 让光标一移动就分界

    mode: 'ir',
    lang: language == 'zh-cn' ? 'zh_CN' : config.editorLanguage,
    icon: "material",
    tab: '\t',
    preview: {
      theme: { path: `${md.rootPath}/css/content-theme` },
      markdown: { toc: true, codeBlockPreview: config.previewCode },
      hljs: { style: 'vim', lineNumber: config.previewCodeHighlight.showLineNumber },
      extPath: md.rootPath,
      math: { engine: 'KaTeX', "inlineDigit": true }
    },
    toolbar: await getToolbar(md.rootPath),
    extPath: md.rootPath,
    input(content) {
      if (content === currentSavedContent) return;
      // 只存内容快照。光标落点在撤销/重做时,靠"切换前后可见文本 diff"现算 (变化区末尾)。
      const oldContent = currentSavedContent;
      const top = undoStack[undoStack.length - 1];
      if (!top || top.content !== oldContent) {
        undoStack.push({ content: oldContent });
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
        content = (content ?? '').replace(/\r\n?/g, '\n');
        editor.setValue(content);
        currentSavedContent = content;
        undoStack.length = 0;
        redoStack.length = 0;
      })
      openLink()
      onToolbarClick(editor)
      initTOC(md.tocState)
      initSearch()
      initPopover()
      initBlockEditor()

      // setValue 前先清空 selection + blur,防止 vditor 内部 addCaret 因 stale Range 崩溃
      const safeSetValue = (content) => {
        try {
          const sel = window.getSelection();
          if (sel) sel.removeAllRanges();
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        } catch { }
        try { editor.setValue(content); } catch (e) { dlog('[hkk] setValue threw:', String(e)); }
      };

      // Fix LESSONS §1.7: SpinVditorIRDOM 对 code/math 块有两个 bug:
      // (1) <wbr> 在 code 内容里会被 Lute 当 HTML 元素处理,导致内容被截断丢字
      // (2) Lute 从零重建 IR DOM,不保留运行时 --expand,每次 outerHTML 替换后块折叠
      // 修法: (1) <wbr> 换成哨兵文本绕过 Lute,出来后还原第一个,删掉其余(Lute 会把
      //           哨兵同时写进 source 和 preview 两区,后者不还原会显示为乱字)
      //       (2) 只要光标在 code/math 块内(<wbr> 存在),无论 input 是否有 --expand
      //           都强制往结果里补回来 —— 因为每次 outerHTML 赋值后 --expand 必然丢失
      if (editor.vditor?.lute) {
        const _lute = editor.vditor.lute;
        const _origSpin = _lute.SpinVditorIRDOM.bind(_lute);
        // vditor 在代码块里同时可能用两种光标标记:
        //   <wbr>                          → 用 _WBR 哨兵保护
        //   <span class="vditor-wbr"></span> → 用 _VWBR 哨兵保护
        // 两者都会被 Lute 当 HTML 元素截断代码内容;必须进 Lute 前都替换掉
        const _WBR  = '\x02HKKWBR\x02';
        const _VWBR = 'HKKVWBR';
        _lute.SpinVditorIRDOM = function(html) {
          const isCodeOrMath = html.indexOf('data-type="code-block"') >= 0
            || html.indexOf('data-type="math-block"') >= 0;
          if (!isCodeOrMath) return _origSpin(html);
          const hasWbr  = html.indexOf('<wbr>') >= 0;
          const hasVWbr = html.indexOf('class="vditor-wbr"') >= 0;
          if (!hasWbr && !hasVWbr) return _origSpin(html);
          let sentHtml = html;
          if (hasWbr)  sentHtml = sentHtml.replace(/<wbr>/g, _WBR);
          if (hasVWbr) sentHtml = sentHtml.replace(/<span\b[^>]*\bclass="vditor-wbr"[^>]*><\/span>/g, _VWBR);
          const result = _origSpin(sentHtml);
          // 还原第一个 _WBR → <wbr>(setRangeByWbr 用来落光标)
          let fixed = result.replace(_WBR, '<wbr>');
          // 清掉所有剩余哨兵(Lute 会把哨兵写进 source 和 preview 两区)
          if (fixed.indexOf(_WBR)  >= 0) fixed = fixed.split(_WBR).join('');
          if (fixed.indexOf(_VWBR) >= 0) fixed = fixed.split(_VWBR).join('');
          // 光标在块内 → 强制保持展开(每次 outerHTML 替换后 --expand 必然丢失)
          if (fixed.indexOf('vditor-ir__node--expand') < 0) {
            fixed = fixed.replace(/(vditor-ir__node)(?=["\s])/, '$1 vditor-ir__node--expand');
          }
          return fixed;
        };
      }

      // 给 block-editor.js 用:把一段修改后的 markdown 应用到编辑器,走我们自己的撤销栈
      window.__hkkGetContent = () => currentSavedContent;
      window.__hkkEditor = editor;
      window.__hkkApplyMarkdown = (newMd) => {
        if (newMd === currentSavedContent) return;
        undoStack.push({ content: currentSavedContent });
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack.length = 0;
        currentSavedContent = newMd;
        safeSetValue(newMd);
        handler.emit("save", newMd);
      };

      // 撤销/重做后光标落在"变化处":比对切换前后的可见全文 (按单元插 \n 分隔),
      // 只用公共前缀 p 定位变化起点 (前缀不受文档末尾块渲染态影响;后缀会被末尾噪声污染)。
      // 删 → 落 p (删除点);插入 → 落 p+插入量。先同步试,没成 (DOM 没就绪) 下一帧兜底。
      const restoreCaret = (fromVis, fromMd, toMd) => {
        const place = () => {
          const toVis = getVisText();
          let p = 0;
          const minLen = Math.min(fromVis.length, toVis.length);
          while (p < minLen && fromVis.charCodeAt(p) === toVis.charCodeAt(p)) p++;
          // markdown 变化起点:不依赖 DOM 渲染态,绝对可靠,用作"裁判"
          let mp = 0;
          const mml = Math.min(fromMd.length, toMd.length);
          while (mp < mml && fromMd.charCodeAt(mp) === toMd.charCodeAt(mp)) mp++;
          if (fromVis !== toVis) {
            const target = p + Math.max(0, toVis.length - fromVis.length);
            // 裁判:可见落点相对位置 远超 markdown 变化相对位置 → 可见 diff 被"末尾块渲染
            // 不稳"的噪声带偏 (典型:链接/盲区编辑,变化没反映、只剩末尾假差异) → 改走块定位。
            const visRatio = target / Math.max(1, toVis.length);
            const mdRatio = mp / Math.max(1, toMd.length);
            if (visRatio - mdRatio > 0.25) return placeCaretAtChangedBlock(fromMd, toMd);
            return placeCaretAtVisOffset(target);
          }
          // 可见文字没变 (变化在 marker/preview 盲区,如 URL/公式),按块定位
          return placeCaretAtChangedBlock(fromMd, toMd);
        };
        if (!place()) requestAnimationFrame(place);
      };

      doCustomUndo = () => {
        if (undoStack.length === 0) return;
        const item = undoStack.pop();
        const fromMd = currentSavedContent, fromVis = getVisText();   // 切换前的内容/可见全文
        redoStack.push({ content: fromMd });
        currentSavedContent = item.content;
        safeSetValue(item.content);
        handler.emit("save", item.content);
        restoreCaret(fromVis, fromMd, item.content);
      };
      doCustomRedo = () => {
        if (redoStack.length === 0) return;
        const item = redoStack.pop();
        const fromMd = currentSavedContent, fromVis = getVisText();
        undoStack.push({ content: fromMd });
        currentSavedContent = item.content;
        safeSetValue(item.content);
        handler.emit("save", item.content);
        restoreCaret(fromVis, fromMd, item.content);
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
