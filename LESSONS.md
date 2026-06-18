# HKK MD Editor 开发踩坑笔记

记录在 cweijan/vscode-office 基础上做精简 + 个性化 (HKK 主题、IR 模式、自定义 undo/redo)过程中踩到的雷点和应对策略，留给未来回头看或者别人接手时参考。

按"踩雷领域"分组，每条：**现象 → 根因 → 解决/绕开**。

---

## 1. vditor 库的雷 (最深)

### 1.1 wysiwyg 模式下不能往可编辑 DOM 插装饰 `<span>`
- **现象**：实现颜色色块预览 (`#hex` 前插彩色圆点)，光标在一个色值内删除一个数字，**整段甚至跨段的 hex 文本全消失**；光标频繁跳到段首
- **根因**：vditor wysiwyg 是 contenteditable + DOM 即数据模型。我用 `splitText + insertBefore(<span>)` 插入色块时，vditor 的 input 序列化拿到的 DOM 被我"切坏"，回写到 markdown 源时丢字
- **应对**：**Phase 3.1 撤回**。可能的解法：CSS Custom Highlight API(不动 DOM 只染色)、绕开 wysiwyg 走 vditor SV 模式。详见 `memory/project_pending_color_swatch.md`

### 1.2 vditor IR 模式 setValue 会崩 (`addCaret` 报 null.classList)
- **现象**：`editor.setValue(content)` 后控制台报 `Uncaught TypeError: Cannot read properties of null (reading 'classList')` at `vditor.js: addCaret`
- **根因**：setValue 重建 DOM 时，vditor 内部尝试恢复光标 (`addCaret`)，会读之前 Selection 的 Range，而 Range 引用的节点已经被销毁
- **应对**：写 `safeSetValue` —— **setValue 前手动 `removeAllRanges()` 和 `blur()`**，Range 引用没了 vditor 就 no-op，不再崩

```js
const safeSetValue = (content) => {
  try {
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    if (document.activeElement?.blur) document.activeElement.blur();
  } catch {}
  editor.setValue(content);
};
```

