; ============================================================================
;  Meter GomokuTrainer —— 独立版五子棋训练器 · 安装包脚本（Inno Setup 7）
; ----------------------------------------------------------------------------
;  编译（命令行）：
;      "C:\Program Files\Inno Setup 7\ISCC.exe" "installer\MeterGomokuTrainer.iss"
;  产物：
;      installer\out\Meter GomokuTrainer_Setup.exe
;
;  设计要点（改前先读）：
;   ① 打包源 = 项目根的「Meter GomokuTrainer」目录（独立版，页面内 AI）。
;      **绝不打包 `GomokuTrainer resources\`** —— 那是 WebView2 的用户数据缓存
;      （宿主按 exe 旁目录创建，见 host.cpp 的 CreateCoreWebView2EnvironmentWithOptions），
;      属于运行期产物：几十 MB 垃圾 + 崩溃 dmp，必须在 [UninstallDelete] 里清理。
;   ② PrivilegesRequired=lowest（单用户安装，不弹 UAC）：
;      因为 ①，exe 所在目录必须**可写**。装到 Program Files 会让 WebView2 建不出
;      用户数据目录 → 程序启动失败。{autopf} 在 lowest 模式下解析为
;      %LOCALAPPDATA%\Programs，正是 VSCode / Chrome 等的做法。
;   ③ 中英双语：安装一开始就说选择界面语言（ShowLanguageDialog=yes）。
;      中文用本目录 languages\ChineseSimplified.isl —— 从 Inno 官方自带翻译复制而来，
;      并**改写为 UTF-8 带 BOM + LanguageCodePage=0**：Inno 7 会按“文件自身代码页”
;      校验字节，原文件是无 BOM 却在头部声明 936，容易被按 GBK 解读 → 界面乱码。
;   ④ 图标：安装包自身 + 所有快捷方式 + 控制面板卸载项，统一用 Calculator.ico
;      （exe 在构建时已由 rc.exe 把同一个 ico 编入，所以 Icons 直接指向 exe 的资源）。
; ============================================================================

#define AppName        "Meter GomokuTrainer"
#define AppVersion     "4.3.0"
#define AppPublisher   "Meter"
#define AppExeName     "Desktop GomokuTrainer.exe"
#define SrcDir         "..\Meter GomokuTrainer"
#define AppIcon        "..\desktop-calculator\src\Calculator.ico"

[Setup]
; AppId 固定不变 —— 升级安装/卸载识别同一个应用，勿改。
AppId={{7C3E9A54-2B6D-4F18-9E7A-5D0C1B8F3A62}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppComments=Five-in-a-Row (Gomoku) training tool / 五子棋对弈训练器
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
; ---- 单用户安装（理由见文件头 ②）----
PrivilegesRequired=lowest
; ---- 产物 ----
OutputDir=out
OutputBaseFilename=Meter GomokuTrainer_Setup
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2/max
SolidCompression=yes
; ---- 向导外观：现代风格 + 跟随系统深浅色 ----
WizardStyle=modern dynamic
; ---- 中英双语：让用户在安装开始时选择 ----
ShowLanguageDialog=yes
; ---- 系统要求：x64 兼容 + Windows 10 及以上（exe 是 x64；运行时只依赖 Win10/11 自带 WebView2）----
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; ---- 安装期间若程序正在运行：提示关闭后继续 ----
CloseApplications=yes
RestartApplications=no
; ---- 文件属性 ----
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup

[Languages]
; 中文放第一个：中文用户直接回车即可
Name: "zh"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
; ---- 简体中文 ----
zh.CreateDesktopIcon=创建桌面快捷方式
zh.LaunchApp=启动五子棋训练器
zh.AdditionalIcons=附加快捷方式：
; 桌面快捷方式的名字跟随安装界面语言（2026-09-21 用户要求：选中文 → 「Meter 五子棋」）
zh.IconName=Meter 五子棋
zh.WebView2Missing=本软件需要「Microsoft Edge WebView2 运行时」（Windows 10/11 通常已随 Edge 预装）。%n%n点「是」立即打开官方下载页，安装完成后回来继续即可；点「否」先继续安装（安装后仍可手动补装运行时）。%n%n下载页：https://go.microsoft.com/fwlink/p/?LinkId=2124703
; ---- English ----
en.CreateDesktopIcon=Create a desktop shortcut
en.LaunchApp=Launch Meter Gomoku Trainer
en.AdditionalIcons=Additional shortcuts:
en.IconName=Meter GomokuTrainer
en.WebView2Missing=This app requires the Microsoft Edge WebView2 Runtime (normally already present on Windows 10/11 via Edge).%n%nClick Yes to open the official download page now, then continue after installing it; click No to continue the installation anyway (you can install the runtime later).%n%nDownload: https://go.microsoft.com/fwlink/p/?LinkId=2124703

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; 升级安装：先清掉旧版本的界面与引擎，避免旧 .enc / 旧引擎残留被加载。
Type: filesandordirs; Name: "{app}\calc"
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\rapfi-native"

[Files]
; 宿主 exe
Source: "{#SrcDir}\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
; 识别组件（识图窗「上传识别 / 屏幕截图」的子进程；C++ 单文件零依赖）
; ★ 2026-09-21 补进安装清单 —— 之前漏了，装出来的版本识图窗识别不可用。
Source: "{#SrcDir}\GomokuVision.exe"; DestDir: "{app}"; Flags: ignoreversion
; 使用说明（随包装到根目录）
Source: "{#SrcDir}\使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion
; 加密后的界面（宿主内存解密；磁盘上无明文）
Source: "{#SrcDir}\calc\*.enc"; DestDir: "{app}\calc"; Flags: ignoreversion
; ★ 2026-09-25：页面内 AI 换**原生 Rapfi 引擎**（exe 旁 rapfi-native/ 存在即启用，
;   host.cpp 按变体探测 avx512/avx2；目录缺席才回落页面内 WASM——独立版发布目录已不带
;   resources/，故安装包同样只装原生运行时：引擎 exe ×2 + 官方权重 + config.toml，约 41MB）
Source: "{#SrcDir}\rapfi-native\*"; DestDir: "{app}\rapfi-native"; Flags: ignoreversion recursesubdirs
; ★ 不列 {#SrcDir}\GomokuTrainer resources\ —— WebView2 用户数据缓存，属运行期产物。

[Icons]
; 开始菜单 + 桌面快捷方式：图标取自 exe 内嵌资源（与安装包同一个 ico）。
; 桌面快捷方式的名字用 {cm:IconName}：选中文装出来叫「Meter 五子棋」（2026-09-21 用户要求）。
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"; IconIndex: 0
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{cm:IconName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"; IconIndex: 0; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 卸载前先关掉程序：程序运行时 WebView2 会持有 {app}\GomokuTrainer resources 里的句柄，
; 卸载器删不掉该目录（实测会留下几十 MB 残骸）。先 taskkill 再删，保证卸载干净。
Filename: "{sys}\taskkill.exe"; Parameters: "/IM ""{#AppExeName}"" /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "KillTrainer"
; 识别组件万一还在跑（识图子进程残留）也一并关掉，否则 {app}\GomokuVision.exe 删不掉。
Filename: "{sys}\taskkill.exe"; Parameters: "/IM ""GomokuVision.exe"" /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "KillVision"

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
