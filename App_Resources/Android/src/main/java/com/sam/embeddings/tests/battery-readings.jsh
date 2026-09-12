// javac -d /tmp/opencode/sam-battery-checks App_Resources/Android/src/main/java/com/sam/embeddings/BatteryReadings.java
// jshell --class-path /tmp/opencode/sam-battery-checks App_Resources/Android/src/main/java/com/sam/embeddings/tests/battery-readings.jsh
// Pure JVM checks: no Android framework or JSON dependency.
import java.lang.reflect.*;
import java.util.*;
import java.util.function.*;

class BatteryChecks {
  int passed;
  final Class<?> readings = Class.forName("com.sam.embeddings.BatteryReadings");
  BatteryChecks() throws Exception {}

  Object call(String name, Class<?> type, Object value) throws Exception {
    Method method = readings.getDeclaredMethod(name, type);
    method.setAccessible(true);
    return method.invoke(null, value);
  }

  void check(Object actual, Object expected, String label) {
    if (!Objects.equals(actual, expected)) throw new AssertionError(label + ": " + actual + " != " + expected);
    passed++;
  }

  void run() throws Exception {
    for (int value : new int[] {Integer.MIN_VALUE, Integer.MAX_VALUE, -1, 0, 100_000_001}) {
      check(call("charge", IntSupplier.class, (IntSupplier) () -> value), null, "invalid charge " + value);
    }
    for (int value : new int[] {1, 4_123_456, 100_000_000}) {
      check(call("charge", IntSupplier.class, (IntSupplier) () -> value), value, "raw charge " + value);
    }
    for (int value : new int[] {Integer.MIN_VALUE, Integer.MAX_VALUE, -20_000_001, 20_000_001, 0}) {
      check(call("current", IntSupplier.class, (IntSupplier) () -> value), null, "invalid current " + value);
    }
    for (int value : new int[] {-20_000_000, -123_456, -1, 1, 123_456, 20_000_000}) {
      check(call("current", IntSupplier.class, (IntSupplier) () -> value), value, "raw signed current " + value);
    }
    for (long value : new long[] {Long.MIN_VALUE, Long.MAX_VALUE, Integer.MIN_VALUE, Integer.MAX_VALUE,
        -1, 0, 1_000_000_000_001L, 9_007_199_254_740_991L, 9_007_199_254_740_992L}) {
      check(call("energy", LongSupplier.class, (LongSupplier) () -> value), null, "invalid energy " + value);
    }
    for (long value : new long[] {1, 16_123_456_789L, 1_000_000_000_000L}) {
      check(call("energy", LongSupplier.class, (LongSupplier) () -> value), value, "raw exact energy " + value);
    }
    int[] calls = {0};
    IntSupplier brokenInt = () -> { calls[0]++; throw new SecurityException("OEM unavailable"); };
    LongSupplier brokenLong = () -> { calls[0]++; throw new UnsupportedOperationException("OEM unavailable"); };
    check(call("charge", IntSupplier.class, brokenInt), null, "charge exception");
    check(call("current", IntSupplier.class, brokenInt), null, "now exception");
    check(call("current", IntSupplier.class, brokenInt), null, "average exception");
    check(call("energy", LongSupplier.class, brokenLong), null, "energy exception");
    check(calls[0], 4, "all properties attempted independently");
    check(call("energy", LongSupplier.class, (LongSupplier) () -> 16_123_456_789L), 16_123_456_789L, "failure does not poison other property");
    check(call("plugged", int.class, 0), false, "unplugged");
    for (int value : new int[] {1, 2, 4, 8, 3, 15}) check(call("plugged", int.class, value), true, "power flag " + value);
    for (int value : new int[] {-1, Integer.MIN_VALUE, Integer.MAX_VALUE, 16}) check(call("plugged", int.class, value), null, "unknown power flag");
    for (int value = 1; value <= 5; value++) check(call("status", int.class, value), value, "raw status");
    for (int value : new int[] {-1, 0, 6, Integer.MIN_VALUE, Integer.MAX_VALUE}) check(call("status", int.class, value), null, "unknown status");
    System.out.println("PASS: " + passed + " battery sanitizer, exception isolation, and broadcast checks");
  }
}

int testExitCode = 0;
try { new BatteryChecks().run(); } catch (Throwable failure) { failure.printStackTrace(); testExitCode = 1; }
/exit testExitCode
