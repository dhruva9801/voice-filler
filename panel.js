// ===================== PAGE FUNCTIONS =====================
// Everything in this section runs IN THE WEB PAGE via executeScript.
// Each function must be self-contained: no outside helpers, no panel variables.

function extractFields() {
  const labelText = lab => {
    const c = lab.cloneNode(true);
    c.querySelectorAll('input, select, textarea').forEach(n => n.remove());
    return c.textContent.trim();
  };
  const sel =
    'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select';
  return [...document.querySelectorAll(sel)].map((el, i) => {
    el.dataset.ffId = String(i);
    const label =
      (el.labels?.[0] && labelText(el.labels[0])) ||
      el.getAttribute('aria-label') ||
      el.placeholder ||
      el.name ||
      '';
    return {
      id: String(i),
      tag: el.tagName.toLowerCase(),
      type: el.type,
      name: el.name,
      label,
      options: el.tagName === 'SELECT' ? [...el.options].map(o => o.text) : undefined,
    };
  });
}

function fillFields(values) {
  const setNative = (el, val) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const results = {};
  for (const [id, val] of Object.entries(values)) {
    const el = document.querySelector(`[data-ff-id="${id}"]`);
    if (!el) { results[id] = 'not found'; continue; }

    if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked !== Boolean(val)) el.click();
    } else if (el.tagName === 'SELECT') {
      const opt = [...el.options].find(o => o.text.trim() === String(val).trim());
      if (!opt) { results[id] = 'no matching option'; continue; }
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      setNative(el, String(val));
    }
    results[id] = 'ok';
  }
  return results;
}

function readValue(id) {
  const el = document.querySelector(`[data-ff-id="${id}"]`);
  if (!el) return null;
  if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 'true' : '';
  return el.value;
}

function highlight(id) {
  document.querySelectorAll('[data-ff-id]').forEach(el => (el.style.outline = ''));
  const el = document.querySelector(`[data-ff-id="${id}"]`);
  if (!el) return 'not found';
  el.style.outline = '3px solid orange';
  el.scrollIntoView({ block: 'center' });
  return 'ok';
}

function listMedia() {
  return [...document.querySelectorAll('audio, video')].map((el, i) => {
    el.dataset.ffMedia = String(i);
    return { id: String(i), tag: el.tagName.toLowerCase(), duration: el.duration, paused: el.paused };
  });
}

async function playMedia(id) {
  const el = document.querySelector(`[data-ff-media="${id}"]`);
  if (!el) return 'not found';
  try { await el.play(); return 'playing'; }
  catch (e) { return e.name; } // NotAllowedError = click the page once, then retry
}

// ===================== PANEL CODE =====================
// Everything below runs in the side panel.

async function runInPage(func, args = []) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return res.result;
}

let fields = [], cur = 0, listening = false, profile = {};
const $ = id => document.getElementById(id);
const log = msg => ($('log').textContent = msg + '\n' + $('log').textContent);

// Safe DOM builder: never puts untrusted text into innerHTML
function h(tag, text = '', ...children) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  e.append(...children);
  return e;
}

// ---------- text normalization ----------
const NATO = {
  alpha:'a', bravo:'b', charlie:'c', delta:'d', echo:'e', foxtrot:'f', golf:'g',
  hotel:'h', india:'i', juliet:'j', kilo:'k', lima:'l', mike:'m', november:'n',
  oscar:'o', papa:'p', quebec:'q', romeo:'r', sierra:'s', tango:'t', uniform:'u',
  victor:'v', whiskey:'w', xray:'x', yankee:'y', zulu:'z',
};

// "d h r u v a" -> "dhruva"; leaves normal words alone
function collapseSpelled(text) {
  const out = [];
  let run = '';
  for (const raw of text.split(/\s+/)) {
    const w = NATO[raw.toLowerCase()] ?? raw;
    if (/^[a-z0-9]$/i.test(w)) { run += w; continue; }
    if (run) { out.push(run); run = ''; }
    out.push(w);
  }
  if (run) out.push(run);
  return out.join(' ');
}

function normalizeEmail(text) {
  let t = ' ' + text.toLowerCase() + ' ';
  t = t.replace(/\s+at\s+/g, ' @ ')
       .replace(/\s+dot\s+/g, ' . ')
       .replace(/\s+underscore\s+/g, ' _ ')
       .replace(/\s+(dash|hyphen)\s+/g, ' - ');
  return collapseSpelled(t.trim()).replace(/\s+/g, '');
}

function normalizeFor(field, text) {
  if (field.type === 'email') return normalizeEmail(text);
  if (field.tag === 'textarea') return text;  // free-form answers: leave as spoken
  return collapseSpelled(text);                // names, short inputs
}

// ---------- random ----------
const WORDS = ['banana', 'nebula', 'quokka', 'velvet', 'thunder', 'pickle',
               'galaxy', 'marmalade', 'zeppelin', 'cactus', 'waffle', 'comet'];
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function randomFor(field) {
  if (field.tag === 'select') return pick(field.options);
  if (field.type === 'checkbox') return Math.random() < 0.5;
  if (field.type === 'radio') return true; // real random choice needs radio groups (your task)
  return pick(WORDS);
}

// ---------- saved info (profile) ----------
async function loadProfile() {
  const { profile: saved = {} } = await chrome.storage.local.get('profile');
  profile = saved;
  renderProfile();
}

async function saveKey(key, value) {
  key = key.trim().toLowerCase();
  if (!key) return log('need a name to save under');
  const existed = key in profile;
  profile[key] = value;
  await chrome.storage.local.set({ profile });
  renderProfile();
  log(`${existed ? 'updated' : 'saved'} "${key}"`);
}

