# Changelog

## Unreleased

### Prompt, navigation, and copy mode

- Added a vim-style modal prompt editor with `INSERT`, `NORMAL`, `VISUAL`, and `VISUAL LINE` modes.
- Added persistent prompt history in `.mechpi/prompt-history.json`, with prefix-filtered `Up`/`Down` browsing and `MECHPI_PROMPT_HISTORY_LIMIT`.
- Added prompt and equation-editor `J` line-join behavior.
- Added tmux-like full-screen copy mode (`Ctrl-a` then `]`) with vim-style movement, visual selections, yanking, paste back to prompt, and image-aware linewise copying.
- Standardized focus return behavior: most commands/dialogs return to prompt `INSERT`; copy mode returns to `NORMAL` for immediate `p`/`P` paste.

### Voice input

- Added `/mechvoice` with recording/transcription control, optional wake-word integration hook, and configurable recorder/STT backends.
- Made hold-`Space` push-to-talk opt-in via `MECHPI_VOICE_SPACE_HOLD=1` to avoid prompt lockups during normal typing.

### Manuscript and equation workflows

- Extended paper-map ingestion to capture equation numbers from `.aux` files and explicit `\tag{...}` entries.
- Added rendered-equation-number lookup for `/mecheqedit number:...` and the `mech_focus_equation` tool.
- Added `/mechedit` for source-grounded manuscript location search and external-editor launch.
- Improved equation previews to preserve original PDF equation numbers in isolated renderings when aux/tag data is available.

### Citation workflows

- Added `/mechaddcite` with local `.bib` search plus Crossref, OpenAlex, Semantic Scholar, arXiv, DOI BibTeX, and Google Scholar manual fallback.
- Added `/mechaddcite` multi-select with `Space`, batch `.bib` append, and combined TeX citation insertion.
- Added citation detail drilldown: `l` shows conservative metadata/abstract summary; second `l` opens the best web reference.
- Added `/mechaddcite --to-bib` / `-b` to add bibliography entries without editing TeX.
- Added `/mechaddcite --keep-local` / `-l` to copy/download source documents into `.mechpi/ingest/sources/` and add/update BibTeX `file = {...}` fields.
- Added `/mechgotocite` for local `.bib` fuzzy search, best-URL opening, command-line autocomplete, and autocomplete cycling with `Tab`, `Shift-Tab`, `Up`, and `Down`.

### Reference ingestion and RAG

- Added `/mechingest` to select local `.bib` references and local project files, extract text, chunk content, and build `.mechpi/ingest/vector-store.json`.
- Upgraded the ingest store from token overlap to real text embeddings when available. Default backend is Python `sentence-transformers` with `sentence-transformers/all-MiniLM-L6-v2`; OpenAI and custom command providers are configurable.
- Added automatic per-query RAG injection from `.mechpi/ingest/vector-store.json` in `before_agent_start`; falls back to lexical retrieval if embeddings are unavailable.
- Added `/mechingest` progress bar through extraction, chunking, embedding, and vector-store writing.
- Added local `AGENTS.md` creation/update from `/mechingest`, instructing future agents to use vector-store RAG first and avoid redundant broad filesystem searches.
- Added strict `.bib` source resolution order: explicit verified `file`/`pdf` path, DOI metadata and DOI/URL PDF download, then bounded `$HOME` search only after DOI download fails.
- Hardened metadata verification for local and downloaded documents: DOI/title/venue/year/author evidence, near-title proximity, journal-article type checks, and slide-deck rejection for journal article entries.
- If a verified `$HOME` document is found for a BibTeX entry, `/mechingest` surgically adds or updates that entry's `file = {...}` field.
- If no verified match exists or matches are ambiguous, `/mechingest` marks the source `needs-clarification` and refuses to ingest it.
- Unchecking an already-ingested source removes it from the next rebuilt vector store and deletes that source's cached text/source artifacts.
- Added `/mechingest` in-popup source verification: green `✓` means already ingested; gray `✓` means staged. `l` opens a summary from the actual extracted text; a second `l` opens the stored source document externally for clean inspection.
- Added `/mechingest` popup search focus behavior: `Esc` focuses search, `Enter` returns to selector rows, and `j`/`q` from search cancels to prompt.
- Fixed `/mechingest` popup close repainting so cancelling from search returns cleanly to the prompt without blanking the model/status area.
- Gave mech-pi overlay popups a full-width opaque popup background so underlying chat/model text does not bleed through transparent spaces.

### Documentation

- Updated README and command/keybinding docs for new slash commands, prompt behavior, citation workflows, reference ingestion, embedding configuration, and preview behavior.

## 0.1.0

- Initial pi package for mechanics-aware LaTeX paper development.
- Paper-map ingestion into `.mechpi/paper-map.json`.
- Equation focus by label or source fragment.
- Interactive equation editor with manuscript-preamble rendered PNG preview.
- LaTeX compile and PDF preview tools.
- Symbol search and lightweight checks.
- Mechanics research skill and interrogation prompt.
- Documentation for installation, commands, equation editing, and terminal image settings.
