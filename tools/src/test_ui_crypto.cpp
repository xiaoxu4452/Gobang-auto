// test_ui_crypto.cpp —— 校验「Node 加密」与「C++ 解密」逐字节互逆。
//
// 为什么值得一个独立测试：面板能不能起来，取决于 ui_crypto.h 与 obfuscator.js 两侧算法
// 是否严格互逆（密钥、LCG 种子、奇偶交错、位移方向，任何一处差一点就解出乱码）。
// 而这种错误**不会报错** —— exe 编译得过、WebView2 也照常加载，只是拿到一堆乱码，
// 表现就是「面板一片空白」。所以必须在构建期就比对出结果。
//
// 用法：test_ui_crypto.exe <ui 目录>
//   对目录里每个 <file>.enc 解密，与同名明文逐字节比对；全部一致返回 0。
#include <windows.h>
#include <stdio.h>
#include <string>
#include <vector>
#include "ui_crypto.h"

static bool ReadFileBytes(const std::wstring& p, std::vector<uint8_t>& out) {
  FILE* f = _wfopen(p.c_str(), L"rb");
  if (!f) return false;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  out.resize((size_t)n);
  size_t got = n > 0 ? fread(&out[0], 1, (size_t)n, f) : 0;
  fclose(f);
  out.resize(got);
  return true;
}

int wmain(int argc, wchar_t** argv) {
  std::wstring dir = (argc > 1) ? argv[1] : L".";
  std::wstring mask = dir + L"\\*.enc";
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(mask.c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) {
    wprintf(L"test_ui_crypto: no .enc found in %s\n", dir.c_str());
    return 1;
  }
  int total = 0, bad = 0;
  do {
    std::wstring encPath = dir + L"\\" + fd.cFileName;
    std::wstring name(fd.cFileName);
    std::wstring plainName = name.substr(0, name.size() - 4);   // 去掉 ".enc"
    std::wstring plainPath = dir + L"\\" + plainName;
    std::vector<uint8_t> dec, ref;
    bool okDec = gbReadEncFile(encPath, dec);
    bool okRef = ReadFileBytes(plainPath, ref);
    total++;
    if (!okDec) { wprintf(L"  FAIL %-20s decrypt failed\n", name.c_str()); bad++; continue; }
    if (!okRef) { wprintf(L"  skip %-20s (no plaintext side by side)\n", name.c_str()); continue; }
    if (dec.size() != ref.size() || memcmp(dec.data(), ref.data(), dec.size()) != 0) {
      wprintf(L"  FAIL %-20s mismatch (%zu vs %zu bytes)\n", name.c_str(), dec.size(), ref.size());
      bad++;
    } else {
      wprintf(L"  ok   %-20s %zu bytes\n", name.c_str(), dec.size());
    }
  } while (FindNextFileW(h, &fd));
  FindClose(h);
  wprintf(L"test_ui_crypto: %d files, %d failed\n", total, bad);
  return bad ? 1 : 0;
}
