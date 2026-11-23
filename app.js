'use strict';
(() => {
  // ================= helpers =================
  const $ = (s) => document.querySelector(s);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const now = () => performance.now();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const STANDALONE = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const CAN_FULLSCREEN = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen) && !/iPhone|iPod/.test(navigator.userAgent);
  const SMALL = Math.min(screen.width, screen.height) < 600;
  const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

  const LS = {
    get(k, d) { try { const v = localStorage.getItem('tp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('tp.' + k, JSON.stringify(v)); } catch { /* quota / private mode */ } },
  };

  function guessLang() {
    const l = (navigator.language || 'zh-TW').toLowerCase();
    if (l.startsWith('zh')) {
      if (l.includes('hk') || l.includes('mo') || l.includes('yue')) return 'zh-HK';
      if (l.includes('cn') || l.includes('sg') || l.includes('hans')) return 'zh-CN';
      return 'zh-TW';
    }
    const map = { en: l.includes('gb') ? 'en-GB' : 'en-US', ja: 'ja-JP', ko: 'ko-KR', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' };
    return map[l.slice(0, 2)] || 'en-US';
  }

  const SAMPLE = `# 開場
大家好，今天我想跟大家分享一個小工具：會聽你說話的提詞器。[停頓]

你只要照著講稿唸，畫面就會跟著你的進度往下捲動。就算中間停下來喝口水，它也會在原地等你。

# 使用方式
把講稿貼到編輯區，或是直接匯入 Word 檔，甚至 PowerPoint 的演講者備忘稿。[換投影片]

以井字號開頭的行會變成段落標題，方括號裡的文字是提示，這兩種都不需要唸出來。

如果講到一半跳過了一段，它會在後面的內容裡把你找回來；你也可以點一下任何一個字（手機上是長按），把進度設在那裡。

# 結語
謝謝大家的聆聽，有任何問題都歡迎提出。`;

  // ================= settings =================
  const DEFAULTS = {
    mode: SR ? 'voice' : 'auto',
    lang: guessLang(),
    fontSize: SMALL ? 34 : 56,
    lineHeight: SMALL ? 1.4 : 1.5,
    width: SMALL ? 100 : 85,
    readingLine: 33,
    speed: 40,
    mirrorX: false,
    mirrorY: false,
    transcript: true,
  };
  const settings = Object.assign({}, DEFAULTS, LS.get('settings', {}));
  if (!SR && settings.mode === 'voice') settings.mode = 'auto';

  const OUT_FMT = {
    fontSize: (v) => v + ' px',
    lineHeight: (v) => (+v).toFixed(2),
    width: (v) => v + '%',
    readingLine: (v) => v + '%',
    speed: (v) => v + ' px/秒',
  };

  // ================= tokenizer =================
  // CJK: one token per character. Other scripts: one token per word.
  const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}';
  const WCH = `(?:(?![${CJK}])[\\p{L}\\p{M}\\p{N}])`;
  const TOKEN_RE = new RegExp(`[${CJK}]|${WCH}+(?:['’]${WCH}+)*`, 'gu');
  const CJK_RE = new RegExp(`[${CJK}]`, 'u');
  const SENT_END = /[.!?。！？；;…:：]/;

  const norm = (t) => t.normalize('NFKC').toLowerCase().replace(/’/g, "'");
  function tokenize(text) {
    const out = [];
    for (const m of text.matchAll(TOKEN_RE)) out.push(norm(m[0]));
    return out;
  }

  // ================= DOM refs =================
  const editor = $('#editor'), prompter = $('#prompter'), stage = $('#stage'), content = $('#content');
  const ta = $('#script'), fileInput = $('#file');
  const hud = { dot: $('#dot'), status: $('#status'), timer: $('#timer'), progress: $('#progress'), section: $('#section'), toggle: $('#hToggle') };
  const transcriptEl = $('#transcript');

  // ================= state =================
  let tokens = [];      // { norm, el }
  let centers = [];     // vertical center (px) of each token inside #content
  let marks = [];       // headings & cues: { el, at }
  let paraStarts = [], sentStarts = [];
  let endEl = null;
  let renderedText = null;
  let pos = 0;          // index of the next token to be read
  let curY = 0, targetY = 0, lastT = 0, rafId = 0;
  let manualUntil = 0, resyncTimer = 0;
  let listening = false, playing = false, recog = null;
  // heard = text from finished recognition sessions; session = current session's final text;
  // interim = not-yet-final text; skip = tokens of the current session to ignore after a manual jump
  let heard = '', session = '', interim = '', skip = 0;
  let sessionStart = 0, resultsAtStart = 0;
  let diag = { start: false, audio: false, sound: false, speech: false, results: 0, ends: 0, err: '', since: 0 };
  let lastGlobal = 0;
  let elapsed = 0, lastHudPaint = 0, lastAutoSync = 0;
  let wakeLock = null;

  // ================= rendering =================
  function render(text) {
    renderedText = text;
    content.textContent = '';
    tokens = []; marks = []; paraStarts = []; sentStarts = [];
    const frag = document.createDocumentFragment();
    let para = null;
    let sentenceBreak = true;

    const addGap = (parent, s) => {
      if (!s) return;
      parent.appendChild(document.createTextNode(s));
      if (SENT_END.test(s)) sentenceBreak = true;
    };
    const addText = (parent, s) => {
      let last = 0;
      for (const m of s.matchAll(TOKEN_RE)) {
        addGap(parent, s.slice(last, m.index));
        if (sentenceBreak) { sentStarts.push(tokens.length); sentenceBreak = false; }
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = m[0];
        span.dataset.i = tokens.length;
        parent.appendChild(span);
        tokens.push({ norm: norm(m[0]), el: span });
        last = m.index + m[0].length;
      }
      addGap(parent, s.slice(last));
    };

    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (const raw of lines) {
      const trimmed = raw.trim();
      const line = trimmed.replace(/\*\*|__|`/g, '');
      if (!line) { para = null; continue; }
      const h = line.match(/^#{1,6}\s*(.*)$/) || trimmed.match(/^\*\*([^*]+)\*\*$/);
      if (h) {
        const el = document.createElement('div');
        el.className = 'sec';
        el.textContent = h[1];
        frag.appendChild(el);
        marks.push({ el, at: tokens.length, title: h[1] });
        para = null; sentenceBreak = true;
        continue;
      }
      if (!para) {
        para = document.createElement('p');
        frag.appendChild(para);
        paraStarts.push(tokens.length);
        sentenceBreak = true;
      } else {
        para.appendChild(document.createElement('br'));
      }
      const body = line.replace(/^([-*+]|\d+[.)])\s+/, '');
      const CUE = /\[[^\]\n]*\]|【[^】\n]*】/g;
      let last = 0, m;
      while ((m = CUE.exec(body))) {
        addText(para, body.slice(last, m.index));
        const c = document.createElement('span');
        c.className = 'cue';
        c.textContent = m[0].slice(1, -1);
        para.appendChild(c);
        marks.push({ el: c, at: tokens.length });
        last = CUE.lastIndex;
      }
      addText(para, body.slice(last));
    }

    if (!tokens.length) {
      const e = document.createElement('p');
      e.className = 'empty';
      e.textContent = '講稿是空的。按 Esc 回去貼上講稿。';
      frag.appendChild(e);
    }
    endEl = document.createElement('p');
    endEl.className = 'end';
    endEl.textContent = '— 完 —';
    frag.appendChild(endEl);
    content.appendChild(frag);

    pos = 0;
    for (let i = 0; i < tokens.length; i++) tokens[i].el.classList.remove('read', 'cur');
    tokens[0]?.el.classList.add('cur');
  }

  function computeLayout() {
    centers = tokens.map((t) => t.el.offsetTop + t.el.offsetHeight / 2);
  }

  function lineHeightPx() { return settings.fontSize * settings.lineHeight; }

  // first token whose line is at (or below) the reading line
  function indexAtScroll(y) {
    const lineY = y + stage.clientHeight * settings.readingLine / 100 - lineHeightPx() / 2;
    let lo = 0, hi = centers.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (centers[mid] < lineY) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function setPos(n, opts = {}) {
    n = clamp(n | 0, 0, tokens.length);
    if (n !== pos) {
      const lo = Math.min(n, pos), hi = Math.max(n, pos);
      for (let i = lo; i < hi; i++) tokens[i].el.classList.toggle('read', i < n);
      tokens[pos]?.el.classList.remove('cur');
      tokens[n]?.el.classList.add('cur');
      for (const mk of marks) mk.el.classList.toggle('read', mk.at < n);
      pos = n;
      savePos();
      paintHud(true);
    }
    if (opts.scroll !== false && now() > manualUntil) followPos(opts.instant);
  }

  function followPos(instant) {
    const c = pos < tokens.length ? centers[pos] : (endEl ? endEl.offsetTop + endEl.offsetHeight / 2 : 0);
    if (c == null) return;
    targetY = c - stage.clientHeight * settings.readingLine / 100;
    if (instant) curY = targetY;
  }

  // ================= animation loop =================
  function tick(t) {
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
    lastT = t;
    if (settings.mode === 'auto' && playing) {
      targetY += settings.speed * dt;
      curY = targetY;
      if (t - lastAutoSync > 150) {
        lastAutoSync = t;
        setPos(indexAtScroll(curY), { scroll: false });
        if (pos >= tokens.length) pause();
      }
    } else {
      const diff = targetY - curY;
      curY = Math.abs(diff) < 0.5 ? targetY : curY + diff * (1 - Math.exp(-dt * 7));
    }
    content.style.transform = `translate3d(0, ${-curY}px, 0)`;
    if (listening || playing) elapsed += dt * 1000;
    if (t - lastHudPaint > 250) paintHud();
    rafId = requestAnimationFrame(tick);
  }

  // ================= speech tracking =================
  const MATCH = 2, PARTIAL = 1, MISMATCH = -1, GAP = -1;
  const SPOKEN_N = 16, BACK = 20, AHEAD = 120;

  function sim(a, b) {
    if (a === b) return MATCH;
    if (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4)) return PARTIAL;
    return MISMATCH;
  }

  // Smith–Waterman local alignment of the spoken tail against tokens[from, to).
  // Only alignments that end at the latest spoken token are considered, so the
  // returned `end` is "the index right after what the speaker just said".
  function align(sp, from, to, usePenalty) {
    const W = to - from, m = sp.length;
    if (W <= 0 || !m) return null;
    let prev = new Float32Array(W + 1), cur = new Float32Array(W + 1);
    for (let i = 1; i <= m; i++) {
      cur[0] = 0;
      const s = sp[i - 1];
      for (let j = 1; j <= W; j++) {
        const v = Math.max(0, prev[j - 1] + sim(s, tokens[from + j - 1].norm), prev[j] + GAP, cur[j - 1] + GAP);
        cur[j] = v;
      }
      [prev, cur] = [cur, prev];
    }
    let best = null;
    for (let j = 1; j <= W; j++) {
      const raw = prev[j];
      if (raw <= 0) continue;
      const a = from + j;
      const d = a - pos;
      const pen = usePenalty ? (d >= 0 ? 0.02 * d : 0.15 * -d) : 0;
      const score = raw - pen;
      if (!best || score > best.score) best = { end: a, raw, score };
    }
    return best;
  }

  function track() {
    if (!tokens.length) return;
    const sp = spokenTokens();
    if (sp.length < 2) return;
    const cjkShare = sp.filter((t) => CJK_RE.test(t)).length / sp.length;
    const thr = cjkShare > 0.5 ? 7 : 5;

    let cand = null;
    const local = align(sp, Math.max(0, pos - BACK), Math.min(tokens.length, pos + AHEAD), true);
    if (local && local.score >= thr) cand = local;
    else if (sp.length >= 8 && now() - lastGlobal > 1200) {
      // speaker may have skipped ahead (or back) — search the whole script, demand a strong match
      lastGlobal = now();
      const g = align(sp, 0, tokens.length, false);
      if (g && g.raw >= thr * 2) cand = g;
    }
    if (!cand) return;
    const a = cand.end;
    if (a > pos || (a < pos - 2 && cand.raw >= thr + 5)) setPos(a);
  }

  function spokenTokens() {
    const cur = tokenize(session + ' ' + interim).slice(skip);
    return tokenize(heard).concat(cur).slice(-SPOKEN_N);
  }

  // iOS Safari (and some Android builds) repeat earlier text inside later results.
  // Collapse a result that only extends (or repeats) the previous one.
  function joinResults(list) {
    let out = '', prev = '';
    for (const t of list) {
      const a = t.trim();
      if (!a) continue;
      if (prev && a.startsWith(prev)) out = out.slice(0, out.length - prev.length) + a;
      else if (prev && prev.startsWith(a)) continue;
      else out += (out ? ' ' : '') + a;
      prev = a;
    }
    return out;
  }

  function onResult(e) {
    const fin = [], tmp = [];
    for (let i = 0; i < e.results.length; i++) (e.results[i].isFinal ? fin : tmp).push(e.results[i][0].transcript);
    session = joinResults(fin);
    interim = joinResults(tmp);
    if (session && interim.startsWith(session)) interim = interim.slice(session.length).trim();
    track();
    paintTranscript();
  }

  // a recognition session ended: keep its words as context for the next one
  function foldSession() {
    const kept = tokenize(session + ' ' + interim).slice(skip);
    if (kept.length) heard = (heard + ' ' + kept.join(' ')).slice(-400);
    session = ''; interim = ''; skip = 0;
  }

  // after a manual reposition, forget what was heard so stale words don't pull us back
  function forgetHeard() {
    heard = '';
    skip = tokenize(session + ' ' + interim).length;
    paintTranscript();
  }

  const langLabel = () => document.querySelector(`#lang option[value="${settings.lang}"]`)?.textContent || settings.lang;
  function paintTranscript() {
    if (listening && stalled) {
      transcriptEl.innerHTML = '<b class="stalled">辨識停咗 — 撳一下畫面繼續聆聽</b>';
      return;
    }
    if (listening && diag.results === 0) {
      // nothing recognised yet: show what the browser has reported so far
      const ok = (b) => (b ? '✓' : '–');
      transcriptEl.textContent =
        `${langLabel()}｜啟動 ${ok(diag.start)} 麥克風 ${ok(diag.audio)} 聲音 ${ok(diag.sound)} 說話 ${ok(diag.speech)} 結果 0` +
        (diag.ends ? `｜重啟 ${diag.ends}` : '') + (diag.err ? `｜錯誤 ${diag.err}` : '');
      return;
    }
    if (!settings.transcript) { transcriptEl.textContent = ''; return; }
    const h = (heard + ' ' + session).trim().slice(-60);
    transcriptEl.innerHTML = '';
    if (!h && !interim) return;
    transcriptEl.append(h + ' ');
    const s = document.createElement('span');
    s.className = 'interim';
    s.textContent = interim.slice(-40);
    transcriptEl.append(s);
  }

  // ---- speech event log (shown via the 紀錄 button, copyable for debugging) ----
  const evlog = [];
  function logEv(msg) {
    const t = ((now() - (diag.since || now())) / 1000).toFixed(1);
    evlog.push(`${t.padStart(6)}s  ${msg}`);
    if (evlog.length > 300) evlog.shift();
    if (!$('#logPanel').hidden) paintLog();
  }

  // Keep recognition alive for as long as the user wants it: restart after every end, back off
  // when sessions keep failing, and run a watchdog in case the browser silently stops.
  let sessionSpeech = false, stalled = false;
  let fails = 0, sessionActive = false, lastStartCall = 0, lastEventAt = 0, watchdog = 0, restartTimer = 0, warnedCapture = false;
  const FATAL = ['not-allowed', 'service-not-allowed', 'language-not-supported'];

  function startListening() {
    if (!SR) { toast('這個瀏覽器不支援語音辨識，請改用 Chrome、Edge 或 Safari，或在設定選「固定速度」。'); return; }
    if (!window.isSecureContext) { toast('語音辨識需要 HTTPS（或 localhost）才能使用麥克風。'); return; }
    if (listening) return;
    if (!recog) {
      recog = new SR();
      // Continuous mode avoids the ~1.3 s gap between utterances. On iOS it works once the mic
      // is healthy, but if a continuous session hears speech and never returns a result we fall
      // back to one utterance per session (remembered on this device).
      recog.continuous = !IS_IOS || LS.get('iosContinuous', true);
      recog.interimResults = true;
      recog.maxAlternatives = 1;
      const seen = (k, label) => () => { diag[k] = true; lastEventAt = now(); logEv(label); paintTranscript(); };
      recog.onstart = () => { if (stalled) { stalled = false; logEv('resumed'); } sessionActive = true; sessionSpeech = false; sessionStart = now(); resultsAtStart = diag.results; seen('start', 'start')(); };
      recog.onaudiostart = seen('audio', 'audiostart');
      recog.onsoundstart = seen('sound', 'soundstart');
      recog.onspeechstart = () => { sessionSpeech = true; seen('speech', 'speechstart')(); };
      recog.onresult = (e) => {
        diag.results++;
        fails = 0;
        lastEventAt = now();
        const last = e.results[e.results.length - 1];
        logEv(`result${last.isFinal ? ' (final)' : ''}: ${last[0].transcript.slice(-40)}`);
        onResult(e);
        // Apple's recogniser handles roughly a minute of audio per session, then quietly stops
        // returning text. Start a fresh session at a sentence boundary before that happens.
        const age = now() - sessionStart;
        if (recog.continuous && ((last.isFinal && age > 40000) || age > 55000)) {
          logEv(`recycle after ${Math.round(age / 1000)}s`);
          recycle();
        }
      };
      recog.onerror = (e) => {
        diag.err = e.error;
        lastEventAt = now();
        logEv(`error: ${e.error}${e.message ? ' — ' + e.message : ''}`);
        paintTranscript();
        if (FATAL.includes(e.error)) {
          stopListening('error ' + e.error);
          toast(e.error === 'language-not-supported' ? '這個瀏覽器不支援所選的辨識語言。'
            : IS_IOS ? '無法使用語音辨識：請到「設定 → 一般 → 鍵盤」開啟「啟用聽寫」，並在「設定 → App → Safari → 咪高峰」允許，再試一次。'
            : '無法使用麥克風：請在網址列允許麥克風權限後再試一次。', 8000);
        } else if (e.error === 'audio-capture' && !warnedCapture) {
          warnedCapture = true;
          toast('咪高峰冇聲音傳入。通常係 Safari 嘅咪高峰卡住咗：請由螢幕底部向上掃，強制關閉 Safari 再打開。會繼續自動重試。', 9000);
        } else if (e.error === 'network') {
          toast('語音辨識連線失敗（需要網路）。會自動重試。');
        }
      };
      recog.onend = () => {
        sessionActive = false;
        lastEventAt = now();
        foldSession();
        diag.ends++;
        // a session that produced nothing within a few seconds counts as a failure → back off
        const failed = diag.results === resultsAtStart && now() - sessionStart < 4000;
        fails = failed ? fails + 1 : 0;
        logEv(`end${failed ? ` (failed ×${fails})` : ''}`);
        if (IS_IOS && recog.continuous && sessionSpeech && diag.results === resultsAtStart && now() - sessionStart > 6000) {
          recog.continuous = false;
          LS.set('iosContinuous', false);
          logEv('iOS: continuous gave no results → single-utterance mode');
        }
        paintTranscript();
        if (listening) scheduleRestart();
        paintHud(true);
      };
    }
    recog.lang = settings.lang;
    listening = true;
    fails = 0; warnedCapture = false;
    diag = { start: false, audio: false, sound: false, speech: false, results: 0, ends: 0, err: '', since: now() };
    evlog.length = 0;
    logEv(`listen lang=${recog.lang} continuous=${recog.continuous}`);
    startSession();
    clearInterval(watchdog);
    watchdog = setInterval(checkAlive, 1000);
    paintHud(true);
  }

  function scheduleRestart() {
    clearTimeout(restartTimer);
    const delay = fails ? Math.min(5000, 250 * 2 ** fails) : 150;
    restartTimer = setTimeout(() => { if (listening && !sessionActive) startSession(); }, delay);
  }

  function startSession() {
    lastStartCall = now();
    sessionStart = now();
    resultsAtStart = diag.results;
    try { recog.start(); logEv('start()'); }
    catch (err) { logEv('start() threw: ' + (err && err.name)); }
  }

  function checkAlive() {
    if (!listening) return;
    const t = now();
    if (!sessionActive && t - lastStartCall > 3000) {
      // start() was called but the browser never started (or never told us it ended).
      // iOS sometimes only honours start() inside a tap, so also ask the user to tap.
      if (!stalled) { stalled = true; logEv('stalled: waiting for tap'); paintTranscript(); pokeHud(); }
      logEv('watchdog: not running → retry');
      try { recog.abort(); } catch { /* ignore */ }
      startSession();
    } else if (sessionActive && t - lastEventAt > 8000) {
      // the session looks open but nothing has arrived for a while: recycle it. Don't wait for
      // an "end" event — iOS sometimes never sends one after abort(), which left us stuck.
      logEv('watchdog: no events for 8s → recycle');
      recycle();
    }
  }

  // End the current session and start a fresh one shortly after, whether or not "end" fires.
  function recycle() {
    try { recog.abort(); } catch { /* ignore */ }
    sessionActive = false;
    lastEventAt = now();
    foldSession();
    scheduleRestart();
  }

  function stopListening(reason) {
    listening = false;
    stalled = false;
    clearInterval(watchdog);
    clearTimeout(restartTimer);
    logEv('stop' + (reason ? ` (${reason})` : ''));
    try { recog?.stop(); } catch { /* ignore */ }
    paintHud(true);
  }

  function paintLog() {
    $('#logText').textContent = evlog.join('\n') || '（未有紀錄）';
    $('#logText').scrollTop = 1e9;
  }

  // ================= transport =================
  const isRunning = () => listening || playing;
  function play() {
    if (settings.mode === 'voice') startListening();
    else if (settings.mode === 'auto') {
      if (pos >= tokens.length) jumpTo(0);
      playing = true;
    }
    paintHud(true);
  }
  function pause() {
    if (listening) stopListening();
    playing = false;
    paintHud(true);
  }
  function toggle() { isRunning() ? pause() : play(); }

  function jumpTo(i) {
    forgetHeard();
    manualUntil = 0;
    setPos(i);
  }
  function nextIn(list, dir) {
    if (!list.length) return pos;
    if (dir > 0) { for (const s of list) if (s > pos) return s; return tokens.length; }
    for (let k = list.length - 1; k >= 0; k--) if (list[k] < pos) return list[k];
    return 0;
  }

  // ================= HUD =================
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = String(m).padStart(2, '0'), ss = String(r).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function paintHud(force) {
    const t = now();
    if (!force && t - lastHudPaint < 250) return;
    lastHudPaint = t;
    hud.timer.textContent = fmtTime(elapsed);
    if (listening && diag.results === 0) paintTranscript();
    hud.progress.textContent = tokens.length ? Math.round((pos / tokens.length) * 100) + '%' : '0%';
    let sec = '';
    for (const mk of marks) { if (mk.title == null) continue; if (mk.at <= pos) sec = mk.title; else break; }
    hud.section.textContent = sec;
    const mode = settings.mode;
    hud.dot.className = 'dot' + (listening ? ' on' : playing ? ' play' : '');
    hud.status.textContent =
      mode === 'manual' ? '手動模式' :
      listening ? (fails >= 2 ? `重新連接中…・${langLabel()}` : `聆聽中・${langLabel()}`) :
      playing ? `捲動中 ${settings.speed}px/秒` :
      mode === 'voice' ? '已暫停（空白鍵開始聆聽）' : '已暫停（空白鍵開始捲動）';
    hud.toggle.textContent = isRunning() ? '❚❚' : '▶';
    hud.toggle.hidden = mode === 'manual';
    prompter.classList.toggle('mode-auto', mode === 'auto');
    prompter.classList.toggle('hud-pin', !isRunning());
    if (!isRunning()) prompter.classList.add('hud-on');
  }
  let hudTimer = 0;
  function pokeHud() {
    prompter.classList.add('hud-on');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => { if (isRunning()) prompter.classList.remove('hud-on'); }, IS_TOUCH ? 4000 : 2500);
  }
  function toggleHud() {
    if (prompter.classList.contains('hud-on') && isRunning()) { clearTimeout(hudTimer); prompter.classList.remove('hud-on'); }
    else pokeHud();
  }

  let toastTimer = 0;
  function toast(msg, ms = 3500) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ================= settings UI =================
  function applySettings() {
    const r = document.documentElement.style;
    r.setProperty('--fs', settings.fontSize + 'px');
    r.setProperty('--lh', settings.lineHeight);
    r.setProperty('--w', settings.width + '%');
    r.setProperty('--rl', settings.readingLine + '%');
    stage.classList.toggle('mx', !!settings.mirrorX);
    stage.classList.toggle('my', !!settings.mirrorY);
    for (const o of document.querySelectorAll('output[data-for]')) {
      const k = o.dataset.for;
      o.textContent = OUT_FMT[k] ? OUT_FMT[k](settings[k]) : settings[k];
    }
    paintTranscript();
    if (!prompter.hidden) { computeLayout(); followPos(true); paintHud(true); }
  }
  function syncInputs() {
    for (const el of document.querySelectorAll('[data-s]')) {
      const k = el.dataset.s;
      if (el.type === 'checkbox') el.checked = !!settings[k];
      else if (el.type === 'radio') el.checked = el.value === settings[k];
      else el.value = settings[k];
    }
  }
  function saveSettings() { LS.set('settings', settings); }

  for (const el of document.querySelectorAll('[data-s]')) {
    el.addEventListener('input', () => {
      const k = el.dataset.s;
      if (el.type === 'checkbox') settings[k] = el.checked;
      else if (el.type === 'radio') { if (!el.checked) return; settings[k] = el.value; }
      else if (el.type === 'range') settings[k] = +el.value;
      else settings[k] = el.value;
      saveSettings();
      applySettings();
      if (k === 'mode') refreshSupport();
    });
  }

  function refreshSupport() {
    const box = $('#support');
    const msgs = [];
    if (!SR) {
      msgs.push(IS_IOS && STANDALONE
        ? '從主畫面開啟時，iOS 沒有提供語音辨識。要用語音追蹤，請改在 Safari 裡開啟這個網址；固定速度和手動模式在這裡都能用。'
        : '這個瀏覽器沒有語音辨識功能（例如 Firefox）。請改用 Chrome、Edge 或 Safari，或使用「固定速度」／「手動」。');
      const v = document.querySelector('input[name=mode][value=voice]');
      v.disabled = true;
    } else if (!window.isSecureContext) {
      msgs.push('目前不是 HTTPS 連線，瀏覽器不會讓網頁使用麥克風。放到 GitHub Pages（HTTPS）或用 localhost 開啟即可。');
    }
    if (SR && settings.mode === 'voice' && settings.lang.startsWith('zh')) {
      msgs.push('提示：講稿是繁體就選「中文（台灣）」或「粵語」，簡體就選「普通话」，辨識結果的字形要跟講稿一致才對得上。');
    }
    if (IS_IOS && SR && settings.mode === 'voice') {
      msgs.push('iPhone／iPad：請先把這個網站的咪高峰設成「允許」，否則 Safari 每次重新聆聽都會再問一次，問的時候就會停。做法：在網址列按「大小」（aA）→「網站設定」→「咪高峰」→「允許」。若仍失敗，到「設定 → 一般 → 鍵盤」開啟「啟用聽寫」。提詞時請保持畫面在前景。');
    }
    box.hidden = !msgs.length;
    box.innerHTML = msgs.map((m) => `<div>${m}</div>`).join('');
  }

  // ================= script storage =================
  function hashText(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + ':' + s.length; }
  let posTimer = 0;
  function savePos() {
    clearTimeout(posTimer);
    posTimer = setTimeout(() => { if (renderedText != null) LS.set('pos', { h: hashText(renderedText), pos }); }, 400);
  }
  function savedPosFor(text) {
    const p = LS.get('pos', null);
    return p && p.h === hashText(text) ? p.pos : 0;
  }
  let saveTimer = 0;
  function updateStats() {
    const n = tokenize(ta.value).length;
    const cjk = (ta.value.match(new RegExp(`[${CJK}]`, 'gu')) || []).length;
    // rough speaking-time estimate: ~4 CJK chars/sec, ~2.5 words/sec
    const secs = cjk / 4 + (n - cjk) / 2.5;
    $('#stats').textContent = n ? `${n} 個字詞・約 ${Math.max(1, Math.round(secs / 60))} 分鐘` : '';
    const sp = savedPosFor(ta.value);
    $('#resume').hidden = !(sp > 0 && sp < n);
  }
  ta.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => LS.set('script', ta.value), 300);
    updateStats();
  });

  // ================= import =================
  async function readTextFile(file) {
    const buf = await file.arrayBuffer();
    for (const enc of ['utf-8', 'big5', 'gb18030']) {
      try { return new TextDecoder(enc, { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch { /* try next */ }
    }
    return new TextDecoder('utf-8').decode(buf);
  }

  async function unzip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('檔案不是有效的 Office 文件');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const files = new Map();
    for (let k = 0; k < count && dv.getUint32(off, true) === 0x02014b50; k++) {
      const method = dv.getUint16(off + 10, true);
      const csize = dv.getUint32(off + 20, true);
      const nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
      const lho = dv.getUint32(off + 42, true);
      files.set(dec.decode(u8.subarray(off + 46, off + 46 + nlen)), { method, csize, lho });
      off += 46 + nlen + elen + clen;
    }
    return {
      has: (n) => files.has(n),
      async text(name) {
        const f = files.get(name);
        if (!f) return null;
        const start = f.lho + 30 + dv.getUint16(f.lho + 26, true) + dv.getUint16(f.lho + 28, true);
        const data = u8.subarray(start, start + f.csize);
        let out;
        if (f.method === 0) out = data;
        else if (f.method === 8) {
          if (typeof DecompressionStream === 'undefined') throw new Error('瀏覽器太舊，無法解壓 Office 檔');
          const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          out = new Uint8Array(await new Response(stream).arrayBuffer());
        } else throw new Error('不支援的壓縮格式');
        return dec.decode(out);
      },
    };
  }

  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const byLocal = (root, name) => [...root.getElementsByTagNameNS('*', name)];

  function docxText(doc) {
    const out = [];
    for (const p of byLocal(doc, 'p')) {
      if (p.parentNode && p.parentNode.localName === 'p') continue;
      let s = '';
      for (const el of p.getElementsByTagNameNS('*', '*')) {
        const n = el.localName;
        if (n === 't') s += el.textContent;
        else if (n === 'tab') s += ' ';
        else if (n === 'br' || n === 'cr') s += '\n';
      }
      const style = byLocal(p, 'pStyle')[0];
      const sv = style ? (style.getAttributeNS(style.namespaceURI, 'val') || style.getAttribute('w:val') || '') : '';
      if (/^(heading|title|標題)/i.test(sv) && s.trim()) s = '# ' + s.trim();
      out.push(s);
    }
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function resolvePath(baseDir, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = (baseDir + target).split('/');
    const st = [];
    for (const p of parts) { if (p === '..') st.pop(); else if (p && p !== '.') st.push(p); }
    return st.join('/');
  }
  async function readRels(zip, partPath) {
    const dir = partPath.slice(0, partPath.lastIndexOf('/') + 1);
    const relsPath = dir + '_rels/' + partPath.slice(dir.length) + '.rels';
    const s = await zip.text(relsPath);
    const map = {};
    if (!s) return map;
    for (const r of byLocal(xml(s), 'Relationship')) map[r.getAttribute('Id')] = resolvePath(dir, r.getAttribute('Target'));
    return map;
  }
  function placeholderText(doc, types) {
    const out = [];
    for (const sp of byLocal(doc, 'sp')) {
      const ph = byLocal(sp, 'ph')[0];
      if (!ph || !types.includes(ph.getAttribute('type') || 'body')) continue;
      for (const p of byLocal(sp, 'p')) {
        if (p.namespaceURI !== 'http://schemas.openxmlformats.org/drawingml/2006/main') continue;
        let s = '';
        for (const el of p.getElementsByTagNameNS('*', '*')) {
          if (el.localName === 't') s += el.textContent;
          else if (el.localName === 'br') s += '\n';
        }
        out.push(s);
      }
    }
    return out.join('\n').replace(/\n{2,}/g, '\n').trim();
  }
  async function pptxNotes(zip) {
    const pres = xml(await zip.text('ppt/presentation.xml'));
    const rels = await readRels(zip, 'ppt/presentation.xml');
    const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const ids = byLocal(pres, 'sldId').map((e) => e.getAttributeNS(RNS, 'id') || e.getAttribute('r:id'));
    const out = [];
    let n = 0, withNotes = 0;
    for (const rid of ids) {
      n++;
      const slidePath = rels[rid];
      if (!slidePath) continue;
      const slideXml = await zip.text(slidePath);
      const title = slideXml ? placeholderText(xml(slideXml), ['title', 'ctrTitle']).replace(/\n/g, ' ') : '';
      const srels = await readRels(zip, slidePath);
      const notesPath = Object.values(srels).find((t) => /notesSlides\/notesSlide\d+\.xml$/.test(t));
      const notes = notesPath ? placeholderText(xml(await zip.text(notesPath)), ['body']) : '';
      if (notes) withNotes++;
      out.push(`# 投影片 ${n}${title ? '・' + title : ''}`);
      if (notes) out.push(notes);
      out.push('');
    }
    if (!withNotes) throw new Error('這份簡報沒有演講者備忘稿');
    return out.join('\n').trim();
  }

  // PDF: pdf.js is loaded from a CDN only when a PDF is imported (it is ~1.8 MB).
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/';
  async function pdfText(buf) {
    const lib = await import(PDFJS + 'pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
    const doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
    const lines = []; // { text, y, h, page }
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      let cur = null;
      const flush = () => { if (cur && cur.text.trim()) lines.push(cur); cur = null; };
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        const y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
        if (cur && Math.abs(y - cur.y) > h * 0.6) flush();
        if (!cur) cur = { text: '', y, h, page: n };
        cur.text += it.str;
        cur.h = Math.max(cur.h, h);
        if (it.hasEOL) flush();
      }
      flush();
    }
    return pdfLinesToScript(lines);
  }

  // Rebuild paragraphs from PDF lines: join wrapped lines, keep headings on their own.
  function pdfLinesToScript(lines) {
    const isHeading = (t) => /^#{1,6}\s/.test(t) || /^\*\*[^*]+\*\*$/.test(t) || (/^(slide|投影片|第\s*\d+\s*張)\s*\d*/i.test(t) && t.length < 70 && !/[.。!?！？]$/.test(t));
    const endsSentence = (t) => /[.!?。！？:：)\]」』"]$/.test(t);
    const blocks = [];
    let para = null, prev = null;
    for (const ln of lines) {
      const t = ln.text.normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (isHeading(t)) { blocks.push(t); para = null; prev = null; continue; }
      const gap = prev && prev.page === ln.page ? Math.abs(prev.y - ln.y) : null;
      const newPara = !para ||
        (gap != null ? gap > Math.max(prev.h, ln.h) * 1.8 : endsSentence(para.text));
      if (newPara) { para = { text: t }; blocks.push(para); }
      else {
        const a = para.text, cjkJoin = CJK_RE.test(a.slice(-1)) && CJK_RE.test(t[0]);
        para.text = a.endsWith('-') && /^[a-z]/.test(t) ? a + t : a + (cjkJoin ? '' : ' ') + t;
      }
      prev = ln;
    }
    return blocks.map((b) => (typeof b === 'string' ? b : b.text)).join('\n\n');
  }

  async function importFile(file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    try {
      let text;
      if (ext === 'docx') {
        const zip = await unzip(await file.arrayBuffer());
        text = docxText(xml(await zip.text('word/document.xml')));
      } else if (ext === 'pptx') {
        text = await pptxNotes(await unzip(await file.arrayBuffer()));
      } else if (ext === 'pdf') {
        toast('正在讀取 PDF…', 8000);
        text = await pdfText(await file.arrayBuffer());
      } else if (['doc', 'ppt', 'pages', 'key'].includes(ext)) {
        throw new Error(`不支援 .${ext}，請另存成 .docx、.pptx 或 .txt`);
      } else {
        text = await readTextFile(file);
      }
      if (!text.trim()) throw new Error('檔案裡沒有讀到文字');
      if (ta.value.trim() && ta.value.trim() !== SAMPLE.trim() && !confirm(`要用「${file.name}」取代目前的講稿嗎？`)) return;
      ta.value = text;
      LS.set('script', text);
      updateStats();
      toast(`已匯入「${file.name}」`);
    } catch (err) {
      toast('匯入失敗：' + (err.message || err));
    }
  }

  fileInput.addEventListener('change', () => { importFile(fileInput.files[0]); fileInput.value = ''; });
  $('#sample').addEventListener('click', () => {
    if (ta.value.trim() && ta.value.trim() !== SAMPLE.trim() && !confirm('要用範例取代目前的講稿嗎？')) return;
    ta.value = SAMPLE; LS.set('script', SAMPLE); updateStats();
  });
  $('#clear').addEventListener('click', () => {
    if (ta.value.trim() && !confirm('確定要清空講稿嗎？')) return;
    ta.value = ''; LS.set('script', ''); updateStats(); ta.focus();
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#drop').classList.add('show'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('show'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0; $('#drop').classList.remove('show');
    if (!prompter.hidden) return;
    importFile(e.dataTransfer.files[0]);
  });

  // ================= enter / exit prompter =================
  async function requestWake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* not allowed */ }
  }
  // iOS Safari can keep the old page's microphone capture alive across a reload, and the new
  // page then only gets a muted source. Abort recognition the moment this page is unloaded.
  const releaseMic = () => {
    listening = false;
    clearInterval(watchdog);
    clearTimeout(restartTimer);
    try { recog?.abort(); } catch { /* ignore */ }
  };
  window.addEventListener('pagehide', releaseMic);
  window.addEventListener('beforeunload', releaseMic);
  window.addEventListener('pageshow', (e) => { if (e.persisted && !prompter.hidden) paintHud(true); });

  let pausedByHide = false;
  document.addEventListener('visibilitychange', () => {
    if (prompter.hidden) return;
    if (document.visibilityState === 'hidden') {
      if (isRunning()) { pausedByHide = true; pause(); }
    } else {
      requestWake();
      if (pausedByHide) { pausedByHide = false; pokeHud(); toast('剛才切到背景，已暫停。點 ▶ 繼續。'); }
    }
  });

  function enterPrompter(resume) {
    const text = ta.value;
    LS.set('script', text);
    editor.hidden = true;
    prompter.hidden = false;
    document.body.classList.add('prompting');
    window.scrollTo(0, 0);
    if (text !== renderedText) render(text);
    applySettings();
    computeLayout();
    const start = resume ? savedPosFor(text) : 0;
    pos = -1; // force full repaint of read state
    for (let i = 0; i < tokens.length; i++) tokens[i].el.classList.toggle('read', i < start);
    pos = start;
    tokens.forEach((t) => t.el.classList.remove('cur'));
    tokens[pos]?.el.classList.add('cur');
    for (const mk of marks) mk.el.classList.toggle('read', mk.at < pos);
    heard = ''; session = ''; interim = ''; skip = 0; elapsed = 0; manualUntil = 0;
    followPos(true);
    paintTranscript();
    paintHud(true);
    pokeHud();
    requestWake();
    if (!rafId) { lastT = 0; rafId = requestAnimationFrame(tick); }
    if (settings.mode === 'voice' && tokens.length) { checkLanguage(); startListening(); }
    else if (settings.mode === 'auto') toast(IS_TOUCH ? '點 ▶ 開始捲動，用「慢／快」調整速度' : '按空白鍵開始捲動，↑ ↓ 調整速度');
  }

  function checkLanguage() {
    const share = (re) => tokens.filter((t) => re.test(t.norm)).length / (tokens.length || 1);
    const cjk = share(CJK_RE), latin = share(/^[a-z0-9'.-]+$/);
    const lang = settings.lang.slice(0, 2);
    let to = null;
    if (latin > 0.8 && ['zh', 'ja', 'ko'].includes(lang)) to = 'en-US';
    else if (cjk > 0.6 && !['zh', 'ja'].includes(lang)) {
      const g = guessLang();
      to = /^(zh|ja)/.test(g) ? g : 'zh-TW';
    }
    if (!to) return;
    settings.lang = to;
    saveSettings(); syncInputs(); refreshSupport();
    toast(`講稿的語言和辨識語言不同，已改用「${langLabel()}」辨識。可在設定裡更改。`, 5000);
  }

  function exitPrompter() {
    pause();
    cancelAnimationFrame(rafId); rafId = 0;
    if (document.fullscreenElement) document.exitFullscreen?.();
    wakeLock?.release?.(); wakeLock = null;
    prompter.hidden = true;
    editor.hidden = false;
    document.body.classList.remove('prompting');
    updateStats();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else (prompter.requestFullscreen || prompter.webkitRequestFullscreen)?.call(prompter);
  }

  function bumpFont(d) {
    settings.fontSize = clamp(settings.fontSize + d, 20, 140);
    saveSettings(); syncInputs(); applySettings();
    toast(`字級 ${settings.fontSize}px`, 900);
  }

  function bumpSpeed(d) {
    settings.speed = clamp(settings.speed + d, 5, 250);
    saveSettings(); syncInputs(); applySettings(); paintHud(true);
    toast(`速度 ${settings.speed}px/秒`, 800);
  }
  $('#hSlower').addEventListener('click', () => { bumpSpeed(-5); pokeHud(); });
  $('#hFaster').addEventListener('click', () => { bumpSpeed(5); pokeHud(); });
  $('#start').addEventListener('click', () => enterPrompter(false));
  $('#resume').addEventListener('click', () => enterPrompter(true));
  $('#hToggle').addEventListener('click', toggle);
  $('#hHome').addEventListener('click', () => jumpTo(0));
  $('#hSmaller').addEventListener('click', () => bumpFont(-4));
  $('#hBigger').addEventListener('click', () => bumpFont(4));
  $('#hMirror').addEventListener('click', () => { settings.mirrorX = !settings.mirrorX; saveSettings(); syncInputs(); applySettings(); });
  $('#hFull').addEventListener('click', toggleFullscreen);
  $('#hLog').addEventListener('click', () => { paintLog(); $('#logPanel').hidden = false; });
  $('#logClose').addEventListener('click', () => { $('#logPanel').hidden = true; });
  $('#logCopy').addEventListener('click', async () => {
    const text = `${navigator.userAgent}\nmode=${settings.mode} lang=${settings.lang}\n---\n` + evlog.join('\n');
    try { await navigator.clipboard.writeText(text); }
    catch { const ta2 = document.createElement('textarea'); ta2.value = text; document.body.appendChild(ta2); ta2.select(); document.execCommand('copy'); ta2.remove(); }
    toast('已複製語音紀錄', 1200);
  });
  $('#hExit').addEventListener('click', exitPrompter);

  // ================= keyboard =================
  document.addEventListener('keydown', (e) => {
    if (prompter.hidden) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); enterPrompter(false); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const auto = settings.mode === 'auto';
    let handled = true;
    switch (e.key) {
      case ' ': case 'Spacebar':
        if (settings.mode === 'manual') jumpTo(nextIn(sentStarts, 1)); else toggle();
        break;
      case 'ArrowRight': jumpTo(nextIn(auto ? paraStarts : sentStarts, 1)); break;
      case 'ArrowLeft': jumpTo(nextIn(auto ? paraStarts : sentStarts, -1)); break;
      case 'ArrowDown':
        if (auto) bumpSpeed(5);
        else jumpTo(nextIn(paraStarts, 1));
        break;
      case 'ArrowUp':
        if (auto) bumpSpeed(-5);
        else jumpTo(nextIn(paraStarts, -1));
        break;
      case 'PageDown': jumpTo(nextIn(paraStarts, 1)); break;
      case 'PageUp': jumpTo(nextIn(paraStarts, -1)); break;
      case 'Home': jumpTo(0); break;
      case 'End': jumpTo(tokens.length); break;
      case '+': case '=': bumpFont(4); break;
      case '-': case '_': bumpFont(-4); break;
      case 'm': case 'M': $('#hMirror').click(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'Escape': if (!document.fullscreenElement) exitPrompter(); else handled = false; break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); pokeHud(); }
  });

  // ================= pointer: wheel, drag, tap =================
  function manualScroll(dy) {
    targetY += dy * (settings.mirrorY ? -1 : 1);
    if (settings.mode !== 'auto') curY = targetY;
    manualUntil = now() + 100000;
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => {
      manualUntil = 0;
      if (settings.mode !== 'auto') { forgetHeard(); setPos(indexAtScroll(targetY), { scroll: false }); }
    }, 900);
  }
  stage.addEventListener('wheel', (e) => { e.preventDefault(); manualScroll(e.deltaY); pokeHud(); }, { passive: false });

  // mouse: click a word to jump there. touch: tap toggles the controls, long-press a word
  // to jump there, drag to scroll, pinch with two fingers to change the font size.
  const pointers = new Map();
  let drag = null, pinch = null, pressTimer = 0, applyRaf = 0;
  const wordAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest ? el.closest('.w') : null; };
  const scheduleApply = () => { if (!applyRaf) applyRaf = requestAnimationFrame(() => { applyRaf = 0; applySettings(); }); };

  stage.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    if (pointers.size === 2) {
      clearTimeout(pressTimer);
      drag = null;
      stage.classList.remove('dragging');
      const [p1, p2] = [...pointers.values()];
      pinch = { d0: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1, f0: settings.fontSize };
      return;
    }
    if (pointers.size > 2) return;
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, long: false, id: e.pointerId, touch: e.pointerType !== 'mouse' };
    if (drag.touch) {
      pressTimer = setTimeout(() => {
        if (!drag || drag.moved) return;
        const w = wordAt(drag.sx, drag.sy);
        if (w) { drag.long = true; jumpTo(+w.dataset.i); toast('已把進度設在這裡', 900); }
      }, 450);
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') pokeHud();
    const pt = pointers.get(e.pointerId);
    if (pt) { pt.x = e.clientX; pt.y = e.clientY; }
    if (pinch) {
      if (pointers.size < 2) return;
      const [p1, p2] = [...pointers.values()];
      const f = clamp(Math.round((pinch.f0 * Math.hypot(p1.x - p2.x, p1.y - p2.y)) / pinch.d0 / 2) * 2, 20, 140);
      if (f !== settings.fontSize) { settings.fontSize = f; scheduleApply(); }
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.abs(e.clientY - drag.sy) + Math.abs(e.clientX - drag.sx) > 8) {
      drag.moved = true;
      clearTimeout(pressTimer);
      stage.classList.add('dragging');
    }
    if (drag.moved) { manualScroll(drag.y - e.clientY); }
    drag.x = e.clientX; drag.y = e.clientY;
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) { pinch = null; saveSettings(); syncInputs(); toast(`字級 ${settings.fontSize}px`, 900); }
      drag = null;
      return;
    }
    clearTimeout(pressTimer);
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag;
    drag = null;
    stage.classList.remove('dragging');
    if (d.moved || d.long || e.type !== 'pointerup') return;
    if (listening && (stalled || !sessionActive)) {
      // a tap is a user gesture, which iOS always accepts for starting recognition
      logEv('tap → start()');
      startSession();
      toast('繼續聆聽', 900);
      return;
    }
    if (d.touch) { toggleHud(); return; }
    const w = wordAt(e.clientX, e.clientY);
    if (w) { jumpTo(+w.dataset.i); toast('已把進度設在這裡', 900); }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  prompter.addEventListener('mousemove', pokeHud);

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!prompter.hidden) { computeLayout(); followPos(true); } }, 100);
  });

  // ================= init =================
  $('#hFull').hidden = !CAN_FULLSCREEN;
  $('#startMobile').addEventListener('click', () => enterPrompter(false));
  ta.value = LS.get('script', null) ?? SAMPLE;
  syncInputs();
  applySettings();
  refreshSupport();
  updateStats();

  // test hook: simulate recognised speech, e.g. __tp.say('大家好今天')
  window.__tp = {
    say(text, final = true) {
      if (final) { session = joinResults([session, text].filter(Boolean)); interim = ''; } else interim = text;
      track(); paintTranscript();
      return pos;
    },
    get pos() { return pos; },
    get tokens() { return tokens.length; },
  };
})();
