#!/usr/bin/env node
// agenticloops — install and run agentic loops (recurring AI agents in one
// LOOP.md). One file defines it; any harness can run it. https://agenticloops.dev
import { install } from "../src/install.mjs";
import { runLoop } from "../src/runcmd.mjs";
import { loadRegistry, search } from "../src/registry.mjs";
import { listRecords, parseSchedule } from "../src/schedule.mjs";
import { fetchInstalls } from "../src/telemetry.mjs";
import { c, sym, fail, info, CliError } from "../src/util.mjs";

const VERSION = "0.1.2";

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      flags[k] = v === undefined ? true : v;
    } else positional.push(a);
  }
  return { positional, flags };
}

const HELP = `${c.bold("agenticloops")} — install and run agentic loops ${c.dim("v" + VERSION)}

${c.bold("Usage")}
  npx agenticloops install <owner/loop> [--harness=<id>] [--no-telemetry] [--yes] [--dry-run]
  npx agenticloops run <owner/loop|path> [--harness=<id>] [--backend=portable|5dive]
  npx agenticloops find <query>
  npx agenticloops list
  npx agenticloops update [<slug>]

${c.bold("Commands")}
  install   Fetch + validate a LOOP.md, install its skills, pre-flight its
            requirements, and register the recurring job on your harness.
  run       Execute a loop's chain once now (what a schedule fires). Multi-agent
            loops run each role in order, threading {{previous_output}} forward.
  find      Search the public directory (agenticloops.dev) for loops.
  list      Show loops installed on this machine + their install counts.
  update    Re-fetch + re-install a loop (all, or one slug).

${c.bold("Harnesses")}  5dive · github-actions · claude-code · cursor · cron
  Auto-detected from the current directory/env. A loop needs SCHEDULING, so a
  run-only harness (an IDE) is warned about; target a scheduler to run on time.

${c.bold("Flags")}
  --harness=<id>    Target a specific harness instead of auto-detecting.
  --no-telemetry    Don't send the anonymous install ping (slug + ts only).
                    Also honored: AGENTICLOOPS_NO_TELEMETRY=1, DO_NOT_TRACK=1.
  --yes             Assume yes to prompts (non-interactive installs).
  --dry-run         Show what would happen; change nothing, send nothing.

Spec: https://github.com/5dive-ai/loops/blob/main/SPEC.md  ·  MIT`;

async function cmdInstall(positional, flags) {
  const ref = positional[0];
  if (!ref) throw new CliError("usage: agenticloops install <owner/loop>", 2);
  await install(ref, {
    harness: typeof flags.harness === "string" ? flags.harness : undefined,
    noTelemetry: !!flags["no-telemetry"],
    yes: !!flags.yes,
    dryRun: !!flags["dry-run"],
  });
}

async function cmdRun(positional, flags) {
  const ref = positional[0];
  if (!ref) throw new CliError("usage: agenticloops run <owner/loop|path>", 2);
  const res = await runLoop(ref, {
    harness: typeof flags.harness === "string" ? flags.harness : undefined,
    backend: typeof flags.backend === "string" ? flags.backend : undefined,
  });
  if (flags.json) process.stdout.write(JSON.stringify(res.signed || res.receipt, null, 2) + "\n");
  process.exitCode = res.ok ? 0 : 1;
}

async function cmdFind(positional) {
  const query = positional.join(" ");
  const { loops, url } = await loadRegistry();
  if (!loops.length) throw new CliError("could not load the loop directory", 1);
  const hits = search(loops, query);
  if (!hits.length) {
    info(`no loops match "${query}" ${c.dim("(" + loops.length + " in the directory)")}`);
    return;
  }
  const installs = await fetchInstalls().catch(() => ({}));
  process.stderr.write(`\n${c.dim(`${hits.length} of ${loops.length} loops · ${url}`)}\n\n`);
  for (const l of hits.slice(0, 25)) {
    const n = installs[l.slug];
    const badge = l.imported ? c.dim(" [community]") : "";
    const count = typeof n === "number" ? c.dim(`  ${n}↓`) : "";
    process.stdout.write(
      `${c.bold(l.slug)}${badge}${count}\n  ${c.cyan(l.jobTitle || "")} — ${l.tagline || ""}\n` +
        (l.source?.repo ? `  ${c.dim("install: agenticloops install " + l.source.repo)}\n` : "") +
        "\n",
    );
  }
}

async function cmdList() {
  const recs = listRecords();
  if (!recs.length) {
    info("no loops installed on this machine yet. Try: agenticloops find <query>");
    return;
  }
  const installs = await fetchInstalls().catch(() => ({}));
  process.stderr.write(`\n${c.dim(recs.length + " installed")}\n\n`);
  for (const r of recs) {
    const n = installs[r.slug];
    const sched = r.cron ? r.cron : r.trigger?.value || "?";
    process.stdout.write(
      `${c.bold(r.slug)}  ${c.dim("on " + r.harness)}${typeof n === "number" ? c.dim("  " + n + "↓ globally") : ""}\n` +
        `  ${c.cyan(sched)} — ${(r.description || "").split("\n")[0]}\n` +
        `  ${c.dim(r.source || r.ref)}\n\n`,
    );
  }
}

async function cmdUpdate(positional, flags) {
  const recs = listRecords();
  const targets = positional[0] ? recs.filter((r) => r.slug === positional[0]) : recs;
  if (!targets.length) {
    info(positional[0] ? `"${positional[0]}" is not installed` : "nothing installed to update");
    return;
  }
  for (const r of targets) {
    info(`updating ${c.bold(r.slug)} ${c.dim("(" + r.ref + ")")}`);
    await install(r.ref, {
      harness: r.harness,
      yes: true,
      noTelemetry: true, // an update isn't a new install — don't double-count
      dryRun: !!flags["dry-run"],
    });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const cmd = positional.shift(); // first non-flag token is the command

  if (flags.version || flags.v || cmd === "version") {
    process.stdout.write(VERSION + "\n");
    return;
  }
  if (!cmd || flags.help || flags.h || cmd === "help") {
    process.stdout.write(HELP + "\n");
    return;
  }

  switch (cmd) {
    case "install":
    case "add":
      return cmdInstall(positional, flags);
    case "run":
      return cmdRun(positional, flags);
    case "find":
    case "search":
      return cmdFind(positional, flags);
    case "list":
    case "ls":
      return cmdList(positional, flags);
    case "update":
    case "upgrade":
      return cmdUpdate(positional, flags);
    default:
      throw new CliError(`unknown command "${cmd}". Run: agenticloops --help`, 2);
  }
}

main().catch((e) => {
  if (e instanceof CliError) {
    fail(e.message);
    process.exit(e.code || 1);
  }
  fail(e?.stack || String(e));
  process.exit(1);
});
