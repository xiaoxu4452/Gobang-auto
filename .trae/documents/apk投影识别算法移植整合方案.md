# APK 投影识别算法移植并整合进 desktop-vision（大预防针）

## 一、Context（为什么做）

用户要求：解析 `C:\Users\harve\Desktop\project\gomoku-analysis-1.0.36-arm64.apk` 里的识别算法，
整合进项目中的训练器（独立版 `Meter GomokuTrainer`）与连线版训练器（`Meter engine-server`）。

经澄清后定案（本轮用户明确）：

- **落地形态**：用 C++ / OpenCV 重写，合并进 `desktop-vision/src`——与现有识别模块**整合到一块**，而不是独立 JS 模块、也不新增 UI 开关。
- **接入语义**：把它当作一个**「大预防针」（大兜底层）**，"并列到一个整体的算法中"。即：它是同一条识别管线里的一个新兜底层，当现有各层给不出可信结果时接管；用户无感，无需任何界面切换。
  - 佐证：项目里「预防针」已有明确定义——`tools/recog_vaccine_selftest.py`（极端场景压力矩阵 A~H）。本方案就是把 APK 算法作为该矩阵所覆盖场景的兜底。
- **移植范围**：**完整移植**（含 grad/frame/ultra 多级兜底、星位重校准 `scanStarRecal`、自动微角度校平 `scanAutoLevel`）。
- **零回归**：现有 `recognize()` 的既有分支（`locateBoard`/`locateGridHough`/`scanOnce` 及所有 crop / partial 兜底）行为不得改变；proj 仅在现有结果不可信时叠加。
- **一处改动覆盖两个训练器**：`GomokuVision.dll` 被两个训练器共用（`tools/build-vision.js --publish` 同时复制到两个 `Vision\` 目录），故只改 DLL 侧即可。

## 二、现状分析（基于实际代码核验）

### 2.1 分层与数据流（已核验）

```
calc.js(UI) --tellHost({type:'visRecognize',mode:'image'})--> host.cpp RunVisionForVis
   -> VisionRecognize()/HTTP POST /recognize -> GomokuVision.exe(壳,无OpenCV)
   -> gbpipe/model 导出 -> GomokuVision.dll GbvRecognizeJson(reqJson)
   -> mode=="wulin" ? recognizeWulin : recognize(image,size,allowSnap)
