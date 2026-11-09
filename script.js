/* ==========================================================================
   Digital Clock — clock, alarms, stopwatch, countdown timer
   Plain JavaScript, no dependencies.
   ========================================================================== */
(() => {
  'use strict';

  /* ---------- Constants & small helpers ---------- */
  const MAX_ALARMS = 10;
  const SNOOZE_MS = 5 * 60 * 1000;
  const MAX_TIMER_SECONDS = 99 * 3600 + 59 * 60 + 59;
  const BASE_TITLE = document.title;

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');

  /** Safe localStorage wrapper (JSON values, never throws). */
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem('clock-' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('clock-' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
  };

  /** Tiny DOM builder: h('div', {class: 'x', onclick: fn}, child, ...) */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, val] of Object.entries(props)) {
      if (key === 'class') el.className = val;
      else if (key === 'checked') el.checked = Boolean(val);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), val);
      else if (val !== false && val != null) el.setAttribute(key, val === true ? '' : val);
    }
    el.append(...children);
    return el;
  }

  /* ---------- Preferences ---------- */
  const prefs = {
    theme: store.get('theme', window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    format: store.get('format', '12'),
  };
  if (!['light', 'dark'].includes(prefs.theme)) prefs.theme = 'dark';
  if (!['12', '24'].includes(prefs.format)) prefs.format = '12';

  /* ---------- Sound (Web Audio — no audio files needed) ---------- */
  const Sound = (() => {
    let ctx = null;
    let loop = null;
    let stopper = null;

    // Browsers only allow audio after a user gesture, so unlock on first interaction.
    function unlock() {
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
      } catch { /* audio unsupported */ }
    }

    function beep(freq, start, duration) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.3, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.05);
    }

    function pattern() {
      if (!ctx) return;
      const t = ctx.currentTime;
      [784, 988, 784, 988].forEach((f, i) => beep(f, t + i * 0.22, 0.16));
    }

    function play() {            // repeats until stop() or 60 seconds
      unlock();
      stop();
      pattern();
      loop = setInterval(pattern, 1400);
      stopper = setTimeout(stop, 60000);
    }

    function stop() {
      clearInterval(loop);
      clearTimeout(stopper);
      loop = stopper = null;
    }

    return { unlock, play, stop, test() { unlock(); pattern(); } };
  })();

  document.addEventListener('pointerdown', Sound.unlock, { once: true });
  document.addEventListener('keydown', Sound.unlock, { once: true });

  /* ---------- Element references ---------- */
  const el = {
    html: document.documentElement,
    themeBtn: $('themeBtn'),
    formatBtns: document.querySelectorAll('[data-format]'),
    slots: ['h1', 'h2', 'm1', 'm2', 's1', 's2'].map($),
    clock: $('clock'), ampm: $('ampm'), secFill: $('secFill'),
    weekday: $('weekday'), fullDate: $('fullDate'), tz: $('tz'),
    alarmForm: $('alarmForm'), alarmTime: $('alarmTime'), alarmLabel: $('alarmLabel'), alarmRepeat: $('alarmRepeat'),
    alarmError: $('alarmError'), alarmStatus: $('alarmStatus'), alarmEmpty: $('alarmEmpty'), alarmList: $('alarmList'),
    testSound: $('testSound'),
    swDisplay: $('swDisplay'), swStart: $('swStart'), swStop: $('swStop'), swReset: $('swReset'),
    cdDisplay: $('cdDisplay'), cdFill: $('cdFill'), cdError: $('cdError'), cdStart: $('cdStart'), cdReset: $('cdReset'),
    cdInputs: { h: $('cdH'), m: $('cdM'), s: $('cdS') },
    presets: document.querySelectorAll('[data-preset]'),
    ring: $('ring'), ringTitle: $('ringTitle'), ringText: $('ringText'), snoozeBtn: $('snoozeBtn'), dismissBtn: $('dismissBtn'),
  };

  /* ==========================================================================
     Theme & time format
     ========================================================================== */
  function applyTheme() {
    el.html.dataset.theme = prefs.theme;
    el.themeBtn.setAttribute('aria-label', prefs.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }

  function applyFormat() {
    el.formatBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.format === prefs.format)));
    updateClock();
    renderAlarms();
  }

  el.themeBtn.addEventListener('click', () => {
    prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
    store.set('theme', prefs.theme);
    applyTheme();
  });

  el.formatBtns.forEach((btn) => btn.addEventListener('click', () => {
    prefs.format = btn.dataset.format;
    store.set('format', prefs.format);
    applyFormat();
  }));

  /** Format "HH:MM" (24h string) for display in the chosen format. */
  function formatHM(hm) {
    const [H, M] = hm.split(':').map(Number);
    if (prefs.format === '24') return `${pad(H)}:${pad(M)}`;
    return `${H % 12 || 12}:${pad(M)} ${H >= 12 ? 'PM' : 'AM'}`;
  }

  /* ==========================================================================
     Main clock
     ========================================================================== */
  /** Update a digit and replay its small transition only when the value changes. */
  function setDigit(node, value) {
    if (node.textContent === value) return;
    node.textContent = value;
    node.classList.remove('tick');
    void node.offsetWidth;            // restart the CSS animation
    node.classList.add('tick');
  }

  function updateClock() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();

    const is12 = prefs.format === '12';
    if (is12) {
      el.ampm.textContent = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
    }
    el.ampm.hidden = !is12;

    const digits = pad(hours) + pad(minutes) + pad(seconds);
    el.slots.forEach((node, i) => setDigit(node, digits[i]));
    el.clock.setAttribute('aria-label', `Current time ${pad(hours)}:${pad(minutes)}${is12 ? ' ' + el.ampm.textContent : ''}`);

    // Seconds progress bar (skip the rewind animation at :00)
    el.secFill.style.transition = seconds === 0 ? 'none' : '';
    el.secFill.style.transform = `scaleX(${(seconds + 1) / 60})`;

    // Date
    el.weekday.textContent = now.toLocaleDateString(undefined, { weekday: 'long' });
    el.fullDate.textContent = now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

    checkAlarms(now);
  }

  function showTimeZone() {
    const offset = -new Date().getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '−';
    const hh = Math.floor(Math.abs(offset) / 60);
    const mm = Math.abs(offset) % 60;
    let zone = '';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* ignore */ }
    el.tz.textContent = `${zone ? zone + ' ' : ''}(UTC${sign}${hh}${mm ? ':' + pad(mm) : ''}) — local system time`;
  }

  /* ==========================================================================
     Ringing banner (shared by alarms and the countdown timer)
     ========================================================================== */
  let ringing = null;
  let snoozed = null;

  function ring(info) {
    ringing = info;
    el.ringTitle.textContent = info.title;
    el.ringText.textContent = info.text;
    el.snoozeBtn.hidden = !info.snoozable;
    el.ring.hidden = false;
    document.title = `⏰ ${info.title}`;
    Sound.play();
  }

  function dismissRing() {
    ringing = null;
    el.ring.hidden = true;
    document.title = BASE_TITLE;
    Sound.stop();
  }

  el.dismissBtn.addEventListener('click', dismissRing);
  el.snoozeBtn.addEventListener('click', () => {
    if (!ringing) return;
    snoozed = { at: Date.now() + SNOOZE_MS, info: ringing };
    const until = new Date(snoozed.at);
    el.alarmStatus.textContent = `Snoozed until ${formatHM(`${pad(until.getHours())}:${pad(until.getMinutes())}`)}.`;
    dismissRing();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ringing) dismissRing(); });

  /* ==========================================================================
     Alarms
     ========================================================================== */
  let alarms = store.get('alarms', []);
  alarms = Array.isArray(alarms)
    ? alarms.filter((a) => a && /^\d{2}:\d{2}$/.test(a.time) && typeof a.id === 'string')
    : [];
  const lastFired = {};      // alarm id -> "date hh:mm", prevents firing twice in one minute

  const saveAlarms = () => store.set('alarms', alarms);

  function checkAlarms(now) {
    const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const stamp = `${now.toDateString()} ${hm}`;

    for (const alarm of alarms) {
      if (!alarm.enabled || alarm.time !== hm || lastFired[alarm.id] === stamp) continue;
      lastFired[alarm.id] = stamp;
      if (!alarm.repeat) alarm.enabled = false;      // one-time alarms switch themselves off
      saveAlarms();
      renderAlarms();
      el.alarmStatus.textContent = '';
      ring({ title: alarm.label || 'Alarm', text: `It is ${formatHM(alarm.time)}.`, snoozable: true });
    }

    if (snoozed && Date.now() >= snoozed.at) {
      const { info } = snoozed;
      snoozed = null;
      el.alarmStatus.textContent = '';
      ring(info);
    }
  }

  function renderAlarms() {
    el.alarmList.replaceChildren();
    const sorted = [...alarms].sort((a, b) => a.time.localeCompare(b.time));
    el.alarmEmpty.hidden = sorted.length > 0;

    sorted.forEach((alarm) => {
      const toggle = h('input', {
        type: 'checkbox', checked: alarm.enabled, 'aria-label': `Alarm at ${formatHM(alarm.time)}`,
        onchange: (e) => { alarm.enabled = e.target.checked; saveAlarms(); renderAlarms(); },
      });
      const meta = [alarm.label, alarm.repeat ? 'Daily' : 'Once'].filter(Boolean).join(' — ');
      const item = h('li', { class: 'alarm-item' + (alarm.enabled ? '' : ' off') },
        h('div', { class: 'alarm-info' },
          h('div', { class: 'alarm-time' }, formatHM(alarm.time)),
          h('div', { class: 'alarm-meta' }, meta)),
        h('label', { class: 'switch' }, toggle, h('span', { class: 'slider' })),
        h('button', {
          type: 'button', class: 'del', 'aria-label': `Delete alarm at ${formatHM(alarm.time)}`,
          onclick: () => { alarms = alarms.filter((a) => a.id !== alarm.id); saveAlarms(); renderAlarms(); },
        }, '×'));
      el.alarmList.appendChild(item);
    });
  }

  function setDefaultAlarmTime() {
    const next = new Date(Date.now() + 60000);
    el.alarmTime.value = `${pad(next.getHours())}:${pad(next.getMinutes())}`;
  }

  el.alarmForm.addEventListener('submit', (e) => {
    e.preventDefault();
    Sound.unlock();
    const time = el.alarmTime.value;
    const label = el.alarmLabel.value.trim();
    const fail = (msg) => { el.alarmError.textContent = msg; };

    if (!/^\d{2}:\d{2}$/.test(time)) return fail('Choose a time for the alarm.');
    if (alarms.length >= MAX_ALARMS) return fail(`You can have up to ${MAX_ALARMS} alarms. Delete one to add another.`);
    if (alarms.some((a) => a.time === time)) return fail(`An alarm for ${formatHM(time)} already exists.`);

    alarms.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      time, label, repeat: el.alarmRepeat.checked, enabled: true,
    });
    saveAlarms();
    renderAlarms();
    el.alarmError.textContent = '';
    el.alarmLabel.value = '';
    el.alarmRepeat.checked = false;
    el.alarmStatus.textContent = `Alarm set for ${formatHM(time)}.`;
  });

  el.testSound.addEventListener('click', Sound.test);

  /* ==========================================================================
     Stopwatch (timestamp based, so it stays accurate even if frames are skipped)
     ========================================================================== */
  const sw = { running: false, startedAt: 0, elapsed: 0, raf: 0 };

  const swTime = () => sw.elapsed + (sw.running ? performance.now() - sw.startedAt : 0);

  function swRender() {
    const t = Math.floor(swTime());
    const cs = Math.floor(t / 10) % 100;
    const s = Math.floor(t / 1000) % 60;
    const m = Math.floor(t / 60000) % 60;
    const hr = Math.floor(t / 3600000);
    el.swDisplay.textContent = `${pad(hr)}:${pad(m)}:${pad(s)}.${pad(cs)}`;
  }

  function swButtons() {
    el.swStart.disabled = sw.running;
    el.swStart.textContent = sw.elapsed > 0 ? 'Resume' : 'Start';
    el.swStop.disabled = !sw.running;
    el.swReset.disabled = !sw.running && sw.elapsed === 0;
  }

  function swLoop() {
    swRender();
    if (sw.running) sw.raf = requestAnimationFrame(swLoop);
  }

  el.swStart.addEventListener('click', () => {
    if (sw.running) return;
    sw.running = true;
    sw.startedAt = performance.now();
    swButtons();
    swLoop();
  });

  el.swStop.addEventListener('click', () => {
    if (!sw.running) return;
    sw.elapsed += performance.now() - sw.startedAt;
    sw.running = false;
    cancelAnimationFrame(sw.raf);
    swRender();
    swButtons();
  });

  el.swReset.addEventListener('click', () => {
    sw.running = false;
    sw.elapsed = 0;
    cancelAnimationFrame(sw.raf);
    swRender();
    swButtons();
  });

  /* ==========================================================================
     Countdown timer
     ========================================================================== */
  // mode: 'idle' (editing inputs) | 'running' | 'paused'
  const cd = { mode: 'idle', total: 0, remaining: 0, endAt: 0, timer: 0 };

  const fmtDuration = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;

  /** Read and validate the inputs. Returns {seconds} or {error}. */
  function readTimerInputs() {
    const read = (input) => (input.value.trim() === '' ? 0 : Number(input.value));
    const h = read(el.cdInputs.h), m = read(el.cdInputs.m), s = read(el.cdInputs.s);
    const ok = [h, m, s].every(Number.isInteger) && h >= 0 && h <= 99 && m >= 0 && m <= 59 && s >= 0 && s <= 59;
    if (!ok) return { error: 'Use whole numbers: hours 0–99, minutes 0–59, seconds 0–59.' };
    const seconds = h * 3600 + m * 60 + s;
    if (seconds === 0) return { error: 'Set a time greater than zero.' };
    if (seconds > MAX_TIMER_SECONDS) return { error: 'That time is too long.' };
    return { seconds, h, m, s };
  }

  function setInputsDisabled(disabled) {
    Object.values(el.cdInputs).forEach((i) => { i.disabled = disabled; });
    el.presets.forEach((p) => { p.disabled = disabled; });
  }

  function cdRender() {
    const secs = Math.ceil(cd.remaining / 1000);
    el.cdDisplay.textContent = fmtDuration(secs);
    el.cdDisplay.classList.toggle('low', cd.mode === 'running' && secs <= 10);
    const ratio = cd.mode === 'idle' || !cd.total ? 1 : Math.max(0, cd.remaining / (cd.total * 1000));
    el.cdFill.style.transform = `scaleX(${ratio})`;
  }

  function cdButtons() {
    el.cdStart.textContent = cd.mode === 'running' ? 'Pause' : cd.mode === 'paused' ? 'Resume' : 'Start';
    el.cdReset.disabled = cd.mode === 'idle';
    setInputsDisabled(cd.mode !== 'idle');
  }

  /** While idle, show the time the inputs currently describe. */
  function cdPreview() {
    if (cd.mode !== 'idle') return;
    const r = readTimerInputs();
    cd.remaining = r.seconds ? r.seconds * 1000 : 0;
    cdRender();
  }

  function cdTick() {
    cd.remaining = cd.endAt - Date.now();
    if (cd.remaining <= 0) return cdFinish();
    cdRender();
  }

  function cdFinish() {
    clearInterval(cd.timer);
    const total = cd.total;
    cd.mode = 'idle';
    cd.remaining = 0;
    cdRender();
    cdButtons();
    ring({ title: 'Timer finished', text: `Your ${fmtDuration(total)} countdown is complete.`, snoozable: false });
  }

  el.cdStart.addEventListener('click', () => {
    Sound.unlock();
    if (cd.mode === 'running') {                       // pause
      clearInterval(cd.timer);
      cd.remaining = Math.max(0, cd.endAt - Date.now());
      cd.mode = 'paused';
    } else {
      if (cd.mode === 'idle') {                        // fresh start: validate inputs
        const r = readTimerInputs();
        if (r.error) { el.cdError.textContent = r.error; return; }
        cd.total = r.seconds;
        cd.remaining = r.seconds * 1000;
        store.set('timer', { h: r.h, m: r.m, s: r.s });
      }
      el.cdError.textContent = '';
      cd.mode = 'running';
      cd.endAt = Date.now() + cd.remaining;
      cd.timer = setInterval(cdTick, 200);
    }
    cdButtons();
    cdRender();
  });

  el.cdReset.addEventListener('click', () => {
    clearInterval(cd.timer);
    cd.mode = 'idle';
    el.cdError.textContent = '';
    cdButtons();
    cdPreview();
    cdRender();
  });

  Object.values(el.cdInputs).forEach((input) => input.addEventListener('input', () => {
    el.cdError.textContent = '';
    cdPreview();
  }));

  el.presets.forEach((btn) => btn.addEventListener('click', () => {
    if (cd.mode !== 'idle') return;
    const sec = Number(btn.dataset.preset);
    el.cdInputs.h.value = Math.floor(sec / 3600);
    el.cdInputs.m.value = Math.floor(sec / 60) % 60;
    el.cdInputs.s.value = sec % 60;
    el.cdError.textContent = '';
    cdPreview();
  }));

  /* ==========================================================================
     Start-up
     ========================================================================== */
  function init() {
    const saved = store.get('timer', null);
    if (saved && ['h', 'm', 's'].every((k) => Number.isInteger(saved[k]))) {
      el.cdInputs.h.value = saved.h;
      el.cdInputs.m.value = saved.m;
      el.cdInputs.s.value = saved.s;
    }

    applyTheme();
    showTimeZone();
    setDefaultAlarmTime();
    applyFormat();            // also renders the clock and the alarm list
    swRender();
    swButtons();
    cdButtons();
    cdPreview();

    // Start ticking on the next whole second, then every second.
    setTimeout(() => {
      updateClock();
      setInterval(updateClock, 1000);
    }, 1000 - (Date.now() % 1000));

    // Catch up immediately when the tab becomes visible again.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) updateClock(); });
  }

  init();
})();
