import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, CustomEditor, DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { complete, StringEnum, type Message } from "@earendil-works/pi-ai";
import { Container, Key, Markdown, Spacer, Text, deleteAllKittyImages, deleteKittyImage, getCapabilities, getCellDimensions, getImageDimensions, imageFallback, isKeyRelease, matchesKey, parseKey, renderImage, truncateToWidth, visibleWidth, type AutocompleteItem, type AutocompleteProvider, type EditorTheme, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

interface EquationNumberInfo {
  label?: string;
  number: string;
  page?: string;
  anchor?: string;
  auxFile?: string;
  raw?: string;
  source: "aux" | "tag";
}

interface AuxStatus {
  rootAux?: string;
  auxFiles: string[];
  found: boolean;
  stale: boolean;
  newestTexMtimeMs?: number;
  oldestAuxMtimeMs?: number;
  labels: number;
  warnings: string[];
}

interface EquationInfo {
  label?: string;
  labels: string[];
  number?: string;
  numbers: EquationNumberInfo[];
  tags: string[];
  numbered: boolean;
  numberingNotes: string[];
  file: string;
  lineStart: number;
  lineEnd: number;
  env: string;
  tex: string;
  nearby: string;
  symbols: string[];
}

interface PaperMap {
  generatedAt: string;
  cwd: string;
  rootTex?: string;
  texFiles: string[];
  macros: { name: string; args?: string; file: string; line: number }[];
  equations: EquationInfo[];
  labels: { label: string; file: string; line: number; kind: string }[];
  refs: { ref: string; file: string; line: number; command: string }[];
  citations: { key: string; file: string; line: number; command?: string }[];
  bibKeys: { key: string; file: string; line: number }[];
  equationNumbers: EquationNumberInfo[];
  auxStatus?: AuxStatus;
  todos: { text: string; file: string; line: number }[];
  warnings: string[];
}

const IngestParams = Type.Object({
  root: Type.Optional(Type.String({ description: "Root TeX file, default auto-detects main.tex or first documentclass file" })),
  writeCache: Type.Optional(Type.Boolean({ description: "Write .mechpi/paper-map.json (default true)" })),
  compileIfAuxMissing: Type.Optional(Type.Boolean({ description: "Run latexmk first when aux files needed for equation numbers are missing/stale (default false)" })),
});

const FocusParams = Type.Object({
  label: Type.Optional(Type.String({ description: "Equation label, e.g. eq:entropy" })),
  number: Type.Optional(Type.String({ description: "Rendered equation number from the compiled PDF/aux, e.g. 2.14" })),
  contains: Type.Optional(Type.String({ description: "Fallback text/macro to search for inside equations" })),
  contextLines: Type.Optional(Type.Number({ description: "Nearby context lines to include (default 6)" })),
  edit: Type.Optional(Type.Boolean({ description: "Open an interactive terminal equation editor and save changes back to source (default false)" })),
  autoCompile: Type.Optional(Type.Boolean({ description: "For number lookup, run latexmk if .aux files are missing/stale (default true)" })),
});

const CompileParams = Type.Object({
  root: Type.Optional(Type.String({ description: "Root TeX file (default from map/autodetect)" })),
  clean: Type.Optional(Type.Boolean({ description: "Run latexmk -C first" })),
  nonstop: Type.Optional(Type.Boolean({ description: "Use nonstopmode (default true)" })),
});

const PreviewParams = Type.Object({
  pdf: Type.Optional(Type.String({ description: "PDF path, default root .pdf" })),
  command: Type.Optional(Type.String({ description: "Preview command, default MECHPI_PDF_VIEWER or xdg-open" })),
});

const SearchParams = Type.Object({
  query: Type.String({ description: "Symbol/macro/text to search in TeX sources" }),
  includeContext: Type.Optional(Type.Boolean({ description: "Include one-line context (default true)" })),
});

const CheckParams = Type.Object({
  kind: Type.Optional(StringEnum(["all", "latex", "mechanics", "indices"] as const)),
});

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function unique<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function themeFg(theme: any, key: string, text: string): string {
  return typeof theme?.fg === "function" ? theme.fg(key, text) : text;
}

function mechPiEditorTheme(theme: any): EditorTheme {
  return {
    borderColor: (s: string) => typeof theme?.borderColor === "function" ? theme.borderColor(s) : themeFg(theme, "accent", s),
    selectList: {
      selectedPrefix: (s: string) => themeFg(theme, "accent", s),
      selectedText: (s: string) => themeFg(theme, "accent", s),
      description: (s: string) => themeFg(theme, "muted", s),
      scrollInfo: (s: string) => themeFg(theme, "dim", s),
      noMatch: (s: string) => themeFg(theme, "warning", s),
    },
  };
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function walk(dir: string, ignored = new Set([".git", "node_modules", ".pi", ".mechpi", "build"])): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (ignored.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walk(p, ignored));
    else out.push(p);
  }
  return out;
}

async function readText(p: string): Promise<string> { return await fs.readFile(p, "utf8"); }

function normalizeEditorLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function dominantLineEnding(text: string): "\n" | "\r\n" | "\r" {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const crOnly = text.match(/\r(?!\n)/g)?.length ?? 0;
  const lfOnly = text.match(/(?<!\r)\n/g)?.length ?? 0;
  if (crlf >= lfOnly && crlf >= crOnly && crlf > 0) return "\r\n";
  if (crOnly > lfOnly && crOnly > 0) return "\r";
  return "\n";
}

function restoreLineEndingsForSource(text: string, sourceText: string): string {
  const eol = dominantLineEnding(sourceText);
  return normalizeEditorLineEndings(text).replace(/\n/g, eol);
}

async function detectRoot(cwd: string, requested?: string): Promise<string | undefined> {
  if (requested) return path.resolve(cwd, requested);
  const main = path.join(cwd, "main.tex");
  if (await exists(main)) return main;
  const tex = (await walk(cwd)).filter(p => p.endsWith(".tex"));
  for (const p of tex) {
    const t = await readText(p).catch(() => "");
    if (/\\documentclass\b/.test(t)) return p;
  }
  return tex[0];
}

function stripComments(s: string): string {
  return s.split(/\r?\n/).map(l => l.replace(/(^|[^\\])%.*/, "$1")).join("\n");
}

function readBraced(s: string, open: number): { value: string; end: number } | null {
  if (s[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { value: s.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

function topLevelBraceGroups(s: string): string[] {
  const groups: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) continue;
    if (s[i] !== "{") continue;
    const g = readBraced(s, i);
    if (!g) break;
    groups.push(g.value);
    i = g.end - 1;
  }
  return groups;
}

function extractCommandArgs(tex: string, command: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\\\${command}\\*?\\s*\\{`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(tex))) {
    const open = m.index + m[0].lastIndexOf("{");
    const g = readBraced(tex, open);
    if (!g) continue;
    out.push(g.value);
    re.lastIndex = g.end;
  }
  return out;
}

function normalizeEquationNumber(n: string): string {
  let s = n.trim();
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1);
  return s
    .replace(/\\protect\s*/g, "")
    .replace(/\\ignorespaces\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, "");
}

function sameEquationNumber(a: string, b: string): boolean {
  return normalizeEquationNumber(a) === normalizeEquationNumber(b);
}

async function discoverTexClosure(cwd: string, root?: string): Promise<string[]> {
  if (!root) return (await walk(cwd)).filter(p => p.endsWith(".tex"));
  const seen = new Set<string>();
  async function visit(file: string) {
    const abs = path.resolve(file);
    if (seen.has(abs) || !(await exists(abs))) return;
    seen.add(abs);
    const dir = path.dirname(abs);
    const txt = stripComments(await readText(abs));
    const re = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt))) {
      const raw = m[1].trim();
      const child = path.resolve(dir, raw.endsWith(".tex") ? raw : `${raw}.tex`);
      await visit(child);
    }
  }
  await visit(root);
  return Array.from(seen);
}

function extractSymbols(tex: string): string[] {
  const macros = Array.from(tex.matchAll(/\\[A-Za-z]+/g)).map(m => m[0]);
  const indexed = Array.from(tex.matchAll(/([A-Za-z](_\{[^}]+\}|_[A-Za-z])?)/g)).map(m => m[1]);
  return unique([...macros, ...indexed]).filter(s => !["\\begin", "\\end", "\\label"].includes(s)).slice(0, 80);
}

function findEquations(rel: string, text: string, contextLines: number): EquationInfo[] {
  const envs = ["equation", "align", "gather", "multline", "eqnarray"];
  const out: EquationInfo[] = [];
  const lines = text.split(/\r?\n/);
  for (const env of envs) {
    const re = new RegExp(`\\\\begin\\{(${env}\\*?)\\}([\\s\\S]*?)\\\\end\\{\\1\\}`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const block = m[0];
      const actualEnv = m[1];
      const start = lineOf(text, m.index);
      const end = start + block.split(/\r?\n/).length - 1;
      const labels = extractCommandArgs(block, "label");
      const tags = extractCommandArgs(block, "tag");
      const starred = actualEnv.endsWith("*");
      const hasNoNumber = /\\(?:notag|nonumber)\b/.test(block);
      const numbered = !starred && !hasNoNumber && tags.length === 0;
      const numberingNotes: string[] = [];
      if (starred && tags.length === 0) numberingNotes.push("Starred environment has no automatic equation number.");
      if (numbered && labels.length === 0) numberingNotes.push("Potentially numbered but unlabeled; standard LaTeX aux files cannot map its PDF number back to source. Add \\label or \\tag for exact number lookup.");
      const nearby = lines.slice(Math.max(0, start - contextLines - 1), Math.min(lines.length, end + contextLines)).join("\n");
      out.push({
        label: labels[0], labels, number: undefined, numbers: [], tags, numbered,
        numberingNotes, file: rel, lineStart: start, lineEnd: end, env: actualEnv,
        tex: block, nearby, symbols: extractSymbols(block),
      });
    }
  }
  return out.sort((a, b) => a.lineStart - b.lineStart);
}

function parseAuxNewlabel(line: string, auxFile: string): EquationNumberInfo | null {
  const idx = line.indexOf("\\newlabel");
  if (idx < 0) return null;
  let pos = idx + "\\newlabel".length;
  while (/\s/.test(line[pos] ?? "")) pos++;
  const labelGroup = readBraced(line, pos);
  if (!labelGroup) return null;
  const label = labelGroup.value;
  if (/@(?:cref|rcref|currentlabel|currentHref|currentlabelname)$/.test(label)) return null;
  pos = labelGroup.end;
  while (/\s/.test(line[pos] ?? "")) pos++;
  const payload = readBraced(line, pos);
  if (!payload) return null;
  const groups = topLevelBraceGroups(payload.value);
  if (groups.length === 0) return null;
  return { label, number: groups[0], page: groups[1], anchor: groups[3], auxFile, raw: line.trim(), source: "aux" };
}

async function fileMtimeMs(p: string): Promise<number | undefined> {
  try { return (await fs.stat(p)).mtimeMs; } catch { return undefined; }
}

async function parseAuxTree(cwd: string, root?: string, texFiles: string[] = []): Promise<{ entries: EquationNumberInfo[]; status: AuxStatus }> {
  const expectedRootAuxAbs = root ? path.resolve(cwd, root).replace(/\.tex$/i, ".aux") : undefined;
  const status: AuxStatus = { rootAux: expectedRootAuxAbs ? path.relative(cwd, expectedRootAuxAbs) : undefined, auxFiles: [], found: false, stale: false, labels: 0, warnings: [] };
  if (!expectedRootAuxAbs || !root) {
    status.warnings.push("No root TeX file was detected, so aux-based equation numbers are unavailable.");
    return { entries: [], status };
  }
  const rootBase = path.basename(root, ".tex");
  const candidates = unique([
    expectedRootAuxAbs,
    path.resolve(cwd, `${rootBase}.aux`),
    path.resolve(cwd, "build", `${rootBase}.aux`),
    path.resolve(cwd, "out", `${rootBase}.aux`),
    path.resolve(cwd, "_build", `${rootBase}.aux`),
  ]);
  let rootAuxAbs: string | undefined;
  for (const candidate of candidates) if (await exists(candidate)) { rootAuxAbs = candidate; break; }
  if (!rootAuxAbs) {
    status.warnings.push(`Root aux file not found (looked for ${candidates.map(p => path.relative(cwd, p)).join(", ")}). Compile the document to build equation-number data.`);
    return { entries: [], status };
  }
  status.rootAux = path.relative(cwd, rootAuxAbs);

  const entries: EquationNumberInfo[] = [];
  const seen = new Set<string>();
  async function visit(auxAbs: string) {
    auxAbs = path.resolve(auxAbs);
    if (seen.has(auxAbs)) return;
    seen.add(auxAbs);
    if (!(await exists(auxAbs))) {
      status.warnings.push(`Included aux file not found: ${path.relative(cwd, auxAbs)}`);
      return;
    }
    status.found = true;
    status.auxFiles.push(path.relative(cwd, auxAbs));
    const text = await readText(auxAbs).catch(e => { status.warnings.push(`${path.relative(cwd, auxAbs)}: ${e.message}`); return ""; });
    for (const line of text.split(/\r?\n/)) {
      const entry = parseAuxNewlabel(line, path.relative(cwd, auxAbs));
      if (entry) entries.push(entry);
    }
    for (const m of text.matchAll(/\\@input\{([^}]+)\}/g)) {
      const raw = m[1].trim();
      const fromAuxDir = path.resolve(path.dirname(auxAbs), raw);
      const fromCwd = path.resolve(cwd, raw);
      await visit(await exists(fromAuxDir) ? fromAuxDir : fromCwd);
    }
  }
  await visit(rootAuxAbs);

  const texMtimes = (await Promise.all(texFiles.map(rel => fileMtimeMs(path.resolve(cwd, rel))))).filter((n): n is number => typeof n === "number");
  const auxMtimes = (await Promise.all(status.auxFiles.map(rel => fileMtimeMs(path.resolve(cwd, rel))))).filter((n): n is number => typeof n === "number");
  status.newestTexMtimeMs = texMtimes.length ? Math.max(...texMtimes) : undefined;
  status.oldestAuxMtimeMs = auxMtimes.length ? Math.min(...auxMtimes) : undefined;
  status.stale = !!(status.newestTexMtimeMs && status.oldestAuxMtimeMs && status.oldestAuxMtimeMs < status.newestTexMtimeMs);
  if (status.stale) status.warnings.push("Aux files are older than at least one TeX source; equation numbers may be stale. Recompile to refresh them.");
  status.labels = entries.length;
  return { entries, status };
}

function enrichEquationsWithNumbers(map: PaperMap, entries: EquationNumberInfo[]): void {
  const byLabel = new Map<string, EquationNumberInfo[]>();
  for (const entry of entries) {
    const arr = byLabel.get(entry.label ?? "") ?? [];
    arr.push(entry);
    byLabel.set(entry.label ?? "", arr);
  }
  const all: EquationNumberInfo[] = [];
  for (const e of map.equations) {
    e.labels = e.labels ?? (e.label ? [e.label] : []);
    e.tags = e.tags ?? extractCommandArgs(e.tex, "tag");
    e.numberingNotes = e.numberingNotes ?? [];
    const numbers: EquationNumberInfo[] = [];
    for (const label of e.labels) numbers.push(...(byLabel.get(label) ?? []));
    const seen = new Set(numbers.map(n => normalizeEquationNumber(n.number)));
    for (const tag of e.tags) {
      const norm = normalizeEquationNumber(tag);
      if (!seen.has(norm)) numbers.push({ number: tag, source: "tag" });
      seen.add(norm);
    }
    e.numbers = numbers;
    e.number = numbers[0]?.number;
    if (!e.number && e.labels.length > 0) e.numberingNotes.push("Label(s) found in source but no matching aux number was found; compile may be missing, stale, or failed before this label was written.");
    all.push(...numbers);
  }
  map.equationNumbers = all;
}

function equationNumberSummary(e: EquationInfo): string {
  if (!e.numbers?.length) return "none";
  return e.numbers.map(n => `${n.number}${n.label ? ` (${n.label})` : ""}${n.page ? ` p.${n.page}` : ""}${n.source === "tag" ? " [tag]" : ""}`).join(", ");
}

async function buildPaperMap(cwd: string, rootArg?: string): Promise<PaperMap> {
  const root = await detectRoot(cwd, rootArg);
  const texFiles = await discoverTexClosure(cwd, root);
  const allFiles = await walk(cwd);
  const bibFiles = allFiles.filter(p => p.endsWith(".bib"));
  const map: PaperMap = {
    generatedAt: new Date().toISOString(), cwd, rootTex: root ? path.relative(cwd, root) : undefined,
    texFiles: texFiles.map(p => path.relative(cwd, p)), macros: [], equations: [], labels: [], refs: [], citations: [], bibKeys: [], equationNumbers: [], todos: [], warnings: []
  };
  for (const abs of texFiles) {
    const rel = path.relative(cwd, abs);
    const text = await readText(abs).catch(e => { map.warnings.push(`${rel}: ${e.message}`); return ""; });
    const clean = stripComments(text);
    const lines = text.split(/\r?\n/);
    lines.forEach((l, i) => { if (/TODO|FIXME|NOTE|XXX/.test(l)) map.todos.push({ text: l.trim(), file: rel, line: i + 1 }); });
    for (const m of clean.matchAll(/\\(?:newcommand|renewcommand|def)\s*\\?\{?\\([A-Za-z@]+)\}?\s*(\[[^\]]+\])?/g)) {
      map.macros.push({ name: `\\${m[1]}`, args: m[2], file: rel, line: lineOf(clean, m.index) });
    }
    map.equations.push(...findEquations(rel, text, 6));
    for (const m of clean.matchAll(/\\label\{([^}]+)\}/g)) map.labels.push({ label: m[1], file: rel, line: lineOf(clean, m.index), kind: m[1].split(":")[0] || "label" });
    for (const m of clean.matchAll(/\\(eqref|ref|cref|Cref|autoref)\{([^}]+)\}/g)) {
      for (const r of m[2].split(",").map(s => s.trim())) map.refs.push({ ref: r, file: rel, line: lineOf(clean, m.index), command: m[1] });
    }
    for (const m of clean.matchAll(/\\(?:cite|citet|citep|citealp|parencite|textcite)(?:\[[^\]]*\])*\{([^}]+)\}/g)) {
      for (const k of m[1].split(",").map(s => s.trim()).filter(Boolean)) map.citations.push({ key: k, file: rel, line: lineOf(clean, m.index), command: m[0].match(/^\\([A-Za-z]+)/)?.[1] });
    }
  }
  for (const abs of bibFiles) {
    const rel = path.relative(cwd, abs);
    const text = await readText(abs).catch(() => "");
    for (const m of text.matchAll(/@\w+\s*\{\s*([^,]+),/g)) map.bibKeys.push({ key: m[1].trim(), file: rel, line: lineOf(text, m.index) });
  }
  const aux = await parseAuxTree(cwd, map.rootTex, map.texFiles);
  map.auxStatus = aux.status;
  enrichEquationsWithNumbers(map, aux.entries);
  for (const w of aux.status.warnings) map.warnings.push(w);
  for (const e of map.equations) for (const note of e.numberingNotes) map.warnings.push(`${e.file}:${e.lineStart} ${e.label ?? ""}: ${note}`);
  const labels = new Set(map.labels.map(l => l.label));
  for (const r of map.refs) if (!labels.has(r.ref)) map.warnings.push(`Undefined reference ${r.ref} at ${r.file}:${r.line}`);
  const bibKeys = new Set(map.bibKeys.map(b => b.key));
  for (const c of map.citations) if (!bibKeys.has(c.key)) map.warnings.push(`Undefined citation ${c.key} at ${c.file}:${c.line}`);
  const dupLabels = map.labels.map(l => l.label).filter((x, i, a) => a.indexOf(x) !== i);
  for (const d of unique(dupLabels)) map.warnings.push(`Duplicate label ${d}`);
  return map;
}

async function loadOrBuildMap(ctx: ExtensionContext, root?: string): Promise<PaperMap> {
  const cache = path.join(ctx.cwd, ".mechpi", "paper-map.json");
  if (!root && await exists(cache)) {
    try { return JSON.parse(await readText(cache)) as PaperMap; } catch {}
  }
  return await buildPaperMap(ctx.cwd, root);
}

async function writeMap(cwd: string, map: PaperMap) {
  const dir = path.join(cwd, ".mechpi");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "paper-map.json"), JSON.stringify(map, null, 2));
}

function promptHistoryLimit(): number {
  const n = Number.parseInt(process.env.MECHPI_PROMPT_HISTORY_LIMIT ?? "100", 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
}

function promptHistoryPath(cwd: string): string { return path.join(cwd, ".mechpi", "prompt-history.json"); }

async function loadPromptHistory(cwd: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readText(promptHistoryPath(cwd)));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, promptHistoryLimit()) : [];
  } catch { return []; }
}

async function savePromptHistory(file: string, history: string[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(history.slice(0, promptHistoryLimit()), null, 2));
}

function run(cmd: string, args: string[], cwd: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<{ code: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: false, env: env ? { ...process.env, ...env } : process.env });
    let stdout = "", stderr = "";
    p.stdout.on("data", d => stdout += d.toString());
    p.stderr.on("data", d => stderr += d.toString());
    p.on("error", reject);
    p.on("close", code => resolve({ code, stdout, stderr }));
    signal?.addEventListener("abort", () => p.kill("SIGTERM"));
  });
}

function runWithInput(cmd: string, args: string[], input: string, cwd: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<{ code: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: false, env: env ? { ...process.env, ...env } : process.env });
    let stdout = "", stderr = "";
    p.stdout.on("data", d => stdout += d.toString());
    p.stderr.on("data", d => stderr += d.toString());
    p.on("error", reject);
    p.on("close", code => resolve({ code, stdout, stderr }));
    signal?.addEventListener("abort", () => p.kill("SIGTERM"));
    p.stdin.end(input);
  });
}

type CompileUpdate = (update: { content: { type: "text"; text: string }[]; details: Record<string, unknown> }) => void;

interface LatexCompileSummary {
  ok: boolean;
  code: number | null;
  root: string;
  errors: string[];
  warnings: string[];
  stdoutTail: string;
}

function summarizeLatexOutput(root: string, r: { code: number | null; stdout: string; stderr: string }): LatexCompileSummary {
  const combined = `${r.stdout}\n${r.stderr}`;
  const lines = combined.split(/\r?\n/);
  const errors = lines.filter(l => /^! |LaTeX Error|Package .* Error|^l\.\d+/.test(l)).slice(0, 40);
  const warnings = lines.filter(l => /Warning|undefined references|Citation.*undefined|Label\(s\) may have changed/i.test(l)).slice(0, 60);
  return { ok: r.code === 0, code: r.code, root, errors, warnings, stdoutTail: combined.slice(-8000) };
}

async function runLatexmk(cwd: string, root: string, signal?: AbortSignal, onUpdate?: CompileUpdate, clean?: boolean, nonstop = true): Promise<LatexCompileSummary> {
  if (clean) {
    onUpdate?.({ content: [{ type: "text", text: "Cleaning latexmk artifacts..." }], details: {} });
    await run("latexmk", ["-C", root], cwd, signal);
  }
  const args = ["-pdf", nonstop ? "-interaction=nonstopmode" : "", root].filter(Boolean);
  onUpdate?.({ content: [{ type: "text", text: `Running latexmk ${args.join(" ")}` }], details: {} });
  const r = await run("latexmk", args, cwd, signal);
  return summarizeLatexOutput(root, r);
}

function compileSummaryText(s: LatexCompileSummary): string {
  return `${s.ok ? "Compile OK" : `Compile failed (exit ${s.code})`}\nRoot: ${s.root}\n\nErrors:\n${s.errors.join("\n") || "none"}\n\nWarnings:\n${s.warnings.join("\n") || "none"}`;
}

function numberMapNeedsCompile(map: PaperMap): boolean {
  return !map.auxStatus || !map.auxStatus.found || map.auxStatus.stale;
}

async function loadNumberAwareMap(ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: CompileUpdate, autoCompile = true): Promise<{ map: PaperMap; compile?: LatexCompileSummary }> {
  let map = await buildPaperMap(ctx.cwd);
  let compile: LatexCompileSummary | undefined;
  if (autoCompile && numberMapNeedsCompile(map) && map.rootTex) {
    const reason = !map.auxStatus?.found ? "No aux file found; compiling to build equation-number data..." : "Aux files appear stale; compiling to refresh equation-number data...";
    onUpdate?.({ content: [{ type: "text", text: reason }], details: {} });
    compile = await runLatexmk(ctx.cwd, map.rootTex, signal, onUpdate, false, true);
    if (compile.ok) map = await buildPaperMap(ctx.cwd);
  }
  await writeMap(ctx.cwd, map);
  return { map, compile };
}

function summarizeMap(map: PaperMap): string {
  return [
    `Root: ${map.rootTex ?? "not found"}`,
    `TeX files: ${map.texFiles.length}`,
    `Macros: ${map.macros.length}`,
    `Equations: ${map.equations.length} (${map.equations.filter(e => e.label || e.labels?.length).length} labeled, ${(map.equationNumbers ?? []).length} numbered from aux/tags)`,
    `Aux numbers: ${map.auxStatus?.found ? `${map.auxStatus.labels} labels in ${map.auxStatus.auxFiles.length} aux file(s)${map.auxStatus.stale ? " [stale]" : ""}` : "not available"}`,
    `Labels/refs/cites/bib: ${map.labels.length}/${map.refs.length}/${map.citations.length}/${map.bibKeys.length}`,
    `TODOs: ${map.todos.length}`,
    `Warnings: ${map.warnings.length}`,
  ].join("\n");
}

function indexProblems(tex: string): string[] {
  const problems: string[] = [];
  const chunks = tex.split(/\\\\|=/);
  for (const chunk of chunks) {
    const counts = new Map<string, number>();
    for (const m of chunk.matchAll(/[_^]\{?([ijklmnpqrsαβγa-zA-Z])\}?/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    for (const [idx, n] of counts) if (n > 2) problems.push(`Index ${idx} appears ${n} times in expression chunk: ${chunk.trim().slice(0, 100)}`);
  }
  return problems;
}

function equationOnlyPreview(tex: string): string {
  return tex
    .replace(/\\begin\{[^}]+\}/g, "")
    .replace(/\\end\{[^}]+\}/g, "")
    .replace(/\\label\{[^}]+\}/g, "")
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l.trim().length > 0)
    .join("\n");
}

function texWithOriginalNumbers(e: EquationInfo): string {
  if (!e.numbers?.length || /\\tag\*?\s*\{/.test(e.tex)) return e.tex;
  let tex = e.tex;
  const labelNumbers = e.numbers.filter(n => n.label);
  for (const n of labelNumbers) {
    const labelText = `\\label{${n.label}}`;
    const idx = tex.indexOf(labelText);
    if (idx < 0) continue;
    const rowStart = Math.max(0, tex.lastIndexOf("\\\\", idx));
    const nextBreak = tex.indexOf("\\\\", idx + labelText.length);
    const rowEnd = nextBreak < 0 ? tex.length : nextBreak;
    if (/\\tag\*?\s*\{/.test(tex.slice(rowStart, rowEnd))) continue;
    tex = `${tex.slice(0, idx)}\\tag{${n.number}}${tex.slice(idx)}`;
  }
  if (tex !== e.tex) return tex;
  const n = e.numbers[0];
  const endRe = new RegExp(`\\\\end\\{${escapeRegExp(e.env)}\\}\\s*$`);
  return tex.replace(endRe, `\\tag{${n.number}}\n\\end{${e.env}}`);
}

function printableKey(data: string): string | undefined {
  const key = parseKey(data);
  return key && key.length === 1 ? key : undefined;
}

function stripDocumentClass(preamble: string): string {
  return preamble.replace(/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}\s*/, "");
}

async function rootPreamble(ctx: ExtensionContext): Promise<string> {
  const map = await loadOrBuildMap(ctx);
  const root = map.rootTex ?? "main.tex";
  const rootText = await readText(path.join(ctx.cwd, root));
  const beforeDoc = rootText.split(/\\begin\{document\}/)[0] ?? rootText;
  return stripDocumentClass(beforeDoc);
}

async function adaptiveEquationPreviewDpi(ctx: ExtensionContext, pdfPath: string, targetWidthCells?: number): Promise<number> {
  const forced = Number.parseInt(process.env.MECHPI_EQUATION_PREVIEW_DPI ?? "", 10);
  if (Number.isFinite(forced) && forced > 0) return forced;

  const maxQuality = /^(1|true|yes|on)$/i.test(process.env.MECHPI_PREVIEW_MAX_QUALITY ?? "");
  const fallback = maxQuality ? 4800 : 1200;
  const minDpiDefault = maxQuality ? "2400" : "600";
  const maxDpiDefault = maxQuality ? "9600" : "2400";
  const oversampleDefault = maxQuality ? "8" : "2";
  const minDpi = Number.parseInt(process.env.MECHPI_EQUATION_PREVIEW_MIN_DPI ?? minDpiDefault, 10) || Number.parseInt(minDpiDefault, 10);
  const maxDpi = Number.parseInt(process.env.MECHPI_EQUATION_PREVIEW_MAX_DPI ?? maxDpiDefault, 10) || Number.parseInt(maxDpiDefault, 10);
  const oversampleLimit = maxQuality ? 16 : 4;
  const oversample = Math.max(1, Math.min(oversampleLimit, Number.parseFloat(process.env.MECHPI_EQUATION_PREVIEW_OVERSAMPLE ?? oversampleDefault) || Number.parseFloat(oversampleDefault)));
  const widthCells = Math.max(1, targetWidthCells ?? Math.floor((process.stdout.columns || 100) * 0.9));
  const targetPixels = widthCells * getCellDimensions().widthPx * oversample;

  const info = await run("pdfinfo", [pdfPath], ctx.cwd);
  if (info.code !== 0) return Math.max(minDpi, Math.min(maxDpi, fallback));
  const m = (info.stdout + info.stderr).match(/Page size:\s*([0-9.]+)\s+x\s+([0-9.]+)\s+pts/i);
  const widthPt = m ? Number.parseFloat(m[1]) : NaN;
  if (!Number.isFinite(widthPt) || widthPt <= 0) return Math.max(minDpi, Math.min(maxDpi, fallback));
  const dpi = Math.ceil(targetPixels / (widthPt / 72));
  return Math.max(minDpi, Math.min(maxDpi, dpi));
}

async function bibliographyPreviewConfig(ctx: ExtensionContext): Promise<{ biblatex: boolean; style: string }> {
  const map = await loadOrBuildMap(ctx).catch(() => undefined);
  const root = map?.rootTex ?? "main.tex";
  const rootText = await readText(path.join(ctx.cwd, root)).catch(() => "");
  const beforeDoc = rootText.split(/\\begin\{document\}/)[0] ?? rootText;
  const biblatex = /\\usepackage(?:\[[^\]]*\])?\{[^}]*\bbiblatex\b/.test(beforeDoc) || /\\addbibresource\b/.test(rootText) || /\\printbibliography\b/.test(rootText);
  const style = rootText.match(/\\bibliographystyle\s*\{([^}]+)\}/)?.[1]?.trim() || "plain";
  return { biblatex, style };
}

function stripBibliographyResourceCommands(preamble: string): string {
  return preamble
    .replace(/\\addbibresource(?:\[[^\]]*\])?\{[^}]+\}\s*/g, "")
    .replace(/\\bibliography\s*\{[^}]+\}\s*/g, "")
    .replace(/\\bibliographystyle\s*\{[^}]+\}\s*/g, "");
}

function latexTextEscape(text: string): string {
  const escaped: Record<string, string> = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    "$": "\\$",
    "&": "\\&",
    "#": "\\#",
    "_": "\\_",
    "%": "\\%",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
  };
  return Array.from(normalizeSpace(text)).map(ch => escaped[ch] ?? ch).join("");
}

function firstPreviewErrorLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return normalizeSpace(text.split(/\r?\n/).find(Boolean) ?? text).slice(0, 220);
}

async function renderBibEntryPng(ctx: ExtensionContext, rawBibtex: string, targetWidthCells?: number): Promise<{ base64: string; log?: string }> {
  const parsed = parseBibEntries(rawBibtex, "preview")[0];
  if (!parsed) throw new Error("Preview requires one valid BibTeX entry.");
  const tempRoot = path.join(ctx.cwd, ".mechpi", "citation-render");
  await fs.mkdir(tempRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tempRoot, "cite-"));
  const texPath = path.join(dir, "citation.tex");
  const bibPath = path.join(dir, "citation.bib");
  const pdfPath = path.join(dir, "citation.pdf");
  const pngPrefix = path.join(dir, "citation");
  const pngPath = path.join(dir, "citation.png");
  const preamble = stripBibliographyResourceCommands(await rootPreamble(ctx));
  const cfg = await bibliographyPreviewConfig(ctx);
  const document = cfg.biblatex
    ? `\\documentclass[border=6pt,varwidth=6.5in]{standalone}
${preamble}
\\addbibresource{citation.bib}
\\renewcommand*{\\bibfont}{\\small}
\\begin{document}
\\nocite{${parsed.key}}
\\printbibliography[heading=none]
\\end{document}
`
    : `\\documentclass[border=6pt,varwidth=6.5in]{standalone}
${preamble}
\\renewcommand{\\refname}{}
\\begin{document}
\\small
\\nocite{${parsed.key}}
\\bibliographystyle{${cfg.style}}
\\bibliography{citation}
\\end{document}
`;
  await fs.writeFile(texPath, document, "utf8");
  await fs.writeFile(bibPath, `${rawBibtex.trim()}\n`, "utf8");
  const env = { TEXINPUTS: `${ctx.cwd}//:${process.env.TEXINPUTS ?? ""}`, BSTINPUTS: `${ctx.cwd}//:${process.env.BSTINPUTS ?? ""}`, BIBINPUTS: `${ctx.cwd}//:${process.env.BIBINPUTS ?? ""}` };
  const latex1 = await run("pdflatex", ["-halt-on-error", "-interaction=nonstopmode", "-output-directory", dir, texPath], ctx.cwd, undefined, env);
  if (latex1.code !== 0) throw new Error(`pdflatex failed while rendering citation preview:\n${(latex1.stdout + latex1.stderr).slice(-3000)}`);
  const bibTool = cfg.biblatex ? (commandExists("biber") ? "biber" : "bibtex") : "bibtex";
  const bibArgs = bibTool === "biber" ? ["citation"] : ["citation"];
  const bib = await run(bibTool, bibArgs, dir, undefined, env).catch(err => ({ code: 1, stdout: "", stderr: String(err) }));
  if (cfg.biblatex && bibTool === "biber" && bib.code !== 0) {
    throw new Error(`biber failed while rendering citation preview:\n${(bib.stdout + bib.stderr).slice(-3000)}`);
  }
  if (!cfg.biblatex && bib.code !== 0) throw new Error(`bibtex failed while rendering citation preview:\n${(bib.stdout + bib.stderr).slice(-3000)}`);
  for (let i = 0; i < 2; i++) {
    const latex = await run("pdflatex", ["-halt-on-error", "-interaction=nonstopmode", "-output-directory", dir, texPath], ctx.cwd, undefined, env);
    if (latex.code !== 0) throw new Error(`pdflatex failed after ${bibTool} while rendering citation preview:\n${(latex.stdout + latex.stderr).slice(-3000)}`);
  }
  const previewDpi = await adaptiveEquationPreviewDpi(ctx, pdfPath, targetWidthCells);
  const ppm = await run("pdftoppm", ["-singlefile", "-png", "-r", String(previewDpi), "-aa", "yes", "-aaVector", "yes", pdfPath, pngPrefix], ctx.cwd);
  if (ppm.code !== 0) throw new Error(`pdftoppm failed while rendering citation preview:\n${(ppm.stdout + ppm.stderr).slice(-2000)}`);
  const base64 = (await fs.readFile(pngPath)).toString("base64");
  fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return { base64 };
}

async function renderBibEntryMetadataPng(ctx: ExtensionContext, rawBibtex: string, targetWidthCells?: number): Promise<{ base64: string; log?: string }> {
  const parsed = parseBibEntries(rawBibtex, "preview")[0];
  if (!parsed) throw new Error("Preview requires one valid BibTeX entry.");
  const tempRoot = path.join(ctx.cwd, ".mechpi", "citation-render");
  await fs.mkdir(tempRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tempRoot, "cite-card-"));
  const texPath = path.join(dir, "citation-card.tex");
  const pdfPath = path.join(dir, "citation-card.pdf");
  const pngPrefix = path.join(dir, "citation-card");
  const pngPath = path.join(dir, "citation-card.png");
  const f = parsed.fields;
  const authors = normalizeSpace(f.author ?? "").replace(/\s+and\s+/gi, "; ");
  const venue = f.journal ?? f.booktitle ?? f.publisher ?? f.school ?? f.institution ?? "";
  const details = [parsed.type, f.year, venue].filter(Boolean).join(" -- ");
  const doiUrl = [normalizeDoi(f.doi) ? `doi:${normalizeDoi(f.doi)}` : "", f.url].filter(Boolean).join(" -- ");
  const document = `\\documentclass[border=6pt,varwidth=6.5in]{standalone}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{xcolor}
\\begin{document}
\\begin{minipage}{6.5in}
\\raggedright\\small
{\\color{gray}BibTeX metadata preview for \\texttt{${latexTextEscape(parsed.key)}}}\\par\\medskip
{\\bfseries ${latexTextEscape(f.title ?? parsed.key)}}\\par
${authors ? `${latexTextEscape(authors)}\\par` : ""}
${details ? `\\emph{${latexTextEscape(details)}}\\par` : ""}
${doiUrl ? `{\\footnotesize\\texttt{${latexTextEscape(doiUrl)}}}\\par` : ""}
\\end{minipage}
\\end{document}
`;
  await fs.writeFile(texPath, document, "utf8");
  const latex = await run("pdflatex", ["-halt-on-error", "-interaction=nonstopmode", "-output-directory", dir, texPath], ctx.cwd);
  if (latex.code !== 0) throw new Error(`pdflatex failed while rendering citation metadata card:\n${(latex.stdout + latex.stderr).slice(-3000)}`);
  const previewDpi = await adaptiveEquationPreviewDpi(ctx, pdfPath, targetWidthCells);
  const ppm = await run("pdftoppm", ["-singlefile", "-png", "-r", String(previewDpi), "-aa", "yes", "-aaVector", "yes", pdfPath, pngPrefix], ctx.cwd);
  if (ppm.code !== 0) throw new Error(`pdftoppm failed while rendering citation metadata card:\n${(ppm.stdout + ppm.stderr).slice(-2000)}`);
  const base64 = (await fs.readFile(pngPath)).toString("base64");
  fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return { base64 };
}

async function renderCitationPreviewPng(ctx: ExtensionContext, rawBibtex: string, targetWidthCells?: number): Promise<{ base64: string; note?: string }> {
  try {
    return await renderBibEntryPng(ctx, rawBibtex, targetWidthCells);
  } catch (primary) {
    try {
      const fallback = await renderBibEntryMetadataPng(ctx, rawBibtex, targetWidthCells);
      return { ...fallback, note: `Bibliography-style preview failed; showing metadata card instead. ${firstPreviewErrorLine(primary)}` };
    } catch (secondary) {
      throw new Error(`Bibliography-style preview failed: ${firstPreviewErrorLine(primary)}\nMetadata-card preview also failed: ${firstPreviewErrorLine(secondary)}`);
    }
  }
}

async function renderEquationPng(ctx: ExtensionContext, e: EquationInfo, targetWidthCells?: number): Promise<{ base64: string; log?: string }> {
  const tempRoot = path.join(ctx.cwd, ".mechpi", "equation-render");
  await fs.mkdir(tempRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tempRoot, "eq-"));
  const texPath = path.join(dir, "equation.tex");
  const pdfPath = path.join(dir, "equation.pdf");
  const pngPrefix = path.join(dir, "equation");
  const pngPath = path.join(dir, "equation.png");
  const preamble = await rootPreamble(ctx);
  const amsmath = /\\usepackage(?:\[[^\]]*\])?\{[^}]*\bamsmath\b/.test(preamble) ? "" : "\\usepackage{amsmath}\n";
  const previewTex = texWithOriginalNumbers(e);
  const document = `\\documentclass[border=6pt,varwidth]{standalone}
${amsmath}${preamble}
\\pagestyle{empty}
\\begin{document}
${previewTex}
\\end{document}
`;
  await fs.writeFile(texPath, document, "utf8");
  const env = { TEXINPUTS: `${ctx.cwd}//:${process.env.TEXINPUTS ?? ""}` };
  const latex = await run("pdflatex", ["-halt-on-error", "-interaction=nonstopmode", "-output-directory", dir, texPath], ctx.cwd, undefined, env);
  if (latex.code !== 0) throw new Error(`pdflatex failed while rendering equation:\n${(latex.stdout + latex.stderr).slice(-3000)}`);
  const previewDpi = await adaptiveEquationPreviewDpi(ctx, pdfPath, targetWidthCells);
  const ppm = await run("pdftoppm", ["-singlefile", "-png", "-r", String(previewDpi), "-aa", "yes", "-aaVector", "yes", pdfPath, pngPrefix], ctx.cwd);
  if (ppm.code !== 0) throw new Error(`pdftoppm failed while rendering equation:\n${(ppm.stdout + ppm.stderr).slice(-2000)}`);
  const base64 = (await fs.readFile(pngPath)).toString("base64");
  fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return { base64 };
}

