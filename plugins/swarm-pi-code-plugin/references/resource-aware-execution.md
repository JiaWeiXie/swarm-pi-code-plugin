# Resource-Aware Execution

Load this reference before a potentially expensive or recursive command.

1. Inspect indirect scripts, task targets, and available worker or shard
   controls.
2. Start with the smallest relevant target.
3. Run expensive stages sequentially; share one bounded result across sessions
   or perspectives.
4. Use concurrency only when the tool's syntax is verified, with a low practical
   limit.
5. When cost or fan-out remains unknown, narrow the command or return the risk
   to the user.

This is command-planning guidance. It grants no capability, lease, approval, or
delivery authority.
