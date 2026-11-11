# Changelog

## 1.3.0 - 2026-11-12

- Personal GitHub installs on Windows now configure the PowerShell 7 launcher. A plain `pi` starts in `Pi-Work` from the home, drive root or Windows system directory. Reload the PowerShell profile once in an already-open shell.
- Forward package management commands in the caller’s directory. Restore the shell location and forward arguments, pipeline input and exit status.

## 1.2.0 - 2026-11-11

- Prepare the `Pi-Work` parent directory during installation and on every plugin load, including ordinary project sessions. This no longer depends on an existing shell wrapper or workspace state.
- Change the actual Pi process working directory to its active session workspace, and restore it before releasing the workspace. Verify the real process directory across new and resumed sessions.
- Recognize Windows system-directory launches such as elevated terminals starting in `System32`.
- Set the temporary terminal title to `Pi-Work` without adding a status row. The native footer still describes the original startup directory; `/temp-work` reports the effective process directory explicitly.

## 1.1.0 - 2026-11-11

- Automatically create `Pi-Work` and activate a separate session workspace when Pi starts in the user home or a filesystem root, including launches without a PowerShell profile.
- Keep normal project directories unchanged. The PowerShell startup helper is optional and only changes the native startup directory shown by Pi.
- Verify actual Pi startup, new-session and resume behavior from the home, filesystem root, scratch root and project directories.
