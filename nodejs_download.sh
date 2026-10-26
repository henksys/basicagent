#!/bin/bash
VERSION="v24.22.1"
FILE="node-$VERSION-linux-x64.tar.xz"

wget "https://nodejs.org/dist/$VERSION/$FILE"
tar -xJf "$FILE"
rm "$FILE"
