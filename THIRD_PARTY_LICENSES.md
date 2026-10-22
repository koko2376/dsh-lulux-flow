# Third-party licenses

DSH-LULUX Flow is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).
This file lists the third-party software that ships inside the published
package, and records what the project did **not** take from other projects.

## What ships, and where

| Artifact | Contents |
|---|---|
| `lib/index.js` (host plugin) | Only this project's own code. Every dependency (`@deepseek-ai/*`) is a peer dependency resolved from the DSH installation at runtime and is **not** bundled. |
| `lib/client.js` (browser bundle) | This project's own code plus the packages below. React and react-dom are **not** bundled; they come from DSH's shared browser platform. |

The versions below are the ones pinned in `pnpm-lock.yaml` for release 0.1.0.
`@xyflow/react` is the only direct dependency; the rest are its transitive
dependencies.

| Package | Version | License | Copyright |
|---|---|---|---|
| [@xyflow/react](https://github.com/xyflow/xyflow) | 12.12.0 | MIT | Copyright (c) 2019-2025 webkid GmbH |
| [@xyflow/system](https://github.com/xyflow/xyflow) | 0.0.83 | MIT | Copyright (c) 2019-2025 webkid GmbH |
| [classcat](https://github.com/jorgebucaran/classcat) | 5.0.5 | MIT | Copyright © Jorge Bucaran |
| [zustand](https://github.com/pmndrs/zustand) | 4.5.7 | MIT | Copyright (c) 2019 Paul Henschel |
| [use-sync-external-store](https://github.com/facebook/react) | 1.7.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| [d3-color](https://github.com/d3/d3-color) | 3.1.0 | ISC | Copyright 2010-2022 Mike Bostock |
| [d3-dispatch](https://github.com/d3/d3-dispatch) | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| [d3-drag](https://github.com/d3/d3-drag) | 3.0.0 | ISC | Copyright 2010-2021 Mike Bostock |
| [d3-interpolate](https://github.com/d3/d3-interpolate) | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| [d3-selection](https://github.com/d3/d3-selection) | 3.0.0 | ISC | Copyright 2010-2021 Mike Bostock |
| [d3-timer](https://github.com/d3/d3-timer) | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| [d3-transition](https://github.com/d3/d3-transition) | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| [d3-zoom](https://github.com/d3/d3-zoom) | 3.0.0 | ISC | Copyright 2010-2021 Mike Bostock |
| [d3-ease](https://github.com/d3/d3-ease) | 3.0.1 | BSD-3-Clause | Copyright 2010-2021 Mike Bostock |

When a dependency is upgraded, update this table from the lockfile and the
package's own `LICENSE` file.

## License texts

### MIT License

Applies to @xyflow/react, @xyflow/system, classcat, zustand and
use-sync-external-store, each under its copyright line above.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC License

Applies to d3-color, d3-dispatch, d3-drag, d3-interpolate, d3-selection,
d3-timer, d3-transition and d3-zoom, each under its copyright line above.

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### BSD 3-Clause License

Applies to d3-ease. Its license text, verbatim:

```
Copyright 2010-2021 Mike Bostock
Copyright 2001 Robert Penner
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Artwork

The kernel avatars in `client/assets/avatars/` and `icon.svg` are original
artwork by the author (koko), licensed with this project under Apache-2.0.
They are not official logos of the tools they represent.

## Prior art: ideas only, no code

The workflow canvas was designed after looking at two other projects. Only
ideas were taken; **no source code, assets or text were copied** from either:

- **Ekko Studio**: general ideas about presenting agent work visually.
- **Workflow One** ([chumingjun/dsh-harness-one](https://github.com/chumingjun/dsh-harness-one), MIT): the idea of a DAG canvas of DSH agents with webhook and cron triggers.

Development and test tooling (TypeScript, Vitest, ESLint, esbuild, Testing
Library, jsdom and others in `devDependencies`) is used only to build and test
the project and is not redistributed in the package.
