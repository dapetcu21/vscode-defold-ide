import {
  Range,
  ExtensionContext,
  TextEditor,
  commands,
  window,
  workspace,
  Uri,
  WorkspaceEdit,
  TextDocument,
  Position,
} from "vscode";
import { Edit, refactorHashes } from "../refactorHash";
import { promises as fspromises } from "fs";

function applyEdit(
  document: TextDocument,
  workspaceEdit: WorkspaceEdit,
  edit: Edit | null
) {
  if (!edit) return;
  switch (edit.type) {
    case "insert":
      if (edit.text) {
        workspaceEdit.insert(
          document.uri,
          document.positionAt(edit.offset),
          edit.text
        );
      }
      break;
    case "replace":
      if (edit.text) {
        workspaceEdit.replace(
          document.uri,
          new Range(
            document.positionAt(edit.startOffset),
            document.positionAt(edit.endOffset)
          ),
          edit.text
        );
      }
      break;
  }
}

function applyEditToNewDocument(
  uri: Uri,
  workspaceEdit: WorkspaceEdit,
  edit: Edit | null
) {
  if (!edit) return;
  switch (edit.type) {
    case "insert":
      if (edit.text) {
        workspaceEdit.insert(uri, new Position(0, 0), edit.text);
      }
      break;
  }
}

async function getModuleUri(modulePath: string, editor: TextEditor) {
  let workspaceFolder =
    workspace.workspaceFolders && workspace.workspaceFolders.length === 1
      ? workspace.workspaceFolders[0]
      : null;

  if (!editor.document.isUntitled) {
    workspaceFolder =
      workspace.getWorkspaceFolder(editor.document.uri) || workspaceFolder;
  }

  if (!workspaceFolder) {
    window.showErrorMessage(
      "It's ambiguous which workspace folder defoldIDE.refactorHash.modulePath refers to. Save this file first."
    );
    return null;
  }

  const workspaceUri = workspaceFolder.uri;
  return Uri.parse(
    workspaceUri.toString() +
      (workspaceUri.path.endsWith("/") ? "" : "/") +
      modulePath
  );
}

export default function registerRefactorHashCommand(context: ExtensionContext) {
  let disposable = commands.registerCommand(
    "defold-ide.refactorHash",
    async function () {
      const editor = window.activeTextEditor;
      if (!editor) {
        return;
      }

      const document = editor.document;

      const config = workspace.getConfiguration("defoldIDE.refactorHash");
      const prefix: string = config.get("prefix") || "";
      const capitalise: boolean = !!config.get("capitalise");
      const modulePath: string = config.get("modulePath") || "";
      const moduleRequireBinding: string =
        config.get("moduleRequireBinding") || "h";

      let moduleUri: Uri | null = null;
      let moduleDocument: TextDocument | undefined = undefined;
      let moduleDoesNotExist = false;
      let moduleText: string = "";
      if (modulePath) {
        moduleUri = await getModuleUri(modulePath, editor);
        if (!moduleUri) {
          return;
        }

        if (moduleUri.scheme === "file") {
          try {
            if (!(await fspromises.stat(moduleUri.fsPath)).isFile()) {
              moduleDoesNotExist = true;
            }
          } catch (err) {
            moduleDoesNotExist = true;
          }
        }

        if (!moduleDoesNotExist) {
          moduleDocument = await workspace.openTextDocument(moduleUri);
          if (moduleDocument) {
            moduleText = moduleDocument.getText();
          }
        }
      }

      const documentText: string = document.getText();

      const selections: string[] = [];
      editor.selections.forEach((selection) => {
        const wordSelection = selection.isEmpty
          ? document.getWordRangeAtPosition(selection.start)
          : selection;
        if (!wordSelection || !wordSelection.isSingleLine) {
          return;
        }
        selections.push(document.getText(wordSelection));
      });

      const { documentEdits, moduleEdits } = refactorHashes(
        selections,
        documentText,
        moduleText,
        {
          prefix,
          capitalise,
          modulePath,
          moduleRequireBinding,
        }
      );

      if (documentEdits.length === 0 && moduleEdits.length === 0) {
        return;
      }

      const workspaceEdit = new WorkspaceEdit();
      documentEdits.forEach((edit) => {
        applyEdit(document, workspaceEdit, edit);
      });

      if (modulePath) {
        if (moduleDoesNotExist && moduleUri) {
          workspaceEdit.createFile(moduleUri);
        }
        moduleEdits.forEach((edit) => {
          if (moduleDocument) {
            applyEdit(moduleDocument, workspaceEdit, edit);
          } else if (moduleUri) {
            applyEditToNewDocument(moduleUri, workspaceEdit, edit);
          }
        });
      }

      await workspace.applyEdit(workspaceEdit);
    }
  );

  context.subscriptions.push(disposable);
}
