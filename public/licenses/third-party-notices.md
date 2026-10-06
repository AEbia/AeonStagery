# Third-Party Notices

AeonStagery itself is licensed under the Apache License 2.0 (see `LICENSE`).

This file lists third-party components that are either copied into the packaged application (`node_modules`) or bundled into the built renderer/main bundles. Each component remains under its own license; the Apache-2.0 license of AeonStagery does not apply to them.

## Who is NOT bundled

Live2D Cubism Core scripts (`live2d.min.js`, `live2dcubismcore.min.js`) are **never** part of a release build. They are proprietary Live2D software and must be obtained and staged locally by the user. Only the internal verification build (`npm run dist:win:verify`) contains them, and that build must never be redistributed.

The Cubism 3/4/5 framework and shaders are bundled through `untitled-pixi-live2d-engine/cubism`; no external SDK checkout is required. Live2D-derived framework code remains subject to Live2D license terms.

## License summary

| License | Packages |
| --- | --- |
| (MPL-2.0 OR Apache-2.0) | 1 |
| Apache-2.0 | 1 |
| BlueOak-1.0.0 | 1 |
| BSD-3-Clause | 3 |
| GPL-3.0-or-later | 1 |
| GreenSock Standard License | 1 |
| ISC | 4 |
| MIT | 56 |
| Python-2.0 | 1 |

## Bundled / shipped packages

