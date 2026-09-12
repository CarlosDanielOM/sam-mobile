package com.sam.embeddings;

import android.app.ActivityManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Debug;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.net.Uri;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.util.JsonReader;
import android.util.JsonToken;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.StringReader;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Permission-free diagnostics and user-directed local report sharing, independent of inference. */
public final class SamDeviceDiagnostics {
  private static final int MAX_REPORT_BYTES = 1024 * 1024;
  private static final int MAX_REQUESTS = 16;
  private static final long RESULT_TTL_NANOS = TimeUnit.MINUTES.toNanos(10);
  private static final String REPORT_NAME =
      "sam-embeddings-report-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json";
  private static final Map<String, Request> REQUESTS = new HashMap<>();
  private static final ExecutorService WORKER = Executors.newSingleThreadExecutor(runnable -> {
    Thread thread = new Thread(runnable, "sam-device-diagnostics");
    thread.setPriority(Thread.NORM_PRIORITY - 1);
    return thread;
  });

  private static final class Request {
    final String operation;
    final String pending;
    String completed;
    long completedNanos;

    Request(String id, String operation) {
      this.operation = operation;
      pending = envelope(id, operation, "pending", null, null, null);
    }
  }

  private static final class ReportException extends IOException {
    private static final long serialVersionUID = 1L;
    final String code;

    ReportException(String code, String message) {
      super(message);
      this.code = code;
    }
  }

  private SamDeviceDiagnostics() {}

