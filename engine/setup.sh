#!/bin/bash
# Build engine/dq.wasm from scratch: fetch dquickts + wasi-sdk, apply the WASI patch, compile.
# Usage: bash engine/setup.sh   (Linux x86_64; needs git, curl, tar)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HERE/.build}"
DQ_COMMIT=f9a3efaa4d7cadb9dcad7e80a03d2774eb95a406
SDK=wasi-sdk-34.0-x86_64-linux
mkdir -p "$WORK" && cd "$WORK"
log() { echo "[$(date +%H:%M:%S)] $*"; }

if [ ! -d dquickts ]; then
  log "clone dquickts"
  git clone -q https://github.com/stencil-hq/dquickts && git -C dquickts checkout -q $DQ_COMMIT
fi
[ -d $SDK ] || { log "fetch $SDK"; curl -sL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/$SDK.tar.gz | tar xz; }

log "apply wasi.patch"
git -C dquickts checkout -q quickjs.c
git -C dquickts apply "$HERE/wasi.patch"

mkdir -p stub obj
echo '/* dtoa.c includes setjmp.h but never uses it */' > stub/setjmp.h
CC=$WORK/$SDK/bin/clang
FL=(--target=wasm32-wasip1 -O2 -fwrapv -D_GNU_SOURCE '-DCONFIG_VERSION="2026-06-04"' -Wno-everything -Istub -I"$WORK/dquickts")
for f in quickjs dtoa libregexp libunicode cutils; do
  log "cc $f"; $CC "${FL[@]}" -c dquickts/$f.c -o obj/$f.o || { log "FAIL $f"; exit 1; }
done
$CC "${FL[@]}" -c "$HERE/dq.c" -o obj/dq.o || { log "FAIL dq.c"; exit 1; }
$CC --target=wasm32-wasip1 -mexec-model=reactor -O2 obj/*.o -o "$HERE/dq.wasm" \
  -Wl,-z,stack-size=1048576 -Wl,--initial-memory=8388608 -lm || { log "FAIL link"; exit 1; }
ls -la "$HERE/dq.wasm"
log "done: engine/dq.wasm"
sha256sum "$HERE/dq.wasm"
