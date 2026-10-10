# Gobang-auto · Meter Gomoku

**Meter Gomoku** is a Windows desktop Gomoku (Five-in-a-Row) suite built around the native **RapFi** engine. It ships as four publish directories:

| Directory | What it is |
| --- | --- |
| `Meter Gomoku` | Link edition — desktop overlay with board recognition, engine analysis, balance-point suggestions and optional auto-move, plus a built-in micro-browser and a review panel |
| `Meter GomokuTrainer` | Standalone trainer — analysis, position setup, evaluation (incl. VCF / VCT / forbidden-move checks), replay and study tools |
| `Meter GomokuAssistant` | Assistant overlay — real-time board capture, evaluation overlay, balance-point / swap assessment and auto-move for playing against online boards |
| `Meter engine-server` | Shared engine server — native RapFi build plus the scan / vision service used by the suite |

## Highlights

- **Native RapFi engine** — the strong, official open-source Gomoku engine is linked in-process; no HTTP round-trips for engine calls (pure hard links), which keeps latency low and strength high.
- **Zero-HTTP core** — board scanning, recognition and engine communication run through the C++ host (screen capture → vision → native engine) instead of network services.
- **Single-shot exclusive analysis** — every analysis/auto-move request uses a dedicated single-lane channel (`Analyze` with exclusive semantics), so evaluation and moves do not queue up behind each other.
- **Balance points** — empty-board swap (two black / one white) and mid-game swap (one black / one white) suggestions are computed from the official RapFi opening book, tuned so neither side gains a visible advantage.
- **Recognition overlay** — four purple L-shaped corner frames connected by sky-blue guides, five crosshair anchor points, immunity against capturing the overlay windows themselves, and low/high-DPI fixed-ratio scaling.
- **WebView2 UI** — light/dark theme, Chinese/English switching, and a built-in micro-browser (search / navigation / downloads via the system save dialog).
- **Hardened packaging** — Inno Setup installers with Defender-friendly signing options and variant checks; installable on older Windows machines.

## System requirements

- Windows 10 / 11 (x64), including older builds and low-resolution screens.
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (Evergreen).
- No internet connection required after install — everything runs locally.

## Download

Suite & standalone installers (password: `55555`):

https://wwbbj.lanzout.com/b016l4d3id

The standalone trainer build has its own separate download address.

## Repository layout

- `Meter Gomoku/`, `Meter GomokuTrainer/`, `Meter GomokuAssistant/`, `Meter engine-server/` — ready-to-run publish directories (executables, encrypted UI resources, engine binaries).
- `desktop-connect/` — desktop core source: WebView2 UI (`ui/`) and the Win32 host (`src/`), published with comments stripped and concise English file headers.
- `installer/` — Inno Setup scripts (`*.iss`) and build output.
- `tools/` — build / release / packaging helper scripts.
- `desktop-calculator/`, `desktop-vision/` — related desktop projects (calculator overlay and vision/recognition service).

## Building from source (summary)

1. Install Visual Studio (C++ toolchain), Windows SDK, and the WebView2 SDK.
2. Obtain the native RapFi build (`rapfi-native`) and place it under the publish directories as expected by the runtime.
3. Build `desktop-connect` (host + WebView2 UI), then run the release packaging script in `tools/` to produce the `.enc` UI resources and the Inno Setup installers.

Note: UI-file decryption keys and a few internal headers are intentionally not published; keys are injected at build time.

## License

This repository contains a mix of original code and third-party components. The Gomoku search engine is based on **RapFi** (GPL-3.0); please review the engine's license terms before redistribution. The remainder of the project is published for reference and personal use.
