// ===================== PAGE FUNCTIONS =====================
// Everything in this section runs IN THE WEB PAGE via executeScript.
// Each function must be self-contained: no outside helpers, no panel variables.

function extractFields() {
  const labelText = lab => {
    const c = lab.cloneNode(true);
    c.querySelectorAll('input, select, textarea').forEach(n => n.remove());
    return c.textContent.trim();
  };
  const fieldLabel = el =>
    (el.labels?.[0] && labelText(el.labels[0])) ||
    el.getAttribute('aria-label') || el.placeholder || el.name || '';
  const optionLabel = el =>
    (el.labels?.[0] && labelText(el.labels[0])) ||
    el.getAttribute('aria-label') || el.value;

  // Wipe tags from any previous scan so ids never go stale
  document.querySelectorAll('[data-ff-id]').forEach(el => delete el.dataset.ffId);

  const sel = 'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select';
  const fields = [];
  const seenGroups = new Set();

  for (const el of document.querySelectorAll(sel)) {
    const id = String(fields.length);

    // Radio group: one field for the whole question
    if (el.type === 'radio' && el.name) {
      if (seenGroups.has(el.name)) continue;            // already added this question
      seenGroups.add(el.name);
      const group = [...document.querySelectorAll(
        `input[type=radio][name="${CSS.escape(el.name)}"]`)];
      group.forEach(r => (r.dataset.ffId = id));        // all buttons share one id
      const legend = el.closest('fieldset')?.querySelector('legend')?.textContent.trim();
      fields.push({ id, tag: 'input', type: 'radio-group', name: el.name,
                    label: legend || el.name, options: group.map(optionLabel) });
      continue;
    }

    el.dataset.ffId = id;
    fields.push({
      id,
      tag: el.tagName.toLowerCase(),
      type: el.type,
      name: el.name,
      label: fieldLabel(el),
      options: el.tagName === 'SELECT' ? [...el.options].map(o => o.text.trim()) : undefined,
    });
  }
  return fields;
}

function fillFields(values) {
  const fire = (el, ...types) =>
    types.forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
  const setNative = (el, val) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    fire(el, 'input', 'change');
  };

  const results = {};
  for (const [id, val] of Object.entries(values)) {
    const els = [...document.querySelectorAll(`[data-ff-id="${id}"]`)];
    const el = els[0];
    if (!el) { results[id] = 'not found'; continue; }

    // {choice: n} = pick option n (the panel already decided which one)
    const isChoice = val !== null && typeof val === 'object' && 'choice' in val;

    if (isChoice && el.tagName === 'SELECT') {
      if (!el.options[val.choice]) { results[id] = 'bad choice'; continue; }
      el.selectedIndex = val.choice;
      fire(el, 'input', 'change');
    } else if (isChoice && el.type === 'radio') {
      const r = els[val.choice];
      if (!r) { results[id] = 'bad choice'; continue; }
      if (!r.checked) r.click();
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked !== Boolean(val)) el.click();
    } else if (el.tagName === 'SELECT') {
      const i = [...el.options].findIndex(o => o.text.trim() === String(val).trim());
      if (i === -1) { results[id] = 'no matching option'; continue; }
      el.selectedIndex = i;
      fire(el, 'input', 'change');
    } else {
      setNative(el, String(val));
    }
    results[id] = 'ok';
  }
  return results;
}

function readValue(id) {
  const els = [...document.querySelectorAll(`[data-ff-id="${id}"]`)];
  const el = els[0];
  if (!el) return null;
  if (el.type === 'radio') {
    const c = els.find(r => r.checked);
    return c ? (c.labels?.[0]?.textContent.trim() || c.value) : '';
  }
  if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.text.trim() ?? '';
  if (el.type === 'checkbox') return el.checked ? 'true' : '';
  return el.value;
}

function highlight(id) {
  document.querySelectorAll('[data-ff-hl]').forEach(e => {
    e.style.outline = '';
    delete e.dataset.ffHl;
  });
  const els = [...document.querySelectorAll(`[data-ff-id="${id}"]`)];
  if (!els.length) return 'not found';
  for (const el of els) {
    const target = (el.type === 'radio' && el.labels?.[0]) || el; // radios are tiny: outline the label
    target.style.outline = '3px solid #c9a227';
    target.dataset.ffHl = '1';
  }
  els[0].scrollIntoView({ block: 'center' });
  return 'ok';
}

function clearHighlight() {
  document.querySelectorAll('[data-ff-hl]').forEach(e => {
    e.style.outline = '';
    delete e.dataset.ffHl;
  });
}

function listMedia() {
  return [...document.querySelectorAll('audio, video')].map((el, i) => {
    el.dataset.ffMedia = String(i);
    return { id: String(i), tag: el.tagName.toLowerCase() };
  });
}

async function playMedia(id) {
  const el = document.querySelector(`[data-ff-media="${id}"]`);
  if (!el) return 'not found';
  try { await el.play(); return 'playing'; }
  catch (e) { return e.name; } // NotAllowedError = click the page once, then retry
}

