const fs=require('fs'),path=require('path');
const R=path.join(__dirname,'..');
function rd(p){try{return fs.readFileSync(p,'utf8')}catch(e){return null}}
const out=[];
function scan(name,rel,needles){
  const s=rd(path.join(R,rel));
  out.push('=== '+name+' ('+rel+') '+(s?s.length+' chars':'MISSING')+' ===');
  if(!s) return;
  for(const n of needles){
    const i=s.indexOf(n);
    let line=0;
    if(i>=0){line=s.slice(0,i).split('\n').length;}
    out.push('  '+(i>=0?'YES':' no')+'  L'+line+'  '+JSON.stringify(n));
  }
}
scan('vision main.cpp','desktop-vision/src/main.cpp',[
 'SetProcessDpiAwareness','DpiAwareness','SetProcessDPIAware','wWinMain','int main']);
scan('vision gbscreen.cpp','desktop-vision/src/gbscreen.cpp',[
 'BitBlt','PrintWindow','CAPTUREBLT','CreateCompatibleDC','GetDC(NULL)','SetProcessDpiAwareness',
 'EnumDisplayMonitors','GetSystemMetrics','SM_CXVIRTUALSCREEN']);
scan('vision gbhttp.cpp','desktop-vision/src/gbhttp.cpp',['listen','WSAStartup','8971','8970','inet_pton']);
scan('overlay host.cpp','desktop-overlay/src/host.cpp',[
 'CreateCoreWebView2Environment','WebView2Loader','GetAvailableCoreWebView2BrowserVersionString',
 'DPI_AWARENESS','SetProcessDpiAwarenessContext','SetProcessDPIAware','MessageBoxW','WDA_EXCLUDEFROMCAPTURE',
 'RefreshPanelHitSurface','ApplyPanelRect','WM_SIZING','WS_THICKFRAME','GetSaveFileNameW',
 'Gdiplus::Image','CLSIDFromString','FindEngineExe','EnsureScanServer']);
scan('vision gb.cpp','desktop-vision/src/gb.cpp',['DPI','main','argc']);
out.push('=== dirs ===');
for(const d of ['desktop-vision/build','Desktop version','Meter GomokuTrainer','Meter engine-server']){
  const p=path.join(R,d);
  try{out.push('  '+d+': '+fs.readdirSync(p).filter(f=>/\.(exe|dll)$/i.test(f)).join(', '))}catch(e){out.push('  '+d+': -')}
}
fs.writeFileSync(path.join(R,'tools','_audit_c.txt'),out.join('\n'),'utf8');
console.log('ok');