  /** Synchronous compatibility API for background callers only. UI callers must use sample/poll. */
  public static String snapshot(Context context) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      throw new IllegalStateException("Diagnostics must not run on the UI thread; use sample() and poll().");
    }
    Context app = application(context);
    JSONObject result = new JSONObject();
    ModelCatalog.put(result, "timestamp", System.currentTimeMillis());
    ModelCatalog.put(result, "manufacturer", Build.MANUFACTURER);
    ModelCatalog.put(result, "model", Build.MODEL);
    ModelCatalog.put(result, "androidVersion", Build.VERSION.RELEASE);
    ModelCatalog.put(result, "sdk", Build.VERSION.SDK_INT);
    ModelCatalog.put(result, "abi", Build.SUPPORTED_ABIS.length == 0 ? null : Build.SUPPORTED_ABIS[0]);
    JSONArray abis = new JSONArray();
    for (String abi : Build.SUPPORTED_ABIS) abis.put(abi);
    ModelCatalog.put(result, "supportedAbis", abis);
    if (Build.VERSION.SDK_INT >= 31 && reliable(Build.SOC_MODEL)) {
      JSONObject soc = new JSONObject();
      ModelCatalog.put(soc, "model", Build.SOC_MODEL);
      if (reliable(Build.SOC_MANUFACTURER)) {
        ModelCatalog.put(soc, "manufacturer", Build.SOC_MANUFACTURER);
      }
      ModelCatalog.put(result, "soc", soc);
    }

    for (String key : new String[] {"totalRamBytes", "availableRamBytes", "appPssBytes",
        "lowMemory", "thresholdBytes", "batteryLevel", "batteryTemperatureC", "thermalStatus"}) {
      ModelCatalog.put(result, key, null);
    }
    try {
      ActivityManager manager = (ActivityManager) app.getSystemService(Context.ACTIVITY_SERVICE);
      if (manager != null) {
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
        manager.getMemoryInfo(memory);
        ModelCatalog.put(result, "totalRamBytes", memory.totalMem);
        ModelCatalog.put(result, "availableRamBytes", memory.availMem);
        ModelCatalog.put(result, "lowMemory", memory.lowMemory);
        ModelCatalog.put(result, "thresholdBytes", memory.threshold);
      }
    } catch (RuntimeException unavailable) {
      // Some OEMs restrict diagnostics; unknown is not reported as zero.
    }
    try {
      Debug.MemoryInfo memory = new Debug.MemoryInfo();
      Debug.getMemoryInfo(memory);
      ModelCatalog.put(result, "appPssBytes", memory.getTotalPss() * 1024L);
    } catch (RuntimeException unavailable) {
      // Keep the nullable field when the OS cannot supply PSS.
    }
    ModelCatalog.put(result, "nativeHeapBytes", Debug.getNativeHeapAllocatedSize());
    Runtime runtime = Runtime.getRuntime();
    ModelCatalog.put(result, "javaHeapBytes", runtime.totalMemory() - runtime.freeMemory());
    JSONObject energy = new JSONObject();
    for (String key : new String[] {"chargeCounterUah", "currentNowUa", "currentAverageUa",
        "energyCounterNwh", "plugged", "status"}) {
      ModelCatalog.put(energy, key, null);
    }
    ModelCatalog.put(energy, "elapsedRealtimeMs", SystemClock.elapsedRealtime());
    ModelCatalog.put(result, "batteryEnergy", energy);
    try {
      BatteryManager manager = (BatteryManager) app.getSystemService(Context.BATTERY_SERVICE);
      if (manager != null) {
        ModelCatalog.put(energy, "chargeCounterUah", BatteryReadings.charge(
            () -> manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER)));
        ModelCatalog.put(energy, "currentNowUa", BatteryReadings.current(
            () -> manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)));
        ModelCatalog.put(energy, "currentAverageUa", BatteryReadings.current(
            () -> manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE)));
        ModelCatalog.put(energy, "energyCounterNwh", BatteryReadings.energy(
            () -> manager.getLongProperty(BatteryManager.BATTERY_PROPERTY_ENERGY_COUNTER)));
      }
    } catch (RuntimeException unavailable) {
      // Service lookup can fail; each property independently handles OEM exceptions.
    }
    try {
      Intent battery = app.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
      if (battery != null) {
        ModelCatalog.put(energy, "plugged", BatteryReadings.plugged(
            battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)));
        ModelCatalog.put(energy, "status", BatteryReadings.status(
            battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1)));
        int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
        if (level >= 0 && scale > 0 && level <= scale) {
          ModelCatalog.put(result, "batteryLevel", 100.0 * level / scale);
        }
        if (battery.hasExtra(BatteryManager.EXTRA_TEMPERATURE)) {
          ModelCatalog.put(result, "batteryTemperatureC",
              battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0);
        }
      }
    } catch (RuntimeException unavailable) {
      // Reading the sticky broadcast does not register a long-lived receiver.
    }
    if (Build.VERSION.SDK_INT >= 29) {
      try {
        PowerManager power = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
        if (power != null) ModelCatalog.put(result, "thermalStatus", power.getCurrentThermalStatus());
      } catch (RuntimeException unavailable) {
        // Leave thermalStatus null on unsupported devices.
      }
    }
    return result.toString();
  }

  /** Returns an opaque request ID immediately; all sampling happens on the diagnostics worker. */
  public static String sample(Context context) {
    Context app = application(context);
    String id = beginRequest("sample");
    WORKER.execute(() -> {
      try {
        complete(id, new JSONObject(snapshot(app)), null, null);
      } catch (Exception unavailable) {
        complete(id, null, "DIAGNOSTICS_FAILED", "Could not sample device diagnostics.");
      }
    });
    return id;
  }

  /** Terminal results are consumed once; polling never samples or performs file I/O. */
  public static String poll(String requestId) {
    synchronized (REQUESTS) {
      Request request = requestId != null && requestId.length() == 36 ? REQUESTS.get(requestId) : null;
      if (request != null) {
        if (request.completed == null) return request.pending;
        REQUESTS.remove(requestId);
        if (System.nanoTime() - request.completedNanos <= RESULT_TTL_NANOS) return request.completed;
      }
      return envelope(requestId != null && requestId.length() == 36 ? requestId : null,
          null, "completed", null, "UNKNOWN_REQUEST", "Request is unknown, consumed, expired, or from an earlier process.");
    }
  }

  /** Writes a bounded local JSON report off-thread, then opens only Android's user share chooser. */
  public static String exportReport(Context context, String json) {
    Context app = application(context);
    String id = beginRequest("export_report");
    // Constant-time admission check avoids retaining an arbitrarily large String in the work queue.
    boolean oversized = json != null && json.length() > MAX_REPORT_BYTES;
    String report = oversized ? null : json;
    WORKER.execute(() -> {
      try {
        if (oversized) throw new ReportException("REPORT_TOO_LARGE", "Report exceeds the 1 MiB UTF-8 limit.");
        byte[] bytes = validateReport(report);
        File file = writeReport(app, id, bytes);
        Uri uri;
        try {
          uri = FileProvider.getUriForFile(app, app.getPackageName() + ".embeddings.reports", file);
        } catch (IllegalArgumentException | SecurityException unavailable) {
          throw new ReportException("REPORT_PROVIDER", "Report FileProvider is missing or does not allow embedding-reports in cache.");
        }
        Intent send = new Intent(Intent.ACTION_SEND).setType("application/json")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri("SAM embeddings report", uri));
        Intent chooser = Intent.createChooser(send, "Share embeddings report")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        chooser.setClipData(send.getClipData());
        JSONObject result = new JSONObject();
        ModelCatalog.put(result, "chooserLaunched", true);
        ModelCatalog.put(result, "filename", file.getName());
        ModelCatalog.put(result, "mimeType", "application/json");
        ModelCatalog.put(result, "bytes", bytes.length);
        // No file inspection, provider lookup, report parsing, or diagnostics in this UI runnable.
        boolean posted = new Handler(Looper.getMainLooper()).post(() -> {
          try {
            app.startActivity(chooser);
            complete(id, result, null, null);
          } catch (ActivityNotFoundException unavailable) {
            complete(id, null, "SHARE_UNAVAILABLE", "No Android share chooser is available.");
          } catch (RuntimeException unavailable) {
            complete(id, null, "SHARE_LAUNCH_FAILED", "Android could not open the report share chooser.");
          }
        });
        if (!posted) complete(id, null, "SHARE_LAUNCH_FAILED", "Android could not schedule the report share chooser.");
      } catch (ReportException invalid) {
        complete(id, null, invalid.code, invalid.getMessage());
      } catch (Exception unavailable) {
        // Do not expose report content, private paths, or raw provider/OS exception text.
        complete(id, null, "REPORT_IO", "Could not prepare the local report for sharing.");
      }
    });
    return id;
  }

  private static Context application(Context context) {
    if (context == null || context.getApplicationContext() == null) {
      throw new IllegalArgumentException("An application context is required.");
    }
    return context.getApplicationContext();
  }

  private static String beginRequest(String operation) {
    synchronized (REQUESTS) {
      long now = System.nanoTime();
      Iterator<Request> iterator = REQUESTS.values().iterator();
      while (iterator.hasNext()) {
        Request request = iterator.next();
        if (request.completed != null && now - request.completedNanos > RESULT_TTL_NANOS) iterator.remove();
      }
      if (REQUESTS.size() >= MAX_REQUESTS) {
        throw new IllegalStateException("Diagnostics request limit reached; poll existing requests before retrying.");
      }
      if ("export_report".equals(operation)) {
        for (Request request : REQUESTS.values()) {
          // Keep a not-yet-launched chooser's file out of subsequent report retention cleanup.
          if ("export_report".equals(request.operation) && request.completed == null) {
            throw new IllegalStateException("A report share is already pending; poll it before retrying.");
          }
        }
      }
      String id = UUID.randomUUID().toString();
      REQUESTS.put(id, new Request(id, operation));
      return id;
    }
  }

  private static void complete(String id, JSONObject result, String code, String message) {
    synchronized (REQUESTS) {
      Request request = REQUESTS.get(id);
      if (request == null || request.completed != null) return;
      request.completed = envelope(id, request.operation, "completed", result, code, message);
      request.completedNanos = System.nanoTime();
    }
  }

  private static String envelope(String id, String operation, String state, JSONObject result,
      String code, String message) {
    JSONObject value = new JSONObject();
    ModelCatalog.put(value, "requestId", id);
    ModelCatalog.put(value, "operation", operation);
    ModelCatalog.put(value, "state", state);
    ModelCatalog.put(value, "result", result);
    JSONObject error = null;
    if (code != null) {
      error = new JSONObject();
      ModelCatalog.put(error, "code", code);
      ModelCatalog.put(error, "message", message);
    }
    ModelCatalog.put(value, "error", error);
    return value.toString();
  }

  private static byte[] validateReport(String json) throws IOException {
    if (json == null) throw new ReportException("INVALID_REPORT", "Report must be a JSON object.");
    if (json.length() > MAX_REPORT_BYTES) {
      throw new ReportException("REPORT_TOO_LARGE", "Report exceeds the 1 MiB UTF-8 limit.");
    }
    ByteBuffer encoded;
    try {
      encoded = StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(json));
    } catch (CharacterCodingException malformed) {
      throw new ReportException("INVALID_REPORT", "Report contains invalid Unicode.");
    }
    if (encoded.remaining() > MAX_REPORT_BYTES) {
      throw new ReportException("REPORT_TOO_LARGE", "Report exceeds the 1 MiB UTF-8 limit.");
    }
    byte[] bytes = new byte[encoded.remaining()];
    encoded.get(bytes);
    // JsonReader in strict mode rejects comments, trailing data, and JavaScript-like JSON extensions.
    // Traverse iteratively with a depth bound rather than recursively parsing a 1 MiB object.
    try (JsonReader reader = new JsonReader(new StringReader(json))) {
      reader.setLenient(false);
      if (reader.peek() != JsonToken.BEGIN_OBJECT) throw new IOException("Expected object");
      int depth = 0;
      do {
        switch (reader.peek()) {
          case BEGIN_OBJECT: reader.beginObject(); depth++; break;
          case BEGIN_ARRAY: reader.beginArray(); depth++; break;
          case END_OBJECT: reader.endObject(); depth--; break;
          case END_ARRAY: reader.endArray(); depth--; break;
          case NAME: reader.nextName(); break;
          case STRING:
          case NUMBER: reader.nextString(); break;
          case BOOLEAN: reader.nextBoolean(); break;
          case NULL: reader.nextNull(); break;
          default: throw new IOException("Incomplete object");
        }
        if (depth > 64) throw new IOException("Report nesting exceeds 64 levels");
      } while (depth > 0);
      if (reader.peek() != JsonToken.END_DOCUMENT) throw new IOException("Trailing content");
    } catch (IOException | RuntimeException malformed) {
      throw new ReportException("INVALID_REPORT", "Report must be a valid JSON object with at most 64 nesting levels.");
    }
    return bytes;
  }

  private static File writeReport(Context app, String id, byte[] bytes) throws IOException, ErrnoException {
    File cache = app.getCacheDir().getCanonicalFile();
    File directory = new File(cache, "embedding-reports");
    if (!directory.getCanonicalFile().equals(directory.getAbsoluteFile())) {
      throw new ReportException("UNSAFE_REPORT_PATH", "Report directory must not be a symbolic link.");
    }
    if (!directory.isDirectory() && !directory.mkdir()) throw new IOException("Cannot create report directory");
    if (!OsConstants.S_ISDIR(Os.lstat(directory.getPath()).st_mode)) {
      throw new ReportException("UNSAFE_REPORT_PATH", "Report storage is not a private directory.");
    }
    File file = new File(directory, "sam-embeddings-report-" + System.currentTimeMillis() + "-" + id + ".json");
    if (!file.createNewFile()) throw new IOException("Report filename already exists");
    try {
      checkReportFile(directory, file);
      try (FileOutputStream output = new FileOutputStream(file)) {
        output.write(bytes);
        output.getFD().sync();
      }
    } catch (IOException | ErrnoException failure) {
      // An incomplete file is never shared, even when a full cache prevents cleanup.
      if (file.getCanonicalFile().equals(file.getAbsoluteFile())) file.delete();
      throw failure;
    }
    File[] previous = directory.listFiles(candidate -> !candidate.equals(file) && candidate.getName().matches(REPORT_NAME));
    if (previous == null) throw new IOException("Cannot list report directory");
    for (File candidate : previous) checkReportFile(directory, candidate);
    Arrays.sort(previous, Comparator.comparingLong(File::lastModified).reversed().thenComparing(File::getName));
    for (int index = 9; index < previous.length; index++) {
      checkReportFile(directory, previous[index]);
      if (!previous[index].delete()) throw new IOException("Cannot remove old report");
    }
    return file;
  }

  private static void checkReportFile(File directory, File file) throws IOException, ErrnoException {
    if (!directory.getCanonicalFile().equals(directory.getAbsoluteFile())
        || !file.getParentFile().equals(directory)
        || !file.getCanonicalFile().equals(file.getAbsoluteFile())) {
      throw new ReportException("UNSAFE_REPORT_PATH", "Report must remain inside private report storage.");
    }
    StructStat stat = Os.lstat(file.getPath());
    if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_nlink != 1) {
      throw new ReportException("UNSAFE_REPORT_PATH", "Report is not a private regular file.");
    }
  }

  private static boolean reliable(String value) {
    return value != null && !value.trim().isEmpty() && !Build.UNKNOWN.equalsIgnoreCase(value);
  }
}
