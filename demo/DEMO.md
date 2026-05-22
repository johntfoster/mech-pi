# mech-pi demo script

This is the morning walkthrough for using `mech-pi` inside a mechanics LaTeX paper repo.

## 1. Start pi with the extension

```bash
cd /home/jfoster/Documents/LaTeX/FourPhaseReactingMixture_Pi
pi -e /home/jfoster/Documents/mech-pi
```

Or install once:

```bash
pi install /home/jfoster/Documents/mech-pi
pi
```

## 2. Ingest the paper

In pi:

```text
/mechmap
```

Expected result: a `.mechpi/paper-map.json` file appears in the paper repo. The status summary shows root file, TeX file count, equation count, labels/refs/citations, TODOs, and warnings.

## 3. Ask source-grounded questions

```text
What is the logical structure of the current paper? Use the TeX as truth.
```

The agent should use `mech_ingest` if the cache is stale, then answer from the paper map and file contents.

## 4. Focus on one equation

```text
Focus on equation eq:entropy-inequality. Explain every term and ask me what assumptions are missing.
```

If you do not remember the label:

```text
Find equations containing \eta and focus on the most important one.
```

The focused view returns exact source, nearby prose, symbols/macros, and simple index warnings.

## 5. Compile and preview

```text
/mechcompile
/mechpreview
```

Or ask naturally:

```text
Compile the paper. If it fails, summarize only the first real LaTeX error.
```

## 6. Interrogate the development

```text
/mechquestions entropy production and reacting phase mass transfer
```

The agent should ask pointed mechanics questions instead of drifting into generic prose.

## 7. Edit with the source of truth loop

```text
Add a short clarification after the entropy inequality distinguishing assumptions from constitutive restrictions. Then compile.
```

The intended loop is:

```text
ingest/focus -> discuss -> precise TeX edit -> compile -> preview -> repeat
```

## 8. Demo recording outline

If recording a video/asciinema:

1. Launch pi in the LaTeX repo with `-e /home/jfoster/Documents/mech-pi`.
2. Run `/mechmap`.
3. Ask: `focus the main entropy inequality and challenge the derivation`.
4. Run `/mechcompile`.
5. Run `/mechpreview`.
6. Ask: `make a three-step plan to nudge this section toward truth`.

The key behavior to show: pi does not rely on stale chat memory; it reloads the TeX context and cites exact equation source.
