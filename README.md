# HKK MD Editor

> 一个 VS Code 里的所见即所得 (WYSIWYG)Markdown 编辑器扩展。
> 精简自 [cweijan/vscode-office](https://github.com/cweijan/vscode-office)(MIT),只保留 markdown 编辑功能，去掉了 PDF/Excel/Word/PPT/字体/压缩包等模块。
> 底层编辑器内核仍为 [Vditor](https://github.com/Vanessa219/vditor)。

## 在新电脑上开始开发

### 前置依赖

| 工具 | 版本 | 说明 |
|---|---|---|
| Git | 任意 | clone 代码 |
| Node.js | ≥ 20.x(建议 22.x) | 编译扩展 |
| VS Code | ≥ 1.64 | 调试 & 运行扩展 |

### clone + 跑起来

```powershell
git clone https://github.com/huangko555/hkk-md-editor.git
cd hkk-md-editor

# 1. 装依赖(版本由 package-lock.json 锁定,所有机器装的是同一个版本)
npm install

# 2. 编译扩展,生成 out/extension.js
npm run build
```

`npm run build` 输出 `build success` 就算成功。

### 在 VS Code 里调试

1. 用 VS Code 打开**项目根目录**(`hkk-md-editor/`)
2. 按 **F5**
3. 会自动打开一个新窗口 (标题栏含 `[Extension Development Host]`)，里面跑的就是扩展
4. 在新窗口里打开任意 `.md` 文件，会自动用 HKK MD Editor 打开；或右键 → **Reopen Editor With...** → 选 `HKK MD Editor`

> F5 已经配置好 `preLaunchTask = dev`，会自动跑 watch 模式的 esbuild(代码改动自动重新编译)。

### 打包成 .vsix(可选)

```powershell
npm install -g @vscode/vsce
npm run package
```

会在根目录生成 `hkk-md-editor-0.0.1.vsix`，VS Code 里 Extensions → 三个点 → Install from VSIX… 可手动安装。

## 项目结构

```
hkk-md-editor/
├── build.js                # esbuild 编译脚本(代替 vite,只打扩展)
├── package.json            # 扩展清单 + 依赖
├── package-lock.json       # 锁定依赖版本(已提交,跨机一致)
├── tsconfig.json
├── .vscode/                # F5 调试配置
├── lib/                    # 粘贴图片用的 win/mac/linux 脚本
├── template/               # markdown-pdf 导出模板
├── resource/
│   ├── vditor/             # ⭐ 编辑器前端 UI(Vditor 内核)
│   └── lib/                # vditor 依赖的通用 css/js
└── src/
    ├── extension.ts        # 扩展入口
    ├── common/             # 工具类
    ├── provider/
    │   └── markdownEditorProvider.ts   # 注册自定义编辑器
    └── service/
        ├── markdownService.ts          # 命令实现(切换、粘贴图片、导出)
        └── markdown/                   # markdown-pdf / outline / 扩展插件
```

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm install` | 装依赖 (按 lock 文件) |
| `npm run dev` | watch 模式编译 (F5 自动跑) |
| `npm run build` | 生产编译 (产出 `out/extension.js`) |
| `npm run package` | 打包 .vsix |

## 致谢与协议

- 源项目：[cweijan/vscode-office](https://github.com/cweijan/vscode-office) — MIT License © 2020 Weijan Chen
- 编辑器内核：[Vditor](https://github.com/Vanessa219/vditor) — MIT License
- 本仓库协议：MIT(沿用原作者)，保留原版 `LICENSE` 文件
