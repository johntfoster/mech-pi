import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, ExtensionEditorComponent } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Image, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

interface EquationInfo {
  label?: string;
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
  citations: { key: string; file: string; line: number }[];
  bibKeys: { key: string; file: string; line: number }[];
  todos: { text: string; file: string; line: number }[];
  warnings: string[];
}

const IngestParams = Type.Object({
  root: Type.Optional(Type.String({ description: "Root TeX file, default auto-detects main.tex or first documentclass file" })),
  writeCache: Type.Optional(Type.Boolean({ description: "Write .mechpi/paper-map.json (default true)" })),
});

const FocusParams = Type.Object({
  label: Type.Optional(Type.String({ description: "Equation label, e.g. eq:entropy" })),
  contains: Type.Optional(Type.String({ description: "Fallback text/macro to search for inside equations" })),
  contextLines: Type.Optional(Type.Number({ description: "Nearby context lines to include (default 6)" })),
  edit: Type.Optional(Type.Boolean({ description: "Open an interactive terminal equation editor and save changes back to source (default false)" })),
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
  for (const env of envs) {
    const re = new RegExp(`\\\\begin\\{${env}\\*?\\}([\\s\\S]*?)\\\\end\\{${env}\\*?\\}`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const block = m[0];
      const start = lineOf(text, m.index);
      const end = start + block.split(/\r?\n/).length - 1;
      const label = block.match(/\\label\{([^}]+)\}/)?.[1];
      const lines = text.split(/\r?\n/);
      const nearby = lines.slice(Math.max(0, start - contextLines - 1), Math.min(lines.length, end + contextLines)).join("\n");
      out.push({ label, file: rel, lineStart: start, lineEnd: end, env, tex: block, nearby, symbols: extractSymbols(block) });
    }
  }
  return out.sort((a, b) => a.lineStart - b.lineStart);
}

async function buildPaperMap(cwd: string, rootArg?: string): Promise<PaperMap> {
  const root = await detectRoot(cwd, rootArg);
  const texFiles = await discoverTexClosure(cwd, root);
  const allFiles = await walk(cwd);
  const bibFiles = allFiles.filter(p => p.endsWith(".bib"));
  const map: PaperMap = {
    generatedAt: new Date().toISOString(), cwd, rootTex: root ? path.relative(cwd, root) : undefined,
    texFiles: texFiles.map(p => path.relative(cwd, p)), macros: [], equations: [], labels: [], refs: [], citations: [], bibKeys: [], todos: [], warnings: []
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
      for (const k of m[1].split(",").map(s => s.trim()).filter(Boolean)) map.citations.push({ key: k, file: rel, line: lineOf(clean, m.index) });
    }
  }
  for (const abs of bibFiles) {
    const rel = path.relative(cwd, abs);
    const text = await readText(abs).catch(() => "");
    for (const m of text.matchAll(/@\w+\s*\{\s*([^,]+),/g)) map.bibKeys.push({ key: m[1].trim(), file: rel, line: lineOf(text, m.index) });
  }
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

function summarizeMap(map: PaperMap): string {
  return [
    `Root: ${map.rootTex ?? "not found"}`,
    `TeX files: ${map.texFiles.length}`,
    `Macros: ${map.macros.length}`,
    `Equations: ${map.equations.length} (${map.equations.filter(e => e.label).length} labeled)`,
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

async function renderEquationPng(ctx: ExtensionContext, e: EquationInfo): Promise<{ base64: string; log?: string }> {
  const tempRoot = path.join(ctx.cwd, ".mechpi", "equation-render");
  await fs.mkdir(tempRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tempRoot, "eq-"));
  const texPath = path.join(dir, "equation.tex");
  const pdfPath = path.join(dir, "equation.pdf");
  const pngPrefix = path.join(dir, "equation");
  const pngPath = path.join(dir, "equation.png");
  const preamble = await rootPreamble(ctx);
  const document = `\\documentclass[border=6pt,varwidth]{standalone}
${preamble}
\\pagestyle{empty}
\\begin{document}
${e.tex}
\\end{document}
`;
  await fs.writeFile(texPath, document, "utf8");
  const env = { TEXINPUTS: `${ctx.cwd}//:${process.env.TEXINPUTS ?? ""}` };
  const latex = await run("pdflatex", ["-halt-on-error", "-interaction=nonstopmode", "-output-directory", dir, texPath], ctx.cwd, undefined, env);
  if (latex.code !== 0) throw new Error(`pdflatex failed while rendering equation:\n${(latex.stdout + latex.stderr).slice(-3000)}`);
  const ppm = await run("pdftoppm", ["-singlefile", "-png", "-r", "220", pdfPath, pngPrefix], ctx.cwd);
  if (ppm.code !== 0) throw new Error(`pdftoppm failed while rendering equation:\n${(ppm.stdout + ppm.stderr).slice(-2000)}`);
  const base64 = (await fs.readFile(pngPath)).toString("base64");
  fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return { base64 };
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
  try { rendered = await renderEquationPng(ctx, e); }
  catch (err) { renderError = err instanceof Error ? err.message : String(err); }
  return await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(`Typeset LaTeX preview: ${e.label ?? "(unlabeled)"}`)), 1, 0));
    if (rendered) {
      container.addChild(new Image(rendered.base64, "image/png", { fallbackColor: (s: string) => theme.fg("muted", s) }, { maxWidthCells: 100, maxHeightCells: 16 }));
    } else {
      container.addChild(new Text(theme.fg("warning", "Could not render a typeset preview; falling back to source."), 1, 0));
      container.addChild(new Text(theme.fg("dim", (renderError ?? "unknown render error").slice(0, 1200)), 1, 0));
      container.addChild(new Text(equationOnlyPreview(e.tex) || e.tex, 1, 0));
    }
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Spacer(1));
    const editor = new ExtensionEditorComponent(
      tui,
      keybindings,
      `${title}\nSave with Enter; newline with Shift+Enter; cancel with Esc/Ctrl+C; external vim/nvim via $EDITOR/$VISUAL shortcut.`,
      e.tex,
      value => done(value),
      () => done(null),
      { paddingX: 1 },
    );
    container.addChild(editor);
    return {
      get focused() { return editor.focused; },
      set focused(v: boolean) { editor.focused = v; },
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { editor.handleInput(data); tui.requestRender(); },
    };
  }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } });
}

