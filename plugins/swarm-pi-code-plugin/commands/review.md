---
description: Review working-tree or branch changes with a read-only Pi reviewer
argument-hint: '[working-tree|branch <base-ref>]'
allowed-tools: Bash, Read, Write, AskUserQuestion
---

Use the bundled `swarm-pi-code-plugin-review` skill. Apply `$ARGUMENTS` to select the target scope, verify every finding against the actual diff, and present confirmed findings by severity.
