#!/usr/bin/env bash
# Comprehensive lanzou download test:
#  - GET folder page, extract t/k/file/uid/puid
#  - POST filemoreajax.php?file=<file> pwd=15  (folder unlock -> cookie)
#  - GET file page, extract sign + real file id
#  - POST ajaxfile.php with p vs pwd field variants
set -u
cd "$(dirname "$0")"

API="https://wwbbj.lanzout.com"
SHARE="/b016l49aqj"
FILE_PAGE="/itDh84ad20ej"
PWD="15"

JAR="$(pwd)/_dltest3_cookies.txt"
rm -f "$JAR"

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

echo "=== STEP 0: GET folder page ==="
curl -s -c "$JAR" -A "$UA" -e "$API$SHARE" "$API$SHARE" -o _dltest3_folder.html -w "HTTP %{http_code}\n"

# Extract t/k from folder page (var X='hex/digits')
T=$(grep -oE "var [a-zA-Z0-9_]+='[0-9a-f]+'" _dltest3_folder.html | head -2 | sed -n '1p' | sed -E "s/var [a-zA-Z0-9_]+='([0-9a-f]+)'/\1/")
K=$(grep -oE "var [a-zA-Z0-9_]+='[0-9a-f]+'" _dltest3_folder.html | head -2 | sed -n '2p' | sed -E "s/var [a-zA-Z0-9_]+='([0-9a-f]+)'/\1/")
FILE=$(grep -oE "file=[0-9]+" _dltest3_folder.html | head -1 | sed -E 's/file=([0-9]+)/\1/')
UID=$(grep -oE "var user_id='[0-9]+'|'uid':'[0-9]+'" _dltest3_folder.html | head -1)
echo "T=[$T] K=[$K] FILE=[$FILE]"

echo
echo "=== STEP 0b: POST filemoreajax.php?file=$FILE (folder unlock, pwd=$PWD) ==="
UNLOCK=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" \
  --data-urlencode "lx=2" --data-urlencode "fid=$FILE" --data-urlencode "uid=4801414" \
  --data-urlencode "puid=0" --data-urlencode "pg=1" --data-urlencode "rep=0" \
  --data-urlencode "t=$T" --data-urlencode "k=$K" --data-urlencode "up=1" \
  --data-urlencode "ls=1" --data-urlencode "pwd=$PWD" \
  "$API/filemoreajax.php?file=$FILE" -w "\nHTTP %{http_code}\n")
echo "${UNLOCK:0:200}"

echo
echo "=== STEP A: GET file page (sign) ==="
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" "$API$FILE_PAGE" -o _dltest3_file.html -w "HTTP %{http_code}\n"
SIGN=$(grep -oE "var isngis = '[^']+'" _dltest3_file.html | head -1 | sed -E "s/var isngis = '([^']*)'/\1/")
REAL_FILE_ID=$(grep -oE "ajaxfile\.php\?file=[0-9]+" _dltest3_file.html | head -1 | sed -E 's/.*file=([0-9]+)/\1/')
echo "SIGN(len=${#SIGN}) REAL_FILE_ID=[$REAL_FILE_ID]"

try_field () {
  local field="$1"
  echo
  echo "--- ajaxfile with field '$field' = pwd ---"
  local resp
  resp=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$FILE_PAGE" \
    --data-urlencode "action=downprocess" --data-urlencode "sign=$SIGN" \
    --data-urlencode "kd=1" --data-urlencode "$field=$PWD" \
    "https://apifile.woozooo.com/ajaxfile.php?file=$REAL_FILE_ID" -w "\nHTTP %{http_code}\n")
  echo "${resp:0:160}"
  local dom url
  dom=$(printf '%s' "$resp" | grep -o '"dom"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/' | sed 's#\\/#/#g')
  url=$(printf '%s' "$resp" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/')
  if [ -n "$dom" ] && [ -n "$url" ] && [ "$url" != "0" ]; then
    echo ">>> SUCCESS dom=$dom url=$url"
    echo ">>> LINK=$dom/file/$url"
    curl -s -L -b "$JAR" -A "$UA" -e "$API$FILE_PAGE" -o _dltest3_downloaded.exe \
      -w "DOWNLOAD HTTP %{http_code} size=%{size_download} type=%{content_type}\n" "$dom/file/$url"
    ls -l _dltest3_downloaded.exe 2>/dev/null; file _dltest3_downloaded.exe 2>/dev/null
    return 0
  fi
  return 1
}

try_field "p"
try_field "pwd"
echo "=== done ==="
