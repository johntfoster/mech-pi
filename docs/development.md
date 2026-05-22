# Development

## Local setup

```bash
cd /home/jfoster/Documents/mech-pi
npm install
npm run typecheck
```

Use in a paper repository without installing:

```bash
cd /path/to/paper
pi -e /home/jfoster/Documents/mech-pi
```

After editing extension code in a running pi session:

```text
/reload
```

## Repository layout

```text
extensions/mech-pi.ts                 main pi extension
skills/mechanics-research/SKILL.md    source-grounded mechanics workflow skill
prompts/interrogate-mechanics.md      prompt template
docs/                                user/developer documentation
demo/DEMO.md                         walkthrough script
```

## Type checking

```bash
npm run typecheck
```

## Design notes

- The LaTeX repository is the source of truth.
- `.mechpi/paper-map.json` is a cache, not canonical state.
- Equation edits replace exact source blocks only if the original block is uniquely found in the source file.
- The rendered preview uses the manuscript preamble rather than KaTeX so project macros/packages are respected.

## Publishing

This package can be installed by pi directly from GitHub:

```bash
pi install git:github.com/johntfoster/mech-pi
```

No npm publish is required for GitHub distribution.
