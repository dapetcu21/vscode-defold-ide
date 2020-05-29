// eslint-disable-next-line no-unused-vars
import * as vscode from 'vscode'

import registerRefactorHashCommand from './refactorHash'

export function activate(context: vscode.ExtensionContext) {
	registerRefactorHashCommand(context)
}

export function deactivate() {}