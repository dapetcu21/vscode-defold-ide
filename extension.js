// eslint-disable-next-line no-unused-vars
const vscode = require('vscode');

const registerRefactorHashCommand = require('./src/refactorHash')

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	registerRefactorHashCommand(context)
}

exports.activate = activate;

function deactivate() {}

module.exports = {
	activate,
	deactivate
}
