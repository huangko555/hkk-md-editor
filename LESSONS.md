# HKK MD Editor 开发踩坑笔记

记录在 cweijan/vscode-office 基础上做精简 + 个性化 (HKK 主题、IR 模式、自定义 undo/redo)过程中踩到的雷点和应对策略，留给未来回头看或者别人接手时参考。

按"踩雷领域"分组，每条：**现象 → 根因 → 解决/绕开**。

---

## 1. vditor 库的雷 (最深)

### 1.1 wysiwyg 模式下不能往可编辑 DOM 插装饰 `<span>`
- **现象**：实现颜色色块预览 (`#hex` 前插彩色圆点)，光标在一个色值内删除一个数字，**整段甚至跨段的 hex 文本全消失**；光标频繁跳到段首
- **根因**：vditor wysiwyg 是 contenteditable + DOM 即数据模型。我用 `splitText + insertBefore(<span>)` 插入色块时，vditor 的 input 序列化拿到的 DOM 被我"切坏"，回写到 markdown 源时丢字
- **应对**：**Phase 3.1 撤回**。可能的解法：CSS Custom Highlight API(不动 DOM 只染色)、绕开 wysiwyg 走 vditor SV 模式。详见 `memory/project_pending_color_swatch.md`
- **注**：`hkk-color-swatch.js` 已在 Phase 4 收尾清理时删除 (它是死代码)，记忆里保留概念，需要时重写

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
- **根因 (后来实测精确定位)**：IR 撤销栈**永远是空**。`undo.addToUndoStack` 第一步调 `addCaret(vditor, true)`，而 `addCaret` 内部遍历克隆 DOM 时抛 `Cannot read properties of null (reading 'classList')` → 整个入栈失败 → 栈空 → `undo()` 是空操作。是 vditor **库内 bug**，`vditor.js` minified **不可改**，复用无望。(诊断方法见 §5.1:临时挂 `Ctrl+Alt+Z/S` 直接调 `editor.vditor.undo.*` + 打 `err.stack`)
- **应对**：**在 webview 自维护 undoStack/redoStack** + 自己定位光标 (见 §7 完整方案)
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

### 1.6 vditor 原生 `.vditor-copy` 按钮在 VSCode webview 里完全坏
- **现象**：代码块右上角悬浮的复制图标，点击不复制 (剪贴板空)，且 IR 模式下点击会变成"展开代码块"
- **根因**：两个独立问题叠加 ——
  1. vditor 内部用 inline `onclick="...document.execCommand('copy')..."`，在 VSCode webview 沙箱里 `execCommand('copy')` 被拒，静默失败
  2. IR 模式下 **mousedown 阶段**就把光标放进了代码块 → 触发 `.vditor-ir__node--expand` → click 阶段再阻止已经晚了
- **应对**：**绕开 vditor 原生按钮**，自己做 ——
  - CSS 把 `.vditor-copy` 隐藏掉
  - `document.body` 上挂一个 `.hkk-code-copy` 浮动按钮 (单例)，`mouseover` 跟随当前 hover 的代码块，定位 fixed 到右上角
  - `mousedown` `preventDefault()` 阻止抢焦点 → IR 节点不展开
  - `click` 用 `navigator.clipboard.writeText` 现代 API 写剪贴板，fallback 用 textarea + `document.execCommand('copy')` 兜底
- **教训**：VSCode webview 的 `execCommand('copy'/'cut'/'paste')` 几乎都被拒，有这类需求一律走 Clipboard API。**inline onclick 也跟"先 mousedown 抢光标"竞争**，要拦截操作类按钮，得在 mousedown 就 preventDefault。

### 1.7 IR 模式代码块/数学块行内输入丢字 (已修复,2026-06-23)
- **现象**：在代码块或 `$$ ... $$` 数学块里打字、删字,内容会被吞——有时尾巴丢几个字,有时整行甚至跨行消失;同时光标会跳到代码块顶部的语言行
- **早期误判**：旧版写"git stash 退回接手前对照,照样丢"。**这判断是错的**——接手前用的是 wysiwyg 模式,stash 同时把 `mode: 'ir'` 也回滚了,等于在对比两个完全不同的内核路径
- **实锤过程**：开 dlog 在 `SpinVditorIRDOM(html)` 入出参里打日志,确认 Lute 把光标占位符当成 HTML 元素截断了代码内容
- **根因 (两个独立 bug,叠加才能 100% 复现)**：
  1. vditor IR 模式里光标占位符有 **两种** 形式 —— `<wbr>` 和 `<span class="vditor-wbr"></span>`,后者在行尾/节点边界时出现。两者**都**会被 Lute 当 HTML 元素处理,代码内容被截断
  2. 每次按键后 vditor 调用 `SpinVditorIRDOM(blockElement.outerHTML)` 重新渲染当前块,这一步会丢失运行时的 `vditor-ir__node--expand` CSS class → 块立即折叠,source 编辑区消失只剩 preview
