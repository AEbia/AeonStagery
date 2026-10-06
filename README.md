# AeonStagery

[English](README.md) | [简体中文](README_CN.md)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-0.8.2--beta-informational.svg)
![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![PixiJS](https://img.shields.io/badge/PixiJS-Rendering-E72264?logo=pixijs&logoColor=white)

> AeonStagery is a cinematic scene authoring and playback tool for building visual-novel-style sequences with timeline-driven staging, Live2D character control, layered environments, and export-oriented playback.

---

## Overview

- **Timeline-based Authoring**: Orchestrate dialogue, character staging, camera movements, lighting, audio, and scene actions with fine-grained control.
- **Real-time Preview**: Fluid desktop preview powered by PixiJS and GSAP inside an Electron application.
- **Deterministic Seeking**: Snapshot-based seeking guarantees reliable scrubbing and repeatable playback states.
- **Collaborative Editing**: Room-based collaboration runtime with asset-readiness verification and synchronized scene documents.
- **High-Fidelity Rendering**: Export-ready rendering pipeline built for video production and cinematic scene exports.

## Tech Stack

| Domain | Technologies |
| :--- | :--- |
| **Framework & UI** | React 18, TypeScript, Vite |
| **Desktop Runtime** | Electron |
| **Graphics & Animation** | PixiJS, GSAP |
| **Testing** | Vitest, Electron E2E |
| **Collaboration** | Yjs, WebSocket Standalone Server |

---

## Quick Start

### 1. Installation

Install project dependencies:

```bash
npm install
```

### 2. Running in Development

Run the renderer in your browser, or launch the full Electron desktop app:

```bash
# Start renderer in browser dev mode
npm run dev

# Start Electron desktop app in dev mode
npm run electron:dev

# Start packaged Electron entry against the latest build
npm start
```

---

## Live2D Runtime Setup

> [!WARNING]
> **Live2D runtimes are not distributed with this repository.**
> Any copyright disputes resulting from the use of Live2D shall be borne solely by the creators.

Provide runtimes via environment variables or place them in the local `.local/` directory:

| Runtime family | Environment variable | Fallback path |
| :--- | :--- | :--- |
| Cubism 2.1 core (`live2d.min.js`) | `LIVE2D_CUBISM2_CORE` (file or directory) | `.local/live2d/live2d.min.js` |
| Cubism 3/4/5 Core (`live2dcubismcore.min.js`) | `LIVE2D_CUBISM_CORE` (file or directory) | `.local/live2d/live2dcubismcore.min.js` |

Cubism 3/4/5 uses `untitled-pixi-live2d-engine/cubism`: only the Core script is supplied externally. No SDK checkout, Framework types, or Shader folder is needed. `CUBISM_WEB_SDK_DIR/Core/live2dcubismcore.min.js` remains a fallback for existing setups. Run `npm run sync:live2d-runtime` after supplying the file. In a packaged app, place it in `userData/live2d-runtime/`; existing user runtime files are preserved across upgrades.

---

## Testing & Build

```bash
# Run unit and integration tests
npm test

# Run Electron E2E tests (Linux requires xvfb-run; Windows/macOS launch directly)
npm run test:e2e

# Build renderer and Electron bundles
npm run build

# Create distributable installer package (Windows)
npm run dist:win
```

---

## Collaboration Server

AeonStagery supports multi-user collaboration through a standalone server:

```bash
npm run collab:server
```

The collaboration layer is built around a shared scene document with asset availability checks performed before remote changes are applied locally.

---

## Agent Bridge

Run the project Agent headlessly from the command line, enabling external agents to drive scene edits and inspect results:

```bash
# Execute an agent round on a target scene
npm run agent:bridge -- run --project-dir <project-dir> --scene-rel-path scenes/start.json \
  --message "hi!" \
  --endpoint https://api.example.com/v1 --model your-model

# Inspect persisted conversation results (managed in bridge journal)
npm run agent:bridge -- list --project-id <projectId>
npm run agent:bridge -- show --project-id <projectId> --task-id <taskId>

# Long-lived stdio JSON-RPC session (run / send / pause / cancel / status / result / list / show / close)
npm run agent:bridge -- serve --endpoint ... --model ...
```

---

## Scope & Known Limits

### Supported Scope

- Electron desktop authoring workflow
- Timeline-driven scene editing and playback
- Live2D character animation and custom-motion keyframe editing
- Multi-user collaboration sessions backed by Node.js server
- Architecture documentation indexed by [`docs/adr-status.md`](docs/adr-status.md)

### Known Limits

- **Live2D Compatibility**: Targets supported runtime families (Cubism 2.1 and Cubism 3/4/5 via untitled-pixi-live2d-engine); does not claim generic support for arbitrary Cubism versions.
- **Missing Runtime Handling**: Without configured runtime files, Live2D models fail with an explicit missing-runtime error while the rest of the application remains fully functional.

---

## License

AeonStagery is licensed under the [Apache License 2.0](LICENSE).

See [`NOTICE`](NOTICE) for required attributions and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the licenses of all shipped and bundled third-party components (including FFmpeg under GPL-3.0-or-later, GSAP under the GreenSock Standard License, and bundled OFL fonts).
