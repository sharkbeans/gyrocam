# GyroCam — Visual Horizon Stabilizer

A mobile web app that reads device gyroscope data and counter-rotates the camera preview to keep the horizon visually level. The camera feed is displayed inside a circular viewport with real-time tilt indicators.

**This is a visual stabilization overlay, not hardware stabilization.**

## Features

- Rear camera access with circular viewport
- Gyroscope-driven horizon stabilization via CSS rotation
- Low-pass filter for smooth, jitter-free motion
- Horizon indicator line (green = level, red = tilted)
- Numeric tilt readout in degrees
- Calibration button to set a custom zero-reference
- Smoothing on/off toggle
- FPS and debug panel
- Landscape orientation hint
- iOS Safari permission handling
- Graceful fallbacks for unsupported browsers

## Setup

No build tools or dependencies required. The project is four static files:

```
index.html
style.css
script.js
README.md
```

### Local Development

Serve the files over HTTPS. The simplest options:

```bash
# Using Python (HTTP only — fine for localhost testing)
python -m http.server 8000

# Using npx with HTTPS (recommended for testing sensors)
npx http-server --ssl
```

Open `https://localhost:8080` on your mobile device (or use `localhost` on desktop for camera-only testing).

### Deploy to GitHub Pages

1. Push all files to a GitHub repository
2. Go to **Settings → Pages**
3. Set source to **main branch** (root `/`)
4. Save — your site will be live at `https://<username>.github.io/<repo>/`

GitHub Pages serves over HTTPS automatically, which is required for camera and sensor APIs.

## Why HTTPS is Required

The `getUserMedia` (camera) and `DeviceOrientationEvent` (gyroscope) APIs are restricted to **secure contexts**. Browsers block these APIs on plain HTTP to protect user privacy. GitHub Pages provides HTTPS by default.

## Browser Compatibility

| Browser | Camera | Gyroscope | Notes |
|---------|--------|-----------|-------|
| Android Chrome (latest) | Yes | Yes | Full support |
| iOS Safari 13+ | Yes | Yes | Requires user-gesture permission prompt |
| Desktop Chrome | Yes | No | Camera works; no gyroscope on most desktops |
| Desktop Firefox | Yes | No | Same as Chrome |
| Desktop Safari | Yes | No | Same as Chrome |

## How It Works

1. **Camera**: `getUserMedia` requests the rear camera; the video stream renders inside a circular `overflow: hidden` container
2. **Sensors**: `DeviceOrientationEvent` provides `gamma` (left/right tilt in degrees)
3. **Stabilization**: If the device tilts +N°, the video is CSS-rotated −N° to compensate, keeping the horizon level
4. **Smoothing**: A low-pass filter (`smoothed += alpha * (raw - smoothed)`) reduces sensor noise; `alpha ≈ 0.12` balances responsiveness and stability
5. **Render loop**: `requestAnimationFrame` drives all visual updates — sensor callbacks only store raw values

## Known Limitations

- **Not hardware stabilization** — this is a visual CSS rotation overlay only
- **Black corners**: The video is scaled ~1.45× to prevent black corners during rotation, which crops the image slightly
- **Sensor availability**: Desktop browsers typically lack gyroscope hardware; the app will show camera but cannot stabilize
- **iOS permission**: iOS 13+ requires a user-initiated gesture to request motion permission — the "Enable Motion" button handles this
- **Extreme tilt**: At extreme angles (>45°) the gamma value wraps and stabilization degrades
- **No portrait lock**: The app suggests portrait orientation but cannot force it without a PWA manifest

## Security

- Runs entirely client-side — no data leaves the device
- No analytics, no external API calls, no cookies
- Calibration offset is stored in memory only (lost on reload)
- Requires HTTPS for all sensor/camera APIs

## License

MIT