- **修法** (`resource/vditor/index.js` 的 `after()` 回调里 monkey-patch `lute.SpinVditorIRDOM`)：
  - 进 Lute 前把 `<wbr>` 替换为文本哨兵 `\x02HKKWBR\x02` (`_WBR`),把 `<span class="vditor-wbr"></span>` 替换为 `HKKVWBR` (`_VWBR`)
  - 出来后还原**第一个** `_WBR` → `<wbr>` (vditor `setRangeByWbr` 据此定位光标),其余哨兵 (Lute 会把哨兵同时写进 source 和 preview 两区) 用 `split().join('')` 全删 —— 不删的话 preview 里显示成乱字
  - 只要光标在 code/math 块内 (有 `<wbr>` 或 `<span class="vditor-wbr">`),不论 input 是否带 `--expand`,都在返回结果里强制注入 `vditor-ir__node--expand`。**不能靠 `wasExpanded` 判断**——第一次 `outerHTML` 替换后 `--expand` 必然丢失,此后输入永远是 false
- **教训**：minified 第三方库的 bug,从入参/出参打日志看 transform 是最快的定位方式;同时不要忘了 vditor 里光标占位符可能有多种形式 (`<wbr>` 不是唯一的)
- **保留的妥协**：popover 上的"编辑"按钮 + modal 仍然在 —— 复杂代码 (含特殊字符、巨长) 走 modal 更稳

### 1.8 vditor IR 代码块底色:wrapper 内多余子元素 + preview 不在 wrapper 后代的陷阱
- **现象**：用 `.vditor-ir__node[data-type="code-block"] .vditor-ir__preview` 后代选择器给 preview 加底色,**不生效**;同时折叠态代码块顶部有一行不该有的空白
- **诊断方法**：给 wrapper 加 `outline: red`、各类子元素加不同颜色 outline,直接在浏览器里看 selector 命中情况(比靠 specificity 算更直观)
- **根因**：
  1. `.vditor-ir__preview` 是 wrapper 的**直接后代但加了 outline 后看着像兄弟** —— 实际是后代,但 outline 不能反映这种父子布局
  2. 折叠态空行来自两处:wrapper 默认 `:before/:after { content: ' ' }` + wrapper 内 marker spans (open/close marker / language info span) + text node 在 `line-height` 撑出的行高 + source `<pre>` 自身 `inline-block` 在折叠态 `height:0` 但 `line-height` 仍占位
- **修法** (`resource/vditor/css/theme/HKK.css`)：折叠态用 `line-height: 0`、所有 `:before/:after` 加 `content: none`、wrapper 内 `> span` 折叠态全部 `display: none`、source `<pre>` 折叠态 `display: none`;只给 source `<pre>` 和折叠态 preview 加蓝底,展开态 preview 透明
- **教训**:CSS 出问题先用 outline 画清 DOM,别靠头脑模拟 box model;`content: none` 比 `display: none` 安全,后者会破坏 vditor 内部计算光标位置

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

## 7. 撤销/重做光标定位 — 从底层重做 (B' 方案，已定稿)

自维护 undo 栈好做 (存 markdown 快照 + setValue 回退)；**真正难的是撤销后把光标放回"刚才改动的地方"**。前后试了几代，记录踩坑：

### 7.1 病根：别用"markdown 源码偏移 ↔ DOM 位置"双向映射
- 历史方案：diff 两份 markdown 快照得到源码偏移，再走 TreeWalker 把偏移映射回 DOM。**两层映射都不可靠**——vditor input 后会重排空白 (§2.2)、IR marker 显隐让字符数对不上 (§2.1)。光标稳定跳到无关位置。
- **正解：换坐标系**。不碰 markdown，只在 **"可见文字"** 这一个坐标系里做：`getVisText()` 遍历可见 IR 文本，**跳过** marker / preview / 代码围栏，**保留** `marker--pre` 里的代码内容 (那是可编辑正文)。撤销/重做时比对切换前后两份可见文字，定位变化处。

