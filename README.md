# HKK MD Editor

> VS Code 里的所见即所得 (WYSIWYG) Markdown 编辑器。
> 精简自 [cweijan/vscode-office](https://github.com/cweijan/vscode-office) (MIT)，去掉 PDF/Excel/Word/PPT/字体/压缩包等模块，只保留 markdown 编辑。
> 底层编辑器内核仍为 [Vditor](https://github.com/Vanessa219/vditor),默认走 IR 模式。

## 开发

```powershell
npm install
npm run build      # 产出 out/extension.js
```

VS Code 打开项目根目录，按 **F5** 启动 Extension Development Host 调试。

## 待优化

- **工具栏"更多"菜单**:优化方向待细化 (布局 / 暗色样式 / 可见项),提及但未落地。

## 0.0.3 更新

- 修复代码块 / 数学块行内输入丢字 (vditor `SpinVditorIRDOM` 把 `<wbr>` 和 `<span class="vditor-wbr">` 当 HTML 元素截断内容,monkey-patch 用文本哨兵绕过) — 详见 LESSONS §1.7
- 重写代码块 / 数学块底色 — 详见 LESSONS §1.8
  - 代码块 (有/无语言):折叠态整块蓝,展开后 source 蓝、preview 透明
  - 数学块:折叠态无色,展开后 source 蓝、preview 透明
- 浮窗 (popover) 在点击编辑区外的任意位置 (目录、工具栏、空白) 时自动隐藏
- 目录 z-index 调到浮窗之上

## 协议

- 源项目：[cweijan/vscode-office](https://github.com/cweijan/vscode-office) — MIT © 2020 Weijan Chen
- 编辑器内核：[Vditor](https://github.com/Vanessa219/vditor) — MIT
- 本仓库：MIT，保留原 `LICENSE`
