# Gobang-auto · Meter Gomoku

**Meter Gomoku** is a Windows desktop Gomoku (Five-in-a-Row) suite built around the native **RapFi** engine. It ships as four publish directories:

> **Ready-to-run packages** — the `Meter *` directories below are **pre-built, compiled release packages** (installer-layout folders: executable + encrypted UI resources + native RapFi engine + vision service). You can run them directly without building anything. The `desktop-*` / `bookmark-assistant` / `iconic` directories are the source code used to build them.

| Directory | What it is |
| --- | --- |
| `Meter Gomoku` | **Ready-to-run** Link edition — desktop overlay with board recognition, engine analysis, balance-point suggestions and optional auto-move, plus a built-in micro-browser and a review panel |
| `Meter GomokuTrainer` | **Ready-to-run** standalone trainer — analysis, position setup, evaluation (incl. VCF / VCT / forbidden-move checks), replay and study tools |
| `Meter GomokuAssistant` | **Ready-to-run** assistant overlay — real-time board capture, evaluation overlay, balance-point / swap assessment and auto-move for playing against online boards |
| `Meter engine-server` | **Ready-to-run** shared engine server — native RapFi build plus the scan / vision service used by the suite |

## Source layout

| Directory | Source of |
| --- | --- |
| `desktop-connect/` | Link / trainer UI (`ui/`) and Win32 host (`src/`) — WebView2 UI, comment-stripped with short English headers |
| `desktop-calculator/` | Standalone trainer application — `src/` Win32 host + `ui/` WebView2 UI |
| `desktop-vision/` | Vision / recognition service (`src/`) used by the trainer and the assistant |
| `desktop-overlay/` | Assistant overlay application — host (`src/`), overlay UI (`ui/`) and launcher scripts |
| `bookmark-assistant/` | Bookmark-edition floating Gomoku assistant (pure JS) — delegates board recognition to the local C++ vision service (`GomokuVision`) and move search to the native RapFi engine |

## Highlights

- **Native RapFi engine** — the strong, official open-source Gomoku engine is linked in-process; no HTTP round-trips for engine calls in the desktop editions (pure hard links), which keeps latency low and strength high.
- **Zero-HTTP core (desktop editions)** — board scanning, recognition and engine communication run through the C++ host (screen capture → vision → native engine) instead of network services.
- **Single-shot exclusive analysis** — every analysis/auto-move request uses a dedicated single-lane channel (`Analyze` with exclusive semantics), so evaluation and moves do not queue up behind each other.
- **Balance points** — empty-board swap (two black / one white) and mid-game swap (one black / one white) suggestions are computed from the official RapFi opening book, tuned so neither side gains a visible advantage.
- **Recognition overlay** — four purple L-shaped corner frames connected by sky-blue guides, five crosshair anchor points, immunity against capturing the overlay windows themselves, and low/high-DPI fixed-ratio scaling.
- **Board recognition algorithm (native, zero-HTTP)** — the whole pipeline runs in the C++ host and vision service, no network involved:
  1. **Capture** — the target region is grabbed directly (shared memory / named pipe, no PNG round-trip), then binarized and colour-segmented for black/white stones and the board frame.
  2. **Board localization** — the four L-shaped corner anchors are matched first; the board rectangle is then confirmed by the frame plus the stone layout (so a nearly-full board is still found reliably). The region is expanded by 0.6 cell and locked, and the five crosshair anchor points (centre + edge midpoints) are registered for the coordinate grid.
  3. **Anti-jitter stabilizer** — once a fixed region is locked, the detector converges and only re-searches when the board visibly moves/resizes; transient left/right drift is suppressed so corner coordinates and edge numbers are never mistaken for stones.
  4. **Stone classification** — cell-by-cell black/white detection with coordinate-label immunity (row/column numbers, the centre star points etc. are excluded); results are smoothed across frames to remove flicker.
  5. **Overlay immunity** — the recognition process never captures the suite's own windows or the hollow selection window (physical click-through is used for the select-rectangle overlay), so no garbage stones appear from the UI itself.
  6. **Auto/manual modes** — auto mode scans the whole desktop and locks onto a board; manual mode lets the user draw a rectangle once, after which only find-stones / evaluate-stones run (no re-searching), keeping the pipeline fast and stable.
- **WebView2 UI** — light/dark theme, Chinese/English switching, and a built-in micro-browser (search / navigation / downloads via the system save dialog).
- **Hardened packaging** — Inno Setup installers with Defender-friendly signing options and variant checks; installable on older Windows machines.

## System requirements

- Windows 10 / 11 (x64), including older builds and low-resolution screens.
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (Evergreen).
- No internet connection required after install — everything runs locally.

## Download

Suite & standalone installers (password: `55555`):

https://wwbbj.lanzout.com/b016l4d3id

The standalone trainer build has its own separate download address. GitHub Releases also host the latest installers.

## Building from source (summary)

1. Install Visual Studio (C++ toolchain), Windows SDK, and the WebView2 SDK.
2. Obtain the native RapFi build (`rapfi-native`) and place it under the publish directories as expected by the runtime.
3. Build each desktop project (host + WebView2 UI) with its build script, then produce the `.enc` UI resources for the release packages.

Note: UI-file decryption keys and a few internal headers are intentionally not published; keys are injected at build time.

## License

This repository contains a mix of original code and third-party components. The Gomoku search engine is based on **RapFi** (GPL-3.0); please review the engine's license terms before redistribution. The remainder of the project is published for reference and personal use.
