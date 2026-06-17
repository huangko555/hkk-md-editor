import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './provider/markdownEditorProvider';
import { MarkdownService } from './service/markdownService';
import { FileUtil } from './common/fileUtil';

export function activate(context: vscode.ExtensionContext) {
	const viewOption = { webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true } };
	FileUtil.init(context)
	const markdownService = new MarkdownService(context);
	const markdownEditorProvider = new MarkdownEditorProvider(context)
	context.subscriptions.push(
		vscode.commands.registerCommand('hkk-md-editor.switch', (uri) => { markdownService.switchEditor(uri) }),
		vscode.commands.registerCommand('hkk-md-editor.paste', () => { markdownService.loadClipboardImage() }),
		vscode.window.registerCustomEditorProvider("hkk-md-editor.editor", markdownEditorProvider, viewOption),
		vscode.window.registerCustomEditorProvider("hkk-md-editor.editor.optional", markdownEditorProvider, viewOption),
	);
}

export function deactivate() { }
