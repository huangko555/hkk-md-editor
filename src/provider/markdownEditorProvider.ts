import { adjustImgPath, getWorkspacePath, writeFile } from '@/common/fileUtil';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { basename, isAbsolute, parse, resolve, dirname } from 'path';
import * as vscode from 'vscode';
import { Handler } from '../common/handler';
import { Util } from '../common/util';
import { Holder } from '../service/markdown/holder';
import { MarkdownService } from '../service/markdownService';
import { Global } from '@/common/global';
import { platform } from 'os';

/**
 * support view and edit office files.
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {

    private extensionPath: string;
    private countStatus: vscode.StatusBarItem;
    private state: vscode.Memento;

    constructor(private context: vscode.ExtensionContext) {
        this.extensionPath = context.extensionPath;
        this.countStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.state = context.globalState
    }

    private getFolders(): vscode.Uri[] {
        const data = [];
        for (let i = 65; i <= 90; i++) {
            data.push(vscode.Uri.file(`${String.fromCharCode(i)}:/`))
        }
        return data;
    }

    resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): void | Thenable<void> {
        // console.log('schema', document.uri.scheme);
        const uri = document.uri;
        const webview = webviewPanel.webview;
        const folderPath = vscode.Uri.joinPath(uri, '..')
        webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file("/"), ...this.getFolders()]
        }
        const handler = Handler.bind(webviewPanel, uri);
        this.handleMarkdown(document, handler, folderPath)
        handler.on('developerTool', () => vscode.commands.executeCommand('workbench.action.toggleDevTools'))
    }

    private handleMarkdown(document: vscode.TextDocument, handler: Handler, folderPath: vscode.Uri) {

        const uri = document.uri;
        const webview = handler.panel.webview;

        let content = document.getText();
        const contextPath = `${this.extensionPath}/resource/vditor`;
        const rootPath = webview.asWebviewUri(vscode.Uri.file(`${contextPath}`)).toString();

        Holder.activeDocument = document;
        handler.panel.onDidChangeViewState(e => {
            Holder.activeDocument = e.webviewPanel.visible ? document : Holder.activeDocument
            if (e.webviewPanel.visible) {
                this.updateCount(content)
                this.countStatus.show()
            } else {
                this.countStatus.hide()
            }
        });

        let lastManualSaveTime: number;
        const config = vscode.workspace.getConfiguration("hkk-md-editor");

        // ── Phase 1: 外部改动同步 + dirty 安全锁 ──────────────────────
        // lastSyncedText 是"我们已知的真相",用来去重(避免把自己刚写盘的内容当外部改动)
        const normalize = (s: string) => (s ?? '').replace(/\r\n/g, '\n');
        let lastSyncedText = normalize(content);
        let conflictNotified = false;

        const handleExternalText = (newText: string) => {
            const normalized = normalize(newText);
            if (normalized === lastSyncedText) return; // 自身回写,跳过
            if (document.isDirty) {
                // 有未保存草稿 → 不覆盖,只弹一次警告;保存时由 VS Code 原生对话框做最终裁决
                if (!conflictNotified) {
                    conflictNotified = true;
                    vscode.window.showWarningMessage('文件冲突！文件已在别的地方被修改，请注意处理。');
                }
                return;
            }
            // 干净状态:静默更新 webview 内容
            conflictNotified = false;
            content = newText;
            lastSyncedText = normalized;
            this.updateCount(content);
            handler.emit('update', newText);
        };
        // ─────────────────────────────────────────────────────────────

        handler.on("init", () => {
            const scrollTop = this.state.get(`scrollTop_${document.uri.fsPath}`, 0);
            handler.emit("open", {
                title: basename(uri.fsPath),
                config, scrollTop,
                language: vscode.env.language,
                rootPath, content
            })
            this.updateCount(content)
            this.countStatus.show()
        }).on("externalUpdate", e => {
            // VS Code 内文档变化:含我们自己 applyEdit 引起的,以及干净时 VS Code 自动重载外部改动
            if (lastManualSaveTime && Date.now() - lastManualSaveTime < 800) return;
            handleExternalText(e.document.getText());
        }).on("fileChange", async () => {
            // 磁盘文件变化:即使 VS Code 没自动重载(dirty 时会拒绝),这里也会收到
            if (lastManualSaveTime && Date.now() - lastManualSaveTime < 800) return;
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                handleExternalText(Buffer.from(bytes).toString('utf8'));
            } catch { /* 文件被删 / 暂不可读 */ }
        }).on("command", (command) => {
            vscode.commands.executeCommand(command)
        }).on("openLink", (uri: string) => {
            const resReg = /https:\/\/file.*\.net/i;
            if (uri.match(resReg)) {
                const localPath = uri.replace(resReg, '')
                vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(localPath));
            } else {
                vscode.env.openExternal(vscode.Uri.parse(uri));
            }
        }).on("scroll", ({ scrollTop }) => {
            this.state.update(`scrollTop_${document.uri.fsPath}`, scrollTop)
        }).on("img", async (img) => {
            const { relPath, fullPath } = adjustImgPath(uri)
            const imagePath = isAbsolute(fullPath) ? fullPath : `${resolve(uri.fsPath, "..")}/${relPath}`.replace(/\\/g, "/");
            const imageDir = dirname(imagePath);
            if (!existsSync(imageDir)) mkdirSync(imageDir, { recursive: true });
            writeFileSync(imagePath, Buffer.from(img, 'binary'))
            const fileName = parse(relPath).name;
            const adjustRelPath = await MarkdownService.imgExtGuide(imagePath, relPath);
            vscode.env.clipboard.writeText(`![${fileName}](${adjustRelPath})`)
            vscode.commands.executeCommand("editor.action.clipboardPasteAction")
        }).on("editInVSCode", (full: boolean) => {
            const side = full ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
            vscode.commands.executeCommand('vscode.openWith', uri, "default", side);
        }).on("save", (newContent) => {
            if (lastManualSaveTime && Date.now() - lastManualSaveTime < 800) return;
            content = newContent
            lastSyncedText = normalize(newContent);  // 记下"我们刚写的内容",避免随后的事件被当外部改动
            this.updateTextDocument(document, newContent)
            this.updateCount(content)
        }).on("doSave", async (newContent) => {
            lastManualSaveTime = Date.now();
            lastSyncedText = normalize(newContent);
            await this.updateTextDocument(document, newContent)
            this.updateCount(newContent)
            vscode.commands.executeCommand('workbench.action.files.save');
        }).on("export", (option) => {
            vscode.commands.executeCommand('workbench.action.files.save');
            new MarkdownService(this.context).exportMarkdown(uri, option)
        }).on("theme", async (theme) => {
            if (!theme) {
                const themes = [
                    "Auto", "|",
                    "Light", "Solarized", "Warm Light", "Dim Light", "|",
                    "One Dark", "Github Dark",
                    "Nord", "Monokai", "Dracula",
                ];
                const editorTheme = Global.getConfig('editorTheme');
                const themeItems: vscode.QuickPickItem[] = themes.map(theme => {
                    if (theme == '|') return { label: '|', kind: vscode.QuickPickItemKind.Separator }
                    return { label: theme, description: theme == editorTheme ? 'Current' : undefined }
                })
                theme = await vscode.window.showQuickPick(themeItems, { placeHolder: "Select Editor Theme" });
                if (!theme) return
            }
            const label = typeof theme === 'string' ? theme : theme.label;
            handler.emit('theme', label)
            Global.updateConfig('editorTheme', label)
        }).on("saveOutline", (enable) => {
            config.update("openOutline", enable, true)
        }).on('developerTool', () => {
            vscode.commands.executeCommand('workbench.action.toggleDevTools')
        })

        // ── 1 秒轮询兜底(zhfix / Obsidian 等"临时文件+原子改名"会绕开 FileSystemWatcher)──
        let pollTimer: NodeJS.Timeout | undefined;
        let lastStatMtime = -1;
        let lastStatSize = -1;
        const pollDisk = async () => {
            if (lastManualSaveTime && Date.now() - lastManualSaveTime < 800) return;
            let st: vscode.FileStat;
            try {
                st = await vscode.workspace.fs.stat(uri);
            } catch { return; }
            if (st.mtime === lastStatMtime && st.size === lastStatSize) return;
            lastStatMtime = st.mtime;
            lastStatSize = st.size;
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                handleExternalText(Buffer.from(bytes).toString('utf8'));
            } catch { /* 文件被删 / 暂不可读 */ }
        };
        const startPoll = () => { if (!pollTimer) pollTimer = setInterval(pollDisk, 1000); };
        const stopPoll = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; } };
        handler.panel.onDidChangeViewState(() => {
            if (handler.panel.visible) { pollDisk(); startPoll(); }
            else stopPoll();
        });
        startPoll();
        handler.panel.onDidDispose(() => stopPoll());
        // ─────────────────────────────────────────────────────────────────────────────────

        const basePath = Global.getConfig('workspacePathAsImageBasePath') ?
            vscode.Uri.file(getWorkspacePath(folderPath)) : folderPath;
        const baseUrl = webview.asWebviewUri(basePath).toString().replace(/\?.+$/, '').replace('https://git', 'https://file');
        webview.html = Util.buildPath(
            readFileSync(`${this.extensionPath}/resource/vditor/index.html`, 'utf8')
                .replace("{{rootPath}}", rootPath)
                .replace("{{baseUrl}}", baseUrl)
                .replace(`{{configs}}`, JSON.stringify({
                    platform: platform()
                })),
            webview, contextPath);
    }

    private updateCount(content: string) {
        this.countStatus.text = `Line ${content.split(/\r\n|\r|\n/).length}    Count ${content.length}`
    }

    private updateTextDocument(document: vscode.TextDocument, content: any) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), content);
        return vscode.workspace.applyEdit(edit);
    }

}