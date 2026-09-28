# Gomoku Desktop Assistant

A screen-recognition Gomoku (Five-in-a-Row) helper overlay. It captures the board from your screen,
asks a local engine for evaluation, and draws **a recommended-move blue circle, a four-tier heatmap,
and an opponent-prediction ring** on top of the game. Just double-click to run — no manual setup needed.

---

## 1. Requirements

- **OS**: Windows 10 / 11 (64-bit).
- **WebView2 Runtime**: Ships with Windows 11 and most Windows 10 (via Edge). If missing, install
  "Microsoft Edge WebView2 Runtime" once (free from Microsoft).
- **Engine & recognizer**: Nothing extra to install. `Desktop GomokuOverlay.exe` auto-starts the shared engine
  (`Web GomokuEngine.exe` on `:8964`) and the screen-scan service on `:8971`. If those ports are already
  in use, the program **reuses** the running processes instead of launching duplicates.

## 2. Folder layout

This `Desktop version/` folder contains:

```
Desktop version/
├── Desktop GomokuOverlay.exe      # main executable
├── overlay/               # panel UI (HTML + CSS + JS), rendered by WebView2
│   ├── panel.html
│   ├── panel-ui.js
│   └── bridge.js
├── README_zh.md           # Chinese guide
├── README_en.md           # this file
└── logs/                  # runtime logs (auto-rotating, see section 4)
    ├── overlay-YYYYMMDD-HHMMSS.log
    └── crash.log
```

## 3. How to use

1. **Double-click `Desktop GomokuOverlay.exe`**.
2. Two things appear:
   - a **black CMD window** showing the runtime log (English, see below);
   - a **semi-transparent floating control panel** in the bottom-right corner.
3. Put the board (e.g. the Zhisong Gomoku page) on screen. The program detects the board, draws the
   corner marks and board frame, and suggests moves as you play.

### Panel features

| Element | Meaning |
| --- | --- |
| Corner L-brackets + blue-violet board frame | marks the detected board |
| **Blue circle** | recommended move (from your perspective) |
| **Heatmap** | four tiers: cyan → green → pink → light-pink; each cell shows an eval number (your perspective, positive = you are ahead). Can be **turned off** and its **opacity** adjusted |
| **Opponent ring** | predicts the opponent's reply. Turn off "opponent evaluation" in the panel if you only want your own suggestions |
| Glass / transparency | blur removed — pure opacity only (see-through like glass, no blur); light mode uses pure-black text |

### Key behaviors

- **Evaluate once, then freeze**: when the board does not change, it stops re-computing (matches real thinking time).
- **Empty-board detection**: if no stone is detected for two consecutive frames, the board is treated as cleared and a
  **new game** starts automatically; the new game **reuses the previous board geometry** to avoid first-move jitter.
- **Close = quit**: clicking the **×** in the panel exits the whole program (including the engine and recognizer).

## 4. Runtime logs

Logs live in the `logs/` folder:

- a new file `overlay-YYYYMMDD-HHMMSS.log` is created **every 15 minutes**;
- at most **500** log files are kept — the oldest is deleted automatically when the limit is exceeded;
- crash info goes to `logs/crash.log`;
- to send everything to one fixed file (e.g. for automated testing), set the env var
  `set GB_LOG_FILE=absolute\path\single.log` (the program prefers this over rotation).

The log window title is `Gomoku Desktop Assistant - runtime log`, and every log line is in English for easy troubleshooting.

## 5. Troubleshooting

- **Panel stays black / times out**: usually means the WebView2 Runtime is missing or a security product blocks its
  child process. Install WebView2 Runtime first; otherwise check the latest `logs/` file and `crash.log`.
- **Board not detected**: make sure the board is on-screen and not covered by another window; restart if needed.
- **To fully quit**: close the black CMD window, or click the panel's ×.

---

> This program is for display assistance only — you still make the actual moves.
