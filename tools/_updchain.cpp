// _updchain.cpp — 诊断工具：原样复刻 host.cpp 的 HttpFetch2/cookie 罐/acw 求解/8 步下载链，
// 逐步打日志，定位「应用内下载失败」卡在哪一步。与 host.cpp 的差异**只允许**是日志。
// cl /std:c++17 /utf-8 /EHsc _updchain.cpp link winhttp.lib shell32.lib user32.lib
#include <windows.h>
#include <winhttp.h>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>
#include <fstream>
#include <cctype>
#include <algorithm>

#pragma comment(lib, "winhttp.lib")

static void LOG(const std::string& s) { printf("[chain] %s\n", s.c_str()); fflush(stdout); }

static std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
  return w;
}
static std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

// ── cookie 罐（★ 仿浏览器：按域存储与发送） ──
struct Ck { std::string dom; std::string name; std::string val; };
static std::vector<Ck> g_updCookies;
static void UpdSetCookie(const std::string& host, const std::string& name, const std::string& val) {
  for (auto& kv : g_updCookies)
    if (kv.dom == host && kv.name == name) { kv.val = val; return; }
  g_updCookies.push_back({host, name, val});
}
static std::string UpdCookieHeader(const std::string& host) {
  std::string h;
  for (auto& c : g_updCookies) {
    if (host.size() < c.dom.size()) continue;
    std::string tail = host.substr(host.size() - c.dom.size());
    if (tail != c.dom && (tail.size() < c.dom.size() + 1 || tail[tail.size() - c.dom.size() - 1] != '.')) continue;
    if (!h.empty()) h += "; ";
    h += c.name + "=" + c.val;
  }
  return h;
}
static void UpdSaveCookies(HINTERNET hR, const std::string& host) {
  // ★ 用 RAW_HEADERS_CRLF 自己解析全部 Set-Cookie（WINHTTP_QUERY_SET_COOKIE 按 index
  //   枚举实测会漏头，同一响应的 cdn_sec_tc 就这么丢的 → SignError）。
  DWORD n = 0;
  if (!WinHttpQueryHeaders(hR, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
                           WINHTTP_NO_OUTPUT_BUFFER, &n, WINHTTP_NO_HEADER_INDEX) &&
      GetLastError() != ERROR_INSUFFICIENT_BUFFER)
    return;
  std::wstring buf(n, L'\0');
  if (!WinHttpQueryHeaders(hR, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
                           (LPVOID)buf.data(), &n, WINHTTP_NO_HEADER_INDEX))
    return;
  std::string raw = WideToUtf8(buf.c_str());
  size_t pos = 0;
  while ((pos = raw.find("Set-Cookie:", pos)) != std::string::npos) {
    pos += 11;
    while (pos < raw.size() && (raw[pos] == ' ' || raw[pos] == '\t')) pos++;
    size_t eol = raw.find("\r\n", pos);
    if (eol == std::string::npos) eol = raw.size();
    std::string one = raw.substr(pos, eol - pos);
    size_t eq = one.find('=');
    if (eq != std::string::npos && eq > 0) {
      std::string val = one.substr(eq + 1);
      size_t sc = val.find(';');
      if (sc != std::string::npos) val = val.substr(0, sc);
      UpdSetCookie(host, one.substr(0, eq), val);
    }
    pos = eol;
  }
}

