import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveEnergy } from './energy';
import type { BatteryEnergyReadings, DeviceDiagnostics } from './types';

const device: DeviceDiagnostics = {
  timestamp: 1, manufacturer: 'Test', model: 'Phone', androidVersion: '15', sdk: 35,
  abi: null, supportedAbis: [], totalRamBytes: null, availableRamBytes: null, appPssBytes: null,
  nativeHeapBytes: 0, javaHeapBytes: 0, batteryLevel: 80, batteryTemperatureC: null,
  thermalStatus: null, lowMemory: null, thresholdBytes: null,
};

function window(overrides: Partial<BatteryEnergyReadings> = {}): DeviceDiagnostics[] {
  return Array.from({ length: 11 }, (_, index) => ({
    ...device,
    batteryEnergy: {
      chargeCounterUah: 4_000_000 - index * 1_000,
      energyCounterNwh: 16_000_000_000 - index * 4_000_000,
      currentNowUa: -600_000, currentAverageUa: -600_000,
      plugged: false, status: 3, elapsedRealtimeMs: 1_000 + index * 6_000,
      ...overrides,
    },
  }));
}

function unavailable(samples: DeviceDiagnostics[], pattern: RegExp): void {
  const result = deriveEnergy(samples, 50, 2_000);
  assert.equal(result.chargeConsumedMah, null);
  assert.equal(result.energyConsumedMwh, null);
  assert.equal(result.mahPer100Documents, null);
  assert.equal(result.mwhPer100Documents, null);
  assert.equal(result.mwhPer1000Tokens, null);
  assert.equal(result.confidence, 'unavailable');
  assert.match(result.reason!, pattern);
}

test('counter unit conversion and normalization are explicitly device-wide estimates', () => {
  const samples = window();
  const original = structuredClone(samples);
  const result = deriveEnergy(samples, 50, 2_000);
  assert.deepEqual(result, {
    chargeConsumedMah: 10, energyConsumedMwh: 40,
    mahPer100Documents: 20, mwhPer100Documents: 80, mwhPer1000Tokens: 20,
    reason: null, chargeReason: null, energyReason: null,
    confidence: 'counter-estimate', resolution: 'observed-step-screened',
    scope: 'device-wide-including-screen-and-system',
  });
  assert.deepEqual(samples, original, 'raw readings must not be changed');
});

test('missing diagnostics, insufficient samples and gaps do not shorten the measured window', () => {
  unavailable([], /three/);
  unavailable(window().slice(0, 2), /three/);
  unavailable([device, device, device], /unavailable/);
  for (const index of [0, 5, 10]) {
    const samples = window();
    delete samples[index].batteryEnergy;
    unavailable(samples, /unavailable/);
  }
});

test('unsupported, nonpositive, unsafe, sentinel and bogus counters remain unavailable', () => {
  for (const value of [null, 0, -1, -2_147_483_648, 2_147_483_647,
    -9_223_372_036_854_775_808, 9_223_372_036_854_775_807,
    Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, 0.5, 1_000_000_000_001]) {
    unavailable(window({ chargeCounterUah: value, energyCounterNwh: value }), /unsupported/);
  }
});

test('each counter can be independently unavailable without synthesizing the missing unit', () => {
  const chargeOnly = deriveEnergy(window({ energyCounterNwh: null }), 50, 2_000);
  assert.equal(chargeOnly.chargeConsumedMah, 10);
  assert.equal(chargeOnly.energyConsumedMwh, null);
  assert.equal(chargeOnly.mwhPer1000Tokens, null);
  assert.match(chargeOnly.energyReason!, /unsupported/);
  const energyOnly = deriveEnergy(window({ chargeCounterUah: null }), 50, 2_000);
  assert.equal(energyOnly.energyConsumedMwh, 40);
  assert.equal(energyOnly.chargeConsumedMah, null);
  assert.equal(energyOnly.mwhPer1000Tokens, 20);
  for (const key of ['chargeCounterUah', 'energyCounterNwh'] as const) {
    const samples = window();
    samples[5].batteryEnergy![key] = null;
    assert.match(deriveEnergy(samples, 50, 2_000)[key === 'chargeCounterUah' ? 'chargeReason' : 'energyReason']!, /missing/);
  }
});

test('plugged, charging, full, not-charging and unknown broadcast state reject the entire window', () => {
  for (const override of [{ plugged: true }, { plugged: null }, ...[null, 1, 2, 4, 5, 0, 6].map(status => ({ status }))]) {
    const samples = window();
    Object.assign(samples[5].batteryEnergy!, override);
    unavailable(samples, /unplugged.*discharging/);
  }
});

