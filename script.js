/**
 * GyroCam — Visual Horizon Stabilizer
 *
 * Reads device orientation and counter-rotates the camera preview to keep
 * the horizon visually level inside a circular viewport.
 *
 * Sensor strategy (dual-API for maximum compatibility):
 *   1. Generic Sensor API (AbsoluteOrientationSensor) — Android Chrome 67+
 *      Provides quaternion orientation, converted to Euler gamma equivalent.
 *      More reliable and properly permission-gated on Android.
 *   2. DeviceOrientationEvent — iOS Safari 13+ fallback
 *      Uses gamma (left/right tilt). Requires requestPermission() on iOS.
 *
 * Key concepts:
 *   - gamma: left/right tilt in degrees (−90 to 90)
 *   - Rotation inversion: device tilts +N° → rotate video −N° to compensate
 *   - Low-pass filter smooths noisy sensor data to reduce jitter
 *   - requestAnimationFrame drives visual updates (never inside sensor callbacks)
 */

const GyroCam = (() => {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────
  const SMOOTHING_ALPHA = 0.12;        // Low-pass filter coefficient (0 = no change, 1 = no smoothing)
  const LEVEL_THRESHOLD_DEG = 1.5;     // Degrees within which we consider "level"
  const TILTED_THRESHOLD_DEG = 10;     // Degrees beyond which we consider "very tilted"
  const FPS_SAMPLE_INTERVAL_MS = 500;  // How often to update FPS display
  const SENSOR_FREQUENCY_HZ = 60;      // Generic Sensor API sampling rate
  const RAD_TO_DEG = 180 / Math.PI;

  // ─── DOM References (cached once) ────────────────────────────────
  const dom = {
    camera: document.getElementById('camera'),
    horizonLine: document.getElementById('horizon-line'),
    tiltValue: document.getElementById('tilt-value'),
    statusBadge: document.getElementById('status-badge'),
    btnCamera: document.getElementById('btn-camera'),
    btnMotion: document.getElementById('btn-motion'),
    btnCalibrate: document.getElementById('btn-calibrate'),
    toggleSmoothing: document.getElementById('toggle-smoothing'),
    toggleDebug: document.getElementById('toggle-debug'),
    debugPanel: document.getElementById('debug-panel'),
    fpsDisplay: document.getElementById('fps-display'),
    rawGamma: document.getElementById('raw-gamma'),
    smoothGamma: document.getElementById('smooth-gamma'),
    errorMessage: document.getElementById('error-message'),
    landscapeHint: document.getElementById('landscape-hint'),
  };

  // ─── State ───────────────────────────────────────────────────────
  const state = {
    cameraStream: null,
    motionEnabled: false,
    smoothingEnabled: true,
    sensorType: 'none',       // 'generic-sensor' | 'device-orientation' | 'none'

    rawGamma: 0,              // Latest raw gamma from sensor (degrees)
    smoothedGamma: 0,         // After low-pass filter
    calibrationOffset: 0,     // Stored offset from calibration
    hasReceivedData: false,   // True once we get a non-zero sensor reading

    sensorInstance: null,     // Generic Sensor API instance (if used)
    animFrameId: null,        // requestAnimationFrame handle
    lastFrameTime: 0,         // For FPS calculation
    frameCount: 0,
    currentFps: 0,
  };

  // ─── Camera ──────────────────────────────────────────────────────

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('Camera API is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      state.cameraStream = stream;
      dom.camera.srcObject = stream;

      // iOS Safari: ensure inline playback
      dom.camera.setAttribute('playsinline', '');
      dom.camera.setAttribute('muted', '');
      await dom.camera.play();

      dom.btnCamera.textContent = 'Camera Active';
      dom.btnCamera.disabled = true;
      dom.btnMotion.disabled = false;

      hideError();
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        showError('Camera permission denied. Please allow camera access and reload.');
      } else if (err.name === 'NotFoundError') {
        showError('No camera found on this device.');
      } else {
        showError('Camera error: ' + err.message);
      }
    }
  }

  // ─── Motion Sensors ──────────────────────────────────────────────

  /**
   * Main entry point for enabling motion. Tries the best available API:
   *   1. Generic Sensor API (AbsoluteOrientationSensor) — Android Chrome
   *   2. DeviceOrientationEvent — iOS Safari and others
   *
   * Must be called from a user gesture (button tap) for permissions to work.
   */
  async function enableMotion() {
    // Try Generic Sensor API first (Android Chrome)
    const genericOk = await tryGenericSensor();
    if (genericOk) {
      onMotionReady('generic-sensor');
      return;
    }

    // Fall back to DeviceOrientationEvent (iOS Safari, older browsers)
    const doeOk = await tryDeviceOrientation();
    if (doeOk) {
      onMotionReady('device-orientation');
      return;
    }

    showError(
      'Motion sensors unavailable. Ensure you are on a mobile device, ' +
      'using HTTPS, and have granted sensor permissions in browser settings.'
    );
  }

  /**
   * Called when a sensor API is successfully activated.
   */
  function onMotionReady(sensorType) {
    state.sensorType = sensorType;
    state.motionEnabled = true;

    dom.btnMotion.textContent = 'Motion Active';
    dom.btnMotion.disabled = true;
    dom.btnCalibrate.disabled = false;

    startRenderLoop();
    hideError();
  }

  // ─── Strategy 1: Generic Sensor API ──────────────────────────────

  /**
   * Attempts to use AbsoluteOrientationSensor (Chromium 67+).
   * Returns true if successfully started, false otherwise.
   *
   * This API provides a quaternion [x, y, z, w] representing device
   * orientation relative to Earth. We convert to Euler angles to extract
   * the gamma-equivalent (left/right tilt).
   */
  async function tryGenericSensor() {
    if (!('AbsoluteOrientationSensor' in window)) {
      return false;
    }

    // Check permissions via Permissions API (Chromium)
    try {
      const results = await Promise.all([
        navigator.permissions.query({ name: 'accelerometer' }),
        navigator.permissions.query({ name: 'gyroscope' }),
        navigator.permissions.query({ name: 'magnetometer' }),
      ]);

      const denied = results.some(r => r.state === 'denied');
      if (denied) {
        return false;
      }
    } catch (e) {
      // Permissions API query not supported for these names — continue anyway
    }

    return new Promise((resolve) => {
      try {
        const sensor = new AbsoluteOrientationSensor({
          frequency: SENSOR_FREQUENCY_HZ,
          referenceFrame: 'device',
        });

        let resolved = false;

        sensor.addEventListener('reading', () => {
          // quaternion: [x, y, z, w]
          const q = sensor.quaternion;
          if (q) {
            /**
             * Convert quaternion to gamma (left/right tilt) in degrees.
             *
             * Using standard aerospace Euler angle extraction for the
             * "bank" angle (rotation around the forward axis):
             *   gamma = atan2(2*(qw*qx + qy*qz), 1 - 2*(qx² + qy²))
             *
             * This gives us the equivalent of DeviceOrientationEvent.gamma.
             */
            const x = q[0], y = q[1], z = q[2], w = q[3];
            const gamma = Math.atan2(
              2 * (w * y + x * z),
              1 - 2 * (y * y + x * x)
            ) * RAD_TO_DEG;

            if (!Number.isNaN(gamma)) {
              state.rawGamma = gamma;
              state.hasReceivedData = true;
            }
          }

          if (!resolved) {
            resolved = true;
            state.sensorInstance = sensor;
            resolve(true);
          }
        });

        sensor.addEventListener('error', (event) => {
          if (!resolved) {
            resolved = true;
            resolve(false);
          }
        });

        // Timeout: if no reading within 2 seconds, give up
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            try { sensor.stop(); } catch (e) { /* ignore */ }
            resolve(false);
          }
        }, 2000);

        sensor.start();
      } catch (err) {
        // SecurityError = blocked by Permissions-Policy
        // ReferenceError = API not available
        resolve(false);
      }
    });
  }

  // ─── Strategy 2: DeviceOrientationEvent ──────────────────────────

  /**
   * Attempts to use the legacy DeviceOrientationEvent.
   * On iOS 13+, requestPermission() must be called from a user gesture.
   * Returns true if the event starts providing data.
   */
  async function tryDeviceOrientation() {
    if (!('DeviceOrientationEvent' in window)) {
      return false;
    }

    // iOS 13+ requires explicit permission via requestPermission()
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== 'granted') {
          return false;
        }
      } catch (err) {
        return false;
      }
    }

    return new Promise((resolve) => {
      let resolved = false;
      let attempts = 0;

      function handler(event) {
        attempts++;
        const gamma = event.gamma;

        // Some browsers fire an initial event with null/zero — wait for real data
        if (gamma != null && !Number.isNaN(gamma)) {
          state.rawGamma = gamma;

          // Accept on first non-null reading, or after a few attempts
          // (gamma can legitimately be 0 if device is flat)
          if (gamma !== 0 || attempts > 5) {
            state.hasReceivedData = true;
          }
        }

        if (!resolved && attempts >= 3) {
          resolved = true;
          // Even if we only got zeros, keep listening — the device might be flat
          resolve(true);
        }
      }

      window.addEventListener('deviceorientation', handler);

      // Also listen for the 'absolute' variant (some Android browsers prefer it)
      window.addEventListener('deviceorientationabsolute', (event) => {
        if (event.gamma != null && !Number.isNaN(event.gamma)) {
          state.rawGamma = event.gamma;
          state.hasReceivedData = true;
        }
      });

      // Store reference for cleanup
      state._doeHandler = handler;

      // Timeout: if no events at all within 2 seconds, assume it won't work
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (attempts > 0) {
            // We got events, even if zero — consider it working
            resolve(true);
          } else {
            // No events at all — sensor not available
            window.removeEventListener('deviceorientation', handler);
            resolve(false);
          }
        }
      }, 2000);
    });
  }

  // ─── Smoothing (Low-Pass Filter) ────────────────────────────────

  /**
   * Applies an exponential low-pass filter to reduce sensor jitter.
   *
   * Formula:  smoothed = smoothed + alpha * (raw - smoothed)
   *
   * - alpha near 0 → very smooth but laggy
   * - alpha near 1 → responsive but jittery
   * - 0.12 is a good balance for handheld use
   */
  function applySmoothing(raw) {
    if (!state.smoothingEnabled) {
      state.smoothedGamma = raw;
      return raw;
    }

    const prev = state.smoothedGamma;

    // Guard against NaN propagation
    if (Number.isNaN(prev)) {
      state.smoothedGamma = raw;
      return raw;
    }

    state.smoothedGamma = prev + SMOOTHING_ALPHA * (raw - prev);
    return state.smoothedGamma;
  }

  // ─── Calibration ─────────────────────────────────────────────────

  function calibrate() {
    state.calibrationOffset = state.smoothedGamma;
    dom.btnCalibrate.textContent = 'Recalibrate';
  }

  // ─── Render Loop ─────────────────────────────────────────────────

  function startRenderLoop() {
    if (state.animFrameId) return;
    state.lastFrameTime = performance.now();
    state.frameCount = 0;
    tick(performance.now());
  }

  function tick(now) {
    state.animFrameId = requestAnimationFrame(tick);

    // ── FPS tracking ──
    state.frameCount++;
    const elapsed = now - state.lastFrameTime;
    if (elapsed >= FPS_SAMPLE_INTERVAL_MS) {
      state.currentFps = Math.round((state.frameCount / elapsed) * 1000);
      state.frameCount = 0;
      state.lastFrameTime = now;
    }

    // ── Compute smoothed, calibrated tilt ──
    const smoothed = applySmoothing(state.rawGamma);
    const corrected = smoothed - state.calibrationOffset;

    // ── Rotation inversion: tilt +N° → rotate −N° to stabilize ──
    const rotation = -corrected;

    // ── Apply CSS transform (translate keeps video centered in circle) ──
    dom.camera.style.transform =
      'translate(-50%, -50%) rotate(' + rotation + 'deg)';

    // ── Update tilt readout ──
    const absTilt = Math.abs(corrected);
    dom.tiltValue.textContent = corrected.toFixed(1) + '\u00B0';

    // ── Update horizon line color and status badge ──
    if (absTilt <= LEVEL_THRESHOLD_DEG) {
      dom.horizonLine.className = 'level';
      dom.statusBadge.className = 'level';
      dom.statusBadge.textContent = 'LEVEL';
    } else if (absTilt <= TILTED_THRESHOLD_DEG) {
      dom.horizonLine.className = '';
      dom.statusBadge.className = 'tilted';
      dom.statusBadge.textContent = 'TILTED';
    } else {
      dom.horizonLine.className = 'tilted';
      dom.statusBadge.className = 'very-tilted';
      dom.statusBadge.textContent = 'TILTED';
    }

    // ── Debug panel ──
    if (!dom.debugPanel.classList.contains('hidden')) {
      dom.fpsDisplay.textContent = 'FPS: ' + state.currentFps;
      dom.rawGamma.textContent = 'Raw: ' + state.rawGamma.toFixed(1);
      dom.smoothGamma.textContent = 'Smooth: ' + smoothed.toFixed(1);
    }
  }

  // ─── Landscape Detection ─────────────────────────────────────────

  function checkOrientation() {
    const isLandscape = window.innerWidth > window.innerHeight;
    dom.landscapeHint.classList.toggle('hidden', !isLandscape);
  }

  // ─── Error Display ───────────────────────────────────────────────

  function showError(msg) {
    dom.errorMessage.textContent = msg;
    dom.errorMessage.classList.remove('hidden');
  }

  function hideError() {
    dom.errorMessage.classList.add('hidden');
  }

  // ─── HTTPS Check ─────────────────────────────────────────────────

  function checkSecureContext() {
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      showError('HTTPS is required for camera and motion sensor access. Please serve this page over HTTPS.');
      dom.btnCamera.disabled = true;
      return false;
    }
    return true;
  }

  // ─── Desktop Detection ───────────────────────────────────────────

  function checkMobileCapabilities() {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!isMobile) {
      showError(
        'This app is designed for mobile devices with gyroscope sensors. ' +
        'Camera will work, but stabilization requires a mobile device.'
      );
    }
  }

  // ─── Event Binding ───────────────────────────────────────────────

  function bindEvents() {
    dom.btnCamera.addEventListener('click', startCamera);
    dom.btnMotion.addEventListener('click', enableMotion);
    dom.btnCalibrate.addEventListener('click', calibrate);

    dom.toggleSmoothing.addEventListener('change', (e) => {
      state.smoothingEnabled = e.target.checked;
    });

    dom.toggleDebug.addEventListener('change', (e) => {
      dom.debugPanel.classList.toggle('hidden', !e.target.checked);
    });

    window.addEventListener('resize', checkOrientation);
    checkOrientation();
  }

  // ─── Cleanup ─────────────────────────────────────────────────────

  function destroy() {
    if (state.animFrameId) {
      cancelAnimationFrame(state.animFrameId);
      state.animFrameId = null;
    }

    if (state.sensorInstance) {
      try { state.sensorInstance.stop(); } catch (e) { /* ignore */ }
      state.sensorInstance = null;
    }

    if (state._doeHandler) {
      window.removeEventListener('deviceorientation', state._doeHandler);
    }

    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((track) => track.stop());
      state.cameraStream = null;
    }
  }

  // ─── Init ────────────────────────────────────────────────────────

  function init() {
    const secure = checkSecureContext();
    if (secure) {
      checkMobileCapabilities();
    }
    bindEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { destroy };
})();
