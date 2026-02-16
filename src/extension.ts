import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

/** A single parsed ctags entry */
interface CtagsEntry {
  name: string;
  file: string;
  pattern: string;
  kind: string;
  lineNumber: number;
  fields: Map<string, string>;
}

function parseCtagsFile(content: string, workspaceRoot: string): CtagsEntry[] {
  const entries: CtagsEntry[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    if (line.startsWith("!_TAG_") || line.trim() === "") {
      continue;
    }
    const firstTab = line.indexOf("\t");
    if (firstTab === -1) { continue; }
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (secondTab === -1) { continue; }

    const name = line.substring(0, firstTab);
    const file = line.substring(firstTab + 1, secondTab);
    const rest = line.substring(secondTab + 1);

    let pattern = "";
    let kind = "";
    let lineNumber = 0;
    const fields = new Map<string, string>();

    const exCmdEnd = rest.indexOf(';\"');
    if (exCmdEnd !== -1) {
      pattern = rest.substring(0, exCmdEnd);
      const afterExCmd = rest.substring(exCmdEnd + 2);
      const parts = afterExCmd.split("\t").filter((s) => s.length > 0);
      if (parts.length > 0) { kind = parts[0]; }
      for (let i = 1; i < parts.length; i++) {
        const colon = parts[i].indexOf(":");
        if (colon !== -1) {
          fields.set(parts[i].substring(0, colon), parts[i].substring(colon + 1));
        }
      }
    } else {
      pattern = rest;
    }

    const lineField = fields.get("line");
    if (lineField) {
      lineNumber = Math.max(0, parseInt(lineField, 10) - 1);
    } else if (/^\d+$/.test(pattern.trim())) {
      lineNumber = Math.max(0, parseInt(pattern.trim(), 10) - 1);
    } else {
      lineNumber = resolvePatternLineNumber(pattern, file, workspaceRoot);
    }

    entries.push({ name, file, pattern, kind, lineNumber, fields });
  }
  return entries;
}

function resolvePatternLineNumber(
  pattern: string,
  relativeFile: string,
  workspaceRoot: string,
): number {
  let searchText = pattern;
  if (searchText.startsWith("/^")) {
    searchText = searchText.substring(2);
  } else if (searchText.startsWith("/")) {
    searchText = searchText.substring(1);
  }
  if (searchText.endsWith("$/")) {
    searchText = searchText.substring(0, searchText.length - 2);
  } else if (searchText.endsWith("/")) {
    searchText = searchText.substring(0, searchText.length - 1);
  }

  searchText = searchText.replace(/\\\//g, "/").replace(/\\\\/g, "\\");

  if (searchText.length === 0) {
    return 0;
  }

  const absPath = path.join(workspaceRoot, relativeFile);
  try {
    const fileContent = fs.readFileSync(absPath, "utf-8");
    const fileLines = fileContent.split("\n");
    for (let i = 0; i < fileLines.length; i++) {
      if (fileLines[i].includes(searchText)) {
        return i;
      }
    }
  } catch {
    // file not readable
  }
  return 0;
}

type CtagsIndex = Map<string, CtagsEntry[]>;

function buildIndex(entries: CtagsEntry[]): CtagsIndex {
  const index: CtagsIndex = new Map();
  for (const entry of entries) {
    let list = index.get(entry.name);
    if (!list) {
      list = [];
      index.set(entry.name, list);
    }
    list.push(entry);
  }
  return index;
}

function entryToLocation(entry: CtagsEntry, root: string): vscode.Location {
  const uri = vscode.Uri.file(path.join(root, entry.file));
  const pos = new vscode.Position(entry.lineNumber, 0);
  return new vscode.Location(uri, pos);
}

function entryToSymbolKind(kind: string): vscode.SymbolKind {
  switch (kind) {
    case "f": case "function": case "func":
      return vscode.SymbolKind.Function;
    case "c": case "class":
      return vscode.SymbolKind.Class;
    case "m": case "method": case "member":
      return vscode.SymbolKind.Method;
    case "v": case "variable": case "var":
      return vscode.SymbolKind.Variable;
    case "s": case "struct": case "structure":
      return vscode.SymbolKind.Struct;
    case "e": case "enum": case "enumerator":
      return vscode.SymbolKind.Enum;
    case "i": case "interface":
      return vscode.SymbolKind.Interface;
    case "n": case "namespace":
      return vscode.SymbolKind.Namespace;
    case "d": case "macro": case "define":
      return vscode.SymbolKind.Constant;
    case "t": case "typedef": case "type":
      return vscode.SymbolKind.TypeParameter;
    case "p": case "property": case "prop":
      return vscode.SymbolKind.Property;
    case "g": case "enumeration":
      return vscode.SymbolKind.Enum;
    default:
      return vscode.SymbolKind.Variable;
  }
}

function getWordAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
): string | undefined {
  const range = document.getWordRangeAtPosition(position);
  if (!range) { return undefined; }
  return document.getText(range);
}

// ---- Extension State ----

