; ============================================================================
;  Meter Gomoku Link —— 连线版五子棋训练器 · 专属安装包脚本（Inno Setup 7）
; ----------------------------------------------------------------------------
;  编译（命令行）：
;      "C:\Program Files\Inno Setup 7\ISCC.exe" "installer\MeterGomokuLink.iss"
;  产物：
;      installer\out\Meter Gomoku Link_Setup.exe
;
;  设计要点（改前先读，与 MeterGomokuTrainer.iss 的差异见 ⑥）：
;   ① 打包源 = 项目根的「Meter Gomoku」目录（连线版：识别在连线窗、引擎=宿主内
;      Rapfi 三车道、AI 大脑=助手 bridge.js）。**绝不打包
;      `GomokuTrainer resources\`** —— 那是 WebView2 的用户数据缓存（宿主按 exe 旁
;      目录创建），属运行期产物：几十 MB 垃圾 + 崩溃 dmp，在 [UninstallDelete] 清理。
;   ② PrivilegesRequired=lowest（单用户安装，不弹 UAC）：
;      WebView2 用户数据目录建在 exe 旁，exe 所在目录必须**可写**。装到 Program Files
;      会建不出用户数据目录 → 启动失败。{autopf} 在 lowest 模式下解析为
;      %LOCALAPPDATA%\Programs（VSCode / Chrome 同款做法）。
;   ③ 中英双语：安装一开始就选界面语言（ShowLanguageDialog=yes）。中文
;      languages\ChineseSimplified.isl 为 UTF-8 带 BOM + LanguageCodePage=0（防乱码）。
;   ④ 图标：安装包 + 快捷方式 + 卸载项统一用 Calculator.ico（exe 构建时已由
;      rc.exe 编入同一 ico，Icons 直接指 exe 资源）。
;   ⑤ 识别组件 = {app}\Vision\{GomokuVision.exe + GomokuVision.dll} 成对安装
;      （宿主 EnsureScanServer 第一优先找 {ExeDir}\Vision\GomokuVision.exe）。
;   ⑥ 2026-10-07 专属化（连线版）：
;      · AppId 独立 —— 与独立版训练器/助手互不覆盖，可并存；
;      · 文档 = 软件说明 (Software Description).pdf（使用说明 + 开源说明合并为一份，
;        中英双语；开源字体：思源黑体/思源宋体排版）；
;      · 引擎 = 官方 Rapfi 五变体 + 权重/配置（宿主三车道 main/sub/fwd 共用）；
;      · 卸载时连 Vision 识别进程一并 taskkill（残留句柄会锁住 {app}\Vision）。
;   ⑦ 2026-10-08（用户）：「如果用户在选择语言中选择中文，这个软件的名字就叫 Meter 五子棋」
;      ⇒ 显示名随**安装向导里选的语言**走，走 [CustomMessages] + {cm:AppName}：
;         中文 → Meter 五子棋 ；英文 → Meter Gomoku
;         （向导标题 / 安装目录 / 开始菜单 / 桌面快捷方式 /「应用和功能」里的条目
;           全部跟着变 —— 一个安装包同时伺候两种语言，语言在安装开始时选。）
;      技术标识仍固定英文（版本资源 ProductName、输出文件名），
;      理由：这两处是**编译期**求值，多语言常量在那里只有一种取值，写死反而稳。
; ============================================================================

; #AppNameEn = 技术标识用的固定英文名（版本资源 / 输出文件名）；
; 一切**看得见**的地方都用 {cm:AppName}（见 [CustomMessages]）。
#define AppNameEn      "Meter Gomoku"
#define AppVersion     "4.38"
#define AppPublisher   "Meter"
#define AppExeName     "Desktop GomokuTrainer.exe"
#define SrcDir         "..\Meter Gomoku"
#define AppIcon        "..\desktop-connect\src\Calculator.ico"

[Setup]
; AppId 独立固定 —— 连线版专属身份，勿与 MeterGomokuTrainer.iss 共用。
AppId={{8D47B1F0-5A31-4C6E-9D82-3F1A0C7E2B94}
; ★ 2026-10-08（用户）：显示名 = 跟随安装语言（中文 Meter 五子棋 / 英文 Meter Gomoku）
AppName={cm:AppName}
AppVersion={#AppVersion}
AppVerName={cm:AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppComments=Five-in-a-Row (Gomoku) trainer / 五子棋训练器
DefaultDirName={autopf}\{cm:AppName}
DefaultGroupName={cm:AppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
; ---- 单用户安装（理由见文件头 ②）----
PrivilegesRequired=lowest
; ---- 产物 ----
OutputDir=out
; 输出文件名固定英文（一个安装包同时带中英两套语言，文件名不该偏向某一种语言）
OutputBaseFilename=Meter Gomoku_Setup
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2/max
SolidCompression=yes
; ---- 向导外观：现代风格 + 跟随系统深浅色 ----
WizardStyle=modern dynamic
; ---- 中英双语：让用户在安装开始时选择 ----
ShowLanguageDialog=yes
; ---- 系统要求：x64 兼容 + Windows 10 及以上（运行时只依赖 Win10/11 自带 WebView2）----
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; ---- 安装期间若程序正在运行：提示关闭后继续 ----
CloseApplications=yes
RestartApplications=no
; ---- 文件属性 ----
VersionInfoVersion={#AppVersion}
; 版本资源在**编译期**写死，只能用固定英文名（多语言常量在这里不适用）
VersionInfoProductName={#AppNameEn}
VersionInfoProductVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppNameEn} Setup

[Languages]
; 中文放第一个：中文用户直接回车即可
Name: "zh"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
; ---- 简体中文 ----
; ★ 2026-10-08（用户）：「如果用户在选择语言中选择中文，这个软件的名字就叫 Meter 五子棋」
;   AppName 走这里 → 向导标题 / 安装目录 / 开始菜单 / 桌面快捷方式 /「应用和功能」条目
;   全部跟语言走。UninstallName 单独给一条：{cm:} 不支持嵌套，
;   {cm:UninstallProgram,{cm:AppName}} 这种写法靠不住，索性各语言写全。
zh.AppName=Meter 五子棋
zh.IconName=Meter 五子棋
zh.UninstallName=卸载 Meter 五子棋
zh.CreateDesktopIcon=创建桌面快捷方式
zh.LaunchApp=启动 Meter 五子棋
zh.AdditionalIcons=附加快捷方式：
zh.WebView2Missing=本软件需要「Microsoft Edge WebView2 运行时」（Windows 10/11 通常已随 Edge 预装）。%n%n点「是」立即打开官方下载页，安装完成后回来继续即可；点「否」先继续安装（安装后仍可手动补装运行时）。%n%n下载页：https://go.microsoft.com/fwlink/p/?LinkId=2124703
; ---- English ----
en.AppName=Meter Gomoku
en.IconName=Meter Gomoku
en.UninstallName=Uninstall Meter Gomoku
en.CreateDesktopIcon=Create a desktop shortcut
en.LaunchApp=Launch Meter Gomoku
en.AdditionalIcons=Additional shortcuts:
en.WebView2Missing=This app requires the Microsoft Edge WebView2 Runtime (normally already present on Windows 10/11 via Edge).%n%nClick Yes to open the official download page now, then continue after installing it; click No to continue the installation anyway (you can install the runtime later).%n%nDownload: https://go.microsoft.com/fwlink/p/?LinkId=2124703

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; 升级安装：先清掉旧版本的界面与引擎，避免旧 .enc / 旧引擎残留被加载。
Type: filesandordirs; Name: "{app}\calc"
Type: filesandordirs; Name: "{app}\rapfi-native"
Type: filesandordirs; Name: "{app}\Vision"
; 旧版说明 PDF（旧的「米特五子棋连线 使用说明 / Meter Gomoku Link User Guide」两份，
;   以及上一版的《使用说明》《开源说明》两份）—— 升级时全部清掉，换成合并后的单份《软件说明》。
Type: files; Name: "{app}\米特五子棋连线 使用说明.pdf"
Type: files; Name: "{app}\Meter Gomoku Link User Guide.pdf"
Type: files; Name: "{app}\使用说明.pdf"
Type: files; Name: "{app}\开源说明.pdf"

[Files]
; 宿主 exe（连线窗 + 主窗 + 识别调度 + 引擎三车道宿主）
Source: "{#SrcDir}\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
; 识别组件（exe 服务壳 + dll 识别模块，成对）
Source: "{#SrcDir}\Vision\GomokuVision.exe"; DestDir: "{app}\Vision"; Flags: ignoreversion
Source: "{#SrcDir}\Vision\GomokuVision.dll"; DestDir: "{app}\Vision"; Flags: ignoreversion
; 软件说明（使用说明 + 开源说明合并为一份，中英双语；思源黑体/思源宋体排版），随包装到根目录
Source: "{#SrcDir}\软件说明 (Software Description).pdf"; DestDir: "{app}"; Flags: ignoreversion
; 加密后的界面（宿主内存解密；磁盘上无明文）
Source: "{#SrcDir}\calc\*.enc"; DestDir: "{app}\calc"; Flags: ignoreversion
; 原生 Rapfi 引擎：官方 250615 五变体（avx512vnni/avxvnni/avx512/avx2/sse）
;   + 权重与配置，约 50MB。排除 *.poisoned-bak（本地排障备份，非运行时文件）。
Source: "{#SrcDir}\rapfi-native\*"; DestDir: "{app}\rapfi-native"; Excludes: "*.poisoned-bak,rapfi_bak??.db"; Flags: ignoreversion recursesubdirs
; ★ 不列 {#SrcDir}\GomokuTrainer resources\ —— WebView2 用户数据缓存，属运行期产物。

[Icons]
; 开始菜单 + 桌面快捷方式：图标取自 exe 内嵌资源。
; ★ 2026-10-08（用户）：快捷方式名跟随安装语言 —— 中文装 =「Meter 五子棋」，
;   英文装 =「Meter Gomoku」（{cm:AppName} / {cm:IconName} / {cm:UninstallName}）。
Name: "{group}\{cm:AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"; IconIndex: 0
Name: "{group}\{cm:UninstallName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{cm:IconName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"; IconIndex: 0; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 卸载前先关掉程序：程序运行时 WebView2 会持有 {app}\GomokuTrainer resources 里的句柄，
; 卸载器删不掉该目录。先 taskkill 再删，保证卸载干净。
Filename: "{sys}\taskkill.exe"; Parameters: "/IM ""{#AppExeName}"" /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "KillLinkTrainer"
; 识别组件万一还在跑（识别子进程残留）也一并关掉，否则 {app}\Vision\* 删不掉。
Filename: "{sys}\taskkill.exe"; Parameters: "/IM ""GomokuVision.exe"" /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "KillLinkVision"

[UninstallDelete]
; 清理运行期产物（这些不在安装清单里，卸载器本来不会碰）
Type: filesandordirs; Name: "{app}\GomokuTrainer resources"
Type: files; Name: "{app}\GomokuTrainer.log"
Type: files; Name: "{app}\GomokuTrainer.pos"

[Code]
const
  WebView2ClientKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2DownloadUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

{ 读取 WebView2 运行时的已安装版本；返回空串 = 未安装。
  EdgeUpdate 的运行时登记表项分三处（系统级 32 位视图 / 系统级 64 位视图 / 当前用户），
  逐一探测；"0.0.0.0" 是官方约定的“已卸载”占位值。 }
function GetWebView2Version(): String;
var
  V: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM32, WebView2ClientKey, 'pv', V) then
    Result := V
  else if RegQueryStringValue(HKLM64, WebView2ClientKey, 'pv', V) then
    Result := V
  else if RegQueryStringValue(HKCU, WebView2ClientKey, 'pv', V) then
    Result := V;
  if (Result = '') or (Result = '0.0.0.0') then
    Result := '';
end;

{ 复制文件之前检查运行时：缺了就给一个“去下载 / 继续安装”的选择（不阻断安装）。 }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ErrCode: Integer;
begin
  Result := '';
  if GetWebView2Version() <> '' then
    Exit;
  if WizardSilent() then
    Exit;
  if MsgBox(ExpandConstant('{cm:WebView2Missing}'), mbInformation, MB_YESNO) = IDYES then
    ShellExec('open', WebView2DownloadUrl, '', '', SW_SHOWNORMAL, ewNoWait, ErrCode);
end;
