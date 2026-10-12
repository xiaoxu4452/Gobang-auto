#!/usr/bin/env bash
# FULL chain end-to-end: folder pwd=15 -> webpage token -> /fn token -> ajaxfile -> download.
set -u
cd "$(dirname "$0")"

API="https://wwbbj.lanzout.com"
SHARE="/b016l49aqj"
PWD="15"
JAR="$(pwd)/_dltest8_cookies.txt"; rm -f "$JAR"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

echo "=== 1. folder page tokens ==="
curl -s -c "$JAR" -A "$UA" -e "$API$SHARE" "$API$SHARE" -o _dltest8_folder.html
T=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _dltest8_folder.html | sed -E "s/.*'([0-9a-f]+)'/\1/" | head -1)
K=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _dltest8_folder.html | sed -E "s/.*'([0-9a-f]+)'/\1/" | sed -n '2p')
FILE=$(grep -oE "file=[0-9]+" _dltest8_folder.html | head -1 | sed -E 's/file=([0-9]+)/\1/')
PUID=$(grep -oE "puid':'[^']+'" _dltest8_folder.html | head -1 | sed -E "s/puid':'([^']+)'/\1/")
echo "T=$T K=$K FILE=$FILE"

echo "=== 2. filemoreajax pwd=$PWD ==="
LIST=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" \
  --data-urlencode "lx=2" --data-urlencode "fid=$FILE" --data-urlencode "uid=4801414" \
  --data-urlencode "puid=$PUID" --data-urlencode "pg=1" --data-urlencode "rep=0" \
  --data-urlencode "t=$T" --data-urlencode "k=$K" --data-urlencode "up=1" \
  --data-urlencode "ls=1" --data-urlencode "pwd=$PWD" \
  "$API/filemoreajax.php?file=$FILE")
echo "${LIST:0:220}"
FPATH=$(printf '%s' "$LIST" | grep -oE '"id":"[^"]+"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/')
echo "FPATH=$FPATH"

echo "=== 3. file page (?webpage=) -> /fn token ==="
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" "$API/$FPATH" -o _dltest8_web.html
FNTOKEN=$(grep -oE '/fn\?[^"'"'"'> ]+' _dltest8_web.html | head -1 | sed -E 's#/fn\?##')
echo "FNTOKEN=${FNTOKEN:0:30}..."

echo "=== 4. /fn? -> wp_sign + ajaxdata + real file id ==="
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API/$FPATH" "$API/fn?$FNTOKEN" -o _dltest8_fn.html
WP_SIGN=$(grep -oE "var wp_sign = '[^']+'" _dltest8_fn.html | head -1 | sed -E "s/.*'([^']*)'/\1/")
AJAXDATA=$(grep -oE "var ajaxdata = '[^']+'" _dltest8_fn.html | head -1 | sed -E "s/.*'([^']*)'/\1/")
FID=$(grep -oE "ajaxfile\.php\?file=[0-9]+" _dltest8_fn.html | head -1 | sed -E 's/.*file=([0-9]+)/\1/')
echo "WP_SIGN(len=${#WP_SIGN}) AJAXDATA=[$AJAXDATA] FID=$FID"
if [ -z "$WP_SIGN" ] || [ -z "$AJAXDATA" ] || [ -z "$FID" ]; then echo "!! extract failed"; exit 1; fi

echo "=== 5. ajaxfile POST (websign=2, no password) ==="
RESP=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API/fn?$FNTOKEN" \
  -H "X-Requested-With: XMLHttpRequest" -H "Accept: application/json, text/javascript, */*; q=0.01" \
  --data-urlencode "action=downprocess" \
  --data-urlencode "websignkey=$AJAXDATA" \
  --data-urlencode "signs=$AJAXDATA" \
  --data-urlencode "sign=$WP_SIGN" \
  --data-urlencode "websign=2" \
  --data-urlencode "kd=1" \
  --data-urlencode "ves=1" \
  "https://apifile.woozooo.com/ajaxfile.php?file=$FID" -w "\nHTTP %{http_code}\n")
echo "$RESP"

DOM=$(printf '%s' "$RESP" | grep -o '"dom"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/' | sed 's#\\/#/#g')
URL=$(printf '%s' "$RESP" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/' | sed 's#\\/#/#g')
echo "DOM=[$DOM] URL=[$URL]"
if [ -n "$DOM" ] && [ -n "$URL" ] && [ "$URL" != "0" ]; then
  LINK="$DOM/file/$URL"
  echo ">>> LINK=$LINK"
  echo "=== 6. download (follow 302) ==="
  curl -s -L --compressed -b "$JAR" -A "$UA" -e "$API/" -o _dltest8_installer.exe \
    -w "DOWNLOAD HTTP %{http_code} size=%{size_download} type=%{content_type}\n" "$LINK"
  ls -l _dltest8_installer.exe
  head -c 2 _dltest8_installer.exe | od -An -tx1
else
  echo "!! no dom/url"
fi
