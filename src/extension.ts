import * as vscode from "vscode";
import * as path from "path";
import { createReadStream } from "fs";
import * as readline from "readline";

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

// ---- Data structures ----

/**
 * Lightweight ctags entry. Uses direct properties instead of Map
 * to save ~200 bytes per entry at scale.
 */
interface CtagsEntry {
  name: string;
  nameLower: string;  // pre-cached lowercase for fast search
  file: string;
  pattern: string;
  kind: string;
  lineNumber: number; // -1 = unresolved, resolved lazily on first access
  scope: string;      // extracted from fields (scope or class)
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

// ---- Streaming parser ----

/**
 * Parse a ctags file using streaming readline.
 * Avoids loading the entire file into memory as a single string.
 */
function streamParseCtagsFile(
  tagsPath: string,
  onProgress?: (count: number) => void,
): Promise<CtagsEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: CtagsEntry[] = [];
    let progressCounter = 0;
    const progressInterval = 50000; // report every 50K entries
    const rl = readline.createInterface({
      input: createReadStream(tagsPath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    rl.on("line", (line: string) => {
      if (line.startsWith("!_TAG_") || line.length === 0) {
        return;
      }
      const firstTab = line.indexOf("\t");
      if (firstTab === -1) { return; }
      const secondTab = line.indexOf("\t", firstTab + 1);
      if (secondTab === -1) { return; }

      const name = line.substring(0, firstTab);
      const file = line.substring(firstTab + 1, secondTab);
      const rest = line.substring(secondTab + 1);

      let pattern = "";
      let kind = "";
      let lineNumber = -1;
      let scope = "";
      let lineField = "";

      const exCmdEnd = rest.indexOf(';"');
      if (exCmdEnd !== -1) {
        pattern = rest.substring(0, exCmdEnd);
        const afterExCmd = rest.substring(exCmdEnd + 2);
        const parts = afterExCmd.split("\t");
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (p.length === 0) { continue; }
          if (i === 0 || (kind === "" && p.indexOf(":") === -1)) {
            // First non-empty part after ;" that isn't a key:value is the kind
            if (kind === "") { kind = p; continue; }
          }
          const colon = p.indexOf(":");
          if (colon !== -1) {
            const key = p.substring(0, colon);
            const val = p.substring(colon + 1);
            if (key === "line") { lineField = val; }
            else if (key === "scope" || key === "class") { scope = val; }
          }
        }
      } else {
        pattern = rest;
      }

      // Resolve line number from field or numeric pattern
      if (lineField) {
        lineNumber = Math.max(0, parseInt(lineField, 10) - 1);
      } else if (/^\d+$/.test(pattern)) {
        lineNumber = Math.max(0, parseInt(pattern, 10) - 1);
      }
      // else stays -1 => lazy resolution

      entries.push({
        name,
        nameLower: name.toLowerCase(),
        file,
        pattern,
        kind,
        lineNumber,
        scope,
      });

      progressCounter++;
      if (onProgress && progressCounter % progressInterval === 0) {
        onProgress(progressCounter);
      }
    });

    rl.on("close", () => {
      if (onProgress) { onProgress(entries.length); }
      resolve(entries);
    });
    rl.on("error", (err: Error) => reject(err));
  });
}

// ---- Indexes ----

/** Name lookup: tag name -> entries */
type NameIndex = Map<string, CtagsEntry[]>;

/** File lookup: relative file path -> entries */
type FileIndex = Map<string, CtagsEntry[]>;

/**
 * Sorted array of { nameLower, entry } for binary-search prefix matching.
 * Sorted by nameLower.
 */
interface SortedSymbol {
  nameLower: string;
  entry: CtagsEntry;
}

interface TagDatabase {
  entries: CtagsEntry[];
  nameIndex: NameIndex;
  fileIndex: FileIndex;
  sorted: SortedSymbol[];
}

function buildDatabase(entries: CtagsEntry[]): TagDatabase {
  const nameIndex: NameIndex = new Map();
  const fileIndex: FileIndex = new Map();

  for (const entry of entries) {
    // Name index
    let nameList = nameIndex.get(entry.name);
    if (!nameList) { nameList = []; nameIndex.set(entry.name, nameList); }
    nameList.push(entry);

    // File index
    let fileList = fileIndex.get(entry.file);
    if (!fileList) { fileList = []; fileIndex.set(entry.file, fileList); }
    fileList.push(entry);
  }

  // Sorted array for binary-search prefix matching
  const sorted: SortedSymbol[] = entries.map(e => ({ nameLower: e.nameLower, entry: e }));
  sorted.sort((a, b) => {
    if (a.nameLower < b.nameLower) { return -1; }
    if (a.nameLower > b.nameLower) { return 1; }
    return 0;
  });

  return { entries, nameIndex, fileIndex, sorted };
}

