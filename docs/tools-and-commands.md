# Tools and commands

For prompt editing and tmux-like copy-mode keys, see [keybindings.md](keybindings.md).

## Slash commands

### `/mechmap [root.tex]`

Ingest the current LaTeX repository and write `.mechpi/paper-map.json`. If compiled `.aux` files are present, the map also records label-to-equation-number data from `\newlabel` entries.

### `/mechedit query`

Find a likely manuscript location from a natural-language query, equation label, rendered equation number already present in the paper map, or `file.tex:line` reference and open it in an external editor.

Examples:

```text
/mechedit entropy inequality
/mechedit capillary pressure constitutive law
/mechedit eq:mom_gas
/mechedit sections/model.tex:120
```

This command uses the paper map plus lexical/semantic-ish scoring over equation source, labels, known equation numbers, section headings, and nearby prose. It then launches an external editor at the best matching line. Direct `file.tex:line` references are opened without searching.

By default it uses `MECHPI_EDITOR`, `VISUAL`, `EDITOR`, or `nvim`. For GUI editors such as VS Code/Codium it uses the editor's line-opening arguments. For terminal editors, `mech-pi` opens a new Kitty window when Kitty is available. You can override the terminal launcher with `MECHPI_EDITOR_TERMINAL`.

Useful settings:

```bash
export MECHPI_EDITOR=nvim
export MECHPI_EDITOR_TERMINAL=kitty
```

Embedding a live `nvim` session inside pi's TUI is not currently supported reliably; launching an external terminal/editor is the intended workflow. After editing, return to pi and run `/mechmap` if you want to force-refresh the paper map cache immediately.

### `/mecheqedit eq:label`

Open a focused equation editor for a labeled equation. The top panel shows a compiled/typeset preview when terminal image display is available. The lower panel edits the exact LaTeX source block. Saving replaces the equation block in the manuscript and rebuilds `.mechpi/paper-map.json`.

Example:

```text
/mecheqedit eq:mom_gas
```

### `/mecheqedit number:2.14`

Open a focused equation editor by rendered PDF equation number. If `.aux` files are missing or stale, `mech-pi` runs `latexmk` first to refresh label-to-number data. If compilation fails, repair the reported LaTeX errors, rerun `/mechcompile`, and try again.

This lookup is exact for labeled equations and explicit `\tag{...}` entries. Standard LaTeX `.aux` files do not identify automatically numbered equations that have no `\label`; add a label or explicit tag if you need number-based lookup for those displays.

Example:

```text
/mecheqedit number:2.14
```

### `/mecheqedit contains:fragment`

Open the first equation whose source contains `fragment`.

Example:

```text
/mecheqedit contains:\rho_g\mbf{a}_g
```

### `/mechaddcite prompt`

Find citation candidates for a natural-language citation need, show a keyboard-navigable popup, then add the chosen citation to the paper or bibliography.

Behavior:

- Searches existing paper `.bib` files first.
- Searches Crossref, OpenAlex, Semantic Scholar, and arXiv when local entries are insufficient.
- Adds a Google Scholar manual fallback row that opens Scholar in a browser and lets you paste BibTeX for validation.
- Uses DOI content negotiation for authoritative BibTeX when possible.
- `j`/`k` or arrows move the highlighted row, `Space` toggles multi-selection with a ✅ marker, first `l` opens a detail view with an LLM summary based only on fetched metadata/abstract, second `l` from the detail view opens the best web reference for the paper, `h` returns to the list, and `Enter` inserts the highlighted citation or all checked citations.
- If multiple citations are checked, all selected entries are added to the `.bib` file when needed and inserted as one citation command at the source-grounded TeX location.
- Auto-inserts only when metadata and TeX location are high confidence; otherwise asks for confirmation. If no high-confidence TeX location can be determined, `mech-pi` adds/reuses the BibTeX entry and opens an external editor at the closest likely source location for manual citation placement.
- `--to-bib` / `-b`: add/reuse selected citation(s) in the bibliography only; do not edit TeX.
- `--keep-local` / `-l`: copy a matching local paper from `$HOME`, or download DOI/URL content when possible, into `.mechpi/ingest/sources/` for later `/mechingest` use. When a stored document is found, `mech-pi` adds/updates a `file = {...}` field in the BibTeX entry for faster future lookup.

