#!/usr/bin/env bash
# Packages dist/amail.js (single-file Bun bundle) with the skill, README and LICENSE.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
name="amail-$version"
stage=$(mktemp -d)
mkdir -p "$stage/$name"
cp dist/amail.js README.md LICENSE "$stage/$name/"
cp -R skills "$stage/$name/"
tar -C "$stage" -czf "dist/$name.tar.gz" "$name"
rm -rf "$stage"
shasum -a 256 "dist/$name.tar.gz"