| Package | Version | License | Source |
| --- | --- | --- | --- |
| `@derhuerst/http-basic` | 8.2.4 | MIT | [npm](https://registry.npmjs.org/@derhuerst/http-basic/-/http-basic-8.2.4.tgz) |
| `@monaco-editor/loader` | 1.7.0 | MIT | [npm](https://registry.npmjs.org/@monaco-editor/loader/-/loader-1.7.0.tgz) |
| `@monaco-editor/react` | 4.7.0 | MIT | [npm](https://registry.npmjs.org/@monaco-editor/react/-/react-4.7.0.tgz) |
| `@pixi/colord` | 2.9.6 | MIT | [npm](https://registry.npmjs.org/@pixi/colord/-/colord-2.9.6.tgz) |
| `@pixi/sound` | 6.0.1 | MIT | [npm](https://registry.npmjs.org/@pixi/sound/-/sound-6.0.1.tgz) |
| `@types/earcut` | 3.0.0 | MIT | [npm](https://registry.npmjs.org/@types/earcut/-/earcut-3.0.0.tgz) |
| `@types/gradient-parser` | 0.1.5 | MIT | [npm](https://registry.npmjs.org/@types/gradient-parser/-/gradient-parser-0.1.5.tgz) |
| `@types/node` | 10.17.60 | MIT | [npm](https://registry.npmjs.org/@types/node/-/node-10.17.60.tgz) |
| `@types/trusted-types` | 2.0.7 | MIT | [npm](https://registry.npmjs.org/@types/trusted-types/-/trusted-types-2.0.7.tgz) |
| `@webgpu/types` | 0.1.74 | BSD-3-Clause | [npm](https://registry.npmjs.org/@webgpu/types/-/types-0.1.74.tgz) |
| `@xmldom/xmldom` | 0.8.15 | MIT | [npm](https://registry.npmjs.org/@xmldom/xmldom/-/xmldom-0.8.15.tgz) |
| `agent-base` | 6.0.2 | MIT | [npm](https://registry.npmjs.org/agent-base/-/agent-base-6.0.2.tgz) |
| `argparse` | 2.0.1 | Python-2.0 | [npm](https://registry.npmjs.org/argparse/-/argparse-2.0.1.tgz) |
| `buffer-from` | 1.1.2 | MIT | [npm](https://registry.npmjs.org/buffer-from/-/buffer-from-1.1.2.tgz) |
| `builder-util-runtime` | 9.7.0 | MIT | [npm](https://registry.npmjs.org/builder-util-runtime/-/builder-util-runtime-9.7.0.tgz) |
| `caseless` | 0.12.0 | Apache-2.0 | [npm](https://registry.npmjs.org/caseless/-/caseless-0.12.0.tgz) |
| `concat-stream` | 2.0.0 | MIT | [npm](https://registry.npmjs.org/concat-stream/-/concat-stream-2.0.0.tgz) |
| `debug` | 4.4.3 | MIT | [npm](https://registry.npmjs.org/debug/-/debug-4.4.3.tgz) |
| `dompurify` | 3.2.7 | (MPL-2.0 OR Apache-2.0) | [npm](https://registry.npmjs.org/dompurify/-/dompurify-3.2.7.tgz) |
| `earcut` | 3.2.3 | ISC | [npm](https://registry.npmjs.org/earcut/-/earcut-3.2.3.tgz) |
| `electron-updater` | 6.8.9 | MIT | [npm](https://registry.npmjs.org/electron-updater/-/electron-updater-6.8.9.tgz) |
| `env-paths` | 2.2.1 | MIT | [npm](https://registry.npmjs.org/env-paths/-/env-paths-2.2.1.tgz) |
| `eventemitter3` | 5.0.4 | MIT | [npm](https://registry.npmjs.org/eventemitter3/-/eventemitter3-5.0.4.tgz) |
| `ffmpeg-static` | 5.3.0 | GPL-3.0-or-later | [npm](https://registry.npmjs.org/ffmpeg-static/-/ffmpeg-static-5.3.0.tgz) |
| `fs-extra` | 10.1.0 | MIT | [npm](https://registry.npmjs.org/fs-extra/-/fs-extra-10.1.0.tgz) |
| `gifuct-js` | 2.1.2 | MIT | [npm](https://registry.npmjs.org/gifuct-js/-/gifuct-js-2.1.2.tgz) |
| `graceful-fs` | 4.2.11 | ISC | [npm](https://registry.npmjs.org/graceful-fs/-/graceful-fs-4.2.11.tgz) |
| `gsap` | 3.15.0 | GreenSock Standard License | [npm](https://registry.npmjs.org/gsap/-/gsap-3.15.0.tgz) |
| `http-response-object` | 3.0.2 | MIT | [npm](https://registry.npmjs.org/http-response-object/-/http-response-object-3.0.2.tgz) |
| `https-proxy-agent` | 5.0.1 | MIT | [npm](https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-5.0.1.tgz) |
| `inherits` | 2.0.4 | ISC | [npm](https://registry.npmjs.org/inherits/-/inherits-2.0.4.tgz) |
| `ismobilejs` | 1.1.1 | MIT | [npm](https://registry.npmjs.org/ismobilejs/-/ismobilejs-1.1.1.tgz) |
| `isomorphic.js` | 0.2.5 | MIT | [npm](https://registry.npmjs.org/isomorphic.js/-/isomorphic.js-0.2.5.tgz) |
| `js-binary-schema-parser` | 2.0.3 | MIT | [npm](https://registry.npmjs.org/js-binary-schema-parser/-/js-binary-schema-parser-2.0.3.tgz) |
| `js-tokens` | 4.0.0 | MIT | [npm](https://registry.npmjs.org/js-tokens/-/js-tokens-4.0.0.tgz) |
| `js-yaml` | 4.1.1 | MIT | [npm](https://registry.npmjs.org/js-yaml/-/js-yaml-4.1.1.tgz) |
| `jsonfile` | 6.2.1 | MIT | [npm](https://registry.npmjs.org/jsonfile/-/jsonfile-6.2.1.tgz) |
| `lazy-val` | 1.0.5 | MIT | [npm](https://registry.npmjs.org/lazy-val/-/lazy-val-1.0.5.tgz) |
| `lib0` | 0.2.117 | MIT | [npm](https://registry.npmjs.org/lib0/-/lib0-0.2.117.tgz) |
| `lodash.escaperegexp` | 4.1.2 | MIT | [npm](https://registry.npmjs.org/lodash.escaperegexp/-/lodash.escaperegexp-4.1.2.tgz) |
| `lodash.isequal` | 4.5.0 | MIT | [npm](https://registry.npmjs.org/lodash.isequal/-/lodash.isequal-4.5.0.tgz) |
| `loose-envify` | 1.4.0 | MIT | [npm](https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz) |
| `marked` | 14.0.0 | MIT | [npm](https://registry.npmjs.org/marked/-/marked-14.0.0.tgz) |
| `monaco-editor` | 0.55.1 | MIT | [npm](https://registry.npmjs.org/monaco-editor/-/monaco-editor-0.55.1.tgz) |
| `ms` | 2.1.3 | MIT | [npm](https://registry.npmjs.org/ms/-/ms-2.1.3.tgz) |
| `parse-cache-control` | 1.0.1 | BSD-3-Clause | [npm](https://registry.npmjs.org/parse-cache-control/-/parse-cache-control-1.0.1.tgz) |
| `parse-svg-path` | 0.2.0 | MIT | [npm](https://registry.npmjs.org/parse-svg-path/-/parse-svg-path-0.2.0.tgz) |
| `pend` | 1.2.0 | MIT | [npm](https://registry.npmjs.org/pend/-/pend-1.2.0.tgz) |
| `pixi-filters` | 6.1.5 | MIT | [npm](https://registry.npmjs.org/pixi-filters/-/pixi-filters-6.1.5.tgz) |
| `pixi.js` | 8.21.0 | MIT | [npm](https://registry.npmjs.org/pixi.js/-/pixi.js-8.21.0.tgz) |
| `progress` | 2.0.3 | MIT | [npm](https://registry.npmjs.org/progress/-/progress-2.0.3.tgz) |
| `react` | 18.3.1 | MIT | [npm](https://registry.npmjs.org/react/-/react-18.3.1.tgz) |
| `react-dom` | 18.3.1 | MIT | [npm](https://registry.npmjs.org/react-dom/-/react-dom-18.3.1.tgz) |
| `readable-stream` | 3.6.2 | MIT | [npm](https://registry.npmjs.org/readable-stream/-/readable-stream-3.6.2.tgz) |
| `safe-buffer` | 5.1.2 | MIT | [npm](https://registry.npmjs.org/safe-buffer/-/safe-buffer-5.1.2.tgz) |
| `sax` | 1.6.0 | BlueOak-1.0.0 | [npm](https://registry.npmjs.org/sax/-/sax-1.6.0.tgz) |
| `scheduler` | 0.23.2 | MIT | [npm](https://registry.npmjs.org/scheduler/-/scheduler-0.23.2.tgz) |
| `semver` | 7.7.4 | ISC | [npm](https://registry.npmjs.org/semver/-/semver-7.7.4.tgz) |
| `state-local` | 1.0.7 | MIT | [npm](https://registry.npmjs.org/state-local/-/state-local-1.0.7.tgz) |
| `string_decoder` | 1.1.1 | MIT | [npm](https://registry.npmjs.org/string_decoder/-/string_decoder-1.1.1.tgz) |
| `tiny-lru` | 11.4.7 | BSD-3-Clause | [npm](https://registry.npmjs.org/tiny-lru/-/tiny-lru-11.4.7.tgz) |
| `tiny-typed-emitter` | 2.1.0 | MIT | [npm](https://registry.npmjs.org/tiny-typed-emitter/-/tiny-typed-emitter-2.1.0.tgz) |
| `typedarray` | 0.0.6 | MIT | [npm](https://registry.npmjs.org/typedarray/-/typedarray-0.0.6.tgz) |
| `universalify` | 2.0.1 | MIT | [npm](https://registry.npmjs.org/universalify/-/universalify-2.0.1.tgz) |
| `untitled-pixi-live2d-engine` | 1.4.0 | MIT | [npm](https://registry.npmjs.org/untitled-pixi-live2d-engine/-/untitled-pixi-live2d-engine-1.4.0.tgz) |
| `util-deprecate` | 1.0.2 | MIT | [npm](https://registry.npmjs.org/util-deprecate/-/util-deprecate-1.0.2.tgz) |
| `ws` | 8.21.0 | MIT | [npm](https://registry.npmjs.org/ws/-/ws-8.21.0.tgz) |
| `yauzl` | 3.4.0 | MIT | [npm](https://registry.npmjs.org/yauzl/-/yauzl-3.4.0.tgz) |
| `yjs` | 13.6.31 | MIT | [npm](https://registry.npmjs.org/yjs/-/yjs-13.6.31.tgz) |

## Components requiring specific attention

### FFmpeg (`ffmpeg-static`)

- License: **GPL-3.0-or-later** (the binary and the `ffmpeg-static` wrapper package).
- Usage boundary: AeonStagery only ever executes FFmpeg as a **separate child process** (`spawn` / `execFile`). It is not linked into the application, so AeonStagery remains Apache-2.0 while the FFmpeg executable keeps its own GPL-3.0 terms.
- Binary source: `ffmpeg-static` release builds — Windows x64 from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), Linux from [johnvansickle.com](https://johnvansickle.com/ffmpeg/), macOS from [evermeet.cx](https://evermeet.cx/ffmpeg/) / [osxexperts.net](https://osxexperts.net/).
- Corresponding FFmpeg source: <https://git.ffmpeg.org/ffmpeg.git> and <https://ffmpeg.org/download.html>. The full GPL-3.0 text ships in `public/licenses/ffmpeg/GPL-3.0.txt`; `node_modules/ffmpeg-static/ffmpeg.exe.LICENSE` is copied into the packaged app alongside the binary.
- Users may point the exporter at their own FFmpeg build instead of the bundled binary.

### GSAP (GreenSock Animation Platform)

- License: **GreenSock Standard License** (`no charge` license), which is not an OSI license and does not permit selling the library itself. It is bundled into the renderer bundle as an animation runtime.
- License text: <https://gsap.com/standard-license/>.

### Fonts

- JetBrains Mono, Noto Sans SC and Outfit are bundled under the SIL Open Font License 1.1; the full texts ship in `public/licenses/fonts/`.

### Live2D runtimes (user-supplied)

- `live2d.min.js` (Cubism 2.1 core) and `live2dcubismcore.min.js` (Cubism 3/4/5 Core) are covered by Live2D Inc. license terms; see <https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html> and <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>.
- They are staged locally by the user (see <https://github.com/AEbia/aeonstagery#live2d-runtimes-are-not-part-of-the-repository>) and are the user's responsibility to license.

## License texts for separately bundled packages

These packages are bundled into the renderer from development dependencies, so their license files are reproduced here rather than relying on packaged `node_modules` files.

### @pixi/sound@6.0.1 (MIT)

```text
MIT License

Copyright (c) 2017 Matt Karl, LLC

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

### untitled-pixi-live2d-engine@1.4.0 (MIT)

```text
MIT License

Copyright (c) 2026 GuangChen2333

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

## Regenerating

```bash
npm run notices          # regenerate this file
npm run notices:check    # CI: fail when the file is stale
```