Example:

```text
/mechaddcite We need a citation to support the statement in the paper: Such swelling can cause fracturing in rock formations. I recall studies about a city in southern Germany that drilled wells into an anhydrite formation and caused uplift.
```

### `/mechciteedit query`

Fuzzy-select a local BibTeX entry and edit the exact `.bib` entry in-terminal. The top panel shows a compiled formatted-reference preview when possible; if the bibliography-style render fails, `mech-pi` falls back to a rendered metadata-card preview. The editor normalizes line endings for display but restores the source `.bib` file's line-ending style on save.

Example:

```text
/mechciteedit silling peridynamic states
```

### `/mechgotocite query`

Fuzzy-search local BibTeX entries and open the selected citation's best website. Matching uses cite keys plus title, authors, year, journal/booktitle, DOI, and URL fields from the local `.bib` files.

As you type the argument on the prompt line, normal autocomplete shows matching citations immediately. Use `Tab` or `Up`/`Down` to cycle the highlighted autocomplete row, then press `Enter`; the selected `/mechgotocite ...` completion opens the best page directly. If you submit a nonempty query without choosing a completion, `mech-pi` opens the top fuzzy match. With no argument, it falls back to an interactive picker.

URL priority is the same as `/mechaddcite` detail-page web opening: DOI resolver first, then local URL/journal page, then arXiv, then a Google Scholar title search fallback.

Example:

```text
/mechgotocite anhydrite uplift
```

### `/mechingest keywords`

Build a project-local retrieval store under `.mechpi/ingest/` from selected local files and bibliography references. The command opens a live fuzzy selector seeded by `keywords`.

Selectable items include:

- local `.bib` references,
- local documents/text files in the current repository, including `.pdf`, `.md`, `.txt`, `.tex`, `.bib`, `.csv`, `.json`, `.yaml`, and `.docx` when `pandoc` is installed.

Keys:

- type text or use command-line autocomplete after `/mechingest`: refine fuzzy search over local `.bib` entries and local files in the current working directory only
- `Esc` from the selector locks focus to the search box for editing; `Enter` from the search box returns focus to the selector rows
- while search is focused, `j` or `q` cancels and returns to the prompt
- `Space`: toggle selection; a green `✓` means already ingested in the vector store, while a gray `✓` means staged for ingestion. Unchecking an already-ingested item removes it from the next rebuilt vector store and deletes that source's cached text/source artifacts.
- `j`/`k`, arrows, or `Tab`/`Shift-Tab`: move the highlighted row while selector rows are focused
- `l`: open a summary of the actual currently stored/extracted source for an already-ingested item
- second `l` from the summary: open the stored source document externally with `MECHPI_DOCUMENT_VIEWER`, `MECHPI_PDF_VIEWER`, or `xdg-open`
- `h`: return from summary to the selection list
- `Enter`: rebuild the ingest store from the currently selected items
- `q` or root-list `h`: cancel

For selected `.bib` references, `mech-pi` uses a strict source order:

1. Check explicit BibTeX `file`/`pdf` paths first, and accept them only after verifying against BibTeX/Crossref DOI metadata such as title or DOI.
2. Query DOI metadata when a DOI is present, then try to download the paper through DOI/URL resolution and common PDF links on the landing page. Downloaded PDFs must still pass metadata verification.
3. Only if DOI/URL download fails, run a broad but bounded `$HOME` search (`MECHPI_HOME_SEARCH_LIMIT`, default 25000 files; `MECHPI_HOME_SEARCH_NAME_LIMIT`, default 10000 filename matches) and score all candidates to select the best metadata match rather than stopping at the first plausible filename. Filename search uses author family names, distinctive title words, and DOI fragments, then verifies extracted PDF/text front matter. A candidate is accepted only if its extracted metadata tightly matches the expected title/DOI/venue/year/author evidence, including near-title proximity rather than scattered keyword hits. If the BibTeX/Crossref metadata says the source is a journal article, presentation/slide-deck-like PDFs are rejected, and a DOI mention alone is not sufficient because slide decks/books often contain article DOIs in references. If this finds a verified local file, `mech-pi` surgically adds/updates the BibTeX `file = {...}` field for future runs.
4. If no verified document or downloadable PDF is available, or if multiple plausible local matches are ambiguous, the source is marked `needs-clarification` and is not ingested. `mech-pi` should prefer asking for clarification over putting a doubtful paper into the vector store.

