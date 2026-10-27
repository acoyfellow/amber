# Third-party notices

`engine/dq.wasm` is compiled from the projects below. `engine/wasi.patch` is the only change made to
dquickts (it disables Atomics and the native stack check under WASI). `engine/setup.sh` pins the exact
sources.

## dquickts / QuickJS

Source: https://github.com/stencil-hq/dquickts (commit f9a3efaa4d7cadb9dcad7e80a03d2774eb95a406)

```
QuickJS Javascript Engine

Copyright (c) 2017-2021 Fabrice Bellard
Copyright (c) 2017-2021 Charlie Gordon
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## wasi-libc (via wasi-sdk 34)

Source: https://github.com/WebAssembly/wasi-sdk and https://github.com/WebAssembly/wasi-libc

The C standard library linked into the module comes from wasi-libc, which is distributed under the
Apache License 2.0 with LLVM Exceptions, the MIT License, or CC0. It includes code from musl libc
(MIT). See the wasi-libc repository for the full license texts.