static std::string QuotedAfter(const std::string& s, const std::string& key) {
  size_t p = s.find(key);
  if (p == std::string::npos) return "";
  p += key.size();
  if (p >= s.size()) return "";
  char q = s[p];
  if (q == '\'' || q == '"') {
    size_t e = s.find(q, p + 1);
    return (e == std::string::npos) ? "" : s.substr(p + 1, e - p - 1);
  }
  size_t e = p;
  while (e < s.size()) {
    char c = s[e];
    if (c == '\'' || c == '"' || c == ',' || c == '}' || c == ']' || c == ';' ||
        c == ' ' || c == '\t' || c == '\n' || c == '\r') break;
    e++;
  }
  return s.substr(p, e - p);
}
static std::string JsVarStr(const std::string& s, const std::string& var) {
  size_t p = s.find(var);
  if (p == std::string::npos) return "";
  size_t q = s.find('\'', p);
  if (q == std::string::npos) return "";
  size_t e = s.find('\'', q + 1);
  if (e == std::string::npos) return "";
  return s.substr(q + 1, e - q - 1);
}
static void ExtractTk(const std::string& s, std::string& t, std::string& k) {
  t.clear(); k.clear();
  size_t p = 0;
  std::vector<std::string> vals;
  while ((p = s.find("var ", p)) != std::string::npos) {
    p += 4;
    while (p < s.size() && (s[p] == ' ' || s[p] == '\t')) p++;
    while (p < s.size() && (isalnum((unsigned char)s[p]) || s[p] == '_')) p++;
    while (p < s.size() && s[p] == ' ') p++;
    if (p >= s.size() || s[p] != '=') continue;
    p++;
    while (p < s.size() && s[p] == ' ') p++;
    if (p >= s.size() || s[p] != '\'') continue;
    p++;
    size_t vs = p;
    while (p < s.size() && ((s[p] >= '0' && s[p] <= '9') ||
                            (s[p] >= 'a' && s[p] <= 'f') || (s[p] >= 'A' && s[p] <= 'F'))) p++;
    if (p > vs) vals.push_back(s.substr(vs, p - vs));
  }
  if (vals.size() >= 1) t = vals[0];
  if (vals.size() >= 2) k = vals[1];
}
static std::string DigitsAfter(const std::string& s, const std::string& key) {
  size_t p = s.find(key);
  if (p == std::string::npos) return "";
  p += key.size();
  size_t e = p;
  while (e < s.size() && isdigit((unsigned char)s[e])) e++;
  return s.substr(p, e - p);
}
static std::string FirstVersion(const std::string& s) {
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] < '0' || s[i] > '9') continue;
    bool boundary = (i == 0) || !(s[i - 1] >= '0' && s[i - 1] <= '9') && s[i - 1] != '.';
    if (!boundary) continue;
    size_t j = i;
    while (j < s.size() && s[j] >= '0' && s[j] <= '9') j++;
    if (j < s.size() && s[j] == '.') {
      size_t k = j + 1;
      while (k < s.size() && s[k] >= '0' && s[k] <= '9') k++;
      if (k > j + 1) {
        size_t end = k;
        if (k < s.size() && s[k] == '.') {
          size_t m = k + 1;
          while (m < s.size() && s[m] >= '0' && s[m] <= '9') m++;
          if (m > k + 1) end = m;
        }
        return s.substr(i, end - i);
      }
    }
  }
  return "";
}
static std::string JsonUnslash(const std::string& s) {
  std::string o;
  o.reserve(s.size());
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '\\' && i + 1 < s.size() &&
        (s[i + 1] == '/' || s[i + 1] == '\\' || s[i + 1] == '"' || s[i + 1] == '\'')) {
      o += s[i + 1];
      i++;
    } else {
      o += s[i];
    }
  }
  return o;
}
static std::string UrlEnc(const std::string& s) {
  static const char* hex = "0123456789ABCDEF";
  std::string o;
  for (unsigned char c : s) {
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      o += (char)c;
    } else {
      o += '%';
      o += hex[c >> 4];
      o += hex[c & 15];
    }
  }
  return o;
}
static std::string SolveAcwScV2(const std::string& arg1) {
  static const int kPos[40] = {15,35,29,24,33,16,1,38,10,9,19,31,40,27,22,23,25,13,6,11,39,18,20,8,
                               14,21,32,26,2,30,7,4,17,5,3,28,34,37,12,36};
  static const char* kMask = "3000176000856006061501533003690027800375";
  if (arg1.size() != 40) return "";
  auto hexv = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return 0;
  };
  std::string u(40, '0');
  for (int z = 0; z < 40; z++) u[z] = arg1[kPos[z] - 1];
  std::string out;
  char b[4];
  for (int i = 0; i < 40; i += 2) {
    int a = hexv(u[i]) * 16 + hexv(u[i + 1]);
    int m = hexv(kMask[i]) * 16 + hexv(kMask[i + 1]);
    snprintf(b, sizeof(b), "%02x", a ^ m);
    out += b;
  }
  return out;
}

