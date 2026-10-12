# -*- coding: utf-8 -*-
import io
p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"
with io.open(p, 'r', encoding='utf-8') as f:
    lines = f.read().split('\n')
fixed = 0
for i, ln in enumerate(lines):
    if 'std::wstring cmd = L' in ln:
        # C++: L"\"" + exe + L"\" --scan-image \"" + imgPath + L"\""
        lines[i] = '    std::wstring cmd = L"\\"" + exe + L"\\" --scan-image \\"" + imgPath + L"\\"";'
        fixed += 1
with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write('\n'.join(lines))
print('fixed lines:', fixed)
