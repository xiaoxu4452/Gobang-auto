# Gobang-auto · Meter Gomoku — Gomoku AI Trainer, Assistant & Link Tool

**Meter Gomoku (米特五子棋)** is a Windows desktop **Gomoku AI** suite built around the native **RapFi** engine — the strongest open-source **Gomoku (五子棋 / Five-in-a-Row / Renju)** engine available. It combines an **AI trainer** (analysis, evaluation, VCF/VCT mate search, forbidden-move checks), a **live-play assistant** (screen recognition + auto-move for playing inside other apps) and a **board-recognition link tool** (Gomoku Vision + engine analysis for online Gomoku platforms). Everything runs locally with zero HTTP.

> **Ready-to-run packages** — the `Meter *` directories below are **pre-built, compiled release packages** (executable + encrypted UI resources + native RapFi engine + vision service). You can run them directly without building anything. The `desktop-*` / `bookmark-assistant` directories are the source code used to build them.

| Directory | What it is |
| --- | --- |
| `Meter Gomoku` | **Ready-to-run** Link edition — desktop overlay with board recognition, RapFi engine analysis, balance-point suggestions, optional auto-move and a review panel |
| `Meter GomokuTrainer` | **Ready-to-run** standalone **Gomoku AI trainer** — analysis, position setup, evaluation (incl. VCF / VCT mate search, forbidden-move checks), replay and study tools |
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

- **Native RapFi engine** — the strong official open-source Gomoku / Renju engine is linked in-process (pure C++ hard link, zero HTTP round-trips), keeping latency low and strength high.
- **Single RapFi variant + multi-thread collaborative search** — one engine variant searches a single game tree with the full thread count over one shared large partitioned transposition table; the effective hash size is your chosen step x2 (with a 128 MB-per-core floor, capped at 80% of RAM and a 6 GB hard cap), and the thread count strictly follows your selection.
- **Single-shot exclusive analysis** — every analysis/auto-move request uses a dedicated single-lane channel (`Analyze` with exclusive semantics), so evaluation and moves do not queue up behind each other.
- **Balance points / swap assessment** — empty-board swap (two black / one white) and mid-game swap (one black / one white) suggestions are computed from the official RapFi opening book, tuned so neither side gains a visible advantage; Renju (forbidden moves), Freestyle and Overline-loses each use their own dedicated openings and evaluation lines.
- **Screen recognition (Gomoku Vision)** — turn a screenshot of any Gomoku game into a study position; used by both the trainer and the Link assistant.
- **Recognition overlay** — four purple L-shaped corner frames connected by sky-blue guides, five crosshair anchor points, immunity against capturing the overlay windows themselves, and low/high-DPI fixed-ratio scaling.
- **Board recognition algorithm (native, zero-HTTP)** — the whole pipeline runs in the C++ host and vision service, no network involved:
  1. **Capture** — the target region is grabbed directly (shared memory / named pipe, no PNG round-trip), then binarized and colour-segmented for black/white stones and the board frame.
  2. **Board localization** — the four L-shaped corner anchors are matched first; the board rectangle is then confirmed by the frame plus the stone layout (so a nearly-full board is still found reliably). The region is expanded and locked, and the five crosshair anchor points are registered for the coordinate grid.
  3. **Anti-jitter stabilizer** — once a fixed region is locked, the detector converges and only re-searches when the board visibly moves/resizes; transient drift is suppressed so coordinates and edge numbers are never mistaken for stones.
  4. **Stone classification** — cell-by-cell black/white detection with coordinate-label immunity; results are smoothed across frames to remove flicker.
  5. **Overlay immunity** — the recognition process never captures the suite's own windows or the hollow selection window (physical click-through is used), so no garbage stones appear from the UI itself.
  6. **Auto/manual modes** — auto mode scans the whole desktop and locks onto a board; manual mode lets the user draw a rectangle once, after which only stone finding / evaluating runs (no re-searching), keeping the pipeline fast and stable.
- **Link mode (auto-move)** — three-stage click pipeline (PostMessage → SendInput → real mouse) with next-frame verification and whole-round retry; Real Click mode for programs that only accept a genuine mouse (e.g. self-drawn / anti-cheat windows).
- **WebView2 UI** — light/dark theme, Chinese/English switching, and a built-in micro-browser (search / navigation / downloads via the system save dialog).
- **Hardened packaging** — Inno Setup installers with Defender-friendly signing options and variant checks; installable on older Windows machines.

## Open-source components and links

This project is built on the following open-source projects (all licence texts are shipped with the release packages):

| Component | Purpose | Licence | Official link |
| --- | --- | --- | --- |
| **RapFi** (by dhbloo) | The Gomoku / Renju search engine — the most important dependency of this project. A strong neural-network-based engine; the balance-opening book used by Balance Points / Swap Assessment is derived from its official SWAP2 table. | GPL-3.0 | **https://github.com/dhbloo/rapfi** |
| OpenCV | Board and stone recognition, statically linked into `GomokuVision.exe` | Apache-2.0 | https://opencv.org |
| Microsoft Edge WebView2 Runtime | Desktop UI runtime (provided by Windows / Edge, not redistributed) | Proprietary (Microsoft) | https://developer.microsoft.com/microsoft-edge/webview2/ |
| Source Han Serif / Sans (Noto Serif SC / Noto Sans SC) | Typesetting fonts for the manuals, embedded in the PDF | SIL OFL 1.1 | https://github.com/adobe-fonts/source-han-serif · https://github.com/adobe-fonts/source-han-sans |
| Inno Setup | Builds the Windows installer (packaging only) | Inno Setup License | https://jrsoftware.org/isinfo.php |

Related resources: [gomocalc.com](https://www.gomocalc.com/#/) (online Gomoku calculator / position-code format used by the Position panel).

## System requirements

- Windows 10 / 11 (x64), including older builds and low-resolution screens.
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (Evergreen).
- No internet connection required after install — everything runs locally.

## Download

- Latest installers: see the **Releases** page of this repository.
- Suite & standalone packages: https://wwbbj.lanzout.com/b016l4d3id (password: `55555`).

## Building from source (summary)

1. Install Visual Studio (C++ toolchain), Windows SDK, and the WebView2 SDK.
2. Obtain the native RapFi build (`rapfi-native`) and place it under the publish directories as expected by the runtime.
3. Build each desktop project (host + WebView2 UI) with its build script, then produce the `.enc` UI resources for the release packages.

Note: UI-file decryption keys and a few internal headers are intentionally not published; keys are injected at build time.

## License

This repository contains a mix of original code and third-party components. The Gomoku search engine is based on **RapFi** (GPL-3.0, https://github.com/dhbloo/rapfi); please review the engine's license terms before redistribution. The remainder of the project is published for reference and personal use.