### 7.2 只用"公共前缀"定位，别用后缀
- 想当然用 `公共前缀 p` + `公共后缀 s` 框出变化区 `[p, len-s]`。**后缀是坑**：**第一次撤销**时文档末尾的块 (引用定义 `[x]: url` 等) 渲染态还没稳，`fromVis`/`toVis` 末尾有无关差异，后缀只匹配几十字符就断 → 算出的"变化末尾"飙到文档尾 → 光标跳末尾。撤销一次后 DOM 稳了就好，所以表现为"第一次必触发、之后正常"。
- **修**：只用前缀 p (前缀不受末尾影响)。删除→落 p (删除点)；插入→落 `p + 长度差`。

### 7.3 块/单元边界二义：要插分隔符
- 可见文字把各块/格无缝拼接，**"上段末尾"和"下段开头"偏移重合** → 句尾撤销落到下段首、句首落到上段尾、表格里落到上一格尾。单用 `>=`/`>` 必然顾此失彼。
- **修**：`getVisText` 与落点函数**用同一套**，在"单元"(td/th、li、顶层块) 边界插 `\n` 分隔，边界偏移不再重合，各归各位。`blockUnitOf()` 判定单元归属。

### 7.4 marker/preview 盲区 + markdown 当裁判
- 链接 URL、公式、图片这类，可编辑内容在 marker/preview 区，`getVisText` 看不见 → 编辑改了 markdown 但可见文字没变 (`visEqual`)。光标无从精确定位。
- **裁判**：markdown 不依赖 DOM 渲染态，绝对可靠。算"可见落点相对位置"vs"markdown 变化相对位置"，若可见落点明显靠后 (差 >25%) → 判定被噪声带偏 → 改走**块定位** `placeCaretAtChangedBlock`：落进块内第一个 `.vditor-ir__node`，`placeRangeAt` 会自动给它加 `--expand` (顺带解决链接撤销"不展开")。
- 盲区是 B' 的**固有边界**：这类只能落到块/节点附近，做不到字符级精确。

### 7.5 撤销粒度 = vditor 的 `undoDelay`，默认 800ms 太长
- 我们的 `input` 回调 = vditor 的入栈信号，受 `options.undoDelay` (默认 **800ms**) 时间防抖，**只看时间不看位置**。800ms 内分别编辑的多处 (哪怕跨块) 被合并成**一个**撤销步 → 一次撤销全没。
- **修**：传 `undoDelay: 200`。人"编辑一处→移动→编辑另一处"的间隔通常 >200ms，自然分界；连续打字 (<200ms) 仍合并成一步 (这是对的)。仍有残留：同段落极快多处编辑会被合并，vditor 层面拆不开 (要绕开自建按键级 undo，不划算)。

### 7.6 闪烁：同步定位 + 单次 rAF 兜底
- 历史用 `setTimeout(…, 120)` 等 DOM 重建，导致 IR 节点折叠态停 120ms 才展开 → 闪。
- **修**：setValue 后**同步**先试一次定位，失败才 `requestAnimationFrame` 兜底一次 (单次，§5.2 说过多次重试会跟 vditor expand 打架)。

### 7.7 代码块/数学块"输入即丢内容"跟撤销无关
- 现象：在代码块/数学块里打字，内容偶尔被清空
- **结论已在 Phase 4 实锤更新，详见 §1.7**。简版：确认是 vditor IR 序列化 bug,跟撤销路径无关；改不动内核，改走 popover + modal 妥协。当时这条记录里"git stash 也复现"的判断是错的(stash 把 IR 模式也回滚了，对比对象不对)

---

## 8. Phase 4 的小经验 (浮窗 / 搜索性能)

