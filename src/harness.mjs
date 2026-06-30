// Harness detection + capabilities. A harness is anything that can resolve the
// loop's skills, honor its trigger, and run the prompt. Crucially, a loop needs
// SCHEDULING — a harness that can only run interactively (an IDE) can run the
// agent but cannot honor a recurring trigger; we warn when targeting one.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

function has(bin) {
  try {
    execSync(`command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Each harness: id, label, canSchedule, headlessCmd (how it runs ONE prompt
// non-interactively — the portable multi-agent backend shells this), and a
// detect() that inspects cwd/env.
export const HARNESSES = [
  {
    id: "5dive",
    label: "5dive runtime",
    canSchedule: true,
    headlessCmd: ["claude", "-p"],
    detect: () => has("5dive") || existsSync("/var/lib/5dive"),
  },
  {
    id: "github-actions",
    label: "GitHub Actions",
    canSchedule: true,
    headlessCmd: ["claude", "-p"],
    detect: (cwd) => existsSync(join(cwd, ".github", "workflows")) || !!process.env.GITHUB_ACTIONS,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    canSchedule: false,
    headlessCmd: ["claude", "-p"],
    detect: (cwd) => existsSync(join(cwd, ".claude")) || has("claude"),
  },
  {
    id: "codex",
    label: "Codex CLI",
    canSchedule: false,
    headlessCmd: ["codex", "exec"],
    detect: (cwd) => existsSync(join(cwd, ".codex")) || has("codex"),
  },
  {
    id: "cursor",
    label: "Cursor",
    canSchedule: false,
    headlessCmd: ["claude", "-p"], // no native headless; use claude if present
    detect: (cwd) => existsSync(join(cwd, ".cursor")),
  },
  {
    id: "cron",
    label: "system cron",
    canSchedule: true,
    headlessCmd: ["claude", "-p"],
    detect: () => has("crontab"),
  },
];

export function getHarness(id) {
  return HARNESSES.find((h) => h.id === id);
}

// Where each harness keeps installed skills (a dir of <skill>/SKILL.md). Used
// to mark a skill "host-satisfied" only when it's VERIFIABLY present, so the
// skip is honest — never an asserted-but-unchecked built-in.
const SKILL_DIRS = {
  "claude-code": [join(homedir(), ".claude", "skills")],
  cursor: [join(homedir(), ".cursor", "skills")],
  "5dive": [join(homedir(), ".claude", "skills")],
};

export function hostSkillsFor(harnessId) {
  const dirs = SKILL_DIRS[harnessId] || [];
  const found = new Set();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"))) found.add(name);
      }
    } catch {
      /* unreadable dir — skip */
    }
  }
  return [...found];
}

// Auto-detect: prefer a schedulable harness when several are present, since a
// loop's whole point is the recurring trigger. Returns { harness, all }.
export function detectHarness(cwd = process.cwd()) {
  const all = HARNESSES.filter((h) => {
    try {
      return h.detect(cwd);
    } catch {
      return false;
    }
  });
  const scheduler = all.find((h) => h.canSchedule);
  return { harness: scheduler || all[0] || null, all };
}
