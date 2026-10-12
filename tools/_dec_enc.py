# -*- coding: utf-8 -*-
# Decrypt Meter Gomoku calc .enc files (base64 + rotated XOR, 32-char key)
# Mirrors desktop-connect/src/ui_crypto.h gbCalcDecrypt exactly.
import sys, base64

KEY = b"GbClcUiK3y2026xQz9Wm8Pd5Rt2YvN7s"  # 32 chars

def b64_decode(s):
    out = bytearray()
    buf = 0; bits = 0
    for ch in s:
        if ch in '=\n\r \t': continue
        v = -1
        if 'A' <= ch <= 'Z': v = ord(ch) - ord('A')
        elif 'a' <= ch <= 'z': v = ord(ch) - ord('a') + 26
        elif ch in '0123456789': v = ord(ch) - ord('0') + 52
        elif ch == '+': v = 62
        elif ch == '/': v = 63
        if v < 0: return None
        buf = (buf << 6) | v
        bits += 6
        if bits >= 8:
            bits -= 8
            out.append((buf >> bits) & 0xff)
    return out

def decrypt(path):
    data = open(path, 'rb').read().decode('utf-8', 'replace')
    seed2 = 0; shift = 0; b64 = ''
    for line in data.splitlines():
        if line.startswith('SEED2='): seed2 = int(line[6:])
        elif line.startswith('SHIFT='): shift = int(line[6:])
        elif line.startswith('B64='): b64 = line[4:]
    buf = b64_decode(b64)
    if buf is None: raise ValueError('bad base64')

    s = shift % 8
    if s != 0:
        amt = 8 - s
        for i in range(len(buf)):
            buf[i] = ((buf[i] << amt) | (buf[i] >> (8 - amt))) & 0xff

    klen = len(KEY)
    s1 = 0x811c9dc5
    for b in KEY:
        s1 ^= b
        s1 = (s1 * 0x01000193) & 0xffffffff
    s2 = seed2 & 0xffffffff
    for i in range(len(buf)):
        if (i & 1) == 0:
            s1 = (s1 * 1103515245 + 12345) & 0xffffffff
            mix = (s1 >> 24) & 0xff
        else:
            s2 = (s2 * 1103515245 + 12345) & 0xffffffff
            mix = (s2 >> 24) & 0xff
        buf[i] = (buf[i] ^ KEY[i % klen] ^ mix) & 0xff
    return bytes(buf)

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    out = decrypt(src)
    open(dst, 'wb').write(out)
    print(f"decrypted {len(out)} bytes -> {dst}")
