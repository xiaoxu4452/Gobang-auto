# Line-based patch of RunVisionForVis in host.cpp.
$p = "C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"
$lines = [IO.File]::ReadAllLines($p)
$joined = [string]::Join("`n", $lines)
if ($joined.Contains("visUseTest")) { Write-Output "already patched"; exit 0 }

# Locate the anchor lines: the unique boardSize line, then the next
# "std::wstring exe = FindVisionExe();" after it.
$startIdx = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match 'int boardSize = JsonIntAfter') { $startIdx = $i - 1; break }
}
if ($startIdx -lt 0) { Write-Output "ERROR: boardSize line not found"; exit 1 }

$endIdx = -1
for ($i = $startIdx + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match 'std::wstring exe = FindVisionExe\(\);') { $endIdx = $i; break }
}
if ($endIdx -lt 0) { Write-Output "ERROR: FindVisionExe line not found"; exit 1 }

$newBlock = @'
  // Modular test model: when a Vision-test folder ships with the app, the
  // Vision capture window runs the one-shot Zhizi test recognizer; the shared
  // formal service (used by board-linking) is never touched. Deleting the
  // Vision-test folder restores the formal model for the capture window too.
  std::wstring testExe = Join(Join(ExeDir(), L"Vision-test"), L"GomokuVision.exe");
  bool visUseTest = FileExists(testExe);
  {
    int boardSize = JsonIntAfter(req, "\"size\":");
    if (boardSize < 9 || boardSize > 25) boardSize = 15;   
    std::string http;
    bool ok = false;
    if (!visUseTest) {
      if (mode == "scan")
        ok = VisionScanImage(bytes.data(), (int)bytes.size(), http);
      else
        ok = VisionRecognize(bytes.data(), (int)bytes.size(), boardSize, skipSnap, http);
      if (ok) {
        LogMsg("[vis] recognize ok (" + std::to_string(http.size()) +
               " bytes, mode=" + mode + ")");
        PostToVisPageSoon("{\"type\":\"visResult\",\"mode\":\"" + mode +
                          (seq.empty() ? "" : "\",\"seq\":" + seq) +
                          "\",\"result\":" + http + "}");
        return;
      }
      LogMsg("[vis] http path unavailable -> spawn fallback (mode=" + mode + ")");
    } else {
      LogMsg("[vis] test model (Vision-test) -> one-shot CLI recognizer (mode=" + mode + ")");
    }
  }

  std::wstring exe = visUseTest ? testExe : FindVisionExe();
'@

$out = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $startIdx; $i++) { $out.Add($lines[$i]) }
foreach ($l in ($newBlock -split "`n")) { $out.Add($l) }
for ($i = $endIdx + 1; $i -lt $lines.Count; $i++) { $out.Add($lines[$i]) }

[IO.File]::WriteAllLines($p, $out, (New-Object Text.UTF8Encoding $false))
Write-Output "patched OK (lines $($startIdx+1)..$($endIdx+1))"