function latexAutocompleteProvider(items: AutocompleteItem[]): AutocompleteProvider {
  function prefixAt(lines: string[], cursorLine: number, cursorCol: number): string | null {
    const line = lines[cursorLine] ?? "";
    const before = line.slice(0, cursorCol);
    const m = before.match(/\\[A-Za-z@]*$/);
    return m?.[0] ?? null;
  }
  return {
    async getSuggestions(lines, cursorLine, cursorCol) {
      const prefix = prefixAt(lines, cursorLine, cursorCol);
      if (prefix === null) return null;
      const q = prefix.toLowerCase();
      const matches = items
        .filter(item => item.value.toLowerCase().startsWith(q))
        .slice(0, 80);
      return matches.length ? { items: matches, prefix } : null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const next = [...lines];
      const line = next[cursorLine] ?? "";
      const start = cursorCol - prefix.length;
      next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
      return { lines: next, cursorLine, cursorCol: start + item.value.length };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return prefixAt(lines, cursorLine, cursorCol) !== null;
    },
  };
}

async function latexCompletionItems(ctx: ExtensionContext): Promise<AutocompleteItem[]> {
  const common = [
    "\\alpha", "\\beta", "\\gamma", "\\delta", "\\epsilon", "\\varepsilon", "\\theta", "\\lambda", "\\mu", "\\nu", "\\xi", "\\pi", "\\rho", "\\sigma", "\\tau", "\\phi", "\\varphi", "\\psi", "\\omega",
    "\\Gamma", "\\Delta", "\\Theta", "\\Lambda", "\\Pi", "\\Sigma", "\\Phi", "\\Psi", "\\Omega",
    "\\frac{}{}", "\\partial", "\\nabla", "\\cdot", "\\times", "\\otimes", "\\oplus", "\\leq", "\\geq", "\\neq", "\\approx", "\\equiv", "\\infty",
    "\\left", "\\right", "\\begin{}", "\\end{}", "\\label{}", "\\eqref{}", "\\mathrm{}", "\\mathbf{}", "\\mathcal{}", "\\bar{}", "\\hat{}", "\\tilde{}",
  ];
  const map = await loadOrBuildMap(ctx).catch(() => undefined);
  const macroItems = (map?.macros ?? []).map(m => ({
    value: m.name,
    label: m.name,
    description: `${m.file}:${m.line}${m.args ? ` ${m.args}` : ""}`,
  }));
  const seen = new Set<string>();
  return [
    ...macroItems,
    ...common.map(value => ({ value, label: value, description: "LaTeX" })),
  ].filter(item => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

async function saveEquationEdit(ctx: ExtensionContext, e: EquationInfo, newTex: string): Promise<string> {
  const abs = path.join(ctx.cwd, e.file);
  const source = await readText(abs);
  const first = source.indexOf(e.tex);
  if (first < 0) throw new Error(`Could not find the original equation block in ${e.file}; run mech_ingest and try again.`);
  if (source.indexOf(e.tex, first + e.tex.length) >= 0) throw new Error(`Equation source is not unique in ${e.file}; refusing automatic replacement.`);
  await fs.writeFile(abs, source.slice(0, first) + newTex + source.slice(first + e.tex.length));
  const map = await buildPaperMap(ctx.cwd);
  await writeMap(ctx.cwd, map);
  return `${e.file}:${e.lineStart}-${e.lineEnd}`;
}

async function openEquationEditor(ctx: ExtensionContext, e: EquationInfo): Promise<string | null> {
  const title = `Edit ${e.label ?? "unlabeled equation"} (${e.file}:${e.lineStart}-${e.lineEnd})`;
  if (!ctx.hasUI) return null;
  let rendered: { base64: string } | null = null;
  let renderError: string | null = null;
  try { rendered = await renderEquationPng(ctx, e, Math.floor((process.stdout.columns || 100) * 0.9)); }
  catch (err) { renderError = err instanceof Error ? err.message : String(err); }

  const completions = await latexCompletionItems(ctx);
  suppressAssistantLatexPreviewImages++;
  process.stdout.write(deleteAllKittyImages());
  try {
    return await openUniformPopupEditor(ctx, {
      title,
      initialText: e.tex,
      autocompleteProvider: latexAutocompleteProvider(completions),
      help: "Same edit keys as the prompt. Ctrl+R refreshes preview; :w writes+refreshes; :wq/Ctrl+S saves and closes; Ctrl+C/:q cancels.",
      renderPreview: (width: number) => {
        const lines: string[] = [];
        lines.push(truncateToWidth(`Typeset LaTeX preview: ${e.label ?? "(unlabeled)"}`, width));
        if (rendered) {
          const previewWidth = scaledLatexPreviewWidth(width, 4);
          lines.push(...new AspectRatioLatexImage(rendered.base64, previewWidth, { fallbackColor: (s: string) => s }).render(width));
        } else {
          lines.push(`Could not render a typeset preview; falling back to source.`);
          lines.push((renderError ?? "unknown render error").slice(0, 1200));
        }
        return lines;
      },
      onRefresh: async (text, setStatus) => {
        setStatus("Rendering preview...");
        try {
          rendered = await renderEquationPng(ctx, { ...e, tex: text }, scaledLatexPreviewWidth(process.stdout.columns || 100, 4));
          renderError = null;
          setStatus("Preview refreshed. Ctrl+S or :wq saves to source; :w writes and stays open.");
        } catch (err) {
          rendered = null;
          renderError = err instanceof Error ? err.message : String(err);
          setStatus("Preview render failed; fix LaTeX and Ctrl+R again.");
        }
      },
      onWrite: async (text, setStatus) => {
        setStatus("Writing equation and refreshing preview...");
        const where = await saveEquationEdit(ctx, e, text);
        e.tex = text;
        try {
          rendered = await renderEquationPng(ctx, { ...e, tex: text }, scaledLatexPreviewWidth(process.stdout.columns || 100, 4));
          renderError = null;
          setStatus(`Wrote ${where}; preview refreshed.`);
        } catch (err) {
          rendered = null;
          renderError = err instanceof Error ? err.message : String(err);
          setStatus(`Wrote ${where}; preview render failed.`);
        }
      },
    });
  } finally {
    suppressAssistantLatexPreviewImages = Math.max(0, suppressAssistantLatexPreviewImages - 1);
    process.stdout.write(deleteAllKittyImages());
  }
}

type MathSegment = { kind: "text" | "math"; text: string; display?: boolean; rawText?: string };

const latexPreviewCache = new Map<string, { base64?: string; error?: string }>();
let assistantLatexPreviewInstalled = false;
let latexPreviewCwd = process.cwd();
let suppressAssistantLatexPreviewImages = 0;

function terminalLooksLight(): boolean {
  const forced = process.env.MECHPI_LATEX_PREVIEW_FG?.toLowerCase();
  if (forced === "black" || forced === "dark") return true;
  if (forced === "white" || forced === "light") return false;
  const colorfgbg = process.env.COLORFGBG ?? "";
  const bg = colorfgbg.split(";").map(s => Number.parseInt(s, 10)).filter(Number.isFinite).at(-1);
  if (bg === undefined) return false;
  if (bg >= 232) return bg >= 244;
  return bg === 7 || bg === 15 || (bg >= 10 && bg <= 14);
}

function latexPreviewColor(): "black" | "white" {
  return terminalLooksLight() ? "black" : "white";
}

function splitMarkdownIntoLatexSegments(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let i = 0;
  let textStart = 0;
  let inFence = false;
  let inInlineCode = false;
  const pushText = (end: number) => { if (end > textStart) segments.push({ kind: "text", text: text.slice(textStart, end) }); };
  while (i < text.length) {
    if (text.startsWith("```", i)) { inFence = !inFence; i += 3; continue; }
    if (!inFence && text[i] === "`") { inInlineCode = !inInlineCode; i++; continue; }
    if (inFence || inInlineCode) { i++; continue; }
    const candidates: Array<{ start: string; end: string; display: boolean }> = [
      { start: "\\[", end: "\\]", display: true },
      { start: "\\(", end: "\\)", display: false },
      { start: "$$", end: "$$", display: true },
      { start: "$", end: "$", display: false },
    ];
    const env = text.slice(i).match(/^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}/);
    if (env) {
      const endToken = `\\end{${env[1]}}`;
      const end = text.indexOf(endToken, i + env[0].length);
      if (end >= 0) {
        pushText(i);
        const rawText = text.slice(i, end + endToken.length);
        segments.push({ kind: "math", text: rawText, rawText, display: true });
        i = end + endToken.length;
        textStart = i;
        continue;
      }
    }
    const c = candidates.find(c => text.startsWith(c.start, i));
    if (!c) { i++; continue; }
    if (c.start === "$" && (text.startsWith("$$", i) || /\d/.test(text[i + 1] ?? ""))) { i++; continue; }
    const end = text.indexOf(c.end, i + c.start.length);
    if (end < 0) { i++; continue; }
    if (c.start === "$" && /\d/.test(text[end + 1] ?? "")) { i++; continue; }
    pushText(i);
    const rawText = text.slice(i, end + c.end.length);
    segments.push({ kind: "math", text: text.slice(i + c.start.length, end), rawText, display: c.display });
    i = end + c.end.length;
    textStart = i;
  }
  pushText(text.length);
  return segments;
}

function isEquationLikeLatex(tex: string): boolean {
  const t = tex.trim();
  if (!t) return false;
  if (/^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}/.test(t)) return true;
  return /(?:=|\\leq|\\geq|\\neq|\\approx|\\sim|\\propto|\\to|\\rightarrow|\\leftarrow|\\frac|\\dfrac|\\tfrac|\\partial|\\nabla|\\sum|\\int|\\prod|\\begin\{(?:matrix|pmatrix|bmatrix|cases|aligned|split)\})/.test(t);
}

function shouldRenderLatexSegment(segment: MathSegment): boolean {
  if (segment.kind !== "math") return false;
  if (segment.display) return true;
  return isEquationLikeLatex(segment.text);
}

function stableKittyImageId(key: string): number {
  // Kitty image placements survive normal terminal line clearing.  Use a stable
  // per-snippet ID and delete it immediately before redrawing so streaming
  // assistant updates do not leave old equation previews smeared over text.
  const n = Number.parseInt(createHash("sha1").update(key).digest("hex").slice(0, 8), 16);
  return (n % 0xfffffffe) + 1;
}

const latexPreviewKittyImageIds = new Set<number>();
const latexPreviewImagePayloads = new Map<number, { source: string; base64: string }>();
const LATEX_PREVIEW_SCALE = Math.max(0.25, Math.min(1.5, Number.parseFloat(process.env.MECHPI_LATEX_PREVIEW_SCALE ?? "1.0") || 1.0));

function scaledLatexPreviewWidth(width: number, reservedCells = 2): number {
  const available = Math.max(1, width - reservedCells);
  return Math.max(1, Math.floor(available * LATEX_PREVIEW_SCALE));
}

