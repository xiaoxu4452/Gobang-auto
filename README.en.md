# Meter Gomoku — Website

Static site and usage guide for Meter Gomoku, a Gomoku AI trainer for Windows. It covers the main
window, analysis tools and engine settings, plus a full walkthrough from starting a game to the
three-state pause key. Chinese version: [README.md](README.md).

```
index.html            main page (single file, ZH/EN toggle)
preview/app-*.html    main / analysis / settings interface pages in both languages
preview/app.css       the app's own stylesheet
preview/assets/*.png  board and static bitmaps used by the interface
```

- Site: <https://xiaoxu4452.github.io/Gobang-auto/>
- English build: `?lang=en`

## Web calculator

The site keeps a single link for online analysis: **gomocalc** (<https://www.gomocalc.com/#/>),
maintained by the Rapfi author — mature, phone friendly, opens straight into the board.

The earlier in-house web calculator (`/calc/`, Rapfi compiled to WebAssembly and running locally in the
browser) has been detached from this repository and paused; its source is kept on its own and no longer
ships with the site.

## Local preview

Any static server works, for example `python -m http.server 8000` and then open <http://localhost:8000/>.
Opening the file directly mostly works too, though some browsers block `file://` iframes.

## Updating the interface pages

The export scripts are not part of this repository (they need the app's debug port). Start
`Desktop GomokuTrainer.exe` with `GB_WV2_ARGS_EXTRA=--remote-debugging-port=9222`, drive the UI into the
target state, export `document.body`, and convert visible canvases to PNG injected back as
`background-image`.
