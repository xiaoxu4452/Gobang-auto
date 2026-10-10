/* Runtime UI-file decryption (in-memory; base64 + rotated XOR; key injected at build time). */


#pragma once
#include <string>
#include <vector>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <iterator>

static const char* GB_UI_KEY = "";

static int gbB64Idx(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}
static bool gbBase64Decode(const std::string& in, std::vector<uint8_t>& out) {
  out.clear();
  int buf = 0, bits = 0;
  for (size_t i = 0; i < in.size(); ++i) {
    char c = in[i];
    if (c == '=' || c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
    int v = gbB64Idx(c);
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

static bool gbDecryptUi(const std::string& b64, uint32_t seed2, int shift, std::vector<uint8_t>& out) {
  std::vector<uint8_t> buf;
  if (!gbBase64Decode(b64, buf)) return false;

  const char* K = GB_UI_KEY;
  uint32_t klen = (uint32_t)strlen(K);
  if (klen != 32) return false;

  int s = shift % 8;
  if (s != 0) {
    int amt = 8 - s;
    for (size_t i = 0; i < buf.size(); ++i)
      buf[i] = (uint8_t)(((buf[i] << amt) | (buf[i] >> (8 - amt))) & 0xff);
  }

  uint32_t s1 = 0x811c9dc5u;                       
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

static bool gbReadEncFile(const std::wstring& wpath, std::vector<uint8_t>& out) {
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
  return gbDecryptUi(b64, seed2, shift, out);
}
