# Meter Gomoku Bookmark Assistant (Bookmark Edition)

A floating Gomoku assistant that runs from a browser bookmark — no user scripts (Tampermonkey / ScriptCat) needed. Drag `bookmarklet.js` to the bookmark bar, open any Gomoku board page, and click it.

## How it works

- Pure JS front end (no build step): detects the board (canvas) on the page, shows a floating panel with analysis and optional auto-move.
- Board recognition is delegated to the **local C++ vision service** (`GomokuVision`, built from `desktop-vision/` sources; prebuilt binaries ship in the release directories under `Vision/`).
- Move search is delegated to the **native RapFi engine** (`rapfi-native`), shipped in the release directories.
- The bookmark edition talks to the local service over HTTP on `127.0.0.1` — this is a browser-sandbox requirement and applies to the bookmark edition only; the desktop editions stay zero-HTTP.

## Usage

1. Install the suite (or build `desktop-vision` + the engine service yourself).
2. Start the local engine/vision service (double-click `Web GomokuEngine.exe` or the assistant's engine server).
3. Drag `bookmarklet.js` onto the browser bookmark bar.
4. Open a board page, click the bookmark, and the floating assistant appears.

## Layout

- `bookmarklet.js` — the assistant (comment-stripped, English file header; UI strings kept as-is).
- See `desktop-vision/` for the C++ vision sources and `README.md` at the repo root for the full suite overview.
