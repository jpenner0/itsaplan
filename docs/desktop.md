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
  an unidentified developer. Open System Settings, Privacy & Security, and click "Open Anyway".
- **Windows:** in the SmartScreen dialog click "More info", then "Run anyway".
- **Linux:** for the AppImage, make the file executable with `chmod +x` and run it. The `.deb`
  installs with your package manager.

## Server URL

On first launch the app asks for the URL of your instance, for example `https://plan.example.com`.

- If you enter no scheme, `https://` is added.
- `http://` is allowed, for instances that run only on an internal network.
- The app checks that the URL is reachable, then stores it on your computer.
- Only the origin is stored. A path such as `https://host/plan` is dropped, so the instance must
  be served at the root of its host.
- The dialog shows an error when the input is not accepted: "Enter a valid URL.", "Only http and
  https URLs are supported.", "Could not reach <url>." followed by the reason, or "Could not save
  the server URL." followed by the reason.
- To use another instance, choose "Change server…". It is in the app menu on macOS and in the File
  menu on Windows and Linux. The app shows the dialog again.
- The app connects to one instance at a time.

## Sign-in

| Method             | In the app                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Email and password | Works.                                                                                                                           |
| OIDC               | Works.                                                                                                                           |
| Google             | Works.                                                                                                                           |
| GitHub             | Works if your instance has GitHub sign-in. The sign-in is a redirect in the app window, like Google.                             |
| Passkeys | Security keys work. A passkey works only if exactly one stored credential matches, because the app has no account picker. Platform passkeys (Touch ID) on macOS need a signed app, so they do not work. |
| Magic link         | Does not work. The link opens your default browser, so the session is created there and not in the app. Use another method.     |

## Features

The window loads your instance, so a web feature works in the app unless it needs a behaviour the
shell restricts. The shell keeps `http(s)` navigation in the window, sends `window.open` and
`target="_blank"` to the system browser, and gives the page no preload and no Node access. The
results below come from reading the code. None was run against a real GitHub, Microsoft or Trello
account.

| Feature                                        | Result in the app                                                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in with GitHub                            | Works. A redirect to GitHub and back in the same window sets the session cookie.                                                                   |
| Link a GitHub account (profile)                | Works. `linkSocial` redirects, so the flow stays in the window.                                                                                    |
| GitHub issue sync, agent triggers, PR tools    | Works. Settings forms, a webhook and server-side calls. No popup and no redirect.                                                                   |
| Microsoft 365 mailbox (email intake)           | Works. The mailbox form takes an app registration, and the api fetches the token. There is no browser sign-in.                                      |
| Microsoft Teams notifications and bot          | Works. A pasted webhook URL, no sign-in flow.                                                                                                      |
| Markdown folder import                         | Works. The folder and ZIP pickers are file inputs and open the system dialog. A drop on the zone reads the files. A drop elsewhere does not navigate, because `file:` navigation is blocked. |
| HTML and Markdown export, other downloads      | Works. A download from a blob link opens the system save dialog.                                                                                   |
| Mermaid                                        | Works. It renders in the page.                                                                                                                     |
| Copy to clipboard                              | Works.                                                                                                                                             |
| Paste from clipboard (labels, states, fields, issue types, roles) | Works. The app grants clipboard read to the instance page only, not to a site the window navigated to.                          |
| Import from Trello                             | Works. The Trello authorize page opens in an app popup, because it answers the opener with `postMessage`. Other popups open the system browser.  |
| Connect Telegram                               | Works. The bot page opens in the system browser. Return to the app, which waits for the link.                                                      |

A link with `target="_blank"` or a modifier click opens the system browser.

## Not included

- Code signing. See "Open an unsigned build".
- Auto-update. Download a new version from the Releases page.
- Native notifications, a tray icon and deep links. The page may not request notification permission.
- Offline mode.
