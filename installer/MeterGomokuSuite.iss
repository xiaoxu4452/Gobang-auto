; ============================================================================
;  Meter 五子棋 · 三合一版本 —— 安装包脚本（Inno Setup 7）
; ----------------------------------------------------------------------------
;  编译（命令行）：
;      "C:\Program Files\Inno Setup 7\ISCC.exe" "installer\MeterGomokuSuite.iss"
;  产物：
;      installer\out\Meter Gomoku Suite_Setup.exe
;
;  设计要点（改前先读）：
;   ① 打包源 = 项目根的「Meter engine-server」目录（三合一套装导出；2026-09-25 用户定）：
;        Desktop GomokuTrainer.exe   训练器         → 快捷方式中文名「五子棋训练器」
;        Desktop GomokuOverlay.exe   桌面版助手      → 快捷方式中文名「桌面识别器」
;        Web GomokuEngine.exe        网页版助手      → 快捷方式中文名「网页识别器」
;        GomokuVision.exe            识别组件（前两者共用）
;      ★ 顺序固定为 训练器 → 桌面识别器 → 网页识别器（勾选页 / 开始菜单同序）。
;   ② **绝不打包 `GomokuTrainer resources\` 与 `logs\`** —— 都是运行期产物
;      （WebView2 用户数据缓存 / 运行日志），必须在 [UninstallDelete] 里清理。
;      「最小打包」：只进三个 exe + 识别组件 + 加密 UI + rapfi 运行时 + 说明书；
;      任何 *.log / logs\ / 用户数据目录都不得进 [Files]（build-installer.js 有护栏）。
;   ③ PrivilegesRequired=lowest（单用户安装，不弹 UAC）：exe 所在目录必须可写，
;      {autopf} 在 lowest 模式下解析为 %LOCALAPPDATA%\Programs。
;   ④ 中英双语：安装一开始就说选择界面语言（ShowLanguageDialog=yes）。
;   ⑤ **安装结束时**（复制完文件之后、完成页之前）弹一页「保留哪些桌面快捷方式」：
;      三项复选**默认全勾**（用户 2026-09-22 定），三个都能单独取消 —— 用户要求
;      「到最后让用户选择可保留的快捷方式」。静默安装跳过自定义页 = 三个都建。
;   ⑥ 图标：安装包自身用图标目录里**专属**的多尺寸 Gomoku3in1.ico（≠ 任一程序图标）；
;      各快捷方式图标取自**对应 exe 内嵌资源**（三个图标互不相同）。
; ============================================================================

#define SuiteName       "Meter Gomoku Suite"
#define SuiteVersion    "4.3.0"
#define SuitePublisher  "Meter"
#define ExeTrainer      "Desktop GomokuTrainer.exe"
#define ExeWeb          "Web GomokuEngine.exe"
#define ExeOverlay      "Desktop GomokuOverlay.exe"
#define SrcDir          "..\Meter engine-server"
#define SuiteIcon       "icons\Gomoku3in1.ico"

[Setup]
; AppId 固定不变 —— 升级安装/卸载识别同一个应用，勿改（与独立版不同 AppId，两包互不干扰）。
AppId={{9E47B2C1-58A0-4D36-9B7F-2A64C0D15E83}
AppName={#SuiteName}
AppVersion={#SuiteVersion}
AppVerName={#SuiteName} {#SuiteVersion}
AppPublisher={#SuitePublisher}
AppComments=Five-in-a-Row (Gomoku) 3-in-1 suite: Trainer + Web Recognizer + Desktop Recognizer
DefaultDirName={autopf}\{#SuiteName}
DefaultGroupName={#SuiteName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
; ---- 单用户安装（理由见文件头 ③）----
PrivilegesRequired=lowest
; ---- 产物 ----
OutputDir=out
OutputBaseFilename=Meter Gomoku Suite_Setup
SetupIconFile={#SuiteIcon}
UninstallDisplayIcon={app}\{#ExeTrainer}
Compression=lzma2/max
SolidCompression=yes
; ---- 向导外观：现代风格 + 跟随系统深浅色 ----
WizardStyle=modern dynamic
; ---- 中英双语：让用户在安装开始时选择 ----
ShowLanguageDialog=yes
; ---- 系统要求：x64 兼容 + Windows 10 及以上 ----
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; ---- 安装期间若程序正在运行：提示关闭后继续 ----
CloseApplications=yes
RestartApplications=no
; ---- 文件属性 ----
VersionInfoVersion={#SuiteVersion}
VersionInfoProductName={#SuiteName}
VersionInfoProductVersion={#SuiteVersion}
VersionInfoCompany={#SuitePublisher}
VersionInfoDescription={#SuiteName} Setup

[Languages]
; 中文放第一个：中文用户直接回车即可
Name: "zh"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
; ---- 简体中文 ----
zh.SuiteTitle=选择要创建的桌面快捷方式
zh.SuiteDesc=接下来开始复制文件。勾选你想在桌面上创建的快捷方式（三个都已勾上，不想要的取消即可）：%n没勾的不会建到桌面，之后随时可以从开始菜单启动。
zh.SuiteGroup=桌面快捷方式
zh.ScTrainer=五子棋训练器
zh.ScOverlay=桌面识别器
zh.ScWeb=网页识别器
zh.LaunchApp=启动五子棋训练器
zh.WebView2Missing=本软件需要「Microsoft Edge WebView2 运行时」（Windows 10/11 通常已随 Edge 预装）。%n%n点「是」立即打开官方下载页，安装完成后回来继续即可；点「否」先继续安装（安装后仍可手动补装运行时）。%n%n下载页：https://go.microsoft.com/fwlink/p/?LinkId=2124703
; ---- English ----
en.SuiteTitle=Choose desktop shortcuts to create
en.SuiteDesc=Setup is about to copy the files. Tick the desktop shortcuts you want created (all three are ticked; clear the ones you don't want):%nunticked ones are not created on the desktop; you can always launch them from the Start Menu.
en.SuiteGroup=Desktop shortcuts
en.ScTrainer=Gomoku Trainer
en.ScOverlay=Desktop Recognizer
en.ScWeb=Web Recognizer
en.LaunchApp=Launch Gomoku Trainer
en.WebView2Missing=This app requires the Microsoft Edge WebView2 Runtime (normally already present on Windows 10/11 via Edge).%n%nClick Yes to open the official download page now, then continue after installing it; click No to continue the installation anyway (you can install the runtime later).%n%nDownload: https://go.microsoft.com/fwlink/p/?LinkId=2124703

[InstallDelete]
; 升级安装：先清掉旧版本的界面与模型，避免旧 .enc / 旧 rapfi 残留被加载。
Type: filesandordirs; Name: "{app}\calc"
Type: filesandordirs; Name: "{app}\overlay"
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\rapfi-native"

[Files]
; 三个宿主 exe + 识别组件
Source: "{#SrcDir}\{#ExeTrainer}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\{#ExeWeb}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\{#ExeOverlay}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\GomokuVision.exe"; DestDir: "{app}"; Flags: ignoreversion
; 说明文档
Source: "{#SrcDir}\使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\README_zh.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\README_en.md"; DestDir: "{app}"; Flags: ignoreversion
; 加密后的界面（训练器 calc / 覆盖层 overlay；宿主内存解密；磁盘上无明文）
Source: "{#SrcDir}\calc\*.enc"; DestDir: "{app}\calc"; Flags: ignoreversion
Source: "{#SrcDir}\overlay\*.enc"; DestDir: "{app}\overlay"; Flags: ignoreversion
; rapfi 运行时 —— 2026-09-25 起两份并存（原生为主、WASM 兜底）：
;   · **原生主路径**：Web GomokuEngine.exe（engine-server）优先 probe exe 旁 rapfi-native/
;     （RapfiEngine-avx512/avx2.exe + 官方权重 + config.toml，约 41MB；三车道 main/sub/fwd
;     各一个独立进程，线程/哈希按核心数与内存分档）；
;   · **WASM 兜底**：CPU 太旧（无 AVX2）探针失败时回落 resources/rapfi-multi.*（老保险）；
;   · 三件套里训练器的页面内 AI 走 :8964 共享引擎，不本地加载；覆盖层也走 :8964。
Source: "{#SrcDir}\resources\*"; DestDir: "{app}\resources"; Flags: ignoreversion recursesubdirs
Source: "{#SrcDir}\rapfi-native\*"; DestDir: "{app}\rapfi-native"; Flags: ignoreversion recursesubdirs
; ★ 不列 {#SrcDir}\GomokuTrainer resources\ 与 logs\ —— 运行期产物，见文件头 ②。

[Icons]
; 开始菜单：三个程序 + 卸载项（桌面快捷方式在安装结束时按用户勾选创建，见 [Code]）。
; ★ 顺序 = 训练器 → 桌面识别器 → 网页识别器，与勾选页一致。
; ★ 三个快捷方式各自用**对应 exe 内嵌的图标**（IconFilename 指到本 exe，不共用）。
Name: "{group}\{cm:ScTrainer}"; Filename: "{app}\{#ExeTrainer}"; IconFilename: "{app}\{#ExeTrainer}"; IconIndex: 0
Name: "{group}\{cm:ScOverlay}"; Filename: "{app}\{#ExeOverlay}"; IconFilename: "{app}\{#ExeOverlay}"; IconIndex: 0
Name: "{group}\{cm:ScWeb}"; Filename: "{app}\{#ExeWeb}"; IconFilename: "{app}\{#ExeWeb}"; IconIndex: 0
Name: "{group}\{cm:UninstallProgram,{#SuiteName}}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\{#ExeTrainer}"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 卸载前先关掉三个程序与识别组件：运行时 WebView2 / 引擎 / 识别服务持有 {app} 内句柄，
; 不杀进程卸载器删不干净（实测会留下几十 MB 残骸）。
Filename: "{sys}\taskkill.exe"; Parameters: "/IM ""{#ExeTrainer}"" /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "KillTrainer"
Filename: "{sys}\taskkill.exe"; Parameters: "/IM ""{#ExeWeb}"" /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "KillWeb"
Filename: "{sys}\taskkill.exe"; Parameters: "/IM ""{#ExeOverlay}"" /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "KillOverlay"
Filename: "{sys}\taskkill.exe"; Parameters: "/IM ""GomokuVision.exe"" /F"; Flags: runhidden skipifdoesntexist; RunOnceId: "KillVision"

[UninstallDelete]
; 清理运行期产物（这些不在安装清单里，卸载器本来不会碰）
Type: filesandordirs; Name: "{app}\GomokuTrainer resources"
Type: filesandordirs; Name: "{app}\logs"
Type: files; Name: "{app}\GomokuTrainer.log"
Type: files; Name: "{app}\GomokuTrainer.pos"
Type: files; Name: "{app}\GomokuOverlay.log"
; ★ 桌面快捷方式：**在 [Code] 里用 CreateShellLink 建的，不在 [Icons] 清单里** ——
;   卸载器默认不认识它们，会留下指向已删 exe 的死快捷方式（用户报「快捷方式出错」的另一面）。
;   官方文档 CreateShellLink 的 Remarks 也是这么说的：想让它被卸载清掉就写进本段。
;   这里按字面列**中英两套名字**（不写 {cm:}：卸载器界面语言未必等于安装时的语言，
;   单一 {cm:} 只会在一种语言下命中，另一套清不掉）。不存在的文件会被自动忽略。
Type: files; Name: "{autodesktop}\五子棋训练器.lnk"
Type: files; Name: "{autodesktop}\桌面识别器.lnk"
Type: files; Name: "{autodesktop}\网页识别器.lnk"
Type: files; Name: "{autodesktop}\Gomoku Trainer.lnk"
Type: files; Name: "{autodesktop}\Desktop Recognizer.lnk"
Type: files; Name: "{autodesktop}\Web Recognizer.lnk"

[Code]
const
  WebView2ClientKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2DownloadUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

var
  ShortcutPage: TWizardPage;
  ShortcutList: TNewCheckListBox;
  ScPageMade: Boolean;      { 自定义勾选页真的建出来了吗（静默安装可能没有） }

{ ★ 该不该建第 i 个桌面快捷方式？
  ★★ 2026-09-22 实测教训：**静默安装下引用勾选列表会踩空** —— 页没建出来时
  ShortcutList 不可用，结果三个桌面快捷方式一个都没建出来（用户报「快捷方式出错」的真凶）。
  所以这里一律走「页没建出来 → 按默认（三个都建）」，绝不直接碰 ShortcutList。 }
function ScWanted(i: Integer): Boolean;
begin
  if ScPageMade then
    Result := ShortcutList.Checked[i]
  else
    Result := True;
end;

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

{ 复制文件之前检查运行时：缺了就给一个「去下载 / 继续安装」的选择（不阻断安装）。 }
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

{ ★ 让用户勾选保留哪些桌面快捷方式。
  ★ 2026-09-22 用户定：**三个都默认勾上**，且三个都能单独取消。
  顺序固定 = 训练器 / 桌面识别器 / 网页识别器（与 [Icons]、CurStepChanged 的索引一一对应）。
  静默安装不会走这一页 → ScPageMade 保持 False → 默认三个全建（见 ScWanted）。 }
procedure InitializeWizard();
begin
  { ★★ 2026-09-22 晚 修（用户报「选快捷方式时弹小错误」）——两个坑，都别踩回去：
     【坑 1：AfterID 绝不能用 wpInstalling】
       Inno 脚本层对 AfterID **不做任何合法性校验**（ISCmplr.dll 里连 "Invalid AfterID"
       这类字符串都没有，它只是把数字写进向导页链）。所以挂在 wpInstalling 后面不会编译报错，
       而是把这页插到「进度页」与「完成页」之间 —— ① 那时 ssPostInstall 早跑完，用户的勾选
       根本来不及生效（三个 .lnk 必定全建）；② 向导内部按「进度页之后必是完成页」的索引假设
       被打破，页面一旦被交互（点勾选/翻页重绘）就会弹出运行期小错误 —— 用户看到的正是这个。
       正确插入点 = **wpReady**（「准备安装」页，安装开始前最后一页）：
       非静默安装必定显示，勾选在随后的 ssPostInstall 里生效；静默安装跳过该页 → ScPageMade
       保持 False → 走 ScWanted() 的「三个都建」默认。 }
  ShortcutPage := CreateCustomPage(wpReady,
    ExpandConstant('{cm:SuiteTitle}'),
    ExpandConstant('{cm:SuiteDesc}'));
  ShortcutList := TNewCheckListBox.Create(ShortcutPage);
  ShortcutList.Parent := ShortcutPage.Surface;
  ShortcutList.Left := ScaleX(0);
  ShortcutList.Top := ScaleY(4);
  ShortcutList.Width := ShortcutPage.SurfaceWidth;
  ShortcutList.Height := ScaleY(92);
  { ★★ AddCheckBox 的**权威签名**（2026-09-22 从 ISCmplr.dll 字符串表里挖出来的，勿再凭记忆改）：
       function AddCheckBox(const ACaption, ASubItem: String; ALevel: Byte;
         AChecked, AEnabled, AHasInternalChildren, ACheckWhenParentChecked: Boolean;
         AObject: TObject): Integer;
     ▶ 一共 8 个参数，**没有 AChildCount**；第 7 参 ACheckWhenParentChecked 是 **Boolean**。
       曾误以为第 7 参是 Integer 的 AChildCount 而传了 0 → 编译期 "Type mismatch"，
       整包打不出来。官方示例同款写法（Examples\CodeClasses.iss:335）：
         AddCheckBox('TNewCheckListBox', '', 0, True, True, False, True, nil); }
  { 索引 0 = 训练器 }
  ShortcutList.AddCheckBox(ExpandConstant('{cm:ScTrainer}'), '', 0, True, True, False, True, nil);
  { 索引 1 = 桌面识别器 }
  ShortcutList.AddCheckBox(ExpandConstant('{cm:ScOverlay}'), '', 0, True, True, False, True, nil);
  { 索引 2 = 网页识别器 }
  ShortcutList.AddCheckBox(ExpandConstant('{cm:ScWeb}'), '', 0, True, True, False, True, nil);
  ScPageMade := True;                 { ★ 只有到这一步，ShortcutList 才真正可用 }
end;

{ ★ 建第 i 个桌面快捷方式（0=训练器 / 1=桌面识别器 / 2=网页识别器）。
  成功返回「实际写出的 .lnk 全路径」；**失败会抛异常**（由调用方 try/except 接）。
  ★★ 2026-09-22 实测教训（用户报「选快捷方式时弹小错误」的**真凶**）：
     CreateShellLink 的返回值是 **String**（实际文件名），**不是 Boolean**！
     官方文档原文：
       function CreateShellLink(const Filename, Description, ShortcutTo, Parameters,
         WorkingDir, IconFilename: String; const IconIndex, ShowCmd: Integer): String;
       "Returns the resulting filename of the link... **On failure, an exception will be raised.**"
     旧代码写成 `if CreateShellLink(...) then` —— 编译期照样过，运行到这一句抛
       "Runtime error: Type Mismatch"（交互安装 = 那声小报错弹窗），
     异常还会**中断整个 CurStepChanged**：第一个 .lnk 已经落盘，后两个再没跑 ——
     实测正是「桌面只出现 五子棋训练器.lnk，另两个没有，日志里 0 条 ok」。
     ▶ 所以判据绝不是「返回值是否为空」：**返回值是路径 = 成功，异常 = 失败**。
     ★ 图标 = 它自己那个 exe 的内嵌图标（IconFilename 传本 exe 全路径 + IconIndex 0）。 }
function MakeDesktopLink(i: Integer): String;
var
  Name, Exe: String;
begin
  if i = 0 then begin
    Name := ExpandConstant('{cm:ScTrainer}');
    Exe  := ExpandConstant('{app}\{#ExeTrainer}');
  end else if i = 1 then begin
    Name := ExpandConstant('{cm:ScOverlay}');
    Exe  := ExpandConstant('{app}\{#ExeOverlay}');
  end else begin
    Name := ExpandConstant('{cm:ScWeb}');
    Exe  := ExpandConstant('{app}\{#ExeWeb}');
  end;
  Result := CreateShellLink(
    ExpandConstant('{autodesktop}\') + Name + '.lnk',   { Filename —— ★ 必须带 .lnk 扩展名 }
    '',                                                 { Description }
    Exe,                                                { ShortcutTo }
    '',                                                 { Parameters }
    ExpandConstant('{app}'),                            { WorkingDir }
    Exe,                                                { IconFilename = 本 exe，取它自己的图标 }
    0,                                                  { IconIndex }
    SW_SHOWNORMAL);                                     { ShowCmd }
end;

{ 文件复制完（ssPostInstall）→ 按勾选创建桌面快捷方式（没勾的压根不建）。
  ★★ 2026-09-22 实测教训（用户报「图标与快捷方式出错」的另一个真凶）：
     CreateShellLink 的**第一个参数必须带 `.lnk` 扩展名**！不给扩展名它不报错，
     而是直接在桌面生成一个**无扩展名的文件**（`五子棋训练器` 而不是 `五子棋训练器.lnk`）——
     Windows 不把它当快捷方式，图标空白、双击打不开。已收进 MakeDesktopLink 一处。
  ★★ 每个 .lnk 单独 try/except：一个失败绝不能带走后面两个（旧代码就是被异常整体打断的）。
  ★★ 一律走 ScWanted()：静默/无人值守安装没有勾选页，此时按「三个都建」处理。 }
procedure CurStepChanged(CurStep: TSetupStep);
var
  i: Integer;
  Made: String;
begin
  if CurStep <> ssPostInstall then
    Exit;
  for i := 0 to 2 do begin
    if not ScWanted(i) then begin
      Log('desktop shortcut skipped: index ' + IntToStr(i));
      continue;
    end;
    try
      Made := MakeDesktopLink(i);
      Log('desktop shortcut ok: index ' + IntToStr(i) + ' -> ' + Made);
    except
      Log('desktop shortcut FAILED: index ' + IntToStr(i) + ' -> ' + GetExceptionMessage);
    end;
  end;
end;
