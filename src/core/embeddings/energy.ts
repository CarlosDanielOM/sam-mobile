import type { BatteryEnergyReadings, DeviceDiagnostics } from './types';

export interface EnergyEfficiency {
  chargeConsumedMah: number | null;
  energyConsumedMwh: number | null;
  mahPer100Documents: number | null;
  mwhPer100Documents: number | null;
  mwhPer1000Tokens: number | null;
  /** Null only when both counters support an estimate; partial results explain the missing metric. */
  reason: string | null;
  chargeReason: string | null;
  energyReason: string | null;
  confidence: 'unavailable' | 'counter-estimate';
  resolution: 'unknown' | 'observed-step-screened';
  scope: 'device-wide-including-screen-and-system';
}

/**
 * Device-wide remaining-counter differences, not app attribution or a model ranking.
 * Never integrates current, converts charge with an assumed voltage, or uses battery percentage.
 * Resolution is not published by Android: repeated steps only screen obvious quantization,
 * not establish meter accuracy. Even accepted results remain estimates.
 */
export function deriveEnergy(samples: DeviceDiagnostics[], completed: number, totalTokens: number): EnergyEfficiency {
  const result: EnergyEfficiency = {
    chargeConsumedMah: null, energyConsumedMwh: null, mahPer100Documents: null,
    mwhPer100Documents: null, mwhPer1000Tokens: null, reason: null,
    chargeReason: null, energyReason: null, confidence: 'unavailable', resolution: 'unknown',
    scope: 'device-wide-including-screen-and-system',
  };
  let invalid: string | null = samples.length < 3 ? 'At least three reliable discharging samples are required.' : null;
  const readings: BatteryEnergyReadings[] = [];
  for (const sample of samples) {
    const reading = sample?.batteryEnergy;
    if (!reading) { invalid = 'Battery energy diagnostics are unavailable for part or all of the window.'; break; }
    if (reading.plugged !== false || reading.status !== 3) {
      invalid = 'Every sample must be unplugged and explicitly discharging (Android status 3).'; break;
    }
    // Unsupported/zero current is unavailable, not evidence of either discharge or idle.
    if ([reading.currentNowUa, reading.currentAverageUa].some(value =>
      Number.isSafeInteger(value) && value! > 0 && value! <= 20_000_000)) {
      invalid = 'Positive current contradicts the discharging battery status.'; break;
    }
    if (!Number.isSafeInteger(reading.elapsedRealtimeMs) || reading.elapsedRealtimeMs < 0
        || (readings.length > 0 && reading.elapsedRealtimeMs <= readings[readings.length - 1].elapsedRealtimeMs)) {
      invalid = 'Battery elapsed time must be finite, nonnegative and strictly monotonic.'; break;
    }
    readings.push(reading);
  }
  if (!invalid && readings[readings.length - 1].elapsedRealtimeMs - readings[0].elapsedRealtimeMs < 60_000) {
    invalid = 'The discharging window is too short; at least 60 seconds is required.';
  }
  if (invalid) {
    return { ...result, reason: invalid, chargeReason: invalid, energyReason: invalid };
  }

  for (const kind of ['charge', 'energy'] as const) {
    const key = kind === 'charge' ? 'chargeCounterUah' : 'energyCounterNwh';
    const values = readings.map(reading => reading[key]);
    const max = kind === 'charge' ? 100_000_000 : 1_000_000_000_000;
    const divisor = kind === 'charge' ? 1_000 : 1_000_000;
    let reason: string | null = null;
    if (values.some(value => value === null || !Number.isSafeInteger(value) || value <= 0
        || value > max || value === 2_147_483_647)) {
      reason = `${kind} counter is unsupported, missing or outside reliable ranges.`;
    } else {
      const counters = values as number[];
      let decreases = 0;
      let largestStep = 0;
      for (let index = 1; index < counters.length; index++) {
        const delta = counters[index - 1] - counters[index];
        const elapsed = readings[index].elapsedRealtimeMs - readings[index - 1].elapsedRealtimeMs;
        if (delta < 0) { reason = `${kind} counter rose or reset during the window.`; break; }
        // Per-interval bounds catch resets that a long-window average would hide (10 A / 50 W).
        if (delta / divisor * 3_600_000 / elapsed > (kind === 'charge' ? 10_000 : 50_000)) {
          reason = `${kind} counter implies an implausible discharge rate or reset.`; break;
        }
        if (delta > 0) decreases++;
        largestStep = Math.max(largestStep, delta);
      }
      const delta = counters[0] - counters[counters.length - 1];
      if (!reason && delta <= 0) reason = `${kind} counter has no measurable decrease.`;
      // Ten observed decreases and no step >10% of the window delta. This deliberately
      // rejects short/coarse traces; the largest observed step is NOT a known vendor LSB.
      if (!reason && (decreases < 10 || largestStep > delta / 10 || delta < (kind === 'charge' ? 10 : 10_000))) {
        reason = `${kind} counter delta is too small or vendor quantization is uncertain; collect a longer window.`;
      }
      if (!reason) {
        if (kind === 'charge') result.chargeConsumedMah = delta / divisor;
        else result.energyConsumedMwh = delta / divisor;
      }
    }
    if (kind === 'charge') result.chargeReason = reason;
    else result.energyReason = reason;
  }
  if (result.chargeConsumedMah !== null && result.energyConsumedMwh !== null) {
    // Broad handheld/multi-cell range; no voltage is assumed to manufacture an energy value.
    const impliedVolts = result.energyConsumedMwh / result.chargeConsumedMah;
    if (impliedVolts < 2 || impliedVolts > 20) {
      const reason = 'Charge and energy counter deltas are inconsistent (implied voltage outside 2-20 V).';
      return { ...result, chargeConsumedMah: null, energyConsumedMwh: null,
        reason, chargeReason: reason, energyReason: reason };
    }
  }
  if (result.chargeConsumedMah !== null || result.energyConsumedMwh !== null) {
    result.confidence = 'counter-estimate';
    result.resolution = 'observed-step-screened';
  }
  if (Number.isSafeInteger(completed) && completed > 0) {
    if (result.chargeConsumedMah !== null) result.mahPer100Documents = result.chargeConsumedMah * 100 / completed;
    if (result.energyConsumedMwh !== null) result.mwhPer100Documents = result.energyConsumedMwh * 100 / completed;
  }
  if (Number.isSafeInteger(totalTokens) && totalTokens > 0 && result.energyConsumedMwh !== null) {
    result.mwhPer1000Tokens = result.energyConsumedMwh * 1000 / totalTokens;
  }
  result.reason = [result.chargeReason, result.energyReason,
    !(Number.isSafeInteger(completed) && completed > 0) ? 'Document normalization requires a positive integer completed count.' : null,
    !(Number.isSafeInteger(totalTokens) && totalTokens > 0) ? 'Token normalization requires a positive integer token count.' : null,
  ].filter(Boolean).join(' ') || null;
  return result;
}
