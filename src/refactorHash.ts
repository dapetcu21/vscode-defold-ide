export type Insertion = {
  type: 'insert',
  text: string,
  offset: number,
}

export type Replacement = {
  type: 'replace',
  text: string,
  startOffset: number,
  endOffset: number,
}

export type Edit = Insertion | Replacement

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

function insertLocalHashDeclaration(text: string, hashIdentifier: string, string: string): Insertion | null {
	let insertPoint = -1
	let newlinesBefore = 0
	let newlinesAfter = 0

	// Try inserting the declaration after existing declarations
	// @ts-ignore
	for (const match of text.matchAll(/(^|\n)local [a-zA-Z_][0-9a-zA-Z_]* = hash\(("[^\r\n]*)/g)) {
		if (match[2].substring(0, string.length) === string) {
      return null
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

	const insertString =
    "\n".repeat(newlinesBefore) +
    `local ${hashIdentifier} = hash(${string})` +
    "\n".repeat(newlinesAfter);

  return { type: "insert", text: insertString, offset: insertPoint };
}

function insertModuleHashDeclaration(text: string, hashIdentifier: string, string: string): Insertion | null {
	let insertPoint = -1
	let newlinesBefore = 0
	let newlinesAfter = 0

	if (!text) {
		insertPoint = 0
		newlinesBefore = 0
		newlinesAfter = 1
	} else {
		// Try inserting the declaration after existing declarations
		// @ts-ignore
		for (const match of text.matchAll(/(^|\n)M\.[a-zA-Z_][0-9a-zA-Z_]* = hash\(("[^\r\n]*)/g)) {
			if (match[2].substring(0, string.length) === string) {
				return null
			}
			insertPoint = match.index + match[0].length
			newlinesBefore = 1
			newlinesAfter = 0
		}

		// Try inserting the declaration before return
		if (insertPoint === -1) {
			const match = text.match(/return\s+[a-zA-Z_][a-zA-Z0-9_]*\s*$/)
			if (match) {
				insertPoint = (match.index as number)
				newlinesBefore = 0
				newlinesAfter = 2
			}
		}

		if (insertPoint === -1) {
			insertPoint = text.length
			newlinesBefore = 1
			newlinesAfter = 0
		}
	}

	const insertString = '\n'.repeat(newlinesBefore) +
		`M.${hashIdentifier} = hash(${string})` +
		'\n'.repeat(newlinesAfter)

  return { type: 'insert', text: insertString, offset: insertPoint }
}

function insertModuleRequire(text: string, modulePath: string, moduleRequireBinding: string): Edit | null {
	let insertPoint = -1
	let newlinesBefore = 0
	let newlinesAfter = 0

	// Try inserting the declaration after requires
	if (insertPoint === -1) {
		// @ts-ignore
		for (const match of text.matchAll(/local\s+([a-zA-Z_][0-9a-zA-Z_]*)\s*=\s*require(\(|\s)[^\r\n]*/g)) {
			if (match[1] === moduleRequireBinding) { return null }
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

  return { type: 'insert', text: insertString, offset: insertPoint }
}

function replaceInDocument(text: string, edits: Edit[], from: string, to: string) {
	let searchStart = 0
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

    edits.push({ type: "replace", text: to, startOffset: startPos, endOffset: endPos })
		searchStart = endPos
	}
}

function hashDeclarationAlreadyExists(documentText: string, hashIdentifier: string, moduleText?: string) {
	if (moduleText) {
		return new RegExp(`(^|\\n)M\\.${hashIdentifier}\\s*=\\s*hash\\(`).test(moduleText)
	}
	return new RegExp(`(^|\\n)local\\s+${hashIdentifier}\\s*=\\s*hash\\(`).test(documentText)
}

function addEdit(edits: Edit[], edit: Edit | null | undefined) {
  if (edit) {
    edits.push(edit)
  }
}

export function refactorHashes(selections: string[], documentText: string, moduleText: string, options: {
  prefix: string,
  capitalise: boolean,
  modulePath: string,
  moduleRequireBinding: string,
}): { documentEdits: Edit[], moduleEdits: Edit[] } {
  const { prefix, capitalise, modulePath, moduleRequireBinding } = options

  const hashes: { 
    hash: string, 
    hashIdentifier: string, 
    stringSingleQuoted: string, 
    stringDoubleQuoted: string,
    shouldDeclare: boolean,
  }[] = []

  const documentEdits: Edit[] = []
  const moduleEdits: Edit[] = []

  selections.forEach(selection => {
    let hash = selection.replace(/^['"]|['"]$/g, '')

    if (prefix && hash.substr(0, prefix.length) === prefix) {
      hash = hash.substr(prefix.length)
    }

    if (hashes.find(item => item.hash === hash)) { return }

    const stringDoubleQuoted = '"' + escapeLua(hash) + '"'
    const stringSingleQuoted = '\'' + escapeLua(hash) + '\''
    const identifier = hash.replace(/[^0-9a-zA-Z_]/g, '_')
    const hashIdentifier = prefix + (capitalise ? identifier.toUpperCase() : identifier)

    const shouldDeclare = !hashDeclarationAlreadyExists(documentText, hashIdentifier, moduleText)

    hashes.push({ hash, hashIdentifier, stringSingleQuoted, stringDoubleQuoted, shouldDeclare })
  })
      
  if (!hashes.length) { 
    return { documentEdits, moduleEdits }
  }

  hashes.forEach(({ hashIdentifier, stringSingleQuoted, stringDoubleQuoted, shouldDeclare }) => {
    if (shouldDeclare) {
      if (modulePath) {
        addEdit(documentEdits, insertModuleRequire(documentText, modulePath, moduleRequireBinding))
      } else {
        addEdit(documentEdits, insertLocalHashDeclaration(documentText, hashIdentifier, stringDoubleQuoted))
      }
    }

    const identifier = modulePath ? `${moduleRequireBinding}.${hashIdentifier}` : hashIdentifier
    replaceInDocument(documentText, documentEdits, stringDoubleQuoted, identifier)
    replaceInDocument(documentText, documentEdits, stringSingleQuoted, identifier)
  })

  if (modulePath) {
    if (!moduleText) {
      moduleEdits.push({ type: "insert", offset: 0, text: "local M = {}\n\n" })
    }

    hashes.forEach(({ hashIdentifier, stringDoubleQuoted }) => {
      insertModuleHashDeclaration(moduleText, hashIdentifier, stringDoubleQuoted)
    })

    if (!moduleText) {
      moduleEdits.push({ type: "insert", offset: 0, text: "\nreturn M\n" })
    }
  }

  return { documentEdits, moduleEdits }
}
