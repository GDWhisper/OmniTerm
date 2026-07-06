# psmux Spike Results

> **Status**: Pending — requires validation on a real Windows environment.

This document records the results of the psmux compatibility spike described in the Windows support proposal. Each scenario must be validated before the implementation is considered safe.

## Scenario A: Multi-session

**Goal**: Verify psmux supports multiple sessions in a single server.

```powershell
tmux new-session -d -s s1
tmux new-session -d -s s2
tmux list-sessions -F "#{session_name}"
```

**Expected**: Lists both `s1` and `s2`.

**Result**: _Pending_

## Scenario B: @user_option Format Expansion

**Goal**: Verify `@omniterm_agent` custom option round-trips through format strings.

```powershell
tmux set-option -t s1 @omniterm_agent "claude:idle"
tmux list-sessions -F "#{session_name}|#{@omniterm_agent}"
```

**Expected**: Second column is `claude:idle`.

**Result**: _Pending_

## Scenario C: pane_pid Semantics on ConPTY

**Goal**: Understand what `pane_pid` points to under ConPTY.

```powershell
tmux list-panes -t s1 -F "#{pane_pid}"
Get-Process <pid>
Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>"
```

**Expected**: Identifies whether PID is `conhost.exe`, `OpenConsole.exe`, or `pwsh.exe`, and how many levels of nesting to reach the agent CLI.

**Result**: _Pending_

## Scenario D: Control Mode

**Goal**: Verify `-C` control mode protocol compatibility.

```powershell
tmux -C attach-session -t s1
# Send: list-sessions\n
# Expect: %begin / %end response frames
```

**Result**: _Pending_

## Scenario E: pane_current_path

**Goal**: Verify CWD tracking via OSC 7.

```powershell
# In session: cd C:\Users
tmux display-message -t s1 -p '#{pane_current_path}'
```

**Expected**: Returns `C:\Users`.

**Result**: _Pending_

## Conclusion

_All five scenarios must pass for the Windows support implementation to proceed. Any failure reverts to WSL2-only approach._
