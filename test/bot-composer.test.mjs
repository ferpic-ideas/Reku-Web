import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

test('intro invites a detailed account and steps remain informational without progress highlighting', async () => {
  const html = await readFile(new URL('../bot/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../bot/app.js', import.meta.url), 'utf8');
  assert.match(html, /con el mayor detalle que puedas\.<br \/>Si preferís mandar un audio, no te preocupes por el orden: hablá como te salga\. Con ayuda de IA, lo pasamos a texto y lo organizamos para tu consulta\./);
  assert.equal((html.match(/class="step" id="step-/g) || []).length, 3);
  assert.doesNotMatch(html, /class="step active"/);
  assert.doesNotMatch(script, /\$\('step-(?:talk|detail|report)'\)/);
});

test('audio button stays light green before recording and when ready to send', async () => {
  const css = await readFile(new URL('../bot/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#record\{[^}]*background:#e0f3e8;[^}]*color:#236747;/);
  assert.match(css, /#record\{[^}]*width:132px;flex-shrink:0/);
  assert.match(css, /#record\.recording\{background:#e0f3e8;color:#236747\}/);
  assert.match(css, /#record:not\(:disabled\):hover\{background:#cdebd9\}/);
});

test('recording cancellation sits beside audio send and the textbox cannot be resized', async () => {
  const html = await readFile(new URL('../bot/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../bot/styles.css', import.meta.url), 'utf8');
  const actions = html.match(/<div class="audio-actions">([\s\S]*?)<\/div>/)[1];
  assert.match(actions, /id="record"[\s\S]*id="cancel-recording"/);
  assert.match(css, /#message\{resize:none\}/);
  assert.match(css, /#cancel-recording\{[^}]*color:var\(--muted\)/);
  assert.match(css, /\.recording-help\{[^}]*color:var\(--muted\)/);
  assert.equal((html.match(/id="cancel-recording"/g) || []).length, 1);
  assert.match(html, /class="recording-timer">Grabando <strong id="timer">0:00<\/strong><\/div>\s*<div class="recording-help">Tocá Enviar/);
});

const setup = async ({ audioLevel = 0.02, search = '', hash = '', sessionOverrides = {}, autoStart = true, resetFails = false, sessionFails = false, transcription = 'Me duele la rodilla derecha', transcriptionFailures = 0, access = { allowed: true }, deferMicrophone = false, deferAudioResume = false, recorderStop = 'normal' } = {}) => {
  let focused;
  const element = tagName => ({
    tagName, children: [],
    value: '', hidden: false, disabled: false, handlers: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); }, removeAttribute() {}, setAttribute() {},
    focus() { focused = this; }, scrollIntoView() {}, click() { this.clicked = true; },
  });
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  let resolveRequest;
  let rejectRequest;
  const requests = [];
  const urls = [];
  const replacedHistory = [];
  const audioRequests = [];
  const diagnostics = [];
  const microphoneRequests = [];
  const recorders = [];
  const audioContexts = [];
  const apiTimeouts = [];
  const windowHandlers = {};
  const beacons = [];
  let reloads = 0;
  const timers = new Map();
  const timeouts = new Map();
  let timerId = 0;
  let now = 0;
  class AudioContext {
    constructor() { this.closed = false; audioContexts.push(this); }
    async resume() { if (deferAudioResume) await new Promise(resolve => { this.finishResume = resolve; }); }
    async close() { this.closed = true; }
    createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData: samples => samples.fill(audioLevel) }; }
    createMediaStreamSource() { return { connect() {} }; }
  }
  class MediaRecorder {
    static isTypeSupported() { return true; }
    constructor(stream) { this.state = 'inactive'; this.mimeType = 'audio/webm'; this.stream = stream; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob(['fake-audio']) });
      if (recorderStop === 'throws') throw new Error('Recorder stop failed');
      if (recorderStop === 'missing-event') return;
      queueMicrotask(() => this.onstop());
    }
  }
  const session = { status: 'collecting', version: 0, instanceId: 'test-instance', messages: [], brand: { slug: '' }, ...sessionOverrides };
  const response = (data, ok = true) => ({ ok, json: async () => data });
  vm.runInNewContext(await readFile(new URL('../bot/app.js', import.meta.url), 'utf8'), {
    document: { getElementById: get, createElement: element, createTextNode: text => text, body: element() },
    location: { search, hash, pathname: '/bot', reload: () => reloads++ }, history: { replaceState: (_state, _title, url) => replacedHistory.push(url) }, window: { addEventListener: (event, fn) => { windowHandlers[event] = fn; }, AudioContext, MediaRecorder },
    navigator: { sendBeacon: (url, body) => { beacons.push({ url, body }); return true; }, mediaDevices: { getUserMedia: () => {
      const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
      const stream = { getTracks: () => tracks };
      return new Promise((resolve, reject) => {
        microphoneRequests.push({ tracks, stream, resolve: () => resolve(stream), reject });
        if (!deferMicrophone) resolve(stream);
      });
    } } },
    MediaRecorder, File, Blob, Date: { now: () => now },
    console: { info: (...args) => diagnostics.push(args) },
    setInterval: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; },
    clearInterval: id => timers.delete(id),
    setTimeout: (callback, ms) => { timeouts.set(++timerId, { callback, at: now + ms }); return timerId; },
    clearTimeout: id => timeouts.delete(id),
    URLSearchParams, URL, FormData, AbortSignal: { timeout: ms => { apiTimeouts.push(ms); return AbortSignal.timeout(ms); } }, crypto: { randomUUID },
    fetch: async (url, options) => {
      urls.push(url);
      if (url.endsWith('/access')) { assert.equal(replacedHistory.length, 1); assert.equal(JSON.parse(options.body).token, 'private-test-token'); return response({ ok: true }); }
      if (url.endsWith('/reset')) { assert.equal(options.method, 'POST'); return response(resetFails ? { error: 'Reset failed' } : { session: null }, !resetFails); }
      if (url.endsWith('/context')) return response({ available: true, brand: session.brand, access });
      if (url.endsWith('/session')) { assert.equal(options.method, 'POST', 'Never restore a previous session'); return response(sessionFails ? { error: 'No pudimos comenzar' } : { session }, !sessionFails); }
      if (url.endsWith('/transcribe')) {
        audioRequests.push(options.body);
        if (transcriptionFailures-- > 0) return response({ error: 'Error temporal' }, false);
        return response({ text: transcription });
      }
      if (url.endsWith('/report')) return { ok: true, blob: async () => new Blob(['test-report']) };
      requests.push(JSON.parse(options.body));
      return new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  if (autoStart && !resetFails && access.allowed) { get('consent').checked = true; await get('start').handlers.click(); }
  const submit = () => get('composer').handlers.submit({ preventDefault() {} });
  get('composer').requestSubmit = submit;
  return {
    get, submit, requests, urls, replacedHistory, audioRequests, diagnostics, windowHandlers, beacons, microphoneRequests, recorders, audioContexts, apiTimeouts, reloads: () => reloads, focused: () => focused,
    sampleAudio: () => { for (const timer of timers.values()) if (timer.ms === 50) for (let i = 0; i < 6; i++) timer.callback(); },
    tickRecording: ms => { now += ms; for (const timer of timers.values()) if (timer.ms === 500) timer.callback(); },
    tickWelcome: ms => { now += ms; for (const [id, timer] of timeouts) if (timer.at <= now) { timeouts.delete(id); timer.callback(); } },
    finish: (ok = true, overrides = {}) => resolveRequest(response(ok ? { session: { ...session, version: 1, ...overrides } } : { error: 'Error de prueba' }, ok)),
    loseResponse: () => rejectRequest(new TypeError('Network connection interrupted')),
  };
};

test('consent and Comenzar live below the steps, outside the initially hidden chat', async () => {
  const html = await readFile(new URL('../bot/index.html', import.meta.url), 'utf8');
  const intro = html.match(/<aside class="intro" id="intro">([\s\S]*?)<\/aside>/)[1];
  assert.match(intro, /id="step-report"[\s\S]*id="start-panel"[\s\S]*id="consent"[\s\S]*id="start"[^>]*>Comenzar/);
  assert.match(html, /id="chat-card"[^>]* hidden>/);
  assert.match(intro, /Este asistente usa OpenAI para procesar tu texto y transcribir tus audios\. Solo organiza tu relato; no realiza diagnósticos ni indica tratamientos\./);
  assert.doesNotMatch(html, /La conversación queda disponible/);
  const css = await readFile(new URL('../bot/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.layout:not\(\.awaiting-start\)\{display:block;max-width:820px;margin:0 auto\}/);
});

test('chat opens only after consent and its second greeting arrives exactly two seconds later', async () => {
  const messages = [{ role: 'assistant', text: 'Hola, bienvenido' }, { role: 'assistant', text: 'Podés mandar un audio' }];
  const app = await setup({ autoStart: false, sessionOverrides: { messages } });
  assert.equal(app.get('chat-card').hidden, true);
  assert.equal(app.get('intro').hidden, false);
  await app.get('start').handlers.click();
  assert.equal(app.urls.includes('/api/bot/session'), false);
  app.get('consent').checked = true;
  app.get('consent').handlers.change();
  assert.equal(app.get('start').disabled, false);
  await app.get('start').handlers.click();
  assert.equal(app.get('chat-card').hidden, false);
  assert.equal(app.get('intro').hidden, true);
  assert.equal(app.get('start-panel').hidden, true);
  assert.equal(app.get('messages').children.length, 1);
  assert.equal(app.get('record').disabled, true);
  app.get('message').value = 'Mensaje anticipado';
  await app.submit();
  assert.equal(app.requests.length, 0);
  app.tickWelcome(1999);
  assert.equal(app.get('messages').children.length, 1);
  app.tickWelcome(1);
  assert.equal(app.get('messages').children.length, 2);
  assert.equal(app.get('message').disabled, false);
  assert.equal(app.get('record').disabled, false);
  assert.equal(app.focused(), app.get('message'));
  await app.get('start').handlers.click();
  assert.equal(app.urls.filter(url => url.endsWith('/session')).length, 1);
});

test('leaving during the greeting cancels its delayed message and keeps the chat closed', async () => {
  const app = await setup({ sessionOverrides: { messages: [{ role: 'assistant', text: 'Hola' }, { role: 'assistant', text: 'Audio' }] } });
  app.windowHandlers.pagehide();
  app.tickWelcome(2000);
  assert.equal(app.get('chat-card').hidden, true);
  assert.equal(app.get('messages').children.length, 0);
});

test('failed start keeps consent visible and chat hidden with a retryable error', async () => {
  const app = await setup({ sessionFails: true });
  assert.equal(app.get('chat-card').hidden, true);
  assert.equal(app.get('start-panel').hidden, false);
  assert.equal(app.get('start').disabled, false);
  assert.equal(app.get('error').hidden, false);
  assert.equal(app.get('error').textContent, 'No pudimos comenzar');
});

for (const status of ['complete', 'partial', 'urgent']) test('finished ' + status + ' result shows only readiness and download, without clinical summary', async () => {
  const data = { complaints: [{ reason: 'dolor', location: 'tobillo derecho', pain: 5 }], followups: [{ question: '¿Cambió tu rutina?', answer: 'Me cuesta caminar' }] };
  const app = await setup({ sessionOverrides: { status, data, messages: [{ role: 'assistant', text: 'Mensaje de cierre u orientación' }] } });
  assert.equal(app.get('result').hidden, false);
  assert.equal(app.get('intro').hidden, true);
  assert.equal(app.get('composer').hidden, true);
  assert.equal(app.get('result-title').textContent, status === 'partial' ? 'Tu informe parcial está listo' : 'Tu informe está listo');
  assert.equal(typeof app.get('download').handlers.click, 'function');
  assert.equal(app.get('summary').children.length, 0);
  assert.equal(app.get('messages').children.length, 1);
  assert.equal(data.followups[0].answer, 'Me cuesta caminar');
});
test('private appointment token is removed from navigation before its POST exchange', async () => {
  const app = await setup({ hash: '#appointment=private-test-token', autoStart: false });
  assert.deepEqual(app.replacedHistory, ['/bot']);
  assert.deepEqual(app.urls, ['/api/bot/access', '/api/bot/reset', '/api/bot/context']);
});
test('access denial hides the interview and consent and displays the friendly message', async () => {
  for (const message of ['Ingresá desde el enlace de tu turno.', 'Ya completaste la entrevista para este turno.']) {
    const app = await setup({ access: { allowed: false, message } });
    assert.equal(app.get('access-notice').textContent, message);
    assert.equal(app.get('access-notice').hidden, false);
    assert.equal(app.get('messages').hidden, true);
    assert.equal(app.get('start-panel').hidden, true);
    assert.equal(app.get('start').disabled, true);
    assert.equal(app.urls.includes('/api/bot/session'), false);
  }
});
test('completed appointment can download its saved report without opening a new conversation', async () => {
  const message = 'Ya completaste la entrevista para este turno.';
  const app = await setup({ access: { allowed: false, completed: true, reportAvailable: true, message } });
  assert.equal(app.get('completed-report').hidden, false);
  assert.equal(app.get('completed-report-message').textContent, message);
  assert.equal(app.get('intro').hidden, true);
  assert.equal(app.get('chat-card').hidden, true);
  assert.equal(app.get('start-panel').hidden, true);
  assert.equal(app.urls.includes('/api/bot/session'), false);
  await app.get('download-completed').handlers.click();
  assert.ok(app.urls.includes('/api/bot/report'));
  assert.equal(app.get('download-completed').disabled, false);
  app.windowHandlers.pagehide();
  assert.equal(app.get('completed-report').hidden, true);
});
test('completed appointment without a persisted report does not show a broken download', async () => {
  const app = await setup({ access: { allowed: false, completed: true, reportAvailable: false, message: 'Ya completaste la entrevista.' } });
  assert.equal(app.get('completed-report').hidden, true);
  assert.equal(app.get('access-notice').hidden, false);
  assert.equal(app.get('chat-card').hidden, true);
});
test('each visit resets before starting and never restores a finished conversation', async () => {
  const app = await setup({ autoStart: false, sessionOverrides: { status: 'complete', messages: [{ role: 'user', text: 'Conversación anterior' }] } });
  assert.deepEqual(app.urls, ['/api/bot/reset', '/api/bot/context']);
  assert.equal(app.get('start-panel').hidden, false);
  assert.equal(app.get('result').hidden, true);
  assert.equal(app.get('composer').hidden, true);
  assert.equal(app.get('message').value, '');
  assert.equal(app.get('consent').checked, false);
  assert.equal(app.get('messages').children.length, 0);
  assert.ok(!JSON.stringify(app.get('messages').children).includes('Conversación anterior'));
});
test('a failed reset cannot expose or start an old conversation', async () => {
  const app = await setup({ autoStart: false, resetFails: true });
  assert.deepEqual(app.urls, ['/api/bot/reset']);
  assert.equal(app.get('start').disabled, true);
  assert.equal(app.get('error').textContent, 'Reset failed');
});
test('leaving clears the visible draft and closes only that conversation; back cache reloads', async () => {
  const app = await setup();
  app.get('message').value = 'Borrador privado';
  app.windowHandlers.pagehide();
  assert.equal(app.get('message').value, '');
  assert.equal(app.get('result').hidden, true);
  assert.equal(app.beacons.length, 1);
  assert.equal(app.beacons[0].url, '/api/bot/close');
  assert.deepEqual(JSON.parse(await app.beacons[0].body.text()), { instanceId: 'test-instance' });
  app.windowHandlers.pageshow({ persisted: false });
  assert.equal(app.reloads(), 0);
  app.windowHandlers.pageshow({ persisted: true });
  assert.equal(app.reloads(), 1);
});
test('a pending message cannot bring back private content after leaving', async () => {
  const app = await setup();
  app.get('message').value = 'Relato privado';
  const pending = app.submit();
  app.windowHandlers.pagehide();
  app.finish(true, { messages: [{ role: 'user', text: 'Relato privado' }] });
  await pending;
  assert.equal(app.get('message').value, '');
  assert.equal(app.get('composer').hidden, true);
  assert.ok(!JSON.stringify(app.get('messages').children).includes('Relato privado'));
});
test('result markup contains only the title and download button', async () => {
  const html = await readFile(new URL('../bot/index.html', import.meta.url), 'utf8');
  const result = html.match(/<div id="result"[\s\S]*?<\/div>/)?.[0];
  assert.ok(result);
  assert.deepEqual([...result.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]), ['result', 'result-title', 'download']);
  const script = await readFile(new URL('../bot/app.js', import.meta.url), 'utf8');
  assert.ok(!script.includes("$('summary')"));
  assert.ok(!script.includes("$('restart')"));
});

test('bot API requests stay on the current subdomain without forwarding form parameters', async () => {
  const app = await setup({ search: '?form=other-agreement' });
  assert.ok(app.urls.includes('/api/bot/context'));
  assert.ok(app.urls.includes('/api/bot/session'));
  app.get('message').value = 'Mensaje';
  const pending = app.submit();
  assert.ok(app.urls.includes('/api/bot/message'));
  assert.ok(app.urls.every(url => url.startsWith('/api/bot/') && !url.includes('?')));
  app.finish();
  await pending;
});

test('browser diagnostics contain only this turn decision and its non-authenticating reference', async () => {
  const app = await setup();
  app.get('message').value = 'Relato privado del paciente';
  const pending = app.submit();
  app.finish(true, { diagnosticId: 'qa-reference', followupDiagnostics: [
    { turn: 0, stage: 'review', reason: 'accepted' },
    { turn: 1, stage: 'review', reason: 'review_rejected', failedChecks: ['clear'] },
  ] });
  await pending;
  assert.equal(app.diagnostics.length, 1);
  const diagnostic = JSON.parse(JSON.stringify(app.diagnostics[0][1]));
  assert.equal(diagnostic.diagnosticId, 'qa-reference');
  assert.equal(diagnostic.decisions.length, 1);
  assert.equal(diagnostic.decisions[0].turn, 1);
  assert.ok(!JSON.stringify(app.diagnostics).includes('Relato privado'));
  assert.ok(!JSON.stringify(app.diagnostics).includes('test-instance'));
});

test('sending clears and focuses the composer immediately while preserving the next draft', async () => {
  const app = await setup();
  const input = app.get('message');
  input.value = 'Primer mensaje';
  const pending = app.submit();
  assert.equal(input.value, '');
  assert.equal(input.disabled, false);
  assert.equal(app.focused(), input);
  assert.equal(app.get('send').disabled, true);
  input.value = 'Siguiente mensaje';
  input.handlers.input();
  input.handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(app.requests.length, 1);
  app.finish();
  await pending;
  assert.equal(input.value, 'Siguiente mensaje');
  assert.equal(app.get('send').disabled, false);
  assert.equal(app.requests[0].text, 'Primer mensaje');
});

test('recording sends its transcription directly without changing the typed draft', async () => {
  const app = await setup();
  const input = app.get('message');
  input.value = 'Borrador que todavía no envié';
  assert.equal(app.get('cancel-recording').hidden, true);
  assert.equal(app.get('send').hidden, false);
  await app.get('record').handlers.click();
  assert.equal(app.get('record-label').textContent, 'Enviar');
  assert.equal(app.get('cancel-recording').hidden, false);
  assert.equal(app.get('send').hidden, true);
  app.sampleAudio();
  await app.get('record').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('cancel-recording').hidden, true);
  assert.equal(app.get('send').hidden, false);
  assert.equal(app.audioRequests.length, 1);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].text, 'Me duele la rodilla derecha');
  assert.equal(input.value, 'Borrador que todavía no envié');
  app.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('audio-retry').hidden, true);
  assert.equal(input.value, 'Borrador que todavía no envié');
});

test('four-minute limit sends the captured audio and its full long transcription exactly once', async () => {
  const transcription = 'Relato de prueba. '.repeat(300);
  const app = await setup({ transcription });
  await app.get('record').handlers.click();
  app.sampleAudio();
  app.tickRecording(239000);
  assert.equal(app.get('timer').textContent, '3:59');
  assert.equal(app.get('send').hidden, true);
  assert.equal(app.audioRequests.length, 0);
  app.tickRecording(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.audioRequests.length, 1);
  assert.equal(await app.audioRequests[0].get('audio').text(), 'fake-audio');
  assert.equal(app.get('send').hidden, false);
  assert.equal(app.requests[0].text, transcription.trim());
  assert.equal(app.get('message').value, '');
  app.tickRecording(10000);
  assert.equal(app.audioRequests.length, 1);
  app.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('audio-retry').hidden, true);
});

test('automatic cutoff preserves audio for retry if transcription fails', async () => {
  const app = await setup({ transcriptionFailures: 1 });
  await app.get('record').handlers.click();
  app.sampleAudio();
  app.tickRecording(240000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('audio-retry').hidden, false);
  assert.equal(app.requests.length, 0);
  const retry = app.get('retry-audio').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await app.audioRequests[1].get('audio').arrayBuffer(), await app.audioRequests[0].get('audio').arrayBuffer());
  assert.equal(app.requests.length, 1);
  app.finish();
  await retry;
  assert.equal(app.get('audio-retry').hidden, true);
});

test('silent recordings do not call transcription or send a message', async () => {
  const app = await setup({ audioLevel: 0 });
  await app.get('record').handlers.click();
  app.sampleAudio();
  await app.get('record').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.audioRequests.length, 0);
  assert.equal(app.requests.length, 0);
  assert.match(app.get('error').textContent, /No detectamos voz/);
  assert.equal(app.get('record').disabled, false);
});

