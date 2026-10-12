#!/usr/bin/env bash
# Validate full lanzou download chain: fetch file page FRESH, extract sign + real file id,
# POST ajaxfile.php immediately (sign is age-bound -> must reuse fresh page sign).
set -u
cd "$(dirname "$0")"

API="https://wwbbj.lanzout.com"
FILE_PAGE="/itDh84ad20ej"
PWD="15"

JAR="$(pwd)/_dltest2_cookies.txt"
rm -f "$JAR"

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

echo "=== STEP A: GET file page FRESH (collect cookies) ==="
curl -s -c "$JAR" -A "$UA" -e "$API$FILE_PAGE" "$API$FILE_PAGE" -o _dltest2_file.html -w "HTTP %{http_code}\n"

# Extract sign from freshly fetched page (var isngis = '...')
SIGN=$(grep -oE "var isngis = '[^']+'" _dltest2_file.html | head -1 | sed -E "s/var isngis = '([^']*)'/\1/")
echo "SIGN(len=${#SIGN})=[${SIGN:0:40}...]"

# Extract real internal file id from ajaxfile.php?file=NNNN
REAL_FILE_ID=$(grep -oE "ajaxfile\.php\?file=[0-9]+" _dltest2_file.html | head -1 | sed -E 's/.*file=([0-9]+)/\1/')
echo "REAL_FILE_ID=[$REAL_FILE_ID]"

if [ -z "$SIGN" ] || [ -z "$REAL_FILE_ID" ]; then
  echo "!! failed to extract sign or real file id"; exit 1
fi

echo
echo "=== STEP B: POST ajaxfile.php?file=$REAL_FILE_ID (immediately) ==="
RESP=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" \
  -e "$API$FILE_PAGE" \
  --data-urlencode "action=downprocess" \
  --data-urlencode "sign=$SIGN" \
  --data-urlencode "kd=1" \
  --data-urlencode "p=$PWD" \
  "https://apifile.woozooo.com/ajaxfile.php?file=$REAL_FILE_ID" \
  -w "\nHTTP %{http_code}\n")
echo "$RESP"

echo
echo "=== STEP C: extract dom + url, build link, download ==="
DOM=$(printf '%s' "$RESP" | grep -o '"dom"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/' | sed 's#\\/#/#g')
URL=$(printf '%s' "$RESP" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/')
echo "DOM=[$DOM]"
echo "URL=[$URL]"

if [ -n "$DOM" ] && [ -n "$URL" ] && [ "$URL" != "0" ]; then
  LINK="$DOM/file/$URL"
  echo "LINK=$LINK"
  curl -s -L -b "$JAR" -A "$UA" -e "$API$FILE_PAGE" \
    -o _dltest2_downloaded.exe \
    -w "DOWNLOAD HTTP %{http_code} size=%{size_download} type=%{content_type} url=%{url_effective}\n" \
    "$LINK"
  ls -l _dltest2_downloaded.exe 2>/dev/null
  file _dltest2_downloaded.exe 2>/dev/null
else
  echo "!! dom/url extraction failed (sign likely expired or wrong)"
fi