function renderAspectRatioPng(base64: string, width: number, fallbackColor: (s: string) => string, imageId?: number): string[] {
  const dimensions = getImageDimensions(base64, "image/png");
  if (!dimensions) return [fallbackColor(imageFallback("image/png"))];
  const result = renderImage(base64, dimensions, { maxWidthCells: width, imageId, moveCursor: false });
  if (!result) return [fallbackColor(imageFallback("image/png", dimensions))];
  if (getCapabilities().images === "kitty") return [result.sequence, ...Array.from({ length: Math.max(0, result.rows - 1) }, () => "")];
  const rowOffset = result.rows - 1;
  return [...Array.from({ length: Math.max(0, rowOffset) }, () => ""), `${rowOffset > 0 ? `\x1b[${rowOffset}A` : ""}${result.sequence}`];
}

class AspectRatioLatexImage {
  constructor(
    private readonly base64: string,
    private readonly maxWidthCells: number,
    private readonly theme: { fallbackColor: (s: string) => string },
    private readonly imageId?: number,
  ) {}
  invalidate(): void {}
  getImageId(): number | undefined { return this.imageId; }
  render(width: number): string[] {
    return renderAspectRatioPng(this.base64, Math.min(Math.max(1, width - 2), this.maxWidthCells), this.theme.fallbackColor, this.imageId);
  }
}

function extractKittyImageId(line: string): number | undefined {
  const m = line.match(/\x1b_G[^;]*\bi=(\d+)/);
  return m ? Number.parseInt(m[1], 10) : undefined;
}

class CleanupLatexKittyImages {
  constructor(private readonly imageIds: number[]) {}
  invalidate(): void {}
  render(_width: number): string[] {
    if (getCapabilities().images !== "kitty" || this.imageIds.length === 0) return [];
    return [this.imageIds.map(id => deleteKittyImage(id)).join("")];
  }
}

class RedrawSafeLatexImage {
  private readonly imageId: number;
  constructor(private readonly base64: string, imageIdKey: string, private readonly maxWidthCells: number, maxHeightCells?: number, sourceText?: string) {
    this.imageId = stableKittyImageId(imageIdKey);
    latexPreviewKittyImageIds.add(this.imageId);
    if (sourceText) latexPreviewImagePayloads.set(this.imageId, { source: sourceText, base64 });
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (suppressAssistantLatexPreviewImages > 0) return [deleteKittyImage(this.imageId)];
    const lines = renderAspectRatioPng(this.base64, scaledLatexPreviewWidth(Math.min(width, this.maxWidthCells + 2)), (s: string) => s, this.imageId);
    if (getCapabilities().images === "kitty") {
      // Replace any previous placement with this ID before drawing the current
      // placement.  This avoids stale graphics when the assistant streams and
      // the message layout changes.
      lines[0] = deleteKittyImage(this.imageId) + (lines[0] ?? "");
    }
    return lines;
  }
}

function isTerminalImageProtocolLine(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

function opaquePopupLine(line: string, width: number, theme: any): string {
  if (isTerminalImageProtocolLine(line)) return line;
  const bg = typeof theme.getBgAnsi === "function" ? theme.getBgAnsi("customMessageBg") : "";
  if (!bg) return truncateToWidth(line, width, "", true);
  let body = visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
  // Re-apply the popup background after inner style resets.  Terminals do not
  // support true 90% alpha, so use a solid theme popup background over the full
  // overlay width to prevent distracting chat bleed-through.
  body = body.replace(/\x1b\[0m/g, `\x1b[0m${bg}`);
  const pad = Math.max(0, width - visibleWidth(body));
  return `${bg}${body}${" ".repeat(pad)}\x1b[0m`;
}

class OpaquePopupComponent implements Focusable {
  constructor(private readonly inner: any, private readonly theme: any) {}
  get focused(): boolean { return !!this.inner.focused; }
  set focused(v: boolean) { if ("focused" in this.inner) this.inner.focused = v; }
  invalidate(): void { this.inner.invalidate?.(); }
  dispose(): void { this.inner.dispose?.(); }
  render(width: number): string[] { return (this.inner.render(width) as string[]).map(line => opaquePopupLine(line, width, this.theme)); }
  handleInput(data: string): void { this.inner.handleInput?.(data); }
}

function opaquePopup<T>(component: T, theme: any): T {
  return new OpaquePopupComponent(component, theme) as T;
}

class AnsiLatexImage {
  constructor(private readonly fallbackText = "[LaTeX preview unavailable: terminal image protocol not available]") {}
  invalidate(): void {}
  render(_width: number): string[] { return this.fallbackText.split(/\r?\n/); }
}

function useTerminalLatexImages(): boolean {
  const forced = process.env.MECHPI_LATEX_PREVIEW_IMAGES?.toLowerCase();
  if (forced === "1" || forced === "true" || forced === "kitty") return true;
  if (forced === "0" || forced === "false" || forced === "ansi") return false;
  // Native terminal images are the only readable rendered-PNG path.  In tmux,
  // Kitty passthrough images may not scroll in copy-mode because tmux treats
  // them as opaque terminal escape sequences, but rasterizing to Unicode is not
  // readable enough for equations.
  return !!getCapabilities().images;
}

function latexPreviewComponent(base64: string, imageIdKey: string, maxWidthCells: number, fallbackText?: string, sourceText?: string) {
  return useTerminalLatexImages()
    ? new RedrawSafeLatexImage(base64, imageIdKey, maxWidthCells, undefined, sourceText)
    : new AnsiLatexImage(fallbackText);
}

function renderInlineLatexPngSync(tex: string, display: boolean, fg: "black" | "white", cwd: string): { base64?: string; error?: string } {
  const maxQuality = /^(1|true|yes|on)$/i.test(process.env.MECHPI_PREVIEW_MAX_QUALITY ?? "");
  const dpi = process.env.MECHPI_LATEX_PREVIEW_DPI ?? (maxQuality ? "2400" : "900");
  const key = createHash("sha1").update(`${fg}\0${display}\0${dpi}\0${tex}`).digest("hex");
  const cached = latexPreviewCache.get(key);
  if (cached) return cached;
  const baseDir = path.join(cwd, ".mechpi", "inline-latex-render");
  const dir = path.join(baseDir, key);
  try {
    fss.mkdirSync(dir, { recursive: true });
    const texPath = path.join(dir, "snippet.tex");
    const body = /^\\begin\{/.test(tex.trim()) ? tex.trim() : display ? `\\[${tex}\\]` : `$${tex}$`;
    const doc = `\\documentclass{article}
\\usepackage[active,tightpage]{preview}
\\usepackage{amsmath,amssymb,mathtools,bm,xcolor}
\\pagestyle{empty}
\\begin{document}
\\begin{preview}
{\\color{${fg}}${body}}
\\end{preview}
\\end{document}
`;
    fss.writeFileSync(texPath, doc, "utf8");
    const latex = spawnSync("latex", ["-halt-on-error", "-interaction=nonstopmode", "-output-directory", dir, texPath], { cwd, encoding: "utf8", timeout: 10000 });
    if (latex.status !== 0) throw new Error((latex.stdout + latex.stderr).slice(-1200));
    const dvi = path.join(dir, "snippet.dvi");
    const png = path.join(dir, "snippet.png");
    const dvipng = spawnSync("dvipng", ["-T", "tight", "-D", dpi, "-bg", "Transparent", "-fg", fg === "white" ? "rgb 1.0 1.0 1.0" : "rgb 0.0 0.0 0.0", "-o", png, dvi], { cwd, encoding: "utf8", timeout: 10000 });
    if (dvipng.status !== 0) throw new Error((dvipng.stdout + dvipng.stderr).slice(-1200));
    const result = { base64: fss.readFileSync(png).toString("base64") };
    latexPreviewCache.set(key, result);
    return result;
  } catch (err) {
    const result = { error: err instanceof Error ? err.message : String(err) };
    latexPreviewCache.set(key, result);
    return result;
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function installAssistantLatexPreviewRenderer() {
  if (assistantLatexPreviewInstalled) return;
  assistantLatexPreviewInstalled = true;
  const original = AssistantMessageComponent.prototype.updateContent;
  AssistantMessageComponent.prototype.updateContent = function patchedUpdateContent(message: any): void {
    const self = this as any;
    const hasRenderableMath = message?.content?.some((c: any) => c.type === "text" && splitMarkdownIntoLatexSegments(c.text).some(s => s.kind === "math" && shouldRenderLatexSegment(s)));
    if (!hasRenderableMath) {
      const staleLatexImageIds = Array.from(latexPreviewKittyImageIds);
      latexPreviewKittyImageIds.clear();
      const result = original.call(this, message);
      if (staleLatexImageIds.length) self.contentContainer.addChild(new CleanupLatexKittyImages(staleLatexImageIds));
      return result;
    }
    const staleLatexImageIds = Array.from(latexPreviewKittyImageIds);
    latexPreviewKittyImageIds.clear();
    self.lastMessage = message;
    self.contentContainer.clear();
    if (staleLatexImageIds.length) self.contentContainer.addChild(new CleanupLatexKittyImages(staleLatexImageIds));
    self.contentContainer.addChild(new Spacer(1));
    const mdTheme = getMarkdownTheme();
    const fg = latexPreviewColor();
    let latexImageOrdinal = 0;
    for (const content of message.content) {
      if (content.type !== "text" || !content.text.trim()) continue;
      let markdownBuffer = "";
      const flushMarkdown = () => {
        if (!markdownBuffer.trim()) { markdownBuffer = ""; return; }
        self.contentContainer.addChild(new Markdown(markdownBuffer.trim(), 1, 0, mdTheme));
        markdownBuffer = "";
      };
      for (const segment of splitMarkdownIntoLatexSegments(content.text.trim())) {
        if (segment.kind === "text") {
          markdownBuffer += segment.text;
        } else if (segment.kind === "math") {
          if (!shouldRenderLatexSegment(segment)) {
            markdownBuffer += segment.rawText ?? segment.text;
            continue;
          }
          flushMarkdown();
          const renderAsDisplay = segment.display || isEquationLikeLatex(segment.text);
          const rendered = renderInlineLatexPngSync(segment.text, renderAsDisplay, fg, latexPreviewCwd);
          if (rendered.base64) {
            latexImageOrdinal += 1;
            self.contentContainer.addChild(latexPreviewComponent(
              rendered.base64,
              `${fg}\0${renderAsDisplay}\0${latexImageOrdinal}\0${segment.rawText ?? segment.text}`,
              renderAsDisplay ? 100 : 70,
              segment.rawText ?? segment.text,
              segment.rawText ?? segment.text,
            ));
          } else {
            self.contentContainer.addChild(new Text(segment.rawText ?? segment.text, 1, 0));
          }
        }
      }
      flushMarkdown();
    }
    self.hasToolCalls = message.content.some((c: any) => c.type === "toolCall");
  };
}

type PromptMode = "insert" | "normal" | "visual" | "visualLine" | "command";

type PromptYank = { text: string; lineWise: boolean };

function stripTerminalEscapes(text: string): string {
  return text
    .replace(/\x1b_G[\s\S]*?(?:\x1b\\|\x07)/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x1b\\|\x07)/g, "")
    .replace(/\x1b_[\s\S]*?\x07/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()#][0-9A-Za-z]/g, "");
}

function visibleSlicePlain(line: string, startCol: number, width: number): string {
  let col = 0;
  let out = "";
  for (const ch of Array.from(line)) {
    const w = Math.max(0, visibleWidth(ch));
    if (col + w <= startCol) { col += w; continue; }
    if (visibleWidth(out) + w > width) break;
    out += ch;
    col += w;
  }
  return out;
}

function copyImagePngToSystemClipboard(base64: string): boolean {
  const png = Buffer.from(base64, "base64");
  for (const [cmd, args] of [["wl-copy", ["--type", "image/png"]], ["xclip", ["-selection", "clipboard", "-t", "image/png"]]] as [string, string[]][]) {
    const r = spawnSync(cmd, args, { input: png, stdio: ["pipe", "ignore", "ignore"] });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

function copyTextToSystemClipboard(text: string): boolean {
  for (const [cmd, args] of [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["-ib"]]] as [string, string[]][]) {
    const r = spawnSync(cmd, args, { input: text, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

function readTextFromSystemClipboard(): string | null {
  for (const [cmd, args] of [["wl-paste", ["--no-newline"]], ["xclip", ["-selection", "clipboard", "-out"]], ["xsel", ["-ob"]]] as [string, string[]][]) {
    const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (!r.error && r.status === 0 && r.stdout) return r.stdout;
  }
  return null;
}

function splitCtrlAPrefix(data: string): string | null {
  if (data === "\x01" || matchesKey(data, Key.ctrl("a"))) return "";
  return data.startsWith("\x01") ? data.slice(1) : null;
}

function prefixKeyChar(data: string): string | undefined {
  if (data === "\x1d" || matchesKey(data, "ctrl+]")) return "]";
  if (data === "\x1b" || matchesKey(data, Key.escape)) return "[";
  return printableKey(data) ?? data[0];
}

function isPromptBackspaceInput(data: string): boolean {
  return matchesKey(data, Key.backspace)
    || matchesKey(data, "shift+backspace")
    || data.includes("\x7f")
    || data.includes("\x08")
    || /^\x1b\[127(?:;\d+)*u$/.test(data);
}

type ScreenCopyLine = { text: string; imageSource?: string; imageBase64?: string };

function centeredImageLabel(width: number): string {
  const label = "[latex_image.png]";
  const left = Math.max(0, Math.floor((width - visibleWidth(label)) / 2));
  return `${" ".repeat(left)}${label}`;
}

function centerImageLabelsOnce(lines: ScreenCopyLine[], width: number): ScreenCopyLine[] {
  const out = lines.map(line => ({ ...line }));
  let i = 0;
  while (i < out.length) {
    const source = out[i].imageSource;
    const base64 = out[i].imageBase64;
    if (!source || !base64) { i++; continue; }
    let j = i + 1;
    while (j < out.length && out[j].imageSource === source && out[j].imageBase64 === base64) j++;
    for (let k = i; k < j; k++) {
      if (!out[k].text.trim()) out[k].text = "";
    }
    const middle = i + Math.floor((j - i) / 2);
    if (!out[middle].text.trim()) out[middle].text = centeredImageLabel(width);
    i = j;
  }
  return out;
}

class PromptScreenCopyOverlay implements Focusable {
  private cursorLine: number;
  private cursorCol = 0;
  private topLine: number;
  private colOffset = 0;
  private lastWidth = 80;
  private visualAnchor: { line: number; col: number } | null = null;
  private pendingPrefix = false;
  private pendingY = false;
  private pendingG = false;
  private visualMode: "char" | "line" | null = null;
  private yankBuffer: string | null = null;
  private _focused = false;
  private handle: { hide(): void } | null = null;
  private status = "COPY";

  constructor(
    private readonly tui: TUI,
    private readonly lines: ScreenCopyLine[],
    private readonly pasteToPrompt: (text: string) => void,
    private readonly yankToPrompt: (text: string) => void,
    private readonly returnToPrompt: () => void,
  ) {
    this.cursorLine = Math.max(0, lines.length - 1);
    this.cursorCol = 0;
    const bodyHeight = Math.max(1, tui.terminal.rows - 1);
    this.topLine = Math.max(0, this.cursorLine - bodyHeight + 1);
    this.clampCursor();
  }

  get focused() { return this._focused; }
  set focused(v: boolean) { this._focused = v; }
  setHandle(handle: { hide(): void }): void { this.handle = handle; }
  invalidate(): void {}

  handleInput(data: string): void {
    const prefixed = splitCtrlAPrefix(data);
    if (prefixed !== null) {
      if (prefixed.length === 0) { this.pendingPrefix = true; this.status = "PREFIX"; return; }
      this.pendingPrefix = false;
      const ch = prefixKeyChar(prefixed);
      if (ch === "[") { this.close(); return; }
      if (ch === "]") return;
      return;
    }
    if (this.pendingPrefix) {
      this.pendingPrefix = false;
      const ch = prefixKeyChar(data);
      if (ch === "[") { this.close(); return; }
      if (ch === "]") return;
    }

    const ch = printableKey(data);
    if (matchesKey(data, Key.escape) || ch === "q") { this.close(); return; }
    if (this.pendingY) {
      this.pendingY = false;
      if (ch === "y") this.copyCurrentLine();
      return;
    }
    if (this.pendingG) {
      if (ch === "g") this.moveBufferStart();
      else if (ch === "e") this.moveWordEndBackward();
      this.pendingG = false;
      return;
    }

    if (ch === "v") { this.toggleVisual("char"); return; }
    if (ch === "V") { this.toggleVisual("line"); return; }
    if (ch === "y") { if (this.visualAnchor) this.copySelection(); else { this.pendingY = true; this.status = "COPY"; } return; }
    if (ch === "Y") { if (this.visualAnchor && this.visualMode === "line") this.copySelectedImage(); else this.copyCurrentLine(); return; }
    if (ch === "p" || ch === "P") { this.pasteClipboardToPrompt(); return; }

    if (ch === "j" || matchesKey(data, Key.down)) { this.moveLine(1); return; }
    if (ch === "k" || matchesKey(data, Key.up)) { this.moveLine(-1); return; }
    if (ch === "h" || matchesKey(data, Key.left)) { this.moveCol(-1); return; }
    if (ch === "l" || matchesKey(data, Key.right)) { this.moveCol(1); return; }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) { this.moveLine(-Math.max(1, this.tui.terminal.rows - 2)); return; }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) { this.moveLine(Math.max(1, this.tui.terminal.rows - 2)); return; }
    if (ch === "w") { this.moveWordStartForward(); return; }
    if (ch === "e") { this.moveWordEndForward(); return; }
    if (ch === "b") { this.moveWordStartBackward(); return; }
    if (ch === "g") { this.pendingG = true; this.status = "COPY"; return; }
    if (ch === "G") { this.moveBufferEnd(); return; }
    if (ch === "0" || matchesKey(data, Key.home)) { this.cursorCol = 0; this.ensureVisible(); return; }
    if (ch === "^") { this.moveFirstNonBlank(); return; }
    if (ch === "$" || matchesKey(data, Key.end)) { this.cursorCol = Math.max(0, this.lineLength(this.cursorLine) - 1); this.ensureVisible(); return; }
  }

  render(width: number): string[] {
    this.lastWidth = Math.max(1, width);
    const height = Math.max(1, this.tui.terminal.rows);
    const bodyHeight = Math.max(1, height - 1);
    this.ensureVisible();
    const out: string[] = [];
    for (let row = 0; row < bodyHeight; row++) {
      const lineIndex = this.topLine + row;
      out.push(lineIndex < this.lines.length ? this.renderScreenLine(lineIndex, width) : "");
    }
    const status = `${this.status}  ${Math.min(this.cursorLine + 1, this.lines.length)}/${this.lines.length}`;
    out.push(`\x1b[7m${truncateToWidth(status, width, "", true)}\x1b[27m`);
    return out;
  }

  private close(): void { this.handle?.hide(); this.returnToPrompt(); }
  private lineText(lineNo: number): string {
    return this.lines[lineNo]?.text ?? "";
  }
  private lineChars(lineNo: number): string[] { return Array.from(this.lineText(lineNo)); }
  private lineLength(lineNo: number): number { return this.lineChars(lineNo).length; }
  private clampCursor(): void {
    this.cursorLine = Math.max(0, Math.min(this.lines.length - 1, this.cursorLine));
    const maxCol = Math.max(0, this.lineLength(this.cursorLine) - 1);
    this.cursorCol = Math.max(0, Math.min(maxCol, this.cursorCol));
  }
  private moveLine(delta: number): void { this.cursorLine += delta; this.clampCursor(); this.ensureVisible(); }
  private moveCol(delta: number): void { this.cursorCol += delta; this.clampCursor(); this.ensureVisible(); }
  private moveBufferStart(): void { this.cursorLine = 0; this.cursorCol = 0; this.ensureVisible(); }
  private moveBufferEnd(): void { this.cursorLine = Math.max(0, this.lines.length - 1); this.cursorCol = Math.max(0, this.lineLength(this.cursorLine) - 1); this.ensureVisible(); }
  private moveFirstNonBlank(): void {
    const chars = this.lineChars(this.cursorLine);
    const idx = chars.findIndex(ch => /\S/.test(ch));
    this.cursorCol = idx >= 0 ? idx : 0;
    this.ensureVisible();
  }
  private textFlat(): string { return this.lines.map((_l, i) => this.lineText(i)).join("\n"); }
  private setFlatIndex(index: number): void {
    let rest = Math.max(0, Math.min(index, this.textFlat().length));
    for (let line = 0; line < this.lines.length; line++) {
      const len = this.lineLength(line);
      if (rest <= len) { this.cursorLine = line; this.cursorCol = Math.max(0, Math.min(rest, Math.max(0, len - 1))); this.ensureVisible(); return; }
      rest -= len + 1;
    }
    this.moveBufferEnd();
  }
  private isWordChar(ch: string | undefined): boolean { return !!ch && /[A-Za-z0-9_\\]/.test(ch); }
  private moveWordStartForward(): void {
    const text = this.textFlat();
    let i = Math.min(this.flatIndex({ line: this.cursorLine, col: this.cursorCol }) + 1, text.length);
    while (i < text.length && this.isWordChar(text[i])) i++;
    while (i < text.length && !this.isWordChar(text[i])) i++;
    this.setFlatIndex(i);
  }
  private moveWordEndForward(): void {
    const text = this.textFlat();
    let i = Math.min(this.flatIndex({ line: this.cursorLine, col: this.cursorCol }) + 1, text.length);
    while (i < text.length && !this.isWordChar(text[i])) i++;
    while (i + 1 < text.length && this.isWordChar(text[i + 1])) i++;
    this.setFlatIndex(i);
  }
  private moveWordStartBackward(): void {
    const text = this.textFlat();
    let i = Math.max(0, this.flatIndex({ line: this.cursorLine, col: this.cursorCol }) - 1);
    while (i > 0 && !this.isWordChar(text[i])) i--;
    while (i > 0 && this.isWordChar(text[i - 1])) i--;
    this.setFlatIndex(i);
  }
  private moveWordEndBackward(): void {
    const text = this.textFlat();
    let i = Math.max(0, this.flatIndex({ line: this.cursorLine, col: this.cursorCol }) - 1);
    while (i > 0 && !this.isWordChar(text[i])) i--;
    while (i > 0 && this.isWordChar(text[i - 1])) i--;
    while (i + 1 < text.length && this.isWordChar(text[i + 1])) i++;
    this.setFlatIndex(i);
  }
  private ensureVisible(): void {
    const bodyHeight = Math.max(1, this.tui.terminal.rows - 1);
    if (this.cursorLine < this.topLine) this.topLine = this.cursorLine;
    if (this.cursorLine >= this.topLine + bodyHeight) this.topLine = this.cursorLine - bodyHeight + 1;
    this.topLine = Math.max(0, Math.min(this.topLine, Math.max(0, this.lines.length - bodyHeight)));
    if (this.cursorCol < this.colOffset) this.colOffset = this.cursorCol;
    if (this.cursorCol >= this.colOffset + this.lastWidth) this.colOffset = Math.max(0, this.cursorCol - this.lastWidth + 1);
  }
  private toggleVisual(mode: "char" | "line"): void {
    if (this.visualAnchor && this.visualMode === mode) { this.visualAnchor = null; this.visualMode = null; this.status = "COPY"; return; }
    this.visualAnchor = { line: this.cursorLine, col: mode === "line" ? 0 : this.cursorCol };
    this.visualMode = mode;
    if (mode === "line") this.cursorCol = Math.max(0, this.lineLength(this.cursorLine) - 1);
    this.status = mode === "line" ? "VISUAL LINE" : "VISUAL";
  }
  private flatIndex(pos: { line: number; col: number }): number {
    let index = 0;
    for (let i = 0; i < pos.line; i++) index += this.lineLength(i) + 1;
    return index + pos.col;
  }
  private selectionRange(): { start: number; end: number } | null {
    if (!this.visualAnchor) return null;
    if (this.visualMode === "line") {
      const startLine = Math.min(this.visualAnchor.line, this.cursorLine);
      const endLine = Math.max(this.visualAnchor.line, this.cursorLine);
      return { start: this.flatIndex({ line: startLine, col: 0 }), end: this.flatIndex({ line: endLine, col: Math.max(0, this.lineLength(endLine) - 1) }) };
    }
    const a = this.flatIndex(this.visualAnchor);
    const b = this.flatIndex({ line: this.cursorLine, col: this.cursorCol });
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }
  private positionIndex(lineNo: number, col: number): number {
    let index = 0;
    for (let i = 0; i < lineNo; i++) index += this.lineLength(i) + 1;
    return index + col;
  }
  private isSelectedChar(lineNo: number, col: number): boolean {
    const range = this.selectionRange();
    if (!range) return false;
    const idx = this.positionIndex(lineNo, col);
    return idx >= range.start && idx <= range.end;
  }
  private renderScreenLine(lineNo: number, width: number): string {
    const chars = this.lineChars(lineNo);
    if (chars.length === 0) {
      return lineNo === this.cursorLine ? "\x1b[7m \x1b[27m" : "";
    }
    let out = "";
    let visible = 0;
    for (let col = this.colOffset; col < chars.length; col++) {
      const ch = chars[col] ?? "";
      const w = Math.max(1, visibleWidth(ch));
      if (visible + w > width) break;
      const highlight = this.isSelectedChar(lineNo, col) || (!this.visualAnchor && lineNo === this.cursorLine && col === this.cursorCol);
      out += highlight ? `\x1b[7m${ch}\x1b[27m` : ch;
      visible += w;
    }
    return out;
  }
  private selectedLineRange(): { startLine: number; endLine: number } {
    if (!this.visualAnchor) return { startLine: this.cursorLine, endLine: this.cursorLine };
    return { startLine: Math.min(this.visualAnchor.line, this.cursorLine), endLine: Math.max(this.visualAnchor.line, this.cursorLine) };
  }
  private selectedImagePayloads(): Array<{ source: string; base64: string }> {
    const { startLine, endLine } = this.selectedLineRange();
    const out: Array<{ source: string; base64: string }> = [];
    for (let lineNo = startLine; lineNo <= endLine; lineNo++) {
      const line = this.lines[lineNo];
      if (line?.imageSource && line.imageBase64) out.push({ source: line.imageSource, base64: line.imageBase64 });
    }
    return out;
  }
  private selectedText(): string {
    if (!this.visualAnchor) return `${this.lineText(this.cursorLine)}\n`;
    if (this.visualMode === "line") {
      const images = this.selectedImagePayloads();
      if (images.length) return images.map(i => i.source).join("\n");
    }
    const startLine = Math.min(this.visualAnchor.line, this.cursorLine);
    const endLine = Math.max(this.visualAnchor.line, this.cursorLine);
    const startCol = this.visualAnchor.line <= this.cursorLine ? this.visualAnchor.col : this.cursorCol;
    const endCol = this.visualAnchor.line <= this.cursorLine ? this.cursorCol : this.visualAnchor.col;
    const chunks: string[] = [];
    for (let lineNo = startLine; lineNo <= endLine; lineNo++) {
      const chars = this.lineChars(lineNo);
      if (this.visualMode === "line") chunks.push(chars.join(""));
      else if (lineNo === startLine && lineNo === endLine) chunks.push(chars.slice(Math.min(startCol, endCol), Math.max(startCol, endCol) + 1).join(""));
      else if (lineNo === startLine) chunks.push(chars.slice(startCol).join(""));
      else if (lineNo === endLine) chunks.push(chars.slice(0, endCol + 1).join(""));
      else chunks.push(chars.join(""));
    }
    return chunks.join("\n");
  }
  private rememberYank(text: string): void {
    this.yankBuffer = text;
    this.yankToPrompt(text);
    copyTextToSystemClipboard(text);
    this.close();
  }
  private copyCurrentLine(): void { this.rememberYank(`${this.lineText(this.cursorLine)}\n`); this.status = "COPY"; }
  private copySelection(): void { this.rememberYank(this.selectedText()); this.visualAnchor = null; this.visualMode = null; this.status = "COPY"; }
  private copySelectedImage(): void {
    const image = this.selectedImagePayloads()[0];
    if (!image) { this.copySelection(); return; }
    this.yankBuffer = image.source;
    this.yankToPrompt(image.source);
    copyImagePngToSystemClipboard(image.base64);
    this.visualAnchor = null;
    this.visualMode = null;
    this.status = "COPY";
    this.close();
  }
  private pasteClipboardToPrompt(): void {
    const text = this.yankBuffer ?? readTextFromSystemClipboard();
    if (!text) { this.status = "COPY"; return; }
    this.pasteToPrompt(text);
    this.close();
  }
}

abstract class MechPiModalTextEditor extends CustomEditor {
  wantsKeyRelease = true;
  protected mode: PromptMode = "insert";
  protected pendingPrefix = false;
  protected pendingOperator: "d" | "y" | "c" | null = null;
  protected pendingOperatorCount = 1;
  protected pendingG = false;
  protected pendingGCount = 1;
  protected visualAnchor: number | null = null;
  protected yankBuffer: PromptYank | null = null;
  protected status = "INSERT";
  protected commandBuffer = "";
  protected commandPrefix: ":" | "/" | "?" = ":";
  protected pendingCount = "";
  protected pendingFind: { command: "f" | "F" | "t" | "T"; count: number } | null = null;
  protected pendingReplace: { count: number; visual: boolean } | null = null;
  protected pendingTextObject: { op: "d" | "y" | "c"; around: boolean; count: number } | null = null;
  protected lastFind: { command: "f" | "F" | "t" | "T"; char: string; count: number } | null = null;
  protected lastSearch: { pattern: string; backward: boolean } | null = null;
  private lastModalBackspaceAt = 0;

  constructor(tui: TUI, theme: any, keybindings: any) {
    super(tui, mechPiEditorTheme(theme), keybindings);
  }

  protected handleModalInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (this.tryHandleCtrlAPrefixInput(data)) return;
    if (this.mode === "command") this.handleCommandMode(data);
    else if (this.mode === "insert") this.handleInsertMode(data);
    else if (this.mode === "visual" || this.mode === "visualLine") this.handleVisualMode(data);
    else this.handleNormalMode(data);
    this.tui.requestRender();
  }

  render(width: number): string[] { return this.renderEditorFrame(width); }

  protected renderEditorFrame(width: number): string[] {
    const lines = this.mode === "visual" || this.mode === "visualLine" ? this.renderVisualEditor(width) : super.render(width);
    return this.withPromptModeLine(lines, width);
  }

  protected withPromptModeLine(lines: string[], width: number): string[] {
    if (lines.length === 0) return lines;
    lines[lines.length - 1] = this.promptModeLine(width);
    return lines;
  }

  protected promptModeLine(width: number): string {
    const modeName = this.modeName();
    const label = ` ${modeName} `;
    const command = this.mode === "command" ? `${this.commandPrefix}${this.commandBuffer}` : "";
    const commandText = command ? truncateToWidth(command, Math.max(0, width - visibleWidth(label) - 1), "") : "";
    const filler = "─".repeat(Math.max(0, width - visibleWidth(commandText) - visibleWidth(label)));
    const raw = `${commandText}${filler}${label}`;
    const color = (this as any).borderColor ?? ((x: string) => x);
    return color(truncateToWidth(raw, width, ""));
  }

  protected modeName(): string { return this.mode === "visualLine" ? "VISUAL LINE" : this.mode.toUpperCase(); }

  protected tryHandleCtrlAPrefixInput(data: string): boolean {
    const prefixed = splitCtrlAPrefix(data);
    if (prefixed !== null) {
      if (prefixed.length === 0) {
        this.pendingPrefix = true;
        this.status = "PREFIX";
        this.tui.requestRender();
        return true;
      }
      this.pendingPrefix = false;
      const ch = prefixKeyChar(prefixed);
      if (ch === "]") { this.enterScreenCopyMode(); this.tui.requestRender(); return true; }
      if (ch === "[") { this.enterInsert(); this.tui.requestRender(); return true; }
      return this.handleUnknownPrefix(prefixed);
    }
    if (this.pendingPrefix) {
      this.pendingPrefix = false;
      const ch = prefixKeyChar(data);
      if (ch === "]") { this.enterScreenCopyMode(); this.tui.requestRender(); return true; }
      if (ch === "[") { this.enterInsert(); this.tui.requestRender(); return true; }
      return this.handleUnknownPrefix(data);
    }
    return false;
  }

  protected handleUnknownPrefix(data: string): boolean {
    super.handleInput("\x01");
    super.handleInput(data);
    this.tui.requestRender();
    return true;
  }

  protected enterScreenCopyMode(): void {
    const width = Math.max(1, this.tui.terminal.columns);
    const renderedLines = this.tui.render(width);
    let activeImagePayload: { source: string; base64: string } | undefined;
    const snapshot = centerImageLabelsOnce(renderedLines
      .map(line => {
        const imageId = extractKittyImageId(line);
        const payload = imageId === undefined ? undefined : latexPreviewImagePayloads.get(imageId);
        const text = stripTerminalEscapes(line);
        if (payload) activeImagePayload = payload;
        else if (text.trim().length > 0) activeImagePayload = undefined;
        return { text, imageSource: activeImagePayload?.source, imageBase64: activeImagePayload?.base64 };
      })
      .filter((line, index, lines) => line.text.trim().length > 0 || line.imageSource || index > lines.length - this.tui.terminal.rows - 2), width);
    const overlay = new PromptScreenCopyOverlay(this.tui, snapshot.length ? snapshot : [{ text: "" }], text => {
      this.insertTextAtCursor(text);
      this.enterNormal("NORMAL");
    }, text => {
      this.yankBuffer = { text, lineWise: text.endsWith("\n") };
      this.enterNormal("NORMAL");
    }, () => {
      this.enterNormal("NORMAL");
    });
    const handle = this.tui.showOverlay(overlay, { width: "100%", maxHeight: "100%", anchor: "top-left" });
    overlay.setHandle(handle);
  }

  protected handleInsertMode(data: string): void {
    if (this.isAutocompleteOpen()) {
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.enter)) { super.handleInput(data); return; }
    }
    if (matchesKey(data, Key.escape)) { this.enterNormal(); return; }
    if (isPromptBackspaceInput(data)) { this.handleBackspaceInput(); return; }
    if (matchesKey(data, Key.enter) || matchesKey(data, "shift+enter") || matchesKey(data, "shift+return")) { this.insertTextAtCursor("\n"); return; }
    super.handleInput(data);
  }

  protected handleBackspaceInput(): void {
    const now = Date.now();
    if (now - this.lastModalBackspaceAt < 150) return;
    this.lastModalBackspaceAt = now;
    const s = this.editorState();
    this.snapshot();
    if (s.cursorCol > 0) {
      const line = s.lines[s.cursorLine] ?? "";
      const before = Array.from(line.slice(0, s.cursorCol));
      const removed = before.pop();
      if (removed === undefined) return;
      const nextBefore = before.join("");
      s.lines[s.cursorLine] = nextBefore + line.slice(s.cursorCol);
      s.cursorCol = nextBefore.length;
      this.changed();
      return;
    }
    if (s.cursorLine > 0) {
      const current = s.lines[s.cursorLine] ?? "";
      const previous = s.lines[s.cursorLine - 1] ?? "";
      s.lines[s.cursorLine - 1] = previous + current;
      s.lines.splice(s.cursorLine, 1);
      s.cursorLine--;
      s.cursorCol = previous.length;
      this.changed();
    }
  }

  protected enterCommandMode(prefix: ":" | "/" | "?" = ":"): void {
    this.mode = "command";
    this.commandPrefix = prefix;
    this.commandBuffer = "";
    this.pendingOperator = null;
    this.pendingCount = "";
    this.status = "COMMAND";
  }

  protected handleCommandMode(data: string): void {
    const ch = printableKey(data);
    if (matchesKey(data, Key.escape)) { this.enterNormal("NORMAL"); return; }
    if (isPromptBackspaceInput(data)) { this.commandBuffer = this.commandBuffer.slice(0, -1); return; }
    if (matchesKey(data, Key.enter)) { void this.executeCommandBuffer(); return; }
    if (matchesKey(data, Key.space)) { this.commandBuffer += " "; return; }
    if (ch && ch.length === 1) this.commandBuffer += ch;
  }

  protected async executeCommandBuffer(): Promise<void> {
    const prefix = this.commandPrefix;
    const command = this.commandBuffer;
    this.enterNormal("NORMAL");
    if (prefix === "/" || prefix === "?") {
      if (command) this.searchText(command, prefix === "?", 1);
      return;
    }
    await this.executeColonCommand(command.trim());
    this.tui.requestRender(true);
  }

  protected async executeColonCommand(command: string): Promise<void> {
    if (!command) return;
    if (command === "q" || command === "q!") { this.status = "Use Ctrl+C to cancel this editor"; return; }
    if (command === "w") { this.status = "No file writer for this editor"; return; }
    if (command === "wq" || command === "x") { this.status = "Use Ctrl+S to save this editor"; return; }
    if (this.trySubstituteCommand(command)) return;
    this.status = `Not an editor command: ${command}`;
  }

  protected keyText(data: string): string | undefined {
    if (matchesKey(data, Key.space)) return " ";
    return printableKey(data);
  }

  protected trySubstituteCommand(command: string): boolean {
    const m = command.match(/^(%?s)(.)(.*)$/);
    if (!m) return false;
    const wholeFile = m[1] === "%s";
    const delim = m[2];
    let rest = m[3] ?? "";
    const parts: string[] = [];
    let buf = "";
    let escaped = false;
    for (const c of rest) {
      if (escaped) { buf += c; escaped = false; continue; }
      if (c === "\\") { buf += c; escaped = true; continue; }
      if (c === delim && parts.length < 2) { parts.push(buf); buf = ""; continue; }
      buf += c;
    }
    parts.push(buf);
    if (parts.length < 3) { this.status = "Bad substitute command"; return true; }
    const [findRaw, replaceRaw, flagsRaw] = parts;
    try {
      const flags = flagsRaw.includes("g") ? "g" : "";
      const re = new RegExp(findRaw, flags);
      const s = this.editorState();
      this.snapshot();
      if (wholeFile) {
        const before = this.getText();
        this.setTextPreserveCursor(before.replace(re, replaceRaw), this.flatIndex());
      } else {
        s.lines[s.cursorLine] = String(s.lines[s.cursorLine] ?? "").replace(re, replaceRaw);
        this.changed();
      }
      this.status = "Substitution complete";
    } catch (err) {
      this.status = err instanceof Error ? err.message : String(err);
    }
    return true;
  }

  protected handleNormalMode(data: string): void {
    const ch = printableKey(data);
    const keyText = this.keyText(data);
    if (this.pendingReplace && keyText !== undefined) { const replace = this.pendingReplace; this.pendingReplace = null; replace.visual ? this.replaceVisualChars(keyText) : this.replaceChars(keyText, replace.count); return; }
    if (this.pendingTextObject && ch) { const obj = this.pendingTextObject; this.pendingTextObject = null; this.applyTextObject(obj.op, obj.around, ch, obj.count); return; }
    if (this.pendingFind && ch) { const find = this.pendingFind; this.pendingFind = null; this.findChar(find.command, ch, find.count); return; }
    if (ch && /^[1-9]$/.test(ch)) { this.pendingCount += ch; this.status = `NORMAL -- ${this.pendingCount}`; return; }
    if (ch === "0" && this.pendingCount) { this.pendingCount += ch; this.status = `NORMAL -- ${this.pendingCount}`; return; }
    const count = this.consumeCount();
    if (this.handleNormalCommand(data, ch)) return;
    if (this.pendingG) {
      const gCount = this.pendingGCount;
      if (this.pendingOperator) {
        if (ch === "g") this.applyOperatorToTarget(gCount === 1 ? 0 : this.lineStartIndex(gCount - 1));
        else if (ch === "e") this.applyOperatorMotion("b", gCount);
        else if (ch === "E") this.applyOperatorMotion("B", gCount);
        this.pendingG = false;
        this.pendingGCount = 1;
        return;
      }
      if (ch === "g") gCount === 1 ? this.moveBufferStart() : this.moveToLine(gCount - 1);
      else if (ch === "e") this.repeat(gCount, () => this.moveWordEndBackward());
      else if (ch === "E") this.repeat(gCount, () => this.moveWORDSEndBackward());
      else if (ch === "_") { this.moveLine(gCount - 1); this.moveFirstNonBlank(); }
      this.pendingG = false;
      this.pendingGCount = 1;
      return;
    }
    if (matchesKey(data, Key.escape)) { this.pendingOperator = null; this.pendingOperatorCount = 1; this.pendingReplace = null; this.pendingTextObject = null; this.status = "NORMAL"; return; }
    if (ch === ":") { this.enterCommandMode(":"); return; }
    if (ch === "/") { this.enterCommandMode("/"); return; }
    if (ch === "?") { this.enterCommandMode("?"); return; }
    if (ch === "i") { this.enterInsert(); return; }
    if (ch === "a") { this.moveCol(1); this.enterInsert(); return; }
    if (ch === "A") { this.moveLineEnd(); this.enterInsert(); return; }
    if (ch === "I") { this.moveFirstNonBlank(); this.enterInsert(); return; }
    if (ch === "o") { this.moveLineEnd(); this.insertTextAtCursor("\n"); this.enterInsert(); return; }
    if (ch === "O") { this.moveLineStart(); this.insertTextAtCursor("\n"); this.moveLine(-1); this.enterInsert(); return; }
    if (ch === "J") { this.joinLines(); return; }
    if (ch === "v") { this.mode = "visual"; this.visualAnchor = this.flatIndex(); this.status = "VISUAL"; return; }
    if (ch === "V") { this.mode = "visualLine"; this.visualAnchor = this.lineStartIndex(this.editorState().cursorLine); this.moveLineEnd(); this.status = "VISUAL LINE"; return; }
    if (ch === "h" || matchesKey(data, Key.left)) { this.moveCol(-count); return; }
    if (ch === "l" || matchesKey(data, Key.right)) { this.moveCol(count); return; }
    if (ch === "j" || matchesKey(data, Key.down)) { this.moveLine(count); return; }
    if (ch === "k" || matchesKey(data, Key.up)) { this.moveLine(-count); return; }
    if (this.pendingOperator && (ch === "i" || ch === "a")) { this.pendingTextObject = { op: this.pendingOperator, around: ch === "a", count: this.pendingOperatorCount * count }; this.pendingOperator = null; this.pendingOperatorCount = 1; this.status = `NORMAL -- ${this.pendingTextObject.op}${ch}`; return; }
    if (this.pendingOperator && ch === "g") { this.pendingG = true; this.pendingGCount = count; this.status = "NORMAL -- g"; return; }
    if (this.pendingOperator && ch === "G") { this.applyOperatorToTarget(count === 1 ? this.getText().length : this.lineStartIndex(count - 1)); return; }
    if (this.pendingOperator && (ch === "j" || ch === "k")) { this.applyOperatorLineMotion(ch === "j" ? count : -count); return; }
    if (this.pendingOperator && (ch === "w" || ch === "e" || ch === "b" || ch === "$" || ch === "W" || ch === "E" || ch === "B" || ch === "h" || ch === "l" || ch === "0" || ch === "^")) { this.applyOperatorMotion(ch as any, count); return; }
    if (ch === "w") { this.repeat(count, () => this.moveWordStartForward()); return; }
    if (ch === "e") { this.repeat(count, () => this.moveWordEndForward()); return; }
    if (ch === "b") { this.repeat(count, () => this.moveWordStartBackward()); return; }
    if (ch === "W") { this.repeat(count, () => this.moveWORDSStartForward()); return; }
    if (ch === "E") { this.repeat(count, () => this.moveWORDSEndForward()); return; }
    if (ch === "B") { this.repeat(count, () => this.moveWORDSStartBackward()); return; }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) { this.moveLine(-count * Math.max(1, this.tui.terminal.rows - 2)); return; }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) { this.moveLine(count * Math.max(1, this.tui.terminal.rows - 2)); return; }
    if (matchesKey(data, Key.ctrl("u"))) { this.moveLine(-count * Math.max(1, Math.floor(this.tui.terminal.rows / 2))); return; }
    if (matchesKey(data, Key.ctrl("d"))) { this.moveLine(count * Math.max(1, Math.floor(this.tui.terminal.rows / 2))); return; }
    if (ch === "g") { this.pendingG = true; this.pendingGCount = count; this.status = "NORMAL -- g"; return; }
    if (ch === "G") { count === 1 ? this.moveBufferEnd() : this.moveToLine(count - 1); return; }
    if (ch === "H") { this.moveToLine(0); return; }
    if (ch === "M") { this.moveToLine(Math.floor((this.editorState().lines.length - 1) / 2)); return; }
    if (ch === "L") { this.moveBufferEnd(); return; }
    if (ch === "0") { this.moveLineStart(); return; }
    if (ch === "|") { this.editorState().cursorCol = Math.max(0, count - 1); this.clampCursor(); return; }
    if (ch === "^") { this.moveFirstNonBlank(); return; }
    if (ch === "_") { this.moveLine(count - 1); this.moveFirstNonBlank(); return; }
    if (ch === "$") { this.moveLine(count - 1); this.moveLineEnd(); return; }
    if (ch === "%") { this.moveMatchingBracket(); return; }
    if (ch === "{") { this.repeat(count, () => this.moveParagraph(-1)); return; }
    if (ch === "}") { this.repeat(count, () => this.moveParagraph(1)); return; }
    if (ch === "(") { this.repeat(count, () => this.moveSentence(-1)); return; }
    if (ch === ")") { this.repeat(count, () => this.moveSentence(1)); return; }
    if (ch === "+") { this.moveLine(count); this.moveFirstNonBlank(); return; }
    if (ch === "-") { this.moveLine(-count); this.moveFirstNonBlank(); return; }
    if (matchesKey(data, Key.enter)) { this.moveLine(count); this.moveFirstNonBlank(); return; }
    if (ch === "n") { this.repeat(count, () => this.repeatSearch(false)); return; }
    if (ch === "N") { this.repeat(count, () => this.repeatSearch(true)); return; }
    if (ch === "f" || ch === "F" || ch === "t" || ch === "T") { this.pendingFind = { command: ch, count }; this.status = `NORMAL -- ${ch}`; return; }
    if (ch === ";") { this.repeatLastFind(false, count); return; }
    if (ch === ",") { this.repeatLastFind(true, count); return; }
    if (ch === "u") { (this as any).undo?.(); return; }
    if (ch === "r") { this.pendingReplace = { count, visual: false }; this.status = "NORMAL -- r"; return; }
    if (ch === "x") { this.repeat(count, () => this.deleteChar()); return; }
    if (ch === "X") { this.repeat(count, () => this.deleteCharBefore()); return; }
    if (ch === "D") { this.vimDeleteToEndOfLine(); return; }
    if (ch === "C") { this.vimDeleteToEndOfLine(); this.enterInsert(); return; }
    if (ch === "S") { this.changeLine(); return; }
    if (ch === "p") { this.repeat(count, () => this.pasteAfter()); return; }
    if (ch === "P") { this.repeat(count, () => this.pasteBefore()); return; }
    if (ch === "y") { if (this.pendingOperator === "y") { this.repeat(this.pendingOperatorCount * count, () => this.yankLine()); this.pendingOperator = null; this.pendingOperatorCount = 1; return; } this.pendingOperator = "y"; this.pendingOperatorCount = count; this.status = "NORMAL -- y"; return; }
    if (ch === "d") { if (this.pendingOperator === "d") { this.repeat(this.pendingOperatorCount * count, () => this.deleteLine()); this.pendingOperator = null; this.pendingOperatorCount = 1; return; } this.pendingOperator = "d"; this.pendingOperatorCount = count; this.status = "NORMAL -- d"; return; }
    if (ch === "c") { if (this.pendingOperator === "c") { this.repeat(this.pendingOperatorCount * count, () => this.changeLine()); this.pendingOperator = null; this.pendingOperatorCount = 1; return; } this.pendingOperator = "c"; this.pendingOperatorCount = count; this.status = "NORMAL -- c"; return; }
    this.pendingOperator = null;
    if (data.length === 1 && data.charCodeAt(0) >= 32) return;
    super.handleInput(data);
  }

  protected handleNormalCommand(_data: string, _ch: string | undefined): boolean { return false; }

  protected handleVisualMode(data: string): void {
    const ch = printableKey(data);
    const keyText = this.keyText(data);
    if (this.pendingReplace && keyText !== undefined) { const replace = this.pendingReplace; this.pendingReplace = null; replace.visual ? this.replaceVisualChars(keyText) : this.replaceChars(keyText, replace.count); return; }
    if (this.pendingG) { if (ch === "g") this.moveBufferStart(); else if (ch === "e") this.moveWordEndBackward(); this.pendingG = false; return; }
    if (matchesKey(data, Key.escape) || ch === "v") { this.enterNormal("NORMAL"); return; }
    if (ch === "V") { if (this.mode === "visualLine") this.enterNormal("NORMAL"); else { this.mode = "visualLine"; this.visualAnchor = this.lineStartIndex(this.editorState().cursorLine); this.moveLineEnd(); this.status = "VISUAL LINE"; } return; }
    if (ch === "h" || matchesKey(data, Key.left)) { this.moveCol(-1); return; }
    if (ch === "l" || matchesKey(data, Key.right)) { this.moveCol(1); return; }
    if (ch === "j" || matchesKey(data, Key.down)) { this.moveLine(1); return; }
    if (ch === "k" || matchesKey(data, Key.up)) { this.moveLine(-1); return; }
    if (ch === "w") { this.moveWordStartForward(); return; }
    if (ch === "e") { this.moveWordEndForward(); return; }
    if (ch === "b") { this.moveWordStartBackward(); return; }
    if (ch === "g") { this.pendingG = true; return; }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) { this.moveLine(-Math.max(1, this.tui.terminal.rows - 2)); return; }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) { this.moveLine(Math.max(1, this.tui.terminal.rows - 2)); return; }
    if (ch === "y") { this.yankVisual(); this.enterNormal("Yanked selection"); return; }
    if (ch === "r") { this.pendingReplace = { count: 1, visual: true }; this.status = "VISUAL -- r"; return; }
    if (ch === "d" || ch === "x") { this.deleteVisual(false); return; }
    if (ch === "c" || ch === "s") { this.deleteVisual(true); return; }
    if (ch === "p" || ch === "P") { this.replaceVisualWithYank(); return; }
    if (ch === "0") { this.moveLineStart(); return; }
    if (ch === "^") { this.moveFirstNonBlank(); return; }
    if (ch === "$") { this.moveLineEnd(); return; }
  }

  protected consumeCount(): number { const n = Number.parseInt(this.pendingCount || "1", 10); this.pendingCount = ""; return Number.isFinite(n) && n > 0 ? n : 1; }
  protected repeat(count: number, fn: () => void): void { for (let i = 0; i < Math.max(1, count); i++) fn(); }
  protected moveToLine(lineNo: number): void { const s = this.editorState(); s.cursorLine = Math.max(0, Math.min(lineNo, s.lines.length - 1)); this.clampCursor(); }
  protected isWORDChar(ch: string | undefined): boolean { return !!ch && !/\s/.test(ch); }
  protected nextByPredicate(from: number, pred: (ch: string | undefined) => boolean): number { const text = this.getText(); let i = Math.min(from + 1, text.length); while (i < text.length && pred(text[i])) i++; while (i < text.length && !pred(text[i])) i++; return i; }
  protected endByPredicate(from: number, pred: (ch: string | undefined) => boolean): number { const text = this.getText(); let i = Math.min(from + 1, text.length); while (i < text.length && !pred(text[i])) i++; while (i + 1 < text.length && pred(text[i + 1])) i++; return i; }
  protected backByPredicate(from: number, pred: (ch: string | undefined) => boolean): number { const text = this.getText(); let i = Math.max(0, from - 1); while (i > 0 && !pred(text[i])) i--; while (i > 0 && pred(text[i - 1])) i--; return i; }
  protected moveWORDSStartForward(): void { this.setFlatIndex(this.nextByPredicate(this.flatIndex(), ch => this.isWORDChar(ch))); }
  protected moveWORDSEndForward(): void { this.setFlatIndex(this.endByPredicate(this.flatIndex(), ch => this.isWORDChar(ch))); }
  protected moveWORDSStartBackward(): void { this.setFlatIndex(this.backByPredicate(this.flatIndex(), ch => this.isWORDChar(ch))); }
  protected moveWORDSEndBackward(): void { const text = this.getText(); let i = Math.max(0, this.flatIndex() - 1); while (i > 0 && !this.isWORDChar(text[i])) i--; while (i > 0 && this.isWORDChar(text[i - 1])) i--; while (i + 1 < text.length && this.isWORDChar(text[i + 1])) i++; this.setFlatIndex(i); }
  protected moveParagraph(direction: 1 | -1): void {
    const s = this.editorState();
    let line = s.cursorLine + direction;
    while (line > 0 && line < s.lines.length - 1 && String(s.lines[line] ?? "").trim() !== "") line += direction;
    this.moveToLine(line);
    this.moveFirstNonBlank();
  }
  protected moveSentence(direction: 1 | -1): void {
    const text = this.getText();
    const current = this.flatIndex();
    if (direction > 0) {
      const m = /[.!?][\])'"`]*\s+/g;
      m.lastIndex = Math.min(text.length, current + 1);
      const hit = m.exec(text);
      this.setFlatIndex(hit ? hit.index + hit[0].length : text.length);
    } else {
      const before = text.slice(0, Math.max(0, current - 1));
      let idx = 0;
      for (const hit of before.matchAll(/[.!?][\])'"`]*\s+/g)) idx = (hit.index ?? 0) + hit[0].length;
      this.setFlatIndex(idx);
    }
  }
  protected moveMatchingBracket(): void {
    const text = this.getText();
    const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", ")": "(", "]": "[", "}": "{" };
    const opens = new Set(["(", "[", "{"]);
    let start = this.flatIndex();
    if (!pairs[text[start]]) {
      const line = this.editorState().lines[this.editorState().cursorLine] ?? "";
      const lineStart = this.lineStartIndex(this.editorState().cursorLine);
      const found = Array.from(String(line)).findIndex((c, i) => i >= this.editorState().cursorCol && !!pairs[c]);
      if (found < 0) return;
      start = lineStart + found;
    }
    const ch = text[start];
    const target = pairs[ch];
    const dir = opens.has(ch) ? 1 : -1;
    let depth = 0;
    for (let i = start; i >= 0 && i < text.length; i += dir) {
      if (text[i] === ch) depth++;
      else if (text[i] === target) {
        depth--;
        if (depth === 0) { this.setFlatIndex(i); return; }
      }
    }
  }
  protected findChar(command: "f" | "F" | "t" | "T", char: string, count: number): void {
    this.lastFind = { command, char, count };
    const s = this.editorState();
    const line = s.lines[s.cursorLine] ?? "";
    let idx = s.cursorCol;
    const forward = command === "f" || command === "t";
    for (let n = 0; n < count; n++) {
      idx = forward ? line.indexOf(char, idx + 1) : line.lastIndexOf(char, idx - 1);
      if (idx < 0) return;
    }
    s.cursorCol = Math.max(0, Math.min(line.length, command === "t" ? idx - 1 : command === "T" ? idx + 1 : idx));
    this.clampCursor();
  }
  protected repeatLastFind(reverse: boolean, count: number): void {
    if (!this.lastFind) return;
    const map: Record<"f" | "F" | "t" | "T", "f" | "F" | "t" | "T"> = reverse ? { f: "F", F: "f", t: "T", T: "t" } : { f: "f", F: "F", t: "t", T: "T" };
    this.findChar(map[this.lastFind.command], this.lastFind.char, count);
  }
  protected searchText(pattern: string, backward: boolean, count: number): void {
    this.lastSearch = { pattern, backward };
    const text = this.getText();
    const current = this.flatIndex();
    try {
      const re = new RegExp(pattern, "g");
      let matches = Array.from(text.matchAll(re)).map(m => m.index ?? 0).filter(i => backward ? i < current : i > current);
      if (!matches.length) matches = Array.from(text.matchAll(re)).map(m => m.index ?? 0);
      if (!matches.length) { this.status = "Pattern not found"; return; }
      const idx = backward ? matches[Math.max(0, matches.length - count)] : matches[Math.min(matches.length - 1, count - 1)];
      this.setFlatIndex(idx);
    } catch (err) { this.status = err instanceof Error ? err.message : String(err); }
  }
  protected repeatSearch(reverse: boolean): void { if (this.lastSearch) this.searchText(this.lastSearch.pattern, reverse ? !this.lastSearch.backward : this.lastSearch.backward, 1); }

  protected replaceChars(char: string, count: number): void {
    if (char.length === 0 || char === "\n" || char === "\r") return;
    const s = this.editorState();
    const line = String(s.lines[s.cursorLine] ?? "");
    if (s.cursorCol >= line.length) return;
    const n = Math.min(Math.max(1, count), line.length - s.cursorCol);
    this.snapshot();
    s.lines[s.cursorLine] = line.slice(0, s.cursorCol) + char.repeat(n) + line.slice(s.cursorCol + n);
    this.changed();
    this.enterNormal("NORMAL");
  }

  protected replaceVisualChars(char: string): void {
    if (char.length === 0 || char === "\n" || char === "\r") return;
    const range = this.selectionRange();
    if (!range) return;
    const text = this.getText();
    this.snapshot();
    const replaced = text.slice(range.start, range.end).replace(/[^\n]/g, char);
    this.visualAnchor = null;
    this.mode = "normal";
    this.setTextPreserveCursor(text.slice(0, range.start) + replaced + text.slice(range.end), range.start);
    this.status = "NORMAL";
  }

  protected applyTextObject(op: "d" | "y" | "c", around: boolean, key: string, count: number): void {
    const range = this.textObjectRange(key, around, count);
    if (!range) { this.status = `No text object: ${around ? "a" : "i"}${key}`; return; }
    if (op === "y") { this.yankToClipboard(this.getText().slice(range.start, range.end)); this.status = "Yanked text object"; return; }
    this.deleteRange(range.start, range.end, op === "c");
  }

  protected textObjectRange(key: string, around: boolean, count: number): { start: number; end: number } | null {
    if (key === "w" || key === "W") return this.wordTextObjectRange(key === "W", around, count);
    const pairs: Record<string, [string, string]> = { "(": ["(", ")"], ")": ["(", ")"], "b": ["(", ")"], "[": ["[", "]"], "]": ["[", "]"], "{": ["{", "}"], "}": ["{", "}"], "B": ["{", "}"], "<": ["<", ">"], ">": ["<", ">"] };
    if (pairs[key]) return this.pairedTextObjectRange(pairs[key][0], pairs[key][1], around);
    if (key === "'" || key === '"' || key === "`") return this.quoteTextObjectRange(key, around);
    return null;
  }

  protected wordTextObjectRange(big: boolean, around: boolean, count: number): { start: number; end: number } | null {
    const text = this.getText();
    const pred = big ? (ch: string | undefined) => this.isWORDChar(ch) : (ch: string | undefined) => this.isWordChar(ch);
    let start = this.flatIndex();
    if (!pred(text[start])) {
      while (start < text.length && !pred(text[start])) start++;
      if (start >= text.length) return null;
    }
    while (start > 0 && pred(text[start - 1])) start--;
    let end = start;
    for (let n = 0; n < Math.max(1, count); n++) {
      while (end < text.length && pred(text[end])) end++;
      if (n < count - 1) while (end < text.length && !pred(text[end])) end++;
    }
    if (around) {
      const wsStart = start;
      while (end < text.length && /\s/.test(text[end] ?? "")) end++;
      if (end === wsStart) while (start > 0 && /\s/.test(text[start - 1] ?? "")) start--;
    }
    return { start, end };
  }

  protected pairedTextObjectRange(open: string, close: string, around: boolean): { start: number; end: number } | null {
    const text = this.getText();
    const pos = this.flatIndex();
    let start = -1;
    let depth = 0;
    for (let i = pos; i >= 0; i--) {
      if (text[i] === close) depth++;
      else if (text[i] === open) { if (depth === 0) { start = i; break; } depth--; }
    }
    if (start < 0) return null;
    let end = -1; depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close) { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) return null;
    return around ? { start, end } : { start: start + 1, end: end - 1 };
  }

  protected quoteTextObjectRange(quote: string, around: boolean): { start: number; end: number } | null {
    const text = this.getText();
    const pos = this.flatIndex();
    let start = -1;
    for (let i = pos; i >= 0; i--) if (text[i] === quote && text[i - 1] !== "\\") { start = i; break; }
    if (start < 0) return null;
    let end = -1;
    for (let i = start + 1; i < text.length; i++) if (text[i] === quote && text[i - 1] !== "\\") { end = i + 1; break; }
    if (end < 0 || end <= start + 1) return null;
    return around ? { start, end } : { start: start + 1, end: end - 1 };
  }

  protected enterInsert(): void { this.mode = "insert"; this.visualAnchor = null; this.pendingOperator = null; this.pendingOperatorCount = 1; this.status = "INSERT"; }
  protected enterNormal(status = "NORMAL"): void { this.mode = "normal"; this.visualAnchor = null; this.pendingOperator = null; this.pendingOperatorCount = 1; this.status = status; }
  protected isAutocompleteOpen(): boolean { return !!(this as any).isShowingAutocomplete?.(); }
  protected editorState(): any { return (this as any).state; }
  protected snapshot(): void { (this as any).pushUndoSnapshot?.(); }
  protected changed(): void { this.onChange?.(this.getText()); this.invalidate(); }
  protected joinLines(): void { const s = this.editorState(); if (s.cursorLine >= s.lines.length - 1) return; this.snapshot(); const current = s.lines[s.cursorLine] ?? ""; const next = s.lines[s.cursorLine + 1] ?? ""; const base = current.replace(/\s+$/g, ""); const joiner = base.length > 0 && next.trimStart().length > 0 ? " " : ""; s.lines[s.cursorLine] = base + joiner + next.trimStart(); s.lines.splice(s.cursorLine + 1, 1); s.cursorCol = base.length; this.changed(); }
  protected clampCursor(): void { const s = this.editorState(); s.cursorLine = Math.max(0, Math.min(s.cursorLine, s.lines.length - 1)); s.cursorCol = Math.max(0, Math.min(s.cursorCol, s.lines[s.cursorLine]?.length ?? 0)); }
  protected moveCol(delta: number): void { const s = this.editorState(); s.cursorCol += delta; this.clampCursor(); }
  protected moveLine(delta: number): void { const s = this.editorState(); s.cursorLine += delta; this.clampCursor(); }
  protected moveLineStart(): void { this.editorState().cursorCol = 0; }
  protected moveLineEnd(): void { const s = this.editorState(); s.cursorCol = s.lines[s.cursorLine]?.length ?? 0; }
  protected moveFirstNonBlank(): void { const s = this.editorState(); const line = s.lines[s.cursorLine] ?? ""; s.cursorCol = line.search(/\S/); if (s.cursorCol < 0) s.cursorCol = 0; }
  protected moveBufferStart(): void { const s = this.editorState(); s.cursorLine = 0; s.cursorCol = 0; }
  protected moveBufferEnd(): void { const s = this.editorState(); s.cursorLine = s.lines.length - 1; this.moveLineEnd(); }
  protected isWordChar(ch: string | undefined): boolean { return !!ch && /[A-Za-z0-9_\\]/.test(ch); }
  protected flatIndex(): number { const s = this.editorState(); let index = 0; for (let i = 0; i < s.cursorLine; i++) index += (s.lines[i]?.length ?? 0) + 1; return index + s.cursorCol; }
  protected setFlatIndex(index: number): void { const s = this.editorState(); let rest = Math.max(0, Math.min(index, this.getText().length)); for (let i = 0; i < s.lines.length; i++) { const len = s.lines[i]?.length ?? 0; if (rest <= len) { s.cursorLine = i; s.cursorCol = rest; return; } rest -= len + 1; } s.cursorLine = s.lines.length - 1; s.cursorCol = s.lines[s.cursorLine]?.length ?? 0; }
  protected nextWordStartIndex(from = this.flatIndex()): number { const text = this.getText(); let i = Math.min(from + 1, text.length); while (i < text.length && this.isWordChar(text[i])) i++; while (i < text.length && !this.isWordChar(text[i])) i++; return i; }
  protected wordEndForwardIndex(from = this.flatIndex()): number { const text = this.getText(); let i = Math.min(from + 1, text.length); while (i < text.length && !this.isWordChar(text[i])) i++; while (i + 1 < text.length && this.isWordChar(text[i + 1])) i++; return i; }
  protected wordStartBackwardIndex(from = this.flatIndex()): number { const text = this.getText(); let i = Math.max(0, from - 1); while (i > 0 && !this.isWordChar(text[i])) i--; while (i > 0 && this.isWordChar(text[i - 1])) i--; return i; }
  protected moveWordStartForward(): void { this.setFlatIndex(this.nextWordStartIndex()); }
  protected moveWordEndForward(): void { this.setFlatIndex(this.wordEndForwardIndex()); }
  protected moveWordStartBackward(): void { this.setFlatIndex(this.wordStartBackwardIndex()); }
  protected moveWordEndBackward(): void { const text = this.getText(); let i = Math.max(0, this.flatIndex() - 1); while (i > 0 && !this.isWordChar(text[i])) i--; while (i > 0 && this.isWordChar(text[i - 1])) i--; while (i + 1 < text.length && this.isWordChar(text[i + 1])) i++; this.setFlatIndex(i); }
  protected setTextPreserveCursor(text: string, cursorIndex: number): void { const s = this.editorState(); s.lines = text.split("\n"); if (s.lines.length === 0) s.lines = [""]; this.setFlatIndex(cursorIndex); this.changed(); }
  protected lineStartIndex(lineNo: number): number { const s = this.editorState(); let index = 0; for (let i = 0; i < lineNo; i++) index += (s.lines[i]?.length ?? 0) + 1; return index; }
  protected lineAtFlatIndex(index: number): number { const s = this.editorState(); let rest = Math.max(0, index); for (let i = 0; i < s.lines.length; i++) { const len = s.lines[i]?.length ?? 0; if (rest <= len) return i; rest -= len + 1; } return Math.max(0, s.lines.length - 1); }
  protected selectionRange(): { start: number; end: number } | null { if (this.visualAnchor === null) return null; const textLength = this.getText().length; if (this.mode === "visualLine") { const s = this.editorState(); const anchorLine = this.lineAtFlatIndex(this.visualAnchor); const startLine = Math.min(anchorLine, s.cursorLine); const endLine = Math.max(anchorLine, s.cursorLine); const start = this.lineStartIndex(startLine); const end = Math.min(textLength, this.lineStartIndex(endLine) + (s.lines[endLine]?.length ?? 0) + 1); return { start, end }; } const a = this.visualAnchor; const b = this.flatIndex(); return { start: Math.max(0, Math.min(a, b)), end: Math.min(textLength, Math.max(a, b) + 1) }; }
  protected yankToClipboard(text: string): void { this.yankBuffer = { text, lineWise: text.endsWith("\n") }; copyTextToSystemClipboard(text); }
  protected readClipboard(): PromptYank | null { if (this.yankBuffer) return this.yankBuffer; const text = readTextFromSystemClipboard(); return text ? { text, lineWise: text.endsWith("\n") } : null; }
  protected yankVisual(): void { const range = this.selectionRange(); if (range) this.yankToClipboard(this.getText().slice(range.start, range.end)); }
  protected deleteVisual(insertAfter = false): void { const range = this.selectionRange(); if (!range) return; const text = this.getText(); this.snapshot(); this.yankToClipboard(text.slice(range.start, range.end)); this.mode = insertAfter ? "insert" : "normal"; this.visualAnchor = null; this.setTextPreserveCursor(text.slice(0, range.start) + text.slice(range.end), range.start); this.status = insertAfter ? "INSERT" : "NORMAL"; }
  protected replaceVisualWithYank(): void { const y = this.readClipboard(); const range = this.selectionRange(); if (!y || !range) return; const text = this.getText(); const replaced = text.slice(range.start, range.end); this.snapshot(); this.yankToClipboard(replaced); this.visualAnchor = null; this.mode = "normal"; this.setTextPreserveCursor(text.slice(0, range.start) + y.text + text.slice(range.end), range.start + y.text.length); this.status = "NORMAL"; }
  protected applyOperatorToTarget(target: number, insertAfter = false): void {
    const op = this.pendingOperator;
    if (!op) return;
    this.pendingOperator = null;
    this.pendingOperatorCount = 1;
    const start = this.flatIndex();
    const range = { start: Math.min(start, target), end: Math.max(start, target) };
    if (range.end <= range.start) return;
    if (op === "y") { this.yankToClipboard(this.getText().slice(range.start, range.end)); this.status = "Yanked motion"; return; }
    this.deleteRange(range.start, range.end, op === "c" || insertAfter);
  }

  protected applyOperatorLineMotion(delta: number): void {
    const op = this.pendingOperator;
    if (!op) return;
    const s = this.editorState();
    const startLine = s.cursorLine;
    const endLine = Math.max(0, Math.min(s.lines.length - 1, startLine + delta));
    const first = Math.min(startLine, endLine);
    const last = Math.max(startLine, endLine);
    const start = this.lineStartIndex(first);
    const end = Math.min(this.getText().length, this.lineStartIndex(last) + String(s.lines[last] ?? "").length + 1);
    this.pendingOperator = null;
    this.pendingOperatorCount = 1;
    if (op === "y") { this.yankToClipboard(this.getText().slice(start, end)); this.status = "Yanked motion"; return; }
    this.deleteRange(start, end, op === "c");
  }

  protected applyOperatorMotion(motion: "w" | "e" | "b" | "$" | "W" | "E" | "B" | "h" | "l" | "0" | "^", count = 1, insertAfter = false): void {
    const op = this.pendingOperator;
    if (!op) return;
    const total = this.pendingOperatorCount * count;
    this.pendingOperator = null;
    this.pendingOperatorCount = 1;
    const start = this.flatIndex();
    const s = this.editorState();
    let target = start;
    for (let i = 0; i < total; i++) {
      target = motion === "w" ? this.nextWordStartIndex(target)
        : motion === "e" ? Math.min(this.getText().length, this.wordEndForwardIndex(target) + 1)
        : motion === "b" ? this.wordStartBackwardIndex(target)
        : motion === "W" ? this.nextByPredicate(target, ch => this.isWORDChar(ch))
        : motion === "E" ? Math.min(this.getText().length, this.endByPredicate(target, ch => this.isWORDChar(ch)) + 1)
        : motion === "B" ? this.backByPredicate(target, ch => this.isWORDChar(ch))
        : motion === "h" ? Math.max(0, target - 1)
        : motion === "l" ? Math.min(this.getText().length, target + 1)
        : motion === "0" ? this.lineStartIndex(s.cursorLine)
        : motion === "^" ? this.lineStartIndex(s.cursorLine) + Math.max(0, String(s.lines[s.cursorLine] ?? "").search(/\S/))
        : this.lineStartIndex(s.cursorLine) + (s.lines[s.cursorLine]?.length ?? 0);
    }
    if (target === start) return;
    const range = { start: Math.min(start, target), end: Math.max(start, target) };
    if (op === "y") { this.yankToClipboard(this.getText().slice(range.start, range.end)); this.status = "Yanked motion"; return; }
    this.deleteRange(range.start, range.end, op === "c" || insertAfter);
  }

  protected deleteRange(start: number, end: number, insertAfter = false): void { const text = this.getText(); if (end <= start) return; this.snapshot(); this.yankToClipboard(text.slice(start, end)); this.mode = insertAfter ? "insert" : "normal"; this.setTextPreserveCursor(text.slice(0, start) + text.slice(end), start); this.status = insertAfter ? "INSERT" : "NORMAL"; }
  protected deleteChar(): void { const text = this.getText(); const i = this.flatIndex(); if (i >= text.length) return; this.snapshot(); this.yankToClipboard(text[i]); this.setTextPreserveCursor(text.slice(0, i) + text.slice(i + 1), i); }
  protected deleteCharBefore(): void { const text = this.getText(); const i = this.flatIndex(); if (i <= 0) return; this.snapshot(); this.yankToClipboard(text[i - 1]); this.setTextPreserveCursor(text.slice(0, i - 1) + text.slice(i), i - 1); }
  protected vimDeleteToEndOfLine(): void { const s = this.editorState(); const line = s.lines[s.cursorLine] ?? ""; if (s.cursorCol >= line.length) return; this.snapshot(); this.yankToClipboard(line.slice(s.cursorCol)); s.lines[s.cursorLine] = line.slice(0, s.cursorCol); this.changed(); }
  protected yankLine(): void { const s = this.editorState(); this.yankToClipboard(`${s.lines[s.cursorLine] ?? ""}\n`); this.status = "Yanked line"; }
  protected deleteLine(): void { const s = this.editorState(); this.snapshot(); this.yankToClipboard(`${s.lines[s.cursorLine] ?? ""}\n`); if (s.lines.length <= 1) { s.lines = [""]; s.cursorLine = 0; s.cursorCol = 0; } else { s.lines.splice(s.cursorLine, 1); this.clampCursor(); } this.changed(); }
  protected changeLine(): void { const s = this.editorState(); this.snapshot(); this.yankToClipboard(`${s.lines[s.cursorLine] ?? ""}\n`); s.lines[s.cursorLine] = ""; s.cursorCol = 0; this.enterInsert(); this.changed(); }
  protected pasteAfter(): void { const y = this.readClipboard(); if (!y) return; if (y.lineWise) { this.moveLineEnd(); this.insertTextAtCursor(`\n${y.text.replace(/\n$/, "")}`); } else { this.moveCol(1); this.insertTextAtCursor(y.text); } }
  protected pasteBefore(): void { const y = this.readClipboard(); if (!y) return; if (y.lineWise) { this.moveLineStart(); this.insertTextAtCursor(y.text); this.moveLine(-1); } else this.insertTextAtCursor(y.text); }
  protected renderVisualEditor(width: number): string[] { const s = this.editorState(); const paddingX = Math.min(this.getPaddingX?.() ?? 1, Math.max(0, Math.floor((width - 1) / 2))); const contentWidth = Math.max(1, width - paddingX * 2); const maxVisible = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3)); const startLine = Math.max(0, Math.min(s.cursorLine - maxVisible + 1, Math.max(0, s.lines.length - maxVisible))); const endLine = Math.min(s.lines.length, startLine + maxVisible); const pad = " ".repeat(paddingX); const color = (this as any).borderColor ?? ((x: string) => x); const border = color("─".repeat(width)); const out = [border]; for (let i = startLine; i < endLine; i++) { const raw = s.lines[i] ?? ""; const line = this.visualHighlightedLine(raw, i); const truncated = truncateToWidth(line, contentWidth, ""); out.push(`${pad}${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}${pad}`); } if (out.length === 1) out.push(`${pad}\x1b[7m \x1b[27m${" ".repeat(Math.max(0, contentWidth - 1))}${pad}`); out.push(this.promptModeLine(width)); return out; }
  protected visualHighlightedLine(line: string, lineNo: number): string { const range = this.selectionRange(); if (!range) return line; const lineStart = this.lineStartIndex(lineNo); const start = Math.max(0, range.start - lineStart); const end = Math.min(line.length, range.end - lineStart); if (line.length === 0 && range.start <= lineStart && range.end >= lineStart) return "\x1b[7m \x1b[27m"; if (start >= end) return line; return `${line.slice(0, start)}\x1b[7m${line.slice(start, end)}\x1b[27m${line.slice(end)}`; }
}

