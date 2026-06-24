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

    // Fetch and merge latest dev into current branch
    const { stdout, code } = await pi.exec("git", ["pull", "origin", "dev"], {
      timeout: 15000,
    });

    if (code !== 0) {
      // Conflict: abort merge to leave repo in clean state
      if (stdout.includes("CONFLICT") || stdout.includes("Automatic merge failed")) {
        await pi.exec("git", ["merge", "--abort"]);
        ctx.ui.notify("merge dev conflicted — aborted. Manual merge needed.", "warning");
        pi.sendMessage({
          customType: "auto-pull",
          content: "⚠️ git pull origin dev 有冲突，已自动 abort。请手动合并 dev 再继续。",
          display: true,
        });
      } else {
        ctx.ui.notify(`git pull origin dev failed: ${stdout.trim()}`, "warning");
      }
      return;
    }

    if (stdout.includes("Already up to date") || stdout.trim() === "") {
      return;
    }

    ctx.ui.notify(`merged dev: ${stdout.trim()}`, "info");
  });
}
