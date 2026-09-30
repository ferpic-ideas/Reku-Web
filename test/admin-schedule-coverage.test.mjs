import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../admin/app.js', import.meta.url), 'utf8');
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
const range = (start_time, end_time, day_of_week = 1) => ({ start_time, end_time, day_of_week });
const agreement = (id, name = `Acuerdo ${id}`) => ({ id, name });
const professional = (id, availability, extra = {}) => ({
  id, name: `Fisio ${id}`, active: true, agreements: [agreement(1)], availability, ...extra,
});
const block = (professional_id, start_time, end_time, block_date = '2026-09-28') => ({ professional_id, start_time, end_time, block_date });

async function openCoverage({
  professionals = [], agreements = [agreement(1)], permissions = ['*'], pages = [[]],
  fail = false, now = '2026-09-30T15:00:00Z',
} = {}) {
  let html = '';
  const handlers = new Map();
  const requests = [];
  const app = {
    set innerHTML(value) { html = value; handlers.clear(); },
    get innerHTML() { return html; },
  };
  const element = (key, dataset = {}) => ({
    dataset,
    addEventListener(event, handler) { handlers.set(`${key}:${event}`, handler); },
  });
  const document = {
    getElementById(id) {
      if (id === 'app') return app;
      return html.includes(`id="${id}"`) ? element(id) : null;
    },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector !== '[data-action]') return [];
      return [...html.matchAll(/data-action="([^"]+)"/g)].map(([, action]) => element(action, { action }));
    },
    addEventListener() {},
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return new Date(now).getTime(); }
  }
  const location = { origin: 'http://localhost', pathname: '/admin/horarios', search: '' };
  let shouldFail = fail;
  const fetch = async (path) => {
    requests.push(path);
    let payload;
    if (path === '/api/admin/auth/me') payload = { user: { email: 'admin@example.test', permissions } };
    else if (path === '/api/admin/professionals') payload = { professionals };
    else if (path === '/api/admin/agreements') payload = { agreements };
    else if (path.startsWith('/api/admin/schedule-blocks?')) {
      if (shouldFail) throw new Error('Error de conexión');
      const page = Number(new URL(path, location.origin).searchParams.get('page'));
      payload = { schedule_blocks: pages[page - 1], pagination: { has_more: page < pages.length } };
    } else throw new Error(`Unexpected request: ${path}`);
    return { ok: true, status: 200, json: async () => payload };
  };
  vm.runInNewContext(source, {
    document, fetch, Date: Clock, Intl, FormData, URL, URLSearchParams, console,
    Element: class {}, HTMLAnchorElement: class {},
    window: { location, history: {}, addEventListener() {} },
  });
  await flush();
  return {
    get html() { return html; },
    requests,
    setFailure(value) { shouldFail = value; },
    async action(action) {
      await handlers.get(`${action}:click`)({ currentTarget: { dataset: { action } } });
      await flush();
    },
    async date(value) {
      handlers.get('coverage-week:change')({ target: { value } });
      await flush();
    },
    async agreement(value) {
      handlers.get('coverage-agreement:change')({ target: { value } });
      await flush();
    },
    hours() {
      return [...html.matchAll(/<tr data-hours-professional="([^"]+)">([\s\S]*?)<\/tr>/g)].map(([, id, row]) => {
        const values = [...row.matchAll(/<td[^>]*>([^<]+)<\/td>/g)].map(([, value]) => value);
        return { id, days: values.slice(0, 7), total: values[7] };
      });
    },
    cell(date, time) {
      const match = html.match(new RegExp(`<td class="coverage-cell (covered|uncovered)" data-date="${date}" data-time="${time}"[^>]*>([^<]+)</td>`));
      assert.ok(match, `Missing cell ${date} ${time}`);
      return { status: match[1], count: match[2] === '–' ? 0 : Number(match[2]) };
    },
  };
}

test('coverage counts active professionals and subtracts dated blocks from every page', async () => {
  const ui = await openCoverage({
    professionals: [
      professional(1, [range('08:00', '10:00')]),
      professional(2, [range('08:15', '09:45')]),
      professional(3, [range('08:00', '20:00')], { active: false }),
      professional(4, [range('08:00', '20:00')], { deleted_at: '2026-09-01' }),
    ],
    pages: [[block(1, '08:30', '09:00')], [block(2, '09:05', '09:10')]],
  });
  assert.deepEqual(ui.cell('2026-09-28', '08:00'), { status: 'covered', count: 1 });
  assert.deepEqual(ui.cell('2026-09-28', '08:30'), { status: 'covered', count: 1 });
  assert.deepEqual(ui.cell('2026-09-28', '09:00'), { status: 'covered', count: 1 });
  assert.deepEqual(ui.cell('2026-09-28', '09:30'), { status: 'covered', count: 1 });
  assert.deepEqual(ui.cell('2026-09-28', '10:00'), { status: 'uncovered', count: 0 });
  assert.deepEqual(ui.cell('2026-09-29', '08:00'), { status: 'uncovered', count: 0 });
  assert.ok(ui.requests.includes('/api/admin/schedule-blocks?page=2&page_size=500'));
  assert.equal(ui.requests.some((path) => path.includes('/appointments')), false);
  await ui.action('coverage-next');
  assert.deepEqual(ui.cell('2026-10-05', '08:30'), { status: 'covered', count: 2 });
  await ui.action('coverage-previous');
  assert.equal(ui.cell('2026-09-28', '08:30').count, 1);
});