test('positive now or average current contradicts discharge; unavailable current is not integrated', () => {
  for (const key of ['currentNowUa', 'currentAverageUa'] as const) {
    const samples = window();
    samples[5].batteryEnergy![key] = 1;
    unavailable(samples, /contradicts/);
  }
  for (const value of [null, 0, -2_147_483_648, 2_147_483_647, -20_000_000, NaN]) {
    assert.equal(deriveEnergy(window({ currentNowUa: value, currentAverageUa: value }), 50, 2_000).energyConsumedMwh, 40);
  }
  unavailable(window({ chargeCounterUah: null, energyCounterNwh: null, currentNowUa: -600_000 }), /unsupported/);
});

test('falling percentage and changing wall clock do not produce or affect counter energy', () => {
  const samples = window();
  samples.forEach((sample, index) => { sample.timestamp = 100 - index; sample.batteryLevel = 80 - index; });
  assert.equal(deriveEnergy(samples, 50, 2_000).energyConsumedMwh, 40);
  samples.forEach(sample => { sample.batteryEnergy!.energyCounterNwh = null; sample.batteryEnergy!.chargeCounterUah = null; });
  unavailable(samples, /unsupported/);
});

test('elapsed time must be safe and strictly increasing without sorting away a reset', () => {
  for (const elapsed of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5, 1_000, 0]) {
    const samples = window();
    samples[5].batteryEnergy!.elapsedRealtimeMs = elapsed;
    unavailable(samples, /monotonic/);
  }
  const samples = window();
  samples[5].batteryEnergy!.elapsedRealtimeMs = samples[4].batteryEnergy!.elapsedRealtimeMs;
  unavailable(samples, /monotonic/);
  unavailable(window().reverse(), /monotonic/);
});

test('sub-minute windows and unchanged counters are not measured zero consumption', () => {
  const samples = window();
  samples[10].batteryEnergy!.elapsedRealtimeMs--;
  unavailable(samples, /too short/);
  unavailable(window({ chargeCounterUah: 4_000_000, energyCounterNwh: 16_000_000_000 }), /no measurable/);
});

test('rising counters and upward resets are rejected even with a net decline', () => {
  const samples = window();
  samples[5].batteryEnergy!.chargeCounterUah = 4_000_001;
  samples[5].batteryEnergy!.energyCounterNwh = 16_000_000_001;
  unavailable(samples, /rose or reset/);
});

test('implausible discharge or downward reset is screened per interval, not just net elapsed', () => {
  const fast = window();
  fast[5].batteryEnergy!.elapsedRealtimeMs = fast[4].batteryEnergy!.elapsedRealtimeMs + 1;
  unavailable(fast, /implausible/);
  const reset = window();
  reset.slice(5).forEach(sample => {
    sample.batteryEnergy!.chargeCounterUah! -= 1_000_000;
    sample.batteryEnergy!.energyCounterNwh! -= 4_000_000_000;
  });
  unavailable(reset, /implausible/);
});

test('coarse vendor updates, too few decreases and dominant steps are uncertain', () => {
  const coarse = window();
  coarse.forEach((sample, index) => {
    sample.batteryEnergy!.chargeCounterUah = 4_000_000 - Math.floor(index / 5) * 5_000;
    sample.batteryEnergy!.energyCounterNwh = 16_000_000_000 - Math.floor(index / 5) * 20_000_000;
  });
  unavailable(coarse, /quantization/);
  unavailable(window().filter((_, index) => index % 2 === 0), /quantization/);
  const dominant = window();
  dominant[10].batteryEnergy!.chargeCounterUah! -= 100;
  dominant[10].batteryEnergy!.energyCounterNwh! -= 400_000;
  unavailable(dominant, /quantization/);
});

test('sub-resolution energy differences are rejected despite repeated decreases', () => {
  const samples = window({ chargeCounterUah: null });
  samples.forEach((sample, index) => { sample.batteryEnergy!.energyCounterNwh = 16_000_000_000 - index; });
  unavailable(samples, /quantization/);
});

test('plateaus can pass after enough resolved decreases and a sufficiently long window', () => {
  const samples = window().flatMap(sample => [sample, {
    ...sample, batteryEnergy: { ...sample.batteryEnergy!, elapsedRealtimeMs: sample.batteryEnergy!.elapsedRealtimeMs + 1_000 },
  }]);
  assert.equal(deriveEnergy(samples, 50, 2_000).energyConsumedMwh, 40);
});

test('individually plausible but mutually inconsistent counters reject both estimates', () => {
  for (const step of [1_000_000, 21_000_000]) {
    const samples = window();
    samples.forEach((sample, index) => { sample.batteryEnergy!.energyCounterNwh = 16_000_000_000 - index * step; });
    unavailable(samples, /inconsistent/);
  }
});

test('invalid normalization counts never emit infinity, fabricated zeros or discard raw consumption', () => {
  for (const count of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const result = deriveEnergy(window(), count, count);
    assert.equal(result.chargeConsumedMah, 10);
    assert.equal(result.energyConsumedMwh, 40);
    assert.equal(result.mahPer100Documents, null);
    assert.equal(result.mwhPer100Documents, null);
    assert.equal(result.mwhPer1000Tokens, null);
    assert.match(result.reason!, /normalization/);
  }
});
