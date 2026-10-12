$ErrorActionPreference='Stop'
Add-Type @"
using System;using System.Collections.Generic;using System.Text;using System.Runtime.InteropServices;
public class Win{
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb,IntPtr p);
 public delegate bool EnumWindowsProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out int pid);
 [DllImport("user32.dll")] static extern int GetClassNameW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr z,int x,int y,int cx,int cy,uint f);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e);
 public struct RECT{public int left,top,right,bottom;}
 public static List<string> Wins(int pid){
   var L=new List<string>();
   EnumWindows((h,p)=>{
     int wp; GetWindowThreadProcessId(h,out wp);
     if(wp==pid && IsWindowVisible(h)){
       var cn=new StringBuilder(256); GetClassNameW(h,cn,256);
       var tt=new StringBuilder(256); GetWindowTextW(h,tt,256);
       RECT r; GetWindowRect(h,out r);
       L.Add(h.ToInt64()+"|"+cn.ToString()+"|"+tt.ToString()+"|"+r.left+","+r.top+","+r.right+","+r.bottom);
     }
     return true;
   },IntPtr.Zero);
   return L;
 }
 public static void TopHere(IntPtr h,int x,int y){ SetWindowPos(h,new IntPtr(-1),x,y,0,0,0x1); }
 public static void TopOnly(IntPtr h){ SetWindowPos(h,new IntPtr(-1),0,0,0,0,0x3); }
}
"@
[Win]::SetProcessDPIAware()|Out-Null
$exe="C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Desktop GomokuTrainer.exe"
$proc=Start-Process $exe -PassThru
Start-Sleep 14
$pidv=$proc.Id
function Cap($file){ Add-Type -AssemblyName System.Drawing; $b=New-Object System.Drawing.Bitmap 3072,1920; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0,0,0,0,$b.Size); $b.Save($file,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose }
Write-Output "=== windows before ==="
[Win]::Wins($pidv)|ForEach-Object{ Write-Output $_ }
# 主窗置顶到 0,0（取第一个窗口）
$mainLine=[Win]::Wins($pidv)|Select-Object -First 1
$main=[IntPtr]([long]($mainLine.Split('|')[0]))
[Win]::TopHere($main,0,0)
Start-Sleep 1
Cap "$env:TEMP\f_main.png"
# 点 Link
[Win]::SetCursorPos(946,83)|Out-Null; Start-Sleep -Milliseconds 250
[Win]::mouse_event(2,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 70; [Win]::mouse_event(4,0,0,0,[IntPtr]::Zero)
Start-Sleep 7
Write-Output "=== windows after openLink ==="
[Win]::Wins($pidv)|ForEach-Object{ Write-Output $_ }
# 独立窗 = 不是主窗的那个
$all=[Win]::Wins($pidv)
if($all.Count -ge 2){ $linkLine=$all|Where-Object { $_ -ne $mainLine }|Select-Object -First 1; $link=[IntPtr]([long]($linkLine.Split('|')[0])); [Win]::TopOnly($link); Start-Sleep 1 }
Cap "$env:TEMP\f_link.png"
Write-Output "DONE"