PDFs are converted with `pdftotext` when available; OCR is noted as unavailable when embedded text extraction fails.

While rebuilding, `/mechingest` shows a status-line progress bar through extraction, chunking, embedding, and writing `.mechpi/ingest/vector-store.json`.

Future prompts in the same project automatically embed the new query, retrieve relevant chunks from `.mechpi/ingest/vector-store.json`, and add them to the model context as reference material. The store uses real text embeddings when available: by default `mech-pi` uses the free/open-source Python `sentence-transformers` backend with `sentence-transformers/all-MiniLM-L6-v2`, installed into the package-local `.mechpi-python/` environment by `npm postinstall`; set `MECHPI_PYTHON` to another Python, `MECHPI_EMBED_MODEL` to another local/Hugging Face model, `MECHPI_EMBED_PROVIDER=openai` for OpenAI embeddings, or `MECHPI_EMBED_PROVIDER=command` with `MECHPI_EMBED_COMMAND` for a custom local embedding command. If embeddings are unavailable, the store records the error and temporarily falls back to lexical retrieval.

The command also creates or updates a local `AGENTS.md` block instructing future agents to use the injected vector-store RAG context first, and to inspect `.mechpi/ingest/` before broad filesystem searches when more retrieval is needed. Running `/mechingest` again lets you add or unselect items and rebuilds the store.

Example:

```text
/mechingest anhydrite swelling uplift
```

### `/mechvoice [status|start|stop|toggle|wake on|wake off]`

Speech-to-text input for the prompt editor. `/mechvoice start` records from the default Linux microphone, `/mechvoice stop` stops and transcribes, and `/mechvoice toggle` switches between those states. If `sox`/`rec` is available, recording also stops automatically after a configurable silence interval. The transcribed text is inserted into the prompt editor; set `MECHPI_VOICE_AUTOSUBMIT=1` to submit it immediately.

The prompt editor also supports optional push-to-talk. Set `MECHPI_VOICE_SPACE_HOLD=1`, then hold `Space` on an empty prompt for `MECHPI_VOICE_HOLD_MS` milliseconds, speak, and release `Space`; transcription starts after `MECHPI_VOICE_RELEASE_GRACE_MS` milliseconds. This requires a terminal/key-protocol path that reports key-release events. It is opt-in so ordinary typing is never blocked by voice capture.

Wake-word mode is an integration hook, not a built-in recognizer: set `MECHPI_WAKE_WORD_COMMAND` to a local command that exits 0 when it hears the wake word, then run `/mechvoice wake on`.

### `/mechcompile`

Run `latexmk -pdf -interaction=nonstopmode` on the detected root TeX file. On success, `mech-pi` rebuilds `.mechpi/paper-map.json` so equation-number data from `.aux` is fresh.

### `/mechpreview`

Open the compiled root PDF using `MECHPI_PDF_VIEWER` or `xdg-open`.

### `/mechquestions [topic]`

Ask pi to interrogate the mechanics development around a topic.

## Agent tools

These are callable by the model during normal conversation.

### `mech_ingest`

Builds the paper map from TeX sources and bibliography files.

Parameters:

- `root?: string` — root TeX file, otherwise auto-detects `main.tex` or a file with `\documentclass`.
- `writeCache?: boolean` — write `.mechpi/paper-map.json`; defaults to true.
- `compileIfAuxMissing?: boolean` — run `latexmk` first when `.aux` files needed for equation numbers are missing or stale; defaults to false.

### `mech_focus_equation`

Locates one equation by label, rendered equation number, or contents and returns source, context, symbols, equation-number metadata, and index warnings.

Parameters:

- `label?: string`
- `number?: string` — rendered PDF/aux equation number such as `2.14`.
- `contains?: string`
- `contextLines?: number`
- `edit?: boolean` — when true, opens the interactive equation editor.
- `autoCompile?: boolean` — for number lookup, run `latexmk` if `.aux` files are missing/stale; defaults to true.

### `mech_search_symbol`

Searches all ingested TeX files for a macro, symbol, or text fragment.

### `mech_check`

