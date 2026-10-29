#!/usr/bin/env bash
set -euo pipefail

VERSION="v24.22.1"
ARCH="linux-x64"
FILE="node-$VERSION-$ARCH.tar.xz"
URL="https://nodejs.org/dist/$VERSION/$FILE"

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "This script supports Linux x64 only." >&2
  exit 1
fi

for cmd in wget tar sha256sum; do
  command -v "$cmd" >/dev/null || { echo "$cmd is required." >&2; exit 1; }
done

wget "$URL"
wget "https://nodejs.org/dist/$VERSION/SHASUMS256.txt"
grep -F "  $FILE" SHASUMS256.txt | sha256sum -c -
tar -xJf "$FILE"
rm -f SHASUMS256.txt "$FILE"
