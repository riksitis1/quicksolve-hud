/**
 * QuickSolve HUD — Nutikas töölehtede ja töövihikute lahendaja (koos loomuliku lahenduskäiguga)
 * - Näitab nii õpilasepärast lahenduskäiku (steps) kui ka lõppvastust (answer)
 * - Puhas kompaktne numbrivaade (#1, #2, #3) pildil + alumine kiirvaate riba (Eelmine / Järgmine)
 * - Ühendab sama rea vahelüngad üheks selgeks punktiks ega kata töövihiku teksti kinni
 * - Lahendab ka tabelite lahtrid ja ristkülikud (nt Ül 52 hulkliikmete tegurdamine)
 * - Automaatne mudeli varuvariant, et ükski päring ei jääks mudeli vea taha
 */

(() => {
  'use strict';

  // =========================================================================
  // 1. KONSTANDID JA SÜSTEEMIPROMPT (KOOS LAHENDUSKÄIGUGA)
  // =========================================================================
  const STORAGE_KEYS = {
    API_KEY: 'gemini_api_key',
    MODEL: 'gemini_model',
    COOLDOWN: 'quicksolve_cooldown',
    GUIDE_DISMISSED: 'quicksolve_guide_dismissed',
  };

  const DEFAULT_MODEL = 'gemini-2.5-flash';
  const MODEL_ALIASES = {
    'gemini-3.8-flash': 'gemini-2.5-flash',
    'gemini-3.5-flash-lite': 'gemini-2.5-flash-lite',
    'gemini-4-argon': 'gemini-2.5-pro',
  };
  const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];

  const MAX_IMAGE_EDGE = 2400;
  const JPEG_QUALITY = 0.92;
  const DEFAULT_TITLE = 'QuickSolve HUD — Nutikas töölehtede lahendaja';

  const SYSTEM_INSTRUCTION = `You are an elite, fast, undetectable school worksheet and workbook solver. Analyze the image with extreme visual precision, locate every unanswered question, empty table cell/rectangle after an "=" sign, fill-in-the-blank line, matching box, or multiple-choice question, and return both the natural student solution steps and the final answer mapped to 2D coordinates.

STRICT RULES:
1. ZERO YAPPING: Output strictly the JSON array matching the schema.
2. AUTOMATIC LANGUAGE MATCHING: Detect the exact language used on the worksheet (e.g., Estonian, English, German, Russian) and write \`question_label\`, \`steps\`, and \`answer\` in that exact language.
3. NATURAL 8TH-GRADE STUDENT SOLUTION PROCESS (\`steps\`):
   - Teachers check if the student actually solved the problem or just copied a bare number.
   - In \`steps\`, write the exact intermediate calculation or reasoning steps the way a real 8th-grade student writes in their workbook (so it looks 100% authentic, like they solved it or wrote it off a smart classmate's notebook).
   - Examples of \`steps\`:
     * Factoring & mental math (e.g., "12·28 - 28·11 = ... = ... = ..."): \`"28 · (12 - 11) = 28 · 1 = 28 | Ristsumma: 2 + 8 = 10"\`
     * Polynomial grouping in table boxes (e.g., "5x + 5y + 3xy + 3x² ="): \`"5(x + y) + 3x(y + x) = (x + y)(5 + 3x)"\`
     * Expanding brackets (e.g., "(7x + 10)(1 - 3y)"): \`"(7x + 10)(1 - 3y) = 7x - 21xy + 10 - 30y"\`
     * Linear equation ("5x - 14 = 2x + 19"): \`"5x - 2x = 19 + 14  =>  3x = 33  =>  x = 11"\`
     * Percentage ("320 € - 15%"): \`"320 · 0,85 = 272 € (või 320 - 48 = 272 €)"\`
     * Grammar / Biology fact: Write a brief 3–6 word school-level rule/reason (e.g., \`"Ainsuse osastav (keda? mida?)"\` or \`"Fotosüntees toimub kloroplastides"\`).
4. DO NOT CLUTTER SAME-LINE CHAINED BLANKS:
   - If a single numbered sub-question (like \`1) 12·28 - 28·11 = ..... = ..... = .....\` plus a \`Ristsumma\` column on the same row) has multiple chained blanks on the same row, DO NOT create 4 separate overlapping pins on that row!
   - Instead, create ONE single item for that entire row/sub-question, place \`box_2d\` on the first blank after \`=\`, and put all the chained blank values clearly inside \`steps\` and \`answer\`!
5. SOLVE EMPTY TABLE CELLS, RECTANGLES & MATCHING TASKS:
   - Look carefully for large empty rectangular boxes or grid cells that contain an expression ending with \`=\` (such as factoring exercises in a 2x3 table grid). Every single cell in such a table MUST be solved!
   - If an exercise asks to color/match boxes and then write out the remaining unmatched expressions and expand their brackets, solve all of them!
6. ESTONIAN GRAMMAR & SCIENCE PRECISION:
   - Compound words (kokku- ja lahkukirjutamine): "vanaema" and "kolmsada" are written together; language names like "eesti keel" are written apart.
   - Word corrections (võõrsõnad): Keep the exact same grammatical form/part of speech as in the sentence (e.g., "effektne" -> "efektne").
   - Sentence subject (alus): Return strictly the subject noun itself (e.g., "musträstas") without adjective modifiers ("väike").
7. SPATIAL PRECISION & UNIQUE IDS:
   - \`id\` must be sequential integers (1, 2, 3...).
   - \`question_label\` must be short (e.g., "Ül 51.1", "Ül 52 (1. kast)", "Ül 52 (ava sulud 1)").
   - \`box_2d\` must be [ymin, xmin, ymax, xmax] on a 0-1000 scale.`;

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
        steps: { type: 'STRING' },
        answer: { type: 'STRING' },
      },
      required: ['id', 'box_2d', 'question_label', 'steps', 'answer'],
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
  let activeAbortController = null;

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
  // 9. GEMINI REST API PÄRING KOOS AUTOMAATSE VARUMUDELIGA
  // =========================================================================
  async function callGeminiModel(model, apiKey, payload, signal) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
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

    return response.json();
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

    isSolving = true;
    hideError();
    document.title = '📸 Solving...';
    setStatus('busy', '📸 Lahendan...');
    solvingScanner.classList.remove('hidden');
    scannerStatusMsg.textContent = followUpInstruction
      ? 'Uuendan lahenduskäike ja vastuseid...'
      : '📸 Arvutan lahenduskäike ja vastuseid...';

    followUpInput.disabled = true;
    followUpSubmitBtn.disabled = true;

    let userPromptText =
      'Solve every single exercise, table cell rectangle (like factoring grids), and question on this page. Group chained blanks on the same equation row into a single item so pins never overlap. Include natural 8th-grade student intermediate steps in `steps` and the final result in `answer`.';

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
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    };

    // Koostame mudelite järjekorra: esmalt valitud mudel, seejärel automaatsed varumudelid
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
          renderSpatialOverlaysAndCards(parsedItems);

          document.title = `✅ Ready! (${parsedItems.length} Answers)`;
          setStatus('ready', `✅ Valmis (${parsedItems.length})`);
          lastError = null;
          break;
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          lastError = err;
          // Kui viga on vigases API võtmes (400 API_KEY_INVALID / 403), ära proovi teisi mudeleid
          if (err && (String(err.message).includes('API_KEY') || err.status === 403)) {
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
      showError(
        'Viga töölehe lahendamisel',
        err.message || 'Ühendus Gemini API-ga ebaõnnestus. Kontrolli oma API võtit.'
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
      throw new Error('Mudeli JSON vastuse lugemine ebaõnnestus.');
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

      if (ymax - ymin < 18) ymax = Math.min(1000, ymin + 20);
      if (xmax - xmin < 28) xmax = Math.min(1000, xmin + 32);

      let label = String(item.question_label || `Ül ${uniqueId}`).trim();
      if (label.length > 36) {
        label = `${label.slice(0, 34)}…`;
      }

      return {
        id: uniqueId,
        box_2d: [ymin, xmin, ymax, xmax],
        question_label: label,
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
        <p class="empty-title">Arvutan lahenduskäike...</p>
        <p class="empty-desc">Koostan õpilasepäraseid vahetehteid ja vastuseid.</p>
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

      // 2. Loo lahenduskäigu ja vastuse kaart külgpaneelile
      const cardEl = document.createElement('div');
      cardEl.className = 'answer-card';
      cardEl.dataset.id = String(item.id);

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

      // Märgise või kaardi puudutamine avab alumise kiirvaate ja tõstab ülesande esile
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

    // Vali automaatselt esimene ülesanne (#1), et kasutaja näeks kohe allservas lahenduskäiku!
    selectActivePinByIndex(0, false);
  }

  function selectActivePinByIndex(index, scrollIntoView = true) {
    if (!currentAnswers.length) return;
    const safeIndex = (index + currentAnswers.length) % currentAnswers.length;
    selectedPinIndex = safeIndex;
    const item = currentAnswers[safeIndex];

    // Eemalda vana esiletõstmine ja tõsta valitud #id esile
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
    // Vaheta kompaktsete numbrite (#1, #2) ja täistekstiga märgiste vahel
    togglePinModeBtn.addEventListener('click', () => {
      compactPinMode = !compactPinMode;
      overlayLayer.classList.toggle('compact-pins', compactPinMode);
      togglePinModeBtn.classList.toggle('active-toggle', !compactPinMode);
      togglePinModeText.textContent = compactPinMode
        ? '🏷️ Näita vastuseid pildil'
        : '🔢 Ainult numbrid (#1, #2)';
    });

    // Alumise kiirvaate Eelmine / Järgmine nupud
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

    // Peida / näita kõiki märgiseid
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

    copyAllBtn.addEventListener('click', async () => {
      if (!currentAnswers.length) return;
      const formatted = currentAnswers
        .map((a) =>
          a.steps
            ? `#${a.id} (${a.question_label}): ${a.steps}  =>  Vastus: ${a.answer}`
            : `#${a.id} (${a.question_label}): ${a.answer}`
        )
        .join('\n');
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
