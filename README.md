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

- **代码块 / 数学块编辑**： vditor IR 模式行内编辑代码块会丢字 (内核序列化 bug，见 LESSONS §7.7)。当前妥协方案是 popover 上的"编辑"按钮弹出独立 modal，绕开行内编辑。后续方向：回到行内编辑且不丢字，或换更合适的内核。
- **工具栏"更多"菜单**： 优化方向待细化 (布局 / 暗色样式 / 可见项)，提及但未落地。

## 协议

- 源项目：[cweijan/vscode-office](https://github.com/cweijan/vscode-office) — MIT © 2020 Weijan Chen
- 编辑器内核：[Vditor](https://github.com/Vanessa219/vditor) — MIT
- 本仓库：MIT，保留原 `LICENSE`
