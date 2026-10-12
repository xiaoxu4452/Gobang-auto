# -*- coding: utf-8 -*-
path = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"
raw = open(path, "rb").read()
bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
if bom: raw = raw[3:]
text = raw.decode("utf-8")

# 1) remove center filled dot
dot = (
"              float dr = (float)(sp2 * 0.15);\n"
"              Gdiplus::SolidBrush dot(Gdiplus::Color(255, (BYTE)dotR, (BYTE)dotG, (BYTE)dotB));\n"
"              g.FillEllipse(&dot, x - dr, y - dr, dr * 2, dr * 2);\n"
)
print("dot count:", text.count(dot)); assert text.count(dot) == 1
text = text.replace(dot, "")

# 2) enlarge sequence number font
fsz_old = "                float fsz = sp2 * 0.30f; if (fsz < 8.0f) fsz = 8.0f; if (fsz > 14.0f) fsz = 14.0f;"
fsz_new = "                float fsz = sp2 * 0.42f; if (fsz < 10.0f) fsz = 10.0f; if (fsz > 20.0f) fsz = 20.0f;"
print("fsz count:", text.count(fsz_old)); assert text.count(fsz_old) == 1
text = text.replace(fsz_old, fsz_new)

open(path, "wb").write(bom + text.encode("utf-8"))
print("patched balMk OK")