test('cancelled recordings never transcribe or send', async () => {
  const app = await setup();
  await app.get('record').handlers.click();
  app.sampleAudio();
  app.get('cancel-recording').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('send').hidden, false);
  assert.equal(app.audioRequests.length, 0);
  assert.equal(app.requests.length, 0);
});

test('failed audio sends retry with the same request id without entering the input', async () => {
  const app = await setup();
  await app.get('record').handlers.click();
  app.sampleAudio();
  await app.get('record').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  app.finish(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('message').value, '');
  assert.equal(app.get('audio-retry').hidden, false);
  const retry = app.get('retry-audio').handlers.click();
  assert.equal(app.audioRequests.length, 1);
  assert.equal(app.requests[0].requestId, app.requests[1].requestId);
  app.finish();
  await retry;
  assert.equal(app.get('audio-retry').hidden, true);
});

test('a failed send preserves its immutable request separately from the next draft', async () => {
  const app = await setup();
  app.get('message').value = 'Primer mensaje';
  const pending = app.submit();
  app.get('message').value = 'Borrador siguiente';
  app.finish(false);
  await pending;
  assert.equal(app.get('message').value, 'Borrador siguiente');
  assert.equal(app.get('message').disabled, false);
  assert.equal(app.get('error').textContent, 'Error de prueba');
  assert.equal(app.get('send').disabled, true);
  assert.equal(app.get('record').disabled, true);
  assert.equal(app.get('message-retry').hidden, false);
  assert.equal(app.focused(), app.get('message'));
  await app.submit();
  assert.equal(app.requests.length, 1, 'A new draft cannot replace the uncertain request');
  const retry = app.get('retry-message').handlers.click();
  assert.deepEqual(app.requests[1], app.requests[0]);
  assert.equal(app.get('message').value, 'Borrador siguiente');
  app.finish(true, { messages: [{ role: 'user', text: 'Primer mensaje' }, { role: 'assistant', text: 'Respuesta' }] });
  await retry;
  assert.equal(app.get('message-retry').hidden, true);
  assert.equal(app.get('send').disabled, false);
  assert.equal(app.get('message').value, 'Borrador siguiente');
  const next = app.submit();
  assert.equal(app.requests[2].text, 'Borrador siguiente');
  assert.equal(app.requests[2].version, 1);
  assert.notEqual(app.requests[2].requestId, app.requests[0].requestId);
  app.finish(true, { version: 2 });
  await next;
});