/**
 * Binary search: find the first index in sorted[] where nameLower >= prefix.
 */
function lowerBound(sorted: SortedSymbol[], prefix: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid].nameLower < prefix) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Fast prefix search using binary search on sorted symbols.
 * Returns up to `limit` entries whose name starts with `prefix`.
 */
function prefixSearch(db: TagDatabase, prefix: string, limit: number): CtagsEntry[] {
  const results: CtagsEntry[] = [];
  const start = lowerBound(db.sorted, prefix);
  for (let i = start; i < db.sorted.length && results.length < limit; i++) {
    if (db.sorted[i].nameLower.startsWith(prefix)) {
      results.push(db.sorted[i].entry);
    } else {
      break; // sorted, so no more matches
    }
  }
  return results;
}

/**
 * Substring search fallback. Linear scan but uses pre-cached nameLower.
 */
function substringSearch(db: TagDatabase, query: string, limit: number): CtagsEntry[] {
  const results: CtagsEntry[] = [];
  for (const entry of db.entries) {
    if (entry.nameLower.includes(query)) {
      results.push(entry);
      if (results.length >= limit) { break; }
    }
  }
  return results;
}

// ---- URI cache ----

/** Cache of file URIs to avoid redundant Uri.joinPath calls */
let fileUriCache = new Map<string, vscode.Uri>();

function getFileUri(relPath: string): vscode.Uri {
  let uri = fileUriCache.get(relPath);
  if (!uri) {
    uri = vscode.Uri.joinPath(wsRootUri, relPath);
    fileUriCache.set(relPath, uri);
  }
  return uri;
}

// ---- Lazy line number resolution ----

/**
 * Get file contents via VS Code's document model.
 * Uses already-loaded buffers when available, picks up unsaved changes,
 * and lets VS Code manage its own caching — no duplicate memory usage.
 */
async function getDocument(uri: vscode.Uri): Promise<vscode.TextDocument | null> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return null;
  }
}

/**
 * Resolve the line number of an entry lazily. If already resolved, returns immediately.
 * Otherwise reads the source file (with caching) and finds the pattern.
 */
async function resolveLineNumber(entry: CtagsEntry, rootUri: vscode.Uri): Promise<number> {
  if (entry.lineNumber >= 0) { return entry.lineNumber; }

  const searchText = extractSearchText(entry.pattern);
  if (searchText.length === 0) {
    entry.lineNumber = 0;
    return 0;
  }

  const doc = await getDocument(getFileUri(entry.file));
  if (!doc) {
    entry.lineNumber = 0;
    return 0;
  }

  for (let i = 0; i < doc.lineCount; i++) {
    if (doc.lineAt(i).text.includes(searchText)) {
      entry.lineNumber = i;
      return i;
    }
  }
  entry.lineNumber = 0;
  return 0;
}

/**
 * Resolve line numbers for a batch of entries.
 */
async function resolveEntries(entries: CtagsEntry[], rootUri: vscode.Uri): Promise<void> {
  for (const e of entries) {
    if (e.lineNumber === -1) {
      await resolveLineNumber(e, rootUri);
    }
  }
}

