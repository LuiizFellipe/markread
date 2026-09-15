# MarkRead

A clean, fast Markdown reader for **Linux**, **macOS** and **Windows**, built with [Tauri v2](https://v2.tauri.app).

![CI](https://github.com/YOUR_USERNAME/markread/actions/workflows/build.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MarkRead registers itself as a viewer for `.md` / `.markdown` / `.mdown` / `.mkd`
files on install — double-click any Markdown file in your file manager and it
opens straight in MarkRead.

## Features

- **GitHub-style rendering** — tables, task lists, strikethrough, anchors, typographic punctuation
- **Syntax highlighting** for code blocks (highlight.js)
- **Outline sidebar** with scroll-spy navigation
- **Find in page** (`Ctrl/Cmd + F`) with match highlighting
- **Light / dark / follow-system theme**
- **Zoom** (`Ctrl/Cmd + +/-/0`), persisted
- **Drag & drop** a file onto the window to open it
- **Recent files** in the native menu and welcome screen
- **Links**: external links open in your browser, links to other `.md` files open in-app
- **Local images** with relative paths resolve against the document's folder
- **UI in English, Português (Brasil) or Español** — auto-detected, switchable from the *View → Language* menu
- Sanitized rendering (DOMPurify) — embedded scripts never run
- Single instance: opening another file focuses the existing window

## Install

Grab the installer for your platform from
[Releases](../../releases):

| Platform    | File                        | Registers file associations? |
| ----------- | --------------------------- | ---------------------------- |
| Linux       | `.deb`                      | ✅ Yes (recommended)          |
| Linux       | `.AppImage`                 | ❌ No (AppImage limitation)   |
| macOS       | `.dmg`                      | ✅ Yes                        |
| Windows     | `.exe` (NSIS)               | ✅ Yes                        |

After installing, use your file manager's **Open With → MarkRead** to make it
the default viewer for Markdown files.

## Development

### Prerequisites

- [Node.js](https://nodejs.org) 20+
- [Rust](https://rustup.rs) (stable)
- Linux only — system packages:

  ```bash
  # Debian / Ubuntu / Pop!_OS
  sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev

  # Fedora
  sudo dnf install webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel dbus-devel
  ```

### Run

```bash
npm install
npm run tauri:dev
```

### Build installers

```bash
npm run tauri:build
```

Outputs per platform (in `src-tauri/target/release/bundle/`):

- Linux: `deb/`, `appimage/`, `rpm/`
- macOS: `dmg/`
- Windows: `nsis/`, `msi/`

Cross-compiling is not supported — build on each OS, or push a tag and let
[GitHub Actions](.github/workflows/build.yml) build all three platforms.

### Test document

`sample.md` at the repository root exercises every renderer feature; open it
with the app to eyeball regressions.

## File associations — how it works

- **Windows**: the NSIS installer writes registry entries mapping the
  extensions to MarkRead (`Open With` list gets a MarkRead entry).
- **macOS**: `CFBundleDocumentTypes` in the app bundle's `Info.plist` makes
  `.md` files openable with MarkRead.
- **Linux**: the `.deb` ships a desktop entry with `MimeType=text/markdown;...`,
  so `Open With` and default-application pickers list it.
- When a file is opened, its path reaches the app via CLI argv
  (Windows/Linux), the macOS `open-file` event, or the single-instance plugin
  (app already running) — and the UI renders it.

## License

[MIT](LICENSE)