test('lost HTTP response retries exactly the same message and version before sending the next draft', async () => {
  const app = await setup();
  app.get('message').value = 'Mensaje recibido por el servidor';
  const first = app.submit();
  app.get('message').value = 'Otro detalle';
  app.loseResponse();
  await first;
  const retry = app.get('retry-message').handlers.click();
  assert.deepEqual(app.requests[1], app.requests[0]);
  assert.equal(app.requests[1].version, 0);
  app.finish(true, { version: 1, messages: [{ role: 'user', text: 'Mensaje recibido por el servidor' }, { role: 'assistant', text: 'Respuesta recuperada' }] });
  await retry;
  assert.equal(app.get('message').value, 'Otro detalle');
  assert.equal(app.get('messages').children.length, 2);
});

test('uncertain audio delivery cannot be discarded or replaced and retries without retranscription', async () => {
  const app = await setup();
  await app.get('record').handlers.click();
  app.sampleAudio();
  await app.get('record').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  app.get('message').value = 'Siguiente borrador';
  app.loseResponse();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('discard-audio').disabled, true);
  app.get('discard-audio').handlers.click();
  await app.get('record').handlers.click();
  await app.submit();
  assert.equal(app.recorders.length, 1);
  assert.equal(app.requests.length, 1);
  const retry = app.get('retry-audio').handlers.click();
  assert.deepEqual(app.requests[1], app.requests[0]);
  assert.equal(app.audioRequests.length, 1);
  app.finish();
  await retry;
  assert.equal(app.get('message').value, 'Siguiente borrador');
  assert.equal(app.get('audio-retry').hidden, true);
});