```

- `desktop-vision/src/gbdll.cpp` L189-217：`GbvRecognizeJson` 解析 `size`/`mode`，`mode=="wulin"` 走 `recognizeWulin`，否则走 `recognize`。L219-222：`GbvVersion()` 返回 `2`。
- `desktop-vision/src/gbrecognize.cpp`：
  - L1111-1124 `recognize()`——带缓存（key = fnv1a(imageB64) ^ size ^ allowSnap），`recognizeUncached` 结果 ok 才入缓存。
  - L1126-1233 `recognizeUncached()`——解码 → `recognizeCore` → L1145 `if (!suspect && !stonesEmpty) return res;` → 否则 crop/`snapBoardRects` 救援 → L1229-1232 `PartialGridStones` / `PartialStonesFallback` → `return res`。
  - L653-1070 `recognizeCore()`——`locateBoard`(L662) → `locateGridHough`(L678) → hp 兜底(L692) → `refineLines` → `readStonesAdaptive`/Legacy 仲裁 → L1040-1069 组装输出。
  - **输出形状（必须对齐）**：`{ ok, size, suspect, partial?, diag{...}, geometry{ x0, y0, stepX, stepY, xs[15], ys[15], source, confidence, bg }, black:[{x,y}], white:[{x,y}] }`；`stonesJson`(L177-188) 产出 `{x,y}`。
- `desktop-vision/src/gbvision.h`：L90 `Json recognize(...)`、L92 `Json recognizeWulin(...)`（新增 `recognizeProj` 声明放这里）。
- `desktop-vision/src/gb.h` L298-350：`Json` API（`makeObj/makeArr/makeBool/makeStr/makeNum/makeInt/set/push/find/findMutable/numOr/boolOr/strOr/dump`）。
- `desktop-calculator/src/host.cpp` L1836-1899 `RunVisionForVis`：L1847 `if (mode != "scan") mode = "image";`；L1866-1869 分派 `VisionScanImage` / `VisionRecognize`。
- `tools/build-vision.js` L109 `SOURCES = readdirSync(SRCDIR).filter(*.cpp).sort()`——**新增 .cpp 自动纳入编译**；L174-178 `dllObjs` = 除 gbhttp/gbpipe/main/gbloader 外全部 → 新增 `gbproj.obj` 自动进 DLL 并链 OpenCV（`CV_LIBS` L123-131 含 `opencv_imgproc500.lib`）。L226-229 `--publish` 复制到两个训练器 `Vision\`。

### 2.2 APK 算法规格（源码已提取并核验）

- 源文件：`c:\Users\harve\Desktop\Gobang auto\.tmp-apk-analysis\assets_index.html`（从 APK `assets/index.html` 提取，5236 行；算法位于 L2184-4255）。
- 常量：`N=15, EMPTY=0, BLACK=1, WHITE=2`；`CONF_LOW=0.55`(L2192)；`SCAN_MAX_EDGE=1000`(L2198)。
- **顶层入口** `scanImageOnce(img,noTrim,thrOv)` L4011-4184，管线顺序：
  1. `scanDownscale(img,1000)`（整数因子 k×k box 均值；记录 `kDsX=wIn/w_ds`、`kDsY=hIn/h_ds` 用于坐标回映射，L4018）
  2. `scanAutoLevel(img)`（L2317）微歪自动拉正
  3. `scanTrimBorder(img)`（L3783）自动裁纯色边带 → `trimX/trimY`
  4. `scanToGray`(L2201, Rec.601 整数 `(R*77+G*150+B*29)>>8`) + `scanWarm`(L3005) 暖色掩码
  5. 对比度门：直方图 p5/p50/p95，`p95-p5<18` → 拒（L4039）
  6. 双假设投影（`dark`/`bright`）：`scanProject`(L2428, `thr=max(16,contrast*0.18)`) → `scanFindGrid2`(L2259) 找 fx/fy；缺一维用 `scanGridByFrame`(L2944) 兜底；双模式取 score 最优（L4043-4055）
  7. 框边台阶滑窗（L4065-4095，`scanOuterDarkRun` L3968）
  8. 守门：`|Px-Py|/max>0.12` 或 `rms>0.11P` → 分流拒识文案（L4104-4106）；`dimOk = frame || (inliers>=12 && span>=13)`（L4118-4120）
  9. `scanStarRecal`(L3599) 星位重校准 → `useXs/useYs/useP`
  10. `scanClassify`(L3020) → `{grid,conf,avgLineEv,outEdge,...}`；`outEdge>N*15*0.15` 拒（L4129）；`avgLineEv<0.22` 拒（L4136）
  11. 统计 stones/blacks/whites/low（L4138-4143）
  12. 交叉周期校正（L4152-4173）：`dP0>0.06` 时用大周期钉死小方向重枚举 + 重跑 classify，"棋理修正颗数严格更少"才采纳
  13. 黑白比例门：`stones>=10 && max>min*20` → 拒（L4179）
  14. **返回** `{ ok:true, grid[225], conf[225], stats{stones,blacks,whites,low}, xs[15], ys[15] }`，`xs[i]=(line+trimX)*kDsX`（L4181-4183）
- 其余函数：`scanRotate`(L2236,fill 必须传 p50)、`scanFindGrid2`(L2259)、`scanGridScore`(L2296)、`scanGridPre`(L2452, 自相关+显著性+谐波校正+提峰)、`scanFindGrid`(L2613)、`scanFindGridGrad`(L2770)、`scanGridByFrame`(L2944)、`scanImageCore`(L3882)、`scanImage`(L3921)、`scanImageArb`(L3940)、`scanUpscale2x`(L3989)、`enforceBalance`(L4194)、`applyScan`(L4224)。
- `enforceBalance(grid,conf)` L4194-4219：黑白差 d∉{0,1} 时翻最低置信子；`|d|>4` → fail。

### 2.3 现有验证设施（复用，不新建轮子）

- `tools/recog_vaccine_selftest.py`——「预防针」矩阵 A~H（浅盘白子/深盘黑子/光泽子/反识别/空盘假阳/缩放/整屏同色背景/屏江现场回归），走生产 `recognize()`。**这是本次兜底层的验收标尺。**
- `tools/vision-parity.py`——C++ 与 Python 参考实现逐子对拍，复用疫苗矩阵激励集；两侧都走**离线单图入口**（`--recognize-image` / `--scan-image`），不需起服务。
- `tools/recognize_selftest.py`、`tools/test-recognize-adaptive.js`、`tools/wulin_gloss_selftest.py`——常规回归。
- `desktop-vision/src/main.cpp` L244-276 离线入口：`--scan-image 文件` / `--recognize-image 文件`；L268 组装 `{"image":"<b64>","size":15}` 调 `ModelRecognizeJson`（**目前不能传 mode**）。

## 三、方案（唯一推荐）

### 3.1 新增 `desktop-vision/src/gbproj.h` / `gbproj.cpp`

- 命名空间 `gb`；声明（放入 `gbvision.h`，与 `recognize`/`recognizeWulin` 并列）：

```cpp
// 投影识谱兜底（APK 移植）：返回与 recognize() 同构的 Json
Json recognizeProj(const std::string& imageB64, int size, bool allowRetry = true);
```

- 内部数据结构（文件内匿名命名空间）：
  - `struct PImg { std::vector<unsigned char> g; int w=0,h=0; };`（灰度图，等价 JS 的 `{data,width,height}`）
  - `struct PRect { PImg img; int trimX=0, trimY=0; };`
  - `struct PProf { std::vector<double> col,row; };`
  - `struct PGrid { std::vector<double> lines; double period=0,rms=0; int inliers=0; std::vector<char> hit; bool frame=false; };`
  - `struct PCls { std::vector<int> grid, conf; double avgLineEv=0, outEdge=0; };`
- 常量：`kProjN=15`、`kConfLow=0.55`、`kScanMaxEdge=1000`。

**函数映射表（JS 行号 → C++ 函数，一一对应，便于逐条对拍）**

| APK JS | 行号 | C++ (`gb::` 内部) |
|---|---|---|
| `scanToGray` | 2201 | `projToGray` |
| `scanDownscale` | 2210 | `projDownscale` |
| `scanRotate` | 2236 | `projRotate`（`cv::warpAffine`，`BORDER_CONSTANT` 填 `p50`） |
| `scanFindGrid2` | 2259 | `projFindGrid2` |
| `scanGridScore` | 2296 | `projGridScore` |
| `scanAutoLevel` | 2317 | `projAutoLevel` |
| `scanProject` | 2428 | `projProject` |
| `scanGridPre` | 2452 | `projGridPre` |
| `scanFindGrid` | 2613 | `projFindGrid` |
| `scanFindGridGrad` | 2770 | `projFindGridGrad` |
| `scanGridByFrame` | 2944 | `projGridByFrame` |
| `scanWarm` | 3005 | `projWarm` |
| `scanClassify` | 3020 | `projClassify` |
| `scanStarRecal` | 3599 | `projStarRecal` |
| `scanTrimBorder` | 3783 | `projTrimBorder` |
| `scanOuterDarkRun` | 3968 | `projOuterDarkRun` |
| `scanImageOnce` | 4011 | `projImageOnce`（顶层，返回 `PResult`） |
| `enforceBalance` | 4194 | `projEnforceBalance` |

- 实现约定（决策已定，执行者无需再选）：
  - 直方图分位数 p5/p50/p95、自相关、31px 单调队列滑动最小值、3px 平滑、抛物线插值、峰合并等，全部用 `std::vector`/`std::vector<double>` 逐条照搬 JS 数值语义（**保持整数/浮点运算顺序一致**，力求逐格对拍一致；不做算法"优化"）。
  - 旋转：`cv::warpAffine(src, dst, M, size, INTER_LINEAR, BORDER_CONSTANT, Scalar(fill,fill,fill))`，`fill` 必须由调用方传入已算好的 p50（对齐 JS L2231 注释教训）。
  - `size != 15` 时 `recognizeProj` 直接返回 `{ok:false, err:"proj: size!=15"}`（APK 为固定 15 路）。
  - 解码：复用 `cv::imdecode(..., IMREAD_COLOR)` + `cvtColor(BGR2RGB)`（同 `gbrecognize.cpp` L190-204 的 `decodeImage` 语义）。
  - **输出映射**（JS → C++ `recognize` 同构）：
    - `grid[225]` + `conf[225]` → `black`/`white` 数组（`grid[k]==1 → black.push({x:k%15,y:k/15})`，`==2 → white`）；不做排序（顺序不影响下游 `visSynthMoves`）。
    - `xs[15]`/`ys[15]` → `geometry.xs`/`geometry.ys`；`geometry.x0=xs[0]`、`y0=ys[0]`、`stepX=median(diff(xs))`、`stepY=median(diff(ys))`、`source="proj"`、`confidence`=由 `stats` 与 `avgLineEv` 折算（`confidence = avgLineEv`）、`bg=p50`。
    - `suspect = (low > 0)`（`low` = `conf[k] < 0.55` 的格数）——与 JS 校对标记语义一致；`ok=true`。
    - `diag` 写入：`method="proj"`、`period`、`rms`、`inliers`、`avgLineEv`、`stones/blacks/whites/low`、`mode`（dark/bright）、`frame`、`stars`（recal 是否生效）、`autolevelDeg`——供 `vision-parity` 与排错读取。
  - proj 结果**不进 `recognize()` 的缓存**（仅兜底调用，频次低）。
- 线程安全：由调用方 `GbvRecognizeJson` 的 `std::lock_guard<std::mutex> lk(g_mu)` 覆盖，`gbproj.cpp` 内不额外加锁。

### 3.2 接入点：`desktop-vision/src/gbrecognize.cpp`（大预防针，单一插入）

把现有 `recognizeUncached` 主体原样改名 `recognizeNative`（static），新的 `recognizeUncached` 改为「原生优先 + proj 兜底」：

```cpp
static Json recognizeNative(const std::string& imageB64, int size, bool allowSnap); // 原 L1126-1233 主体

