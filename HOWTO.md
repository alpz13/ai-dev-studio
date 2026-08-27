# How to use the Agent Loop

Right now (Phase 2) it's used from the command line, one feature at a time — there's no chat yet, nothing you can "talk" to directly. The actual flow, once you've done npm install and set your API key, is this:

```bash
npm run agent:dev -- feat_export-csv "Create an endpoint that exports reports to CSV"
```

There, the Dev agent starts up, launches the filesystem-git MCP pointed at workspaces/feat_export-csv/ (a new, isolated folder with its own git repo — it doesn't touch any of your real projects yet), and starts calling tools (read, write, list, git status/commit) until it finishes the task and commits. When it's done you have three things to check: the code in workspaces/feat_export-csv/ with its git history, the full trace in logs/feat_export-csv.jsonl (who did what, step by step), and the summary the agent prints to the console.

That's "using it" today: one task, one agent, one terminal run. It's still not the final product — it's the minimal piece to prove that the agent↔MCP↔Claude loop actually works.

## Roadmap and final experience

The way of using it worth keeping in mind, per the roadmap:

- Phase 3 (Director + pipeline): instead of invoking Dev directly, you talk to the Director with a single command — something like npm run studio -- "I want to export reports to CSV" — and it goes and runs PM → Architect → Dev → QA → DevOps on its own, checking the Feature State MCP to know where each one stands. At that point you no longer choose which agent to run.
- Phase 5 (chat with streaming): that same interaction, but through a web chat or a Telegram/Slack bot — you write the request in natural language and watch "PM: ✅ specs ready", "Dev: writing code...", etc. in real time. That's the final experience envisioned for the project: you never run agents by hand, you just talk to the Director.
- To resume something left half-done (what you asked for from the start), it would be npm run studio -- --resume feat_export-csv: the Director reads that feature's state.json and continues where it left off, without repeating PM/Architect if they were already done.

And an important clarification about the actual scope: for now this is meant as an isolated practice environment (each feature in its own disposable folder under workspaces/), not to be pointed at your real repos. The day you want to use it on a real project, you'd change WORKSPACE_ROOT to point at that repo — but I'd wait until the full pipeline is built and tested before giving it that kind of trust.
