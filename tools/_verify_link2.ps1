$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;using System.Collections.Generic;using System.Text;using System.Runtime.InteropServices;
public class Win2{
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb,IntPtr p);
 public delegate bool EnumWindowsProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out int pid);
 [DllImport("user32.dll")] static extern int GetClassNameW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr z,int x,int y,int cx,int cy,uint f);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
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
 public static void RestoreTop(IntPtr h,int x,int y){ ShowWindow(h,9); SetWindowPos(h,new IntPtr(-1),x,y,0,0,0x41); }
 public static void TopOnly(IntPtr h){ ShowWindow(h,9); SetWindowPos(h,new IntPtr(-1),0,0,0,0,0x43); }
}
"@
[Win2]::SetProcessDPIAware()|Out-Null
$exe="C:\Users\harve\Desktop\Gobang auto\Meter Gomoku\Desktop GomokuTrainer.exe"
$proc=Start-Process $exe -PassThru
Start-Sleep 14
$pidv=$proc.Id
function Cap($file){ $b=New-Object System.Drawing.Bitmap 3072,1920; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0,0,0,0,$b.Size); $b.Save($file,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose }
$mainLine=[Win2]::Wins($pidv)|Select-Object -First 1
$main=[IntPtr]([long]($mainLine.Split('|')[0]))
[Win2]::RestoreTop($main,0,0)
Start-Sleep 1
$nowLine=[Win2]::Wins($pidv)|Where-Object{ $_.StartsWith($mainLine.Split('|')[0]+'|') }
Write-Output "MAIN NOW: $nowLine"
Cap "$env:TEMP\g_main.png"
[Win2]::SetCursorPos(946,83)|Out-Null; Start-Sleep -Milliseconds 300
[Win2]::mouse_event(2,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 80; [Win2]::mouse_event(4,0,0,0,[IntPtr]::Zero)
Start-Sleep 8
Write-Output "=== after openLink ==="
[Win2]::Wins($pidv)|ForEach-Object{ Write-Output $_ }
$all=[Win2]::Wins($pidv)
$mainId=$mainLine.Split('|')[0]
if($all.Count -ge 2){ $linkLine=$all|Where-Object{ -not $_.StartsWith($mainId+'|') }|Select-Object -First 1; $link=[IntPtr]([long]($linkLine.Split('|')[0])); [Win2]::TopOnly($link); Start-Sleep 1 }
Cap "$env:TEMP\g_link.png"
Write-Output "DONE"