// ★ 唯一差异点：extraHdrs 参数（诊断时试不同请求头），host.cpp 里没有 —— 对齐后去掉。
static int HttpFetch2(const std::wstring& host, const std::wstring& path,
                      const std::wstring& method, const std::string& postBody,
                      const std::wstring& referer, std::string& out,
                      const char* extraHdrs = nullptr,
                      FILE* saveTo = nullptr,
                      void (*progress)(long long, long long) = nullptr) {
  out.clear();
  HINTERNET hS = WinHttpOpen(L"gbcalc-update", WINHTTP_ACCESS_TYPE_NO_PROXY,
                             WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!hS) return 0;
  WinHttpSetTimeouts(hS, 10000, 10000, 10000, 60000);
  int status = 0;
  HINTERNET hC = WinHttpConnect(hS, host.c_str(), INTERNET_DEFAULT_HTTPS_PORT, 0);
  if (hC) {
    HINTERNET hR = WinHttpOpenRequest(hC, method.c_str(), path.c_str(), nullptr,
                                      WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                      WINHTTP_FLAG_SECURE);
    if (hR) {
      DWORD decomp = WINHTTP_DECOMPRESSION_FLAG_GZIP | WINHTTP_DECOMPRESSION_FLAG_DEFLATE;
      WinHttpSetOption(hR, WINHTTP_OPTION_DECOMPRESSION, &decomp, sizeof(decomp));
      std::wstring hdrs =
          L"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          L"(KHTML, like Gecko) Chrome/120.0 Safari/537.36\r\n";
      if (!referer.empty()) hdrs += L"Referer: " + referer + L"\r\n";
      std::string ck = UpdCookieHeader(WideToUtf8(host));
      if (!ck.empty()) hdrs += L"Cookie: " + Utf8ToWide(ck) + L"\r\n";
      if (!postBody.empty()) hdrs += L"Content-Type: application/x-www-form-urlencoded\r\n";
      if (extraHdrs) hdrs += Utf8ToWide(extraHdrs);
      const void* bodyPtr = postBody.empty() ? WINHTTP_NO_REQUEST_DATA : (const void*)postBody.c_str();
      DWORD bodyLen = (DWORD)postBody.size();
      if (WinHttpSendRequest(hR, hdrs.c_str(), (DWORD)hdrs.size(), (void*)bodyPtr, bodyLen, bodyLen, 0) &&
          WinHttpReceiveResponse(hR, nullptr)) {
        DWORD st = 0, sz = sizeof(st);
        WinHttpQueryHeaders(hR, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &st, &sz, WINHTTP_NO_HEADER_INDEX);
        status = (int)st;
        UpdSaveCookies(hR, WideToUtf8(host));
        DWORD avail = 0;
        char buf[65536];
        while (WinHttpQueryDataAvailable(hR, &avail) && avail > 0) {
          DWORD rd = 0;
          if (!WinHttpReadData(hR, buf, (avail < sizeof(buf) ? avail : (DWORD)sizeof(buf)), &rd) || rd == 0)
            break;
          if (saveTo) fwrite(buf, 1, rd, saveTo);
          else out.append(buf, rd);
        }
      } else {
        LOG("  !! send/recv failed err=" + std::to_string(GetLastError()));
      }
      WinHttpCloseHandle(hR);
    }
    WinHttpCloseHandle(hC);
  }
  WinHttpCloseHandle(hS);
  return status;
}

