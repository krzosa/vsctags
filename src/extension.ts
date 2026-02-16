import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";

// ---- Output Channel for observability ----
let log: vscode.OutputChannel;

function logInfo(msg: string) {
  const ts = new Date().toISOString();
  log.appendLine(`[${ts}] ${msg}`);
}

function logError(msg: string) {
  const ts = new Date().toISOString();
  log.appendLine(`[${ts}] ERROR: ${msg}`);
}

/** A single parsed ctags entry */
interface CtagsEntry {
  name: string;
  file: string;
  pattern: string;
  kind: string;
  lineNumber: number;
  fields: Map<string, string>;
}

/** Parse raw tag lines into entries (without resolving pattern line numbers) */
function parseCtagsLines(content: string): CtagsEntry[] {
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
    let lineNumber = -1; // -1 means "needs resolution"
    const fields = new Map<string, string>();

    const exCmdEnd = rest.indexOf(';"');
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

    // Resolve line number from fields or numeric pattern
    const lineField = fields.get("line");
    if (lineField) {
      lineNumber = Math.max(0, parseInt(lineField, 10) - 1);
    } else if (/^\d+$/.test(pattern.trim())) {
      lineNumber = Math.max(0, parseInt(pattern.trim(), 10) - 1);
    }
    // otherwise lineNumber stays -1 => needs pattern resolution

    entries.push({ name, file, pattern, kind, lineNumber, fields });
  }
  return entries;
}