test('pending microphone permission cannot be reenabled by typing or start a second capture', async () => {
  const app = await setup({ deferMicrophone: true });
  const first = app.get('record').handlers.click();
  assert.equal(app.get('record').disabled, true);
  assert.equal(app.get('cancel-recording').hidden, false);
  app.get('message').value = 'Un detalle';
  app.get('message').handlers.input();
  assert.equal(app.get('record').disabled, true);
  assert.equal(app.get('message').disabled, true);
  await app.get('record').handlers.click();
  assert.equal(app.microphoneRequests.length, 1);
  app.microphoneRequests[0].resolve();
  await first;
  assert.equal(app.recorders.length, 1);
  assert.equal(app.recorders[0].state, 'recording');
  app.get('cancel-recording').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.recorders[0].state, 'inactive');
  assert.equal(app.microphoneRequests[0].tracks[0].stopped, true);
  assert.equal(app.audioRequests.length, 0);
});

test('leaving while microphone permission is pending stops late tracks without creating a recorder', async () => {
  const app = await setup({ deferMicrophone: true });
  const pending = app.get('record').handlers.click();
  app.windowHandlers.pagehide();
  app.microphoneRequests[0].resolve();
  await pending;
  assert.equal(app.microphoneRequests[0].tracks[0].stopped, true);
  assert.equal(app.recorders.length, 0);
  assert.equal(app.audioRequests.length, 0);
  assert.equal(app.get('chat-card').hidden, true);
});

