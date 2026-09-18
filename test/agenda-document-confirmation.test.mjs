import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const setup = async (success = true) => {
  const source = await readFile(new URL('../agenda/app.js', import.meta.url), 'utf8');
  const app = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const context = {
    document: { getElementById: () => app },
    window: { location: { search: '', hash: '' } },
    URLSearchParams, URL, FormData,
    fetch: async () => ({ ok: success, json: async () => success
      ? { documents: [{ kind: 'link', name: 'Estudio' }], message: 'Documentación compartida.' }
      : { error: 'No se pudo compartir.' } }),
  };
  vm.runInNewContext(source.replace('  loadInitial();', '  globalThis.bookingTest = { state, submitDocuments, renderDocumentsCard, submitManagementDocuments, deleteManagementDocument, renderManagementSentDocuments, renderDocumentDeleteModal, renderMeetLobby, renderAppointmentManagement };'), context);
  const { state } = context.bookingTest;
  state.loading = false;
  state.step = 6;
  state.appointment = { id: 1, status: 'confirmed', payment_status: 'free' };
  state.documentsOpen = true;
  state.documentLinksDraft = 'https://example.com/estudio';
  return { ...context.bookingTest, app };
};

test('successful document upload collapses the form and replaces the gray toggle with confirmation', async () => {
  const page = await setup();
  await page.submitDocuments({ querySelector: () => null });
  assert.equal(page.state.documentsOpen, false);
  assert.equal(page.state.documentsUploading, false);
  assert.equal(page.state.documentLinksDraft, '');
  assert.equal(page.state.documents.length, 1);
  assert.match(page.app.innerHTML, /role="status">\s*<span>Documentación compartida\./);
  assert.match(page.app.innerHTML, /Agregar más documentación/);
  assert.doesNotMatch(page.app.innerHTML, /id="appointment-documents-form"|Quiero enviar estudios previos|Ocultar documentación/);
});

const prepareManaged = page => {
  page.state.management.appointment = {
    id: 1, status: 'confirmed', date: '2026-10-01', start_time: '15:30', end_time: '16:00',
    service: { name: 'Evaluación' }, professional: { name: 'Fisio' }, capabilities: {},
    documents: [
      { id: 1, kind: 'file', name: 'Orden <ficticia>.pdf', url: '/api/booking/manage/documents/1' },
      { id: 2, kind: 'link', name: 'Estudio por enlace', url: 'https://example.test/estudio?id=1&other=2' },
    ],
  };
};

test('both patient email screens list the existing studies outside the collapsed upload panel', async () => {
  const page = await setup();
  prepareManaged(page);
  for (const html of [page.renderMeetLobby(), page.renderAppointmentManagement()]) {
    assert.match(html, /Estudios enviados/);
    assert.match(html, /Orden &lt;ficticia&gt;\.pdf/);
    assert.match(html, /https:\/\/example.test\/estudio\?id=1&amp;other=2/);
    assert.match(html, /Ver archivo/);
    assert.match(html, /Ver enlace/);
    assert.match(html, /Enviar más estudios/);
    assert.match(html, /document-delete-button[^>]*data-id="1"[^>]*aria-label=/);
    assert.doesNotMatch(html, /id="management-documents-form"/);
  }
});

test('adding studies keeps the previous ones visible and collapses the upload form on success', async () => {
  const page = await setup();
  prepareManaged(page);
  page.state.management.documentsOpen = true;
  page.state.management.documentLinksDraft = 'https://example.test/otro';
  await page.submitManagementDocuments({ querySelector: () => null });
  assert.equal(page.state.management.appointment.documents.length, 3);
  assert.equal(page.state.management.documentsOpen, false);
  assert.equal(page.state.management.documentLinksDraft, '');
  assert.match(page.renderManagementSentDocuments(), /Documentación compartida/);
});

test('deletion confirmation identifies the selected study and removes only that item after success', async () => {
  const page = await setup();
  prepareManaged(page);
  page.state.management.documentDeletePending = 1;
  assert.match(page.renderDocumentDeleteModal(), /role="dialog"[\s\S]*Orden &lt;ficticia&gt;\.pdf/);
  await page.deleteManagementDocument();
  assert.equal(page.state.management.appointment.documents.length, 1);
  assert.equal(page.state.management.appointment.documents[0].id, 2);
  assert.equal(page.state.management.documentDeletePending, null);
});

test('failed deletion keeps the study and the confirmation dialog open with the error', async () => {
  const page = await setup(false);
  prepareManaged(page);
  page.state.management.documentDeletePending = 1;
  await page.deleteManagementDocument();
  assert.equal(page.state.management.appointment.documents.length, 2);
  assert.equal(page.state.management.documentDeletePending, 1);
  assert.equal(page.state.management.deletingDocumentId, null);
  assert.match(page.renderDocumentDeleteModal(), /role="alert">No se pudo compartir/);
});

test('failed upload stays open, keeps the draft and never shows a success confirmation', async () => {
  const page = await setup(false);
  await page.submitDocuments({ querySelector: () => null });
  assert.equal(page.state.documentsOpen, true);
  assert.equal(page.state.documentLinksDraft, 'https://example.com/estudio');
  assert.equal(page.state.documentsMessage, '');
  assert.match(page.app.innerHTML, /No se pudo compartir\./);
  assert.match(page.app.innerHTML, /id="appointment-documents-form"/);
  assert.doesNotMatch(page.app.innerHTML, /documents-confirmation/);
});
