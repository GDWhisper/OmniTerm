/**
 * Auto Pull Extension
 *
 * Merges latest dev branch into current branch at session start.
 * Project-local: .pi/extensions/auto-pull.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Check we're in a git repo
    const { code: branchCode } = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
    if (branchCode !== 0) return;

    // Stash dirty working tree before pull
    const { stdout: statusOut } = await pi.exec("git", ["status", "--porcelain"]);
    const hasChanges = statusOut.trim().length > 0;
    if (hasChanges) {
      await pi.exec("git", ["stash", "push", "-m", "auto-pull: stash before merge dev"]);
    }

    // Fetch and merge latest dev into current branch
    const { stdout, stderr, code } = await pi.exec("git", ["pull", "origin", "dev"], {
      timeout: 15000,
    });

    if (code !== 0) {
      // Abort any in-progress merge to leave repo clean
      await pi.exec("git", ["merge", "--abort"]);

      const output = `${stdout}${stderr}`.trim();
      if (output.includes("CONFLICT") || output.includes("Automatic merge failed")) {
        ctx.ui.notify("merge dev conflicted — aborted. Manual merge needed.", "warning");
        pi.sendMessage({
          customType: "auto-pull",
          content: "⚠️ git pull origin dev 有冲突，已自动 abort。请手动合并 dev 再继续。",
          display: true,
        });
      } else {
        ctx.ui.notify(`git pull failed: ${output.slice(0, 200)}`, "warning");
      }

      // Restore stashed changes even on failure
      if (hasChanges) {
        await pi.exec("git", ["stash", "pop"]);
      }
      return;
    }

    // Restore stashed changes
    if (hasChanges) {
      await pi.exec("git", ["stash", "pop"]);
    }

    if (stdout.includes("Already up to date") || stdout.trim() === "") {
      return;
    }

    ctx.ui.notify(`merged dev: ${stdout.trim()}`, "info");
  });
}
