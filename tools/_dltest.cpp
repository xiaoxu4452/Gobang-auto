// Scratch: validate lanzout download chain (cookie + Referer forwarding).
#include <windows.h>
#include <winhttp.h>
#include <string>
#include <vector>
#include <iostream>
#include <fstream>
#include <cctype>

static std::string W2U(WCHAR* w) { if (!w) return ""; int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr); std::string o(n-1, 0); WideCharToMultiByte(CP_UTF8, 0, w, -1, &o[0], n, nullptr, nullptr); return o; }
static std::wstring Utf8ToWide(const std::string& s) { int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0); std::wstring w(n-1, 0); MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &w[0], n); return w; }
static std::string QuotedAfter(const std::string& s, const std::string& key) {
  size_t p = s.find(key); if (p == std::string::npos) return "";
  p += key.size(); if (p >= s.size()) return "";
  char q = s[p];
  if (q == '\'' || q == '"') { size_t e = s.find(q, p + 1); return (e == std::string::npos) ? "" : s.substr(p + 1, e - p - 1); }
  size_t e = p; while (e < s.size()) { char c = s[e]; if (c=='\''||c=='"'||c==','||c=='}'||c==']'||c==';'||c==' '||c=='\t'||c=='\n'||c=='\r') break; e++; }
  return s.substr(p, e - p);
}
static void ExtractTk(const std::string& s, std::string& t, std::string& k) {
  t.clear(); k.clear(); size_t p = 0; std::vector<std::string> vals;
  while ((p = s.find("var ", p)) != std::string::npos) {
    p += 4; while (p < s.size() && (s[p]==' '||s[p]=='\t')) p++;
    while (p < s.size() && (isalnum((unsigned char)s[p]) || s[p]=='_')) p++;
    while (p < s.size() && s[p]==' ') p++;
    if (p >= s.size() || s[p] != '=') continue; p++;
    while (p < s.size() && s[p]==' ') p++;
    if (p >= s.size() || s[p] != '\'') continue; p++;
    size_t vs = p;
    while (p < s.size() && ((s[p]>='0'&&s[p]<='9')||(s[p]>='a'&&s[p]<='f')||(s[p]>='A'&&s[p]<='F'))) p++;
    if (p > vs) vals.push_back(s.substr(vs, p - vs));
  }
  if (vals.size() >= 1) t = vals[0];
  if (vals.size() >= 2) k = vals[1];
}
static std::string DigitsAfter(const std::string& s, const std::string& key) {
  size_t p = s.find(key); if (p == std::string::npos) return ""; p += key.size();
  size_t e = p; while (e < s.size() && isdigit((unsigned char)s[e])) e++;
  return s.substr(p, e - p);
}
static std::string FirstVersion(const std::string& s) {
  for (size_t i=0;i<s.size();i++){ if(s[i]<'0'||s[i]>'9')continue;
    bool b=(i==0)||!(s[i-1]>='0'&&s[i-1]<='9')&&s[i-1]!='.'; if(!b)continue;
    size_t j=i; while(j<s.size()&&s[j]>='0'&&s[j]<='9')j++;
    if(j<s.size()&&s[j]=='.'){size_t k=j+1;while(k<s.size()&&s[k]>='0'&&s[k]<='9')k++;
      if(k>j+1){size_t end=k; if(k<s.size()&&s[k]=='.'){size_t m=k+1;while(m<s.size()&&s[m]>='0'&&s[m]<='9')m++; if(m>k+1)end=m;}
      return s.substr(i,end-i);}} }
  return std::string();
}
static bool HttpFetch(const std::wstring& host, INTERNET_PORT port, const std::wstring& path,
                      const std::wstring& method, const std::string& postBody, std::string& out,
                      const std::string& cookieIn, const std::string& referer, std::string* setCookieOut) {
  out.clear(); if (setCookieOut) setCookieOut->clear();
  HINTERNET hS = WinHttpOpen(L"gbcalc-dl", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!hS) return false;
  WinHttpSetTimeouts(hS, 10000, 10000, 10000, 30000);
  bool ok = false;
  HINTERNET hC = WinHttpConnect(hS, host.c_str(), port, 0);
  if (hC) {
    DWORD flags = (port == INTERNET_DEFAULT_HTTPS_PORT) ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET hR = WinHttpOpenRequest(hC, method.c_str(), path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (hR) {
      std::wstring hdrs = L"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n"
                          L"X-Requested-With: XMLHttpRequest\r\n";
      if (!referer.empty()) hdrs += L"Referer: " + Utf8ToWide(referer) + L"\r\n";
      if (!cookieIn.empty()) hdrs += L"Cookie: " + Utf8ToWide(cookieIn) + L"\r\n";
      if (!postBody.empty()) hdrs += L"Content-Type: application/x-www-form-urlencoded\r\n";
      const void* bp = postBody.empty() ? WINHTTP_NO_REQUEST_DATA : (const void*)postBody.c_str();
      DWORD bl = (DWORD)postBody.size();
      if (WinHttpSendRequest(hR, hdrs.c_str(), (DWORD)hdrs.size(), (void*)bp, bl, bl, 0) &&
          WinHttpReceiveResponse(hR, nullptr)) {
        if (setCookieOut) {
          DWORD hs = 0; WinHttpQueryHeaders(hR, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX, NULL, &hs, NULL);
          if (hs > 0) {
            std::wstring rh(hs / sizeof(WCHAR), 0);
            if (WinHttpQueryHeaders(hR, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX, &rh[0], &hs, NULL)) {
              std::string rhu = W2U(&rh[0]); std::string ck; size_t pos = 0;
              while (pos < rhu.size()) {
                size_t eol = rhu.find('\n', pos); if (eol == std::string::npos) eol = rhu.size();
                std::string line = rhu.substr(pos, eol - pos);
                if (!line.empty() && line.back() == '\r') line.pop_back();
                std::string low = line; for (auto& c : low) c = (char)tolower((unsigned char)c);
                size_t cp = low.find("set-cookie:");
                if (cp != std::string::npos) {
                  std::string cv = line.substr(cp + 11); size_t sc = cv.find(';'); if (sc != std::string::npos) cv = cv.substr(0, sc);
                  size_t a = cv.find_first_not_of(" "), b = cv.find_last_not_of(" ");
                  if (a != std::string::npos) cv = cv.substr(a, b - a + 1);
                  if (!cv.empty()) { if (!ck.empty()) ck += "; "; ck += cv; }
                }
                pos = eol + 1;
              }
              *setCookieOut = ck;
            }
          }
        }
        DWORD avail = 0; char buf[65536];
        while (WinHttpQueryDataAvailable(hR, &avail) && avail > 0) {
          DWORD rd = 0; if (!WinHttpReadData(hR, buf, (avail<sizeof(buf)?avail:(DWORD)sizeof(buf)), &rd) || rd==0) break;
          out.append(buf, rd);
        }
        ok = true;
      }
      WinHttpCloseHandle(hR);
    }
    WinHttpCloseHandle(hC);
  }
  WinHttpCloseHandle(hS);
  return ok;
}
static long long DownloadUrl(const std::string& url, const std::string& outPath, const std::string& cookie, const std::string& referer) {
  std::string cur = url; long long total = 0;
  for (int hop = 0; hop < 8; hop++) {
    size_t sp = cur.find("://"); if (sp == std::string::npos) return -1;
    std::string scheme = cur.substr(0, sp); size_t hs = sp + 3; size_t ps = cur.find('/', hs);
    std::string host = (ps == std::string::npos) ? cur.substr(hs) : cur.substr(hs, ps - hs);
    std::string path = (ps == std::string::npos) ? "/" : cur.substr(ps);
    INTERNET_PORT port = (scheme == "https") ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT;
    std::cout << "  GET [" << hop << "] https://" << host << path << "\n";
    HINTERNET hS = WinHttpOpen(L"gbcalc-dl", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hS) return -1;
    WinHttpSetTimeouts(hS, 10000, 10000, 10000, 60000);
    long long written = -1;
    HINTERNET hC = WinHttpConnect(hS, Utf8ToWide(host).c_str(), port, 0);
    if (hC) {
      DWORD flags = (port == INTERNET_DEFAULT_HTTPS_PORT) ? WINHTTP_FLAG_SECURE : 0;
      HINTERNET hR = WinHttpOpenRequest(hC, L"GET", Utf8ToWide(path).c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
      if (hR) {
        std::wstring hdrs = L"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n";
        if (!referer.empty()) hdrs += L"Referer: " + Utf8ToWide(referer) + L"\r\n";
        if (!cookie.empty()) hdrs += L"Cookie: " + Utf8ToWide(cookie) + L"\r\n";
        if (WinHttpSendRequest(hR, hdrs.c_str(), (DWORD)hdrs.size(), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
            WinHttpReceiveResponse(hR, nullptr)) {
          DWORD code = 0, cl = sizeof(code); WinHttpQueryHeaders(hR, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, NULL, &code, &cl, NULL);
          std::cout << "  status=" << code << "\n";
          if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
            DWORD ls = 0; WinHttpQueryHeaders(hR, WINHTTP_QUERY_LOCATION, WINHTTP_HEADER_NAME_BY_INDEX, NULL, &ls, NULL);
            if (ls > 0) { std::wstring loc(ls / sizeof(WCHAR) + 1, 0); WinHttpQueryHeaders(hR, WINHTTP_QUERY_LOCATION, WINHTTP_HEADER_NAME_BY_INDEX, &loc[0], &ls, NULL);
              std::string locU = W2U(&loc[0]); std::cout << "  Location=" << locU << "\n";
              cur = (locU.find("://") != std::string::npos) ? locU : ("https://" + host + (locU[0]=='/' ? "" : "/") + locU);
              WinHttpCloseHandle(hR); WinHttpCloseHandle(hC); WinHttpCloseHandle(hS); continue; }
          } else if (code == 200) {
            std::ofstream f(outPath, std::ios::binary);
            if (f) { DWORD avail = 0; char buf[65536];
              while (WinHttpQueryDataAvailable(hR, &avail) && avail > 0) { DWORD rd = 0; if (!WinHttpReadData(hR, buf, (avail<sizeof(buf)?avail:(DWORD)sizeof(buf)), &rd) || rd==0) break; f.write(buf, rd); total += rd; }
              f.close(); written = total; } }
        }
        WinHttpCloseHandle(hR);
      }
      WinHttpCloseHandle(hC);
    }
    WinHttpCloseHandle(hS);
    return written;
  }
  return -1;
}
int main() {
  const char* pwd = "15";
  std::string html, cookie0;
  if (!HttpFetch(L"wwbbj.lanzout.com", INTERNET_DEFAULT_HTTPS_PORT, L"/b016l49aqj", L"GET", "", html, "", "", &cookie0)) { std::cout << "PAGE FAILED\n"; return 1; }
  std::cout << "page bytes=" << html.size() << " cookie0=[" << cookie0 << "]\n";
  std::string file = DigitsAfter(html, "filemoreajax.php?file="); if (file.empty()) file = DigitsAfter(html, "/q/jb/?f=");
  std::string uid  = QuotedAfter(html, "uid':'"); if (uid.empty()) uid = QuotedAfter(html, "uid\":\"");
  std::string puid = QuotedAfter(html, "puid':'");
  std::string t, k; ExtractTk(html, t, k);
  std::cout << "file=[" << file << "] uid=[" << uid << "] puid=[" << puid << "] t=[" << t << "] k=[" << k << "]\n";

  std::string body = "lx=2&fid=" + file + "&uid=" + uid + "&puid=" + puid + "&pg=1&rep=0&t=" + t + "&k=" + k + "&up=1&ls=1&pwd=" + pwd;
  std::wstring wpath = L"/filemoreajax.php?file=" + Utf8ToWide(file);
  std::string resp, cookie1;
  if (!HttpFetch(L"wwbbj.lanzout.com", INTERNET_DEFAULT_HTTPS_PORT, wpath, L"POST", body, resp, cookie0, "https://wwbbj.lanzout.com/b016l49aqj", &cookie1)) { std::cout << "AJAX FAILED\n"; return 1; }
  std::cout << "ajax bytes=" << resp.size() << " cookie1=[" << cookie1 << "]\n";

  // parse names, ids, duans
  std::vector<std::string> names, ids, duans;
  size_t p = 0;
  while ((p = resp.find("\"name_all\":\"", p)) != std::string::npos) { p += 12; size_t e = resp.find('"', p); names.push_back(resp.substr(p, e - p)); p = e + 1; }
  p = 0; while ((p = resp.find("\"id\":\"", p)) != std::string::npos) { p += 7; size_t e = resp.find('"', p); ids.push_back(resp.substr(p, e - p)); p = e + 1; }
  p = 0; while ((p = resp.find("\"duan\":\"", p)) != std::string::npos) { p += 8; size_t e = resp.find('"', p); duans.push_back(resp.substr(p, e - p)); p = e + 1; }
  std::string bestId, bestName, bestDuan; float bestNum = -1;
  for (size_t i = 0; i < names.size(); i++) {
    bool isExe = names[i].size() >= 4 && names[i].substr(names[i].size()-4) == ".exe";
    if (!isExe) continue;
    std::string ver = FirstVersion(names[i]); if (ver.empty()) continue;
    try { float n = std::stof(ver); if (n > bestNum) { bestNum = n; bestId = ids[i]; bestName = names[i]; bestDuan = (i < duans.size() ? duans[i] : ""); } } catch (...) {}
  }
  std::cout << "best=[" << bestName << "] id=[" << bestId << "] duan=[" << bestDuan << "]\n";
  if (bestId.empty()) { std::cout << "NO installer\n"; return 1; }
  std::string fidClean = bestId.substr(0, bestId.find('?'));
  // cookie to forward: combine cookie0 + cookie1 (cookie1 may be empty)
  std::string fwdCookie = cookie0; if (!cookie1.empty()) { if (!fwdCookie.empty()) fwdCookie += "; "; fwdCookie += cookie1; }
  std::string ref = bestDuan.empty() ? std::string("https://wwbbj.lanzout.com/b016l49aqj") : ("https://wwbbj.lanzout.com/" + bestDuan);

  // try ajaxm variants with cookie + referer
  std::vector<std::string> variants;
  variants.push_back("lx=0&fid=" + file + "&uid=" + uid + "&pwd=" + std::string(pwd));
  variants.push_back("lx=0&fid=" + file + "&uid=" + uid + "&puid=" + puid + "&pwd=" + std::string(pwd));
  std::vector<std::string> refs = { ref, "https://wwbbj.lanzout.com/b016l49aqj" };
  std::string aresp; bool got = false;
  for (size_t ri = 0; ri < refs.size() && !got; ri++) {
    for (size_t vi = 0; vi < variants.size(); vi++) {
      std::string r;
      if (!HttpFetch(L"wwbbj.lanzout.com", INTERNET_DEFAULT_HTTPS_PORT, L"/ajaxm.php?file=" + Utf8ToWide(fidClean), L"POST", variants[vi], r, fwdCookie, refs[ri], nullptr)) continue;
      std::string d = QuotedAfter(r, "dom':'"); if (d.empty()) d = QuotedAfter(r, "dom\":\"");
      std::string u = QuotedAfter(r, "url':'"); if (u.empty()) u = QuotedAfter(r, "url\":\"");
      std::cout << "  ref[" << ri << "] variant[" << vi << "] resp=" << r << "\n";
      if (!d.empty() && !u.empty()) { aresp = r; got = true; break; }
    }
  }
  if (!got) { std::cout << "ALL AJAXM FAILED\n"; return 1; }
  std::string dom = QuotedAfter(aresp, "dom':'"); if (dom.empty()) dom = QuotedAfter(aresp, "dom\":\"");
  std::string durl = QuotedAfter(aresp, "url':'"); if (durl.empty()) durl = QuotedAfter(aresp, "url\":\"");
  std::string dlUrl = "https://" + dom + durl;
  std::cout << "download url=" << dlUrl << "\n";
  std::string out = "C:/Users/harve/AppData/Local/Temp/_dltest_out.bin";
  long long n = DownloadUrl(dlUrl, out, fwdCookie, ref);
  std::cout << "downloaded bytes=" << n << " -> " << out << "\n";
  return 0;
}
