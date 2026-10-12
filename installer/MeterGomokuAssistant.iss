; ============================================================================
;  Meter GomokuAssistant —— 单桌面版五子棋助手 · 安装包脚本（Inno Setup 7）
; ----------------------------------------------------------------------------
;  编译（命令行）：
;      "C:\Program Files\Inno Setup 7\ISCC.exe" "installer\MeterGomokuAssistant.iss"
;  产物：
;      installer\out\Meter GomokuAssistant_Setup.exe
;
;  设计要点（改前先读）：
;   ① 第三版本（2026-10-03 定案）：借鉴单训练器的发布方案，桌面助手独立成完整产品。
;      与三件套（MeterGomokuSuite.iss）的区别：**只带助手**，不带训练器/书签启动器；
;      宿主是 GB_ASSISTANT_STANDALONE 编译的 Desktop GomokuAssistant.exe ——
;      激进单硬 C++ 连接：引擎（Web GomokuEngine.exe --as-backend）进
;      KILL_ON_JOB_CLOSE job，随宿主生、随宿主死，不收养不道别（无共享所有权竞态）。
;   ② 打包源 = 项目根「Meter GomokuAssistant」目录（build-assistant-release.js 组装，
;      组装脚本自带新鲜度/指纹硬校验 —— 目录不新鲜这里打出来的就是坏包）。
;   ③ PrivilegesRequired=lowest（单用户安装，不弹 UAC）：exe 所在目录必须**可写**
;      （WebView2 用户数据目录 {app}\WebView2Data 由宿主创建）。
;   ④ 中英双语 + 快捷方式命名与训练器/套件同款惯例。
;   ⑤ 引擎随包：Web GomokuEngine.exe（SEA）+ rapfi-native\（官方五变体 + 权重）；
;      视觉随包：Vision\{GomokuVision.exe + GomokuVision.dll} 成对（#95/#110 布局）。
; ============================================================================

#define AppName        "Meter GomokuAssistant"
#define AppVersion     "4.37"
#define AppPublisher   "Meter"
#define AppExeName     "Desktop GomokuAssistant.exe"
#define SrcDir         "..\Meter GomokuAssistant"
#define AppIcon        "..\desktop-overlay\src\GomokuOverlay.ico"

