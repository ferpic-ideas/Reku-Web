import assert from 'node:assert/strict';
import test from 'node:test';
import { enforceBookingIntakeOrigin } from '../src/booking-origin.mjs';

const appUrl = 'https://www.reku.io';

test('medical order intake accepts same-host requests from the main site and agreement subdomains', () => {
  for (const host of ['www.reku.io', 'ypf.reku.io', 'artro.reku.io', 'nuevo-acuerdo.reku.io']) {
    assert.doesNotThrow(() => enforceBookingIntakeOrigin({ headers: { host, origin: `https://${host}` } }, appUrl));
  }
  assert.doesNotThrow(() => enforceBookingIntakeOrigin({ headers: {
    host: 'localhost:8080', origin: 'http://localhost:8080',
  } }, 'http://localhost:8080'));
});

test('medical order intake rejects foreign, sibling, missing and malformed origins', () => {
  for (const [origin, host] of [
    ['https://attacker.example', 'ypf.reku.io'],
    ['https://attacker.example', 'attacker.example'],
    ['https://ypf.reku.io.attacker.example', 'ypf.reku.io.attacker.example'],
    ['https://ypf.reku.io', 'artro.reku.io'],
    ['https://www.reku.io', 'ypf.reku.io'],
    ['https://ypf.reku.io', 'www.reku.io'],
    ['http://ypf.reku.io', 'ypf.reku.io'],
    ['https://ypf.reku.io:8443', 'ypf.reku.io:8443'],
    ['https://admin.reku.io', 'admin.reku.io'],
    ['https://nested.ypf.reku.io', 'nested.ypf.reku.io'],
    ['https://ypf.reku.io/path', 'ypf.reku.io'],
    ['https://user@ypf.reku.io', 'ypf.reku.io'],
    ['null', 'ypf.reku.io'],
    ['', 'ypf.reku.io'],
    ['https://ypf.reku.io', ''],
  ]) {
    assert.throws(() => enforceBookingIntakeOrigin({ headers: {
      host, origin, 'x-forwarded-host': 'ypf.reku.io', 'x-forwarded-proto': 'https',
    } }, appUrl), { message: 'PATIENT_APPOINTMENT_ORIGIN_INVALID', statusCode: 403 }, `${origin} -> ${host}`);
  }
});
