# PARALLAX

A gravity-shift runner in the browser. Roll forward, turn the world ninety degrees at a time, and use walls as floors.

**Play:** https://ishankhandekar.github.io/Parallax/

Built with Three.js (bloom post-processing) and the Web Audio API. Every sound is synthesised in code, and there are no image, model or audio files.

## Controls

| Key | Action |
|---|---|
| A / D or ← / → | Steer |
| Q / E or Space | Shift gravity 90° left / right |
| Shift (hold) | Focus: slow motion |
| R | Restart |
| M | Sound on/off |
| P or Esc | Pause |

## Run locally

The game is two static files with no build step. It has to be served over HTTP rather than opened as a file, because it uses ES modules:

```bash
python -m http.server 8123
```

Then open http://localhost:8123.
