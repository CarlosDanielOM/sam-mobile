package com.sam.embeddings;

import java.util.function.IntSupplier;
import java.util.function.LongSupplier;

/** OEM property screening only: accepted values retain their original units and sign. */
final class BatteryReadings {
  private BatteryReadings() {}

  static Integer charge(IntSupplier property) {
    try {
      int value = property.getAsInt();
      return value > 0 && value <= 100_000_000 ? value : null;
    } catch (RuntimeException unavailable) {
      return null;
    }
  }

  static Integer current(IntSupplier property) {
    try {
      int value = property.getAsInt();
      // Zero also means unsupported on older target SDKs. Never infer idle from it.
      return value != 0 && value >= -20_000_000 && value <= 20_000_000 ? value : null;
    } catch (RuntimeException unavailable) {
      return null;
    }
  }

  static Long energy(LongSupplier property) {
    try {
      long value = property.getAsLong();
      // Screen int sentinels too: some vendors widen an unsupported int to a long.
      if (value == Integer.MIN_VALUE || value == Integer.MAX_VALUE
          || value == Long.MIN_VALUE || value == Long.MAX_VALUE
          || value <= 0 || value > 9_007_199_254_740_991L || value > 1_000_000_000_000L) return null;
      return value;
    } catch (RuntimeException unavailable) {
      return null;
    }
  }

  static Boolean plugged(int value) {
    // Android's AC/USB/wireless/dock bit flags. Unknown future flags are unavailable.
    return value >= 0 && (value & ~15) == 0 ? value != 0 : null;
  }

  static Integer status(int value) {
    return value >= 1 && value <= 5 ? value : null;
  }
}
