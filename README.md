# Meter Gomoku — 官网 / 文档站

Meter Gomoku（五子棋 AI 训练器）的静态官网与使用说明，包含主界面、计算分析、引擎设置等界面，
以及从开局到暂停键的完整操作指南。英文说明见 [README.en.md](README.en.md)。

```
index.html            主站（单文件，中英切换）
preview/app-*.html    主界面 / 分析 / 设置的中英文界面页
preview/app.css       软件本体样式
preview/assets/*.png  界面用的棋盘与静态位图
```

- 访问：<https://xiaoxu4452.github.io/Gobang-auto/>
- 英文直达：`?lang=en`

## 网页版计算器

站点只保留一个在线计算器的链接：**gomocalc**（Rapfi 作者维护，<https://www.gomocalc.com/#/>），
功能成熟、手机可用，打开就能摆盘与分析。

早先自己做的网页计算器（`/calc/`，Rapfi 编译成 WebAssembly 在浏览器本地计算）已从本仓库剥离并暂停，
源码单独存放，不再随站点发布。

## 本地预览

任意静态服务器，例如 `python -m http.server 8000` 后打开 <http://localhost:8000/>。直接双击也能看，
但部分浏览器会限制 iframe 对 `file://` 的访问。

## 更新界面页

界面页的更新脚本不在本仓库里（依赖软件的调试端口）。流程：以 `GB_WV2_ARGS_EXTRA=--remote-debugging-port=9222`
启动 `Desktop GomokuTrainer.exe`，把界面切到目标状态后导出 `document.body`，并把可见 `canvas`
转成 PNG、以 `background-image` 回填。