function mediaState(id) {
  const el = document.querySelector(`[data-ff-media="${id}"]`);
  return el ? { paused: el.paused, ended: el.ended } : null;
}

// ===================== PANEL CODE =====================
// Everything below runs in the side panel.

async function runInPage(func, args = []) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return res.result;
}

let fields = [], cur = 0, listening = false, profile = {}, mediaWatch = null;
const $ = id => document.getElementById(id);
const log = msg => ($('log').textContent = msg + '\n' + $('log').textContent);

// Safe DOM builder: never puts untrusted text into innerHTML
function h(tag, text = '', ...children) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  e.append(...children);
  return e;
}

const clean = s => String(s).toLowerCase().replace(/[^\w\s]/g, '').trim();

// ---------- text normalization ----------
const NATO = {
  alpha:'a', bravo:'b', charlie:'c', delta:'d', echo:'e', foxtrot:'f', golf:'g',
  hotel:'h', india:'i', juliet:'j', kilo:'k', lima:'l', mike:'m', november:'n',
  oscar:'o', papa:'p', quebec:'q', romeo:'r', sierra:'s', tango:'t', uniform:'u',
  victor:'v', whiskey:'w', xray:'x', yankee:'y', zulu:'z',
};

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
  if (field.tag === 'textarea') return text;
  return collapseSpelled(text);
}

// ---------- choice matching (dropdowns + radio groups) ----------
const SOUNDS = { ay: 'a', eh: 'a', hey: 'a', bee: 'b', be: 'b', see: 'c', sea: 'c',
                 dee: 'd', ee: 'e', eff: 'f' };
const NUMS = { one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4,
               five: 5, six: 6, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

const isChoice = f => f.type === 'radio-group' || f.tag === 'select';

// Returns the option index the spoken text means, or -1
function resolveChoice(field, spoken) {
  let t = clean(spoken).replace(/^(option|letter|answer|choice|number)\s+/, '');
  t = SOUNDS[t] ?? t;
  const opts = field.options.map(clean);

  let i = opts.indexOf(t);                         // exact: "b", "junior"
  if (i !== -1) return i;

  const n = /^\d+$/.test(t) ? Number(t) : NUMS[t]; // by number: "two", "2"
  if (n && n <= opts.length) return n - 1;

  if (t.length >= 3) return opts.findIndex(o => o.startsWith(t)); // partial: "soph"
  return -1;
}

// ---------- filling ----------
async function sendFill(value, advance = true) {
  const id = fields[cur].id;
  const result = await runInPage(fillFields, [{ [id]: value }]);
  log(`[${id}] ${result[id]}`);
  if (advance && result[id] === 'ok') await move(1);
}

async function fillCurrent(raw, fromSpeech = false) {
  if (!fields.length) return log('scan first');
  const f = fields[cur];

  if (isChoice(f)) {
    const i = resolveChoice(f, raw);
    if (i === -1) return log(`no match for "${raw}". options: ${f.options.join(', ')}`);
    return sendFill({ choice: i });
  }
  if (f.type === 'checkbox') {
    return sendFill(!['no', 'uncheck', 'off', 'false', ''].includes(clean(raw)));
  }
  return sendFill(fromSpeech ? normalizeFor(f, raw) : raw);
}

// ---------- random ----------
const WORDS = ['banana', 'nebula', 'quokka', 'velvet', 'thunder', 'pickle',
               'galaxy', 'marmalade', 'zeppelin', 'cactus', 'waffle', 'comet'];
const randInt = n => Math.floor(Math.random() * n);

function randomValue(f) {
  if (isChoice(f)) return { choice: randInt(f.options.length) };
  if (f.type === 'checkbox') return Math.random() < 0.5;
  return WORDS[randInt(WORDS.length)];
}

// ---------- saved info (profile) ----------
async function loadProfile() {
  const { profile: saved = {} } = await chrome.storage.local.get('profile');
  profile = saved;
  renderProfile();
}

async function saveKey(key, value) {
  key = clean(key);
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
    if (f.type === 'checkbox') continue;
    const k = matchKey(f);
    if (!k) continue;
    if (isChoice(f)) {
      const i = resolveChoice(f, profile[k]);
      if (i !== -1) values[f.id] = { choice: i };
    } else {
      values[f.id] = profile[k];
    }
  }
  const n = Object.keys(values).length;
  if (!n) return log('no saved info matched any field');
  const result = await runInPage(fillFields, [values]);
  log(`autofilled ${n}: ${JSON.stringify(result)}`);
}

// ---------- field list ----------
function render() {
  $('fields').replaceChildren(...fields.map((f, i) => {
    const name = f.label || f.name || f.type;
    const text = f.type === 'radio-group' ? `${name} (${f.options.join(' / ')})` : name;
    const d = h('div', `${i === cur ? '▶ ' : ''}[${f.id}] ${text}`);
    if (i === cur) {
      d.className = 'current';
      if (f.options) {
        const opts = h('div', f.options.map((o, j) => `${j + 1}. ${o}`).join('    '));
        opts.className = 'opts';
        d.append(opts);
      }
    }
    return d;
  }));
}