static bool projAcceptable(const Json& r) {
    return r.boolOr("ok", false) && !r.boolOr("suspect", false);
}
static bool hasStones(const Json& r) { /* black.size()+white.size()>0 */ }

static Json recognizeUncached(const std::string& imageB64, int size, bool allowSnap) {
    Json res = recognizeNative(imageB64, size, allowSnap);
    if (size != 15) return res;                       // 非 15 路不适用
    if (projAcceptable(res) && hasStones(res)) return res;   // 原生可信且有子 → 不动（零回归）
    Json pr = recognizeProj(imageB64, size, allowSnap);      // 大兜底
    if (projAcceptable(pr)) {
        if (projAcceptable(res) && !hasStones(res)) {
            // 原生判「可信但空盘」：只有 proj 找到子且证据足够强才接管，防空盘假阳（疫苗矩阵 E）
            double lv = 0; if (const Json* d = pr.find("diag")) lv = d->numOr("avgLineEv", 0);
            int lowN = 0; if (const Json* d = pr.find("diag")) lowN = (int)d->numOr("low", 0);
            if (hasStones(pr) && lv >= 0.5 && lowN == 0) return tagProj(pr);
            return res;
        }
        return tagProj(pr);                            // 原生 !ok / suspect → proj 接管
    }
    return res;                                        // proj 也无可信解 → 保持原生结论
}
```

- `tagProj(j)`：把 `diag.method` 标为 `"proj"`（若已有 diag 则叠加），并确保 `diag.proj_fallback=true`，便于回归时统计"什么时候真正用了兜底"。
- 插入位置不影响 `recognizeCore` 内部（L721-731 的早退返回经 `recognizeUncached` 统一收口）——**所有早退都被新 `recognizeUncached` 覆盖**。
- 现有 crop / `snapBoardRects` / `Partial*` 逻辑**一字不动**。

### 3.3 调试/对拍入口：`desktop-vision/src/gbdll.cpp`

在 `GbvRecognizeJson` 的 `wulin` 与默认分支之间新增：

```cpp
} else if (mode == "proj") {
    std::string image = reqJson.strOr("image", "");
    std::lock_guard<std::mutex> lk(g_mu);
    result = recognizeProj(image, size, !reqJson.boolOr("nosnap", false));
}
```

- 目的：让 `mode:"proj"` 可被**直接驱动**（HTTP `POST /recognize` 原样透传 body，见 `main.cpp` L97-107），用于与 JS 金标逐格对拍和排错。
- 默认 `mode:"image"` 行为不变（proj 只在其内部作为兜底）；`GbvVersion` 保持 `2`（导出面未变，壳的 `/health` 巡检不受影响）。

### 3.4 不改动项（明确"不做"）

- **不改** `desktop-calculator/src/host.cpp` / `ui/calc.js` / 加密流水线：因为自动兜底，UI 无需感知、无需开关、无需新 `mode`。`RunVisionForVis` L1847 的 `mode!="scan"→"image"` 保持不变。
- **不改** `main.cpp`、`gbpipe.cpp`、`gbscanapi.*`、`gbdetector.*`、`gbadaptive.*`。
- **不动** `locateBoard` / `locateGridHough` / `scanOnce` / `recognize` 既有分支行为。

### 3.5 构建与发布

- `node tools/build-vision.js --publish`：自动编译 `gbproj.cpp` → 进 DLL → 复制 `GomokuVision.exe`/`.dll` 到 `Meter GomokuTrainer\Vision\` 与 `Meter engine-server\Vision\`（两个训练器一次覆盖）。

## 四、Assumptions & Decisions

1. **无 UI 开关**——按用户"整合到一块 / 大预防针 / 并列到整体算法中"原话，proj 是同管线兜底层，不作为可选算法。
2. **完整移植**——含 `projFindGridGrad`、`projGridByFrame`、`projFindGrid('ultra')`、`projStarRecal`、`projAutoLevel`。
3. **数值逐条照搬**，不为"更优"改写算术顺序；对拍以"逐格一致"为目标，个别浮点末位差异容许（棋盘 15×15 分类结果为整数，容忍度 0）。
4. `projAcceptable` 与「可信但空盘」时的 `avgLineEv>=0.5 && low==0 && stones>0` 门槛，是为守住疫苗矩阵 **E（空盘零假阳）** 而设；若验收发现误伤真图，仅调此门槛，不动算法本体。
5. `recognizeProj` 仅处理 15 路；非 15 直接放弃（训练器即 15 路）。
6. 性能：proj 仅在原生不可信时执行，且 `SCAN_MAX_EDGE=1000` 与 JS 一致，量级 <1s；不引入并行。

## 五、验证（按顺序，全部为可执行命令）

1. **编译自检**：`node tools/build-vision.js`（不带 --publish）——确认 `gbproj.cpp` 编译通过、DLL 链接成功、导出表 4 项齐全（脚本 L209-214 守护）。
2. **JS 金标对拍（核心）**：
   - 用 Python（复用 `recog_vaccine_selftest.py` 的 `render/perturb_*` 与 `PALETTES`）生成一批**轴对齐**夹具（自动校平应判 0°，避免 Node 端无 canvas 的 `scanRotate` 降级造成差异），同时落 PNG（给 C++）与 raw RGBA `.bin`（给 JS）。
   - 新增一次性 Node 脚本 `tools/_proj_golden.js`（下划线前缀=临时工具，不进发布包）：从 `.tmp-apk-analysis/assets_index.html` 抽 L2184-4255 段，在最小沙箱（`document` 桩使 `scanRotate` 走 catch 分支原样返回）中导出 `scanImageOnce`，对每个 `.bin` 产出 `{grid,conf,xs,ys,stats}` JSON。
   - C++ 侧对同一 PNG 用 `POST /recognize` `{"mode":"proj",...}`（或复用 `--recognize-image` 临时加 mode）取 `black/white/xs/ys`，与金标逐格 diff，输出不一致明细。
3. **原生路径零回归**：`python tools/vision-parity.py`（C++ vs Python 参考全矩阵 A~K 对拍）——必须与改动前**完全一致**。
4. **大预防针验收**：`python tools/recog_vaccine_selftest.py`（矩阵 A~H 逐子精确/零假阳）——通过数不低于改动前；重点看 A/B/C/G/H 是否因 proj 兜底**变多通过**，且 E（空盘）**不回归**。
5. **端到端**：在两个训练器「图片」抽屉导入极浅底/深底/光泽棋子/整屏同色背景样张，确认识谱结果正确（proj 兜底时 `diag.proj_fallback=true`，可查日志 `[vis] recognize ok ... mode=image`）。
6. **发布**：`node tools/build-vision.js --publish`，确认两个 `Vision\GomokuVision.dll` 时间戳同步更新。

## 六、实施里程碑（建议顺序）

1. `gbproj.h`/`gbproj.cpp` 骨架 + `projToGray/projDownscale/projRotate/projProject/projFindGrid(projGridPre)`——先让 `mode:"proj"` 在简单木盘夹具上跑通、与 JS 金标一致。
2. `projAutoLevel` + `projTrimBorder` + 守门（rms/inliers/span/period）。
3. `projFindGridGrad` + `projGridByFrame` + `ultra` 兜底 + 框边滑窗。
4. `projWarm` + `projClassify` + `projStarRecal` + 交叉周期校正 + `projEnforceBalance`。
5. 输出映射 + `gbdll.cpp` `mode:"proj"` 分支。
6. `gbrecognize.cpp` 接入（`recognizeNative` 改名 + 新 `recognizeUncached`）。
7. 验证 1~6 全跑；`--publish`。