class MechPiModalPromptEditor extends MechPiModalTextEditor {
  private lastBackspaceAt = 0;
  private voiceSpaceTimer: ReturnType<typeof setTimeout> | null = null;
  private voiceSpaceRecording = false;
  private promptHistory: string[] = [];
  private promptHistoryFile?: string;
  private historyBrowseIndex = -1;
  private historyBrowsePrefix = "";
  private historyBrowseDraft = "";

  constructor(tui: TUI, theme: any, keybindings: any, promptHistoryFile?: string, initialHistory: string[] = []) {
    super(tui, theme, keybindings);
    this.promptHistoryFile = promptHistoryFile;
    this.promptHistory = initialHistory.slice(0, promptHistoryLimit());
    (this as any).history = this.promptHistory.slice();
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) {
      if (this.mode === "insert" && this.handleVoiceSpace(data)) this.tui.requestRender();
      return;
    }
    this.handleModalInput(data);
  }

  protected handleInsertMode(data: string): void {
    if (!matchesKey(data, Key.space) && this.voiceSpaceTimer) {
      clearTimeout(this.voiceSpaceTimer);
      this.voiceSpaceTimer = null;
      this.status = "INSERT";
    }
    if (this.handleVoiceSpace(data)) return;
    if (this.isAutocompleteOpen()) {
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) { super.handleInsertMode(data); return; }
      if (this.isMechGotoCitePrompt() && matchesKey(data, Key.tab)) { CustomEditor.prototype.handleInput.call(this, "\x1b[B"); return; }
      if (this.isMechGotoCitePrompt() && matchesKey(data, Key.shift("tab"))) { CustomEditor.prototype.handleInput.call(this, "\x1b[A"); return; }
    }
    if (matchesKey(data, Key.up)) { if (this.browsePromptHistory("older")) return; }
    if (matchesKey(data, Key.down)) { if (this.browsePromptHistory("newer")) return; }
    if (matchesKey(data, Key.ctrl("s"))) { this.submitPrompt(); return; }
    if (matchesKey(data, Key.escape)) { this.enterNormal(); return; }
    if (isPromptBackspaceInput(data)) { this.resetPromptHistoryBrowse(); this.handlePromptBackspace(data); return; }
    if (matchesKey(data, "shift+enter") || matchesKey(data, "shift+return")) { this.resetPromptHistoryBrowse(); this.insertTextAtCursor("\n"); return; }
    if (matchesKey(data, Key.enter)) { this.submitPrompt(); return; }
    this.resetPromptHistoryBrowse();
    CustomEditor.prototype.handleInput.call(this, data);
  }

  protected handleNormalCommand(data: string, _ch: string | undefined): boolean {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s"))) { this.submitPrompt(); return true; }
    if (matchesKey(data, Key.up)) { if (this.browsePromptHistory("older")) return true; CustomEditor.prototype.handleInput.call(this, data); return true; }
    if (matchesKey(data, Key.down)) { if (this.browsePromptHistory("newer")) return true; CustomEditor.prototype.handleInput.call(this, data); return true; }
    return false;
  }

  tryHandlePromptBackspaceInput(data: string): boolean {
    if (this.tui.hasOverlay() || this.mode !== "insert") return false;
    if (!isPromptBackspaceInput(data)) return false;
    this.handlePromptBackspace(data);
    this.tui.requestRender();
    return true;
  }

  tryHandleTmuxPrefixInput(data: string): boolean {
    if (this.tui.hasOverlay()) return false;
    return this.tryHandleCtrlAPrefixInput(data);
  }

  private isMechGotoCitePrompt(): boolean { return this.getText().trimStart().startsWith("/mechgotocite"); }
  private submitPrompt(): void {
    const promptText = (this.getExpandedText?.() ?? this.getText()).trim();
    if (promptText.length === 0) return;
    this.rememberPrompt(promptText);
    this.enterInsert();
    this.status = "Sending...";
    const submitValue = (this as any).submitValue;
    if (typeof submitValue === "function") submitValue.call(this);
    else this.onSubmit?.((this.getExpandedText?.() ?? this.getText()).trim());
  }
  private rememberPrompt(promptText: string): void {
    this.resetPromptHistoryBrowse();
    this.promptHistory = [promptText, ...this.promptHistory.filter(p => p !== promptText)].slice(0, promptHistoryLimit());
    (this as any).history = this.promptHistory.slice();
    if (this.promptHistoryFile) void savePromptHistory(this.promptHistoryFile, this.promptHistory).catch(() => {});
  }
  private resetPromptHistoryBrowse(): void { this.historyBrowseIndex = -1; this.historyBrowsePrefix = ""; this.historyBrowseDraft = ""; }
  private browsePromptHistory(direction: "older" | "newer"): boolean {
    if (this.promptHistory.length === 0) return false;
    if (this.historyBrowseIndex < 0) {
      this.historyBrowseDraft = this.getText();
      this.historyBrowsePrefix = this.historyBrowseDraft;
    }
    const matches = this.promptHistory.filter(p => !this.historyBrowsePrefix || p.startsWith(this.historyBrowsePrefix));
    if (matches.length === 0) return false;
    const next = this.historyBrowseIndex + (direction === "older" ? 1 : -1);
    if (next < 0) {
      this.setTextPreserveCursor(this.historyBrowseDraft, this.historyBrowseDraft.length);
      this.resetPromptHistoryBrowse();
      return true;
    }
    if (next >= matches.length) return true;
    this.historyBrowseIndex = next;
    this.setTextPreserveCursor(matches[next], matches[next].length);
    this.status = this.mode === "insert" ? "INSERT" : "NORMAL";
    return true;
  }
  returnToInsertAfterChat(): void {
    if (this.tui.hasOverlay()) return;
    if (this.getText().trim().length > 0) this.enterNormal("NORMAL");
    else this.enterInsert();
    this.tui.requestRender();
  }
  insertVoiceText(text: string, submit = /^(1|true|yes|on)$/i.test(process.env.MECHPI_VOICE_AUTOSUBMIT ?? "")): void {
    const cleaned = text.trim();
    if (!cleaned) return;
    const current = this.getText();
    const prefix = current.length > 0 && !/\s$/.test(current) ? " " : "";
    this.insertTextAtCursor(`${prefix}${cleaned}`);
    this.enterInsert();
    if (submit) this.submitPrompt();
    else this.tui.requestRender();
  }
  private handleVoiceSpace(data: string): boolean {
    if (!voiceSpaceHoldEnabled() || this.tui.hasOverlay() || this.mode !== "insert" || !matchesKey(data, Key.space)) return false;
    const voice = activeVoice;
    if (!voice?.isEnabled()) return false;
    const released = isKeyRelease(data);
    const editorEmpty = this.getText().trim().length === 0;
    if (!editorEmpty && !this.voiceSpaceTimer && !this.voiceSpaceRecording) return false;
    if (!released) {
      if (this.voiceSpaceRecording) return true;
      if (this.voiceSpaceTimer) return true;
      this.status = "Hold SPACE for voice";
      this.voiceSpaceTimer = setTimeout(() => {
        this.voiceSpaceTimer = null;
        this.voiceSpaceRecording = true;
        this.status = "VOICE REC";
        void voice.startRecording("space-hold").catch(err => voice.notifyError(err));
        this.tui.requestRender();
      }, Number.parseInt(process.env.MECHPI_VOICE_HOLD_MS ?? "1000", 10) || 1000);
      return true;
    }
    if (this.voiceSpaceTimer) {
      clearTimeout(this.voiceSpaceTimer);
      this.voiceSpaceTimer = null;
      this.status = "INSERT";
      return true;
    }
    if (this.voiceSpaceRecording) {
      this.voiceSpaceRecording = false;
      this.status = "VOICE STOPPING";
      voice.stopAfter(Number.parseInt(process.env.MECHPI_VOICE_RELEASE_GRACE_MS ?? "1000", 10) || 1000);
      return true;
    }
    return false;
  }
  private handlePromptBackspace(_data = ""): void {
    const now = Date.now();
    if (now - this.lastBackspaceAt < 150) return;
    this.lastBackspaceAt = now;
    const s = this.editorState();
    this.snapshot();
    if (s.cursorCol > 0) {
      const line = s.lines[s.cursorLine] ?? "";
      const before = Array.from(line.slice(0, s.cursorCol));
      const removed = before.pop();
      if (removed === undefined) return;
      const nextBefore = before.join("");
      s.lines[s.cursorLine] = nextBefore + line.slice(s.cursorCol);
      s.cursorCol = nextBefore.length;
      this.changed();
      return;
    }
    if (s.cursorLine > 0) {
      const current = s.lines[s.cursorLine] ?? "";
      const previous = s.lines[s.cursorLine - 1] ?? "";
      s.lines[s.cursorLine - 1] = previous + current;
      s.lines.splice(s.cursorLine, 1);
      s.cursorLine--;
      s.cursorCol = previous.length;
      this.changed();
    }
  }
}

type PopupEditorSaveReason = "save" | "cancel";

type PopupEditorResult = { reason: PopupEditorSaveReason; text: string };

type UniformPopupEditorOptions = {
  title: string;
  initialText: string;
  help?: string;
  autocompleteProvider?: AutocompleteProvider;
  renderPreview?: (width: number) => string[];
  onRefresh?: (text: string, setStatus: (status: string) => void) => Promise<void> | void;
  onWrite?: (text: string, setStatus: (status: string) => void) => Promise<void> | void;
};

class MechPiUniformPopupEditor extends MechPiModalTextEditor {
  private refreshing = false;
  private message: string | null = null;

  constructor(
    tui: TUI,
    private readonly themeRef: any,
    keybindings: any,
    private readonly opts: UniformPopupEditorOptions,
    private readonly done: (value: PopupEditorResult | null) => void,
  ) {
    super(tui, themeRef, keybindings);
    this.setText(opts.initialText);
    (this as any).disableSubmit = true;
    if (opts.autocompleteProvider) (this as any).setAutocompleteProvider?.(opts.autocompleteProvider);
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, Key.ctrl("c"))) { this.finish("cancel"); return; }
    if (matchesKey(data, Key.ctrl("s"))) { this.finish("save"); return; }
    if (matchesKey(data, Key.ctrl("r")) && this.opts.onRefresh) { void this.refresh(); return; }
    this.handleModalInput(data);
  }

  render(width: number): string[] {
    const border = this.themeRef.fg("accent", "─".repeat(width));
    const lines: string[] = [deleteAllKittyImages() + border];
    lines.push(truncateToWidth(this.themeRef.fg("accent", this.themeRef.bold(this.opts.title)), width));
    if (this.opts.help) lines.push(truncateToWidth(this.themeRef.fg("dim", this.opts.help), width));
    if (this.message) {
      lines.push(truncateToWidth(this.themeRef.fg(this.refreshing ? "warning" : "dim", this.refreshing ? `${this.message} (refreshing)` : this.message), width));
    }
    const preview = this.opts.renderPreview?.(width) ?? [];
    if (preview.length) {
      lines.push(border);
      lines.push(...preview.map(line => truncateToWidth(line, width, "")));
    }
    lines.push(...this.renderEditorFrame(width));
    return lines;
  }

  protected handleNormalCommand(_data: string, _ch: string | undefined): boolean { return false; }

  protected async executeColonCommand(command: string): Promise<void> {
    if (command === "q" || command === "q!") { this.finish("cancel"); return; }
    if (command === "w") { await this.writeWithoutClosing(); return; }
    if (command === "wq" || command === "x") { await this.writeWithoutClosing(); this.finish("save"); return; }
    await super.executeColonCommand(command);
  }

  private async writeWithoutClosing(): Promise<void> {
    const cursor = this.flatIndex();
    const restoreCursor = () => this.setFlatIndex(Math.min(cursor, this.getText().length));
    if (this.opts.onWrite) {
      this.refreshing = true;
      this.message = "Writing...";
      this.tui.requestRender();
      try { await this.opts.onWrite(this.getText(), s => { this.message = s; }); }
      catch (err) { this.message = err instanceof Error ? err.message : String(err); }
      finally { restoreCursor(); this.refreshing = false; this.tui.requestRender(true); }
      return;
    }
    if (this.opts.onRefresh) { await this.refresh(); restoreCursor(); }
    else { this.message = "Buffer accepted; use :wq or Ctrl+S to close."; restoreCursor(); }
  }

  private finish(reason: PopupEditorSaveReason): void {
    this.tui.terminal.write(deleteAllKittyImages() + "\x1b[2J\x1b[H");
    this.tui.requestRender(true);
    this.done({ reason, text: this.getText() });
  }

  private async refresh(): Promise<void> {
    if (!this.opts.onRefresh || this.refreshing) return;
    this.refreshing = true;
    this.message = "Refreshing preview...";
    this.tui.requestRender();
    try {
      await this.opts.onRefresh(this.getText(), s => { this.message = s; });
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
    } finally {
      this.refreshing = false;
      this.tui.requestRender(true);
    }
  }
}

async function openUniformPopupEditor(ctx: ExtensionContext, opts: UniformPopupEditorOptions): Promise<string | null> {
  if (!ctx.hasUI) return null;
  const result = await ctx.ui.custom<PopupEditorResult | null>((tui, theme, keybindings, done) => {
    const editor = new MechPiUniformPopupEditor(tui, theme, keybindings, opts, done);
    return opaquePopup(editor, theme);
  }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } });
  return result?.reason === "save" ? result.text : null;
}

type EditTarget = { file: string; line: number; score: number; title: string; preview: string };

function editSearchTerms(query: string): string[] {
  return unique(
    query
      .toLowerCase()
      .replace(/\\([a-zA-Z]+)/g, " $1 ")
      .replace(/[^a-z0-9_:+.-]+/g, " ")
      .split(/\s+/)
      .map(s => s.trim())
      .filter(s => s.length >= 2)
  );
}

function editSearchNormalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\\([a-zA-Z]+)/g, " $1 ")
    .replace(/[_{}$^\\]/g, " ")
    .replace(/[^a-z0-9:+.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editSearchScore(query: string, terms: string[], haystack: string, title = ""): number {
  const norm = editSearchNormalize(haystack);
  const titleNorm = editSearchNormalize(title);
  const phrase = editSearchNormalize(query);
  let score = 0;
  if (phrase && norm.includes(phrase)) score += 120;
  if (phrase && titleNorm.includes(phrase)) score += 80;
  for (const term of terms) {
    if (norm.includes(term)) score += 12;
    if (titleNorm.includes(term)) score += 18;
  }
  const uniqueHits = terms.filter(t => norm.includes(t) || titleNorm.includes(t)).length;
  if (terms.length) score += 25 * (uniqueHits / terms.length);
  return score;
}

async function findMechEditTarget(ctx: ExtensionContext, query: string): Promise<EditTarget | null> {
  const trimmed = query.trim();
  const direct = trimmed.match(/^(.+?\.tex)(?::(\d+))?$/);
  if (direct) {
    const file = direct[1];
    const line = Math.max(1, Number.parseInt(direct[2] ?? "1", 10) || 1);
    if (await exists(path.resolve(ctx.cwd, file))) return { file, line, score: 9999, title: "direct location", preview: `${file}:${line}` };
  }

  const map = await loadOrBuildMap(ctx);
  const terms = editSearchTerms(trimmed);
  const candidates: EditTarget[] = [];
  const add = (target: EditTarget) => { if (target.score > 0) candidates.push(target); };

  for (const e of map.equations) {
    const labels = e.labels ?? (e.label ? [e.label] : []);
    const numbers = (e.numbers ?? []).map(n => n.number);
    const title = `equation ${labels.join(", ")} ${numbers.length ? `(${numbers.join(", ")})` : ""}`;
    const text = `${title}\n${e.tex}\n${e.nearby}`;
    let score = editSearchScore(trimmed, terms, text, title) + 10;
    if (labels.some(label => trimmed === label)) score += 500;
    if (labels.some(label => trimmed.includes(label))) score += 250;
    if (numbers.some(n => sameEquationNumber(n, trimmed.replace(/^number:/, "")))) score += 500;
    add({ file: e.file, line: e.lineStart, score, title, preview: equationOnlyPreview(e.tex).slice(0, 240) });
  }

  for (const label of map.labels) {
    const title = `label ${label.label}`;
    let score = editSearchScore(trimmed, terms, title, title);
    if (trimmed === label.label) score += 400;
    if (trimmed.includes(label.label)) score += 150;
    add({ file: label.file, line: label.line, score, title, preview: title });
  }

  for (const rel of map.texFiles) {
    const abs = path.join(ctx.cwd, rel);
    const lines = (await readText(abs).catch(() => "")).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const section = line.match(/\\(part|chapter|section|subsection|subsubsection|paragraph)\*?(?:\[[^\]]*\])?\{([^}]*)\}/);
      if (section) {
        const title = `${section[1]} ${section[2]}`;
        const context = lines.slice(i, Math.min(lines.length, i + 8)).join("\n");
        add({ file: rel, line: i + 1, score: editSearchScore(trimmed, terms, `${title}\n${context}`, title) + 20, title, preview: context.slice(0, 260) });
      }
      if (/\S/.test(line)) {
        const context = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 5)).join("\n");
        add({ file: rel, line: i + 1, score: editSearchScore(trimmed, terms, context, line), title: `text near ${rel}:${i + 1}`, preview: context.slice(0, 260) });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

function splitCommandWords(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(s => s.replace(/^['"]|['"]$/g, "")) ?? [];
}

function commandExists(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0 || spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function openExternalEditorAt(cwd: string, target: EditTarget): { command: string; args: string[]; detached: boolean } {
  const abs = path.resolve(cwd, target.file);
  const editorWords = splitCommandWords(process.env.MECHPI_EDITOR ?? process.env.VISUAL ?? process.env.EDITOR ?? "nvim");
  const editor = editorWords[0] ?? "nvim";
  const editorArgs = editorWords.slice(1);
  const base = path.basename(editor);

  if (/^(code|codium|code-insiders)$/.test(base)) {
    const args = [...editorArgs, "-g", `${abs}:${target.line}`];
    const child = spawn(editor, args, { cwd, detached: true, stdio: "ignore" });
    child.unref();
    return { command: editor, args, detached: true };
  }

  const args = [...editorArgs, `+${target.line}`, abs];
  const terminalWords = splitCommandWords(process.env.MECHPI_EDITOR_TERMINAL ?? "");
  const hasKitty = commandExists("kitty");
  if (terminalWords.length || hasKitty) {
    const terminal = terminalWords[0] ?? "kitty";
    const terminalArgs = terminalWords.slice(1);
    const terminalBase = path.basename(terminal);
    const fullArgs = terminalBase === "kitty"
      ? [...terminalArgs, "--detach", "--working-directory", cwd, editor, ...args]
      : [...terminalArgs, "-e", editor, ...args];
    const child = spawn(terminal, fullArgs, { cwd, detached: true, stdio: "ignore" });
    child.unref();
    return { command: terminal, args: fullArgs, detached: true };
  }

  const child = spawn(editor, args, { cwd, detached: true, stdio: "ignore" });
  child.unref();
  return { command: editor, args, detached: true };
}

type CitationStatus = "local" | "verified" | "partial" | "manual";

type BibEntry = {
  type: string;
  key: string;
  fields: Record<string, string>;
  raw: string;
  file: string;
  line: number;
};

type CitationCandidate = {
  id: string;
  title: string;
  authors: string[];
  year?: string;
  venue?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  abstract?: string;
  key?: string;
  bibtex?: string;
  source: string;
  status: CitationStatus;
  score: number;
  notes: string[];
  summary?: string;
};

function normalizeSpace(s: string): string { return s.replace(/\s+/g, " ").trim(); }
function stripTexMarkupForSearch(s: string): string { return s.replace(/\\[A-Za-z]+(?:\[[^\]]*\])*(?:\{([^{}]*)\})?/g, "$1").replace(/[{}$]/g, " "); }
function searchTokens(s: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "paper", "citation", "support", "statement", "need", "studies", "some", "into", "caused"]);
  const raw = normalizeSpace(stripTexMarkupForSearch(s)).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];
  const expanded = raw.flatMap(t => t.includes("-") ? [t, ...t.split("-").filter(part => part.length >= 3)] : [t]);
  return unique(expanded).filter(t => !stop.has(t));
}
function tokenScore(query: string, text: string): number {
  const toks = searchTokens(query);
  if (!toks.length) return 0;
  const hay = normalizeSpace(text).toLowerCase();
  return toks.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) / toks.length;
}
function decodeHtml(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function latexEscapeBibValue(s: string): string { return normalizeSpace(s).replace(/[{}]/g, ""); }
function normalizeDoi(doi?: string): string | undefined {
  if (!doi) return undefined;
  const d = doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  return d || undefined;
}
function normalizeTitleKey(s: string): string { return normalizeSpace(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function citeKeyFromCandidate(c: CitationCandidate, existing = new Set<string>()): string {
  const last = (c.authors[0] ?? "ref").split(/\s+/).pop()?.replace(/[^A-Za-z0-9]/g, "") || "ref";
  const yr = c.year?.match(/\d{4}/)?.[0] ?? "nd";
  const word = searchTokens(c.title).find(t => !/^(the|and|for|with)$/.test(t)) ?? "paper";
  const base = `${last.toLowerCase()}${yr}${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`.replace(/[^A-Za-z0-9:._-]/g, "");
  let key = base || `ref${yr}`;
  let i = 2;
  while (existing.has(key)) key = `${base}${i++}`;
  return key;
}

function replaceBibtexKey(bibtex: string, key: string): string {
  return bibtex.replace(/^(@\w+\s*[({]\s*)[^,\s]+/m, `$1${key}`);
}

function sameBibIdentity(e: BibEntry, c: CitationCandidate): boolean {
  const edoi = normalizeDoi(e.fields.doi);
  if (edoi && c.doi) return edoi.toLowerCase() === c.doi.toLowerCase();
  return normalizeTitleKey(e.fields.title ?? e.key) === normalizeTitleKey(c.title);
}

function parseBibEntries(text: string, file: string): BibEntry[] {
  const out: BibEntry[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") continue;
    const head = text.slice(i).match(/^@(\w+)\s*([({])\s*([^,\s]+)\s*,/);
    if (!head) continue;
    const type = head[1];
    const open = head[2];
    const close = open === "{" ? "}" : ")";
    let pos = i + head[0].length;
    let depth = 1;
    for (; pos < text.length; pos++) {
      const ch = text[pos];
      if (ch === "\\") { pos++; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) { pos++; break; }
      }
    }
    const raw = text.slice(i, pos);
    const body = raw.slice(head[0].length, -1);
    const fields: Record<string, string> = {};
    const re = /(\w+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|[^,\n]+)\s*,?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      fields[m[1].toLowerCase()] = m[2].trim().replace(/^\{([\s\S]*)\}$/m, "$1").replace(/^"([\s\S]*)"$/m, "$1");
    }
    out.push({ type, key: head[3].trim(), fields, raw, file, line: lineOf(text, i) });
    i = pos;
  }
  return out;
}

async function loadBibEntries(cwd: string, map: PaperMap): Promise<BibEntry[]> {
  const files = unique([...map.bibKeys.map(b => b.file), ...(await walk(cwd).catch(() => [])).filter(p => p.endsWith(".bib")).map(p => path.relative(cwd, p))]);
  const entries: BibEntry[] = [];
  for (const rel of files) entries.push(...parseBibEntries(await readText(path.join(cwd, rel)).catch(() => ""), rel));
  return entries;
}

async function detectBibFile(cwd: string, map: PaperMap): Promise<string> {
  if (map.bibKeys[0]?.file) return map.bibKeys[0].file;
  const root = map.rootTex ? await readText(path.join(cwd, map.rootTex)).catch(() => "") : "";
  const resource = root.match(/\\addbibresource(?:\[[^\]]*\])?\{([^}]+)\}/)?.[1]
    ?? root.match(/\\bibliography\{([^}]+)\}/)?.[1]?.split(",")[0]?.trim();
  if (resource) return resource.endsWith(".bib") ? resource : `${resource}.bib`;
  const bib = (await walk(cwd).catch(() => [])).find(p => p.endsWith(".bib"));
  return bib ? path.relative(cwd, bib) : "references.bib";
}

function bibEntryToCandidate(e: BibEntry, prompt: string): CitationCandidate {
  const title = e.fields.title ?? e.key;
  const authors = (e.fields.author ?? "").split(/\s+and\s+/i).map(a => normalizeSpace(a)).filter(Boolean).slice(0, 8);
  const year = e.fields.year ?? e.fields.date?.match(/\d{4}/)?.[0];
  const venue = e.fields.journal ?? e.fields.journaltitle ?? e.fields.booktitle ?? e.fields.publisher;
  const doi = normalizeDoi(e.fields.doi);
  const text = [title, authors.join(" "), year, venue, e.fields.abstract, e.fields.keywords].filter(Boolean).join(" ");
  return { id: `local:${e.file}:${e.key}`, title, authors, year, venue, doi, url: e.fields.url, abstract: e.fields.abstract, key: e.key, bibtex: e.raw, source: `local ${e.file}`, status: "local", score: 1.2 + tokenScore(prompt, text), notes: [`Already present in ${e.file} as ${e.key}`] };
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<any | null> {
  try {
    const r = await fetch(url, { signal, headers: { "User-Agent": "mech-pi citation helper (mailto:unknown@example.com)" } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchTextUrl(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<string | null> {
  try {
    const r = await fetch(url, { signal, headers: { "User-Agent": "mech-pi citation helper", ...(headers ?? {}) } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

function crossrefItemToCandidate(item: any, prompt: string): CitationCandidate | null {
  const title = normalizeSpace((item.title?.[0] ?? "").replace(/<[^>]+>/g, ""));
  if (!title) return null;
  const authors = (item.author ?? []).map((a: any) => normalizeSpace([a.given, a.family].filter(Boolean).join(" "))).filter(Boolean);
  const year = String(item.published?.["date-parts"]?.[0]?.[0] ?? item.issued?.["date-parts"]?.[0]?.[0] ?? "") || undefined;
  const venue = item["container-title"]?.[0] ?? item.publisher;
  const doi = normalizeDoi(item.DOI);
  const c: CitationCandidate = { id: `crossref:${doi ?? title}`, title, authors, year, venue, doi, url: item.URL, source: "Crossref", status: doi ? "verified" : "partial", score: 0.7 + tokenScore(prompt, [title, authors.join(" "), year, venue].filter(Boolean).join(" ")), notes: doi ? ["DOI present in Crossref metadata"] : ["Crossref result lacks DOI"] };
  return c;
}

function openAlexItemToCandidate(item: any, prompt: string): CitationCandidate | null {
  const title = normalizeSpace(item.title ?? item.display_name ?? "");
  if (!title) return null;
  const authors = (item.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean);
  const doi = normalizeDoi(item.doi);
  const venue = item.primary_location?.source?.display_name ?? item.host_venue?.display_name;
  const c: CitationCandidate = { id: `openalex:${item.id ?? doi ?? title}`, title, authors, year: item.publication_year ? String(item.publication_year) : undefined, venue, doi, url: item.primary_location?.landing_page_url ?? item.id, source: "OpenAlex", status: doi ? "verified" : "partial", score: 0.65 + tokenScore(prompt, [title, authors.join(" "), venue, item.publication_year].filter(Boolean).join(" ")), notes: doi ? ["DOI present in OpenAlex metadata"] : ["OpenAlex result lacks DOI"] };
  return c;
}

function semanticItemToCandidate(item: any, prompt: string): CitationCandidate | null {
  const title = normalizeSpace(item.title ?? "");
  if (!title) return null;
  const doi = normalizeDoi(item.externalIds?.DOI);
  const arxivId = item.externalIds?.ArXiv;
  const authors = (item.authors ?? []).map((a: any) => a.name).filter(Boolean);
  return { id: `semantic:${item.paperId ?? doi ?? title}`, title, authors, year: item.year ? String(item.year) : undefined, venue: item.venue, doi, arxivId, url: item.url, abstract: item.abstract, source: "Semantic Scholar", status: doi || arxivId ? "verified" : "partial", score: 0.65 + tokenScore(prompt, [title, authors.join(" "), item.venue, item.abstract].filter(Boolean).join(" ")), notes: doi ? ["DOI present in Semantic Scholar metadata"] : arxivId ? ["arXiv id present in Semantic Scholar metadata"] : ["Semantic Scholar result lacks DOI/arXiv id"] };
}

function arxivEntryToCandidate(entryXml: string, prompt: string): CitationCandidate | null {
  const get = (tag: string) => decodeHtml(entryXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.replace(/<[^>]+>/g, "") ?? "");
  const title = normalizeSpace(get("title"));
  if (!title) return null;
  const authors = Array.from(entryXml.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g)).map(m => decodeHtml(m[1]).trim());
  const url = get("id");
  const arxivId = url.split("/").pop()?.replace(/v\d+$/, "");
  const year = get("published").match(/\d{4}/)?.[0];
  const abstract = normalizeSpace(get("summary"));
  return { id: `arxiv:${arxivId ?? title}`, title, authors, year, arxivId, url, abstract, source: "arXiv", status: arxivId ? "verified" : "partial", score: 0.55 + tokenScore(prompt, [title, authors.join(" "), abstract].join(" ")), notes: arxivId ? ["arXiv API record"] : ["arXiv result lacks id"] };
}

function normalizeCitationQueryText(s: string): string {
  return normalizeSpace(s)
    .replace(/\bsouther\b/gi, "southern")
    .replace(/\banhydryte\b/gi, "anhydrite")
    .replace(/\banhydrit\b/gi, "anhydrite");
}

function buildCitationSearchQueries(prompt: string): string[] {
  const normalized = normalizeCitationQueryText(prompt);
  const target = extractTargetStatement(normalized);
  const tokens = searchTokens(normalized)
    .filter(t => !new Set(["citation", "support", "statement", "paper", "recall", "remember", "studies", "study", "city", "wells", "well", "formation", "formations", "massive", "caused", "cause", "such"]).has(t));
  const geology = tokens.filter(t => /anhyd|swelling|uplift|geotherm|drill|fractur|rock|germany|staufen|breisgau/i.test(t));
  const queries = [
    target ?? "",
    geology.join(" "),
    tokens.slice(0, 8).join(" "),
    normalized.slice(0, 220),
  ];
  const lower = normalized.toLowerCase();
  if ((lower.includes("germany") || lower.includes("staufen")) && lower.includes("anhydrite") && (lower.includes("uplift") || lower.includes("drill"))) {
    queries.unshift("Staufen Germany geothermal drilling anhydrite uplift");
    queries.unshift("Damage historic town Staufen Germany geothermal drillings anhydrite-bearing formations");
    queries.push("germany anhydrite uplift geothermal drilling");
  }
  if (lower.includes("anhydrite") && (lower.includes("swelling") || lower.includes("fractur"))) {
    queries.push("anhydrite swelling rock fracturing");
  }
  return unique(queries.map(q => normalizeSpace(q)).filter(q => q.length >= 8)).slice(0, 7);
}

async function searchExternalCitations(prompt: string, signal?: AbortSignal): Promise<CitationCandidate[]> {
  const out: CitationCandidate[] = [];
  const queries = buildCitationSearchQueries(prompt);
  for (const query of queries) {
    const q = encodeURIComponent(query.slice(0, 300));
    const [crossref, openalex, semantic, arxivXml] = await Promise.all([
      fetchJson(`https://api.crossref.org/works?rows=5&query.bibliographic=${q}`, signal),
      fetchJson(`https://api.openalex.org/works?per-page=5&search=${q}`, signal),
      fetchJson(`https://api.semanticscholar.org/graph/v1/paper/search?limit=5&fields=title,authors,year,venue,abstract,externalIds,url&query=${q}`, signal),
      fetchTextUrl(`https://export.arxiv.org/api/query?start=0&max_results=3&search_query=all:${q}`, signal),
    ]);
    for (const item of crossref?.message?.items ?? []) { const c = crossrefItemToCandidate(item, prompt); if (c) { c.notes.push(`Matched query: ${query}`); out.push(c); } }
    for (const item of openalex?.results ?? []) { const c = openAlexItemToCandidate(item, prompt); if (c) { c.notes.push(`Matched query: ${query}`); out.push(c); } }
    for (const item of semantic?.data ?? []) { const c = semanticItemToCandidate(item, prompt); if (c) { c.notes.push(`Matched query: ${query}`); out.push(c); } }
    for (const m of arxivXml?.matchAll(/<entry>([\s\S]*?)<\/entry>/g) ?? []) { const c = arxivEntryToCandidate(m[0], prompt); if (c) { c.notes.push(`Matched query: ${query}`); out.push(c); } }
  }
  return mergeCitationCandidates(out);
}

function mergeCitationCandidates(candidates: CitationCandidate[]): CitationCandidate[] {
  const byKey = new Map<string, CitationCandidate>();
  for (const c of candidates) {
    const key = c.doi ? `doi:${c.doi.toLowerCase()}` : c.arxivId ? `arxiv:${c.arxivId.toLowerCase()}` : `title:${normalizeTitleKey(c.title)}`;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, c);
    else if (prev.status === "local" && c.status !== "local") byKey.set(key, { ...prev, notes: unique([...prev.notes, ...c.notes]), source: unique([...prev.source.split(" + "), c.source]).join(" + ") });
    else if (c.status === "local" && prev.status !== "local") byKey.set(key, { ...c, notes: unique([...prev.notes, ...c.notes]), source: unique([...prev.source.split(" + "), c.source]).join(" + ") });
    else if (c.score > prev.score) byKey.set(key, { ...prev, ...c, notes: unique([...prev.notes, ...c.notes]), source: unique([...prev.source.split(" + "), c.source]).join(" + ") });
  }
  return Array.from(byKey.values()).sort((a, b) => b.score - a.score);
}

function bestCitationUrl(c: CitationCandidate): string | null {
  if (c.doi) return `https://doi.org/${encodeURI(c.doi)}`;
  if (c.url) return c.url;
  if (c.arxivId) return `https://arxiv.org/abs/${encodeURIComponent(c.arxivId)}`;
  if (c.title) return `https://scholar.google.com/scholar?q=${encodeURIComponent(c.title)}`;
  return null;
}

function openUrlExternal(url: string): void {
  spawn(process.env.BROWSER ?? "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function googleScholarManualCandidate(prompt: string): CitationCandidate {
  return { id: "manual:google-scholar", title: "Open Google Scholar manual BibTeX fallback", authors: [], source: "Google Scholar manual", status: "manual", score: -1, url: `https://scholar.google.com/scholar?q=${encodeURIComponent(prompt)}`, notes: ["Opens Google Scholar in a browser. Paste BibTeX manually; mech-pi will validate and insert only after confirmation."] };
}

async function hydrateCandidateBibtex(c: CitationCandidate, existingKeys: Set<string>, signal?: AbortSignal): Promise<CitationCandidate> {
  if (c.bibtex && c.key) return c;
  let bib = "";
  if (c.doi) bib = (await fetchTextUrl(`https://doi.org/${encodeURI(c.doi)}`, signal, { Accept: "application/x-bibtex" }))?.trim() ?? "";
  if (bib && /^@\w+\s*\{/m.test(bib)) {
    const parsed = parseBibEntries(bib, "doi")[0];
    if (parsed) return { ...c, bibtex: parsed.raw, key: parsed.key, status: "verified", notes: unique([...c.notes, "BibTeX fetched by DOI content negotiation"]) };
  }
  const key = c.key ?? citeKeyFromCandidate(c, existingKeys);
  const type = c.arxivId && !c.doi ? "misc" : "article";
  const author = c.authors.length ? `  author = {${c.authors.join(" and ")}},\n` : "";
  const year = c.year ? `  year = {${c.year}},\n` : "";
  const venue = c.venue ? `  journal = {${latexEscapeBibValue(c.venue)}},\n` : "";
  const doi = c.doi ? `  doi = {${c.doi}},\n` : "";
  const eprint = c.arxivId ? `  eprint = {${c.arxivId}},\n  archivePrefix = {arXiv},\n` : "";
  const url = c.url ? `  url = {${c.url}},\n` : "";
  return { ...c, key, bibtex: `@${type}{${key},\n  title = {${latexEscapeBibValue(c.title)}},\n${author}${year}${venue}${doi}${eprint}${url}}`, notes: unique([...c.notes, c.doi ? "Constructed BibTeX from verified DOI metadata because DOI BibTeX was unavailable" : c.arxivId ? "Constructed BibTeX from arXiv metadata" : "Constructed BibTeX from partial metadata; confirmation required"]) };
}

async function generateCandidateSummary(ctx: ExtensionContext, c: CitationCandidate): Promise<string> {
  const fallback = `${c.title}${c.year ? ` (${c.year})` : ""}${c.abstract ? `: ${c.abstract}` : ""}`.slice(0, 900);
  if (!ctx.model) return fallback || "No model selected for summary generation.";
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok || !auth.apiKey) return fallback;
    const msg: Message = { role: "user", timestamp: Date.now(), content: [{ type: "text", text: `Write one concise paragraph summarizing this paper for citation selection. Use only the metadata/abstract below; do not invent facts.\n\nTitle: ${c.title}\nAuthors: ${c.authors.join(", ")}\nYear: ${c.year ?? ""}\nVenue: ${c.venue ?? ""}\nDOI/arXiv: ${c.doi ?? c.arxivId ?? ""}\nAbstract/metadata: ${c.abstract ?? "No abstract available."}` }] };
    const r = await complete(ctx.model, { systemPrompt: "You summarize citation candidates conservatively from supplied metadata only.", messages: [msg] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal });
    return r.content.filter((x): x is { type: "text"; text: string } => x.type === "text").map(x => x.text).join("\n").trim() || fallback;
  } catch { return fallback; }
}

function extractTargetStatement(prompt: string): string | null {
  const m = prompt.match(/statement\s+in\s+(?:the\s+)?paper\s*:\s*[“"']?([\s\S]*?)(?:[”"']?\s+(?:I\s+recall|I\s+remember|Maybe|Perhaps|Look|Find)\b|$)/i);
  if (m?.[1]) return normalizeSpace(m[1]).replace(/["'“”]+$/g, "");
  const quoted = prompt.match(/[“"]([^”"]{25,})[”"]/);
  return quoted ? normalizeSpace(quoted[1]) : null;
}

type CiteLocation = { file: string; line: number; start: number; end: number; confidence: "high" | "medium"; snippet: string };

async function findCitationLocation(cwd: string, map: PaperMap, prompt: string): Promise<CiteLocation | null> {
  const target = extractTargetStatement(prompt);
  const terms = searchTokens(target ?? prompt).slice(0, 10);
  const found: CiteLocation[] = [];
  for (const rel of map.texFiles) {
    const text = await readText(path.join(cwd, rel)).catch(() => "");
    if (target) {
      const idx = text.indexOf(target);
      if (idx >= 0) found.push({ file: rel, line: lineOf(text, idx), start: idx, end: idx + target.length, confidence: "high", snippet: target });
    }
    if (!found.length && terms.length) {
      const sentenceRe = /[^.!?\n]{20,}[.!?]/g;
      let m: RegExpExecArray | null;
      while ((m = sentenceRe.exec(text))) {
        const score = terms.filter(t => m![0].toLowerCase().includes(t)).length / terms.length;
        if (score >= 0.55) found.push({ file: rel, line: lineOf(text, m.index), start: m.index, end: m.index + m[0].length, confidence: "medium", snippet: normalizeSpace(m[0]) });
      }
    }
  }
  found.sort((a, b) => (a.confidence === "high" ? -1 : 1) - (b.confidence === "high" ? -1 : 1));
  return found[0] ?? null;
}

async function findClosestCitationEditTarget(cwd: string, map: PaperMap, prompt: string): Promise<EditTarget | null> {
  const target = extractTargetStatement(prompt);
  const terms = searchTokens(target ?? prompt).slice(0, 12);
  const scored: EditTarget[] = [];
  for (const rel of map.texFiles) {
    const text = await readText(path.join(cwd, rel)).catch(() => "");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const context = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 4)).join(" ");
      const norm = context.toLowerCase();
      let score = 0;
      if (target && norm.includes(target.toLowerCase())) score += 500;
      for (const term of terms) if (norm.includes(term)) score += 20;
      if (/\\(section|subsection|paragraph)\b/.test(lines[i] ?? "")) score += 5;
      if (score > 0) scored.push({ file: rel, line: i + 1, score, title: `closest citation location ${rel}:${i + 1}`, preview: normalizeSpace(context).slice(0, 260) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored[0]) return scored[0];
  const fallback = map.rootTex ?? map.texFiles[0];
  return fallback ? { file: fallback, line: 1, score: 0, title: "fallback paper start", preview: fallback } : null;
}

function inferCiteCommand(map: PaperMap): string {
  const counts = new Map<string, number>();
  for (const c of map.citations) if (c.command) counts.set(c.command, (counts.get(c.command) ?? 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "cite";
}

function insertCitationIntoText(text: string, loc: CiteLocation, citeCommand: string, key: string): { text: string; changed: boolean; note: string } {
  const newKeys = key.split(",").map(k => k.trim()).filter(Boolean);
  const searchStart = Math.max(0, loc.end - 20);
  const searchEnd = Math.min(text.length, loc.end + 120);
  const window = text.slice(searchStart, searchEnd);
  const citeRe = /\\(?:cite|citet|citep|parencite|textcite)(?:\[[^\]]*\])*\{([^}]*)\}/g;
  const existing = citeRe.exec(window);
  if (existing) {
    const oldKeys = existing[1].split(",").map(k => k.trim()).filter(Boolean);
    const merged = unique([...oldKeys, ...newKeys]).join(",");
    const start = searchStart + existing.index + existing[0].lastIndexOf("{") + 1;
    const end = start + existing[1].length;
    if (merged === existing[1]) return { text, changed: false, note: "Selected citation key(s) were already present near the target statement." };
    return { text: text.slice(0, start) + merged + text.slice(end), changed: true, note: `Merged citation key(s) into existing citation at ${loc.file}:${loc.line}.` };
  }
  let pos = loc.end;
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  if (/[.!?]/.test(text[pos] ?? "")) {
    const insert = ` \\${citeCommand}{${newKeys.join(",")}}`;
    return { text: text.slice(0, pos) + insert + text.slice(pos), changed: true, note: `Inserted before sentence punctuation at ${loc.file}:${loc.line}.` };
  }
  return { text: text.slice(0, loc.end) + ` \\${citeCommand}{${newKeys.join(",")}}` + text.slice(loc.end), changed: true, note: `Inserted after matched statement at ${loc.file}:${loc.line}.` };
}

function candidateLine(c: CitationCandidate, selected: boolean, checked: boolean, width: number, theme: any): string {
  const badge = c.status === "local" ? "local" : c.status === "verified" ? "verified" : c.status === "manual" ? "manual" : "partial";
  const auth = c.authors[0]?.split(/\s+/).slice(-1)[0] ?? c.source;
  const source = c.source.split(" + ").slice(0, 2).join("+");
  const mark = checked ? "✅" : "  ";
  const line = `${selected ? "▶" : " "} ${mark} [${badge}/${source}] ${auth}${c.year ? ` ${c.year}` : ""}: ${c.title}`;
  const styled = selected ? theme.bg("selectedBg", theme.fg("accent", line)) : line;
  return truncateToWidth(styled, width);
}

class CitationPicker {
  private selected = 0;
  private detail = false;
  private loadingSummary = false;
  private checked = new Set<number>();
  constructor(private tui: TUI, private theme: any, private candidates: CitationCandidate[], private summarize: (c: CitationCandidate) => Promise<string>, private done: (c: CitationCandidate[] | null) => void) {}
  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", "─".repeat(width)));
    if (!this.detail) {
      const count = this.checked.size ? ` (${this.checked.size} selected)` : "";
      lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(`Add citation${count}`)) + this.theme.fg("dim", "  j/k move • space select • l details • enter insert • q cancel"), width));
      for (let i = 0; i < this.candidates.length; i++) lines.push(candidateLine(this.candidates[i], i === this.selected, this.checked.has(i), width, this.theme));
    } else {
      const c = this.candidates[this.selected];
      lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Citation detail")) + this.theme.fg("dim", "  h back • l open web • space select • enter insert • q cancel"), width));
      lines.push(truncateToWidth(`${this.checked.has(this.selected) ? "✅ " : ""}${c.title}`, width));
      lines.push(truncateToWidth(`${c.authors.join(", ")}${c.year ? ` (${c.year})` : ""}`, width));
      lines.push(truncateToWidth(`${c.venue ?? ""}${c.doi ? ` DOI: ${c.doi}` : c.arxivId ? ` arXiv: ${c.arxivId}` : ""}`, width));
      lines.push(truncateToWidth(this.theme.fg(c.status === "verified" || c.status === "local" ? "success" : c.status === "manual" ? "warning" : "warning", `status: ${c.status}; source: ${c.source}`), width));
      lines.push("");
      for (const p of wrapPlain(c.summary ?? (this.loadingSummary ? "Generating summary..." : "No summary yet."), width)) lines.push(p);
      lines.push("");
      for (const n of c.notes.slice(0, 5)) lines.push(truncateToWidth(this.theme.fg("dim", `• ${n}`), width));
    }
    lines.push(this.theme.fg("accent", "─".repeat(width)));
    return lines;
  }
  handleInput(data: string): void {
    const ch = printableKey(data);
    if (matchesKey(data, Key.escape) || ch === "q") { this.done(null); return; }
    if (matchesKey(data, Key.enter)) {
      const indices = this.checked.size ? Array.from(this.checked).sort((a, b) => a - b) : [this.selected];
      this.done(indices.map(i => this.candidates[i]).filter(Boolean));
      return;
    }
    if (matchesKey(data, Key.space)) {
      if (this.checked.has(this.selected)) this.checked.delete(this.selected);
      else this.checked.add(this.selected);
      this.tui.requestRender();
      return;
    }
    if (this.detail) {
      if (ch === "h" || matchesKey(data, Key.left)) { this.detail = false; this.tui.requestRender(); return; }
      if (ch === "l" || matchesKey(data, Key.right)) {
        const url = bestCitationUrl(this.candidates[this.selected]);
        if (url) openUrlExternal(url);
        return;
      }
      return;
    }
    if (ch === "j" || matchesKey(data, Key.down)) this.selected = Math.min(this.candidates.length - 1, this.selected + 1);
    else if (ch === "k" || matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (ch === "l" || matchesKey(data, Key.right)) {
      this.detail = true;
      const c = this.candidates[this.selected];
      if (!c.summary && !this.loadingSummary) {
        this.loadingSummary = true;
        this.summarize(c).then(s => { c.summary = s; }).finally(() => { this.loadingSummary = false; this.tui.requestRender(); });
      }
    }
    this.tui.requestRender();
  }
  invalidate(): void {}
}

function wrapPlain(s: string, width: number): string[] {
  const words = normalizeSpace(s).split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (visibleWidth(`${line} ${w}`.trim()) > width) { if (line) out.push(line); line = w; }
    else line = `${line} ${w}`.trim();
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

async function chooseCitationCandidates(ctx: ExtensionContext, candidates: CitationCandidate[]): Promise<CitationCandidate[] | null> {
  return await ctx.ui.custom<CitationCandidate[] | null>((tui, theme, _kb, done) => opaquePopup(new CitationPicker(tui, theme, candidates, c => generateCandidateSummary(ctx, c), done), theme), { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } });
}

async function handleGoogleScholarManual(ctx: ExtensionContext, prompt: string, existingKeys: Set<string>): Promise<CitationCandidate | null> {
  const url = `https://scholar.google.com/scholar?q=${encodeURIComponent(prompt)}`;
  openUrlExternal(url);
  const pasted = await openUniformPopupEditor(ctx, {
    title: "Paste BibTeX from Google Scholar",
    initialText: "",
    help: "Same edit keys as the prompt. Paste one BibTeX entry; :wq/Ctrl+S accepts; Ctrl+C/:q cancels.",
  });
  if (!pasted?.trim()) return null;
  const parsed = parseBibEntries(pasted, "manual")[0];
  if (!parsed) { ctx.ui.notify("Pasted text did not contain a BibTeX entry.", "error"); return null; }
  const key = existingKeys.has(parsed.key) ? citeKeyFromCandidate({ id: "manual:key", title: parsed.fields.title ?? parsed.key, authors: [], source: "manual", status: "partial", score: 0, notes: [] }, existingKeys) : parsed.key;
  const c = bibEntryToCandidate({ ...parsed, key, raw: replaceBibtexKey(parsed.raw, key) }, prompt);
  return { ...c, key, bibtex: replaceBibtexKey(c.bibtex ?? parsed.raw, key), source: "Google Scholar pasted BibTeX", status: normalizeDoi(parsed.fields.doi) ? "verified" : "partial", notes: [normalizeDoi(parsed.fields.doi) ? "Pasted BibTeX includes DOI; still user-confirmed." : "Pasted BibTeX lacks DOI; requires confirmation."] };
}

type MechAddCiteOptions = { toBibOnly: boolean; keepLocal: boolean; prompt: string };

function parseMechAddCiteArgs(args: string): MechAddCiteOptions {
  const words = splitCommandWords(args);
  const kept: string[] = [];
  let toBibOnly = false;
  let keepLocal = false;
  for (const w of words) {
    if (w === "--to-bib" || w === "-b") toBibOnly = true;
    else if (w === "--keep-local" || w === "-l") keepLocal = true;
    else kept.push(w);
  }
  return { toBibOnly, keepLocal, prompt: kept.join(" ") };
}

function candidateDocumentHints(c: CitationCandidate): string[] {
  return unique([c.key, c.title, c.doi, c.url, ...c.authors]
    .filter(Boolean)
    .flatMap(s => searchTokens(String(s)).slice(0, 8)));
}

async function findLocalDocumentForCandidate(cwd: string, c: CitationCandidate): Promise<string | null> {
  const home = process.env.HOME;
  if (!home) return null;
  const hints = candidateDocumentHints(c).filter(t => t.length >= 4).slice(0, 6);
  if (!hints.length) return null;
  const pattern = hints.map(escapeRegExp).join("|");
  const cmd = `find ${shellQuote(home)} -type f \\( -iname '*.pdf' -o -iname '*.md' -o -iname '*.txt' -o -iname '*.docx' \\) 2>/dev/null | grep -Ei ${shellQuote(pattern)} | head -80`;
  const r = await run("bash", ["-lc", cmd], cwd).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const candidates = r.stdout.split(/\r?\n/).filter(Boolean);
  let best: { path: string; score: number } | null = null;
  for (const p of candidates) {
    const base = path.basename(p).toLowerCase();
    const score = hints.filter(h => base.includes(h.toLowerCase())).length;
    if (!best || score > best.score) best = { path: p, score };
  }
  return best?.path ?? null;
}

async function storeWebDocumentForCandidate(cwd: string, c: CitationCandidate, sourceId: string): Promise<{ stored?: string; note?: string } | null> {
  const url = c.doi ? `https://doi.org/${encodeURI(c.doi)}` : c.url;
  if (!url) return null;
  const r = await fetch(url, { headers: { "User-Agent": "mech-pi citation helper" } }).catch(() => null);
  if (!r || !r.ok) return null;
  const contentType = r.headers.get("content-type") ?? "";
  const ext = contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf") ? ".pdf" : ".html";
  const sourceDir = path.join(mechIngestRoot(cwd), "sources");
  await fs.mkdir(sourceDir, { recursive: true });
  const storedAbs = path.join(sourceDir, `${sourceId}${ext}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(storedAbs, buf);
  return { stored: path.relative(cwd, storedAbs), note: ext === ".pdf" ? "downloaded PDF/URL content" : "downloaded DOI/URL landing page (not a PDF)" };
}

async function keepLocalCitationDocument(ctx: ExtensionContext, c: CitationCandidate, key: string): Promise<{ stored?: string; note: string }> {
  const sourceId = `cite-${hashId(key)}`;
  const local = await findLocalDocumentForCandidate(ctx.cwd, c);
  if (local) {
    const converted = await convertDocumentToText(ctx.cwd, local, sourceId);
    return { stored: converted.stored, note: `copied local document from ${local}` };
  }
  const web = await storeWebDocumentForCandidate(ctx.cwd, c, sourceId);
  if (web?.stored) return { stored: web.stored, note: web.note ?? "downloaded web document" };
  return { note: "no local document found under $HOME and no downloadable DOI/URL content found" };
}

function addBibFieldToEntryRaw(raw: string, field: string, value: string): string {
  const re = new RegExp(`\\n\\s*${escapeRegExp(field)}\\s*=\\s*(\\{[^}]*\\}|\"[^\"]*\")\\s*,?`, "i");
  if (re.test(raw)) return raw.replace(re, `\n  ${field} = {${value}},`);
  const idx = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf(")"));
  if (idx < 0) return raw;
  return `${raw.slice(0, idx).trimEnd()},\n  ${field} = {${value}}\n${raw.slice(idx)}`;
}

async function updateExistingBibEntryField(cwd: string, bibRel: string, key: string, field: string, value: string): Promise<boolean> {
  const abs = path.join(cwd, bibRel);
  const text = await readText(abs).catch(() => "");
  const entries = parseBibEntries(text, bibRel);
  const entry = entries.find(e => e.key === key);
  if (!entry) return false;
  const nextRaw = addBibFieldToEntryRaw(entry.raw, field, value);
  if (nextRaw === entry.raw) return false;
  await fs.writeFile(abs, text.slice(0, text.indexOf(entry.raw)) + nextRaw + text.slice(text.indexOf(entry.raw) + entry.raw.length));
  return true;
}

type PreparedCitation = { candidate: CitationCandidate; key: string; bibtex: string; existed: boolean; highMetadata: boolean; keepStored?: string; keepNote?: string };

async function prepareCitationForInsertion(candidate: CitationCandidate, entries: BibEntry[], existingKeys: Set<string>, signal?: AbortSignal): Promise<PreparedCitation> {
  let c = await hydrateCandidateBibtex(candidate, existingKeys, signal);
  if (!c.key || !c.bibtex) throw new Error(`No BibTeX/citekey available for selected citation: ${c.title}`);
  const existingSameKey = entries.find(e => e.key === c.key);
  if (existingSameKey && c.status !== "local" && !sameBibIdentity(existingSameKey, c)) {
    const newKey = citeKeyFromCandidate(c, existingKeys);
    c = { ...c, key: newKey, bibtex: replaceBibtexKey(c.bibtex!, newKey), notes: unique([...c.notes, `Renamed citekey to ${newKey} to avoid colliding with existing ${existingSameKey.key}`]) };
  }
  const key = c.key!;
  const bibtex = c.bibtex!;
  const existed = existingKeys.has(key);
  existingKeys.add(key);
  return { candidate: c, key, bibtex, existed, highMetadata: c.status === "local" || c.status === "verified" };
}

async function insertCitationCandidates(ctx: ExtensionContext, map: PaperMap, candidates: CitationCandidate[], prompt: string, options: { toBibOnly?: boolean; keepLocal?: boolean } = {}): Promise<string> {
  if (candidates.length === 0) return "No citations selected.";
  const entries = await loadBibEntries(ctx.cwd, map);
  const existingKeys = new Set(entries.map(e => e.key));
  const prepared: PreparedCitation[] = [];
  for (const candidate of candidates) prepared.push(await prepareCitationForInsertion(candidate, entries, existingKeys, ctx.signal));
  if (options.keepLocal) {
    for (const p of prepared) {
      const kept = await keepLocalCitationDocument(ctx, p.candidate, p.key);
      p.keepStored = kept.stored;
      p.keepNote = kept.note;
      if (kept.stored) p.bibtex = addBibFieldToEntryRaw(p.bibtex, "file", kept.stored);
    }
  }

  const partial = prepared.filter(p => !p.highMetadata);
  if (partial.length) {
    const list = partial.map(p => `- ${p.candidate.title}`).join("\n");
    const ok = await ctx.ui.confirm("Partial citation metadata", `${partial.length} selected citation(s) are not DOI/arXiv/local verified. Insert anyway?\n\n${list}`);
    if (!ok) return "Cancelled partial citation insertion.";
  }

  const bibRel = await detectBibFile(ctx.cwd, map);
  const toAppend = prepared.filter(p => !p.existed);
  if (toAppend.length) {
    await fs.mkdir(path.dirname(path.join(ctx.cwd, bibRel)), { recursive: true });
    const old = await readText(path.join(ctx.cwd, bibRel)).catch(() => "");
    await fs.writeFile(path.join(ctx.cwd, bibRel), `${old.trimEnd()}\n\n${toAppend.map(p => p.bibtex.trim()).join("\n\n")}\n`);
  }

  if (options.keepLocal) {
    for (const p of prepared.filter(p => p.existed && p.keepStored)) await updateExistingBibEntryField(ctx.cwd, bibRel, p.key, "file", p.keepStored!);
  }

  const keys = prepared.map(p => p.key);
  const keepNote = options.keepLocal ? ` Keep-local: ${prepared.map(p => `${p.key}: ${p.keepStored ?? p.keepNote ?? "not found"}`).join("; ")}.` : "";
  if (options.toBibOnly) {
    await writeMap(ctx.cwd, await buildPaperMap(ctx.cwd));
    return `BibTeX ${toAppend.length ? "added" : "ready"} in ${bibRel} as ${keys.join(", ")}; TeX unchanged by --to-bib.${keepNote}`;
  }
  const loc = await findCitationLocation(ctx.cwd, map, prompt);
  if (!loc || loc.confidence !== "high") {
    const target = loc
      ? { file: loc.file, line: loc.line, score: loc.confidence === "medium" ? 50 : 0, title: "closest citation location", preview: loc.snippet }
      : await findClosestCitationEditTarget(ctx.cwd, map, prompt);
    if (target) {
      const opened = openExternalEditorAt(ctx.cwd, target);
      return `BibTeX ready in ${bibRel} as ${keys.join(", ")}; TeX unchanged because citation location was not high confidence. Opened ${target.file}:${target.line} in ${opened.command} for manual placement.${keepNote}`;
    }
    return `BibTeX ready in ${bibRel} as ${keys.join(", ")}; TeX unchanged because no safe source location was found.${keepNote}`;
  }

  const allHighMetadata = prepared.every(p => p.highMetadata);
  if (!allHighMetadata || prepared.length > 1) {
    const ok = await ctx.ui.confirm("Confirm TeX citation insertion", `Insert \\cite{${keys.join(",")}} at ${loc.file}:${loc.line}?\n\n${loc.snippet}`);
    if (!ok) return `BibTeX ready in ${bibRel} as ${keys.join(", ")}; TeX unchanged.${keepNote}`;
  }

  const citeCommand = inferCiteCommand(map);
  const texAbs = path.join(ctx.cwd, loc.file);
  const tex = await readText(texAbs);
  const inserted = insertCitationIntoText(tex, loc, citeCommand, keys.join(","));
  if (inserted.changed) await fs.writeFile(texAbs, inserted.text);
  await writeMap(ctx.cwd, await buildPaperMap(ctx.cwd));
  return `${toAppend.length ? "Added" : "Reused"} ${keys.join(", ")} in ${bibRel}. ${inserted.note}${keepNote}`;
}

async function insertCitationCandidate(ctx: ExtensionContext, map: PaperMap, candidate: CitationCandidate, prompt: string): Promise<string> {
  return insertCitationCandidates(ctx, map, [candidate], prompt);
}
function fuzzySubsequenceScore(query: string, text: string): number {
  const q = normalizeSpace(query).toLowerCase();
  if (!q) return 1;
  const t = normalizeSpace(text).toLowerCase();
  if (t.includes(q)) return 100 + q.length;
  let qi = 0;
  let score = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { qi++; score += 3; }
  }
  return qi === q.length ? score : 0;
}

function citationSearchHaystack(c: CitationCandidate): string {
  return [c.key, c.title, c.authors.join(" "), c.year, c.venue, c.doi, c.url, c.source].filter(Boolean).join(" ");
}

function scoreGotoCitation(query: string, c: CitationCandidate): number {
  if (!query.trim()) return 1;
  const terms = searchTokens(query);
  const hay = citationSearchHaystack(c);
  let score = fuzzySubsequenceScore(query, hay);
  score += tokenScore(query, hay) * 100;
  if (c.key && c.key.toLowerCase().includes(query.toLowerCase())) score += 150;
  if (c.title.toLowerCase().includes(query.toLowerCase())) score += 100;
  for (const term of terms) {
    if ((c.key ?? "").toLowerCase().includes(term)) score += 30;
    if (c.title.toLowerCase().includes(term)) score += 20;
    if ((c.venue ?? "").toLowerCase().includes(term)) score += 12;
  }
  return score;
}

class GotoCitationPicker implements Focusable {
  private query: string;
  private selected = 0;
  private _focused = false;
  constructor(private tui: TUI, private theme: any, private candidates: CitationCandidate[], initialQuery: string, private done: (c: CitationCandidate | null) => void) {
    this.query = initialQuery.trim();
  }
  get focused() { return this._focused; }
  set focused(v: boolean) { this._focused = v; }
  invalidate(): void {}
  private matches(): CitationCandidate[] {
    const ranked = this.candidates
      .map(c => ({ c, score: scoreGotoCitation(this.query, c) }))
      .filter(x => !this.query || x.score > 0)
      .sort((a, b) => b.score - a.score || (a.c.key ?? a.c.title).localeCompare(b.c.key ?? b.c.title))
      .map(x => x.c);
    if (this.selected >= ranked.length) this.selected = Math.max(0, ranked.length - 1);
    return ranked;
  }
  render(width: number): string[] {
    const matches = this.matches();
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", "─".repeat(width)));
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Go to citation")) + this.theme.fg("dim", "  type search • j/k move • enter open • q cancel"), width));
    lines.push(truncateToWidth(`search: ${this.query || this.theme.fg("dim", "(all local bib entries)")}`, width));
    lines.push(this.theme.fg("accent", "─".repeat(width)));
    if (!matches.length) lines.push(this.theme.fg("warning", "No matching local BibTeX entries."));
    for (let i = 0; i < Math.min(matches.length, Math.max(5, this.tui.terminal.rows - 8)); i++) {
      const c = matches[i];
      const marker = i === this.selected ? "▶" : " ";
      const key = c.key ? `[${c.key}] ` : "";
      const where = [c.year, c.venue].filter(Boolean).join(" • ");
      const line = `${marker} ${key}${c.authors[0]?.split(/\s+/).slice(-1)[0] ?? ""}${c.authors.length ? ": " : ""}${c.title}${where ? ` — ${where}` : ""}`;
      lines.push(truncateToWidth(i === this.selected ? this.theme.bg("selectedBg", this.theme.fg("accent", line)) : line, width));
    }
    const selected = matches[this.selected];
    if (selected) {
      lines.push(this.theme.fg("accent", "─".repeat(width)));
      lines.push(truncateToWidth(this.theme.fg("dim", bestCitationUrl(selected) ?? "No DOI/URL/arXiv/title URL available"), width));
    }
    lines.push(this.theme.fg("accent", "─".repeat(width)));
    return lines;
  }
  handleInput(data: string): void {
    const ch = printableKey(data);
    const matches = this.matches();
    if (matchesKey(data, Key.escape) || ch === "q") { this.done(null); return; }
    if (matchesKey(data, Key.enter)) { this.done(matches[this.selected] ?? null); return; }
    if (ch === "j" || matchesKey(data, Key.down)) { this.selected = Math.min(Math.max(0, matches.length - 1), this.selected + 1); this.tui.requestRender(); return; }
    if (ch === "k" || matchesKey(data, Key.up)) { this.selected = Math.max(0, this.selected - 1); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.backspace) || data.includes("\x7f") || data.includes("\x08")) { this.query = this.query.slice(0, -1); this.selected = 0; this.tui.requestRender(); return; }
    if (ch && ch.length === 1 && !/^[jkq]$/.test(ch)) { this.query += ch; this.selected = 0; this.tui.requestRender(); return; }
    if (matchesKey(data, Key.space)) { this.query += " "; this.selected = 0; this.tui.requestRender(); return; }
  }
}

async function localGotoCitationCandidates(ctx: ExtensionContext, query: string): Promise<CitationCandidate[]> {
  const map = await loadOrBuildMap(ctx);
  const entries = await loadBibEntries(ctx.cwd, map);
  return entries.map(e => bibEntryToCandidate(e, query)).sort((a, b) => (a.key ?? a.title).localeCompare(b.key ?? b.title));
}

async function localBibEntriesForEdit(ctx: ExtensionContext): Promise<BibEntry[]> {
  const map = await loadOrBuildMap(ctx);
  return await loadBibEntries(ctx.cwd, map);
}

function rankBibEntries(entries: BibEntry[], query: string): BibEntry[] {
  const candidates = entries.map(e => bibEntryToCandidate(e, query));
  const byKey = new Map(candidates.map(c => [c.key, c]));
  return entries
    .map(e => ({ e, score: scoreGotoCitation(query, byKey.get(e.key) ?? bibEntryToCandidate(e, query)) }))
    .filter(x => !query.trim() || x.score > 0 || x.e.key === query.trim())
    .sort((a, b) => b.score - a.score || a.e.key.localeCompare(b.e.key))
    .map(x => x.e);
}

async function saveBibEntryEdit(ctx: ExtensionContext, e: BibEntry, newRaw: string): Promise<string> {
  const abs = path.join(ctx.cwd, e.file);
  const source = await readText(abs);
  const first = source.indexOf(e.raw);
  if (first < 0) throw new Error(`Could not find the original BibTeX entry ${e.key} in ${e.file}.`);
  if (source.indexOf(e.raw, first + e.raw.length) >= 0) throw new Error(`BibTeX entry source is not unique in ${e.file}; refusing automatic replacement.`);
  const replacement = restoreLineEndingsForSource(newRaw, source);
  await fs.writeFile(abs, source.slice(0, first) + replacement + source.slice(first + e.raw.length));
  await writeMap(ctx.cwd, await buildPaperMap(ctx.cwd));
  return `${e.file}:${e.line}`;
}

async function openCitationEditor(ctx: ExtensionContext, e: BibEntry): Promise<string | null> {
  if (!ctx.hasUI) return null;
  const editorText = normalizeEditorLineEndings(e.raw);
  let rendered: { base64: string; note?: string } | null = null;
  let renderError: string | null = null;
  try { rendered = await renderCitationPreviewPng(ctx, editorText, Math.floor((process.stdout.columns || 100) * 0.9)); }
  catch (err) { renderError = err instanceof Error ? err.message : String(err); }
  suppressAssistantLatexPreviewImages++;
  process.stdout.write(deleteAllKittyImages());
  try {
    const edited = await openUniformPopupEditor(ctx, {
      title: `Edit citation ${e.key} (${e.file}:${e.line})`,
      initialText: editorText,
      help: "Same edit keys as the prompt. Ctrl+R refreshes preview; :w writes+refreshes; :wq/Ctrl+S saves and closes; Ctrl+C/:q cancels.",
      renderPreview: (width: number) => {
        const lines: string[] = [];
        lines.push(truncateToWidth(`Formatted reference preview: ${e.key}`, width));
        if (rendered) {
          if (rendered.note) lines.push(truncateToWidth(rendered.note, width));
          const previewWidth = scaledLatexPreviewWidth(width, 4);
          lines.push(...new AspectRatioLatexImage(rendered.base64, previewWidth, { fallbackColor: (s: string) => s }).render(width));
        } else {
          lines.push("Could not render the formatted reference preview; falling back to BibTeX source.");
          lines.push((renderError ?? "unknown render error").slice(0, 1200));
        }
        return lines;
      },
      onRefresh: async (text, setStatus) => {
        setStatus("Rendering formatted reference preview...");
        try {
          rendered = await renderCitationPreviewPng(ctx, text, scaledLatexPreviewWidth(process.stdout.columns || 100, 4));
          renderError = null;
          const parsed = parseBibEntries(text, "preview")[0];
          setStatus(`Reference preview refreshed${parsed?.key ? ` for ${parsed.key}` : ""}. Ctrl+S or :wq saves; :w writes and stays open.`);
        } catch (err) {
          rendered = null;
          renderError = err instanceof Error ? err.message : String(err);
          setStatus("Reference preview render failed; fix BibTeX and Ctrl+R again.");
        }
      },
      onWrite: async (text, setStatus) => {
        setStatus("Writing BibTeX and refreshing preview...");
        const replacement = restoreLineEndingsForSource(text, e.raw);
        const where = await saveBibEntryEdit(ctx, e, replacement);
        e.raw = replacement;
        try {
          rendered = await renderCitationPreviewPng(ctx, text, scaledLatexPreviewWidth(process.stdout.columns || 100, 4));
          renderError = null;
          const parsed = parseBibEntries(text, "preview")[0];
          setStatus(`Wrote ${where}${parsed?.key ? ` (${parsed.key})` : ""}; preview refreshed.`);
        } catch (err) {
          rendered = null;
          renderError = err instanceof Error ? err.message : String(err);
          setStatus(`Wrote ${where}; preview render failed.`);
        }
      },
    });
    return edited === null ? null : restoreLineEndingsForSource(edited, e.raw);
  } finally {
    suppressAssistantLatexPreviewImages = Math.max(0, suppressAssistantLatexPreviewImages - 1);
    process.stdout.write(deleteAllKittyImages());
  }
}

function rankGotoCitationCandidates(candidates: CitationCandidate[], query: string): CitationCandidate[] {
  return candidates
    .map(c => ({ c, score: scoreGotoCitation(query, c) }))
    .filter(x => !query.trim() || x.score > 0)
    .sort((a, b) => b.score - a.score || (a.c.key ?? a.c.title).localeCompare(b.c.key ?? b.c.title))
    .map(x => x.c);
}

function citationCommandAutocompleteItems(command: string, candidates: CitationCandidate[], query: string): AutocompleteItem[] {
  return rankGotoCitationCandidates(candidates, query).slice(0, 12).map(c => ({
    value: `${command} ${c.key ?? c.title}`,
    label: c.key ?? c.title,
    description: `${c.title}${c.year ? ` (${c.year})` : ""}${c.venue ? ` — ${c.venue}` : ""}`,
  }));
}

function gotoCitationAutocompleteItems(candidates: CitationCandidate[], query: string): AutocompleteItem[] {
  return citationCommandAutocompleteItems("mechgotocite", candidates, query);
}

function equationSearchText(e: EquationInfo): string {
  return [e.label, ...(e.labels ?? []), ...(e.numbers ?? []).map(n => n.number), ...(e.tags ?? []), e.env, e.file, e.tex].filter(Boolean).join(" ");
}

function scoreEquationQuery(query: string, e: EquationInfo): number {
  if (!query.trim()) return e.labels?.length || e.label ? 2 : 1;
  const q = query.replace(/^eq:/i, "").replace(/^number:/i, "").replace(/^contains:/i, "").trim();
  const labels = e.labels ?? (e.label ? [e.label] : []);
  let score = fuzzySubsequenceScore(q, equationSearchText(e));
  score += tokenScore(q, equationSearchText(e)) * 80;
  if (labels.some(label => label === query || label === q || label.endsWith(q))) score += 500;
  if ((e.numbers ?? []).some(n => sameEquationNumber(n.number, q)) || (e.tags ?? []).some(t => sameEquationNumber(t, q))) score += 500;
  if (e.tex.includes(q)) score += 120;
  return score;
}

function rankEquations(equations: EquationInfo[], query: string): EquationInfo[] {
  return equations
    .map(e => ({ e, score: scoreEquationQuery(query, e) }))
    .filter(x => !query.trim() || x.score > 0)
    .sort((a, b) => b.score - a.score || (a.e.label ?? a.e.file).localeCompare(b.e.label ?? b.e.file))
    .map(x => x.e);
}

function equationAutocompleteItems(equations: EquationInfo[], query: string): AutocompleteItem[] {
  return rankEquations(equations, query).slice(0, 12).map(e => {
    const labels = e.labels ?? (e.label ? [e.label] : []);
    const label = labels[0] ?? (e.numbers?.[0]?.number ? `number:${e.numbers[0].number}` : `${e.file}:${e.lineStart}`);
    const value = labels[0] ? `mecheqedit ${labels[0]}` : e.numbers?.[0]?.number ? `mecheqedit number:${e.numbers[0].number}` : `mecheqedit contains:${equationOnlyPreview(e.tex).slice(0, 48)}`;
    return { value, label, description: `${e.file}:${e.lineStart}-${e.lineEnd} • ${equationNumberSummary(e)} • ${equationOnlyPreview(e.tex).slice(0, 120)}` };
  });
}

type MechIngestItemType = "bib" | "file";
type MechIngestItem = { id: string; type: MechIngestItemType; label: string; description: string; path?: string; bib?: BibEntry };
type MechIngestSource = { id: string; label: string; type: string; original?: string; stored?: string; status: string; note?: string };
type MechIngestManifest = { selectedIds: string[]; sources: MechIngestSource[]; updatedAt: string; embedding?: MechIngestEmbeddingInfo; retrievalNote?: string };
type MechIngestEmbeddingInfo = { provider: string; model: string; dimensions: number };
type MechIngestChunk = { id: string; sourceId: string; label: string; text: string; tokens: string[]; embedding?: number[] };
type MechIngestStore = { version: 2; updatedAt: string; chunks: MechIngestChunk[]; embedding?: MechIngestEmbeddingInfo; retrievalNote?: string };
type MechEmbeddingResult = { info: MechIngestEmbeddingInfo; embeddings: number[][] };
type MechIngestProgress = (fraction: number, message: string) => void;

function mechIngestRoot(cwd: string): string { return path.join(cwd, ".mechpi", "ingest"); }
function mechIngestManifestPath(cwd: string): string { return path.join(mechIngestRoot(cwd), "manifest.json"); }
function mechIngestStorePath(cwd: string): string { return path.join(mechIngestRoot(cwd), "vector-store.json"); }
function mechIngestAgentsPath(cwd: string): string { return path.join(cwd, "AGENTS.md"); }
function hashId(s: string): string { return createHash("sha1").update(s).digest("hex").slice(0, 16); }
function mechIngestProgressBar(fraction: number, width = 18): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(clamped * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${Math.round(clamped * 100).toString().padStart(3, " ")}%`;
}
function shortProgressLabel(s: string, max = 58): string {
  const clean = normalizeSpace(s);
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

const MECHPI_INGEST_AGENTS_START = "<!-- MECHPI_INGEST_GUIDANCE_START -->";
const MECHPI_INGEST_AGENTS_END = "<!-- MECHPI_INGEST_GUIDANCE_END -->";

function mechIngestAgentsBlock(): string {
  return [
    MECHPI_INGEST_AGENTS_START,
    "## Mech-pi ingest retrieval",
    "",
    "When `.mechpi/ingest/vector-store.json` exists, treat it as the first-pass text-embedding retrieval cache for questions about ingested references, background papers, and remembered phrases.",
    "",
    "- First use the `MECH-PI INGESTED REFERENCE CONTEXT` already injected into the prompt; answer from it when it is sufficient.",
    "- Do not run broad filesystem searches just to duplicate vector-store retrieval. If the injected context is insufficient, inspect `.mechpi/ingest/manifest.json`, `.mechpi/ingest/vector-store.json`, or `.mechpi/ingest/text/` before using wider `find`/`rg` searches.",
    "- Use source files after retrieval only to verify exact quotations, line numbers, or manuscript source-of-truth claims.",
    "- For manuscript mechanics claims, the TeX source and `.mechpi/paper-map.json` still override retrieved reference chunks.",
    MECHPI_INGEST_AGENTS_END,
  ].join("\n");
}

async function ensureMechIngestAgentsGuidance(cwd: string): Promise<"created" | "updated" | "unchanged"> {
  const file = mechIngestAgentsPath(cwd);
  const block = mechIngestAgentsBlock();
  let existing = "";
  let hadFile = true;
  try { existing = await readText(file); } catch { hadFile = false; }
  const marked = new RegExp(`${MECHPI_INGEST_AGENTS_START}[\\s\\S]*?${MECHPI_INGEST_AGENTS_END}`);
  const next = !hadFile || !existing.trim()
    ? `# AGENTS.md\n\n${block}\n`
    : marked.test(existing)
      ? existing.replace(marked, block)
      : `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
  if (hadFile && next === existing) return "unchanged";
  await fs.writeFile(file, next);
  return hadFile ? "updated" : "created";
}
function ingestTokenize(s: string): string[] { return searchTokens(s).filter(t => t.length >= 3).slice(0, 2000); }
function ingestTextExtensions(): Set<string> { return new Set([".txt", ".md", ".markdown", ".rst", ".tex", ".bib", ".csv", ".json", ".yaml", ".yml", ".log", ".html", ".htm"]); }
function ingestDocumentExtensions(): Set<string> { return new Set([...ingestTextExtensions(), ".pdf", ".docx"]); }

async function loadIngestManifest(cwd: string): Promise<MechIngestManifest> {
  try {
    const parsed = JSON.parse(await readText(mechIngestManifestPath(cwd))) as MechIngestManifest;
    return { selectedIds: parsed.selectedIds ?? [], sources: parsed.sources ?? [], updatedAt: parsed.updatedAt ?? new Date(0).toISOString(), embedding: parsed.embedding, retrievalNote: parsed.retrievalNote };
  } catch { return { selectedIds: [], sources: [], updatedAt: new Date(0).toISOString() }; }
}

async function writeIngestManifest(cwd: string, manifest: MechIngestManifest): Promise<void> {
  await fs.mkdir(mechIngestRoot(cwd), { recursive: true });
  await fs.writeFile(mechIngestManifestPath(cwd), JSON.stringify(manifest, null, 2));
}

function bibEntrySearchText(e: BibEntry): string {
  return [e.key, e.fields.title, e.fields.author, e.fields.year, e.fields.journal, e.fields.journaltitle, e.fields.booktitle, e.fields.doi, e.fields.url, e.fields.keywords].filter(Boolean).join(" ");
}

function bibToIngestItem(e: BibEntry): MechIngestItem {
  const title = normalizeSpace(e.fields.title ?? e.key);
  const year = e.fields.year ?? e.fields.date?.match(/\d{4}/)?.[0] ?? "";
  const venue = e.fields.journal ?? e.fields.journaltitle ?? e.fields.booktitle ?? "";
  return { id: `bib:${e.file}:${e.key}`, type: "bib", label: `${e.key}: ${title}`, description: [year, venue, e.fields.doi].filter(Boolean).join(" • "), bib: e };
}

function fileToIngestItem(cwd: string, abs: string): MechIngestItem {
  const rel = path.relative(cwd, abs);
  return { id: `file:${rel}`, type: "file", label: rel, description: path.extname(rel).slice(1).toUpperCase() || "file", path: rel };
}

function scoreIngestItem(query: string, item: MechIngestItem): number {
  if (!query.trim()) return item.type === "bib" ? 2 : 1;
  const hay = `${item.label} ${item.description} ${item.path ?? ""} ${item.bib ? bibEntrySearchText(item.bib) : ""}`;
  return scoreGotoCitation(query, { id: item.id, title: item.label, authors: [], venue: item.description, source: item.type, status: "partial", score: 0, notes: [], key: item.bib?.key, doi: normalizeDoi(item.bib?.fields.doi), url: item.bib?.fields.url });
}

function mechIngestAutocompleteItems(items: MechIngestItem[], query: string): AutocompleteItem[] {
  return items
    .map(item => ({ item, score: scoreIngestItem(query, item) }))
    .filter(x => !query.trim() || x.score > 0)
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    .slice(0, 12)
    .map(({ item }) => ({ value: `mechingest ${item.label}`, label: item.label, description: `[${item.type}] ${item.description}` }));
}

async function discoverMechIngestItems(ctx: ExtensionContext): Promise<MechIngestItem[]> {
  const map = await loadOrBuildMap(ctx);
  const bibEntries = await loadBibEntries(ctx.cwd, map);
  const items = bibEntries.map(bibToIngestItem);
  const exts = ingestDocumentExtensions();
  const files = (await walk(ctx.cwd).catch(() => []))
    .filter(abs => !abs.includes(`${path.sep}.mechpi${path.sep}`) && exts.has(path.extname(abs).toLowerCase()))
    .map(abs => fileToIngestItem(ctx.cwd, abs));
  return [...items, ...files];
}

function ingestSourceTextPath(cwd: string, sourceId: string): string { return path.join(mechIngestRoot(cwd), "text", `${hashId(sourceId)}.txt`); }

async function loadIngestSourceText(cwd: string, source: MechIngestSource): Promise<string> {
  return await readText(ingestSourceTextPath(cwd, source.id)).catch(() => "");
}

async function generateIngestSourceSummary(ctx: ExtensionContext, source: MechIngestSource): Promise<string> {
  const text = await loadIngestSourceText(ctx.cwd, source);
  const fallback = text.trim()
    ? normalizeSpace(text).slice(0, 1200)
    : `No extracted text found for ${source.label}. Status: ${source.status}${source.note ? `. ${source.note}` : ""}`;
  if (!ctx.model || !text.trim()) return fallback;
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok || !auth.apiKey) return fallback;
    const msg: Message = { role: "user", timestamp: Date.now(), content: [{ type: "text", text: `Write one concise paragraph summarizing this ingested document for verification. Use only the extracted text below; do not invent facts. Mention the apparent title/authors if visible.\n\nSource label: ${source.label}\nStored file: ${source.stored ?? source.original ?? ""}\nExtracted text:\n${text.slice(0, 6000)}` }] };
    const r = await complete(ctx.model, { systemPrompt: "You summarize ingested source documents conservatively from supplied extracted text only.", messages: [msg] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal });
    return r.content.filter((x): x is { type: "text"; text: string } => x.type === "text").map(x => x.text).join("\n").trim() || fallback;
  } catch { return fallback; }
}

class MechIngestPicker implements Focusable {
  private query: string;
  private selected = 0;
  private checked: Set<string>;
  private ingested: Set<string>;
  private sourceById: Map<string, MechIngestSource>;
  private mode: "list" | "detail" = "list";
  private searchEditing = false;
  private loadingSummary = false;
  private summaries = new Map<string, string>();
  private _focused = false;
  constructor(private ctx: ExtensionContext, private tui: TUI, private theme: any, private items: MechIngestItem[], initialQuery: string, manifest: MechIngestManifest, private done: (ids: string[] | null) => void) {
    this.query = initialQuery.trim();
    this.checked = new Set(manifest.selectedIds ?? []);
    this.sourceById = new Map((manifest.sources ?? []).map(s => [s.id, s]));
    this.ingested = new Set((manifest.sources ?? []).filter(s => s.status === "ok").map(s => s.id));
  }
  get focused() { return this._focused; }
  set focused(v: boolean) { this._focused = v; }
  invalidate(): void {}
  private matches(): MechIngestItem[] {
    const ranked = this.items
      .map(item => ({ item, score: scoreIngestItem(this.query, item) }))
      .filter(x => !this.query || x.score > 0)
      .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
      .map(x => x.item);
    if (this.selected >= ranked.length) this.selected = Math.max(0, ranked.length - 1);
    return ranked;
  }
  private selectedItem(): MechIngestItem | undefined { return this.matches()[this.selected]; }
  private selectedSource(): MechIngestSource | undefined { const item = this.selectedItem(); return item ? this.sourceById.get(item.id) : undefined; }
  private checkMark(item: MechIngestItem): string {
    if (!this.checked.has(item.id)) return " ";
    return this.ingested.has(item.id) ? this.theme.fg("success", "✓") : this.theme.fg("dim", "✓");
  }
  private showDetail(source: MechIngestSource | undefined): void {
    this.mode = "detail";
    if (!source) { this.tui.requestRender(); return; }
    if (!this.summaries.has(source.id) && !this.loadingSummary) {
      this.loadingSummary = true;
      generateIngestSourceSummary(this.ctx, source)
        .then(s => this.summaries.set(source.id, s))
        .finally(() => { this.loadingSummary = false; this.tui.requestRender(); });
    }
    this.tui.requestRender();
  }
  private finish(ids: string[] | null): void {
    this.done(ids);
    setTimeout(() => this.tui.requestRender(true), 0);
  }
  private openSourceDocument(source: MechIngestSource | undefined): void {
    const rel = source?.stored ?? source?.original;
    if (!rel) { this.ctx.ui.notify("No stored source document is available for this item.", "warning"); return; }
    const abs = path.isAbsolute(rel) ? rel : path.join(this.ctx.cwd, rel);
    if (!fss.existsSync(abs)) { this.ctx.ui.notify(`Source document not found: ${rel}`, "warning"); return; }
    const opener = process.env.MECHPI_DOCUMENT_VIEWER ?? process.env.MECHPI_PDF_VIEWER ?? "xdg-open";
    try {
      spawn(opener, [abs], { cwd: this.ctx.cwd, detached: true, stdio: "ignore" }).unref();
      this.ctx.ui.notify(`Opening ${rel} with ${opener}`, "info");
    } catch (err) {
      this.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }
  render(width: number): string[] {
    const matches = this.matches();
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", "─".repeat(width)));
    if (this.mode === "list") {
      const staged = Array.from(this.checked).filter(id => !this.ingested.has(id)).length;
      lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(`Mech ingest (${this.checked.size} selected, ${staged} staged)`)) + this.theme.fg("dim", this.searchEditing ? "  SEARCH • type/edit • enter selector • j/q quit" : "  selector • esc search • space stage • l summary • enter rebuild • h/q cancel"), width));
      const searchText = this.query || this.theme.fg("dim", "(all .bib refs and local documents)");
      lines.push(truncateToWidth(`${this.theme.fg("success", "✓")} ingested   ${this.theme.fg("dim", "✓")} staged   ${this.searchEditing ? this.theme.fg("accent", "search>") : "search:"} ${searchText}${this.searchEditing ? this.theme.fg("accent", "▌") : ""}`, width));
      lines.push(this.theme.fg("accent", "─".repeat(width)));
      const max = Math.max(6, this.tui.terminal.rows - 8);
      for (let i = 0; i < Math.min(matches.length, max); i++) {
        const item = matches[i];
        const source = this.sourceById.get(item.id);
        const status = source?.status && source.status !== "ok" ? ` ${this.theme.fg("warning", `[${source.status}]`)}` : "";
        const line = `${i === this.selected ? "▶" : " "} ${this.checkMark(item)} [${item.type}] ${item.label}${item.description ? ` — ${item.description}` : ""}${status}`;
        lines.push(truncateToWidth(i === this.selected ? this.theme.bg("selectedBg", this.theme.fg("accent", line)) : line, width));
      }
      if (!matches.length) lines.push(this.theme.fg("warning", "No matches."));
    } else if (this.mode === "detail") {
      const item = this.selectedItem();
      const source = this.selectedSource();
      lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Ingested document summary")) + this.theme.fg("dim", "  h list • l open document • space stage/unstage • enter rebuild • q cancel"), width));
      lines.push(truncateToWidth(`${item?.label ?? "(none)"}`, width));
      if (!source) {
        lines.push(this.theme.fg("warning", "This item is staged or not yet ingested; no stored source/text is available to preview."));
      } else {
        lines.push(truncateToWidth(`status: ${source.status}${source.stored ? ` • stored: ${source.stored}` : ""}`, width));
        if (source.note) lines.push(truncateToWidth(this.theme.fg("dim", source.note), width));
        lines.push("");
        const summary = this.summaries.get(source.id) ?? (this.loadingSummary ? "Generating summary from extracted text..." : "No summary available.");
        for (const p of wrapPlain(summary, width)) lines.push(p);
      }
    }
    lines.push(this.theme.fg("accent", "─".repeat(width)));
    return lines;
  }
  handleInput(data: string): void {
    const ch = printableKey(data);
    const matches = this.matches();
    if (this.mode === "list" && this.searchEditing) {
      if (matchesKey(data, Key.enter)) { this.searchEditing = false; this.tui.requestRender(); return; }
      if (ch === "j" || ch === "q") { this.finish(null); return; }
      if (matchesKey(data, Key.escape)) { this.finish(null); return; }
      if (matchesKey(data, Key.backspace) || data.includes("\x7f") || data.includes("\x08")) { this.query = this.query.slice(0, -1); this.selected = 0; this.tui.requestRender(); return; }
      if (matchesKey(data, Key.space)) { this.query += " "; this.selected = 0; this.tui.requestRender(); return; }
      if (ch && ch.length === 1) { this.query += ch; this.selected = 0; this.tui.requestRender(); return; }
      return;
    }
    if (matchesKey(data, Key.escape) && this.mode === "list") { this.searchEditing = true; this.tui.requestRender(); return; }
    if (matchesKey(data, Key.escape) || ch === "q" || (this.mode === "list" && (ch === "h" || matchesKey(data, Key.left)))) { this.finish(null); return; }
    if (matchesKey(data, Key.enter)) { this.finish(Array.from(this.checked)); return; }
    if (this.mode === "detail") {
      if (ch === "h" || matchesKey(data, Key.left)) { this.mode = "list"; this.searchEditing = false; this.tui.requestRender(); return; }
      if (ch === "l" || matchesKey(data, Key.right)) { this.openSourceDocument(this.selectedSource()); return; }
    }
    if (matchesKey(data, Key.space)) {
      const item = matches[this.selected];
      if (item) this.checked.has(item.id) ? this.checked.delete(item.id) : this.checked.add(item.id);
      this.tui.requestRender(); return;
    }
    if (this.mode === "detail") return;
    if (ch === "j" || matchesKey(data, Key.down) || matchesKey(data, Key.tab)) { this.selected = Math.min(Math.max(0, matches.length - 1), this.selected + 1); this.tui.requestRender(); return; }
    if (ch === "k" || matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab"))) { this.selected = Math.max(0, this.selected - 1); this.tui.requestRender(); return; }
    if (ch === "l" || matchesKey(data, Key.right)) { this.showDetail(this.selectedSource()); return; }
    if (matchesKey(data, Key.backspace) || data.includes("\x7f") || data.includes("\x08")) { this.query = this.query.slice(0, -1); this.selected = 0; this.tui.requestRender(); return; }
    if (ch && ch.length === 1 && !/^[jkqlh]$/.test(ch)) { this.query += ch; this.selected = 0; this.tui.requestRender(); return; }
  }
}

function chunkTextForIngest(text: string, sourceId: string, label: string): MechIngestChunk[] {
  const clean = normalizeSpace(text).replace(/\f/g, " ");
  const chunks: MechIngestChunk[] = [];
  const size = 1400;
  const overlap = 180;
  for (let start = 0, index = 0; start < clean.length; start += size - overlap, index++) {
    const part = clean.slice(start, start + size).trim();
    if (part.length < 80) continue;
    chunks.push({ id: `${sourceId}:chunk:${index}`, sourceId, label, text: part, tokens: unique(ingestTokenize(part)).slice(0, 300) });
  }
  return chunks;
}

async function cleanupIngestArtifactsForSource(cwd: string, sourceId: string): Promise<void> {
  const root = mechIngestRoot(cwd);
  for (const dir of [path.join(root, "sources"), path.join(root, "text"), path.join(root, "tmp")]) {
    const names = await fs.readdir(dir).catch(() => []);
    await Promise.all(names
      .filter(name => name === `${sourceId}.txt` || name === `${sourceId}.html` || name.startsWith(`${sourceId}-`))
      .map(name => fs.unlink(path.join(dir, name)).catch(() => {})));
  }
}

async function convertDocumentToText(cwd: string, relOrAbs: string, sourceId: string): Promise<{ text: string; stored?: string; note?: string }> {
  const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(cwd, relOrAbs);
  const root = mechIngestRoot(cwd);
  const sourceDir = path.join(root, "sources");
  const textDir = path.join(root, "text");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(textDir, { recursive: true });
  const ext = path.extname(abs).toLowerCase();
  const stored = path.join(sourceDir, `${sourceId}-${path.basename(abs)}`);
  await fs.copyFile(abs, stored).catch(async () => { if (abs !== stored) await fs.writeFile(stored, await fs.readFile(abs)); });
  const outText = path.join(textDir, `${sourceId}.txt`);
  if (ext === ".pdf") {
    const r = await run("pdftotext", [stored, outText], cwd).catch(e => ({ code: 1, stdout: "", stderr: String(e) }));
    let text = await readText(outText).catch(() => "");
    if (r.code !== 0 || text.trim().length < 80) {
      return { text, stored: path.relative(cwd, stored), note: "PDF text extraction was weak/failed; OCR is not yet available unless pdftotext can read embedded text." };
    }
    return { text, stored: path.relative(cwd, stored) };
  }
  if (ext === ".docx" && commandExists("pandoc")) {
    const r = await run("pandoc", [stored, "-t", "plain", "-o", outText], cwd).catch(e => ({ code: 1, stdout: "", stderr: String(e) }));
    return { text: await readText(outText).catch(() => ""), stored: path.relative(cwd, stored), note: r.code === 0 ? undefined : "pandoc failed for docx conversion" };
  }
  let text = await readText(stored).catch(() => "");
  if (ext === ".html" || ext === ".htm") text = decodeHtml(text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
  await fs.writeFile(outText, text).catch(() => {});
  return { text, stored: path.relative(cwd, stored) };
}

type BibPaperMetadata = { title?: string; venue?: string; year?: string; doi?: string; authors: string[]; source: string; kind?: "journal-article" | "article-like" | "other" };
type LocalDocumentSearchResult = { path?: string; note?: string; alternatives?: { path: string; score: number }[] };

function bibPaperMetadata(e: BibEntry): BibPaperMetadata {
  const authors = normalizeSpace(e.fields.author ?? "").split(/\s+and\s+/i).map(a => normalizeSpace(a)).filter(Boolean);
  return {
    title: normalizeSpace(e.fields.title ?? "") || undefined,
    venue: normalizeSpace(e.fields.journal ?? e.fields.journaltitle ?? e.fields.booktitle ?? "") || undefined,
    year: e.fields.year ?? e.fields.date?.match(/\d{4}/)?.[0],
    doi: normalizeDoi(e.fields.doi),
    authors,
    source: "BibTeX",
    kind: e.type.toLowerCase() === "article" && Boolean(e.fields.journal ?? e.fields.journaltitle) ? "journal-article" : e.type.toLowerCase() === "article" ? "article-like" : "other",
  };
}

function mergePaperMetadata(primary: BibPaperMetadata, secondary?: BibPaperMetadata | null): BibPaperMetadata {
  if (!secondary) return primary;
  return {
    title: secondary.title ?? primary.title,
    venue: secondary.venue ?? primary.venue,
    year: secondary.year ?? primary.year,
    doi: secondary.doi ?? primary.doi,
    authors: secondary.authors.length ? secondary.authors : primary.authors,
    source: `${primary.source}+${secondary.source}`,
    kind: secondary.kind ?? primary.kind,
  };
}

async function fetchDoiMetadata(doi: string | undefined, signal?: AbortSignal): Promise<BibPaperMetadata | null> {
  if (!doi) return null;
  const data = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, signal).catch(() => null);
  const item = data?.message;
  if (!item) return null;
  const title = normalizeSpace((item.title?.[0] ?? "").replace(/<[^>]+>/g, "")) || undefined;
  const venue = normalizeSpace(item["container-title"]?.[0] ?? item.publisher ?? "") || undefined;
  const year = String(item.published?.["date-parts"]?.[0]?.[0] ?? item.issued?.["date-parts"]?.[0]?.[0] ?? "") || undefined;
  const authors = (item.author ?? []).map((a: any) => normalizeSpace([a.given, a.family].filter(Boolean).join(" "))).filter(Boolean);
  return { title, venue, year, doi: normalizeDoi(item.DOI) ?? doi, authors, source: "Crossref DOI metadata", kind: item.type === "journal-article" ? "journal-article" : "article-like" };
}

function bibDocumentHints(e: BibEntry, metadata = bibPaperMetadata(e)): string[] {
  return unique([e.key, metadata.title, metadata.doi, e.fields.url, metadata.venue, metadata.year, ...metadata.authors]
    .filter(Boolean)
    .flatMap(s => searchTokens(String(s)).slice(0, 10)));
}

function metadataTitleTokens(metadata: BibPaperMetadata): string[] {
  return unique(searchTokens(metadata.title ?? "").filter(t => t.length >= 4)).slice(0, 14);
}

function metadataVenueTokens(metadata: BibPaperMetadata): string[] {
  return unique(searchTokens(metadata.venue ?? "").filter(t => t.length >= 4)).slice(0, 8);
}

function authorFamilyTokens(metadata: BibPaperMetadata): string[] {
  return unique(metadata.authors.map(a => {
    const clean = normalizeSpace(a).replace(/[{}]/g, "");
    const family = clean.includes(",") ? clean.split(",")[0] : clean.split(/\s+/).filter(Boolean).pop() ?? "";
    return family.replace(/[^A-Za-z0-9-]/g, "").toLowerCase();
  }).filter(a => a.length >= 4 && !/^[a-z]\.?$/.test(a))).slice(0, 8);
}

function homeFilenameHints(metadata: BibPaperMetadata): string[] {
  const title = metadataTitleTokens(metadata).filter(t => !new Set(["states", "state", "modeling", "model", "models", "constitutive", "journal", "elasticity"]).has(t));
  const doiParts = metadata.doi ? searchTokens(metadata.doi).filter(t => t.length >= 4) : [];
  return unique([...authorFamilyTokens(metadata), ...title.slice(0, 4), ...doiParts.slice(0, 4)]);
}

function compactForMatch(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, ""); }

async function documentProbeText(cwd: string, abs: string): Promise<string> {
  const ext = path.extname(abs).toLowerCase();
  const base = path.basename(abs);
  if (ext === ".pdf") {
    const info = commandExists("pdfinfo") ? (await run("pdfinfo", [abs], cwd).catch(() => ({ code: 1, stdout: "", stderr: "" }))).stdout : "";
    const text = commandExists("pdftotext") ? (await run("pdftotext", ["-f", "1", "-l", "5", abs, "-"], cwd).catch(() => ({ code: 1, stdout: "", stderr: "" }))).stdout : "";
    return `${base}\n${info.slice(0, 4000)}\n${text.slice(0, 20000)}`;
  }
  if (ext === ".docx" && commandExists("pandoc")) {
    const r = await run("pandoc", [abs, "-t", "plain"], cwd).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    return `${base}\n${r.stdout.slice(0, 20000)}`;
  }
  const text = await readText(abs).catch(() => "");
  return `${base}\n${text.slice(0, 20000)}`;
}

function maxWindowTokenHits(hay: string, tokens: string[], window = 350): number {
  if (!tokens.length) return 0;
  const positions = tokens.map(t => ({ token: t, pos: hay.indexOf(t.toLowerCase()) })).filter(x => x.pos >= 0).sort((a, b) => a.pos - b.pos);
  let best = 0;
  for (const start of positions) {
    const seen = new Set<string>();
    for (const p of positions) if (p.pos >= start.pos && p.pos <= start.pos + window) seen.add(p.token);
    best = Math.max(best, seen.size);
  }
  return best;
}

function looksLikeSlideDeck(hay: string): boolean {
  const slideSignals = ["powerpoint", "slide deck", "presentation", "seminar", "workshop", "tutorial", "lecture", "agenda", "outline", "acknowledgements", "acknowledgments"];
  const signalHits = slideSignals.filter(s => hay.includes(s)).length;
  const pageSize = hay.match(/page size:\s*([0-9.]+)\s+x\s+([0-9.]+)\s+pts/i);
  const landscape = pageSize ? Number(pageSize[1]) > Number(pageSize[2]) * 1.15 : false;
  return signalHits >= 2 || (landscape && signalHits >= 1);
}

async function scoreDocumentForMetadata(cwd: string, metadata: BibPaperMetadata, abs: string): Promise<number> {
  const probe = await documentProbeText(cwd, abs);
  const hay = `${path.basename(abs)} ${probe}`.toLowerCase();
  const compactHay = compactForMatch(hay);
  const doiHit = Boolean(metadata.doi && compactHay.includes(compactForMatch(metadata.doi)));
  const title = normalizeSpace(metadata.title ?? "");
  const exactTitleHit = Boolean(title && compactHay.includes(compactForMatch(title)));
  const titleTokens = metadataTitleTokens(metadata);
  if (!titleTokens.length) return 0;
  const scatteredHits = titleTokens.filter(t => hay.includes(t.toLowerCase())).length;
  const windowHits = maxWindowTokenHits(hay, titleTokens);
  const windowRatio = windowHits / titleTokens.length;
  const venueTokens = metadataVenueTokens(metadata);
  const venueHits = venueTokens.filter(t => hay.includes(t.toLowerCase())).length;
  const authorHits = authorFamilyTokens(metadata).filter(t => hay.includes(t)).length;
  const yearHit = metadata.year && hay.includes(metadata.year) ? 1 : 0;
  const corroboration = Math.min(2, venueHits) + Math.min(2, authorHits) + yearHit;
  const slideDeck = looksLikeSlideDeck(hay);

  // Journal articles must look like the journal article, not a slide deck or a
  // talk with overlapping title words.  With a DOI in the BibTeX/Crossref data,
  // prefer the DOI.  Without a visible DOI, require exact/near-exact title plus
  // journal/author/year corroboration and reject presentation-like PDFs.
  if (metadata.kind === "journal-article") {
    if (slideDeck) return Math.max(scatteredHits / titleTokens.length, windowRatio);
    const nearCompleteTitle = windowHits >= Math.max(4, Math.ceil(titleTokens.length * 0.85));
    const articleCorroborated = venueHits > 0 || authorHits >= Math.min(2, Math.max(1, metadata.authors.length)) || (authorHits > 0 && yearHit > 0);
    // A DOI by itself is not enough: slide decks/books often include the DOI in
    // references.  For journal articles require the title plus author/venue/year
    // evidence in the extracted front matter.
    if (doiHit && (exactTitleHit || nearCompleteTitle) && articleCorroborated) return 100 + Math.min(10, corroboration);
    if (exactTitleHit && articleCorroborated) return 85 + Math.min(10, corroboration);
    if (nearCompleteTitle && venueHits > 0 && (authorHits > 0 || yearHit > 0)) return 70 + windowRatio * 10 + corroboration;
    return Math.max(scatteredHits / titleTokens.length, windowRatio);
  }

  if (doiHit && exactTitleHit) return 95 + Math.min(5, corroboration);
  if (exactTitleHit) return 80 + Math.min(10, corroboration);
  const compactBase = compactForMatch(path.basename(abs));
  const filenameHits = titleTokens.filter(t => compactBase.includes(compactForMatch(t))).length;
  const nearCompleteTitle = windowHits >= Math.max(3, Math.ceil(titleTokens.length * 0.80));
  const strongFilename = filenameHits >= Math.max(3, Math.ceil(titleTokens.length * 0.75));
  if (nearCompleteTitle && corroboration > 0) return 12 + windowRatio * 6 + corroboration;
  if (strongFilename && (windowHits >= 2 || corroboration > 0)) return 12 + (filenameHits / titleTokens.length) * 5 + corroboration;
  return Math.max(scatteredHits / titleTokens.length, windowRatio);
}

async function localDocumentMatchesMetadata(cwd: string, metadata: BibPaperMetadata, abs: string): Promise<boolean> {
  const score = await scoreDocumentForMetadata(cwd, metadata, abs).catch(() => 0);
  return score >= (metadata.kind === "journal-article" ? 70 : 12);
}

function explicitBibDocumentCandidates(cwd: string, e: BibEntry): string[] {
  const out: string[] = [];
  for (const field of ["file", "pdf"]) {
    const raw = e.fields[field];
    if (!raw) continue;
    for (const part of raw.split(/[;\n]+/).map(s => s.trim()).filter(Boolean)) {
      const pieces = part.split(":");
      const candidate = pieces.length >= 2 && /^[A-Za-z]+$/.test(pieces.at(-1) ?? "") ? pieces.slice(0, -1).join(":") : part.split(":").pop() ?? part;
      out.push(path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate));
    }
  }
  return unique(out);
}

async function findExplicitDocumentForBib(cwd: string, e: BibEntry, metadata: BibPaperMetadata): Promise<string | null> {
  for (const abs of explicitBibDocumentCandidates(cwd, e)) {
    if (await exists(abs) && await localDocumentMatchesMetadata(cwd, metadata, abs)) return abs;
  }
  return null;
}

function bibFileFieldValue(cwd: string, abs: string): string {
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
}

async function findHomeDocumentForBib(cwd: string, e: BibEntry, metadata: BibPaperMetadata): Promise<LocalDocumentSearchResult> {
  const home = process.env.HOME;
  if (!home) return { note: "$HOME is not set, so no local fallback search was possible." };
  const filenameHints = homeFilenameHints(metadata).filter(t => t.length >= 4).slice(0, 12);
  const hints = unique([...filenameHints, ...bibDocumentHints(e, metadata).filter(t => t.length >= 4).slice(0, 10)]);
  if (!hints.length) return { note: "No reliable BibTeX/DOI metadata tokens were available for a safe $HOME search." };
  const pattern = filenameHints.length ? filenameHints.map(escapeRegExp).join("|") : hints.map(escapeRegExp).join("| ").replace(/\| /g, "|");
  const prune = `\\( -path '*/.git/*' -o -path '*/node_modules/*' -o -path '*/.cache/*' -o -path '*/.mechpi/*' \\) -prune -o`;
  const typedFind = `find ${shellQuote(home)} ${prune} -type f \\( -iname '*.pdf' -o -iname '*.md' -o -iname '*.txt' -o -iname '*.docx' \\) -print 2>/dev/null`;
  const byNameLimit = Number.parseInt(process.env.MECHPI_HOME_SEARCH_NAME_LIMIT ?? "10000", 10);
  const broadLimit = Number.parseInt(process.env.MECHPI_HOME_SEARCH_LIMIT ?? "25000", 10);
  const byName = await run("bash", ["-lc", `${typedFind} | grep -Ei ${shellQuote(pattern)} | head -${Math.max(1, byNameLimit)}`], cwd).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const broad = await run("bash", ["-lc", `${typedFind} | head -${Math.max(1, broadLimit)}`], cwd).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const candidates = unique([...byName.stdout.split(/\r?\n/), ...broad.stdout.split(/\r?\n/)].filter(Boolean));
  const scored: { path: string; score: number }[] = [];
  for (const p of candidates) {
    const score = await scoreDocumentForMetadata(cwd, metadata, p).catch(() => 0);
    if (score >= (metadata.kind === "journal-article" ? 70 : 12)) scored.push({ path: p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return { note: `No $HOME candidate among ${candidates.length} checked file(s) matched metadata tightly enough (${metadata.title ?? metadata.doi ?? e.key}).` };
  const best = scored[0];
  const close = scored.filter(x => x.path !== best.path && best.score < 90 && Math.abs(best.score - x.score) < 1.0).slice(0, 4);
  if (close.length) {
    return { note: `Ambiguous $HOME matches; not ingesting without clarification. Best candidates: ${[best, ...close].map(x => `${x.path} (${x.score.toFixed(1)})`).join("; ")}`, alternatives: [best, ...close] };
  }
  return { path: best.path, alternatives: scored.slice(0, 5) };
}

function normalizeVector(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map(x => x / norm) : v;
}

function cosineSimilarity(a?: number[], b?: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return Number.NEGATIVE_INFINITY;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function parseEmbeddingResponse(raw: string, provider: string, model: string): MechEmbeddingResult {
  const parsed = JSON.parse(raw) as { embeddings?: unknown; data?: { embedding: number[] }[]; provider?: string; model?: string } | number[][];
  const embeddings = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.embeddings)
      ? parsed.embeddings
      : Array.isArray(parsed.data)
        ? parsed.data.map(x => x.embedding)
        : [];
  if (!Array.isArray(embeddings) || !embeddings.length || !embeddings.every(v => Array.isArray(v) && v.every(x => typeof x === "number"))) {
    throw new Error("embedding provider did not return a numeric embeddings array");
  }
  const normalized = embeddings.map(v => normalizeVector(v as number[]));
  return { info: { provider: Array.isArray(parsed) ? provider : parsed.provider ?? provider, model: Array.isArray(parsed) ? model : parsed.model ?? model, dimensions: normalized[0]?.length ?? 0 }, embeddings: normalized };
}

async function embedTexts(cwd: string, texts: string[], signal?: AbortSignal, existing?: MechIngestEmbeddingInfo): Promise<MechEmbeddingResult> {
  if (!texts.length) return { info: existing ?? { provider: "none", model: "none", dimensions: 0 }, embeddings: [] };
  const provider = (existing?.provider ?? process.env.MECHPI_EMBED_PROVIDER ?? (process.env.MECHPI_EMBED_COMMAND ? "command" : "sentence-transformers")).toLowerCase();
  const model = existing?.model ?? process.env.MECHPI_EMBED_MODEL ?? (provider === "openai" ? "text-embedding-3-small" : "sentence-transformers/all-MiniLM-L6-v2");
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("MECHPI_EMBED_PROVIDER=openai requires OPENAI_API_KEY");
    const r = await fetch(process.env.MECHPI_OPENAI_EMBED_URL ?? "https://api.openai.com/v1/embeddings", {
      method: "POST", signal,
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!r.ok) throw new Error(`OpenAI embedding request failed: ${r.status} ${await r.text().catch(() => "")}`);
    return parseEmbeddingResponse(await r.text(), "openai", model);
  }
  if (provider === "command") {
    const cmd = process.env.MECHPI_EMBED_COMMAND;
    if (!cmd) throw new Error("MECHPI_EMBED_PROVIDER=command requires MECHPI_EMBED_COMMAND");
    const r = await runWithInput("bash", ["-lc", cmd], JSON.stringify({ texts, model }), cwd, signal);
    if (r.code !== 0) throw new Error(`MECHPI_EMBED_COMMAND failed: ${r.stderr || r.stdout}`);
    return parseEmbeddingResponse(r.stdout, "command", model);
  }
  if (provider === "sentence-transformers") {
    const py = `
import json, os, sys
payload = json.load(sys.stdin)
texts = payload.get("texts", [])
model_name = payload.get("model") or os.environ.get("MECHPI_EMBED_MODEL") or "sentence-transformers/all-MiniLM-L6-v2"
from sentence_transformers import SentenceTransformer
model = SentenceTransformer(model_name)
emb = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
print(json.dumps({"provider":"sentence-transformers", "model":model_name, "embeddings":emb.tolist()}))
`;
    const r = await runWithInput("python3", ["-c", py], JSON.stringify({ texts, model }), cwd, signal);
    if (r.code !== 0) throw new Error(`sentence-transformers embedding failed. Install with 'python3 -m pip install sentence-transformers' or set MECHPI_EMBED_PROVIDER=openai/command. ${r.stderr || r.stdout}`);
    return parseEmbeddingResponse(r.stdout, "sentence-transformers", model);
  }
  throw new Error(`Unknown MECHPI_EMBED_PROVIDER: ${provider}`);
}

function safeSourceBasename(e: BibEntry, fallback: string): string {
  const title = e.fields.title ?? e.key ?? fallback;
  return normalizeSpace(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || fallback;
}

function isPdfPayload(contentType: string | null, buf: Buffer): boolean {
  return /application\/pdf/i.test(contentType ?? "") || buf.subarray(0, 5).toString() === "%PDF-";
}

function pdfLinksFromHtml(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = decodeHtml(m[1]);
    if (!/(\.pdf(?:[?#]|$)|\/pdf(?:[/?#]|$)|pdf=)/i.test(href)) continue;
    try { out.push(new URL(href, baseUrl).toString()); } catch {}
  }
  return unique(out).slice(0, 10);
}

async function tryDownloadPdf(cwd: string, e: BibEntry, metadata: BibPaperMetadata, sourceId: string, url: string, visited = new Set<string>()): Promise<{ text: string; stored?: string; note?: string } | null> {
  if (visited.has(url) || visited.size > 12) return null;
  visited.add(url);
  const r = await fetch(url, { headers: { "User-Agent": "mech-pi ingest downloader", "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.5" } }).catch(() => null);
  if (!r?.ok) return null;
  const contentType = r.headers.get("content-type");
  const arrayBuffer = await r.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  const root = mechIngestRoot(cwd);
  const tmpDir = path.join(root, "tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  if (isPdfPayload(contentType, buf)) {
    const tmpPdf = path.join(tmpDir, `${sourceId}-${safeSourceBasename(e, "download")}.pdf`);
    await fs.writeFile(tmpPdf, buf);
    if (!(await localDocumentMatchesMetadata(cwd, metadata, tmpPdf))) return null;
    const converted = await convertDocumentToText(cwd, tmpPdf, sourceId);
    return { ...converted, note: converted.note ?? `Downloaded PDF from ${url} after metadata verification.` };
  }
  const html = buf.toString("utf8");
  for (const pdfUrl of pdfLinksFromHtml(html, r.url || url)) {
    const downloaded = await tryDownloadPdf(cwd, e, metadata, sourceId, pdfUrl, visited);
    if (downloaded) return downloaded;
  }
  return null;
}

async function fetchWebDocumentForBib(cwd: string, e: BibEntry, metadata: BibPaperMetadata, sourceId: string, allowLanding: boolean): Promise<{ text: string; stored?: string; note?: string } | null> {
  const doi = metadata.doi ?? normalizeDoi(e.fields.doi);
  const urls = unique([doi ? `https://doi.org/${encodeURI(doi)}` : undefined, e.fields.url].filter(Boolean) as string[]);
  for (const url of urls) {
    const pdf = await tryDownloadPdf(cwd, e, metadata, sourceId, url).catch(() => null);
    if (pdf) return pdf;
  }
  if (!allowLanding) return null;
  const url = urls[0];
  if (!url) return null;
  const html = await fetchTextUrl(url, undefined).catch(() => null);
  if (!html) return null;
  const root = mechIngestRoot(cwd);
  const sourceDir = path.join(root, "sources");
  const textDir = path.join(root, "text");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(textDir, { recursive: true });
  const stored = path.join(sourceDir, `${sourceId}.html`);
  const textPath = path.join(textDir, `${sourceId}.txt`);
  await fs.writeFile(stored, html);
  const text = decodeHtml(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
  await fs.writeFile(textPath, text);
  return { text, stored: path.relative(cwd, stored), note: `No verified local copy or downloadable PDF was found; stored DOI/URL landing-page text from the web. Metadata source: ${metadata.source}.` };
}

async function rebuildMechIngestStore(ctx: ExtensionContext, selectedIds: string[], allItems: MechIngestItem[], onProgress?: MechIngestProgress): Promise<MechIngestManifest> {
  const byId = new Map(allItems.map(i => [i.id, i]));
  const manifest: MechIngestManifest = { selectedIds, sources: [], updatedAt: new Date().toISOString() };
  const chunks: MechIngestChunk[] = [];
  const total = Math.max(1, selectedIds.length);
  onProgress?.(0.02, `preparing ${selectedIds.length} selected source(s)`);
  for (const [index, id] of selectedIds.entries()) {
    const item = byId.get(id);
    const baseProgress = 0.05 + 0.55 * (index / total);
    onProgress?.(baseProgress, `extracting ${index + 1}/${selectedIds.length}: ${shortProgressLabel(item?.label ?? id)}`);
    if (!item) {
      manifest.sources.push({ id, label: id, type: "missing", status: "missing", note: "Selection no longer exists in local .bib/files." });
      onProgress?.(0.05 + 0.55 * ((index + 1) / total), `skipped missing source ${index + 1}/${selectedIds.length}`);
      continue;
    }
    const sourceId = hashId(id);
    await cleanupIngestArtifactsForSource(ctx.cwd, sourceId);
    try {
      let converted: { text: string; stored?: string; note?: string } | null = null;
      let original = item.path;
      if (item.type === "file" && item.path) converted = await convertDocumentToText(ctx.cwd, item.path, sourceId);
      else if (item.type === "bib" && item.bib) {
        const doiMetadata = await fetchDoiMetadata(normalizeDoi(item.bib.fields.doi), ctx.signal).catch(() => null);
        const metadata = mergePaperMetadata(bibPaperMetadata(item.bib), doiMetadata);
        const explicit = await findExplicitDocumentForBib(ctx.cwd, item.bib, metadata);
        if (explicit) {
          original = explicit;
          converted = await convertDocumentToText(ctx.cwd, explicit, sourceId);
          converted.note = [converted.note, `Used verified explicit BibTeX file/pdf path. Metadata source: ${metadata.source}.`].filter(Boolean).join(" ");
        } else {
          onProgress?.(baseProgress + 0.18 / total, `trying DOI/URL download for ${index + 1}/${selectedIds.length}`);
          converted = await fetchWebDocumentForBib(ctx.cwd, item.bib, metadata, sourceId, false);
          if (!converted) {
            onProgress?.(baseProgress + 0.32 / total, `searching $HOME with metadata verification for ${index + 1}/${selectedIds.length}`);
            const homeLocal = await findHomeDocumentForBib(ctx.cwd, item.bib, metadata);
            if (homeLocal.path) {
              original = homeLocal.path;
              converted = await convertDocumentToText(ctx.cwd, homeLocal.path, sourceId);
              const updated = await updateExistingBibEntryField(ctx.cwd, item.bib.file, item.bib.key, "file", bibFileFieldValue(ctx.cwd, homeLocal.path));
              converted.note = [converted.note, `Used $HOME document after title/DOI/venue/year/author metadata verification. ${updated ? "Updated BibTeX file field." : "BibTeX file field already current or could not be updated."} Metadata source: ${metadata.source}.`].filter(Boolean).join(" ");
            } else {
              converted = null;
              manifest.sources.push({ id, label: item.label, type: item.type, original, status: "needs-clarification", note: homeLocal.note ?? `No verified local file or metadata-verified DOI/URL PDF was found for ${metadata.title ?? item.bib.key}; not ingesting because the match is uncertain.` });
              onProgress?.(0.05 + 0.55 * ((index + 1) / total), `needs clarification for ${index + 1}/${selectedIds.length}`);
              continue;
            }
          }
        }
      }
      if (!converted || converted.text.trim().length < 80) {
        manifest.sources.push({ id, label: item.label, type: item.type, original, status: "not-found", note: converted?.note ?? "No local document or usable web text found." });
        onProgress?.(0.05 + 0.55 * ((index + 1) / total), `no usable text for ${index + 1}/${selectedIds.length}`);
        continue;
      }
      const newChunks = chunkTextForIngest(converted.text, sourceId, item.label);
      chunks.push(...newChunks);
      manifest.sources.push({ id, label: item.label, type: item.type, original, stored: converted.stored, status: "ok", note: converted.note });
      onProgress?.(0.05 + 0.55 * ((index + 1) / total), `chunked ${index + 1}/${selectedIds.length}: +${newChunks.length} chunks`);
    } catch (err) {
      manifest.sources.push({ id, label: item.label, type: item.type, original: item.path, status: "error", note: err instanceof Error ? err.message : String(err) });
      onProgress?.(0.05 + 0.55 * ((index + 1) / total), `error on ${index + 1}/${selectedIds.length}; continuing`);
    }
  }
  onProgress?.(0.64, `prepared ${chunks.length} chunk(s)`);
  const store: MechIngestStore = { version: 2, updatedAt: new Date().toISOString(), chunks };
  if (chunks.length) {
    let tick = 0;
    const timer = setInterval(() => {
      tick++;
      const fraction = Math.min(0.90, 0.70 + (1 - Math.exp(-tick / 18)) * 0.18);
      onProgress?.(fraction, `embedding ${chunks.length} chunk(s)${".".repeat(tick % 4)}`);
    }, 500);
    onProgress?.(0.70, `embedding ${chunks.length} chunk(s)`);
    try {
      const embedded = await embedTexts(ctx.cwd, chunks.map(ch => ch.text), ctx.signal);
      if (embedded.embeddings.length === chunks.length) {
        chunks.forEach((ch, i) => ch.embedding = embedded.embeddings[i]);
        store.embedding = embedded.info;
        manifest.embedding = embedded.info;
        onProgress?.(0.92, `embedded ${chunks.length} chunk(s) with ${embedded.info.model}`);
      } else {
        store.retrievalNote = manifest.retrievalNote = `Embedding provider returned ${embedded.embeddings.length} vectors for ${chunks.length} chunks; falling back to lexical retrieval.`;
        onProgress?.(0.92, "embedding count mismatch; using lexical fallback");
      }
    } catch (err) {
      store.retrievalNote = manifest.retrievalNote = err instanceof Error ? err.message : String(err);
      onProgress?.(0.92, "embedding unavailable; using lexical fallback");
    } finally {
      clearInterval(timer);
    }
  }
  onProgress?.(0.96, "writing .mechpi/ingest/vector-store.json");
  await fs.mkdir(mechIngestRoot(ctx.cwd), { recursive: true });
  await fs.writeFile(mechIngestStorePath(ctx.cwd), JSON.stringify(store, null, 2));
  await writeIngestManifest(ctx.cwd, manifest);
  onProgress?.(1, "vector store ready");
  return manifest;
}

function lexicalIngestRank(store: MechIngestStore, prompt: string): { ch: MechIngestChunk; score: number }[] {
  const q = new Set(ingestTokenize(prompt));
  if (!q.size || !store.chunks?.length) return [];
  return store.chunks.map(ch => {
    const chunkTokens = new Set([...(ch.tokens ?? []), ...ingestTokenize(ch.text)]);
    const text = ch.text.toLowerCase();
    const score = Array.from(q).reduce((n, t) => n + (chunkTokens.has(t) || text.includes(t) ? 1 : 0), 0);
    return { ch, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
}

async function retrieveMechIngestContext(cwd: string, prompt: string): Promise<string> {
  let store: MechIngestStore;
  try { store = JSON.parse(await readText(mechIngestStorePath(cwd))) as MechIngestStore; } catch { return ""; }
  if (!store.chunks?.length) return "";
  let ranked: { ch: MechIngestChunk; score: number }[] = [];
  let method = "lexical fallback";
  if (store.embedding && store.chunks.every(ch => Array.isArray(ch.embedding) && ch.embedding.length === store.embedding?.dimensions)) {
    try {
      const queryEmbedding = (await embedTexts(cwd, [prompt], undefined, store.embedding)).embeddings[0];
      ranked = store.chunks
        .map(ch => ({ ch, score: cosineSimilarity(queryEmbedding, ch.embedding) }))
        .filter(x => Number.isFinite(x.score))
        .sort((a, b) => b.score - a.score);
      method = `${store.embedding.provider}:${store.embedding.model}`;
    } catch {
      ranked = lexicalIngestRank(store, prompt);
    }
  } else {
    ranked = lexicalIngestRank(store, prompt);
  }
  ranked = ranked.slice(0, 6);
  if (!ranked.length) return "";
  return `Retrieval method: ${method}\n` + ranked.map((x, i) => `[${i + 1}] ${x.ch.label} (score ${x.score.toFixed(3)})\n${x.ch.text}`).join("\n\n");
}

async function runMechIngest(args: string, ctx: ExtensionContext): Promise<void> {
  const items = await discoverMechIngestItems(ctx);
  const manifest = await loadIngestManifest(ctx.cwd);
  const selected = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => opaquePopup(new MechIngestPicker(ctx, tui, theme, items, args, manifest, done), theme), { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } });
  if (selected === null) return ctx.ui.notify("mechingest cancelled", "info");
  const showProgress: MechIngestProgress = (fraction, message) => {
    ctx.ui.setStatus("mechingest", ctx.ui.theme.fg("warning", `${mechIngestProgressBar(fraction)} ${message}`));
  };
  showProgress(0, "building vector store");
  try {
    const selectedSet = new Set(selected);
    const removed = (manifest.selectedIds ?? []).filter(id => !selectedSet.has(id));
    if (removed.length) {
      showProgress(0.01, `removing ${removed.length} unchecked source(s)`);
      await Promise.all(removed.map(id => cleanupIngestArtifactsForSource(ctx.cwd, hashId(id))));
    }
    const next = await rebuildMechIngestStore(ctx, selected, items, showProgress);
    const agentsStatus = await ensureMechIngestAgentsGuidance(ctx.cwd);
    const ok = next.sources.filter(s => s.status === "ok").length;
    const missing = next.sources.filter(s => s.status !== "ok");
    const agentsNote = agentsStatus === "unchanged" ? "" : ` AGENTS.md ${agentsStatus} with vector-store retrieval guidance.`;
    ctx.ui.setStatus("mechingest", undefined);
    ctx.ui.notify(`Ingested ${ok} source(s); ${missing.length} missing/error. Vector store rebuilt in .mechpi/ingest/.${agentsNote}${missing.length ? `\n\n${missing.map(s => `- ${s.label}: ${s.status}${s.note ? ` (${s.note})` : ""}`).join("\n")}` : ""}`, missing.length ? "warning" : "info");
  } catch (err) {
    ctx.ui.setStatus("mechingest", undefined);
    ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
  }
}

async function runMechGotoCite(args: string, ctx: ExtensionContext): Promise<void> {
  const query = args.trim();
  const candidates = await localGotoCitationCandidates(ctx, query);
  if (!candidates.length) return ctx.ui.notify("No local BibTeX entries found.", "warning");
  if (query) {
    const chosen = rankGotoCitationCandidates(candidates, query)[0];
    if (!chosen) return ctx.ui.notify(`No local BibTeX entry matched: ${query}`, "warning");
    const url = bestCitationUrl(chosen);
    if (!url) return ctx.ui.notify(`No usable URL found for ${chosen.key ?? chosen.title}`, "warning");
    openUrlExternal(url);
    ctx.ui.notify(`Opening ${chosen.key ?? chosen.title}: ${url}`, "info");
    return;
  }
  const chosen = await ctx.ui.custom<CitationCandidate | null>((tui, theme, _kb, done) => opaquePopup(new GotoCitationPicker(tui, theme, candidates, args, done), theme), { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } });
  if (!chosen) return ctx.ui.notify("Citation navigation cancelled", "info");
  const url = bestCitationUrl(chosen);
  if (!url) return ctx.ui.notify(`No usable URL found for ${chosen.key ?? chosen.title}`, "warning");
  openUrlExternal(url);
  ctx.ui.notify(`Opening ${url}`, "info");
}

async function runMechAddCite(args: string, ctx: ExtensionContext): Promise<void> {
  const opts = parseMechAddCiteArgs(args);
  const prompt = opts.prompt;
  if (!prompt) return ctx.ui.notify("Usage: /mechaddcite [--to-bib|-b] [--keep-local|-l] <citation need / remembered paper>", "warning");
  ctx.ui.setStatus("mechaddcite", ctx.ui.theme.fg("warning", "searching citations"));
  try {
    const map = await loadOrBuildMap(ctx);
    const local = mergeCitationCandidates((await loadBibEntries(ctx.cwd, map)).map(e => bibEntryToCandidate(e, prompt)).filter(c => c.score > 1.25)).slice(0, 5);
    const external = (await searchExternalCitations(prompt, ctx.signal)).slice(0, 10);
    const candidates = mergeCitationCandidates([...external, ...local]).slice(0, 12);
    if (!candidates.some(c => c.status === "manual")) candidates.push(googleScholarManualCandidate(prompt));
    ctx.ui.setStatus("mechaddcite", undefined);
    if (candidates.filter(c => c.status !== "manual").length < 5) ctx.ui.notify(`Found only ${candidates.length - 1} non-manual candidates; included Google Scholar manual fallback rather than fabricating results.`, "warning");
    const chosen = await chooseCitationCandidates(ctx, candidates);
    if (!chosen || chosen.length === 0) return ctx.ui.notify("Citation insertion cancelled", "info");
    const existingKeys = new Set((await loadBibEntries(ctx.cwd, map)).map(e => e.key));
    const selected: CitationCandidate[] = [];
    for (const candidate of chosen) {
      if (candidate.status === "manual") {
        const pasted = await handleGoogleScholarManual(ctx, prompt, existingKeys);
        if (pasted) { selected.push(pasted); if (pasted.key) existingKeys.add(pasted.key); }
      } else {
        selected.push(candidate);
      }
    }
    if (selected.length === 0) return ctx.ui.notify("No citations selected for insertion", "info");
    const result = await insertCitationCandidates(ctx, map, selected, prompt, { toBibOnly: opts.toBibOnly, keepLocal: opts.keepLocal });
    ctx.ui.notify(result, "info");
  } catch (err) {
    ctx.ui.setStatus("mechaddcite", undefined);
    ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
  }
}

function shellQuote(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

function voiceSpaceHoldEnabled(): boolean { return envFlag("MECHPI_VOICE_SPACE_HOLD", false); }

type RecorderSpec = { cmd: string; args: string[]; name: string };

class VoiceInputController {
  private recorder: ReturnType<typeof spawn> | null = null;
  private recorderStderr = "";
  private audioPath: string | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeChild: ReturnType<typeof spawn> | null = null;
  private wakeEnabled = false;

  constructor(private ctx: ExtensionContext) {}

  isEnabled(): boolean { return this.hasRecorder() && this.hasTranscriber(); }
  isRecording(): boolean { return this.recorder !== null; }
  isWakeEnabled(): boolean { return this.wakeEnabled; }

  notifyError(err: unknown): void {
    this.ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    this.ctx.ui.setStatus("voice", undefined);
  }

  statusText(): string {
    const rec = this.findRecorder();
    const transcriber = this.describeTranscriber();
    const parts = [
      `recorder: ${rec?.name ?? "missing"}`,
      `transcriber: ${transcriber}`,
      `recording: ${this.isRecording() ? "yes" : "no"}`,
      `push-to-talk: ${voiceSpaceHoldEnabled() ? "space-hold on" : "space-hold off"} (Ctrl+Alt+Space and /mechvoice toggle are always available)`,
      `wake: ${this.wakeEnabled ? "on" : "off"}`,
    ];
    if (!this.isEnabled()) {
      parts.push("Set MECHPI_STT_COMMAND='{audio} -> text' or MECHPI_WHISPER_CPP_MODEL=/path/to/model.bin for local transcription.");
    }
    return parts.join("\n");
  }

  async startRecording(reason = "manual"): Promise<void> {
    if (this.recorder) return;
    const spec = this.findRecorder();
    if (!spec) throw new Error("No Linux audio recorder found. Install sox, pulseaudio-utils, ffmpeg, or alsa-utils; or set MECHPI_RECORD_COMMAND.");
    if (!this.hasTranscriber()) throw new Error("No speech-to-text backend found. Set MECHPI_STT_COMMAND or MECHPI_WHISPER_CPP_MODEL, or install whisper/vosk-transcriber.");
    const voiceRoot = path.join(this.ctx.cwd, ".mechpi");
    await fs.mkdir(voiceRoot, { recursive: true });
    const dir = await fs.mkdtemp(path.join(voiceRoot, "voice-"));
    this.audioPath = path.join(dir, "utterance.wav");
    const actual = this.materializeRecorder(spec, this.audioPath);
    this.recorderStderr = "";
    this.ctx.ui.setStatus("voice", this.ctx.ui.theme.fg("accent", `● voice ${reason}`));
    this.recorder = spawn(actual.cmd, actual.args, { cwd: this.ctx.cwd, stdio: ["ignore", "ignore", "pipe"] });
    this.recorder.stderr?.on("data", d => this.recorderStderr += d.toString());
    this.recorder.on("error", err => { this.recorder = null; this.notifyError(err); });
    this.recorder.on("close", () => {
      const audio = this.audioPath;
      this.recorder = null;
      this.audioPath = null;
      if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
      if (audio) void this.finishRecording(audio).catch(err => this.notifyError(err));
    });
  }

  stopAfter(ms: number): void {
    if (!this.recorder) return;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => this.stopNow(), Math.max(0, ms));
  }

  stopNow(): void {
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    if (!this.recorder) return;
    this.ctx.ui.setStatus("voice", this.ctx.ui.theme.fg("warning", "● voice transcribing"));
    this.recorder.kill("SIGINT");
    setTimeout(() => this.recorder?.kill("SIGTERM"), 800);
  }

  startWakeLoop(): void {
    const command = process.env.MECHPI_WAKE_WORD_COMMAND;
    if (!command) throw new Error("Set MECHPI_WAKE_WORD_COMMAND to a local command that exits 0 when it hears the wake word, e.g. an openWakeWord/Porcupine wrapper.");
    if (this.wakeEnabled) return;
    this.wakeEnabled = true;
    this.spawnWakeCommand();
  }

  stopWakeLoop(): void {
    this.wakeEnabled = false;
    if (this.wakeChild) {
      this.wakeChild.kill("SIGTERM");
      this.wakeChild = null;
    }
    this.ctx.ui.setStatus("wake", undefined);
  }

  dispose(): void {
    this.stopWakeLoop();
    this.stopNow();
  }

  private spawnWakeCommand(): void {
    if (!this.wakeEnabled || this.wakeChild || this.recorder) return;
    const command = process.env.MECHPI_WAKE_WORD_COMMAND;
    if (!command) return;
    this.ctx.ui.setStatus("wake", this.ctx.ui.theme.fg("dim", "wake: listening"));
    this.wakeChild = spawn("bash", ["-lc", command], { cwd: this.ctx.cwd, stdio: "ignore" });
    this.wakeChild.on("close", code => {
      this.wakeChild = null;
      if (!this.wakeEnabled) return;
      if (code === 0) {
        void this.startRecording("wake").catch(err => this.notifyError(err));
      } else {
        setTimeout(() => this.spawnWakeCommand(), 1000);
      }
    });
    this.wakeChild.on("error", err => this.notifyError(err));
  }

  private async finishRecording(audio: string): Promise<void> {
    this.ctx.ui.setStatus("voice", this.ctx.ui.theme.fg("warning", "● voice transcribing"));
    const text = (await this.transcribe(audio)).trim();
    if (text) activePromptEditor?.insertVoiceText(text);
    else this.ctx.ui.notify("Speech transcription returned no text.", "warning");
    this.ctx.ui.setStatus("voice", undefined);
    if (!/^(1|true|yes|on)$/i.test(process.env.MECHPI_KEEP_VOICE_AUDIO ?? "")) {
      fs.rm(path.dirname(audio), { recursive: true, force: true }).catch(() => {});
    }
    if (this.wakeEnabled) setTimeout(() => this.spawnWakeCommand(), 250);
  }

  private hasRecorder(): boolean { return this.findRecorder() !== null; }
  private findRecorder(): RecorderSpec | null {
    if (process.env.MECHPI_RECORD_COMMAND) return { cmd: "bash", args: ["-lc", process.env.MECHPI_RECORD_COMMAND], name: "MECHPI_RECORD_COMMAND" };
    const silence = process.env.MECHPI_VOICE_SILENCE_SECONDS ?? "1.0";
    const threshold = process.env.MECHPI_VOICE_SILENCE_THRESHOLD ?? "1%";
    if (commandExists("rec")) return { cmd: "rec", args: ["-q", "-r", "16000", "-c", "1", "-b", "16", "{audio}", "silence", "1", "0.1", threshold, "1", silence, threshold], name: "sox rec (auto-silence)" };
    if (commandExists("parecord")) return { cmd: "parecord", args: ["--channels=1", "--rate=16000", "--format=s16le", "--file-format=wav", "{audio}"], name: "parecord" };
    if (commandExists("ffmpeg")) return { cmd: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "default", "-ac", "1", "-ar", "16000", "-y", "{audio}"], name: "ffmpeg/pulse" };
    if (commandExists("arecord")) return { cmd: "arecord", args: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "{audio}"], name: "arecord" };
    return null;
  }
  private materializeRecorder(spec: RecorderSpec, audio: string): RecorderSpec {
    if (spec.name === "MECHPI_RECORD_COMMAND") return { ...spec, args: ["-lc", spec.args[1].replaceAll("{audio}", shellQuote(audio))] };
    return { ...spec, args: spec.args.map(a => a === "{audio}" ? audio : a.replaceAll("{audio}", audio)) };
  }
  private hasTranscriber(): boolean { return this.describeTranscriber() !== "missing"; }
  private describeTranscriber(): string {
    if (process.env.MECHPI_STT_COMMAND) return "MECHPI_STT_COMMAND";
    if (process.env.MECHPI_WHISPER_CPP_MODEL && process.env.MECHPI_WHISPER_CPP_BIN) return process.env.MECHPI_WHISPER_CPP_BIN;
    if (process.env.MECHPI_WHISPER_CPP_MODEL && commandExists("whisper-cli")) return "whisper-cli";
    if (commandExists("whisper")) return "openai-whisper";
    if (commandExists("vosk-transcriber")) return "vosk-transcriber";
    return "missing";
  }
  private async transcribe(audio: string): Promise<string> {
    const dir = path.dirname(audio);
    const custom = process.env.MECHPI_STT_COMMAND;
    if (custom) {
      const r = await run("bash", ["-lc", custom.replaceAll("{audio}", shellQuote(audio))], this.ctx.cwd);
      if (r.code !== 0) throw new Error(`MECHPI_STT_COMMAND failed:\n${(r.stderr || r.stdout).slice(-2000)}`);
      return r.stdout.trim();
    }
    const model = process.env.MECHPI_WHISPER_CPP_MODEL;
    if (model && (process.env.MECHPI_WHISPER_CPP_BIN || commandExists("whisper-cli"))) {
      const exe = process.env.MECHPI_WHISPER_CPP_BIN || "whisper-cli";
      const outPrefix = path.join(dir, "transcript");
      const r = await run(exe, ["-m", model, "-f", audio, "-otxt", "-of", outPrefix, "-nt"], this.ctx.cwd);
      const txt = await readText(`${outPrefix}.txt`).catch(() => "");
      if (r.code !== 0 && !txt.trim()) throw new Error(`${exe} failed:\n${(r.stderr || r.stdout).slice(-2000)}`);
      return txt.trim() || r.stdout.replace(/\[[^\]]*\]/g, " ").trim();
    }
    if (commandExists("whisper")) {
      const modelName = process.env.MECHPI_WHISPER_MODEL ?? "tiny.en";
      const r = await run("whisper", [audio, "--model", modelName, "--language", "en", "--output_format", "txt", "--output_dir", dir, "--fp16", "False"], this.ctx.cwd);
      const txt = await readText(path.join(dir, `${path.basename(audio, path.extname(audio))}.txt`)).catch(() => "");
      if (r.code !== 0 && !txt.trim()) throw new Error(`whisper failed:\n${(r.stderr || r.stdout).slice(-2000)}`);
      return txt.trim();
    }
    if (commandExists("vosk-transcriber")) {
      const r = await run("vosk-transcriber", ["-i", audio], this.ctx.cwd);
      if (r.code !== 0) throw new Error(`vosk-transcriber failed:\n${(r.stderr || r.stdout).slice(-2000)}`);
      return r.stdout.split(/\r?\n/).map(line => {
        try { return JSON.parse(line).text ?? ""; } catch { return line; }
      }).join(" ").trim();
    }
    return "";
  }
}

let activePromptEditor: MechPiModalPromptEditor | null = null;
let activeVoice: VoiceInputController | null = null;

export default function mechPi(pi: ExtensionAPI) {
  installAssistantLatexPreviewRenderer();

  pi.on("session_start", async (_event, ctx) => {
    latexPreviewCwd = ctx.cwd;
    activeVoice = new VoiceInputController(ctx);
    if (/^(1|true|yes|on)$/i.test(process.env.MECHPI_WAKE_ON_START ?? "") && process.env.MECHPI_WAKE_WORD_COMMAND) {
      try { activeVoice.startWakeLoop(); } catch (err) { activeVoice.notifyError(err); }
    }
    const historyFile = promptHistoryPath(ctx.cwd);
    const initialHistory = await loadPromptHistory(ctx.cwd);
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      activePromptEditor = new MechPiModalPromptEditor(tui, theme, keybindings, historyFile, initialHistory);
      return activePromptEditor;
    });
    let gotoCiteCache: { at: number; candidates: CitationCandidate[] } | null = null;
    const getGotoCiteCandidates = async () => {
      if (gotoCiteCache && Date.now() - gotoCiteCache.at < 3000) return gotoCiteCache.candidates;
      const candidates = await localGotoCitationCandidates(ctx, "").catch(() => []);
      gotoCiteCache = { at: Date.now(), candidates };
      return candidates;
    };
    let mechIngestCache: { at: number; items: MechIngestItem[] } | null = null;
    const getMechIngestItems = async () => {
      if (mechIngestCache && Date.now() - mechIngestCache.at < 3000) return mechIngestCache.items;
      const items = await discoverMechIngestItems(ctx).catch(() => []);
      mechIngestCache = { at: Date.now(), items };
      return items;
    };
    let equationCache: { at: number; equations: EquationInfo[] } | null = null;
    const getEquationItems = async () => {
      if (equationCache && Date.now() - equationCache.at < 3000) return equationCache.equations;
      const map = await loadOrBuildMap(ctx).catch(() => undefined);
      const equations = map?.equations ?? [];
      equationCache = { at: Date.now(), equations };
      return equations;
    };
    ctx.ui.addAutocompleteProvider((current: AutocompleteProvider) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const before = line.slice(0, cursorCol);
        const gotoMatch = before.match(/^\/mechgotocite(?:\s+(.*))?$/);
        if (gotoMatch) {
          const query = gotoMatch[1] ?? "";
          const candidates = await getGotoCiteCandidates();
          if (options.signal.aborted || candidates.length === 0) return null;
          const items = gotoCitationAutocompleteItems(candidates, query);
          return items.length ? { items, prefix: before } : null;
        }
        const citeEditMatch = before.match(/^\/mechciteedit(?:\s+(.*))?$/);
        if (citeEditMatch) {
          const query = citeEditMatch[1] ?? "";
          const candidates = await getGotoCiteCandidates();
          if (options.signal.aborted || candidates.length === 0) return null;
          const items = citationCommandAutocompleteItems("mechciteedit", candidates, query);
          return items.length ? { items, prefix: before } : null;
        }
        const eqEditMatch = before.match(/^\/mecheqedit(?:\s+(.*))?$/);
        if (eqEditMatch) {
          const query = eqEditMatch[1] ?? "";
          const items = equationAutocompleteItems(await getEquationItems(), query);
          return items.length ? { items, prefix: before } : null;
        }
        const ingestMatch = before.match(/^\/mechingest(?:\s+(.*))?$/);
        if (ingestMatch) {
          const query = ingestMatch[1] ?? "";
          const items = mechIngestAutocompleteItems(await getMechIngestItems(), query);
          return items.length ? { items, prefix: before } : null;
        }
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
    ctx.ui.onTerminalInput((data) => {
      if (activePromptEditor?.tryHandlePromptBackspaceInput(data)) return { consume: true };
      return activePromptEditor?.tryHandleTmuxPrefixInput(data) ? { consume: true } : undefined;
    });
    if (await exists(path.join(ctx.cwd, "main.tex")) || (await walk(ctx.cwd).catch(() => [])).some(p => p.endsWith(".tex"))) {
      ctx.ui.setStatus("mech-pi", "mech-pi ready");
    }
  });

  pi.on("agent_end", async () => {
    activePromptEditor?.returnToInsertAfterChat();
  });

  pi.on("session_shutdown", async () => {
    activeVoice?.dispose();
    activeVoice = null;
    activePromptEditor = null;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const cache = path.join(ctx.cwd, ".mechpi", "paper-map.json");
    let mapNote = "No .mechpi/paper-map.json cache yet; use mech_ingest before detailed paper claims.";
    if (await exists(cache)) {
      try { mapNote = summarizeMap(JSON.parse(await readText(cache)) as PaperMap); } catch {}
    }
    const ingestContext = await retrieveMechIngestContext(ctx.cwd, event.prompt ?? "");
    const ingestNote = ingestContext ? `\n\nMECH-PI INGESTED REFERENCE CONTEXT (from .mechpi/ingest vector store; cite/check sources before relying on it):\n${ingestContext}` : "";
    return { systemPrompt: ctx.getSystemPrompt() + `\n\nMECH-PI RESEARCH MODE:\n- The LaTeX repository is the source of truth. If chat memory conflicts with TeX files, reload/ingest files and trust TeX.\n- For mechanics/theory claims, prefer focused source citations: file:line and equation labels.\n- Nudge toward truthful mechanics: distinguish assumptions, definitions, derivations, constitutive restrictions, and conjectures.\n- Use mech_ingest, mech_focus_equation, mech_search_symbol, mech_check, and mech_compile when relevant.\n- Keep small definitions and identifiers inline in prose, e.g. p is pressure or c_t is total compressibility; do not force-render single symbols or short definitions.
- Put actual equations, derivations, fractions, derivatives, integrals/sums, matrices/cases, and relation-heavy expressions in display math (\\[...\\] or equation/align environments) so mech-pi uses the full equation renderer.
- Use raw LaTeX code blocks only when the user explicitly asks for raw source/code.
- If MECH-PI INGESTED REFERENCE CONTEXT is present, use it as the first-pass RAG result. Answer from it when sufficient; do not run broad filesystem searches just to duplicate retrieval. If more retrieval is needed, inspect .mechpi/ingest/manifest.json, .mechpi/ingest/vector-store.json, or .mechpi/ingest/text before wider searches.\nCurrent paper cache summary:\n${mapNote}${ingestNote}` };
  });

  pi.registerTool({
    name: "mech_ingest", label: "Mech Ingest", description: "Parse the current LaTeX paper repo into a mechanics-aware paper map cache.", promptSnippet: "Build a paper map from main.tex/includes/def.tex/all.bib for source-of-truth context.", promptGuidelines: ["Use mech_ingest before making claims about the current paper structure or notation."], parameters: IngestParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Scanning LaTeX sources..." }], details: {} });
      let map = await buildPaperMap(ctx.cwd, params.root);
      let compile: LatexCompileSummary | undefined;
      if (params.compileIfAuxMissing && numberMapNeedsCompile(map) && map.rootTex) {
        compile = await runLatexmk(ctx.cwd, map.rootTex, signal, onUpdate, false, true);
        if (compile.ok) map = await buildPaperMap(ctx.cwd, params.root);
      }
      if (params.writeCache !== false) await writeMap(ctx.cwd, map);
      const compileNote = compile && !compile.ok ? `\n\nEquation-number aux refresh failed:\n${compileSummaryText(compile)}` : "";
      return { content: [{ type: "text", text: summarizeMap(map) + (map.warnings.length ? `\n\nTop warnings:\n${map.warnings.slice(0, 20).join("\n")}` : "") + compileNote }], details: { ...map, compile } };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("mech_ingest ")) + theme.fg("muted", args.root ? String(args.root) : "auto"), 0, 0); }
  });

  pi.registerTool({
    name: "mech_focus_equation", label: "Focus Equation", description: "Locate one LaTeX equation by label, rendered equation number, or contents and return exact source, context, symbols, and basic index warnings.", parameters: FocusParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      const loaded = params.number
        ? await loadNumberAwareMap(ctx, signal, onUpdate, params.autoCompile !== false)
        : { map: await loadOrBuildMap(ctx), compile: undefined as LatexCompileSummary | undefined };
      const map = loaded.map;
      let matches = map.equations;
      if (params.label) matches = matches.filter(e => (e.labels ?? (e.label ? [e.label] : [])).includes(params.label!));
      if (!params.label && params.number) matches = matches.filter(e => (e.numbers ?? []).some(n => sameEquationNumber(n.number, params.number!)) || (e.tags ?? []).some(t => sameEquationNumber(t, params.number!)));
      if (!params.label && !params.number && params.contains) matches = matches.filter(e => e.tex.includes(params.contains!));
      if (!params.label && !params.number && !params.contains) return { content: [{ type: "text", text: "Provide label, number, or contains." }], details: { matches: [] } };
      if (matches.length === 0) {
        const compileFailure = loaded.compile && !loaded.compile.ok ? `\n\nTried to compile to create/refresh aux equation-number data, but compilation failed. Repair these LaTeX errors and rerun the lookup:\n${compileSummaryText(loaded.compile)}` : "";
        const auxNote = params.number ? `\n\nEquation-number lookup uses aux labels and explicit \\tag entries. If ${params.number} belongs to an unlabeled automatically numbered equation, standard aux files cannot identify it; add a \\label or \\tag, compile, and rerun.` : "";
        return { content: [{ type: "text", text: `No matching equation found. Run mech_ingest if cache is stale.${auxNote}${compileFailure}` }], details: { matches: [], compile: loaded.compile, auxStatus: map.auxStatus } };
      }
      const e = matches[0];
      const probs = indexProblems(e.tex);
      if (params.edit) {
        const edited = await openEquationEditor(ctx, e);
        if (edited === null) return { content: [{ type: "text", text: `Equation edit cancelled: ${e.label ?? "(unlabeled)"}` }], details: { equation: e, cancelled: true } };
        if (edited !== e.tex) {
          const where = await saveEquationEdit(ctx, e, edited);
          return { content: [{ type: "text", text: `Saved equation edit at ${where}. Rebuilt .mechpi/paper-map.json.` }], details: { equation: e, saved: true } };
        }
        return { content: [{ type: "text", text: `No changes made to ${e.label ?? "(unlabeled equation)"}.` }], details: { equation: e, saved: false } };
      }
      const renderTex = texWithOriginalNumbers(e);
      const renderedPreviewNote = renderTex !== e.tex ? `\n\nLaTeX used for isolated preview with original PDF number(s):\n${renderTex}` : "";
      const notes = e.numberingNotes?.length ? `\n\nNumbering notes:\n${e.numberingNotes.join("\n")}` : "";
      const compileNote = loaded.compile && !loaded.compile.ok ? `\n\nAux refresh compile failed; returned number data may be stale until these LaTeX errors are repaired:\n${compileSummaryText(loaded.compile)}` : "";
      const auxStatusNote = !compileNote && map.auxStatus?.stale ? "\n\nAux status: stale; run mech_compile to refresh equation numbers." : "";
      const text = `Equation ${e.label ?? "(unlabeled)"}\n${e.file}:${e.lineStart}-${e.lineEnd}\nEnvironment: ${e.env}\nRendered number(s): ${equationNumberSummary(e)}\nLabels: ${(e.labels ?? []).join(", ") || "none"}\n\nLaTeX:\n${e.tex}${renderedPreviewNote}\n\nNearby context:\n${e.nearby}\n\nSymbols/macros seen:\n${e.symbols.join(", ")}${notes}${probs.length ? `\n\nIndex warnings:\n${probs.join("\n")}` : ""}${compileNote}${auxStatusNote}`;
      return { content: [{ type: "text", text }], details: { equation: e, indexWarnings: probs, otherMatches: matches.length - 1, compile: loaded.compile, auxStatus: map.auxStatus } };
    }
  });

  pi.registerTool({
    name: "mech_compile", label: "Compile LaTeX", description: "Run latexmk on the paper root and summarize errors/warnings.", parameters: CompileParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      const map = await loadOrBuildMap(ctx, params.root);
      const root = params.root ?? map.rootTex;
      if (!root) return { content: [{ type: "text", text: "No root TeX file found." }], details: { ok: false } };
      const summary = await runLatexmk(ctx.cwd, root, signal, onUpdate, params.clean, params.nonstop !== false);
      if (summary.ok) {
        const nextMap = await buildPaperMap(ctx.cwd, params.root);
        await writeMap(ctx.cwd, nextMap);
      }
      return { content: [{ type: "text", text: compileSummaryText(summary) }], details: summary };
    }
  });

  pi.registerTool({
    name: "mech_search_symbol", label: "Search Symbol", description: "Search all TeX files in the paper map for a macro, symbol, or text fragment.", parameters: SearchParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const map = await loadOrBuildMap(ctx);
      const hits: string[] = [];
      for (const rel of map.texFiles) {
        const abs = path.join(ctx.cwd, rel); const lines = (await readText(abs).catch(() => "")).split(/\r?\n/);
        lines.forEach((l, i) => { if (l.includes(params.query)) hits.push(params.includeContext === false ? `${rel}:${i + 1}` : `${rel}:${i + 1}: ${l.trim()}`); });
      }
      return { content: [{ type: "text", text: hits.length ? hits.slice(0, 200).join("\n") : "No hits." }], details: { query: params.query, count: hits.length, hits } };
    }
  });

  pi.registerTool({
    name: "mech_check", label: "Mechanics Check", description: "Run lightweight LaTeX/mechanics checks: refs, citations, duplicate labels, TODOs, and simple index red flags.", parameters: CheckParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const map = await buildPaperMap(ctx.cwd);
      await writeMap(ctx.cwd, map);
      const indexWarnings = map.equations.flatMap(e => indexProblems(e.tex).map(w => `${e.file}:${e.lineStart} ${e.label ?? ""}: ${w}`));
      const mechanicsHints = [
        "For mixture models, verify phase interaction forces sum to zero unless external supply is declared.",
        "State whether temperature is common or phase-specific before entropy/free-energy restrictions.",
        "Check every reaction/mass-transfer term for companion momentum, energy, and entropy terms.",
        "Separate primitive variables, constraints, and constitutive choices explicitly.",
      ];
      const kind = params.kind ?? "all";
      const parts: string[] = [];
      if (kind === "all" || kind === "latex") parts.push(`LaTeX warnings (${map.warnings.length}):\n${map.warnings.slice(0, 80).join("\n") || "none"}`);
      if (kind === "all" || kind === "indices") parts.push(`Index warnings (${indexWarnings.length}):\n${indexWarnings.slice(0, 80).join("\n") || "none"}`);
      if (kind === "all" || kind === "mechanics") parts.push(`Mechanics prompts:\n- ${mechanicsHints.join("\n- ")}`);
      return { content: [{ type: "text", text: parts.join("\n\n") }], details: { map, indexWarnings, mechanicsHints } };
    }
  });

  pi.registerTool({
    name: "mech_preview_pdf", label: "Preview PDF", description: "Open the compiled PDF with a viewer (xdg-open by default).", parameters: PreviewParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const map = await loadOrBuildMap(ctx);
      const pdf = params.pdf ?? (map.rootTex ? map.rootTex.replace(/\.tex$/, ".pdf") : "main.pdf");
      const abs = path.resolve(ctx.cwd, pdf);
      if (!fss.existsSync(abs)) return { content: [{ type: "text", text: `PDF not found: ${pdf}. Run mech_compile first.` }], details: { opened: false, pdf } };
      const command = params.command ?? process.env.MECHPI_PDF_VIEWER ?? "xdg-open";
      const child = spawn(command, [abs], { cwd: ctx.cwd, detached: true, stdio: "ignore" });
      child.unref();
      return { content: [{ type: "text", text: `Opened ${pdf} with ${command}.` }], details: { opened: true, pdf, command } };
    }
  });

  pi.registerCommand("mechmap", { description: "Ingest current LaTeX repo and show paper map summary", handler: async (args, ctx) => { const map = await buildPaperMap(ctx.cwd, args.trim() || undefined); await writeMap(ctx.cwd, map); ctx.ui.notify(summarizeMap(map), map.warnings.length ? "warning" : "info"); } });
  pi.registerCommand("mechedit", {
    description: "Find a manuscript location from a natural-language query and open it in an external editor. Usage: /mechedit entropy inequality",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) return ctx.ui.notify("Usage: /mechedit text describing the manuscript location, eq:label, or file.tex:line", "warning");
      const target = await findMechEditTarget(ctx, query);
      if (!target) return ctx.ui.notify("No manuscript location found. Run /mechmap if the cache is stale.", "warning");
      try {
        const opened = openExternalEditorAt(ctx.cwd, target);
        ctx.ui.notify(`Opening ${target.file}:${target.line} (${target.title}, score ${target.score.toFixed(1)}) with ${opened.command}.`, "info");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    }
  });
  pi.registerCommand("mecheqedit", {
    description: "Fuzzy-select an equation by label/number/text, open the terminal editor, and save back to TeX. Usage: /mecheqedit eq:label, number:2.14, or text",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) return ctx.ui.notify("Usage: /mecheqedit eq:label, number:2.14, contains:fragment, or fuzzy text", "warning");
      const map = query.startsWith("number:") ? (await loadNumberAwareMap(ctx)).map : await loadOrBuildMap(ctx);
      const matches = query.startsWith("contains:")
        ? map.equations.filter(e => e.tex.includes(query.slice("contains:".length)))
        : query.startsWith("number:")
          ? map.equations.filter(e => (e.numbers ?? []).some(n => sameEquationNumber(n.number, query.slice("number:".length))) || (e.tags ?? []).some(t => sameEquationNumber(t, query.slice("number:".length))))
          : rankEquations(map.equations, query);
      if (matches.length === 0) return ctx.ui.notify("No matching equation found. Run /mechmap or compile if cache/aux files are stale.", "warning");
      const e = matches[0];
      const edited = await openEquationEditor(ctx, e);
      if (edited === null) return ctx.ui.notify("Equation edit cancelled", "info");
      if (edited === e.tex) return ctx.ui.notify("No changes made", "info");
      try {
        const where = await saveEquationEdit(ctx, e, edited);
        ctx.ui.notify(`Saved equation edit at ${where}; rebuilt .mechpi/paper-map.json`, "info");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    }
  });
  pi.registerCommand("mechciteedit", {
    description: "Fuzzy-select a local BibTeX entry, open the terminal editor, and save back to the .bib database. Usage: /mechciteedit <citekey/title>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) return ctx.ui.notify("Usage: /mechciteedit <citekey, title, author, DOI, or fuzzy text>", "warning");
      const entries = await localBibEntriesForEdit(ctx);
      const matches = rankBibEntries(entries, query);
      if (matches.length === 0) return ctx.ui.notify("No matching BibTeX entry found. Run /mechmap if the cache is stale.", "warning");
      const entry = matches[0];
      const edited = await openCitationEditor(ctx, entry);
      if (edited === null) return ctx.ui.notify("Citation edit cancelled", "info");
      if (edited === entry.raw) return ctx.ui.notify("No changes made", "info");
      const parsed = parseBibEntries(edited, entry.file);
      if (parsed.length !== 1) return ctx.ui.notify("Edited text must contain exactly one BibTeX entry; not saved.", "error");
      try {
        const where = await saveBibEntryEdit(ctx, entry, edited);
        ctx.ui.notify(`Saved citation edit at ${where}; rebuilt .mechpi/paper-map.json`, "info");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    }
  });
  pi.registerCommand("mechaddcite", {
    description: "Find verified citation candidates, add BibTeX, and insert a source-grounded citation. Usage: /mechaddcite <citation need>",
    handler: async (args, ctx) => { await runMechAddCite(args, ctx); }
  });
  pi.registerCommand("mechgotocite", {
    description: "Fuzzy search local BibTeX entries and open the best paper website. Usage: /mechgotocite <query>",
    handler: async (args, ctx) => { await runMechGotoCite(args, ctx); }
  });
  pi.registerCommand("mechingest", {
    description: "Select local files or BibTeX references, extract/chunk them, and build .mechpi/ingest vector context. Usage: /mechingest <keywords>",
    handler: async (args, ctx) => { await runMechIngest(args, ctx); }
  });
  pi.registerCommand("mechvoice", {
    description: "Speech-to-text input. Usage: /mechvoice [status|start|stop|toggle|wake on|wake off]",
    handler: async (args, ctx) => {
      const voice = activeVoice ?? (activeVoice = new VoiceInputController(ctx));
      const cmd = args.trim().toLowerCase() || "status";
      try {
        if (cmd === "status") return ctx.ui.notify(voice.statusText(), voice.isEnabled() ? "info" : "warning");
        if (cmd === "start" || cmd === "record") { await voice.startRecording("manual"); return; }
        if (cmd === "stop") { voice.stopNow(); return; }
        if (cmd === "toggle") { voice.isRecording() ? voice.stopNow() : await voice.startRecording("manual"); return; }
        if (cmd === "wake on" || cmd === "wake start") { voice.startWakeLoop(); return ctx.ui.notify("Wake-word listener enabled.", "info"); }
        if (cmd === "wake off" || cmd === "wake stop") { voice.stopWakeLoop(); return ctx.ui.notify("Wake-word listener disabled.", "info"); }
        return ctx.ui.notify("Usage: /mechvoice [status|start|stop|toggle|wake on|wake off]", "warning");
      } catch (err) {
        voice.notifyError(err);
      }
    }
  });
  pi.registerShortcut(Key.ctrlAlt("space"), {
    description: "Toggle mech-pi voice recording",
    handler: async (ctx) => {
      const voice = activeVoice ?? (activeVoice = new VoiceInputController(ctx));
      try { voice.isRecording() ? voice.stopNow() : await voice.startRecording("shortcut"); }
      catch (err) { voice.notifyError(err); }
    }
  });
  pi.registerCommand("mechcompile", { description: "Run latexmk on the detected paper root and refresh equation numbers", handler: async (_args, ctx) => { const map = await loadOrBuildMap(ctx); const root = map.rootTex; if (!root) return ctx.ui.notify("No root TeX file found", "error"); const r = await runLatexmk(ctx.cwd, root); if (r.ok) await writeMap(ctx.cwd, await buildPaperMap(ctx.cwd)); ctx.ui.notify(r.ok ? `Compile OK: ${root}; equation numbers refreshed` : `Compile failed: ${root}; repair LaTeX errors before number lookup`, r.ok ? "info" : "error"); } });
  pi.registerCommand("mechpreview", { description: "Open compiled PDF using MECHPI_PDF_VIEWER or xdg-open", handler: async (_args, ctx) => { const map = await loadOrBuildMap(ctx); const pdf = map.rootTex ? map.rootTex.replace(/\.tex$/, ".pdf") : "main.pdf"; spawn(process.env.MECHPI_PDF_VIEWER ?? "xdg-open", [path.resolve(ctx.cwd, pdf)], { detached: true, stdio: "ignore" }).unref(); ctx.ui.notify(`Opening ${pdf}`, "info"); } });
  pi.registerCommand("mechquestions", { description: "Ask the agent to interrogate the current mechanics development", handler: async (args, _ctx) => { pi.sendUserMessage(`Use the mechanics research companion mode. Ingest/focus on the TeX source as needed, then ask me pointed development questions about ${args || "the current paper"}. Prioritize assumptions, balance laws, thermodynamics, constitutive choices, notation conflicts, and missing derivation steps.`); } });
}
