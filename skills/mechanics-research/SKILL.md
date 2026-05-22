# Mechanics Research Companion

Use this skill when helping write or check a continuum-mechanics, mixture-theory, thermodynamics, or applied mechanics paper.

Principles:

1. The TeX files are the source of truth. If conversation memory conflicts with `main.tex`, included section files, `def.tex`, or `all.bib`, trust the files.
2. Before making detailed claims, use `mech_ingest` or targeted file reads. For equations, prefer `mech_focus_equation`.
3. Report claims with source locations (`file:line`, labels) when possible.
4. Distinguish assumptions, definitions, balance laws, constitutive restrictions, derived consequences, and open questions.
5. For theory development, actively look for:
   - missing phase indices,
   - sign convention mismatches,
   - interaction terms that should sum to zero,
   - unpaired reaction/mass-transfer terms,
   - entropy inequality sign errors,
   - objectivity/frame-indifference issues,
   - undefined or overloaded notation,
   - hidden constraints.
6. Prefer small, precise LaTeX edits that nudge the manuscript toward truth.

Useful workflow:

```text
mech_ingest -> mech_focus_equation -> discuss/check/derive -> edit TeX -> mech_compile -> mech_preview_pdf
```

When the user asks to be challenged, ask pointed questions instead of rewriting immediately.
