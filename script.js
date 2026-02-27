/**
 * GyroCam — Visual Horizon Stabilizer
 *
 * Reads device orientation (gyroscope) and counter-rotates the camera
 * preview to keep the horizon visually level inside a circular viewport.
 *
 * Key concepts:
 *   - gamma: left/right tilt in degrees (−90 to 90)
 *   - Rotation inversion: if device tilts +N°, we rotate video −N° to compensate
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

    rawGamma: 0,              // Latest raw gamma from sensor
    smoothedGamma: 0,         // After low-pass filter
    calibrationOffset: 0,     // Stored offset from calibration

    animFrameId: null,        // requestAnimationFrame handle
    lastFrameTime: 0,         // For FPS calculation
    frameCount: 0,
    currentFps: 0,
  };

  // ─── Camera ──────────────────────────────────────────────────────

  /**
   * Requests rear camera access via getUserMedia.
   * Sets the video element source and enables the motion button on success.
   */
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
   * Enables device orientation listening.
   * On iOS 13+, requestPermission() must be called from a user gesture.
   */
  async function enableMotion() {
    if (!('DeviceOrientationEvent' in window)) {
      showError('Device orientation sensors are not available. This feature requires a mobile device with a gyroscope.');
      return;
    }

    // iOS 13+ requires explicit permission request triggered by user gesture
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== 'granted') {
          showError('Motion sensor permission denied.');
          return;
        }
      } catch (err) {
        showError('Motion permission error: ' + err.message);
        return;
      }
    }

    window.addEventListener('deviceorientation', onDeviceOrientation);
    state.motionEnabled = true;

    dom.btnMotion.textContent = 'Motion Active';
    dom.btnMotion.disabled = true;
    dom.btnCalibrate.disabled = false;

    startRenderLoop();
    hideError();
  }

  /**
   * Sensor callback — only stores raw value, never touches DOM.
   * Visual updates happen exclusively in the rAF render loop.
   *
   * @param {DeviceOrientationEvent} event
   */
  function onDeviceOrientation(event) {
    const gamma = event.gamma;
    // Guard against null/undefined/NaN that some browsers emit
    if (gamma == null || Number.isNaN(gamma)) return;
    state.rawGamma = gamma;
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
   *
   * @param {number} raw - Current raw sensor value
   * @returns {number} Filtered value
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

  /**
   * Sets the current smoothed gamma as the zero-reference point.
   * All future rotations will be relative to this baseline.
   */
  function calibrate() {
    state.calibrationOffset = state.smoothedGamma;
    dom.btnCalibrate.textContent = 'Recalibrate';
  }

  // ─── Render Loop ─────────────────────────────────────────────────

  /**
   * Starts the requestAnimationFrame loop for visual updates.
   * All DOM manipulation happens here, not in sensor callbacks.
   */
  function startRenderLoop() {
    if (state.animFrameId) return; // Already running
    state.lastFrameTime = performance.now();
    state.frameCount = 0;
    tick(performance.now());
  }

  /**
   * Single frame update. Computes corrected rotation and updates DOM.
   *
   * @param {DOMHighResTimeStamp} now
   */
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

    // ── Update horizon line color ──
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
      showError('This app is designed for mobile devices with gyroscope sensors. Camera will work, but stabilization requires a mobile device.');
    }
  }

  // ─── Event Binding ───────────────────────────────────────────────

  function bindEvents() {
    // Buttons — all require user gesture (important for iOS permission model)
    dom.btnCamera.addEventListener('click', startCamera);
    dom.btnMotion.addEventListener('click', enableMotion);
    dom.btnCalibrate.addEventListener('click', calibrate);

    // Toggles
    dom.toggleSmoothing.addEventListener('change', (e) => {
      state.smoothingEnabled = e.target.checked;
    });

    dom.toggleDebug.addEventListener('change', (e) => {
      dom.debugPanel.classList.toggle('hidden', !e.target.checked);
    });

    // Orientation change
    window.addEventListener('resize', checkOrientation);
    checkOrientation();
  }

  // ─── Cleanup (for completeness, called if app were to unmount) ──

  function destroy() {
    if (state.animFrameId) {
      cancelAnimationFrame(state.animFrameId);
      state.animFrameId = null;
    }

    window.removeEventListener('deviceorientation', onDeviceOrientation);

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

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose destroy for potential cleanup
  return { destroy };
})();