test('agreement filtering excludes unassociated professionals and counts multiple associations only once', async () => {
  const ui = await openCoverage({
    agreements: [agreement(1), agreement(2, '<Acuerdo & dos>'), agreement(3)],
    professionals: [
      professional(1, [range('08:00', '10:00')]),
      professional(2, [range('08:00', '10:00')], { agreements: [agreement(2)] }),
      professional(3, [range('08:00', '10:00')], { agreements: [agreement(1), agreement(2)] }),
      ...[[], null, undefined].map((agreements, index) => professional(4 + index, [range('00:00', '23:30')], { agreements })),
    ],
    pages: [[block(3, '08:30', '09:00')]],
  });
  assert.match(ui.html, /<option value="">Todos<\/option>/);
  assert.match(ui.html, /&lt;Acuerdo &amp; dos&gt;/);
  assert.equal(ui.cell('2026-09-28', '08:00').count, 3);
  assert.equal(ui.cell('2026-09-28', '08:30').count, 2);
  assert.doesNotMatch(ui.html, /data-time="00:00"|data-time="20:00"/);
  const requests = ui.requests.length;
  await ui.agreement('1');
  assert.equal(ui.cell('2026-09-28', '08:00').count, 2);
  assert.equal(ui.cell('2026-09-28', '08:30').count, 1);
  await ui.agreement('2');
  assert.equal(ui.cell('2026-09-28', '08:00').count, 2);
  assert.equal(ui.cell('2026-09-28', '08:30').count, 1);
  await ui.action('coverage-next');
  assert.match(ui.html, /<option value="2" selected>/);
  assert.equal(ui.cell('2026-10-05', '08:30').count, 2);
  await ui.agreement('3');
  assert.equal(ui.cell('2026-10-05', '08:00').count, 0);
  await ui.agreement('');
  assert.equal(ui.cell('2026-10-05', '08:00').count, 3);
  assert.equal(ui.requests.length, requests);
});

test('coverage can filter associated agreements without requiring agreement catalog permissions', async () => {
  const ui = await openCoverage({
    permissions: ['professionals.read', 'schedule_blocks.read'],
    professionals: [professional(1, [range('08:00', '10:00')], { agreements: [agreement(7, 'Convenio visible')] })],
  });
  assert.equal(ui.requests.includes('/api/admin/agreements'), false);
  assert.match(ui.html, /<option value="7">Convenio visible<\/option>/);
  await ui.agreement('7');
  assert.equal(ui.cell('2026-09-28', '08:00').count, 1);
});