/** Extract the search text from a ctags /^...$/ pattern */
function extractSearchText(pattern: string): string {
  let s = pattern;
  if (s.startsWith("/^")) { s = s.substring(2); }
  else if (s.startsWith("/")) { s = s.substring(1); }
  if (s.endsWith("$/")) { s = s.substring(0, s.length - 2); }
  else if (s.endsWith("/")) { s = s.substring(0, s.length - 1); }
  s = s.replace(/\\\//g, "/").replace(/\\\\/g, "\\");
  return s;
}

/** Resolve pattern-based line numbers by reading source files (async, batched by file) */
async function resolvePatternLineNumbers(entries: CtagsEntry[], workspaceRoot: string): Promise<number> {
  // Group entries that need resolution by file
  const byFile = new Map<string, CtagsEntry[]>();
  let needsResolution = 0;
  for (const entry of entries) {
    if (entry.lineNumber === -1) {
      needsResolution++;
      let list = byFile.get(entry.file);
      if (!list) { list = []; byFile.set(entry.file, list); }
      list.push(entry);
    }
  }

  if (needsResolution === 0) { return 0; }

  logInfo(`  Resolving ${needsResolution} pattern-based line numbers across ${byFile.size} files...`);
  let resolved = 0;
  let fileErrors = 0;

  for (const [relFile, fileEntries] of byFile) {
    const absPath = path.join(workspaceRoot, relFile);
    try {
      const fileContent = await fs.readFile(absPath, "utf-8");
      const fileLines = fileContent.split("\n");

      for (const entry of fileEntries) {
        const searchText = extractSearchText(entry.pattern);
        if (searchText.length === 0) {
          entry.lineNumber = 0;
          continue;
        }
        let found = false;
        for (let i = 0; i < fileLines.length; i++) {
          if (fileLines[i].includes(searchText)) {
            entry.lineNumber = i;
            resolved++;
            found = true;
            break;
          }
        }
        if (!found) {
          entry.lineNumber = 0; // fallback
        }
      }
    } catch {
      fileErrors++;
      for (const entry of fileEntries) {
        entry.lineNumber = 0;
      }
    }
  }

  logInfo(`  Resolved ${resolved}/${needsResolution} patterns (${fileErrors} unreadable files)`);
  return needsResolution;
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

/** Format milliseconds into a human-readable string */
function formatDuration(ms: number): string {
  if (ms < 1) { return `${(ms * 1000).toFixed(0)}\u00b5s`; }
  if (ms < 1000) { return `${ms.toFixed(1)}ms`; }
  return `${(ms / 1000).toFixed(2)}s`;
}

// ---- Extension State ----

let allEntries: CtagsEntry[] = [];
let tagIndex: CtagsIndex = new Map();
let wsRoot = "";
let statusBarItem: vscode.StatusBarItem;
let isLoading = false;

function updateStatusBar() {
  if (isLoading) {
    statusBarItem.text = "$(sync~spin) vsctags: loading...";
    statusBarItem.tooltip = "Loading tags file...";
  } else if (allEntries.length > 0) {
    statusBarItem.text = `$(tag) vsctags: ${allEntries.length}`;
    statusBarItem.tooltip = `${allEntries.length} tags loaded\n${tagIndex.size} unique symbols\nClick to reload`;
  } else {
    statusBarItem.text = "$(tag) vsctags: no tags";
    statusBarItem.tooltip = "No tags file found. Click to reload.";
  }
  statusBarItem.command = "vsctags.reloadTags";
  statusBarItem.show();
}

async function loadTags(): Promise<boolean> {
  if (!wsRoot) { return false; }
  if (isLoading) {
    logInfo("Load already in progress, skipping.");
    return false;
  }

  isLoading = true;
  updateStatusBar();

  const tagsPath = path.join(wsRoot, "tags");
  const totalStart = performance.now();

  try {
    // Stage 1: Read file
    logInfo("Stage 1/4: Reading tags file...");
    const t1 = performance.now();
    const content = await fs.readFile(tagsPath, "utf-8");
    const fileSizeKB = (Buffer.byteLength(content, "utf-8") / 1024).toFixed(1);
    const readTime = performance.now() - t1;
    logInfo(`  Read ${fileSizeKB} KB in ${formatDuration(readTime)}`);

    // Stage 2: Parse lines
    logInfo("Stage 2/4: Parsing tag entries...");
    const t2 = performance.now();
    const entries = parseCtagsLines(content);
    const parseTime = performance.now() - t2;
    logInfo(`  Parsed ${entries.length} entries in ${formatDuration(parseTime)}`);

    // Stage 3: Resolve patterns
    logInfo("Stage 3/4: Resolving pattern line numbers...");
    const t3 = performance.now();
    const patternsResolved = await resolvePatternLineNumbers(entries, wsRoot);
    const resolveTime = performance.now() - t3;
    if (patternsResolved > 0) {
      logInfo(`  Pattern resolution took ${formatDuration(resolveTime)}`);
    } else {
      logInfo(`  No patterns to resolve (all entries have line numbers)`);
    }

    // Stage 4: Build index
    logInfo("Stage 4/4: Building symbol index...");
    const t4 = performance.now();
    const index = buildIndex(entries);
    const indexTime = performance.now() - t4;
    logInfo(`  Indexed ${index.size} unique symbols in ${formatDuration(indexTime)}`);

    // Commit
    allEntries = entries;
    tagIndex = index;

    // Summary
    const totalTime = performance.now() - totalStart;
    const summary = [
      `--- Load complete ---`,
      `  Tags: ${allEntries.length} entries, ${tagIndex.size} unique symbols`,
      `  File size: ${fileSizeKB} KB`,
      `  Timings:`,
      `    Read:    ${formatDuration(readTime)}`,
      `    Parse:   ${formatDuration(parseTime)}`,
      `    Resolve: ${formatDuration(resolveTime)}`,
      `    Index:   ${formatDuration(indexTime)}`,
      `    Total:   ${formatDuration(totalTime)}`,
    ].join("\n");
    logInfo(summary);

    // Collect kind stats
    const kindCounts = new Map<string, number>();
    for (const entry of allEntries) {
      const k = entry.kind || "(unknown)";
      kindCounts.set(k, (kindCounts.get(k) || 0) + 1);
    }
    const kindLines = Array.from(kindCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, c]) => `    ${k}: ${c}`);
    logInfo(`  Tag kinds:\n${kindLines.join("\n")}`);

    isLoading = false;
    updateStatusBar();
    return true;
  } catch (err) {
    const totalTime = performance.now() - totalStart;
    logError(`Failed to load tags from ${tagsPath} after ${formatDuration(totalTime)}: ${err}`);
    allEntries = [];
    tagIndex = new Map();
    isLoading = false;
    updateStatusBar();
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
    logInfo(`Definition lookup: "${word}" -> ${entries.length} result(s)`);
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
    const t = performance.now();
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
    logInfo(`Workspace symbol search: "${query}" -> ${results.length} result(s) in ${formatDuration(performance.now() - t)}`);
    return results;
  }
}

class CtagsDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument,
  ): vscode.SymbolInformation[] {
    const t = performance.now();
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
    logInfo(`Document symbols: "${relPath}" -> ${results.length} symbol(s) in ${formatDuration(performance.now() - t)}`);
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
    logInfo(`References lookup: "${word}" -> ${entries.length} result(s)`);
    return entries.map((e) => entryToLocation(e, wsRoot));
  }
}

// ---- Activation ----

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("vsctags");
  context.subscriptions.push(log);

  logInfo("Extension activating...");

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    logInfo("No workspace folder open. Extension idle.");
    return;
  }
  wsRoot = folders[0].uri.fsPath;
  logInfo(`Workspace root: ${wsRoot}`);

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  // Initial load with progress
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "vsctags: Loading tags..." },
    async (progress) => {
      progress.report({ message: "Reading tags file..." });
      const ok = await loadTags();
      if (ok) {
        progress.report({ message: `Loaded ${allEntries.length} tags` });
      }
    },
  );

  // Register providers for all languages
  const allLangs = { scheme: "file" };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(allLangs, new CtagsDefinitionProvider()),
    vscode.languages.registerHoverProvider(allLangs, new CtagsHoverProvider()),
    vscode.languages.registerWorkspaceSymbolProvider(new CtagsWorkspaceSymbolProvider()),
    vscode.languages.registerDocumentSymbolProvider(allLangs, new CtagsDocumentSymbolProvider()),
    vscode.languages.registerReferenceProvider(allLangs, new CtagsReferenceProvider()),
  );
  logInfo("Language providers registered (definition, hover, workspace symbols, document symbols, references)");

  // Watch the tags file for changes
  const tagsPattern = new vscode.RelativePattern(folders[0], "tags");
  const watcher = vscode.workspace.createFileSystemWatcher(tagsPattern);

  watcher.onDidChange(async () => {
    logInfo("Tags file changed on disk. Reloading...");
    await loadTags();
    vscode.window.showInformationMessage(`[vsctags] Reloaded ${allEntries.length} tags.`);
  });
  watcher.onDidCreate(async () => {
    logInfo("Tags file created. Loading...");
    await loadTags();
    vscode.window.showInformationMessage(`[vsctags] Loaded ${allEntries.length} tags.`);
  });
  watcher.onDidDelete(() => {
    logInfo("Tags file deleted.");
    allEntries = [];
    tagIndex = new Map();
    updateStatusBar();
    vscode.window.showInformationMessage("[vsctags] Tags file removed.");
  });

  context.subscriptions.push(watcher);
  logInfo("File watcher registered for tags file");

  // Manual reload command
  context.subscriptions.push(
    vscode.commands.registerCommand("vsctags.reloadTags", async () => {
      logInfo("Manual reload requested.");
      const ok = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "vsctags: Reloading tags..." },
        async () => loadTags(),
      );
      if (ok) {
        vscode.window.showInformationMessage(`[vsctags] Reloaded ${allEntries.length} tags.`);
      } else {
        vscode.window.showWarningMessage("[vsctags] No tags file found.");
      }
    }),
  );

  // Show output channel command
  context.subscriptions.push(
    vscode.commands.registerCommand("vsctags.showLog", () => {
      log.show();
    }),
  );

  logInfo("Extension activated.");
}

export function deactivate() {
  logInfo("Extension deactivated.");
}
