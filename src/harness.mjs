// Harness detection + capabilities. A harness is anything that can resolve the
// loop's skills, honor its trigger, and run the prompt. Crucially, a loop needs
// SCHEDULING — a harness that can only run interactively (an IDE) can run the
// agent but cannot honor a recurring trigger; we warn when targeting one.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

function has(bin) {
  try {
    execSync(`command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Each harness: id, label, canSchedule, and a detect() that inspects cwd/env.
export const HARNESSES = [
  {
    id: "5dive",
    label: "5dive runtime",
    canSchedule: true,
    detect: () => has("5dive") || existsSync("/var/lib/5dive"),
  },
  {
    id: "github-actions",
    label: "GitHub Actions",
    canSchedule: true,
    detect: (cwd) => existsSync(join(cwd, ".github", "workflows")) || !!process.env.GITHUB_ACTIONS,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    canSchedule: false,
    detect: (cwd) => existsSync(join(cwd, ".claude")) || has("claude"),
  },
  {
    id: "cursor",
    label: "Cursor",
    canSchedule: false,
    detect: (cwd) => existsSync(join(cwd, ".cursor")),
  },
  {
    id: "cron",
    label: "system cron",
    canSchedule: true,
    detect: () => has("crontab"),
  },
];

export function getHarness(id) {
  return HARNESSES.find((h) => h.id === id);
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
