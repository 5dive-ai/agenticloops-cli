# agenticloops

Install and run **agentic loops** — recurring AI agents defined in a single
[`LOOP.md`](https://github.com/5dive-ai/loops/blob/main/SPEC.md) file: a trigger,
a set of skills, and a prompt. One file defines it; any harness can run it.

The directory lives at **[agenticloops.dev](https://agenticloops.dev?utm_source=github&utm_medium=referral&utm_campaign=agenticloops-cli-readme)**. This is
the install CLI — the loop-level analogue of `npx skills add`.

```bash
# install a loop onto the harness in the current project (auto-detected)
npx agenticloops install <owner/repo>

# target a specific harness
npx agenticloops install <owner/repo> --harness=5dive

# search the directory
npx agenticloops find research

# what's installed here + global install counts
npx agenticloops list
```

## Commands

| Command | What it does |
|---|---|
| `install <owner/loop>` | Fetch + validate the `LOOP.md`, install its skills, pre-flight its `requires`, and register the recurring job on your harness. |
| `find <query>` | Search the public directory. |
| `list` | Loops installed on this machine + their global install counts. |
| `update [<slug>]` | Re-fetch + re-install (all, or one). |

You can also point `install` / `validate` at a **local path** (`./my-loop` or a
`LOOP.md`) while you're authoring.

## How install works

Per the [spec](https://github.com/5dive-ai/loops/blob/main/SPEC.md):

1. **Fetch + validate** the `LOOP.md` against spec v0.1 (required: `name`,
   `description`, a `schedule`/`event` trigger).
2. **Install skills** (`skills:`). `owner/repo/skill` paths are fetched directly;
   bare names resolve against the skills registry; anything the harness already
   provides is used as-is. An unresolvable skill is skipped with a warning — a
   loop degrades rather than refusing to install.
3. **Pre-flight `requires`** (`cli` / `secrets` / `mcp` / `network`). This is
   **declare-and-check**: missing binaries, secrets, and servers are reported and
   you're prompted or the install refuses. Nothing is **ever auto-installed** —
   binaries, secrets, and MCP servers run code or carry trust, so that consent is
   yours.
4. **Register the trigger** on the harness (a recurring 5dive task, a GitHub
   Actions workflow, a cron scaffold, …).

### Harnesses

`5dive` · `github-actions` · `claude-code` · `cursor` · `cron`

Auto-detected from the current directory/env. A loop needs **scheduling**, so a
run-only harness (an IDE) can run the agent but can't honor a recurring trigger —
the installer warns you and suggests a scheduling harness.

## Telemetry — anonymous, opt-out, and exactly this

On a **successful install**, the CLI sends one fire-and-forget ping to
`agenticloops.dev/api/install` so the directory can show real install counts
(like npm download counts):

```json
{ "slug": "ci-analyst", "ts": "2026-06-30T12:00:00.000Z" }
```

That is the **entire** payload. The loop slug is a public id. We do **not** send
or store your IP, username, machine id, repo, prompt, or any other field. Updates
don't re-count. Failure is silent and never blocks an install.

**Opt out** any of these ways:

```bash
npx agenticloops install <owner/repo> --no-telemetry
AGENTICLOOPS_NO_TELEMETRY=1 npx agenticloops install <owner/repo>
DO_NOT_TRACK=1 npx agenticloops install <owner/repo>   # cross-tool standard
```

## License

MIT. Spec + directory: [github.com/5dive-ai/loops](https://github.com/5dive-ai/loops).
