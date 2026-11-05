# Desktop app

The desktop app is a window for your own It's a Plan instance. It runs on macOS, Windows and
Linux and has its own dock or taskbar icon. It contains no copy of the web app: the window loads
your instance, so web updates arrive with each server deploy.

## Download

Download the installer from the
[GitHub Releases](https://github.com/jpenner0/itsaplan/releases) of `jpenner0/itsaplan`.

The files are named `itsaplan-<version>-<os>-<arch>.<ext>`.

| OS      | File                                                                 |
| ------- | -------------------------------------------------------------------- |
| macOS   | `.dmg` for Apple silicon (`arm64`) or for Intel (`x64`)              |
| Windows | `.exe` installer (NSIS, `x64`)                                       |
| Linux   | `.AppImage` or `.deb` (`x64`)                                        |

## Open an unsigned build

The builds are not code-signed, so the system warns you on first launch.

- **macOS:** the app is ad-hoc signed and not notarized. The first launch shows a warning about
  an unidentified developer. Open System Settings, Privacy & Security, and click "Open Anyway",
  or right-click the app and choose Open.
- **Windows:** in the SmartScreen dialog click "More info", then "Run anyway".
- **Linux:** for the AppImage, make the file executable with `chmod +x` and run it. The `.deb`
  installs with your package manager.

## Server URL

On first launch the app asks for the URL of your instance, for example `https://plan.example.com`.

- If you enter no scheme, `https://` is added.
- `http://` is allowed, for instances that run only on an internal network.
- The app checks that the URL is reachable, then stores it on your computer.
- If the server is unreachable, the dialog shows "Could not reach <url>."
- To use another instance, choose "Change server…". It is in the app menu on macOS and in the File
  menu on Windows and Linux. The app shows the dialog again.
- The app connects to one instance at a time.

## Sign-in

| Method             | In the app                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Email and password | Works.                                                                                                                           |
| OIDC               | Works.                                                                                                                           |
| Google             | Works.                                                                                                                           |
| GitHub             | Works if your instance has GitHub sign-in.                                                                                       |
| Passkeys | Security keys work. A passkey works only if exactly one stored credential matches, because the app has no account picker. Platform passkeys (Touch ID) on macOS need a signed app, so they do not work. |
| Magic link         | Does not work. The link opens your default browser, so the session is created there and not in the app. Use another method.     |

## Not included

- Code signing. See "Open an unsigned build".
- Auto-update. Download a new version from the Releases page.
- Notifications, a tray icon and deep links.
- Offline mode.
