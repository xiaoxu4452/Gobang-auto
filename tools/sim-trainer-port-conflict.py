# -*- coding: utf-8 -*-
"""冲突场景仿真：模拟训练器环境（inbox 占 :8972），验证视觉服务迁 :8974/:8975 后
recognize/scan 全链路拿到真实结果（识图窗同款调用序：health → recognize → scan-image）。"""
import base64, json, socket, threading, http.client, glob, os, sys, time

# --- 1. 起一个「inbox」占住 :8972（对任何 POST 回 {"ok":true}，复刻事故应答器） ---
def fake_inbox():
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', 8972)); s.listen(8)
    while True:
        c, _ = s.accept()
        try:
            c.recv(1 << 20)
            c.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{"ok":true}\n')
        except Exception:
            pass
        finally:
            c.close()
threading.Thread(target=fake_inbox, daemon=True).start()
print('fake inbox on :8972 up')

# --- 2. 用新端口环境拉视觉服务（与新版宿主同款 env） ---
import subprocess, time
env = {'GB_RECOG_PORT': '8974', 'GB_SCAN_PORT': '8975', 'SYSTEMROOT': os.environ.get('SYSTEMROOT', r'C:\Windows')}
p = subprocess.Popen([r'desktop-vision/build/GomokuVision.exe', '--both'], env=env,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(3)

ok = total = 0
for f in sorted(glob.glob(r'C:\Users\harve\Desktop\media\img\*'))[:4]:
    raw = open(f, 'rb').read()
    conn = http.client.HTTPConnection('127.0.0.1', 8974, timeout=90)
    conn.request('GET', '/health')
    hr = conn.getresponse(); hr.read()
    body = json.dumps({'image': base64.b64encode(raw).decode(), 'size': 15}).encode()
    conn.request('POST', '/recognize', body=body, headers={'Content-Type': 'application/json'})
    j = json.loads(conn.getresponse().read())
    n = len(j.get('black', [])) + len(j.get('white', []))
    good = j.get('ok') and n > 0
    total += 1; ok += 1 if good else 0
    print(f"{os.path.basename(f)[:26]:28s} :8974 recognize ok={j.get('ok')} stones={n} {'' if good else '<<<< FAIL'}")
    conn.close()

raw = open(r'C:\Users\harve\Desktop\media\img\微信图片_20260922113732_5_1.jpg', 'rb').read()
conn = http.client.HTTPConnection('127.0.0.1', 8975, timeout=90)
conn.request('POST', '/scan-image', body=raw, headers={'Content-Type': 'application/octet-stream'})
j = json.loads(conn.getresponse().read())
n = len(j.get('black', [])) + len(j.get('white', []))
print(f"scan-image :8975 found={j.get('found')} stones={n} {'' if (j.get('found') and n>0) else '<<<< FAIL'}")
conn.close()

p.kill()
print(f'=== {ok}/{total} recognize via :8974 (with hostile {"ok":true} responder on :8972)')