### 1.3 vditor IR 模式自带的 undo/redo **完全不工作**
- **现象**：Ctrl+Z 没反应，toolbar 上的 undo 按钮始终灰色，从来不激活
- **根因**：vditor 库的 IR 模式 undo 实现有 bug(可能就是 #1.2 那个 addCaret 链路坏掉的副作用)
- **应对**：**在 webview 自维护 undoStack/redoStack**(见 `resource/vditor/index.js`)。`input` 回调里把旧 content 压栈，Ctrl+Z keydown 弹栈 + `safeSetValue` + 重新定位光标
- **wysiwyg 模式的 vditor undo 是好的**，但切回 wysiwyg 就失去 IR 的"点行看 md 源符号"特性，我们选了 IR

### 1.4 vditor **同时建 IR + wysiwyg + SV 三套 DOM**，只显示当前 mode 的
- **现象**：`document.querySelector('.vditor-reset')` 返回的不是当前可见模式的那个，光标设到了**隐藏的 SV 模式 DOM** 里，用户看不见
- **根因**：querySelector 返回文档里**第一个**匹配的，而 vditor 把三种模式 DOM 都建好了
- **应对**：`getVisibleMode()` 用 `offsetParent !== null` 找当前可见的那一套

```js
function getVisibleMode() {
  for (const sel of ['.vditor-ir', '.vditor-wysiwyg', '.vditor-sv']) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;  // offsetParent null = display:none / 祖先隐藏
  }
  return null;
}
```

### 1.5 IR 模式 link 点击中间不展开 (vditor 设计如此)
- **现象**：`.vditor-ir__link` span 上点击中间，IR 节点不会自动加 `--expand` 类
- **根因**：vditor 内部对 link span 的 click 有特殊处理 (认为用户想跳转，不展开)
- **应对**：在我们的 click 处理里**主动给 `.vditor-ir__node` 加 `--expand` class**，延迟 50ms 让 vditor 自己的清理逻辑先跑

---

## 2. markdown ↔ DOM 字符级映射的坑

### 2.1 IR 模式下 `Range.toString()` vs `textContent` 对 marker 行为不一致
- **现象**：用 Range.toString 算光标偏移，撤销后光标固定偏到"下面一行的前 2-5 个字"
- **根因**：vditor IR 块未展开时 marker(`##`、`**` 等) 处于隐藏状态 (display:none)。`textContent` **包含** display:none 文本，`Range.toString()` 可能**不含**(取决于浏览器实现)
- **应对**：统一用 `TreeWalker(SHOW_TEXT)` 走 textContent，或者两边都跳过 `.vditor-ir__marker` 节点

### 2.2 markdown 源里的字符不全在 DOM textContent 里
踩了一长串雷，逐层升级才理清：

| markdown 源 | 在 DOM textContent | 备注 |
|---|---|---|
| 段落内部的字符 | ✓ 1:1 | 包括 `**bold**` 的星号 (IR 用 marker span 包，但 span 文本在 textContent 里) |
| 段落之间的 `\n\n` | ✗ 没有 | 段元素分隔，DOM 里不存在 `\n` |
| `## 标题` 里的 `##` | ✓ 有 (在 marker span 里) | 标题行的 markdown 标记**在** textContent |
| `> 引用` 里的 `>` | ✗ 没有 | 用 `<blockquote>` 元素表达，`>` 不在 textContent |
| `- item` 里的 `-` | ✗ 没有 | 用 `<ul><li>` 元素表达 |
| `1. item` 里的 `1.` | ✗ 没有 | 用 `<ol><li>` 元素表达 |
| `---` HR | ✗ 没有 | 用 `<hr>` 元素 |
| 代码栅栏 ` ``` ` | ✗ 没有 | `<pre>` 包裹 |
| 表格 `|---|` | ✗ 没有 | `<table>` 结构 |

- **应对**：**放弃字符级精确映射**，改用 **block 级定位**：
  1. 用 diff 找到编辑发生的 markdown 源码位置
  2. 按 `\n\n` 把 source 切 N 个 block,定位 sourcePos 在第几块
  3. DOM 里取 `editorEl.children[blockIdx]`，这是对应的 DOM block
  4. block 内做精细定位时，跳过行首的 `> ` `- ` `*` `+ ` `1. ` 标记 + `\n`

精度从"字符级"降到"块内 column 级"，但**对所有 markdown 元素稳定**

### 2.3 vditor `<wbr>` 光标标记在 setValue 时不被识别
- **现象**：试过把 `<wbr>` 插到 markdown 里，期望 setValue 后 vditor 把光标放到 wbr 那里
- **根因**：vditor 的 Lute parser 把 `<wbr>` 当 HTML 标签处理，要么 strip 要么转义，反正传不到光标定位逻辑
- **应对**：放弃这条路。vditor 内部用 `<wbr>` 当光标标记的逻辑是在 setValue **之后**用的(往 DOM 里插)，不是 setValue 之前接收 markdown 里的

---

## 3. CSS 跟 base.css 的特异性大战

### 3.1 base.css 的 `*:not(.hljs, ...)` 强力规则
- **现象**：写自己的 wrapper 透明 / 表格隔行底色 / 内嵌 code 透明等规则，被 base.css 用 `!important` 覆盖
- **根因**：`base.css` 里有一条：
```css
.vditor-content *:not(.hljs, .hljs *, .katex, .katex *, a, hr, .vditor-reset--error, code) {
    background-color: var(--bg-color) !important;
    color: var(--front-color) !important;
}
```
这条规则用 `!important` 强行给所有元素涂 `--bg-color`，我的子元素规则要更具体才能赢
- **应对**：用 `#vditor[data-editor-theme="HKK"] ...` 加 ID + 属性选择器拉高特异性，再加 `!important`。或者**直接改 `--code-bg-color` 变量值**让 base.css 自己输出我想要的色 (`HKK.css` ：root 里覆盖 `--code-bg-color`)

### 3.2 rgba 半透明色叠层会变深 (双层叠色)
- **现象**：代码块外层 wrapper 和内层 pre 都设 `rgba(66, 133, 244, 0.10)`，视觉看上去就是**两层**，中心比边缘深一档
- **根因**：rgba 是半透明叠加，内层叠在外层上 → 实际透明度 ≈ `1 - (1-α)²` = 0.19
- **应对**：**只在一层上色，其他层强制 transparent**。或者**全用 solid 纯色**(同色叠加 = 同色，看不出层)

### 3.3 vditor 三种 mode 选择器要全列
- **现象**：Phase 2 起初只写了 `.vditor-wysiwyg__preview` 的样式，切到 IR 模式后代码块底色没了
- **根因**：wysiwyg 和 IR 用不同的元素类 (`.vditor-wysiwyg__preview` vs `.vditor-ir__preview`)
- **应对**：HKK 主题 CSS 同时覆盖两种模式的选择器

### 3.4 链接的"悬停提示"要按 expand 状态分情况
- **现象**：链接已展开成编辑态时，鼠标悬停还显示"Ctrl + 单击跳转"，但这时点击是放光标编辑，不该提示跳转
- **应对**：CSS 用 `:not(.vditor-ir__node--expand)` 限定 hover 提示只在未展开时显示；展开时光标改成 `text` (I-beam)

---

## 4. 外部改动同步 (Phase 1) 的雷

### 4.1 zhfix 这类"临时文件 + 原子改名"绕开 FileSystemWatcher
- **现象**：zhfix 改了文件，vditor 不刷新
- **根因**：Windows 下 atomic rename 不触发 FileSystemWatcher 的 change 事件
- **应对**：1 秒轮询 stat 兜底 (mtime/size 任一变就当外部改动)，只在面板可见时跑

### 4.2 dirty 锁挡掉 VS Code 内部 Ctrl+Z
- **现象**：Phase 1 加了 dirty 安全锁后，VS Code 的 Ctrl+Z 触发了文档回退，但 webview 没同步
- **根因**：dirty 锁拦截所有"内容不一致 + 文档 dirty"的情况，但 Ctrl+Z 也是这种情况 (文档刚被 VS Code 自己回退)
- **应对**：在 externalUpdate handler 里检查 `e.reason === Undo|Redo`，撤销/重做绕开 dirty 锁强制同步

---

## 5. webview 调试基础设施

### 5.1 我 (Claude) 读不到 webview 的 console
- **现象**：让用户复制粘贴 F12 日志，效率极低且容易出错
- **应对**：写了**文件日志机制**：
  1. webview 端 `dlog(...args)` → `handler.emit('debug-log', JSON.stringify(...))`
  2. extension 接收 `debug-log` 事件 → `fs.appendFileSync('test-samples/hkk-debug.log', ...)`
  3. Claude 用 Read 工具直接读日志文件
- **效果**：迭代速度从"每次问用户复制"提升到"用户做完测试我自己读"，一次循环时间从 5+ 分钟降到 30 秒
- **代码位置**：`resource/vditor/index.js` 的 `dlog` 函数 (默认 disabled，改 emit 那行的注释启用)

### 5.2 多次 setTimeout 重试设光标会跟 vditor 内部状态打架
- **现象**：为了"等 setValue 重建 DOM 后再设光标"，写了 `[10, 50, 150, 400, 800]ms` 多次重试。结果前几次设对，最后一次又把光标搞到 offset 0
- **根因**：每次设光标，vditor 内部响应 (触发 expand、修改 DOM 结构等)，DOM 变了 800ms 时再算就乱
- **应对**：**只设一次**，等 vditor 渲染稳定 (120ms 比较稳) 再放

---

## 6. 其他

### 6.1 改 `.ts` 必须 `npm run build`，改 `resource/vditor/` 不用
- 改 extension 端的 TypeScript → esbuild 重打包到 `out/extension.js`
- 改 webview 端的 CSS/JS → 直接从 `resource/vditor/` 加载，Reload Window 即可

### 6.2 vditor 用 `<wbr>` 做光标标记 (内部约定)
- 多个 markdown 编辑器 (vditor、Typora 一脉) 用 `<wbr>` 这个 HTML 标签当光标位置标记
- 在 HTML 里 `<wbr>` 是"建议换行点"，可以插入任何文字流但不显示
- vditor setValue **不识别** wbr，但 vditor 内部 DOM 操作时用 (`insertAdjacentHTML("beforeend", "<wbr>")`)
- **想用就要在 DOM 层操作**，不是 markdown 层

---

## 收尾时回头看的待办 (都已存项目记忆)

详见 `~/.claude/projects/.../memory/`：
- 代码块编辑浮窗亮蓝色压不下来 (`project_pending_codeblock_popup.md`)
- IR 模式 link 中间点击不展开 (`project_link_middle_click_limit.md`)
- 颜色色块预览撤回 (`project_pending_color_swatch.md`)
- 滚动条修复
- 无语言代码块双层底色 (撤回了)

## 用户偏好 (也已存)

- 产品文案不要 emoji，沿用旧 vditor 编辑器风格 (短句 + 全角标点)
- 测试样本永远放在 `test-samples/comprehensive.md` 文档**最顶部**

---

**写于 Phase 3.2 完成收尾时**。改动具体可看 git log，核心 commit:1ddadad(Phase 1)、b05db77(Phase 2)、2c6b334(Phase 3.1 撤回)。
