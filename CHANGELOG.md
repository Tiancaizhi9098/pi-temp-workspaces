# Changelog

## 1.1.0 - 2026-11-11

- Automatically create `Pi-Work` and activate a separate session workspace when Pi starts in the user home or a filesystem root, including launches without a PowerShell profile.
- Keep normal project directories unchanged. The PowerShell startup helper is optional and only changes the native startup directory shown by Pi.
- Verify actual Pi startup, new-session and resume behavior from the home, filesystem root, scratch root and project directories.