function entryToLocation(entry: CtagsEntry): vscode.Location {
  const ln = entry.lineNumber >= 0 ? entry.lineNumber : 0;
  return new vscode.Location(getFileUri(entry.file), new vscode.Position(ln, 0));
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

let db: TagDatabase = { entries: [], nameIndex: new Map(), fileIndex: new Map(), sorted: [] };
let wsRoot = "";
let wsRootUri: vscode.Uri;
let statusBarItem: vscode.StatusBarItem;
let isLoading = false;

function updateStatusBar() {
  if (isLoading) {
    statusBarItem.text = "$(sync~spin) vsctags: loading...";
    statusBarItem.tooltip = "Loading tags file...";
  } else if (db.entries.length > 0) {
    statusBarItem.text = `$(tag) vsctags: ${db.entries.length}`;
    statusBarItem.tooltip = `${db.entries.length} tags loaded\n${db.nameIndex.size} unique symbols\n${db.fileIndex.size} files\nClick to reload`;
  } else {
    statusBarItem.text = "$(tag) vsctags: no tags";
    statusBarItem.tooltip = "No tags file found. Click to reload.";
  }
  statusBarItem.command = "vsctags.reloadTags";
  statusBarItem.show();
}

async function loadTags(progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<boolean> {
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
    // Stage 1: Stream-parse the file
    logInfo("Stage 1/2: Stream-parsing tags file...");
    const t1 = performance.now();

    let fileSizeKB = "?";
    let fileSizeBytes = 0;
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(tagsPath));
      fileSizeBytes = stat.size;
      fileSizeKB = (fileSizeBytes / 1024).toFixed(1);
      logInfo(`  File size: ${fileSizeKB} KB`);
    } catch { /* stat failed, continue anyway */ }

    const entries = await streamParseCtagsFile(tagsPath, (count) => {
      const msg = `Parsing tags... ${(count / 1000).toFixed(0)}K entries`;
      statusBarItem.text = `$(sync~spin) vsctags: ${(count / 1000).toFixed(0)}K`;
      if (progress) { progress.report({ message: msg }); }
    });
    const parseTime = performance.now() - t1;
    const withLineNum = entries.filter(e => e.lineNumber >= 0).length;
    const needsResolve = entries.length - withLineNum;
    logInfo(`  Parsed ${entries.length} entries in ${formatDuration(parseTime)}`);
    logInfo(`  ${withLineNum} with line numbers, ${needsResolve} need lazy resolution`);

    // Stage 2: Build indexes (name, file, sorted)
    logInfo("Stage 2/2: Building indexes...");
    if (progress) { progress.report({ message: `Building index for ${entries.length} tags...` }); }
    statusBarItem.text = `$(sync~spin) vsctags: indexing...`;
    const t2 = performance.now();
    const newDb = buildDatabase(entries);
    const indexTime = performance.now() - t2;
    logInfo(`  Name index: ${newDb.nameIndex.size} unique symbols`);
    logInfo(`  File index: ${newDb.fileIndex.size} files`);
    logInfo(`  Sorted array: ${newDb.sorted.length} entries`);
    logInfo(`  Index build took ${formatDuration(indexTime)}`);

    // Commit — clear caches before swapping
    fileUriCache.clear();
    db = newDb;

    // Summary
    const totalTime = performance.now() - totalStart;
    const summary = [
      `--- Load complete ---`,
      `  Tags: ${db.entries.length} entries, ${db.nameIndex.size} unique symbols, ${db.fileIndex.size} files`,
      `  File size: ${fileSizeKB} KB`,
      `  Lazy resolution deferred for ${needsResolve} pattern-based entries`,
      `  Timings:`,
      `    Parse:  ${formatDuration(parseTime)}`,
      `    Index:  ${formatDuration(indexTime)}`,
      `    Total:  ${formatDuration(totalTime)}`,
    ].join("\n");
    logInfo(summary);

    // Collect kind stats
    const kindCounts = new Map<string, number>();
    for (const entry of db.entries) {
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
    db = { entries: [], nameIndex: new Map(), fileIndex: new Map(), sorted: [] };
    isLoading = false;
    updateStatusBar();
    return false;
  }
}

// ---- Providers ----

class CtagsDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Location[] | undefined> {
    const word = getWordAtPosition(document, position);
    if (!word) { return undefined; }
    const entries = db.nameIndex.get(word);
    if (!entries || entries.length === 0) { return undefined; }
    // Lazy-resolve line numbers before navigating
    await resolveEntries(entries, wsRootUri);
    logInfo(`Definition lookup: "${word}" -> ${entries.length} result(s)`);
    return entries.map((e) => entryToLocation(e));
  }
}

class CtagsHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const word = getWordAtPosition(document, position);
    if (!word) { return undefined; }
    const entries = db.nameIndex.get(word);
    if (!entries || entries.length === 0) { return undefined; }
    await resolveEntries(entries, wsRootUri);

    const lines: string[] = [];
    for (const entry of entries) {
      let label = `**${entry.name}**`;
      if (entry.kind) { label += ` _(${entry.kind})_`; }
      label += ` \u2014 ${entry.file}:${entry.lineNumber + 1}`;
      if (entry.scope) { label += ` [${entry.scope}]`; }
      lines.push(label);
    }
    return new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n")));
  }
}

class CtagsWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  provideWorkspaceSymbols(query: string, _token: vscode.CancellationToken): vscode.SymbolInformation[] {
    const t = performance.now();
    const limit = 200;
    const lowerQuery = query.toLowerCase().trim();