export default function mechPi(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (await exists(path.join(ctx.cwd, "main.tex")) || (await walk(ctx.cwd).catch(() => [])).some(p => p.endsWith(".tex"))) {
      ctx.ui.setStatus("mech-pi", "mech-pi ready");
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const cache = path.join(ctx.cwd, ".mechpi", "paper-map.json");
    let mapNote = "No .mechpi/paper-map.json cache yet; use mech_ingest before detailed paper claims.";
    if (await exists(cache)) {
      try { mapNote = summarizeMap(JSON.parse(await readText(cache)) as PaperMap); } catch {}
    }
    return { systemPrompt: ctx.getSystemPrompt() + `\n\nMECH-PI RESEARCH MODE:\n- The LaTeX repository is the source of truth. If chat memory conflicts with TeX files, reload/ingest files and trust TeX.\n- For mechanics/theory claims, prefer focused source citations: file:line and equation labels.\n- Nudge toward truthful mechanics: distinguish assumptions, definitions, derivations, constitutive restrictions, and conjectures.\n- Use mech_ingest, mech_focus_equation, mech_search_symbol, mech_check, and mech_compile when relevant.\nCurrent paper cache summary:\n${mapNote}` };
  });

  pi.registerTool({
    name: "mech_ingest", label: "Mech Ingest", description: "Parse the current LaTeX paper repo into a mechanics-aware paper map cache.", promptSnippet: "Build a paper map from main.tex/includes/def.tex/all.bib for source-of-truth context.", promptGuidelines: ["Use mech_ingest before making claims about the current paper structure or notation."], parameters: IngestParams,
    async execute(_id, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Scanning LaTeX sources..." }], details: {} });
      const map = await buildPaperMap(ctx.cwd, params.root);
      if (params.writeCache !== false) await writeMap(ctx.cwd, map);
      return { content: [{ type: "text", text: summarizeMap(map) + (map.warnings.length ? `\n\nTop warnings:\n${map.warnings.slice(0, 20).join("\n")}` : "") }], details: map };
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("mech_ingest ")) + theme.fg("muted", args.root ? String(args.root) : "auto"), 0, 0); }
  });

  pi.registerTool({
    name: "mech_focus_equation", label: "Focus Equation", description: "Locate one LaTeX equation by label or contents and return exact source, context, symbols, and basic index warnings.", parameters: FocusParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const map = await loadOrBuildMap(ctx);
      let matches = map.equations;
      if (params.label) matches = matches.filter(e => e.label === params.label);
      if (!params.label && params.contains) matches = matches.filter(e => e.tex.includes(params.contains!));
      if (!params.label && !params.contains) return { content: [{ type: "text", text: "Provide label or contains." }], details: { matches: [] } };
      if (matches.length === 0) return { content: [{ type: "text", text: "No matching equation found. Run mech_ingest if cache is stale." }], details: { matches: [] } };
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
      const text = `Equation ${e.label ?? "(unlabeled)"}\n${e.file}:${e.lineStart}-${e.lineEnd}\nEnvironment: ${e.env}\n\nLaTeX:\n${e.tex}\n\nNearby context:\n${e.nearby}\n\nSymbols/macros seen:\n${e.symbols.join(", ")}${probs.length ? `\n\nIndex warnings:\n${probs.join("\n")}` : ""}`;
      return { content: [{ type: "text", text }], details: { equation: e, indexWarnings: probs, otherMatches: matches.length - 1 } };
    }
  });

  pi.registerTool({
    name: "mech_compile", label: "Compile LaTeX", description: "Run latexmk on the paper root and summarize errors/warnings.", parameters: CompileParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      const map = await loadOrBuildMap(ctx, params.root);
      const root = params.root ?? map.rootTex;
      if (!root) return { content: [{ type: "text", text: "No root TeX file found." }], details: { ok: false } };
      if (params.clean) { onUpdate?.({ content: [{ type: "text", text: "Cleaning latexmk artifacts..." }], details: {} }); await run("latexmk", ["-C", root], ctx.cwd, signal); }
      const args = ["-pdf", params.nonstop === false ? "" : "-interaction=nonstopmode", root].filter(Boolean);
      onUpdate?.({ content: [{ type: "text", text: `Running latexmk ${args.join(" ")}` }], details: {} });
      const r = await run("latexmk", args, ctx.cwd, signal);
      const combined = `${r.stdout}\n${r.stderr}`;
      const errors = combined.split(/\r?\n/).filter(l => /^! |LaTeX Error|Package .* Error/.test(l)).slice(0, 30);
      const warnings = combined.split(/\r?\n/).filter(l => /Warning|undefined references|Citation.*undefined/i.test(l)).slice(0, 40);
      const ok = r.code === 0;
      return { content: [{ type: "text", text: `${ok ? "Compile OK" : `Compile failed (exit ${r.code})`}\nRoot: ${root}\n\nErrors:\n${errors.join("\n") || "none"}\n\nWarnings:\n${warnings.join("\n") || "none"}` }], details: { ok, code: r.code, errors, warnings, stdoutTail: combined.slice(-8000) } };
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
  pi.registerCommand("mecheqedit", {
    description: "Open a focused terminal equation editor and save changes back to the TeX source. Usage: /mecheqedit eq:label or /mecheqedit contains:fragment",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) return ctx.ui.notify("Usage: /mecheqedit eq:label or /mecheqedit contains:fragment", "warning");
      const map = await loadOrBuildMap(ctx);
      const matches = query.startsWith("contains:")
        ? map.equations.filter(e => e.tex.includes(query.slice("contains:".length)))
        : map.equations.filter(e => e.label === query);
      if (matches.length === 0) return ctx.ui.notify("No matching equation found. Run /mechmap if cache is stale.", "warning");
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
  pi.registerCommand("mechcompile", { description: "Run latexmk on the detected paper root", handler: async (_args, ctx) => { const map = await loadOrBuildMap(ctx); const root = map.rootTex; if (!root) return ctx.ui.notify("No root TeX file found", "error"); const r = await run("latexmk", ["-pdf", "-interaction=nonstopmode", root], ctx.cwd); ctx.ui.notify(r.code === 0 ? `Compile OK: ${root}` : `Compile failed: ${root}`, r.code === 0 ? "info" : "error"); } });
  pi.registerCommand("mechpreview", { description: "Open compiled PDF using MECHPI_PDF_VIEWER or xdg-open", handler: async (_args, ctx) => { const map = await loadOrBuildMap(ctx); const pdf = map.rootTex ? map.rootTex.replace(/\.tex$/, ".pdf") : "main.pdf"; spawn(process.env.MECHPI_PDF_VIEWER ?? "xdg-open", [path.resolve(ctx.cwd, pdf)], { detached: true, stdio: "ignore" }).unref(); ctx.ui.notify(`Opening ${pdf}`, "info"); } });
  pi.registerCommand("mechquestions", { description: "Ask the agent to interrogate the current mechanics development", handler: async (args, _ctx) => { pi.sendUserMessage(`Use the mechanics research companion mode. Ingest/focus on the TeX source as needed, then ask me pointed development questions about ${args || "the current paper"}. Prioritize assumptions, balance laws, thermodynamics, constitutive choices, notation conflicts, and missing derivation steps.`); } });
}
