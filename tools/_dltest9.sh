#!/usr/bin/env bash
# Full chain + AliCloud acw_sc__v2 anti-bot cookie solve -> real exe download.
set -u
cd "$(dirname "$0")"

API="https://wwbbj.lanzout.com"
SHARE="/b016l49aqj"
PWD="15"
JAR="$(pwd)/_dltest9_cookies.txt"; rm -f "$JAR"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# --- chain up to ajaxfile ---
curl -s -c "$JAR" -A "$UA" -e "$API$SHARE" "$API$SHARE" -o _dltest9_folder.html
T=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _dltest9_folder.html | sed -E "s/.*'([0-9a-f]+)'/\1/" | head -1)
K=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _dltest9_folder.html | sed -E "s/.*'([0-9a-f]+)'/\1/" | sed -n '2p')
FILE=$(grep -oE "file=[0-9]+" _dltest9_folder.html | head -1 | sed -E 's/file=([0-9]+)/\1/')
PUID=$(grep -oE "puid':'[^']+'" _dltest9_folder.html | head -1 | sed -E "s/puid':'([^']+)'/\1/")
LIST=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" \
  --data-urlencode "lx=2" --data-urlencode "fid=$FILE" --data-urlencode "uid=4801414" \
  --data-urlencode "puid=$PUID" --data-urlencode "pg=1" --data-urlencode "rep=0" \
  --data-urlencode "t=$T" --data-urlencode "k=$K" --data-urlencode "up=1" \
  --data-urlencode "ls=1" --data-urlencode "pwd=$PWD" \
  "$API/filemoreajax.php?file=$FILE")
FPATH=$(printf '%s' "$LIST" | grep -oE '"id":"[^"]+"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/')
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" "$API/$FPATH" -o _dltest9_web.html
FNTOKEN=$(grep -oE '/fn\?[^"'"'"'> ]+' _dltest9_web.html | head -1 | sed -E 's#/fn\?##')
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API/$FPATH" "$API/fn?$FNTOKEN" -o _dltest9_fn.html
WP_SIGN=$(grep -oE "var wp_sign = '[^']+'" _dltest9_fn.html | head -1 | sed -E "s/.*'([^']*)'/\1/")
AJAXDATA=$(grep -oE "var ajaxdata = '[^']+'" _dltest9_fn.html | head -1 | sed -E "s/.*'([^']*)'/\1/")
FID=$(grep -oE "ajaxfile\.php\?file=[0-9]+" _dltest9_fn.html | head -1 | sed -E 's/.*file=([0-9]+)/\1/')
RESP=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API/fn?$FNTOKEN" \
  --data-urlencode "action=downprocess" --data-urlencode "websignkey=$AJAXDATA" \
  --data-urlencode "signs=$AJAXDATA" --data-urlencode "sign=$WP_SIGN" \
  --data-urlencode "websign=2" --data-urlencode "kd=1" --data-urlencode "ves=1" \
  "https://apifile.woozooo.com/ajaxfile.php?file=$FID")
DOM=$(printf '%s' "$RESP" | grep -o '"dom"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/' | sed 's#\\/#/#g')
URL=$(printf '%s' "$RESP" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/' | sed 's#\\/#/#g')
LINK="$DOM/file/$URL"
echo "LINK ok: ${LINK:0:60}..."

# --- GET download link -> acw challenge page with arg1 ---
CHAL=$(curl -s --compressed -b "$JAR" -c "$JAR" -A "$UA" -e "$API/" "$LINK")
ARG1=$(printf '%s' "$CHAL" | grep -oE "arg1='[0-9A-Fa-f]+'" | head -1 | sed -E "s/arg1='([^']*)'/\1/")
echo "ARG1=[$ARG1]"

if [ -n "$ARG1" ]; then
  V=$("/c/Users/harve/.workbuddy/binaries/python/versions/3.13.12/python.exe" -c "
import sys
arg1 = sys.argv[1]
m=[15,35,29,24,33,16,1,38,10,9,19,31,40,27,22,23,25,13,6,11,39,18,20,8,14,21,32,26,2,30,7,4,17,5,3,28,34,37,12,36]
mask='3000176000856006061501533003690027800375'
u=''.join(arg1[p-1] for p in m)
print(''.join('%02x'%(int(u[i:i+2],16)^int(mask[i:i+2],16)) for i in range(0,len(u),2)))
" "$ARG1")
  echo "acw_sc__v2=[$V]"
  printf '.lanrar.com\tTRUE\t/\tFALSE\t0\tacw_sc__v2\t%s\n' "$V" >> "$JAR"
  printf 'developer4.lanrar.com\tTRUE\t/\tFALSE\t0\tacw_sc__v2\t%s\n' "$V" >> "$JAR"
fi

echo "=== final download ==="
curl -s -L --compressed -b "$JAR" -c "$JAR" -A "$UA" -e "$API/" -o _dltest9_installer.exe \
  -w "HTTP %{http_code} size=%{size_download} type=%{content_type} final=%{url_effective}\n" "$LINK"
ls -l _dltest9_installer.exe
echo "--- first 4 bytes (expect 4d 5a = MZ) ---"
head -c 4 _dltest9_installer.exe | od -An -tx1
