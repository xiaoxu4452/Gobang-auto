// seticon.exe —— 给已生成的 exe 换图标（BeginUpdateResource / UpdateResource）。
//
// 为什么需要它：网页端那个 exe 是「复制 node.exe 再注入 SEA blob」做出来的，
// 没有经过链接器，所以 .rc 那套（rc.exe → link）根本用不上。要给成品 exe 换图标，
// 只能事后改它的资源节 —— 这正是 UpdateResource 的用途。
//
// 用法：seticon.exe <目标.exe> <图标.ico>
// 失败返回非 0。Win7+ 均可用（UpdateResource 自 NT 就有）。
#include <windows.h>
#include <stdio.h>

#pragma pack(push, 2)
typedef struct { WORD reserved; WORD type; WORD count; } GB_ICONDIR;
typedef struct {
  BYTE w, h, colorCount, reserved;
  WORD planes, bitCount;
  DWORD bytesInRes, imageOffset;
} GB_ICONDIRENTRY;
typedef struct {
  BYTE w, h, colorCount, reserved;
  WORD planes, bitCount;
  DWORD bytesInRes;
  WORD id;
} GB_GRPICONDIRENTRY;
#pragma pack(pop)

static void die(const char* m) { fprintf(stderr, "seticon: %s\n", m); exit(1); }

int wmain(int argc, wchar_t** argv) {
  if (argc < 3) { fprintf(stderr, "usage: seticon.exe <target.exe> <icon.ico>\n"); return 1; }

  FILE* f = _wfopen(argv[2], L"rb");
  if (!f) die("cannot open ico");
  fseek(f, 0, SEEK_END);
  long flen = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (flen < 6 + 16) die("ico too small");
  BYTE* buf = (BYTE*)malloc((size_t)flen);
  if (!buf) die("oom");
  if (fread(buf, 1, (size_t)flen, f) != (size_t)flen) die("short read");
  fclose(f);

  GB_ICONDIR* dir = (GB_ICONDIR*)buf;
  if (dir->reserved != 0 || dir->type != 1) die("not an .ico file");
  WORD n = dir->count;
  if (n == 0 || n > 32) die("bad icon count");
  if (flen < 6 + (long)n * 16) die("truncated icon directory");

  HANDLE h = BeginUpdateResourceW(argv[1], FALSE);
  if (!h) die("BeginUpdateResource failed (target locked or not writable?)");

  // 先把每张图（RT_ICON）塞进去，id 从 1 开始
  for (WORD i = 0; i < n; i++) {
    GB_ICONDIRENTRY* e = (GB_ICONDIRENTRY*)(buf + 6 + i * 16);
    DWORD off = e->imageOffset, sz = e->bytesInRes;
    if (off < 6 + (DWORD)n * 16 || (long)(off + sz) > flen) die("image offset out of range");
    if (!UpdateResourceW(h, (LPCWSTR)RT_ICON, MAKEINTRESOURCE(i + 1),
                         MAKELANGID(LANG_NEUTRAL, SUBLANG_NEUTRAL),
                         buf + off, sz)) {
      die("UpdateResource(RT_ICON) failed");
    }
  }

  // 再写图标组（RT_GROUP_ICON）：与目录项同构，只是末字段是资源 id 而不是文件偏移
  size_t grpSize = 6 + (size_t)n * sizeof(GB_GRPICONDIRENTRY);
  BYTE* grp = (BYTE*)malloc(grpSize);
  if (!grp) die("oom");
  GB_ICONDIR* gd = (GB_ICONDIR*)grp;
  gd->reserved = 0; gd->type = 1; gd->count = n;
  for (WORD i = 0; i < n; i++) {
    GB_ICONDIRENTRY* src = (GB_ICONDIRENTRY*)(buf + 6 + i * 16);
    GB_GRPICONDIRENTRY* dst = (GB_GRPICONDIRENTRY*)(grp + 6 + i * sizeof(GB_GRPICONDIRENTRY));
    dst->w = src->w; dst->h = src->h; dst->colorCount = src->colorCount;
    dst->reserved = src->reserved; dst->planes = src->planes; dst->bitCount = src->bitCount;
    dst->bytesInRes = src->bytesInRes; dst->id = (WORD)(i + 1);
  }
  // id 用 1（IDR_MAINFRAME 惯用值）：node.exe 原本的图标组也是 1，这里正好覆盖掉它
  if (!UpdateResourceW(h, (LPCWSTR)RT_GROUP_ICON, MAKEINTRESOURCE(1),
                       MAKELANGID(LANG_NEUTRAL, SUBLANG_NEUTRAL), grp, (DWORD)grpSize)) {
    die("UpdateResource(RT_GROUP_ICON) failed");
  }

  if (!EndUpdateResourceW(h, FALSE)) die("EndUpdateResource failed");
  free(grp); free(buf);
  wprintf(L"seticon: icon applied -> %s\n", argv[1]);
  return 0;
}
