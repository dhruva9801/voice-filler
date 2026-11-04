// --- extractFields() and fillFields() from v0.1 go here ---

async function runInPage(func, args = []) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return res.result;
}

// Runs IN THE PAGE: outline and focus the current field
function highlight(id) {
  document.querySelectorAll('[data-ff-id]').forEach(el => (el.style.outline = ''));
  const el = document.querySelector(`[data-ff-id="${id}"]`);
  if (!el) return 'not found';
  el.style.outline = '3px solid orange';
  el.scrollIntoView({ block: 'center' });
  return 'ok';
}

// Runs IN THE PAGE
function listMedia() {
  return [...document.querySelectorAll('audio, video')].map((el, i) => {
    el.dataset.ffMedia = String(i);
    return { id: String(i), tag: el.tagName.toLowerCase(), duration: el.duration, paused: el.paused };
  });
}

// Runs IN THE PAGE. executeScript waits for the returned promise.
async function playMedia(id) {
  const el = document.querySelector(`[data-ff-media="${id}"]`);
  if (!el) return 'not found';
  try { await el.play(); return 'playing'; }
  catch (e) { return e.name; } // NotAllowedError = click the page once, then retry
}

// ---------- panel state ----------
let fields = [], cur = 0, listening = false;
const $ = id => document.getElementById(id);
const log = msg => ($('log').textContent = msg + '\n' + $('log').textContent);

function render() {
  $('fields').innerHTML = fields
    .map((f, i) => `<div style="${i === cur ? 'font-weight:bold' : ''}">${i === cur ? '▶ ' : ''}[${f.id}] ${f.label || f.name || f.type}</div>`)
    .join('');
}

async function move(delta) {
  if (!fields.length) return;
  cur = Math.max(0, Math.min(fields.length - 1, cur + delta));
  await runInPage(highlight, [fields[cur].id]);
  render();
}

// ---------- speech ----------
const rec = new webkitSpeechRecognition();
rec.continuous = true;
rec.interimResults = false;
rec.lang = 'en-US';

rec.onresult = async e => {
  const text = e.results[e.results.length - 1][0].transcript.trim();
  const cmd = text.toLowerCase();
  log('heard: ' + text);

  // A prefix, so that answering with the literal word "next" isn't treated as a command
  if (cmd === 'command next') return move(1);
  if (cmd === 'command back') return move(-1);
  if (cmd === 'command clear') return runInPage(fillFields, [{ [fields[cur].id]: '' }]);

  if (!fields.length) return log('scan first');
  const result = await runInPage(fillFields, [{ [fields[cur].id]: text }]);
  log(JSON.stringify(result));
};

// Chrome ends recognition after silence even with continuous = true
rec.onend = () => { if (listening) rec.start(); };
rec.onerror = e => log('mic error: ' + e.error); // "not-allowed" = open permission.html

function setMic(on) {
  listening = on;
  on ? rec.start() : rec.stop();
  $('mic').textContent = on ? 'Stop mic' : 'Start mic';
}

// ---------- buttons ----------
$('scan').onclick = async () => {
  fields = await runInPage(extractFields);
  cur = 0;
  render();
  if (fields.length) await runInPage(highlight, [fields[0].id]);
};

$('mic').onclick = () => setMic(!listening);

$('media').onclick = async () => {
  const media = await runInPage(listMedia);
  $('mediaList').innerHTML = media.length
    ? media.map(m => `<button data-id="${m.id}">▶ ${m.tag} ${m.id}</button>`).join(' ')
    : 'no audio/video found (could be inside an iframe)';
  $('mediaList').querySelectorAll('button').forEach(b => {
    b.onclick = async () => {
      setMic(false); // stops the mic from transcribing the clip
      log('play: ' + (await runInPage(playMedia, [b.dataset.id])));
    };
  });
};