int main(int argc, char** argv) {
  const std::string SHARE_URL = "https://wwbbj.lanzout.com/b016l49aqj";
  const std::string PWD = "15";
  const std::wstring WSHARE = Utf8ToWide(SHARE_URL);
  bool saveExe = argc > 1;                       // 传输出路径才真下载（默认只验证到直链）
  const char* xrw = argc > 2 && !strcmp(argv[2], "xrw")
                        ? "X-Requested-With: XMLHttpRequest\r\n" : nullptr;

  LOG("① 分享页");
  std::string share;
  int st1 = HttpFetch2(L"wwbbj.lanzout.com", L"/b016l49aqj", L"GET", "", L"", share);
  LOG("  status=" + std::to_string(st1) + " bytes=" + std::to_string(share.size()));
  if (st1 != 200 || share.empty()) { LOG("FAIL step1"); return 1; }

  LOG("② filemoreajax (pwd=15)");
  std::string file = DigitsAfter(share, "filemoreajax.php?file=");
  if (file.empty()) file = DigitsAfter(share, "/q/jb/?f=");
  std::string uid  = QuotedAfter(share, "uid':'");
  if (uid.empty()) uid = QuotedAfter(share, "uid\":\"");
  std::string puid = QuotedAfter(share, "puid':'");
  std::string t, kk;
  ExtractTk(share, t, kk);
  LOG("  file=" + file + " uid=" + uid + " puid=" + puid + " t=" + t + " k=" + kk.substr(0, 8) + "…");
  if (file.empty() || puid.empty() || t.empty() || kk.empty()) { LOG("FAIL step2 parse"); return 1; }
  std::string body = "lx=2&fid=" + file + "&uid=" + UrlEnc(uid) + "&puid=" + UrlEnc(puid) +
                     "&pg=1&rep=0&t=" + UrlEnc(t) + "&k=" + UrlEnc(kk) +
                     "&up=1&ls=1&pwd=" + UrlEnc(PWD);
  std::string resp;
  int st2 = HttpFetch2(L"wwbbj.lanzout.com", L"/filemoreajax.php?file=" + Utf8ToWide(file),
                       L"POST", body, WSHARE, resp, xrw);
  LOG("  status=" + std::to_string(st2) + " zt1=" +
      std::to_string(resp.find("\"zt\":1") != std::string::npos || resp.find("\"zt\":\"1\"") != std::string::npos));
  if (st2 != 200 || (resp.find("\"zt\":1") == std::string::npos && resp.find("\"zt\":\"1\"") == std::string::npos)) {
    LOG("FAIL step2: " + resp.substr(0, 200)); return 1;
  }
  std::string bestName, bestId, bestVer; float bestNum = -1;
  { size_t p = 0;
    while ((p = resp.find("\"name_all\":\"", p)) != std::string::npos) {
      p += 12; size_t e = resp.find('"', p); if (e == std::string::npos) break;
      std::string nm = resp.substr(p, e - p);
      std::string v = FirstVersion(nm); float n = -1;
      try { n = std::stof(v); } catch (...) {}
      if (!v.empty() && n > bestNum) { bestNum = n; bestName = nm; bestVer = v; }
      p = e + 1;
    }
    size_t np = resp.find("\"name_all\":\"" + bestName);
    size_t ip = resp.find("\"id\":\"", np);
    ip += 6; size_t ie = resp.find('"', ip);
    bestId = resp.substr(ip, ie - ip);
  }
  LOG("  best=" + bestName + " v" + bestVer + " id=" + bestId);
  std::wstring fpath = L"/" + Utf8ToWide(bestId);

  LOG("③ 文件页 ?webpage=");
  std::string fpage;
  int st3 = HttpFetch2(L"wwbbj.lanzout.com", fpath, L"GET", "", WSHARE, fpage);
  LOG("  status=" + std::to_string(st3) + " bytes=" + std::to_string(fpage.size()));
  std::string fnTok = QuotedAfter(fpage, "src=\"/fn?");
  if (fnTok.empty()) fnTok = QuotedAfter(fpage, "src='/fn?");
  if (st3 != 200 || fnTok.empty()) {
    LOG("FAIL step3 (fnTok empty)"); 
    std::ofstream("tools/_chain_fpage.html") << fpage;
    return 1;
  }
  LOG("  fnTok ok");

  LOG("④ /fn? 页");
  std::string fnHtml;
  int st4 = HttpFetch2(L"wwbbj.lanzout.com", L"/fn?" + Utf8ToWide(fnTok), L"GET", "", WSHARE + fpath, fnHtml);
  std::string wpSign   = JsVarStr(fnHtml, "wp_sign");
  std::string ajaxData = JsVarStr(fnHtml, "ajaxdata");
  std::string fid      = DigitsAfter(fnHtml, "ajaxfile.php?file=");
  LOG("  status=" + std::to_string(st4) + " wpSign=" + std::to_string(wpSign.size()) + "B ajaxData=" +
      std::to_string(ajaxData.size()) + "B fid=" + fid);
  if (st4 != 200 || wpSign.empty() || ajaxData.empty() || fid.empty()) {
    LOG("FAIL step4");
    std::ofstream("tools/_chain_fn.html") << fnHtml;
    return 1;
  }

  LOG("⑤ ajaxfile.php websign=2");
  std::string body5 = "action=downprocess&websignkey=" + UrlEnc(ajaxData) + "&signs=" + UrlEnc(ajaxData) +
                      "&sign=" + UrlEnc(wpSign) + "&websign=2&kd=1&ves=1";
  std::string resp5;
  std::wstring ref5 = WSHARE + L"/fn?" + Utf8ToWide(fnTok);   // ★ 与 curl 一致：Referer = /fn 页
  int st5 = HttpFetch2(L"apifile.woozooo.com", L"/ajaxfile.php?file=" + Utf8ToWide(fid),
                       L"POST", body5, ref5, resp5, xrw);
  bool zt5 = resp5.find("\"zt\":1") != std::string::npos || resp5.find("\"zt\":\"1\"") != std::string::npos;
  LOG("  status=" + std::to_string(st5) + " zt1=" + std::to_string(zt5) + " resp=" + resp5.substr(0, 120));
  if (st5 != 200 || !zt5) { LOG("FAIL step5"); return 1; }
  std::string dom = JsonUnslash(QuotedAfter(resp5, "\"dom\":\""));
  std::string url = JsonUnslash(QuotedAfter(resp5, "\"url\":\""));
  if (dom.empty() || url.empty() || url == "0") { LOG("FAIL step5 link"); return 1; }
  std::string link = dom + "/file/" + url;
  std::string host6 = dom.substr(dom.find("://") + 3);
  LOG("  link=" + link.substr(0, 80));

  LOG("⑥ 下载页（acw 挑战）");
  std::string page6;
  int st6 = HttpFetch2(Utf8ToWide(host6), L"/file/" + Utf8ToWide(url), L"GET", "", WSHARE, page6);
  LOG("  status=" + std::to_string(st6) + " bytes=" + std::to_string(page6.size()) +
      " arg1?" + std::to_string(page6.find("arg1='") != std::string::npos));
  std::string arg1 = QuotedAfter(page6, "arg1='");
  if (!arg1.empty()) {
    std::string v = SolveAcwScV2(arg1);
    LOG("  acw solved=" + v);
    if (v.empty()) { LOG("FAIL acw solve"); return 1; }
    UpdSetCookie(host6, "acw_sc__v2", v);
    // ★ 仿 curl：过acw后先把 $LINK 完整 GET 两遍（丢弃），第三遍才是取 token 的验证页
    std::string warm;
    int wa = HttpFetch2(Utf8ToWide(host6), L"/file/" + Utf8ToWide(url), L"GET", "", WSHARE, warm);
    int wb = HttpFetch2(Utf8ToWide(host6), L"/file/" + Utf8ToWide(url), L"GET", "", WSHARE, warm);
    LOG("  warm GETs: " + std::to_string(wa) + " " + std::to_string(wb) +
        " (arg1 again? " + std::to_string(warm.find("arg1='") != std::string::npos) + ")");
    page6 = warm;
  }
  std::string fTok  = QuotedAfter(page6, "'file':'");
  std::string fSign = QuotedAfter(page6, "'sign':'");
  LOG("  fileTok=" + std::to_string(fTok.size()) + "B sign=" + std::to_string(fSign.size()) + "B");
  {   // ★ 诊断：cookie 罐快照
    std::string snap;
    for (auto& c : g_updCookies) snap += c.name + "@" + c.dom + " ";
    LOG("  JAR: " + snap);
  }
  if (fTok.empty() || fSign.empty()) {
    LOG("FAIL step6 verify page parse");
    std::ofstream("tools/_chain_verify.html") << page6;
    return 1;
  }
  {   // ★ 诊断：永远 dump 验证页 + token，供与 curl 对照
    std::ofstream("_chain_verify.html") << page6;
    LOG("  fTok[0..72]=" + fTok.substr(0, 72));
    LOG("  fSign=" + fSign);
  }

  LOG("⑦ /file/ajax.php：先 el=1 再 el=2（仿页面点击序列）");
  std::string body7a = "file=" + UrlEnc(fTok) + "&el=1&sign=" + UrlEnc(fSign);
  std::string resp7a;
  int st7a = HttpFetch2(Utf8ToWide(host6), L"/file/ajax.php", L"POST", body7a, Utf8ToWide(link), resp7a, xrw);
  LOG("  el=1 status=" + std::to_string(st7a) + " resp=" + resp7a.substr(0, 120));
  std::string body7 = "file=" + UrlEnc(fTok) + "&el=2&sign=" + UrlEnc(fSign);
  std::string resp7;
  int st7 = HttpFetch2(Utf8ToWide(host6), L"/file/ajax.php", L"POST", body7, Utf8ToWide(link), resp7, xrw);
  bool zt7 = resp7.find("\"zt\":1") != std::string::npos || resp7.find("\"zt\":\"1\"") != std::string::npos;
  LOG("  status=" + std::to_string(st7) + " zt1=" + std::to_string(zt7) + " resp=" + resp7.substr(0, 160));
  if (st7 != 200 || !zt7) { LOG("FAIL step7"); return 1; }
  std::string direct = JsonUnslash(QuotedAfter(resp7, "\"url\":\""));
  if (direct.empty() || direct.rfind("http", 0) != 0) { LOG("FAIL step7 link"); return 1; }
  LOG("  DIRECT=" + direct.substr(0, 100));

  if (!saveExe) { LOG("ALL STEPS OK (no download, pass output path to save exe)"); return 0; }

  LOG("⑧ 下载 exe");
  std::string dHost = direct.substr(direct.find("://") + 3);
  std::string dPath = "/";
  size_t slash = dHost.find('/');
  if (slash != std::string::npos) { dPath = dHost.substr(slash); dHost = dHost.substr(0, slash); }
  FILE* sf = fopen(argv[1], "wb");
  if (!sf) { LOG("FAIL open dest"); return 1; }
  std::string drop;
  int st8 = HttpFetch2(Utf8ToWide(dHost), Utf8ToWide(dPath), L"GET", "", Utf8ToWide(link), drop, xrw, sf);
  fclose(sf);
  FILE* vf = fopen(argv[1], "rb");
  char m2[4] = {0, 0, 0, 0};
  bool isExe = vf && fread(m2, 1, 2, vf) == 2 && m2[0] == 'M' && m2[1] == 'Z';
  if (vf) fclose(vf);
  LOG("  status=" + std::to_string(st8) + " MZ=" + std::to_string(isExe));
  if (!isExe) {
    LOG("FAIL step8 (not exe) — first bytes: " + std::string(m2));
    return 1;
  }
  LOG("ALL STEPS OK — installer saved to " + std::string(argv[1]));
  return 0;
}
