/* ui_crypto.h —— 五子棋练习器 UI 文件运行时解密（与 tools/obfuscator.js 严格互逆）
 *
 * ★ 2026-09-19（用户要求）：「发布包里面的 ui 部分要加密」。
 *   练习器的 UI 原先是**明文**躺在 exe 旁边的 calc/ 里（走 SetVirtualHostNameToFolderMapping），
 *   解包就能读到全部页面源码。现在改为：
 *     构建期 tools/encrypt-calc-ui.js 把 calc.{html,js,css} 加密成 <file>.enc；
 *     运行时本文件在**内存里**解密，由 host.cpp 的 ResHandler 直接当响应体喂给 WebView2
 *     —— 磁盘上全程没有明文。
 *   算法与桌面覆盖层（desktop-overlay/src/ui_crypto.h）**同一套**，只是密钥不同：
 *   两个 exe 各用各的密钥，一个被拆不影响另一个。
 *
 * ⚠️ 密钥是「单一事实来源」：GB_CALC_UI_KEY 必须与 tools/encrypt-calc-ui.js 的 CALC_UI_KEY
 *    逐字符相等（32 字符）。密钥编译进 exe，不写进 .enc（否则等于把钥匙挂在锁上）。
 *    改一边不改另一边 → 页面直接白屏（解密出来是乱码，且不会报错）。
 *
 * 算法（与 obfuscator.js 互逆）：
 *   密文 = base64( 循环左移shift( 双层异或( 明文UTF8 ) ) )
 *   双层异或：第 i 字节 ^= K[i%32] ^ mix；mix 由两种子流按奇偶交错提供
 *             i 偶 → seed1 流（seed1 = FNV-1a(K)），i 奇 → seed2 流（seed2 随密文存）
 *             LCG: s = (s*1103515245 + 12345) mod 2^32，取高 8 位
 *   解密 = 逆序：base64 解码 → 循环右移 shift → 双层异或（异或自逆）→ UTF8 明文
 */
#pragma once
#include <string>
#include <vector>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <iterator>

// ★ 必须与 tools/encrypt-calc-ui.js 的 CALC_UI_KEY 完全一致（32 字符）★
static const char* GB_CALC_UI_KEY = "GbClcUiK3y2026xQz9Wm8Pd5Rt2YvN7s";

// ---- base64 解码（标准，兼容 Node Buffer base64 的填充）----
static int gbCalcB64Idx(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c == '0' || (c >= '1' && c <= '9')) return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}
static bool gbCalcBase64Decode(const std::string& in, std::vector<uint8_t>& out) {
  out.clear();
  int buf = 0, bits = 0;
  for (size_t i = 0; i < in.size(); ++i) {
    char c = in[i];
    if (c == '=' || c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
    int v = gbCalcB64Idx(c);
    if (v < 0) return false;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back((uint8_t)((buf >> bits) & 0xff));
    }
  }
  return true;
}

// ---- 解密单个 payload：b64 文本 + seed2 + shift → 明文字节 ----
static bool gbCalcDecrypt(const std::string& b64, uint32_t seed2, int shift, std::vector<uint8_t>& out) {
  std::vector<uint8_t> buf;
  if (!gbCalcBase64Decode(b64, buf)) return false;

  const char* K = GB_CALC_UI_KEY;
  uint32_t klen = (uint32_t)strlen(K);
  if (klen != 32) return false;                 // 密钥长度不对 → 宁可白屏也不解出乱码

  // 逆「字符位移」：加密是循环左移 shift，解密 = 循环右移 shift = 循环左移 (8-shift)
  int s = shift % 8;
  if (s != 0) {
    int amt = 8 - s;
    for (size_t i = 0; i < buf.size(); ++i)
      buf[i] = (uint8_t)(((buf[i] << amt) | (buf[i] >> (8 - amt))) & 0xff);
  }

  // 逆「双层异或」：异或自逆，LCG 种子流按相同奇偶顺序推进即可还原
  uint32_t s1 = 0x811c9dc5u;                       // FNV-1a 偏移基
  for (uint32_t i = 0; K[i]; ++i) {
    s1 ^= (uint8_t)K[i];
    s1 = (uint32_t)((uint64_t)s1 * 0x01000193u) & 0xffffffffu;
  }
  uint32_t s2 = seed2;
  for (size_t i = 0; i < buf.size(); ++i) {
    uint8_t mix;
    if ((i & 1) == 0) {
      s1 = (uint32_t)((uint64_t)s1 * 1103515245u + 12345u) & 0xffffffffu;
      mix = (uint8_t)(s1 >> 24);
    } else {
      s2 = (uint32_t)((uint64_t)s2 * 1103515245u + 12345u) & 0xffffffffu;
      mix = (uint8_t)(s2 >> 24);
    }
    buf[i] = (uint8_t)((buf[i] ^ (uint8_t)K[i % klen] ^ mix) & 0xff);
  }

  out = std::move(buf);
  return true;
}

// ---- 读取 .enc 文件（格式：首行 GBUIENC1，随后 SEED2= / SHIFT= / B64=）并解密 ----
// ⚠️ "SEED2=" / "SHIFT=" 都是 **6** 个字符（含等号），取值下标也必须是 6。
//    覆盖层那一版早先写成 7：拿 7 字符去比 6 字符的串，长度不等 → 永不相等，
//    seed2/shift 一直是 0，解出来全是乱码（页面一片空白，且不报任何错）。
static bool gbCalcReadEncFile(const std::wstring& wpath, std::vector<uint8_t>& out) {
  std::ifstream f(wpath, std::ios::binary);
  if (!f) return false;
  std::string all((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  uint32_t seed2 = 0;
  int shift = 0;
  std::string b64;
  std::istringstream iss(all);
  std::string line;
  while (std::getline(iss, line)) {
    if (line.compare(0, 6, "SEED2=") == 0) seed2 = (uint32_t)std::strtoul(line.c_str() + 6, nullptr, 10);
    else if (line.compare(0, 6, "SHIFT=") == 0) shift = (int)std::strtol(line.c_str() + 6, nullptr, 10);
    else if (line.compare(0, 4, "B64=") == 0) b64 = line.substr(4);
  }
  if (b64.empty()) return false;
  return gbCalcDecrypt(b64, seed2, shift, out);
}
