import { 
	Range, 
	ExtensionContext, 
	TextEditor,
	TextEditorEdit,
	commands, 
	window, 
	workspace,
	Uri,
	WorkspaceEdit,
	TextDocument,
	Position,
} from 'vscode'
import { fileURLToPath } from 'url'
import { promises as fspromises } from 'fs'

function escapeLua(s: string) {
	return s
		.replace(/\r/g, '\\r')
		.replace(/\n/g, '\\n')
		.replace(/\t/g, '\\t')
		.replace(/\v/g, '\\v')
		.replace(/\\\\/g, '\\\\')
		.replace(/'/g, '\\\'')
		.replace(/"/g, '\\\"')
}

function insertLocalHashDeclaration(document: TextDocument, edit: WorkspaceEdit, hashIdentifier: string, string: string) {
	const text = document.getText()

	let insertPoint = -1
	let newlinesBefore = 0
	let newlinesAfter = 0

	// Try inserting the declaration after existing declarations
	// @ts-ignore
	for (const match of text.matchAll(/(^|\n)local [a-zA-Z_][0-9a-zA-Z_]* = hash\(("[^\r\n]*)/g)) {
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
	edit.insert(document.uri, document.positionAt(insertPoint), insertString)
}

function insertModuleHashDeclaration(document: TextDocument, fileUri: Uri, edit: WorkspaceEdit, hashIdentifier: string, string: string, fileDoesNotExist: boolean) {
	let insertPoint = -1
	let newlinesBefore = 0
	let newlinesAfter = 0

	if (fileDoesNotExist) {
		insertPoint = 0
		newlinesBefore = 0
		newlinesAfter = 1
	} else {
		const text = document.getText()

		// Try inserting the declaration after existing declarations
		// @ts-ignore
		for (const match of text.matchAll(/(^|\n)M\.[a-zA-Z_][0-9a-zA-Z_]* = hash\(("[^\r\n]*)/g)) {
			if (match[2].substring(0, string.length) === string) {
				return
			}
			insertPoint = match.index + match[0].length
			newlinesBefore = 1
			newlinesAfter = 0
		}

		// Try inserting the declaration before return
		if (insertPoint === -1) {
			const match = text.match(/return\s+[a-zA-Z_][a-zA-Z0-9_]*\s*$/)
			if (match) {
				insertPoint = match.index
				newlinesBefore = 0
				newlinesAfter = 2
			}
		}

		if (insertPoint === -1) {
			insertPoint = document.offsetAt(document.validatePosition(new Position(Infinity, Infinity)))
			newlinesBefore = 1
			newlinesAfter = 0
		}
	}

	const insertString = '\n'.repeat(newlinesBefore) +
		`M.${hashIdentifier} = hash(${string})` +
		'\n'.repeat(newlinesAfter)
	edit.insert(fileUri, document ? document.positionAt(insertPoint) : new Position(0, 0), insertString)
}

function insertModuleRequire(document: TextDocument, edit: WorkspaceEdit, modulePath: string, moduleRequireBinding: string) {
	const text = document.getText()

	let insertPoint = -1
	let newlinesBefore = 0
	let newlinesAfter = 0

	// Try inserting the declaration after requires
	if (insertPoint === -1) {
		// @ts-ignore
		for (const match of text.matchAll(/local\s+([a-zA-Z_][0-9a-zA-Z_]*)\s*=\s*require(\(|\s)[^\r\n]*/g)) {
			if (match[1] === moduleRequireBinding) { return }
			insertPoint = match.index + match[0].length
			newlinesBefore = 1
			newlinesAfter = 0
		}
	}

	if (insertPoint === -1) {
		insertPoint = 0
		newlinesBefore = 0
		newlinesAfter = 2
	}

	const luaPath = modulePath
		.replace(/^\.[/\\]/, '')
		.replace(/\.lua$/, '')
		.replace(/[/\\]/g, '.')

	const insertString = '\n'.repeat(newlinesBefore) +
		`local ${moduleRequireBinding} = require "${luaPath}"` +
		'\n'.repeat(newlinesAfter)
	edit.insert(document.uri, document.positionAt(insertPoint), insertString)
}

function replaceInDocument(document: TextDocument, edit: WorkspaceEdit, from: string, to: string) {
	let searchStart = 0
	const text = document.getText()
	while (true) {
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

		edit.replace(
			document.uri,
			new Range(
				document.positionAt(startPos),
				document.positionAt(endPos),
			),
			to
		)
		searchStart = endPos
	}
}

function hashDeclarationAlreadyExists(document: TextDocument, hashIdentifier: string, moduleDocument?: TextDocument) {
	if (moduleDocument) {
		const text = moduleDocument.getText()
		return new RegExp(`(^|\\n)M\\.${hashIdentifier}\\s*=\\s*hash\\(`).test(text)
	}
	const text = document.getText()
	return new RegExp(`(^|\\n)local\\s+${hashIdentifier}\\s*=\\s*hash\\(`).test(text)
}

async function getModuleUri(modulePath: string, editor: TextEditor) {
	let workspaceFolder = workspace.workspaceFolders.length === 1 ? workspace.workspaceFolders[0] : null
	if (!editor.document.isUntitled) {
		workspaceFolder = workspace.getWorkspaceFolder(editor.document.uri) || workspaceFolder
	}

	if (!workspaceFolder) {
		window.showErrorMessage("It's ambiguous which workspace folder defoldIDE.refactorHash.modulePath refers to. Save this file first.")
		return
	}

	const workspaceUri = workspaceFolder.uri
	return Uri.parse(workspaceUri.toString() + (workspaceUri.path.endsWith('/') ? '' : '/') + modulePath)
}

function registerRefactorHashCommand(context: ExtensionContext) {
	let disposable = commands.registerCommand('defold-ide.refactorHash', async function () {
		const editor = window.activeTextEditor
		if (!editor) { return }

		const document = editor.document

		const config = workspace.getConfiguration("defoldIDE.refactorHash")
		const prefix: string = config.get("prefix")
		const capitalise: boolean = config.get("capitalise")
		const modulePath: string = config.get("modulePath")
		const moduleRequireBinding: string = config.get("moduleRequireBinding")

		const edit = new WorkspaceEdit()

		let moduleUri: Uri
		let moduleDocument: TextDocument
		let fileDoesNotExist = false
		if (modulePath) {
			moduleUri = await getModuleUri(modulePath, editor)
			if (!moduleUri) { return }

			if (moduleUri.scheme === "file") {
				try {
					if (!(await fspromises.stat(moduleUri.fsPath)).isFile()) {
						fileDoesNotExist = true
					}
				} catch (err) {
					fileDoesNotExist = true
				}
			} 

			if (!fileDoesNotExist) {
				moduleDocument = await workspace.openTextDocument(moduleUri)
			}
		}

		const hashes = []
		editor.selections.forEach(selection => {
			const wordSelection = selection.isEmpty
				? document.getWordRangeAtPosition(selection.start)
                : selection
                
			if (!wordSelection || !wordSelection.isSingleLine) { return }

			let hash = document.getText(wordSelection)
				.replace(/^['"]|['"]$/g, '')

			if (prefix && hash.substr(0, prefix.length) === prefix) {
				hash = hash.substr(prefix.length)
			}

			if (hashes.find(item => item.hash === hash)) { return }

			const stringDoubleQuoted = '"' + escapeLua(hash) + '"'
			const stringSingleQuoted = '\'' + escapeLua(hash) + '\''
			const identifier = hash.replace(/[^0-9a-zA-Z_]/g, '_')
			const hashIdentifier = prefix + (capitalise ? identifier.toUpperCase() : identifier)

			if (hashDeclarationAlreadyExists(document, hashIdentifier, moduleDocument)) { return }

			hashes.push({ hash, hashIdentifier, stringSingleQuoted, stringDoubleQuoted })
        })
        
		if (!hashes.length) { return }

		hashes.forEach(({ hashIdentifier, stringSingleQuoted, stringDoubleQuoted }) => {
			if (modulePath) {
				insertModuleRequire(document, edit, modulePath, moduleRequireBinding)
			} else {
				insertLocalHashDeclaration(document, edit, hashIdentifier, stringDoubleQuoted)
			}

			const identifier = modulePath ? `${moduleRequireBinding}.${hashIdentifier}` : hashIdentifier
			replaceInDocument(document, edit, stringDoubleQuoted, identifier)
			replaceInDocument(document, edit, stringSingleQuoted, identifier)
		})
		
		if (moduleUri) {
			if (fileDoesNotExist) {
				edit.createFile(moduleUri)
				edit.insert(moduleUri, new Position(0, 0), "local M = {}\n\n")
			}

			hashes.forEach(({ hashIdentifier, stringDoubleQuoted }) => {
				insertModuleHashDeclaration(moduleDocument, moduleUri, edit, hashIdentifier, stringDoubleQuoted, fileDoesNotExist)
			})

			if (fileDoesNotExist) {
				edit.insert(moduleUri, new Position(0, 0), "\nreturn M\n")
			}
		}

		await workspace.applyEdit(edit)
	})

	context.subscriptions.push(disposable)
}

export default registerRefactorHashCommand