#!/usr/bin/env bash
# Validate: folder unlock (confirm pwd=15), then file-page download via ajaxfile.php with seeded
# cookies + browser-like headers. Dump cookies at each step.
set -u
cd "$(dirname "$0")"

API="https://wwbbj.lanzout.com"
SHARE="/b016l49aqj"
FILE_PAGE="/itDh84ad20ej"
PWD="15"

JAR="$(pwd)/_dltest4_cookies.txt"
rm -f "$JAR"

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
H_ACCEPT="application/json, text/javascript, */*; q=0.01"
H_XRW="XMLHttpRequest"

echo "=== STEP 0: GET folder page (fresh tokens) ==="
curl -s -c "$JAR" -A "$UA" -e "$API$SHARE" "$API$SHARE" -o _dltest4_folder.html -w "HTTP %{http_code}\n"
T=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _dltest4_folder.html | sed -E "s/var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'([0-9a-f]+)'/\1/" | head -1)
K=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _dltest4_folder.html | sed -E "s/var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'([0-9a-f]+)'/\1/" | sed -n '2p')
FILE=$(grep -oE "file=[0-9]+" _dltest4_folder.html | head -1 | sed -E 's/file=([0-9]+)/\1/')
PUID=$(grep -oE "puid':'[^']+'" _dltest4_folder.html | head -1 | sed -E "s/puid':'([^']+)'/\1/")
echo "T=[$T] K=[$K] FILE=[$FILE] PUID=[$PUID]"

echo
echo "=== STEP 0b: folder unlock filemoreajax.php?file=$FILE pwd=$PWD ==="
UNLOCK=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" \
  -H "X-Requested-With: $H_XRW" -H "Accept: $H_ACCEPT" \
  --data-urlencode "lx=2" --data-urlencode "fid=$FILE" --data-urlencode "uid=4801414" \
  --data-urlencode "puid=$PUID" --data-urlencode "pg=1" --data-urlencode "rep=0" \
  --data-urlencode "t=$T" --data-urlencode "k=$K" --data-urlencode "up=1" \
  --data-urlencode "ls=1" --data-urlencode "pwd=$PWD" \
  "$API/filemoreajax.php?file=$FILE" -w "\nHTTP %{http_code}\n")
echo "${UNLOCK:0:300}"
echo "--- cookies after unlock ---"
cat "$JAR"

echo
echo "=== STEP A: GET file page (sign) ==="
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" "$API$FILE_PAGE" -o _dltest4_file.html -w "HTTP %{http_code}\n"
SIGN=$(grep -oE "var isngis = '[^']+'" _dltest4_file.html | head -1 | sed -E "s/var isngis = '([^']*)'/\1/")
REAL_FILE_ID=$(grep -oE "ajaxfile\.php\?file=[0-9]+" _dltest4_file.html | head -1 | sed -E 's/.*file=([0-9]+)/\1/')
echo "SIGN(len=${#SIGN}) REAL_FILE_ID=[$REAL_FILE_ID]"

echo
echo "=== STEP B: ajaxfile.php field p=$PWD (with cookies+headers) ==="
RESP=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$FILE_PAGE" \
  -H "X-Requested-With: $H_XRW" -H "Accept: $H_ACCEPT" -H "Origin: $API" \
  --data-urlencode "action=downprocess" --data-urlencode "sign=$SIGN" \
  --data-urlencode "kd=1" --data-urlencode "p=$PWD" \
  "https://apifile.woozooo.com/ajaxfile.php?file=$REAL_FILE_ID" -w "\nHTTP %{http_code}\n")
echo "$RESP"

DOM=$(printf '%s' "$RESP" | grep -o '"dom"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/' | sed 's#\\/#/#g')
URL=$(printf '%s' "$RESP" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/')
echo "DOM=[$DOM] URL=[$URL]"
if [ -n "$DOM" ] && [ -n "$URL" ] && [ "$URL" != "0" ]; then
  LINK="$DOM/file/$URL"
  echo ">>> LINK=$LINK"
  curl -s -L -b "$JAR" -A "$UA" -e "$API$FILE_PAGE" -o _dltest4_downloaded.exe \
    -w "DOWNLOAD HTTP %{http_code} size=%{size_download} type=%{content_type}\n" "$LINK"
  ls -l _dltest4_downloaded.exe 2>/dev/null; file _dltest4_downloaded.exe 2>/dev/null
fi
