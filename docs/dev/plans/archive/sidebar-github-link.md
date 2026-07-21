# Sidebar GitHub Link Plan

## Context

The user wants to add a GitHub repository link button at the bottom of the sidebar, near the connection status area. The current bottom status bar has a left section showing connection status (SignalBarsSprite + "LINK"/"LOST" text) and a right section with two toggle buttons (tmux-cheatsheet and settings). The new GitHub link button should open the repository URL `https://github.com/GDWhisper/OmniTerm` in a new tab with `target="_blank" rel="noopener noreferrer"`.

## Approach

### Step 1: Add GitHub repository URL constant

In `frontend/src/version.ts`, add after the existing `APP_VERSION` export (around line 6):

```ts
/** GitHub repository URL — used for external link button in sidebar */
export const GITHUB_REPO_URL = 'https://github.com/GDWhisper/OmniTerm'
```

This follows the pattern of other project-level constants in `version.ts` and avoids hardcoding URLs in components.

### Step 2: Create GitHubIcon component

Create `frontend/src/components/Icons/GitHubIcon.tsx` with the following content, following the pattern of `GitBranchIcon.tsx`:

```tsx
interface GitHubIconProps {
  size?: number
  color?: string
  className?: string
}

/** GitHub logo icon — filled style (black silhouette) */
export function GitHubIcon({ size = 16, color = 'currentColor', className }: GitHubIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={color}
      className={className}
      style={{ flexShrink: 0 }}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}
```

### Step 3: Add translation keys for GitHub repository button

Add the following translation keys to both `frontend/src/locales/en/translation.json` and `frontend/src/locales/zh/translation.json`:

In `en/translation.json`, add after line 36 (after `"sidebar.lost": "LOST",`):
```json
"sidebar.githubRepo": "GitHub Repository",
```

In `zh/translation.json`, add after the corresponding `sidebar.lost` key:
```json
"sidebar.githubRepo": "GitHub 仓库",
```

### Step 4: Add GitHub link button to sidebar bottom status bar

In `frontend/src/components/Sidebar/Sidebar.tsx`:

1. Import `GitHubIcon` at the top with other icon imports (around line 7-8):
```tsx
import { BookIcon } from '../Icons/BookIcon'
import { IconFolder, IconFolderPlus, IconArrowUp, IconRefresh, IconWarning, IconWorkbench } from '../FileManager/icons'
// Add:
import { GitHubIcon } from '../Icons/GitHubIcon'
```

2. Import `GITHUB_REPO_URL` from version (around line 11):
```tsx
import { APP_VERSION } from '../../version'
// Change to:
import { APP_VERSION, GITHUB_REPO_URL } from '../../version'
```

3. In the bottom status bar section (around lines 1348-1363), add the GitHub link button after the settings button:

Replace the current right section:
```tsx
        <div className="flex items-center gap-2">
          <SidebarBottomButton
            toggle="tmux-cheatsheet"
            icon={<BookIcon width={16} height={16} />}
            title={t('tmuxCheatsheet.title')}
            onClick={toggleTmuxCheatsheet}
            size={26}
          />
          <SidebarBottomButton
            toggle="settings"
            icon="⚙"
            title={t('settings.title')}
            onClick={toggleSettings}
            size={26}
          />
        </div>
```

With:
```tsx
        <div className="flex items-center gap-2">
          <SidebarBottomButton
            toggle="tmux-cheatsheet"
            icon={<BookIcon width={16} height={16} />}
            title={t('tmuxCheatsheet.title')}
            onClick={toggleTmuxCheatsheet}
            size={26}
          />
          <SidebarBottomButton
            toggle="settings"
            icon="⚙"
            title={t('settings.title')}
            onClick={toggleSettings}
            size={26}
          />
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center rounded transition-all"
            style={{
              width: 26,
              height: 26,
              border: '1px solid var(--border-strong)',
              color: 'var(--text-faint)',
              fontSize: 14,
            }}
            title={t('sidebar.githubRepo')}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)'
              e.currentTarget.style.color = 'var(--accent)'
              e.currentTarget.style.background = 'var(--accent-10)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-strong)'
              e.currentTarget.style.color = 'var(--text-faint)'
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <GitHubIcon width={16} height={16} />
          </a>
        </div>
```

### Step 5: Update CHANGELOG.md

Add a new entry to `CHANGELOG.md` under the "Unreleased" section (or create one if it doesn't exist):

```markdown
## [Unreleased]

### Added
- Sidebar bottom status bar now includes a GitHub repository link button that opens `https://github.com/GDWhisper/OmniTerm` in a new tab.
```

### Step 6: Commit changes

Commit all changes with the appropriate commit message following AGENTS.md conventions:

```bash
git add frontend/src/version.ts frontend/src/components/Icons/GitHubIcon.tsx frontend/src/locales/en/translation.json frontend/src/locales/zh/translation.json frontend/src/components/Sidebar/Sidebar.tsx CHANGELOG.md
git commit -m "feat: add GitHub repository link button to sidebar bottom status bar"
```

## Critical files & anchors

1. `frontend/src/version.ts` - Add `GITHUB_REPO_URL` constant (line 6)
2. `frontend/src/components/Icons/GitHubIcon.tsx` - New file - GitHub logo SVG icon component (follow `GitBranchIcon.tsx` pattern)
3. `frontend/src/components/Sidebar/Sidebar.tsx` - Lines 7-11 (imports), Lines 1348-1363 (bottom status bar right section) - Add GitHubIcon import, GITHUB_REPO_URL import, and GitHub link button
4. `frontend/src/locales/en/translation.json` - Line 36 area - Add `sidebar.githubRepo` translation key
5. `frontend/src/locales/zh/translation.json` - Corresponding area - Add `sidebar.githubRepo` translation key
6. `CHANGELOG.md` - Unreleased section - Add new feature entry

## Verification

1. Build the frontend: `cd frontend && npm run build` - Should complete without errors
2. Start the dev server: `./dev.sh start` 
3. In the browser, open the sidebar and verify:
   - The bottom status bar shows the connection status on the left ("LINK" or "LOST")
   - The right section shows three buttons: tmux-cheatsheet book icon, settings gear icon, and GitHub logo icon
   - Hovering over the GitHub button changes its border color to `var(--accent)`, text color to `var(--accent)`, and background to `var(--accent-10)`
   - Clicking the GitHub button opens `https://github.com/GDWhisper/OmniTerm` in a new tab

## Assumptions & contingencies

- The GitHub repository URL is `https://github.com/GDWhisper/OmniTerm` based on the README.md and install.sh files found in the codebase.
- The GitHub icon styling follows the same hover behavior as `SidebarBottomButton` but uses an `<a>` tag instead of a `<button>` to support `target="_blank"`.
- If the translation key `sidebar.githubRepo` is not present in the i18n files, the UI will fall back to showing no title or using the key itself; the plan includes adding the translation keys to both en and zh translation files.
- The constant `GITHUB_REPO_URL` is defined in `version.ts` following the pattern of `APP_VERSION`, avoiding hardcoding URLs in components while keeping it accessible across the frontend.