async function deleteKey(key) {
  delete profile[key];
  await chrome.storage.local.set({ profile });
  renderProfile();
  log(`deleted "${key}"`);
}

function renderProfile() {
  const keys = Object.keys(profile);
  if (!keys.length) return $('profileList').replaceChildren(h('i', 'nothing saved yet'));
  $('profileList').replaceChildren(...keys.map(k => {
    const del = h('button', '✕');
    del.onclick = () => deleteKey(k);
    return h('div', '', del, ` ${k}: ${profile[k]}`);
  }));
}

// Longest key wins, so "first name" beats "name"
function matchKey(field) {
  const hay = `${field.label} ${field.name} ${field.type}`.toLowerCase();
  return Object.keys(profile)
    .sort((a, b) => b.length - a.length)
    .find(k => hay.includes(k));
}

async function autofill() {
  if (!fields.length) return log('scan first');
  const values = {};
  for (const f of fields) {
    if (f.type === 'radio' || f.type === 'checkbox') continue;
    const k = matchKey(f);
    if (k) values[f.id] = profile[k];
  }
  const n = Object.keys(values).length;
  if (!n) return log('no saved info matched any field');
  const result = await runInPage(fillFields, [values]);
  log(`autofilled ${n}: ${JSON.stringify(result)}`);
}

// ---------- field navigation + filling ----------
function render() {
  $('fields').replaceChildren(...fields.map((f, i) => {
    const d = h('div', `${i === cur ? '▶ ' : ''}[${f.id}] ${f.label || f.name || f.type}`);
    if (i === cur) d.className = 'current';
    return d;
  }));
}

async function move(delta) {
  if (!fields.length) return;
  cur = Math.max(0, Math.min(fields.length - 1, cur + delta));
  await runInPage(highlight, [fields[cur].id]);
  render();
}

async function fillCurrent(value, advance = true) {
  if (!fields.length) return log('scan first');
  const id = fields[cur].id;
  const result = await runInPage(fillFields, [{ [id]: value }]);
  log(`[${id}] ${result[id]}`);
  if (advance && result[id] === 'ok') await move(1);
}

// ---------- voice commands ----------
async function handleCommand(c) {
  if (c === 'next') return move(1);
  if (c === 'back') return move(-1);
  if (c === 'clear') return fillCurrent('', false);
  if (c === 'random') {
    if (!fields.length) return log('scan first');
    return fillCurrent(randomFor(fields[cur]));
  }
  if (c === 'autofill') return autofill();

  if (c.startsWith('fill ')) {                    // "command fill email"
    const key = c.slice(5).trim();
    if (!(key in profile)) return log(`nothing saved for "${key}"`);
    return fillCurrent(profile[key]);
  }

  if (c.startsWith('save ')) {                    // "command save email" = save what's in the current field
    if (!fields.length) return log('scan first');
    const value = await runInPage(readValue, [fields[cur].id]);
    if (!value) return log('current field is empty, nothing to save');
    return saveKey(c.slice(5), value);
  }

  log(`unknown command: "${c}"`);
}

// ---------- speech ----------
let rec = null;
if ('webkitSpeechRecognition' in window) {
  rec = new webkitSpeechRecognition();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = 'en-US';

  rec.onresult = async e => {
    try {
      const text = e.results[e.results.length - 1][0].transcript.trim();
      log('heard: ' + text);
      const cmd = text.toLowerCase().replace(/[^\w\s]/g, '').trim();

      if (cmd.startsWith('command ')) return await handleCommand(cmd.slice(8).trim());
      if (!fields.length) return log('scan first');
      await fillCurrent(normalizeFor(fields[cur], text));
    } catch (err) {
      log('error: ' + err.message);
    }
  };

  // Chrome ends recognition after silence even with continuous = true
  rec.onend = () => { if (listening) rec.start(); };
  rec.onerror = e => log('mic error: ' + e.error); // "not-allowed" = open permission.html
} else {
  log('speech recognition not available here');
}

function setMic(on) {
  if (!rec) return log('no speech recognition');
  listening = on;
  on ? rec.start() : rec.stop();
  $('mic').textContent = on ? 'Stop mic' : 'Start mic';
}

// ---------- buttons ----------
$('scan').onclick = async () => {
  try {
    fields = await runInPage(extractFields);
    cur = 0;
    render();
    log(`found ${fields.length} fields`);
    if (fields.length) await runInPage(highlight, [fields[0].id]);
  } catch (e) {
    log('scan error: ' + e.message);
  }
};

$('mic').onclick = () => setMic(!listening);

$('autofill').onclick = () => autofill().catch(e => log('autofill error: ' + e.message));

$('pSave').onclick = async () => {
  await saveKey($('pKey').value, $('pVal').value);
  $('pKey').value = '';
  $('pVal').value = '';
};

$('media').onclick = async () => {
  try {
    const media = await runInPage(listMedia);
    if (!media.length) {
      return $('mediaList').replaceChildren(h('i', 'no audio/video found (could be inside an iframe)'));
    }
    $('mediaList').replaceChildren(...media.map(m => {
      const b = h('button', `▶ ${m.tag} ${m.id}`);
      b.onclick = async () => {
        setMic(false); // stops the mic from transcribing the clip
        log('play: ' + (await runInPage(playMedia, [m.id])));
      };
      return b;
    }));
  } catch (e) {
    log('media error: ' + e.message);
  }
};

loadProfile().catch(e => log('profile load error: ' + e.message));
log('panel ready');