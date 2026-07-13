# Documentation Update SOP

This SOP keeps product documentation aligned with the released
`swarm-pi-code-plugin` experience. It applies to README changes, reference
documentation, command and skill guidance, and committed screenshots.

The user-facing guide should explain the current product plainly. Technical
detail belongs in focused references, not in setup instructions.

## 1. Start With Product Evidence

Before drafting, inspect the current implementation rather than relying on
earlier plans, issue descriptions, or screenshots.

- Verify every command, skill, runner option, and manifest name against the
  packaged plugin.
- Exercise the changed flow when practical, including both host surfaces when
  their instructions differ.
- Identify the audience for each document: README for users, architecture for
  stable runtime boundaries, and configuration reference for the setup model
  and security constraints.
- Treat old screenshots as historical evidence only. Do not publish them when
  the product flow, labels, or visual design has changed.

Document only behavior that is present and verified. If an intended behavior
is not implemented yet, keep it out of user instructions or label it clearly
as future work in an appropriate planning document.

## 2. Plan The Documentation Surface

Write a short outline before editing. Start from the user journey and link to
technical detail instead of duplicating it.

For a product-facing README, keep this order unless the change calls for a
different one:

1. What the plugin does and who owns delivery decisions.
2. A compact architecture overview.
3. Installation and scenario-based usage.
4. Troubleshooting for real failure states.
5. Development and local validation.
6. Tools, references, and license.

Use exact, copyable commands and skill names. When Claude Code and Codex have
different entry points, present them side by side in a table or adjacent
examples. Keep runtime details, file formats, and security rationale in
`docs/architecture.md` or `docs/configuration.md` and cross-link from the
README.

## 3. Use Screenshots Only as Current Evidence

Screenshots are optional. Include them only when they materially improve the
user journey and can be reproduced from the current build with mock local
endpoints and fictional data. Never include API keys, real tokens, personal
repository paths, or live customer/provider information.

When documenting the complete guided configuration flow, a useful sequence is:

1. Empty connection state.
2. Custom endpoint discovery.
3. Project setup.
4. Full review.
5. Saved completion.
6. Project-only reconfiguration.

Store committed images under `docs/assets/setup/` using ordered, descriptive
names. Inspect them at desktop size and exercise the same flow at a mobile
viewport before publishing. If labels, controls, provider/model examples, or
the step sequence no longer match, remove the image reference immediately;
do not keep a stale screenshot as decoration. Unreferenced historical assets
may be cleaned up in a separate binary-asset change.

## 4. Write And Cross-Link

- Use English-first prose because the product UI, CLI, and host surfaces are
  English.
- Explain decisions in user terms before implementation terms.
- Keep README troubleshooting actionable: describe the symptom, likely cause,
  and the next safe action.
- Prefer links to a dedicated reference over repeating long technical text.
- Update reciprocal links whenever a document is renamed or its responsibility
  changes.
- Keep image alt text meaningful and paths relative to the Markdown file.

Avoid stale milestone/status narratives in stable reference documents. Avoid
presenting an exhaustive provider catalog when the product intentionally shows
only usable connections.

## 5. Validate Before Commit

The repository includes an AI-oriented documentation impact checker:

```bash
mise run docs-check
mise run docs-check-staged
mise run docs-check-ci -- --base <sha> --head <sha>
```

Functional changes require both README files. Configuration Web changes also
require the Configuration reference and the current Web implementation; visual
changes in `src/web/ui.ts` require a current setup screenshot or an explicit,
reasoned `Screenshot-Impact: reviewed-current` declaration. The checker reads
inline Markdown images, reference-style images, and HTML `img` sources, while
ignoring remote and data URLs. It rejects broken local references and
repository-escaping paths.

The pre-commit hook is advisory for humans. AI agents must treat a failed
`docs:check` report as unfinished work. CI uses explicit base/head revisions and
blocks high-confidence missing obligations on pull requests. A declaration is
valid only with a meaningful reason and must be preserved on the pull request's
head commit; it cannot hide a broken image reference.

The six current screenshots can be regenerated from the fictional fixture:

```bash
mise run docs-screenshots-install
mise run docs-screenshots
mise run docs-screenshots-validate
```

The generator uses a fixed 1440x1000 Chromium headless context, UTC, English,
light mode, reduced motion, and one sequential browser session. It never reads
real credentials or project state. The generated images are evidence of the
current UI, not proof that every visual pixel is platform-independent.

Run the checks that match the changed surface:

```bash
mise run check
mise run lint
mise run fmt-check
mise run version-check
mise run version-check-installed
claude plugin validate plugins/swarm-pi-code-plugin
```

`mise run version-check` validates the repository's synchronized version sources.
`mise run version-check-installed` additionally compares the installed Claude
Code and Codex plugin records with the repository, verifies that the local
Codex source is correct and enabled, and rejects a Claude manifest that declares
the automatically loaded `hooks/hooks.json`. Use `mise run version-bump -- patch`
for releases; it reinstalls the local Codex plugin before and after writing the
new version so the new Codex manifest value is loaded.

When a documentation change mentions plugin commands, skills, manifests, or
packaged runtime behavior, also run the plugin package validator. When it
documents a user interface, review current screenshots at desktop and mobile
widths. Use the Browser plugin when available; otherwise record the regular
Playwright fallback in the change notes.

Check every local Markdown link and image path. Confirm command examples match
the actual runner arguments and host manifests. Review the final diff with a
reader's eye: the README should remain a usable guide rather than a changelog.

For Codex skills, run the installed `quick_validate.py` from the skill-creator
package against every changed skill. When source or packaged runtime behavior
is mentioned, `mise run check-runtime-parity` is mandatory.

## 6. Maintain Research Separately

Research directories are decision records, not release notes. Keep one current
assessment, one durable decision record, one roadmap, and focused risk studies
that still affect implementation. When a later synthesis supersedes several
proposal drafts, move the surviving decisions into those maintained documents
and delete the duplicates. Git history preserves the original investigation.

Research may describe future work, but it must label implemented, partial,
deferred, and deleted behavior explicitly. Stable user references must never
inherit a future claim from research without code and test evidence.

## 7. Close The Documentation Loop

Keep documentation work in its own feature branch and worktree after the
decision is made. Commit a reviewable, rollback-sized documentation batch once
the checks pass. If validation or review uncovers a mismatch, fix the product
or the documentation, rerun the relevant checks, and update this SOP when the
lesson is generally reusable.

This document is the project's durable record of the documentation workflow.
Use it at the beginning of future documentation loops and improve it only when
new evidence changes the practice.