test('cancelling pending permission cannot let stale tracks affect a newer recording', async () => {
  const app = await setup({ deferMicrophone: true });
  const stale = app.get('record').handlers.click();
  app.get('cancel-recording').handlers.click();
  assert.equal(app.get('record').disabled, false);
  const current = app.get('record').handlers.click();
  app.microphoneRequests[1].resolve();
  await current;
  app.microphoneRequests[0].resolve();
  await stale;
  assert.equal(app.recorders.length, 1);
  assert.equal(app.microphoneRequests[0].tracks[0].stopped, true);
  assert.equal(app.microphoneRequests[1].tracks[0].stopped, false);
  assert.equal(app.recorders[0].state, 'recording');
  app.get('cancel-recording').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.microphoneRequests[1].tracks[0].stopped, true);
});

test('leaving while the audio context resumes closes it and never starts recording', async () => {
  const app = await setup({ deferAudioResume: true });
  const pending = app.get('record').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.audioContexts.length, 1);
  app.windowHandlers.pagehide();
  assert.equal(app.audioContexts[0].closed, true);
  app.audioContexts[0].finishResume();
  await pending;
  assert.equal(app.recorders.length, 0);
  assert.equal(app.microphoneRequests[0].tracks[0].stopped, true);
});

for (const recorderStop of ['missing-event', 'throws']) test(`recorder ${recorderStop} recovers captured voice and a late stop cannot send it twice`, async () => {
  const app = await setup({ recorderStop });
  await app.get('record').handlers.click();
  app.sampleAudio();
  const recorder = app.recorders[0];
  await app.get('record').handlers.click();
  assert.equal(app.get('record').disabled, true);
  assert.equal(app.microphoneRequests[0].tracks[0].stopped, true);
  app.tickWelcome(1999);
  assert.equal(app.audioRequests.length, 0);
  app.tickWelcome(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.audioRequests.length, 1);
  assert.equal(await app.audioRequests[0].get('audio').text(), 'fake-audio');
  assert.equal(app.get('cancel-recording').hidden, true);
  app.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('record').disabled, false);
  await recorder.onstop();
  app.tickWelcome(10000);
  assert.equal(app.audioRequests.length, 1);
  assert.equal(app.requests.length, 1);
});