async function move(delta) {
  if (!fields.length) return;
  cur = Math.max(0, Math.min(fields.length - 1, cur + delta));
  await runInPage(highlight, [fields[cur].id]);
  render();
}

// ---------- media ----------
async function refreshMedia() {
  const media = await runInPage(listMedia);
  if (!media.length) {
    $('mediaList').replaceChildren(h('i', 'no audio/video found (could be inside an iframe)'));
    return media;
  }
  $('mediaList').replaceChildren(...media.map((m, i) => {
    const b = h('button', `▶ ${m.tag} ${i + 1}`);
    b.onclick = () => playByIndex(i).catch(e => log('media error: ' + e.message));
    return b;
  }));
  return media;
}

async function playByIndex(i) {
  const media = await refreshMedia();
  if (!media.length) return log('no audio/video found');
  if (!media[i]) return log(`only ${media.length} clip(s) on this page`);

  const wasListening = listening;
  setMic(false); // so the mic doesn't transcribe the clip
  const r = await runInPage(playMedia, [media[i].id]);
  log(`play ${media[i].tag} ${i + 1}: ${r}`);

  if (r !== 'playing') { if (wasListening) setMic(true); return; }
  if (wasListening) watchMedia(media[i].id);
}

// Turn the mic back on when the clip ends or is paused
function watchMedia(id) {
  clearInterval(mediaWatch);
  mediaWatch = setInterval(async () => {
    try {
      const s = await runInPage(mediaState, [id]);
      if (!s || s.paused || s.ended) {
        clearInterval(mediaWatch);
        setMic(true);
        log('clip finished, mic back on');
      }
    } catch {
      clearInterval(mediaWatch);
    }
  }, 1000);
}

// ---------- kill ----------
async function kill() {
  setMic(false);
  clearInterval(mediaWatch);
  try { await runInPage(clearHighlight); } catch {}
  window.close();
}

// ---------- voice commands ----------
async function handleCommand(c) {
  const f = fields[cur];

  if (c === 'next') return move(1);
  if (c === 'back') return move(-1);
  if (c === 'kill') return kill();
  if (c === 'autofill') return autofill();
  if (c === 'list') return log('saved: ' + (Object.keys(profile).join(', ') || 'nothing'));

  if (c === 'options') {
    if (!f?.options) return log('current field has no options');
    return log(f.options.map((o, i) => `${i + 1}. ${o}`).join('   '));
  }

  if (c === 'clear') {
    if (!f) return log('scan first');
    if (isChoice(f)) return log("can't clear a choice; just pick another one");
    return sendFill('', false);
  }

  if (c === 'random') {
    if (!f) return log('scan first');
    return sendFill(randomValue(f));
  }

  if (c === 'play' || c.startsWith('play ')) {     // "command play", "command play two"
    const n = c.slice(4).trim();
    const num = n ? (Number(n) || NUMS[n]) : 1;
    if (!num) return log(`don't know which clip "${n}" is`);
    return playByIndex(num - 1);
  }

  if (c === 'save this') {                          // save under the field's own label
    if (!f) return log('scan first');
    const value = await runInPage(readValue, [f.id]);
    if (!value) return log('current field is empty, nothing to save');
    return saveKey(f.label || f.name, value);
  }

  if (c.startsWith('save ')) {                      // "command save email"
    if (!f) return log('scan first');
    const value = await runInPage(readValue, [f.id]);
    if (!value) return log('current field is empty, nothing to save');
    return saveKey(c.slice(5), value);
  }

  if (c.startsWith('fill ') || c.startsWith('input ')) {  // "command input email"
    const key = c.replace(/^(fill|input)\s+/, '');
    if (!(key in profile)) return log(`nothing saved for "${key}"`);
    return fillCurrent(profile[key]);
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
      const cmd = clean(text);
      if (cmd.startsWith('command ')) return await handleCommand(cmd.slice(8).trim());
      await fillCurrent(text, true);
    } catch (err) {
      log('error: ' + err.message);
    }
  };

  // Chrome ends recognition after silence even with continuous = true
  rec.onend = () => { if (listening) { try { rec.start(); } catch {} } };
  rec.onerror = e => log('mic error: ' + e.error); // "not-allowed" = open permission.html
} else {
  log('speech recognition not available here');
}

function setMic(on) {
  if (!rec) return log('no speech recognition');
  listening = on;
  try { on ? rec.start() : rec.stop(); } catch {} // already in that state
  $('mic').textContent = on ? 'Stop mic' : 'Start mic';
}

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').textContent = t === 'dark' ? 'Light' : 'Dark';
}

async function loadTheme() {
  const { theme } = await chrome.storage.local.get('theme');
  applyTheme(theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
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
$('media').onclick = () => refreshMedia().catch(e => log('media error: ' + e.message));
$('close').onclick = () => kill();

$('theme').onclick = async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await chrome.storage.local.set({ theme: next });
};

$('pSave').onclick = async () => {
  await saveKey($('pKey').value, $('pVal').value);
  $('pKey').value = '';
  $('pVal').value = '';
};

loadTheme().catch(() => applyTheme('dark'));
loadProfile().catch(e => log('profile load error: ' + e.message));
log('panel ready');