# SCIRE web page

The web page of SCIRE (Source-grounded Coaching Intelligence through Reverse Engineering): what a learner sees and runs in the browser.

SCIRE teaches from a learner's own material, asks questions, grades practice and schedules reviews. This repository holds the part that
runs in the browser. It talks to a SCIRE server over HTTP; the server is not part of this repository.

## What is here

| Path | What it is |
|---|---|
| `tutor.html` | The page: styles, the app script and every screen (welcome, sign-in, Home, Ask, Practice, Review, Progress, Settings) |
| `sw.js` | The service worker that keeps the page and a learner's saved material on the device, so SCIRE works offline |
| `offline/` | The offline engine in plain ES modules: local store, search, practice, mastery, the outbox that syncs later, mode switching |
| `offline-model/` | Source of the optional on-device AI bundle (WebLLM on WebGPU); `npm run build` writes `dist/offline-model.js` |
| `knowledge-map/` | Source of the progress map (React Flow); `npm run build` writes `dist/knowledge-map.js` |
| `dist/` | The built bundles and their third-party licenses |
| `icons/` | The app icons |

There is no build step for the page itself: `tutor.html`, `sw.js` and `offline/` are used as they are.

## Rebuilding a bundle

```bash
cd knowledge-map && npm ci && npm run build     # writes ../dist/knowledge-map.js
cd offline-model && npm ci && npm run build     # writes ../dist/offline-model.js
```

Commit the rebuilt `dist/` files together with the source change.

## License

Copyright (c) 2026 Tojoarisoa. All rights reserved.

This source is public so that it can be read. It is not licensed for reuse: it may not be copied, modified, redistributed or used in
another project without the author's written permission. Third-party code in `dist/` stays under its own licenses, reproduced in the
`THIRD-PARTY-LICENSES*.txt` files next to it.