Runs lightweight checks for references, citations, duplicate labels, TODOs, and simple index red flags.

### `mech_compile`

Runs latexmk and summarizes errors/warnings.

### `mech_preview_pdf`

Opens the compiled PDF.

## Related environment variables

- `MECHPI_EDITOR` — preferred external editor for `/mechedit` and low-confidence `/mechaddcite` placement; falls back to `VISUAL`, `EDITOR`, then `nvim`.
- `MECHPI_EDITOR_TERMINAL` — terminal launcher for terminal editors; defaults to Kitty when available.
- `MECHPI_PDF_VIEWER` — viewer command for `/mechpreview`, `mech_preview_pdf`, and `/mechingest` source opening when `MECHPI_DOCUMENT_VIEWER` is unset.
- `MECHPI_DOCUMENT_VIEWER` — viewer command for opening stored source documents from `/mechingest`; defaults to `MECHPI_PDF_VIEWER` then `xdg-open`.
- `BROWSER` — browser command for the Google Scholar manual fallback and detail-page `l` web opening in `/mechaddcite`; defaults to `xdg-open`.
- `MECHPI_PROMPT_HISTORY_LIMIT` — number of persistent prompts to keep in `.mechpi/prompt-history.json`; defaults to 100.
- `MECHPI_PREVIEW_MAX_QUALITY=1` — experimental maximum-quality preview mode. It raises inline LaTeX DPI to 2400 and makes equation-editor adaptive rendering target much larger rasters. This is slower and can create large terminal image payloads, but is useful for comparing sharpness.
- `MECHPI_LATEX_PREVIEW_DPI` / `MECHPI_EQUATION_PREVIEW_DPI` — rendering DPI knobs for generated equation PNG previews; chat inline LaTeX defaults to 900 DPI, or 2400 when `MECHPI_PREVIEW_MAX_QUALITY=1`. Equation-editor previews use adaptive DPI unless `MECHPI_EQUATION_PREVIEW_DPI` is set.
- `MECHPI_EQUATION_PREVIEW_MIN_DPI` / `MECHPI_EQUATION_PREVIEW_MAX_DPI` / `MECHPI_EQUATION_PREVIEW_OVERSAMPLE` — adaptive equation-editor DPI controls; defaults are 600, 2400, and 2; in maximum-quality mode defaults are 2400, 9600, and 8.
- `MECHPI_LATEX_PREVIEW_SCALE` — terminal width scaling knob for chat inline LaTeX previews and equation-editor previews.
- `MECHPI_STT_COMMAND` — custom speech-to-text command. Use `{audio}` as the recorded WAV path; stdout is inserted as the transcript.
- `MECHPI_WHISPER_CPP_MODEL` — path to a `whisper.cpp` model for `whisper-cli` transcription when `MECHPI_STT_COMMAND` is not set.
- `MECHPI_WHISPER_CPP_BIN` — optional `whisper.cpp` executable name/path if it is not `whisper-cli`.
- `MECHPI_WHISPER_MODEL` — OpenAI Whisper model name for the `whisper` Python CLI fallback; defaults to `tiny.en`.
- `MECHPI_RECORD_COMMAND` — custom recording command. Use `{audio}` as the output WAV path.
- `MECHPI_VOICE_SPACE_HOLD=1` — enable space-hold push-to-talk on an empty prompt; off by default.
- `MECHPI_VOICE_HOLD_MS` / `MECHPI_VOICE_RELEASE_GRACE_MS` — push-to-talk timing; defaults are 1000 ms and 1000 ms.
- `MECHPI_VOICE_SILENCE_SECONDS` / `MECHPI_VOICE_SILENCE_THRESHOLD` — `sox rec` silence-stop controls; defaults are `1.0` and `1%`.
- `MECHPI_VOICE_AUTOSUBMIT=1` — submit transcribed voice text immediately instead of just inserting it.
- `MECHPI_KEEP_VOICE_AUDIO=1` — keep temporary voice WAV/transcription files under `.mechpi/` for debugging.
- `MECHPI_WAKE_WORD_COMMAND` — local wake-word command that exits 0 on detection; `/mechvoice wake on` restarts it after each utterance.
- `MECHPI_WAKE_ON_START=1` — start the wake-word listener automatically when pi starts.