test('cancel still frees the recorder when the browser omits its stop event without sending audio', async () => {
  const app = await setup({ recorderStop: 'missing-event' });
  await app.get('record').handlers.click();
  app.sampleAudio();
  app.get('cancel-recording').handlers.click();
  app.tickWelcome(2000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('record').disabled, false);
  assert.equal(app.get('cancel-recording').hidden, true);
  assert.equal(app.microphoneRequests[0].tracks[0].stopped, true);
  assert.equal(app.audioRequests.length, 0);
  await app.recorders[0].onstop();
  assert.equal(app.audioRequests.length, 0);
});

test('inactive recorder error without a stop event recovers buffered audio and never stays busy', async () => {
  const app = await setup();
  await app.get('record').handlers.click();
  app.sampleAudio();
  const recorder = app.recorders[0];
  recorder.ondataavailable({ data: new Blob(['already-buffered-voice']) });
  recorder.state = 'inactive';
  recorder.onerror();
  app.tickWelcome(2000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await app.audioRequests[0].get('audio').text(), 'already-buffered-voice');
  app.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.get('record').disabled, false);
  assert.equal(app.microphoneRequests[0].tracks[0].stopped, true);
});

test('message timeout has overhead beyond the shared AI deadline while audio allows upload time', async () => {
  const app = await setup();
  app.get('message').value = 'Relato';
  const pending = app.submit();
  assert.equal(app.apiTimeouts.at(-1), 30_000);
  app.finish();
  await pending;
  await app.get('record').handlers.click();
  app.sampleAudio();
  await app.get('record').handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(app.apiTimeouts.includes(100_000));
  assert.equal(app.apiTimeouts.at(-1), 30_000);
  app.finish();
  await new Promise(resolve => setImmediate(resolve));
});
