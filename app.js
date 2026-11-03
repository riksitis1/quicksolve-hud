/**
 * QuickSolve HUD — Zero-Backend Client-Side Spatial Worksheet Solver
 * Supports unthrottled Web Worker screen-stream countdown, ImageCapture track frame grabbing,
 * clipboard paste, mobile camera capture, drag-and-drop, and 2D spatial bounding-box overlays.
 */

(() => {
  'use strict';

  // =========================================================================
  // 1. CONSTANTS & EXACT SYSTEM PROMPT
  // =========================================================================
  const STORAGE_KEYS = {
    API_KEY: 'gemini_api_key',
    MODEL: 'gemini_model',
    COOLDOWN: 'quicksolve_cooldown',
    AUDIO_CUE: 'quicksolve_audio_cue',
  };

  const DEFAULT_MODEL = 'gemini-3.8-flash';
  const MAX_IMAGE_EDGE = 1600;
  const JPEG_QUALITY = 0.82;
  const DEFAULT_TITLE = 'QuickSolve HUD — Instant Worksheet Solver';

  const SYSTEM_INSTRUCTION = `You are a fast, undetectable worksheet solver. Analyze the screen capture, locate every unanswered question, empty input box, fill-in-the-blank line, or multiple-choice question, and return the exact answers mapped to their 2D spatial coordinates.

STRICT RULES:
1. ZERO YAPPING: Output strictly the JSON array matching the schema. Never include explanations, steps, greetings, or markdown blocks.
2. AUTOMATIC LANGUAGE MATCHING: Detect the exact language used on the worksheet (e.g., Estonian, German, English, Russian) and write each answer in that exact language. If it is a foreign language translation exercise, follow the worksheet's instructions.
3. UNDETECTABLE 8TH-GRADE STYLE:
   - Keep answers as short and direct as possible while still being 100% correct.
   - For open-ended or full-sentence questions, write like a normal 8th-grade student. Use simple, everyday vocabulary and straightforward sentence structure.
   - NEVER use robotic AI phrases ("Furthermore", "In conclusion", "It is important to note", "delve", "testament", "crucial").
   - Do not over-explain. If a 4-word phrase answers the question completely, use 4 words instead of a paragraph.
4. MULTIPLE CHOICE / CHECKBOXES: Place \`box_2d\` directly over the correct choice's checkbox, radio button, or letter, and set \`answer\` to "✓ [Option Letter/Text]".
5. SPATIAL PRECISION: \`box_2d\` must be [ymin, xmin, ymax, xmax] on a 0-1000 scale pinpointing the exact blank spot where the student needs to write or click.`;

  const RESPONSE_SCHEMA = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        id: { type: 'INTEGER' },
        box_2d: {
          type: 'ARRAY',
          items: { type: 'INTEGER' },
        },
        question_label: { type: 'STRING' },
        answer: { type: 'STRING' },
      },
      required: ['id', 'box_2d', 'question_label', 'answer'],
    },
  };

  // =========================================================================
  // 2. DOM ELEMENTS
  // =========================================================================
  const apiKeyInput = document.getElementById('apiKeyInput');
  const toggleKeyVisibilityBtn = document.getElementById('toggleKeyVisibilityBtn');
  const modelSelect = document.getElementById('modelSelect');
  const audioCueCheckbox = document.getElementById('audioCueCheckbox');
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');

  // Stage & Views
  const dropZone = document.getElementById('dropZone');
  const dragOverlay = document.getElementById('dragOverlay');
  const launchpadView = document.getElementById('launchpadView');
  const streamView = document.getElementById('streamView');
  const resultView = document.getElementById('resultView');

  // Capture Launchpad Controls
  const startStreamBtn = document.getElementById('startStreamBtn');
  const pasteCardBtn = document.getElementById('pasteCardBtn');
  const cameraBtn = document.getElementById('cameraBtn');
  const uploadBtn = document.getElementById('uploadBtn');
  const cameraInput = document.getElementById('cameraInput');
  const fileInput = document.getElementById('fileInput');

  // Stream & Cooldown HUD Controls
  const liveVideo = document.getElementById('liveVideo');
  const countdownOverlay = document.getElementById('countdownOverlay');
  const countdownNumber = document.getElementById('countdownNumber');
  const cancelCountdownBtn = document.getElementById('cancelCountdownBtn');
  const cooldownInput = document.getElementById('cooldownInput');
  const delayedCaptureBtn = document.getElementById('delayedCaptureBtn');
  const stopStreamBtn = document.getElementById('stopStreamBtn');

  // Result View Controls
  const backToStreamBtn = document.getElementById('backToStreamBtn');
  const recaptureStreamBtn = document.getElementById('recaptureStreamBtn');
  const newCaptureBtn = document.getElementById('newCaptureBtn');
  const toggleOverlaysBtn = document.getElementById('toggleOverlaysBtn');
  const toggleOverlaysText = document.getElementById('toggleOverlaysText');
  const retrySolveBtn = document.getElementById('retrySolveBtn');
  const imageAspectWrapper = document.getElementById('imageAspectWrapper');
  const capturedImage = document.getElementById('capturedImage');
  const overlayLayer = document.getElementById('overlayLayer');
  const solvingScanner = document.getElementById('solvingScanner');
  const scannerStatusMsg = document.getElementById('scannerStatusMsg');

  // Sidebar Elements
  const answerCountBadge = document.getElementById('answerCountBadge');
  const copyAllBtn = document.getElementById('copyAllBtn');
  const copyAllText = document.getElementById('copyAllText');
  const errorBanner = document.getElementById('errorBanner');
  const errorTitle = document.getElementById('errorTitle');
  const errorMessage = document.getElementById('errorMessage');
  const dismissErrorBtn = document.getElementById('dismissErrorBtn');
  const answersList = document.getElementById('answersList');
  const followUpForm = document.getElementById('followUpForm');
  const followUpInput = document.getElementById('followUpInput');
  const followUpSubmitBtn = document.getElementById('followUpSubmitBtn');

  // =========================================================================
  // 3. APPLICATION STATE
  // =========================================================================
  let mediaStream = null;
  let countdownWorker = null;
  let isCountingDown = false;
  let isSolving = false;
  let currentBase64Jpeg = null;
  let currentDataUrl = null;
  let currentAnswers = [];
  let overlaysHidden = false;
  let holdHideTimer = null;
  let isHoldingHide = false;
  let audioCtx = null;
  let activeAbortController = null;

  // =========================================================================
  // 4. INITIALIZATION & LOCALSTORAGE PERSISTENCE
  // =========================================================================
  function initPersistence() {
    const savedKey = localStorage.getItem(STORAGE_KEYS.API_KEY) || '';
    apiKeyInput.value = savedKey;

    const savedModel = localStorage.getItem(STORAGE_KEYS.MODEL) || DEFAULT_MODEL;
    if ([...modelSelect.options].some((o) => o.value === savedModel)) {
      modelSelect.value = savedModel;
    } else {
      modelSelect.value = DEFAULT_MODEL;
      localStorage.setItem(STORAGE_KEYS.MODEL, DEFAULT_MODEL);
    }

    const savedCooldown = localStorage.getItem(STORAGE_KEYS.COOLDOWN);
    if (savedCooldown !== null) {
      const parsed = clampCooldown(parseInt(savedCooldown, 10));
      cooldownInput.value = String(parsed);
    } else {
      cooldownInput.value = '3';
    }

    const savedAudio = localStorage.getItem(STORAGE_KEYS.AUDIO_CUE);
    if (savedAudio !== null) {
      audioCueCheckbox.checked = savedAudio === 'true';
    }

    updateConnectionBadge();

    apiKeyInput.addEventListener('input', () => {
      const trimmed = apiKeyInput.value.trim();
      localStorage.setItem(STORAGE_KEYS.API_KEY, trimmed);
      updateConnectionBadge();
    });

    toggleKeyVisibilityBtn.addEventListener('click', () => {
      const isPassword = apiKeyInput.type === 'password';
      apiKeyInput.type = isPassword ? 'text' : 'password';
    });

    modelSelect.addEventListener('change', () => {
      localStorage.setItem(STORAGE_KEYS.MODEL, modelSelect.value);
    });

    cooldownInput.addEventListener('change', () => {
      const val = clampCooldown(parseInt(cooldownInput.value, 10));
      cooldownInput.value = String(val);
      localStorage.setItem(STORAGE_KEYS.COOLDOWN, String(val));
    });

    audioCueCheckbox.addEventListener('change', () => {
      localStorage.setItem(STORAGE_KEYS.AUDIO_CUE, String(audioCueCheckbox.checked));
    });
  }

  function clampCooldown(val) {
    if (Number.isNaN(val)) return 3;
    return Math.max(0, Math.min(15, val));
  }

  function setStatus(state, message) {
    statusBadge.className = 'status-badge';
    if (state === 'warn') {
      statusBadge.classList.add('status-warn');
    } else if (state === 'ready') {
      statusBadge.classList.add('status-ready');
    } else if (state === 'busy') {
      statusBadge.classList.add('status-busy');
    } else if (state === 'error') {
      statusBadge.classList.add('status-error');
    }
    statusText.textContent = message;
  }

  function updateConnectionBadge() {
    if (isSolving) return;
    const hasKey = apiKeyInput.value.trim().length > 10;
    if (!hasKey) {
      setStatus('warn', 'No API Key');
    } else if (isStreamActive()) {
      setStatus('ready', 'Stream Ready');
    } else {
      setStatus('ready', 'API Ready');
    }
  }

  // =========================================================================
  // 5. SUBTLE WEB AUDIO API CUES (ANTI-SLEEP + TACTILE FEEDBACK)
  // =========================================================================
  function ensureAudioContext() {
    if (!audioCueCheckbox.checked) return null;
    try {
      if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          audioCtx = new AudioContextClass();
        }
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      return audioCtx;
    } catch {
      return null;
    }
  }

  /**
   * Plays a quiet 60ms low-frequency click when the snapshot fires.
   */
  function playCaptureClick() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.exponentialRampToValueAtTime(65, now + 0.06);

      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.06);
    } catch {
      // Ignore audio errors if blocked
    }
  }

  /**
   * Plays a soft double-click when answers finish loading.
   */
  function playCompletionDoubleClick() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
      [0, 0.085].forEach((offset, idx) => {
        const start = ctx.currentTime + offset;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(idx === 0 ? 190 : 240, start);
        osc.frequency.exponentialRampToValueAtTime(95, start + 0.055);

        gain.gain.setValueAtTime(0.07, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.055);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(start);
        osc.stop(start + 0.055);
      });
    } catch {
      // Ignore audio errors
    }
  }

  // =========================================================================
  // 6. INLINE WEB WORKER (UNTHROTTLED BACKGROUND COOLDOWN TIMER)
  // =========================================================================
  function createCountdownWorker() {
    const workerCode = `
      let timerId = null;
      let remaining = 0;

      self.onmessage = function(e) {
        const data = e.data || {};
        if (data.command === 'start') {
          if (timerId) clearInterval(timerId);
          remaining = Number(data.seconds) || 0;

          if (remaining <= 0) {
            self.postMessage({ type: 'done' });
            return;
          }

          self.postMessage({ type: 'tick', remaining: remaining, isInitial: true });

          timerId = setInterval(() => {
            remaining -= 1;
            if (remaining > 0) {
              self.postMessage({ type: 'tick', remaining: remaining, isInitial: false });
            } else {
              clearInterval(timerId);
              timerId = null;
              self.postMessage({ type: 'done' });
            }
          }, 1000);
        } else if (data.command === 'cancel') {
          if (timerId) {
            clearInterval(timerId);
            timerId = null;
          }
          self.postMessage({ type: 'cancelled' });
        }
      };
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(blobUrl);

    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'tick') {
        handleCountdownTick(msg.remaining, msg.isInitial);
      } else if (msg.type === 'done') {
        handleCountdownComplete();
      } else if (msg.type === 'cancelled') {
        resetCountdownUI();
      }
    };

    return worker;
  }

  function startDelayedCapture() {
    if (!isStreamActive()) {
      showError('Stream Not Active', 'Start a screen stream before triggering delayed capture.');
      return;
    }

    ensureAudioContext();

    const seconds = clampCooldown(parseInt(cooldownInput.value, 10));
    cooldownInput.value = String(seconds);
    localStorage.setItem(STORAGE_KEYS.COOLDOWN, String(seconds));

    // Make sure stream view is visible so user sees the HUD countdown if they are on the result view
    showView('stream');

    if (!countdownWorker) {
      countdownWorker = createCountdownWorker();
    }

    isCountingDown = true;
    countdownWorker.postMessage({ command: 'start', seconds });
  }

  function cancelDelayedCapture() {
    if (countdownWorker && isCountingDown) {
      countdownWorker.postMessage({ command: 'cancel' });
    }
    resetCountdownUI();
  }

  function handleCountdownTick(remaining, isInitial) {
    countdownOverlay.classList.remove('hidden');
    countdownNumber.textContent = String(remaining);
    setStatus('busy', `⏳ ${remaining}s — Switch to Test!`);

    if (isInitial) {
      document.title = `⏳ ${remaining}s - Switch to Test!`;
    } else {
      document.title = `⏳ ${remaining}s...`;
    }
  }

  function resetCountdownUI() {
    isCountingDown = false;
    countdownOverlay.classList.add('hidden');
    document.title = DEFAULT_TITLE;
    updateConnectionBadge();
  }

  async function handleCountdownComplete() {
    isCountingDown = false;
    countdownOverlay.classList.add('hidden');
    document.title = '📸 Solving...';
    playCaptureClick();

    await grabStreamFrameAndSolve();
  }

  // =========================================================================
  // 7. SCREEN STREAMING & CRITICAL DIRECT TRACK FRAME GRABBING
  // =========================================================================
  function isStreamActive() {
    if (!mediaStream) return false;
    const tracks = mediaStream.getVideoTracks();
    return tracks.length > 0 && tracks[0].readyState === 'live';
  }

  async function startScreenStream() {
    hideError();
    try {
      if (isStreamActive()) {
        stopScreenStream(false);
      }

      mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',
          cursor: 'never',
        },
        audio: false,
      });

      liveVideo.srcObject = mediaStream;
      await liveVideo.play().catch(() => {});

      const [videoTrack] = mediaStream.getVideoTracks();
      if (videoTrack) {
        videoTrack.addEventListener('ended', () => {
          stopScreenStream(true);
        });
      }

      showView('stream');
      updateStreamButtonsVisibility();
      updateConnectionBadge();
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') {
        showError('Screen Stream Failed', err.message || 'Unable to start screen capture.');
      }
    }
  }

  function stopScreenStream(resetToLaunchpad = true) {
    cancelDelayedCapture();
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
    liveVideo.srcObject = null;
    updateStreamButtonsVisibility();

    if (resetToLaunchpad && !currentDataUrl) {
      showView('launchpad');
    } else if (resetToLaunchpad && currentDataUrl) {
      showView('launchpad');
      clearResults();
    }
    updateConnectionBadge();
  }

  function updateStreamButtonsVisibility() {
    const active = isStreamActive();
    backToStreamBtn.classList.toggle('hidden', !active);
    recaptureStreamBtn.classList.toggle('hidden', !active);
  }

  /**
   * Extracts a live frame directly from the video track using ImageCapture.grabFrame()
   * (with fallback to drawing liveVideo onto canvas) so background tabs never grab a stale frame.
   */
  async function grabStreamFrameAndSolve() {
    if (!isStreamActive()) {
      showError('Stream Ended', 'The screen stream was stopped before capture completed.');
      return;
    }

    const [videoTrack] = mediaStream.getVideoTracks();
    let frameSource = null;
    let sourceWidth = 0;
    let sourceHeight = 0;

    try {
      if (typeof window.ImageCapture === 'function' && videoTrack) {
        const imageCapture = new window.ImageCapture(videoTrack);
        const bitmap = await imageCapture.grabFrame();
        frameSource = bitmap;
        sourceWidth = bitmap.width;
        sourceHeight = bitmap.height;
      }
    } catch {
      // Fallback to <video> element if ImageCapture fails on a specific browser
      frameSource = null;
    }

    if (!frameSource) {
      sourceWidth = liveVideo.videoWidth || 1920;
      sourceHeight = liveVideo.videoHeight || 1080;
      frameSource = liveVideo;
    }

    processDrawableAndSolve(frameSource, sourceWidth, sourceHeight);
  }

  // =========================================================================
  // 8. IMAGE PRE-PROCESSING (MAX 1600PX, JPEG 0.82)
  // =========================================================================
  function processDrawableAndSolve(drawable, rawWidth, rawHeight) {
    hideError();

    let targetWidth = rawWidth;
    let targetHeight = rawHeight;
    const longestEdge = Math.max(rawWidth, rawHeight);

    if (longestEdge > MAX_IMAGE_EDGE) {
      const scale = MAX_IMAGE_EDGE / longestEdge;
      targetWidth = Math.round(rawWidth * scale);
      targetHeight = Math.round(rawHeight * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(drawable, 0, 0, targetWidth, targetHeight);

    if (typeof drawable.close === 'function') {
      try {
        drawable.close();
      } catch {
        // Ignore ImageBitmap close errors
      }
    }

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, '');

    currentDataUrl = dataUrl;
    currentBase64Jpeg = base64Data;

    // Display inside aspect-ratio locked wrapper
    capturedImage.src = dataUrl;
    imageAspectWrapper.style.aspectRatio = `${targetWidth} / ${targetHeight}`;

    showView('result');
    updateStreamButtonsVisibility();

    // Clear previous overlays & trigger Gemini solver
    clearOverlayAndCardsForNewSolve();
    solveWithGemini();
  }

  function loadFileOrBlobAndSolve(file) {
    if (!file || !file.type.startsWith('image/')) {
      showError('Unsupported File', 'Please provide a valid .png, .jpg, or .webp image.');
      return;
    }

    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      processDrawableAndSolve(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      showError('Image Load Error', 'Could not decode the selected image file.');
    };

    img.src = objectUrl;
  }

  // =========================================================================
  // 9. CLIPBOARD PASTE, CAMERA, & DRAG-AND-DROP LISTENERS
  // =========================================================================
  function initCaptureListeners() {
    // 1. Screen Stream
    startStreamBtn.addEventListener('click', startScreenStream);
    delayedCaptureBtn.addEventListener('click', startDelayedCapture);
    cancelCountdownBtn.addEventListener('click', cancelDelayedCapture);
    stopStreamBtn.addEventListener('click', () => stopScreenStream(true));

    // Result Toolbar navigation
    backToStreamBtn.addEventListener('click', () => {
      if (isStreamActive()) {
        showView('stream');
      }
    });

    recaptureStreamBtn.addEventListener('click', () => {
      if (isStreamActive()) {
        startDelayedCapture();
      }
    });

    newCaptureBtn.addEventListener('click', () => {
      showView('launchpad');
    });

    retrySolveBtn.addEventListener('click', () => {
      if (currentBase64Jpeg) {
        solveWithGemini();
      }
    });

    // 2. Global Clipboard Paste (Ctrl+V)
    window.addEventListener('paste', (e) => {
      const clipboardItems = e.clipboardData && e.clipboardData.items;
      if (!clipboardItems) return;

      for (const item of clipboardItems) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) {
            ensureAudioContext();
            loadFileOrBlobAndSolve(blob);
          }
          return;
        }
      }
    });

    // Clicking the Paste Card attempts Async Clipboard API or prompts Ctrl+V
    pasteCardBtn.addEventListener('click', async () => {
      ensureAudioContext();
      if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imageType = item.types.find((t) => t.startsWith('image/'));
            if (imageType) {
              const blob = await item.getType(imageType);
              loadFileOrBlobAndSolve(blob);
              return;
            }
          }
          showError('No Image in Clipboard', 'Copy a screenshot first, then press Ctrl+V or click here.');
        } catch {
          showError('Press Ctrl+V', 'Press Ctrl+V (or Cmd+V on Mac) anywhere on the page to paste your screenshot.');
        }
      } else {
        showError('Press Ctrl+V', 'Press Ctrl+V (or Cmd+V on Mac) anywhere on the page to paste your screenshot.');
      }
    });

    // 3. Camera Snapshot
    cameraBtn.addEventListener('click', () => {
      ensureAudioContext();
      cameraInput.value = '';
      cameraInput.click();
    });

    cameraInput.addEventListener('change', () => {
      if (cameraInput.files && cameraInput.files[0]) {
        loadFileOrBlobAndSolve(cameraInput.files[0]);
      }
    });

    // 4. File Upload & Drag-and-Drop
    uploadBtn.addEventListener('click', () => {
      ensureAudioContext();
      fileInput.value = '';
      fileInput.click();
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        loadFileOrBlobAndSolve(fileInput.files[0]);
      }
    });

    let dragCounter = 0;
    window.addEventListener('dragenter', (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        dragCounter += 1;
        dragOverlay.classList.remove('hidden');
      }
    });

    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
      }
    });

    window.addEventListener('dragleave', (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        dragCounter = Math.max(0, dragCounter - 1);
        if (dragCounter === 0) {
          dragOverlay.classList.add('hidden');
        }
      }
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      dragOverlay.classList.add('hidden');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        ensureAudioContext();
        loadFileOrBlobAndSolve(e.dataTransfer.files[0]);
      }
    });
  }

  // =========================================================================
  // 10. GEMINI REST API SOLVER & FOLLOW-UP CORRECTIONS
  // =========================================================================
  async function solveWithGemini(followUpInstruction = '') {
    if (!currentBase64Jpeg) return;

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      document.title = DEFAULT_TITLE;
      setStatus('warn', 'Missing API Key');
      showError('Gemini API Key Required', 'Paste your Gemini API Key in the top bar to solve this worksheet.');
      apiKeyInput.focus();
      return;
    }

    const model = modelSelect.value || DEFAULT_MODEL;

    if (activeAbortController) {
      activeAbortController.abort();
    }
    activeAbortController = new AbortController();

    isSolving = true;
    hideError();
    document.title = '📸 Solving...';
    setStatus('busy', '📸 Solving...');
    solvingScanner.classList.remove('hidden');
    scannerStatusMsg.textContent = followUpInstruction
      ? `Updating answers with ${model}...`
      : `📸 Solving worksheet with ${model}...`;

    followUpInput.disabled = true;
    followUpSubmitBtn.disabled = true;

    let userPromptText =
      'Analyze this worksheet image and return the JSON array of all answers with their exact 2D bounding boxes [ymin, xmin, ymax, xmax] on a 0-1000 scale.';

    if (followUpInstruction && currentAnswers.length > 0) {
      userPromptText = `Here is the current JSON answer key for this worksheet:\n${JSON.stringify(
        currentAnswers
      )}\n\nApply this follow-up instruction or correction from the student: "${followUpInstruction}"\nReturn the complete updated JSON array matching the schema.`;
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const payload = {
      systemInstruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }],
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: currentBase64Jpeg,
              },
            },
            {
              text: userPromptText,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.25,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: activeAbortController.signal,
      });

      if (!response.ok) {
        let errDetail = `HTTP ${response.status}`;
        try {
          const errJson = await response.json();
          if (errJson && errJson.error && errJson.error.message) {
            errDetail = errJson.error.message;
          }
        } catch {
          // Ignore JSON parse error on error response
        }
        throw new Error(errDetail);
      }

      const data = await response.json();
      const rawText = extractCandidateText(data);
      const parsedItems = parseAndNormalizeAnswers(rawText);

      currentAnswers = parsedItems;
      renderSpatialOverlaysAndCards(parsedItems);

      document.title = `✅ Ready! (${parsedItems.length} Answers)`;
      setStatus('ready', `✅ Solved (${parsedItems.length})`);
      playCompletionDoubleClick();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      document.title = '⚠️ Solver Error';
      setStatus('error', 'Solver Error');
      showError(
        `API Error (${model})`,
        err.message || 'Failed to reach Gemini API. Check your API key or try switching models in the top bar.'
      );
    } finally {
      isSolving = false;
      solvingScanner.classList.add('hidden');
      const hasImage = Boolean(currentBase64Jpeg);
      followUpInput.disabled = !hasImage;
      followUpSubmitBtn.disabled = !hasImage;
    }
  }

  function extractCandidateText(apiResponse) {
    const candidates = apiResponse && apiResponse.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error('No response candidates returned by Gemini. The image might have been blocked or empty.');
    }
    const parts = candidates[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error('Model returned an empty response payload.');
    }
    const textPart = parts.find((p) => typeof p.text === 'string');
    if (!textPart) {
      throw new Error('Model response did not contain JSON text.');
    }
    return textPart.text;
  }

  function parseAndNormalizeAnswers(rawText) {
    const cleaned = rawText
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error('Failed to parse JSON array from model output.');
    }

    if (!Array.isArray(parsed)) {
      throw new Error('Model output was not a JSON array.');
    }

    return parsed.map((item, idx) => {
      const id = typeof item.id === 'number' ? item.id : idx + 1;
      const box = Array.isArray(item.box_2d) && item.box_2d.length === 4 ? item.box_2d : [100, 100, 140, 260];

      let [ymin, xmin, ymax, xmax] = box.map((n) => Math.max(0, Math.min(1000, Number(n) || 0)));
      if (ymax < ymin) [ymin, ymax] = [ymax, ymin];
      if (xmax < xmin) [xmin, xmax] = [xmax, xmin];

      // Ensure minimum visible box dimension on 0-1000 scale
      if (ymax - ymin < 16) ymax = Math.min(1000, ymin + 18);
      if (xmax - xmin < 24) xmax = Math.min(1000, xmin + 28);

      return {
        id,
        box_2d: [ymin, xmin, ymax, xmax],
        question_label: String(item.question_label || `Q${id}`).trim(),
        answer: String(item.answer ?? '').trim(),
      };
    });
  }

  // =========================================================================
  // 11. SPATIAL OVERLAY RENDERING & SYNCED SIDEBAR CARDS
  // =========================================================================
  function clearOverlayAndCardsForNewSolve() {
    overlayLayer.innerHTML = '';
    currentAnswers = [];
    answerCountBadge.textContent = '0';
    copyAllBtn.disabled = true;
    answersList.innerHTML = `
      <div class="empty-answers">
        <div class="empty-icon">
          <span class="spinner"></span>
        </div>
        <p class="empty-title">Analyzing worksheet...</p>
        <p class="empty-desc">Locating blank inputs and computing spatial coordinates.</p>
      </div>
    `;
  }

  function clearResults() {
    currentDataUrl = null;
    currentBase64Jpeg = null;
    currentAnswers = [];
    overlayLayer.innerHTML = '';
    answerCountBadge.textContent = '0';
    copyAllBtn.disabled = true;
    followUpInput.disabled = true;
    followUpSubmitBtn.disabled = true;
    document.title = DEFAULT_TITLE;
  }

  function renderSpatialOverlaysAndCards(items) {
    overlayLayer.innerHTML = '';
    answersList.innerHTML = '';
    answerCountBadge.textContent = String(items.length);
    copyAllBtn.disabled = items.length === 0;

    if (items.length === 0) {
      answersList.innerHTML = `
        <div class="empty-answers">
          <p class="empty-title">No unanswered questions detected</p>
          <p class="empty-desc">Use the follow-up bar below to specify which question you want solved.</p>
        </div>
      `;
      return;
    }

    items.forEach((item) => {
      const [ymin, xmin, ymax, xmax] = item.box_2d;

      // Exact percentage mapping from 0-1000 scale
      const leftPct = xmin / 10;
      const topPct = ymin / 10;
      const widthPct = (xmax - xmin) / 10;
      const heightPct = (ymax - ymin) / 10;

      // 1. Create Spatial Overlay Box
      const boxEl = document.createElement('div');
      boxEl.className = 'spatial-box';
      boxEl.dataset.id = String(item.id);
      boxEl.style.left = `${leftPct}%`;
      boxEl.style.top = `${topPct}%`;
      boxEl.style.width = `${widthPct}%`;
      boxEl.style.height = `${heightPct}%`;

      if (ymin < 75) {
        boxEl.classList.add('pill-bottom');
      }
      if (xmin > 720) {
        boxEl.classList.add('pill-right');
      }

      const pillEl = document.createElement('div');
      pillEl.className = 'spatial-pill';

      const pillIdEl = document.createElement('span');
      pillIdEl.className = 'spatial-pill-id';
      pillIdEl.textContent = `#${item.id}`;

      const pillTextEl = document.createElement('span');
      pillTextEl.className = 'spatial-pill-text';
      pillTextEl.textContent = item.answer;

      pillEl.appendChild(pillIdEl);
      pillEl.appendChild(pillTextEl);
      boxEl.appendChild(pillEl);

      // 2. Create Synced Sidebar Answer Card
      const cardEl = document.createElement('div');
      cardEl.className = 'answer-card';
      cardEl.dataset.id = String(item.id);

      cardEl.innerHTML = `
        <div class="answer-card-top">
          <div class="answer-meta">
            <span class="answer-id-pill">#${escapeHtml(String(item.id))}</span>
            <span class="answer-label">${escapeHtml(item.question_label)}</span>
          </div>
          <button type="button" class="copy-card-btn" title="Copy answer">
            <span>Copy</span>
          </button>
        </div>
        <div class="answer-value">${escapeHtml(item.answer)}</div>
      `;

      const copyBtn = cardEl.querySelector('.copy-card-btn');
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyTextToClipboard(item.answer, copyBtn);
      });

      // Bidirectional Highlighting & Click Interactions
      boxEl.addEventListener('mouseenter', () => setItemHighlight(item.id, true));
      boxEl.addEventListener('mouseleave', () => setItemHighlight(item.id, false));
      boxEl.addEventListener('click', (e) => {
        e.stopPropagation();
        boxEl.classList.toggle('is-expanded');
        setItemHighlight(item.id, true);
        cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });

      cardEl.addEventListener('mouseenter', () => setItemHighlight(item.id, true));
      cardEl.addEventListener('mouseleave', () => setItemHighlight(item.id, false));
      cardEl.addEventListener('click', () => {
        setItemHighlight(item.id, true);
        boxEl.classList.toggle('is-expanded');
        boxEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });

      overlayLayer.appendChild(boxEl);
      answersList.appendChild(cardEl);
    });
  }

  function setItemHighlight(id, active) {
    const selector = `[data-id="${CSS.escape(String(id))}"]`;
    overlayLayer.querySelectorAll(selector).forEach((el) => {
      el.classList.toggle('is-highlighted', active);
    });
    answersList.querySelectorAll(selector).forEach((el) => {
      el.classList.toggle('is-highlighted', active);
    });
  }

  // =========================================================================
  // 12. OVERLAY VISIBILITY TOGGLE (HOLD OR CLICK) & COPY UTILITIES
  // =========================================================================
  function initToolbarAndSidebarEvents() {
    // Support both Press-and-Hold peek AND single-click toggle on "Hold/Click to Hide Overlays"
    toggleOverlaysBtn.addEventListener('pointerdown', () => {
      isHoldingHide = false;
      holdHideTimer = setTimeout(() => {
        isHoldingHide = true;
        setOverlaysHiddenState(true);
      }, 180);
    });

    const releaseHold = () => {
      if (holdHideTimer) {
        clearTimeout(holdHideTimer);
        holdHideTimer = null;
      }
      if (isHoldingHide) {
        setOverlaysHiddenState(false);
        isHoldingHide = false;
      }
    };

    toggleOverlaysBtn.addEventListener('pointerup', releaseHold);
    toggleOverlaysBtn.addEventListener('pointerleave', releaseHold);
    toggleOverlaysBtn.addEventListener('pointercancel', releaseHold);

    toggleOverlaysBtn.addEventListener('click', () => {
      if (!isHoldingHide) {
        setOverlaysHiddenState(!overlaysHidden);
      }
    });

    // Copy All button
    copyAllBtn.addEventListener('click', async () => {
      if (!currentAnswers.length) return;
      const formatted = currentAnswers
        .map((a) => `#${a.id} (${a.question_label}): ${a.answer}`)
        .join('\n');
      try {
        await navigator.clipboard.writeText(formatted);
        copyAllText.textContent = 'Copied!';
        setTimeout(() => {
          copyAllText.textContent = 'Copy All';
        }, 1400);
      } catch {
        // Ignore clipboard errors
      }
    });

    // Follow-Up / Correction form submission
    followUpForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const instruction = followUpInput.value.trim();
      if (!instruction || !currentBase64Jpeg || isSolving) return;
      followUpInput.value = '';
      solveWithGemini(instruction);
    });

    dismissErrorBtn.addEventListener('click', hideError);
  }

  function setOverlaysHiddenState(hidden) {
    overlaysHidden = hidden;
    overlayLayer.classList.toggle('overlays-hidden', hidden);
    toggleOverlaysBtn.classList.toggle('active-toggle', hidden);
    toggleOverlaysText.textContent = hidden ? 'Show Overlays' : 'Hold/Click to Hide Overlays';
  }

  async function copyTextToClipboard(text, btnEl) {
    try {
      await navigator.clipboard.writeText(text);
      const span = btnEl.querySelector('span');
      const prev = span ? span.textContent : 'Copy';
      btnEl.classList.add('copied');
      if (span) span.textContent = 'Copied!';
      setTimeout(() => {
        btnEl.classList.remove('copied');
        if (span) span.textContent = prev;
      }, 1200);
    } catch {
      // Fallback copy
    }
  }

  // =========================================================================
  // 13. VIEW SWITCHING & ERROR HELPERS
  // =========================================================================
  function showView(viewName) {
    launchpadView.classList.toggle('hidden', viewName !== 'launchpad');
    streamView.classList.toggle('hidden', viewName !== 'stream');
    resultView.classList.toggle('hidden', viewName !== 'result');
  }

  function showError(title, message) {
    errorTitle.textContent = title;
    errorMessage.textContent = message;
    errorBanner.classList.remove('hidden');
  }

  function hideError() {
    errorBanner.classList.add('hidden');
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // =========================================================================
  // 14. BOOTSTRAP
  // =========================================================================
  initPersistence();
  initCaptureListeners();
  initToolbarAndSidebarEvents();
})();