    if (lowerQuery.length === 0) {
      return [];
    }

    try {
      // Fast prefix search via binary search — O(log n + k), synchronous
      const results = prefixSearch(db, lowerQuery, limit);

      const symbols = results.map(entry =>
        new vscode.SymbolInformation(
          entry.name,
          entryToSymbolKind(entry.kind),
          entry.scope,
          entryToLocation(entry),
        ),
      );

      logInfo(`Workspace symbol search: "${query}" -> ${symbols.length} result(s) in ${formatDuration(performance.now() - t)}`);
      return symbols;
    } catch (err) {
      logError(`Workspace symbol search failed for "${query}": ${err}`);
      return [];
    }
  }

  async resolveWorkspaceSymbol(symbol: vscode.SymbolInformation): Promise<vscode.SymbolInformation | undefined> {
    // Resolve the exact line number when the user selects a symbol
    const relPath = vscode.workspace.asRelativePath(symbol.location.uri, false);
    const entries = db.nameIndex.get(symbol.name);
    if (!entries) { return symbol; }

    const match = entries.find(e => e.file === relPath);
    if (match) {
      if (match.lineNumber === -1) {
        await resolveLineNumber(match, wsRootUri);
      }
      symbol.location = entryToLocation(match);
    }
    return symbol;
  }
}

class CtagsDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument,
  ): vscode.SymbolInformation[] {
    const t = performance.now();
    const relPath = vscode.workspace.asRelativePath(document.uri, false);

    // O(1) lookup via file index instead of scanning all entries
    const fileEntries = db.fileIndex.get(relPath);
    if (!fileEntries || fileEntries.length === 0) {
      logInfo(`Document symbols: "${relPath}" -> 0 symbol(s) in ${formatDuration(performance.now() - t)}`);
      return [];
    }

    const results = fileEntries.map(entry =>
      new vscode.SymbolInformation(
        entry.name,
        entryToSymbolKind(entry.kind),
        entry.scope,
        entryToLocation(entry),
      ),
    );

    logInfo(`Document symbols: "${relPath}" -> ${results.length} symbol(s) in ${formatDuration(performance.now() - t)}`);
    return results;
  }
}

class CtagsReferenceProvider implements vscode.ReferenceProvider {
  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Location[] | undefined> {
    const word = getWordAtPosition(document, position);
    if (!word) { return undefined; }
    const entries = db.nameIndex.get(word);
    if (!entries || entries.length === 0) { return undefined; }
    await resolveEntries(entries, wsRootUri);
    logInfo(`References lookup: "${word}" -> ${entries.length} result(s)`);
    return entries.map((e) => entryToLocation(e));
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
  wsRootUri = folders[0].uri;
  wsRoot = wsRootUri.fsPath;
  logInfo(`Workspace root: ${wsRoot}`);

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  // Initial load with progress
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "vsctags" },
    async (progress) => {
      progress.report({ message: "Loading tags..." });
      const ok = await loadTags(progress);
      if (ok) {
        progress.report({ message: `Loaded ${db.entries.length} tags` });
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

  // Watch the tags file for changes (debounced)
  const tagsPattern = new vscode.RelativePattern(folders[0], "tags");
  const watcher = vscode.workspace.createFileSystemWatcher(tagsPattern);
  const debounceMs = 2000;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function debouncedReload(reason: string) {
    if (debounceTimer) { clearTimeout(debounceTimer); }
    logInfo(`Tags file ${reason}. Waiting ${debounceMs}ms for stability...`);
    statusBarItem.text = "$(sync~spin) vsctags: file changed...";
    debounceTimer = setTimeout(async () => {
      debounceTimer = undefined;
      logInfo("Debounce elapsed, reloading tags.");
      await loadTags();
      vscode.window.showInformationMessage(`[vsctags] Reloaded ${db.entries.length} tags.`);
    }, debounceMs);
  }

  watcher.onDidChange(() => debouncedReload("changed"));
  watcher.onDidCreate(() => debouncedReload("created"));
  watcher.onDidDelete(() => {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = undefined; }
    logInfo("Tags file deleted.");
    db = { entries: [], nameIndex: new Map(), fileIndex: new Map(), sorted: [] };
    fileUriCache.clear();
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
        async (progress) => loadTags(progress),
      );
      if (ok) {
        vscode.window.showInformationMessage(`[vsctags] Reloaded ${db.entries.length} tags.`);
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
