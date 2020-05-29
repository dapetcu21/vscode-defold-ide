const vscode = require('vscode');

/**
 * @param {string} s
 */
function escapeLua(s) {
	return s
		.replace(/\r/g, '\\r')
		.replace(/\n/g, '\\n')
		.replace(/\t/g, '\\t')
		.replace(/\v/g, '\\v')
		.replace(/\\\\/g, '\\\\')
		.replace(/'/g, '\\\'')
		.replace(/"/g, '\\\"')
}

/**
 * @param {import("vscode").TextEditor} editor
 * @param {import("vscode").TextEditorEdit} editBuilder
 * @param {string} hashIdentifier
 * @param {string | any[]} string
 */
function insertLocalHashDeclaration(editor, editBuilder, hashIdentifier, string) {
	const text = editor.document.getText()

	let insertPoint = -1
	let newlinesBefore = 0
	let newlinesAfter = 0

	// Try inserting the declaration after existing declarations
	// @ts-ignore
	for (const match of text.matchAll(/(^|\n)local [a-zA-Z_][0-9a-zA-Z_]* = hash\(("[^\r\n]*)/g)) {
		console.log(match)
		if (match[2].substring(0, string.length) === string) {
			return
		}
		insertPoint = match.index + match[0].length
		newlinesBefore = 1
		newlinesAfter = 0
	}

	// Try inserting the declaration after requires
	if (insertPoint === -1) {
		// @ts-ignore
		for (const match of text.matchAll(/local\s+[a-zA-Z_][0-9a-zA-Z_]*\s*=\s*require(\(|\s)[^\r\n]*/g)) {
			insertPoint = match.index + match[0].length
			newlinesBefore = 2
			newlinesAfter = 0
		}
	}

	if (insertPoint === -1) {
		insertPoint = 0
		newlinesBefore = 0
		newlinesAfter = 2
	}

	const insertString = '\n'.repeat(newlinesBefore) +
		`local ${hashIdentifier} = hash(${string})` +
		'\n'.repeat(newlinesAfter)
	editBuilder.insert(editor.document.positionAt(insertPoint), insertString)
}

/**
 * @param {import("vscode").TextEditor} editor
 * @param {import("vscode").TextEditorEdit} editBuilder
 * @param {string} from
 * @param {string} to
 */
function replaceInDocument(editor, editBuilder, from, to) {
	let searchStart = 0
	while (true) {
		const text = editor.document.getText()
		const index = text.indexOf(from, searchStart)
		if (index < 0) { break }

		let startPos = index
		let endPos = index + from.length

		const match = text.substr(0, index).match(
			new RegExp(`(local ${to} = )?hash\\(\\s*$`)
		)

		if (match) {
			if (match[1]) {
				searchStart = index + from.length
				continue
			} else {
				startPos = startPos - match[0].length
				const endMatch = text.substr(endPos).match(/\s*\)/)
				if (endMatch) {
					endPos = endPos + endMatch[0].length
				}
			}
		}

		editBuilder.replace(
			new vscode.Range(
				editor.document.positionAt(startPos),
				editor.document.positionAt(endPos),
			),
			to
		)
		searchStart = startPos + to.length
	}
}

function hashDeclarationAlreadyExists(editor, hashIdentifier) {
	const text = editor.document.getText()
	return new RegExp(`(^|\\n)local\\s+${hashIdentifier}\\s*=\\s*hash\\(`).test(text)
}

/**
 * @param {import("vscode").ExtensionContext} context
 */
function registerRefactorHashCommand(context) {
	let disposable = vscode.commands.registerCommand('defold-ide.refactorHash', function () {
		const editor = vscode.window.activeTextEditor
		if (!editor) { return }

		const config = vscode.workspace.getConfiguration("defoldIDE.refactorHash")
		const prefix = config.get("prefix")
		const capitalise = config.get("capitalise")

        const hashes = []
		editor.selections.forEach(selection => {
			const wordSelection = selection.isEmpty
				? editor.document.getWordRangeAtPosition(selection.start)
                : selection
                
			if (!wordSelection || !wordSelection.isSingleLine) { return }

			let word = editor.document.getText(wordSelection)
				.replace(/^['"]|['"]$/g, '')

			if (prefix && word.substr(0, prefix.length) == prefix) {
				word = word.substr(prefix.length)
			}

			hashes.push(word)
        })
        
		if (!hashes.length) { return }


		editor.edit(editBuilder => {
			hashes.forEach(hash => {
				const stringDoubleQuoted = '"' + escapeLua(hash) + '"'
				const stringSingleQuoted = '\'' + escapeLua(hash) + '\''
				const identifier = hash.replace(/[^0-9a-zA-Z_]/g, '_')
				const hashIdentifier = prefix + (capitalise ? identifier.toUpperCase() : identifier)

				if (hashDeclarationAlreadyExists(editor, hashIdentifier)) { return }

				insertLocalHashDeclaration(editor, editBuilder, hashIdentifier, stringDoubleQuoted)

				replaceInDocument(editor, editBuilder, stringDoubleQuoted, hashIdentifier)
				replaceInDocument(editor, editBuilder, stringSingleQuoted, hashIdentifier)
			})
		})
	});

	context.subscriptions.push(disposable);
}

module.exports = registerRefactorHashCommand