let allEntries: CtagsEntry[] = [];
let tagIndex: CtagsIndex = new Map();
let wsRoot = "";

function loadTags(): boolean {
  if (!wsRoot) { return false; }
  const tagsPath = path.join(wsRoot, "tags");
  try {
    const content = fs.readFileSync(tagsPath, "utf-8");
    allEntries = parseCtagsFile(content, wsRoot);
    tagIndex = buildIndex(allEntries);
    console.log(`[vsctags] Loaded ${allEntries.length} tags from ${tagsPath}`);
    return true;
  } catch {
    console.log(`[vsctags] No tags file found at ${tagsPath}`);
    allEntries = [];
    tagIndex = new Map();
    return false;
  }
}

// ---- Providers ----

class CtagsDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location[] | undefined {
    const word = getWordAtPosition(document, position);
    if (!word) { return undefined; }
    const entries = tagIndex.get(word);
    if (!entries || entries.length === 0) { return undefined; }
    return entries.map((e) => entryToLocation(e, wsRoot));
  }
}

class CtagsHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const word = getWordAtPosition(document, position);
    if (!word) { return undefined; }
    const entries = tagIndex.get(word);
    if (!entries || entries.length === 0) { return undefined; }

    const lines: string[] = [];
    for (const entry of entries) {
      let label = `**${entry.name}**`;
      if (entry.kind) { label += ` _(${entry.kind})_`; }
      label += ` \u2014 ${entry.file}:${entry.lineNumber + 1}`;
      const scope = entry.fields.get("scope") || entry.fields.get("class");
      if (scope) { label += ` [${scope}]`; }
      lines.push(label);
    }
    return new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n")));
  }
}

class CtagsWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  provideWorkspaceSymbols(query: string): vscode.SymbolInformation[] {
    const results: vscode.SymbolInformation[] = [];
    const lowerQuery = query.toLowerCase();

    for (const entry of allEntries) {
      if (lowerQuery && !entry.name.toLowerCase().includes(lowerQuery)) {
        continue;
      }
      results.push(
        new vscode.SymbolInformation(
          entry.name,
          entryToSymbolKind(entry.kind),
          entry.fields.get("scope") || entry.fields.get("class") || "",
          entryToLocation(entry, wsRoot),
        ),
      );
      if (results.length >= 500) { break; }
    }
    return results;
  }
}

class CtagsDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument,
  ): vscode.SymbolInformation[] {
    const relPath = vscode.workspace.asRelativePath(document.uri, false);
    const results: vscode.SymbolInformation[] = [];

    for (const entry of allEntries) {
      if (entry.file === relPath) {
        results.push(
          new vscode.SymbolInformation(
            entry.name,
            entryToSymbolKind(entry.kind),
            entry.fields.get("scope") || entry.fields.get("class") || "",
            entryToLocation(entry, wsRoot),
          ),
        );
      }
    }
    return results;
  }
}

class CtagsReferenceProvider implements vscode.ReferenceProvider {
  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location[] | undefined {
    const word = getWordAtPosition(document, position);
    if (!word) { return undefined; }
    const entries = tagIndex.get(word);
    if (!entries || entries.length === 0) { return undefined; }
    return entries.map((e) => entryToLocation(e, wsRoot));
  }
}

// ---- Activation ----

export function activate(context: vscode.ExtensionContext) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) { return; }
  wsRoot = folders[0].uri.fsPath;

  loadTags();

  const allLangs = { scheme: "file" };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(allLangs, new CtagsDefinitionProvider()),
    vscode.languages.registerHoverProvider(allLangs, new CtagsHoverProvider()),
    vscode.languages.registerWorkspaceSymbolProvider(new CtagsWorkspaceSymbolProvider()),
    vscode.languages.registerDocumentSymbolProvider(allLangs, new CtagsDocumentSymbolProvider()),
    vscode.languages.registerReferenceProvider(allLangs, new CtagsReferenceProvider()),
  );

  // Watch the tags file for changes
  const tagsPattern = new vscode.RelativePattern(folders[0], "tags");
  const watcher = vscode.workspace.createFileSystemWatcher(tagsPattern);

  watcher.onDidChange(() => {
    loadTags();
    vscode.window.showInformationMessage("[vsctags] Tags file reloaded.");
  });
  watcher.onDidCreate(() => {
    loadTags();
    vscode.window.showInformationMessage("[vsctags] Tags file loaded.");
  });
  watcher.onDidDelete(() => {
    allEntries = [];
    tagIndex = new Map();
    vscode.window.showInformationMessage("[vsctags] Tags file removed.");
  });

  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.commands.registerCommand("vsctags.reloadTags", () => {
      if (loadTags()) {
        vscode.window.showInformationMessage(`[vsctags] Reloaded ${allEntries.length} tags.`);
      } else {
        vscode.window.showWarningMessage("[vsctags] No tags file found.");
      }
    }),
  );

  console.log(`[vsctags] Activated with ${allEntries.length} tags.`);
}

export function deactivate() {}