test('coverage uses custom name-only tooltips with escaped names and no native cell titles', async () => {
  const ui = await openCoverage({ professionals: [
    professional(1, [range('08:00', '10:00')], { name: 'Zoe' }),
    professional(2, [range('08:00', '10:00')], { name: 'Ana <"&>' }),
  ] });
  assert.match(ui.html, /id="coverage-tooltip"[^>]*role="tooltip" hidden/);
  assert.match(ui.html, /data-professional-names="\[&quot;Ana &lt;\\&quot;&amp;&gt;&quot;,&quot;Zoe&quot;\]" tabindex="0"/);
  assert.doesNotMatch(ui.html, /<td class="coverage-cell[^>]* title=/);
  assert.doesNotMatch(ui.html, /<td class="coverage-cell uncovered"[^>]*data-professional-names=/);
});

test('professional hours merge overlapping schedules and subtract exact blocked minutes only once', async () => {
  const ui = await openCoverage({
    professionals: [
      professional(1, [range('08:00', '10:00'), range('09:00', '11:00'), range('11:00', '12:00'),
        range('14:00', '15:00'), range('09:15', '10:00', 2), range('23:00', '23:30', 7)]),
      professional(2, [range('08:00', '13:00')]),
      professional(3, []),
      professional(4, [range('08:00', '20:00')], { active: false }),
      professional(5, [range('08:00', '20:00')], { deleted_at: '2026-09-01' }),
      professional(6, [range('08:00', '20:00')], { agreements: [] }),
    ],
    pages: [[
      block(1, '07:00', '08:15'), block(1, '09:00', '09:30'), block(1, '09:15', '10:00'),
      block(1, '11:45', '14:15'), block(1, '16:00', '17:00'),
    ], [
      block(1, '09:30', '09:40', '2026-09-29'), block(1, '23:15', '23:20', '2026-10-04'),
      block(2, '00:00', '23:59', '2026-10-05'),
    ]],
  });
  assert.deepEqual(ui.hours(), [
    { id: '2', days: ['5 h', '0 h', '0 h', '0 h', '0 h', '0 h', '0 h'], total: '5 h' },
    { id: '1', days: ['3 h 15 min', '0 h 35 min', '0 h', '0 h', '0 h', '0 h', '0 h 25 min'], total: '4 h 15 min' },
    { id: '3', days: Array(7).fill('0 h'), total: '0 h' },
  ]);
  await ui.action('coverage-next');
  assert.deepEqual(ui.hours()[0], {
    id: '1', days: ['5 h', '0 h 45 min', '0 h', '0 h', '0 h', '0 h', '0 h 30 min'], total: '6 h 15 min',
  });
  assert.equal(ui.hours().find((row) => row.id === '2').total, '0 h');
});

test('professional hour totals follow the agreement filter and break ties alphabetically', async () => {
  const ui = await openCoverage({
    agreements: [agreement(1), agreement(2), agreement(3)],
    professionals: [
      professional(1, [range('08:00', '10:00')], { name: 'Zoe' }),
      professional(2, [range('08:00', '10:00', 2)], { name: 'Ana', agreements: [agreement(2)] }),
      professional(3, [range('08:00', '09:30', 6)], { name: '<Camila & José>', agreements: [agreement(1), agreement(2)] }),
    ],
  });
  assert.deepEqual(ui.hours().map((row) => row.id), ['2', '1', '3']);
  assert.equal(ui.hours()[2].days[5], '1 h 30 min');
  assert.equal(ui.hours()[2].total, '1 h 30 min');
  assert.match(ui.html, /<th scope="row">&lt;Camila &amp; José&gt;<\/th>/);
  await ui.agreement('1');
  assert.deepEqual(ui.hours().map((row) => row.id), ['1', '3']);
  await ui.agreement('2');
  assert.deepEqual(ui.hours().map((row) => row.id), ['2', '3']);
  await ui.agreement('3');
  assert.deepEqual(ui.hours(), []);
  assert.match(ui.html, /No hay profesionales activos para los acuerdos seleccionados/);
});

test('a partial block removes a full slot; exact boundaries leave adjacent slots intact', async () => {
  const ui = await openCoverage({
    professionals: [professional(1, [range('08:00', '10:00')])],
    pages: [[block(1, '08:30', '09:00'), block(1, '09:40', '09:45')]],
  });
  assert.equal(ui.cell('2026-09-28', '08:00').count, 1);
  assert.equal(ui.cell('2026-09-28', '08:30').count, 0);
  assert.equal(ui.cell('2026-09-28', '09:00').count, 1);
  assert.equal(ui.cell('2026-09-28', '09:30').count, 0);
});

test('adjacent ranges cover a full slot once; split shifts and partial slots retain their gaps', async () => {
  const ui = await openCoverage({ professionals: [professional(1, [
    range('08:15', '08:45'), range('08:45', '09:00'), range('10:00', '10:15'), range('10:20', '11:00'),
  ], { name: '<Ana & José>' })] });
  assert.equal(ui.cell('2026-09-28', '08:00').count, 0);
  assert.equal(ui.cell('2026-09-28', '08:30').count, 1);
  assert.equal(ui.cell('2026-09-28', '09:00').count, 0);
  assert.equal(ui.cell('2026-09-28', '10:00').count, 0);
  assert.equal(ui.cell('2026-09-28', '10:30').count, 1);
  assert.match(ui.html, /&lt;Ana &amp; José&gt;/);
});

test('week selection includes weekends, handles year changes, and defaults to Argentina date', async () => {
  const ui = await openCoverage({
    now: '2026-09-28T01:00:00Z', // Still Sunday in Argentina.
    professionals: [professional(1, [range('07:10', '21:10', 7)])],
  });
  assert.match(ui.html, /value="2026-09-21"/);
  assert.equal(ui.cell('2026-09-27', '07:00').count, 0);
  assert.equal(ui.cell('2026-09-27', '07:30').count, 1);
  assert.equal(ui.cell('2026-09-27', '21:00').count, 0);
  await ui.date('2027-01-01');
  assert.match(ui.html, /value="2026-12-28"/);
  assert.equal(ui.cell('2027-01-03', '08:00').count, 1);
  await ui.date('');
  assert.match(ui.html, /value="2026-12-28"/);
  await ui.action('coverage-today');
  assert.match(ui.html, /value="2026-09-21"/);
});

test('empty schedules render uncovered slots; failed requests never render false coverage and can retry', async () => {
  const empty = await openCoverage();
  assert.match(empty.html, /No hay horarios de profesionales activos/);
  assert.equal((empty.html.match(/class="coverage-cell uncovered"/g) || []).length, 24 * 7);
  const failed = await openCoverage({ fail: true });
  assert.match(failed.html, /No se pudo cargar la cobertura: Error de conexión/);
  assert.doesNotMatch(failed.html, /class="coverage-cell/);
  failed.setFailure(false);
  await failed.action('refresh');
  assert.equal(failed.cell('2026-09-28', '08:00').count, 0);
  failed.setFailure(true);
  await failed.action('refresh');
  assert.doesNotMatch(failed.html, /class="coverage-cell/);
});