### 8.1 自定义浮窗 (popover) 的几条小经验
- **失焦自动隐藏**：document 上挂一个 `focusin`，当 `e.target` 既不在编辑器内、也不在 popover 内，就 `hide()`。`document.body.click` 不够，焦点跳到大纲/工具栏不会触发 click。
- **滚出视口隐藏**：在 `position()` 入口判 `target.getBoundingClientRect()` 完全离开 viewport 就 `hide()`。否则浮窗会贴边停在视口里"鬼影"。
- **事件委托代替每次 render 重绑**：popover 内按钮全部用 `[data-action]` 标记,popover 自己挂一个 `click` 委托,render 时只 `innerHTML =` 不再 `addEventListener`。
- **同 target 内移动只 reposition,不重渲**：例如表格 cell 之间跳,DOM 内容没变，光重写 innerHTML 会让按钮一闪。`update()` 短路条件用 `currentTarget === ctx.target && currentType === ctx.type`,cell 仅作为 reposition 的入参。
- **mousedown preventDefault 保住编辑器焦点**：popover 按钮按下时必须 `preventDefault()`，否则光标跳到 popover → vditor 那边的 selection 就丢了 → 操作的"当前块"就找不到了。

### 8.2 表格 popover 折叠/展开两态的定位
- **折叠态(`…` 单按钮)**：贴当前**行**的左外侧，纵向居中行高，不遮挡表格
- **展开态(完整工具栏)**：贴当前**单元格**的左上方 (`left = cell.left, top = cell.top - h - 4`)，顶不下时翻到 `cell.bottom + 4`
- 教训：**不要贴"上一行"**——表头时没有上一行、合并单元格时上一行结构不对。直接锚到当前 cell 简单稳定,clamp 兜底就能保证完整显示

### 8.3 搜索卡顿：防抖 + layout thrashing 是两条独立的源
- **input 每个字符都立刻 findAll**：长文档 + 短关键字时一次匹配几百个，每帧都跑一遍 → 卡。修法：input 加 120ms debounce。Enter 按下时记得 flush 一次，否则极速打字 + 立刻 Enter 会跳到旧关键字的位置。
- **renderMinimap 循环里 read→write 交替**：每个匹配先 `getBoundingClientRect()` (read,触发 reflow)，再 `style.top = ...; appendChild()` (write,让下次 read 又要重算)——经典 layout thrashing。修法：**两阶段**——先把所有匹配的 ratio 算完存数组，再用 `DocumentFragment` 批量 append 一次。
- **教训**：性能问题先 profile,但 read/write 交替的模式肉眼可见，看到就先拆。

### 8.4 文件级日志机制再次救命 (§5.1 复用)
- 这次解决"代码块输入丢字"靠 dlog 在 `input(content)` 回调里 diff 上下次 content。无 dlog 的话只能猜或者让用户复制 F12 截图，效率天差地别
- 默认沉默(handler.emit 注释起来)，需要时一行注释打开，用完再关。机制成本低、价值大，以后类似"vditor 给我们的数据是不是已经坏了"类问题首选

---

## 收尾时回头看的待办 (都已存项目记忆) 

详见 `~/.claude/projects/.../memory/`：
- 代码块编辑浮窗亮蓝色压不下来 (`project_pending_codeblock_popup.md`)
- IR 模式 link 中间点击不展开 (`project_link_middle_click_limit.md`)
- 颜色色块预览撤回 (`project_pending_color_swatch.md`)
- 工具栏"更多"菜单优化 (`project_pending_more_menu.md`，方向待细化)
- ~~代码块/数学块行内编辑回归 (当前用 modal 妥协)~~ — **已修复,见 §1.7**
- 滚动条修复
- ~~无语言代码块双层底色~~ — **已修复,见 §1.8** (inline-code 规则误染 + wrapper 内多余子元素)

## 用户偏好 (也已存)

- 产品文案不要 emoji，沿用旧 vditor 编辑器风格 (短句 + 全角标点)
- 测试样本永远放在 `test-samples/comprehensive.md` 文档**最顶部**

---

**初版写于 Phase 3.2 完成收尾时，Phase 4 收尾 (2026-06-22) 增补 §1.6 / §1.7 / §8、改写 §7.7、§1.1 注记；0.0.3 收尾 (2026-06-23) 修复 §1.7 + 新增 §1.8。**
改动可看 git log，核心 commit:1ddadad(Phase 1)、b05db77(Phase 2)、2c6b334(Phase 3.1 撤回)、f6ec39c(Phase 3.2 自维护 undo)、e76f7d1(Phase 4.3 popover)。