[Setup]
; AppId 固定不变（新 GUID，与训练器/套件互不冲突）—— 升级/卸载识别同一个应用，勿改。
AppId={{4E8B1C77-6A52-4D93-9F0B-1C7D5A24E931}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppComments=Five-in-a-Row (Gomoku) on-screen assistant / 五子棋桌面助手（单机版）
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
; ---- 单用户安装（理由见文件头 ③）----
PrivilegesRequired=lowest
; ---- 产物 ----
OutputDir=out
OutputBaseFilename=Meter GomokuAssistant_Setup
; 输出安装内容清单（与安装包同名 .manifest）：让 Defender / 用户可审计包里装了什么，
; 降低「未知自解压包」误报面（2026-10-04 Defender 防护批）。
OutputManifestFile=Meter GomokuAssistant_Setup.manifest
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2/max
SolidCompression=yes
; ---- 向导外观：现代风格 + 跟随系统深浅色 ----
WizardStyle=modern dynamic
; ---- 中英双语：让用户在安装开始时选择 ----
ShowLanguageDialog=yes
; ---- 系统要求：x64 兼容；放宽到 Windows 7 SP1+（2026-10-04 用户「低版本电脑适应性」）----
;   运行时只依赖 WebView2：Win10/11 通常自带；Win7/8 缺时安装向导会提示去装（见 PrepareToInstall）。
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=6.1sp1
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
zh.LaunchApp=启动五子棋助手
zh.AdditionalIcons=附加快捷方式：
zh.IconName=Meter 五子棋助手
zh.WebView2Missing=本软件需要「Microsoft Edge WebView2 运行时」（Windows 10/11 通常已随 Edge 预装）。%n%n点「是」立即打开官方下载页，安装完成后回来继续即可；点「否」先继续安装（安装后仍可手动补装运行时）。%n%n下载页：https://go.microsoft.com/fwlink/p/?LinkId=2124703
; ---- English ----
en.CreateDesktopIcon=Create a desktop shortcut
en.LaunchApp=Launch Meter Gomoku Assistant
en.AdditionalIcons=Additional shortcuts:
en.IconName=Meter GomokuAssistant
en.WebView2Missing=This app requires the Microsoft Edge WebView2 Runtime (normally already present on Windows 10/11 via Edge).%n%nClick Yes to open the official download page now, then continue after installing it; click No to continue the installation anyway (you can install the runtime later).%n%nDownload: https://go.microsoft.com/fwlink/p/?LinkId=2124703

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; 升级安装：先清掉旧版本的面板/引擎/识别组件，避免旧 .enc / 旧引擎残留被加载。
Type: filesandordirs; Name: "{app}\overlay"
Type: filesandordirs; Name: "{app}\rapfi-native"
Type: filesandordirs; Name: "{app}\Vision"
Type: files; Name: "{app}\Web GomokuEngine.exe"
Type: files; Name: "{app}\GomokuVision.exe"
Type: files; Name: "{app}\GomokuVision.dll"
; 2026-10-03：废除 overlay README 与 Node 调度器模式 —— 升级时清掉旧货
Type: files; Name: "{app}\README_zh.md"
Type: files; Name: "{app}\README_en.md"

[Files]
; 助手宿主（单机版编译：GB_ASSISTANT_STANDALONE，引擎调度 C++ 化 —— 无 Web GomokuEngine）
Source: "{#SrcDir}\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
; 引擎模型（官方五变体 + 权重 + 官方开局库 rapfi.db，rapfi-native\）
; 2026-10-04 Defender 防护批：*.poisoned-bak 与 rapfi_bak*.db（非 rapfi 官方开局库）一律不入包
Source: "{#SrcDir}\rapfi-native\*"; DestDir: "{app}\rapfi-native"; Excludes: "*.poisoned-bak,rapfi_bak*.db"; Flags: ignoreversion recursesubdirs
; 视觉组件（识图服务壳 + 识别模型库，成对装进 Vision\ 子目录）
Source: "{#SrcDir}\Vision\GomokuVision.exe"; DestDir: "{app}\Vision"; Flags: ignoreversion
Source: "{#SrcDir}\Vision\GomokuVision.dll"; DestDir: "{app}\Vision"; Flags: ignoreversion
; 加密面板（宿主内存解密；磁盘上无明文）
Source: "{#SrcDir}\overlay\*.enc"; DestDir: "{app}\overlay"; Flags: ignoreversion
; 文档（中英手册 + 中英开源许可与版权声明）
Source: "{#SrcDir}\使用手册.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\User Guide.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\开源许可与版权声明.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\LICENSES & COPYRIGHT NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; 开始菜单 + 桌面快捷方式：图标取自 exe 内嵌资源。
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"; IconIndex: 0
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{cm:IconName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"; IconIndex: 0; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 卸载前先关掉程序与随包引擎/视觉：它们活着会持有 {app} 里的句柄，卸载删不干净。
Filename: "{sys}\taskkill.exe"; Parameters: "/IM ""{#AppExeName}"" /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "KillAssistant"
Filename: "{sys}\taskkill.exe"; Parameters: "/IM ""Web GomokuEngine.exe"" /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "KillEngine"
Filename: "{sys}\taskkill.exe"; Parameters: "/IM ""GomokuVision.exe"" /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "KillVision"

[UninstallDelete]
; 清理运行期产物（这些不在安装清单里，卸载器本来不会碰）
Type: filesandordirs; Name: "{app}\WebView2Data"
Type: filesandordirs; Name: "{app}\logs"

[Code]
const
  WebView2ClientKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2DownloadUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

{ 读取 WebView2 运行时的已安装版本；返回空串 = 未安装。 }
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
