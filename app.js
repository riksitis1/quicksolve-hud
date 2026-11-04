/**
 * QuickSolve HUD — Nutikas töölehtede ja töövihikute lahendaja
 * - Näitab täpselt KUHU paberil kirjutada (where_to_write: trükitud tekst/valem enne lünka)
 * - Kui ühel real on mitu lünka, tähistab täpselt mis käib 1. lünka, 2. lünka jne
 * - Näitab loomulikku 8. klassi õpilase lahenduskäiku (steps) ja lõppvastust (answer)
 * - Täpne box_2d joondus otse trükitud rea kõrgusele
 */

(() => {
  'use strict';

  // =========================================================================
  // 1. KONSTANDID JA SÜSTEEMIPROMPT
  // =========================================================================
  const STORAGE_KEYS = {
    API_KEY: 'gemini_api_key',
    MODEL: 'gemini_model',
    COOLDOWN: 'quicksolve_cooldown',
    GUIDE_DISMISSED: 'quicksolve_guide_dismissed',
  };

  const DEFAULT_MODEL = 'gemini-3.8-flash';
  const MODEL_ALIASES = {
    'gemini-2.5-flash': 'gemini-3.8-flash',
    'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite',
    'gemini-2.5-pro': 'gemini-4-argon',
    'gemini-2.0-flash': 'gemini-3.8-flash',
  };
  const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon'];

  const MAX_IMAGE_EDGE = 2000;
  const JPEG_QUALITY = 0.9;
  const REQUEST_TIMEOUT_MS = 90000;
  const MAX_CACHE_ENTRIES = 20;
  const RETRYABLE_STATUSES = [404, 408, 429, 500, 502, 503, 504];
  const DEFAULT_TITLE = 'QuickSolve HUD — Nutikas töölehtede lahendaja';

  const SYSTEM_INSTRUCTION = `You are an elite, fast, undetectable school worksheet and workbook solver. Analyze the image with extreme visual precision, locate every unanswered question, empty table cell/rectangle after an "=" sign, fill-in-the-blank line, matching box, or multiple-choice question, and return the exact location guide, natural student solution steps, and final answer mapped to 2D coordinates.

STRICT RULES:
1. ZERO YAPPING: Output strictly the JSON array matching the schema.
2. AUTOMATIC LANGUAGE MATCHING: Detect the exact language used on the worksheet (e.g., Estonian, English, German, Russian) and write \`question_label\`, \`where_to_write\`, \`steps\`, and \`answer\` in that exact language.
3. CRYSTAL-CLEAR LOCATION GUIDE (\`where_to_write\`):
   - On a phone screen, the student needs to know IMMEDIATELY which exact printed equation, table cell, or line on their paper this answer belongs to.
   - Set \`where_to_write\` to quote the exact printed text/formula right before the blank (e.g., \`'Ül 52 tabel (2. rida, vasak kast): "6xy - 5x + 3x² - 10y ="'\` or \`'Ül 51 rida 1) "12·28 - 28·11 = ... = ... = ..."' \` or \`'Ül 52 alumine osa, rida 1) ".......... = .........."' \`).
4. MULTI-BLANK CLARITY (WHEN A LINE HAS MULTIPLE BLANKS):
   - If a single row has multiple blanks (such as \`1) ....... = ....... = ....... | Ristsumma: .......\` or \`1) ....... = .......\`), create ONE item for that row and clearly label what goes into each blank inside \`answer\` and \`steps\`!
   - Example for \`1) 12·28 - 28·11 = ... = ... = ...\`:
     * \`steps\`: \`"1. lünk: 28·(12 - 11) | 2. lünk: 28·1 | 3. lünk: 28 | Ristsumma: 2 + 8 = 10"\`
     * \`answer\`: \`"28·(12-11) = 28·1 = 28  (Ristsumma: 2+8 = 10)"\`
   - Example for \`1) [avaldis] = [ava sulud]\`:
     * \`steps\`: \`"1. lünk (enne = märki): (7x + 10)(1 - 3y) | 2. lünk (pärast = märki): 7x - 21xy + 10 - 30y"\`
     * \`answer\`: \`"(7x + 10)(1 - 3y) = 7x - 21xy + 10 - 30y"\`
5. NATURAL 8TH-GRADE STUDENT SOLUTION PROCESS (\`steps\`):
   - Write intermediate calculation or factoring steps the way a real 8th-grade student writes in their workbook so the teacher sees full work.
   - For polynomial factoring by grouping (e.g. \`6xy - 5x + 3x² - 10y\`), group terms that share a common factor (even if you rearrange 1st & 4th terms: \`(6xy - 10y) + (3x² - 5x) = 2y(3x - 5) + x(3x - 5) = (x + 2y)(3x - 5)\`). Verify by expanding your factored result that it matches one of the answer boxes on the worksheet!
6. EXACT \`box_2d\` SPATIAL CALIBRATION:
   - \`box_2d\` [ymin, xmin, ymax, xmax] (0–1000 scale) must be anchored at the EXACT vertical height (\`ymin\` to \`ymax\`) of the printed line or empty box where the student writes.
   - For numbered lines \`1)\`, \`2)\`, \`3)\`, \`ymin\` and \`ymax\` MUST be on the exact same horizontal row as the printed \`1)\`, \`2)\`, \`3)\` — never shift the box down onto the text below!
   - For table cells with a printed formula at the top of the cell, place \`box_2d\` inside the empty writing space of that specific cell.`;

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
        where_to_write: { type: 'STRING' },
        steps: { type: 'STRING' },
        answer: { type: 'STRING' },
      },
      required: ['id', 'box_2d', 'question_label', 'where_to_write', 'steps', 'answer'],
    },
  };

  // =========================================================================
  // 2. DOM ELEMENDID
  // =========================================================================
  const apiKeyInput = document.getElementById('apiKeyInput');
  const toggleKeyVisibilityBtn = document.getElementById('toggleKeyVisibilityBtn');
  const openGuideBtn = document.getElementById('openGuideBtn');
  const modelSelect = document.getElementById('modelSelect');
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');

  // API Võtme juhend
  const onboardingCard = document.getElementById('onboardingCard');
  const closeGuideBtn = document.getElementById('closeGuideBtn');
  const guideApiKeyInput = document.getElementById('guideApiKeyInput');
  const saveGuideKeyBtn = document.getElementById('saveGuideKeyBtn');

  // Mobiilse vaate vahetaja
  const mainWorkspace = document.getElementById('mainWorkspace');
  const mobileTabSwitcher = document.getElementById('mobileTabSwitcher');
  const mobTabImage = document.getElementById('mobTabImage');
  const mobTabAnswers = document.getElementById('mobTabAnswers');
  const mobAnswerCount = document.getElementById('mobAnswerCount');

  // Vaated
  const dragOverlay = document.getElementById('dragOverlay');
  const launchpadView = document.getElementById('launchpadView');
  const streamView = document.getElementById('streamView');
  const resultView = document.getElementById('resultView');

  // Allika valiku nupud
  const startStreamBtn = document.getElementById('startStreamBtn');
  const pasteCardBtn = document.getElementById('pasteCardBtn');
  const cameraBtn = document.getElementById('cameraBtn');
  const uploadBtn = document.getElementById('uploadBtn');
  const cameraInput = document.getElementById('cameraInput');
  const fileInput = document.getElementById('fileInput');

  // Ekraanivoo HUD nupud
  const liveVideo = document.getElementById('liveVideo');
  const countdownOverlay = document.getElementById('countdownOverlay');
  const countdownNumber = document.getElementById('countdownNumber');
  const cancelCountdownBtn = document.getElementById('cancelCountdownBtn');
  const cooldownInput = document.getElementById('cooldownInput');
  const delayedCaptureBtn = document.getElementById('delayedCaptureBtn');
  const stopStreamBtn = document.getElementById('stopStreamBtn');

  // Tulemuste vaate nupud
  const backToStreamBtn = document.getElementById('backToStreamBtn');
  const recaptureStreamBtn = document.getElementById('recaptureStreamBtn');
  const newCaptureBtn = document.getElementById('newCaptureBtn');
  const togglePinModeBtn = document.getElementById('togglePinModeBtn');
  const togglePinModeText = document.getElementById('togglePinModeText');
  const toggleOverlaysBtn = document.getElementById('toggleOverlaysBtn');
  const toggleOverlaysText = document.getElementById('toggleOverlaysText');
  const retrySolveBtn = document.getElementById('retrySolveBtn');
  const imageAspectWrapper = document.getElementById('imageAspectWrapper');
  const capturedImage = document.getElementById('capturedImage');
  const overlayLayer = document.getElementById('overlayLayer');
  const solvingScanner = document.getElementById('solvingScanner');
  const scannerStatusMsg = document.getElementById('scannerStatusMsg');

  // Alumine valitud ülesande kiirvaade (#activePinInspector)
  const activePinInspector = document.getElementById('activePinInspector');
  const inspIdBadge = document.getElementById('inspIdBadge');
  const inspQuestionLabel = document.getElementById('inspQuestionLabel');
  const inspPrevBtn = document.getElementById('inspPrevBtn');
  const inspNextBtn = document.getElementById('inspNextBtn');
  const inspCloseBtn = document.getElementById('inspCloseBtn');
  const inspLocationRow = document.getElementById('inspLocationRow');
  const inspStepsRow = document.getElementById('inspStepsRow');
  const inspFinalAnswer = document.getElementById('inspFinalAnswer');
  const inspCopyBtn = document.getElementById('inspCopyBtn');

  // Külgpaneeli elemendid
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
  // 3. RAKENDUSE OLEK
  // =========================================================================
  let mediaStream = null;
  let countdownWorker = null;
  let isCountingDown = false;
  let isSolving = false;
  let currentBase64Jpeg = null;
  let currentDataUrl = null;
  let currentImageSignature = '';
  let currentAnswers = [];
  let selectedPinIndex = 0;
  let compactPinMode = true;
  let overlaysHidden = false;
  let holdHideTimer = null;
  let isHoldingHide = false;
  let suppressNextToggleClick = false;
  let activeAbortController = null;
  let solveRequestId = 0;

  const responseCache = new Map();

  // =========================================================================
  // 4. SEADISTUSTE SALVESTAMINE JA API VÕTME JUHEND
  // =========================================================================
  function resolveModelName(rawModel) {
    if (!rawModel) return DEFAULT_MODEL;
    return MODEL_ALIASES[rawModel] || rawModel;
  }

  function initPersistenceAndGuide() {
    const savedKey = (localStorage.getItem(STORAGE_KEYS.API_KEY) || '').trim();
    apiKeyInput.value = savedKey;
    guideApiKeyInput.value = savedKey;

    const rawSavedModel = localStorage.getItem(STORAGE_KEYS.MODEL) || DEFAULT_MODEL;
    const resolvedModel = resolveModelName(rawSavedModel);
    if ([...modelSelect.options].some((o) => o.value === resolvedModel)) {
      modelSelect.value = resolvedModel;
      localStorage.setItem(STORAGE_KEYS.MODEL, resolvedModel);
    } else {
      modelSelect.value = DEFAULT_MODEL;
      localStorage.setItem(STORAGE_KEYS.MODEL, DEFAULT_MODEL);
    }

    const savedCooldown = localStorage.getItem(STORAGE_KEYS.COOLDOWN);
    if (savedCooldown !== null) {
      cooldownInput.value = String(clampCooldown(parseInt(savedCooldown, 10)));
    } else {
      cooldownInput.value = '3';
    }

    const hasValidKey = savedKey.length > 15;
    const guideDismissed = localStorage.getItem(STORAGE_KEYS.GUIDE_DISMISSED) === 'true';
    if (hasValidKey || guideDismissed) {
      onboardingCard.classList.add('hidden');
    } else {
      onboardingCard.classList.remove('hidden');
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      startStreamBtn.classList.add('hidden');
    }

    updateConnectionBadge();

    apiKeyInput.addEventListener('input', () => {
      const trimmed = apiKeyInput.value.trim();
      guideApiKeyInput.value = trimmed;
      localStorage.setItem(STORAGE_KEYS.API_KEY, trimmed);
      updateConnectionBadge();
    });

    guideApiKeyInput.addEventListener('input', () => {
      const trimmed = guideApiKeyInput.value.trim();
      apiKeyInput.value = trimmed;
      localStorage.setItem(STORAGE_KEYS.API_KEY, trimmed);
      updateConnectionBadge();
    });

    saveGuideKeyBtn.addEventListener('click', () => {
      const trimmed = guideApiKeyInput.value.trim();
      if (trimmed.length < 15) {
        guideApiKeyInput.focus();
        showError('Vigane API võti', 'Kopeeri Google AI Studiost täispikk API võti (algab tähtedega AIza...).');
        return;
      }
      apiKeyInput.value = trimmed;
      localStorage.setItem(STORAGE_KEYS.API_KEY, trimmed);
      localStorage.setItem(STORAGE_KEYS.GUIDE_DISMISSED, 'true');
      onboardingCard.classList.add('hidden');
      hideError();
      updateConnectionBadge();
    });

    openGuideBtn.addEventListener('click', () => {
      showView('launchpad');
      onboardingCard.classList.remove('hidden');
      guideApiKeyInput.focus();
    });

    closeGuideBtn.addEventListener('click', () => {
      localStorage.setItem(STORAGE_KEYS.GUIDE_DISMISSED, 'true');
      onboardingCard.classList.add('hidden');
    });

    toggleKeyVisibilityBtn.addEventListener('click', () => {
      const isPassword = apiKeyInput.type === 'password';
      apiKeyInput.type = isPassword ? 'text' : 'password';
      guideApiKeyInput.type = isPassword ? 'text' : 'password';
    });

    modelSelect.addEventListener('change', () => {
      localStorage.setItem(STORAGE_KEYS.MODEL, modelSelect.value);
    });

    cooldownInput.addEventListener('change', () => {
      const val = clampCooldown(parseInt(cooldownInput.value, 10));
      cooldownInput.value = String(val);
      localStorage.setItem(STORAGE_KEYS.COOLDOWN, String(val));
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
    const hasKey = apiKeyInput.value.trim().length > 15;
    if (!hasKey) {
      setStatus('warn', 'Lisa API võti');
    } else if (isStreamActive()) {
      setStatus('ready', 'Otsepilt valmis');
    } else {
      setStatus('ready', 'Valmis');
    }
  }

  // =========================================================================
  // 5. HÄÄLETU TAUSTATAIMER (WEB WORKER)
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
      showError('Ekraanivoog pole aktiivne', 'Alusta esmalt ekraani jagamist.');
      return;
    }

    const seconds = clampCooldown(parseInt(cooldownInput.value, 10));
    cooldownInput.value = String(seconds);
    localStorage.setItem(STORAGE_KEYS.COOLDOWN, String(seconds));

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
    setStatus('busy', `⏳ ${remaining}s — Ava test!`);

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
    await grabStreamFrameAndSolve();
  }

  // =========================================================================
  // 6. ULTRA HD EKRAANIJAGAMINE JA KAADRI HAARAMINE
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
          width: { ideal: 2560, max: 3840 },
          height: { ideal: 1440, max: 2160 },
          frameRate: { ideal: 30 },
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
        showError('Ekraani jagamine ebaõnnestus', err.message || 'Ekraani jagamist ei õnnestunud käivitada.');
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

    if (resetToLaunchpad) {
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

  async function grabStreamFrameAndSolve() {
    if (!isStreamActive()) {
      showError('Ekraanivoog lõppes', 'Ekraani jagamine peatati enne pildi tegemist.');
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
  // 7. PILDI TERAVUSTAMINE JA EELTÖÖTLUS
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

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = 'contrast(1.06)';
    ctx.drawImage(drawable, 0, 0, targetWidth, targetHeight);

    if (typeof drawable.close === 'function') {
      try {
        drawable.close();
      } catch {
        // Ignoreeri
      }
    }

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, '');

    currentDataUrl = dataUrl;
    currentBase64Jpeg = base64Data;
    currentImageSignature = `${base64Data.length}_${base64Data.slice(0, 48)}_${base64Data.slice(-48)}`;

    capturedImage.src = dataUrl;
    imageAspectWrapper.style.aspectRatio = `${targetWidth} / ${targetHeight}`;

    showView('result');
    setMobileTab('image');
    updateStreamButtonsVisibility();

    clearOverlayAndCardsForNewSolve();
    solveWithGemini('', false);
  }

  function loadFileOrBlobAndSolve(file) {
    if (!file || !file.type.startsWith('image/')) {
      showError('Sobimatu failitüüp', 'Palun vali .png, .jpg või .webp pildifail.');
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
      showError('Pildi laadimise viga', 'Valitud pildifaili ei õnnestunud avada.');
    };

    img.src = objectUrl;
  }

  // =========================================================================
  // 8. KUULAJAD (KAAMERA, LÕIKELAUD, FAILID, MOBIILSED VAHEKAARDID)
  // =========================================================================
  function initCaptureListeners() {
    startStreamBtn.addEventListener('click', startScreenStream);
    delayedCaptureBtn.addEventListener('click', startDelayedCapture);
    cancelCountdownBtn.addEventListener('click', cancelDelayedCapture);
    stopStreamBtn.addEventListener('click', () => stopScreenStream(true));

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
        solveWithGemini('', true);
      }
    });

    mobTabImage.addEventListener('click', () => setMobileTab('image'));
    mobTabAnswers.addEventListener('click', () => setMobileTab('answers'));

    window.addEventListener('paste', (e) => {
      const clipboardItems = e.clipboardData && e.clipboardData.items;
      if (!clipboardItems) return;

      for (const item of clipboardItems) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) {
            loadFileOrBlobAndSolve(blob);
          }
          return;
        }
      }
    });

    pasteCardBtn.addEventListener('click', async () => {
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
          showError('Lõikelaual pole pilti', 'Kopeeri esmalt ekraanipilt (nt PrtScn klahviga) ja vajuta seejärel Ctrl+V.');
        } catch {
          showError('Vajuta Ctrl+V', 'Vajuta lehel olles klaviatuuril Ctrl+V, et kleepida ekraanipilt.');
        }
      } else {
        showError('Vajuta Ctrl+V', 'Vajuta lehel olles klaviatuuril Ctrl+V, et kleepida ekraanipilt.');
      }
    });

    cameraBtn.addEventListener('click', () => {
      cameraInput.value = '';
      cameraInput.click();
    });

    cameraInput.addEventListener('change', () => {
      if (cameraInput.files && cameraInput.files[0]) {
        loadFileOrBlobAndSolve(cameraInput.files[0]);
      }
    });

    uploadBtn.addEventListener('click', () => {
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
        loadFileOrBlobAndSolve(e.dataTransfer.files[0]);
      }
    });
  }

  function setMobileTab(tabName) {
    const isImage = tabName === 'image';
    mobTabImage.classList.toggle('active', isImage);
    mobTabAnswers.classList.toggle('active', !isImage);
    mainWorkspace.classList.toggle('mob-mode-image', isImage);
    mainWorkspace.classList.toggle('mob-mode-answers', !isImage);
  }

  // =========================================================================
  // 9. GEMINI REST API PÄRING
  // =========================================================================
  async function callGeminiModel(model, apiKey, payload, signal) {
    // API võti saadetakse päises (mitte URL-is), et see ei satuks brauseri ajalukku ega logidesse
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`;

    // Ükski päring ei jää lõputult "rippuma" — 90 sekundi järel katkestame
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, REQUEST_TIMEOUT_MS);
    const forwardAbort = () => timeoutController.abort();
    signal.addEventListener('abort', forwardAbort);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        let errDetail = `HTTP ${response.status}`;
        try {
          const errJson = await response.json();
          if (errJson && errJson.error && errJson.error.message) {
            errDetail = errJson.error.message;
          }
        } catch {
          // Ignoreeri
        }
        const error = new Error(errDetail);
        error.status = response.status;
        throw error;
      }

      return await response.json();
    } catch (err) {
      if (timedOut) {
        const timeoutError = new Error('Päring võttis liiga kaua aega.');
        timeoutError.status = 408;
        throw timeoutError;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', forwardAbort);
    }
  }

  /** Muudab tehnilised API vead arusaadavaks eestikeelseks selgituseks */
  function friendlyErrorMessage(err) {
    const status = err && err.status;
    const raw = String((err && err.message) || '');

    if (!navigator.onLine || (err instanceof TypeError && /fetch|network/i.test(raw))) {
      return 'Internetiühendus puudub või see on blokeeritud. Kontrolli ühendust ja proovi uuesti.';
    }
    if (/API key not valid|API_KEY_INVALID|API key expired/i.test(raw) || status === 401) {
      return 'API võti ei kehti. Ava "? API juhend" ja kopeeri uus võti Google AI Studiost.';
    }
    if (status === 403) {
      return 'Sellel API võtmel puudub luba. Loo uus võti aadressil aistudio.google.com/apikey.';
    }
    if (status === 429) {
      return 'Tasuta päringute limiit sai hetkeks täis. Oota ~1 minut ja vajuta "Uuesti".';
    }
    if (status === 408) {
      return 'Päring aegus. Proovi uuesti või tee pilt lähemalt ja selgemalt.';
    }
    if (status === 413) {
      return 'Pilt on liiga suur. Tee uus foto lähemalt või vähema taustaga.';
    }
    if (status && status >= 500) {
      return 'Google serverid on hetkel ülekoormatud. Proovi mõne sekundi pärast uuesti.';
    }
    return raw || 'Ühendus Gemini API-ga ebaõnnestus. Kontrolli oma API võtit.';
  }

  async function solveWithGemini(followUpInstruction = '', bypassCache = false) {
    if (!currentBase64Jpeg) return;

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      document.title = DEFAULT_TITLE;
      setStatus('warn', 'Lisa API võti');
      showError('Gemini API võti on vajalik', 'Sisesta ülemisele ribale oma Gemini API võti (vaata "? API juhend" nuppu).');
      apiKeyInput.focus();
      return;
    }

    const preferredModel = resolveModelName(modelSelect.value || DEFAULT_MODEL);
    const cacheKey = `${preferredModel}::${currentImageSignature}::${followUpInstruction}`;

    if (!bypassCache && !followUpInstruction && responseCache.has(cacheKey)) {
      const cachedItems = responseCache.get(cacheKey);
      currentAnswers = cachedItems;
      renderSpatialOverlaysAndCards(cachedItems);
      document.title = `✅ Ready! (${cachedItems.length} Answers)`;
      setStatus('ready', `✅ Valmis (${cachedItems.length})`);
      return;
    }

    if (activeAbortController) {
      activeAbortController.abort();
    }
    activeAbortController = new AbortController();

    const requestId = ++solveRequestId;
    isSolving = true;
    hideError();
    document.title = '📸 Solving...';
    setStatus('busy', '📸 Lahendan...');
    solvingScanner.classList.remove('hidden');
    scannerStatusMsg.textContent = followUpInstruction
      ? 'Uuendan lahenduskäike ja asukohti...'
      : '📸 Arvutan täpseid asukohti ja lahenduskäike...';

    followUpInput.disabled = true;
    followUpSubmitBtn.disabled = true;

    let userPromptText =
      'Solve every exercise, table cell rectangle (like factoring grids), and question on this page. In `where_to_write`, quote the exact printed text or formula right before the blank so the student knows immediately where to write on their paper. If a row has multiple blanks, clearly label what goes into each blank (1. lünk, 2. lünk, etc.). Place `box_2d` at the exact vertical height of the blank line.';

    if (followUpInstruction && currentAnswers.length > 0) {
      userPromptText = `Current JSON answers:\n${JSON.stringify(
        currentAnswers
      )}\n\nStudent correction/request: "${followUpInstruction}"\nReturn the complete updated JSON array matching the schema.`;
    }

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
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    };

    const modelsToTry = [preferredModel, ...FALLBACK_MODELS.filter((m) => m !== preferredModel)];
    let lastError = null;

    try {
      for (const candidateModel of modelsToTry) {
        try {
          const data = await callGeminiModel(
            candidateModel,
            apiKey,
            payload,
            activeAbortController.signal
          );
          const rawText = extractCandidateText(data);
          const parsedItems = parseAndNormalizeAnswers(rawText);

          currentAnswers = parsedItems;
          responseCache.set(cacheKey, parsedItems);
          // Hoia vahemälu väike, et pikalt kasutades mälu ei täituks
          if (responseCache.size > MAX_CACHE_ENTRIES) {
            responseCache.delete(responseCache.keys().next().value);
          }
          renderSpatialOverlaysAndCards(parsedItems);

          document.title = `✅ Ready! (${parsedItems.length} Answers)`;
          setStatus('ready', `✅ Valmis (${parsedItems.length})`);
          lastError = null;
          break;
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          lastError = err;
          // Proovi varumudelit ainult siis, kui probleem on mudelis/serveris — mitte vigase võtme puhul
          const isRetryable = !err.status || RETRYABLE_STATUSES.includes(err.status);
          if (!isRetryable || err instanceof TypeError) {
            break;
          }
        }
      }

      if (lastError) {
        throw lastError;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      document.title = '⚠️ Viga lahendamisel';
      setStatus('error', 'Viga');
      showError('Viga töölehe lahendamisel', friendlyErrorMessage(err));
    } finally {
      // Kui vahepeal algas uus päring, ära sega selle olekut
      if (requestId === solveRequestId) {
        isSolving = false;
        solvingScanner.classList.add('hidden');
        const hasImage = Boolean(currentBase64Jpeg);
        followUpInput.disabled = !hasImage;
        followUpSubmitBtn.disabled = !hasImage;
      }
    }
  }

  function extractCandidateText(apiResponse) {
    const candidates = apiResponse && apiResponse.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error('Mudel ei tagastanud ühtegi vastust.');
    }
    const parts = candidates[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error('Mudeli vastus oli tühi.');
    }
    const textPart = parts.find((p) => typeof p.text === 'string');
    if (!textPart) {
      throw new Error('Mudeli vastus ei sisaldanud JSON teksti.');
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
      const lastBrace = cleaned.lastIndexOf('}');
      if (lastBrace !== -1) {
        const repaired = `${cleaned.slice(0, lastBrace + 1)}]`;
        try {
          parsed = JSON.parse(repaired);
        } catch {
          throw new Error('Mudeli JSON vastuse lugemine ebaõnnestus.');
        }
      } else {
        throw new Error('Mudeli JSON vastuse lugemine ebaõnnestus.');
      }
    }

    if (!Array.isArray(parsed)) {
      throw new Error('Mudeli väljund ei olnud JSON massiiv.');
    }

    return parsed.map((item, idx) => {
      const uniqueId = idx + 1;
      const box = Array.isArray(item.box_2d) && item.box_2d.length === 4 ? item.box_2d : [100, 100, 140, 260];

      let [ymin, xmin, ymax, xmax] = box.map((n) => Math.max(0, Math.min(1000, Number(n) || 0)));
      if (ymax < ymin) [ymin, ymax] = [ymax, ymin];
      if (xmax < xmin) [xmin, xmax] = [xmax, xmin];

      if (ymax - ymin < 14) ymax = Math.min(1000, ymin + 16);
      if (xmax - xmin < 24) xmax = Math.min(1000, xmin + 28);

      let label = String(item.question_label || `Ül ${uniqueId}`).trim();
      if (label.length > 38) {
        label = `${label.slice(0, 36)}…`;
      }

      return {
        id: uniqueId,
        box_2d: [ymin, xmin, ymax, xmax],
        question_label: label,
        where_to_write: String(item.where_to_write || label).trim(),
        steps: String(item.steps ?? '').trim(),
        answer: String(item.answer ?? '').trim(),
      };
    });
  }

  // =========================================================================
  // 10. MÄRGISTE, ALUMISE KIIRVAATE JA KÜLGPANEELI RENDERDAMINE
  // =========================================================================
  function clearOverlayAndCardsForNewSolve() {
    overlayLayer.innerHTML = '';
    currentAnswers = [];
    selectedPinIndex = 0;
    activePinInspector.classList.add('hidden');
    answerCountBadge.textContent = '0';
    mobAnswerCount.textContent = '0';
    copyAllBtn.disabled = true;
    answersList.innerHTML = `
      <div class="empty-answers">
        <div class="empty-icon">
          <span class="spinner"></span>
        </div>
        <p class="empty-title">Arvutan lahenduskäike ja asukohti...</p>
        <p class="empty-desc">Tuvastan trükitud tehted ja koostan iga lünga jaoks täpse juhise.</p>
      </div>
    `;
  }

  function clearResults() {
    currentDataUrl = null;
    currentBase64Jpeg = null;
    currentImageSignature = '';
    currentAnswers = [];
    selectedPinIndex = 0;
    overlayLayer.innerHTML = '';
    activePinInspector.classList.add('hidden');
    answerCountBadge.textContent = '0';
    mobAnswerCount.textContent = '0';
    copyAllBtn.disabled = true;
    followUpInput.disabled = true;
    followUpSubmitBtn.disabled = true;
    document.title = DEFAULT_TITLE;
  }

  function renderSpatialOverlaysAndCards(items) {
    overlayLayer.innerHTML = '';
    answersList.innerHTML = '';
    answerCountBadge.textContent = String(items.length);
    mobAnswerCount.textContent = String(items.length);
    copyAllBtn.disabled = items.length === 0;

    if (items.length === 0) {
      activePinInspector.classList.add('hidden');
      answersList.innerHTML = `
        <div class="empty-answers">
          <p class="empty-title">Ülesandeid ei leitud</p>
          <p class="empty-desc">Kasuta alumist täpsustusriba, et öelda, millist ülesannet soovid lahendada.</p>
        </div>
      `;
      return;
    }

    items.forEach((item, index) => {
      const [ymin, xmin, ymax, xmax] = item.box_2d;

      const leftPct = xmin / 10;
      const topPct = ymin / 10;
      const widthPct = (xmax - xmin) / 10;
      const heightPct = (ymax - ymin) / 10;

      // 1. Loo 2D märgis pildile
      const boxEl = document.createElement('div');
      boxEl.className = 'spatial-box';
      boxEl.dataset.id = String(item.id);
      boxEl.style.left = `${leftPct}%`;
      boxEl.style.top = `${topPct}%`;
      boxEl.style.width = `${widthPct}%`;
      boxEl.style.height = `${heightPct}%`;

      if (xmin > 750) {
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

      // 2. Loo täpne kaart külgpaneelile (Asukoht paberil + Lahenduskäik + Vastus)
      const cardEl = document.createElement('div');
      cardEl.className = 'answer-card';
      cardEl.dataset.id = String(item.id);

      const locationHtml = item.where_to_write
        ? `<div class="card-location-box">
             <span class="card-location-label">📍 Kuhu paberil kirjutada (otsi see tekst):</span>
             ${escapeHtml(item.where_to_write)}
           </div>`
        : '';

      const hasDistinctSteps =
        item.steps &&
        item.steps.toLowerCase() !== item.answer.toLowerCase();

      const stepsHtml = hasDistinctSteps
        ? `<div class="card-steps-box">
             <span class="card-steps-label">✏️ Lahenduskäik (kirjuta vihikusse):</span>
             ${escapeHtml(item.steps)}
           </div>`
        : '';

      cardEl.innerHTML = `
        <div class="answer-card-top">
          <div class="answer-meta">
            <span class="answer-id-pill">#${escapeHtml(String(item.id))}</span>
            <span class="answer-label">${escapeHtml(item.question_label)}</span>
          </div>
          <button type="button" class="copy-card-btn" title="Kopeeri lahendus ja vastus">
            <span>Kopeeri</span>
          </button>
        </div>
        ${locationHtml}
        ${stepsHtml}
        <div class="answer-value">
          <span class="answer-value-prefix">Vastus:</span>${escapeHtml(item.answer)}
        </div>
      `;

      const copyBtn = cardEl.querySelector('.copy-card-btn');
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const textToCopy = hasDistinctSteps ? `${item.steps} => ${item.answer}` : item.answer;
        copyTextToClipboard(textToCopy, copyBtn);
      });

      boxEl.addEventListener('mouseenter', () => setItemHighlight(item.id, true));
      boxEl.addEventListener('mouseleave', () => {
        if (currentAnswers[selectedPinIndex]?.id !== item.id) {
          setItemHighlight(item.id, false);
        }
      });
      boxEl.addEventListener('click', (e) => {
        e.stopPropagation();
        selectActivePinByIndex(index, true);
      });

      cardEl.addEventListener('mouseenter', () => setItemHighlight(item.id, true));
      cardEl.addEventListener('mouseleave', () => {
        if (currentAnswers[selectedPinIndex]?.id !== item.id) {
          setItemHighlight(item.id, false);
        }
      });
      cardEl.addEventListener('click', () => {
        if (window.innerWidth <= 900) {
          setMobileTab('image');
        }
        selectActivePinByIndex(index, true);
      });

      overlayLayer.appendChild(boxEl);
      answersList.appendChild(cardEl);
    });

    selectActivePinByIndex(0, false);
  }

  function selectActivePinByIndex(index, scrollIntoView = true) {
    if (!currentAnswers.length) return;
    const safeIndex = (index + currentAnswers.length) % currentAnswers.length;
    selectedPinIndex = safeIndex;
    const item = currentAnswers[safeIndex];

    overlayLayer.querySelectorAll('.spatial-box').forEach((el) => {
      el.classList.toggle('is-highlighted', el.dataset.id === String(item.id));
    });
    answersList.querySelectorAll('.answer-card').forEach((el) => {
      el.classList.toggle('is-highlighted', el.dataset.id === String(item.id));
    });

    // Uuenda alumist kiirvaate kaarti (#activePinInspector)
    activePinInspector.classList.remove('hidden');
    inspIdBadge.textContent = `#${item.id}`;
    inspQuestionLabel.textContent = item.question_label;

    if (item.where_to_write) {
      inspLocationRow.classList.remove('hidden');
      inspLocationRow.textContent = `📍 Kuhu kirjutada: ${item.where_to_write}`;
    } else {
      inspLocationRow.classList.add('hidden');
      inspLocationRow.textContent = '';
    }

    if (item.steps && item.steps.toLowerCase() !== item.answer.toLowerCase()) {
      inspStepsRow.classList.remove('hidden');
      inspStepsRow.textContent = `✏️ Lahenduskäik: ${item.steps}`;
    } else {
      inspStepsRow.classList.add('hidden');
      inspStepsRow.textContent = '';
    }

    inspFinalAnswer.textContent = item.answer;

    if (scrollIntoView) {
      const selector = `[data-id="${CSS.escape(String(item.id))}"]`;
      const boxEl = overlayLayer.querySelector(selector);
      if (boxEl) {
        boxEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
      const cardEl = answersList.querySelector(selector);
      if (cardEl && window.innerWidth > 900) {
        cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
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
  // 11. TÖÖRIISTARIBA NUPUD, KIIRVAATE NAVIGEERIMINE JA KOPEERIMINE
  // =========================================================================
  function initToolbarAndSidebarEvents() {
    togglePinModeBtn.addEventListener('click', () => {
      compactPinMode = !compactPinMode;
      overlayLayer.classList.toggle('compact-pins', compactPinMode);
      togglePinModeBtn.classList.toggle('active-toggle', !compactPinMode);
      togglePinModeText.textContent = compactPinMode
        ? '🏷️ Näita vastuseid pildil'
        : '🔢 Ainult numbrid (#1, #2)';
    });

    inspPrevBtn.addEventListener('click', () => {
      selectActivePinByIndex(selectedPinIndex - 1, true);
    });

    inspNextBtn.addEventListener('click', () => {
      selectActivePinByIndex(selectedPinIndex + 1, true);
    });

    inspCloseBtn.addEventListener('click', () => {
      activePinInspector.classList.add('hidden');
    });

    inspCopyBtn.addEventListener('click', () => {
      const item = currentAnswers[selectedPinIndex];
      if (!item) return;
      const text = item.steps ? `${item.steps} => ${item.answer}` : item.answer;
      copyTextToClipboard(text, inspCopyBtn);
    });

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
        // Hoidmise lõpus tekkiv "click" ei tohi märgiseid uuesti peita
        suppressNextToggleClick = true;
        setTimeout(() => {
          suppressNextToggleClick = false;
        }, 400);
      }
    };

    toggleOverlaysBtn.addEventListener('pointerup', releaseHold);
    toggleOverlaysBtn.addEventListener('pointerleave', releaseHold);
    toggleOverlaysBtn.addEventListener('pointercancel', releaseHold);

    toggleOverlaysBtn.addEventListener('click', () => {
      if (suppressNextToggleClick) return;
      setOverlaysHiddenState(!overlaysHidden);
    });

    // Klaviatuuri otseteed arvutis: ← → vahetavad ülesannet, Esc sulgeb kiirvaate
    window.addEventListener('keydown', (e) => {
      if (resultView.classList.contains('hidden')) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight') {
        selectActivePinByIndex(selectedPinIndex + 1, true);
      } else if (e.key === 'ArrowLeft') {
        selectActivePinByIndex(selectedPinIndex - 1, true);
      } else if (e.key === 'Escape') {
        activePinInspector.classList.add('hidden');
      }
    });

    copyAllBtn.addEventListener('click', async () => {
      if (!currentAnswers.length) return;
      const formatted = currentAnswers
        .map((a) =>
          a.steps
            ? `#${a.id} (${a.where_to_write || a.question_label}):\n  Lahenduskäik: ${a.steps}\n  Vastus: ${a.answer}`
            : `#${a.id} (${a.where_to_write || a.question_label}): ${a.answer}`
        )
        .join('\n\n');
      try {
        await navigator.clipboard.writeText(formatted);
        copyAllText.textContent = 'Kopeeritud!';
        setTimeout(() => {
          copyAllText.textContent = 'Kopeeri kõik';
        }, 1400);
      } catch {
        // Ignoreeri
      }
    });

    followUpForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const instruction = followUpInput.value.trim();
      if (!instruction || !currentBase64Jpeg || isSolving) return;
      followUpInput.value = '';
      solveWithGemini(instruction, true);
    });

    dismissErrorBtn.addEventListener('click', hideError);
  }

  function setOverlaysHiddenState(hidden) {
    overlaysHidden = hidden;
    overlayLayer.classList.toggle('overlays-hidden', hidden);
    toggleOverlaysBtn.classList.toggle('active-toggle', hidden);
    toggleOverlaysText.textContent = hidden ? '👁️ Näita märgiseid' : '👁️ Peida märgised';
  }

  async function copyTextToClipboard(text, btnEl) {
    try {
      await navigator.clipboard.writeText(text);
      const span = btnEl.querySelector('span');
      const prev = span ? span.textContent : 'Kopeeri';
      btnEl.classList.add('copied');
      if (span) span.textContent = 'Kopeeritud!';
      setTimeout(() => {
        btnEl.classList.remove('copied');
        if (span) span.textContent = prev;
      }, 1200);
    } catch {
      // Ignoreeri
    }
  }

  // =========================================================================
  // 12. VAADETE VAHETAMINE JA ABIFUNKTSIOONID
  // =========================================================================
  function showView(viewName) {
    launchpadView.classList.toggle('hidden', viewName !== 'launchpad');
    streamView.classList.toggle('hidden', viewName !== 'stream');
    resultView.classList.toggle('hidden', viewName !== 'result');

    mobileTabSwitcher.classList.toggle('hidden', viewName !== 'result');
    if (viewName !== 'result') {
      mainWorkspace.classList.remove('mob-mode-image', 'mob-mode-answers');
    }
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
  // 13. KÄIVITAMINE
  // =========================================================================
  initPersistenceAndGuide();
  initCaptureListeners();
  initToolbarAndSidebarEvents();
})();
