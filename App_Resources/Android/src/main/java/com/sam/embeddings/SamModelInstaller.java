package com.sam.embeddings;

import android.content.Context;
import android.os.StatFs;
import android.os.SystemClock;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONException;
import org.json.JSONObject;

/** Process-local, serial model installer. It never loads a model or calls an inference runtime. */
public final class SamModelInstaller {
  private static volatile SamModelInstaller instance;
  private final Context app;
  private final Object control = new Object();
  private final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> {
    Thread thread = new Thread(runnable, "sam-model-installer");
    thread.setPriority(Thread.NORM_PRIORITY - 1);
    return thread;
  });
  private volatile boolean busy = true;
  private volatile boolean cancelled;
  private volatile String operation = "recovery";
  private volatile Call activeCall;
  private volatile File directory;
  private volatile Installed installed;
  private volatile String status;
  private volatile long liveStartedMs = -1;
  private volatile long downloadStartedMs;
  private volatile long lastNetworkUpdateMs;

  // Everything below is confined to the serial worker; readers see immutable JSON snapshots.
  private File modelFile;
  private File partFile;
  private File metadataFile;
  private AtomicFile metadata;
  private OkHttpClient client;
  private String state = "verifying";
  private long downloadedBytes;
  private long verifiedBytes;
  private double recentSpeed;
  private JSONObject metrics = new JSONObject();
  private JSONObject attempt = new JSONObject();
  private JSONObject error;
  private JSONObject recoveryError;
  private long attemptStartedMs;
  private long lastPublishMs;
  private long lastPersistMs;
  private boolean finalized;

  private static final class Installed {
    final File file;
    final long modified;
    final StructStat identity;
    final StructStat parentIdentity;
    final String json;

    Installed(File file) throws ErrnoException {
      this.file = file;
      modified = file.lastModified();
      identity = Os.lstat(file.getPath());
      parentIdentity = Os.lstat(file.getParent());
      JSONObject value = new JSONObject();
      put(value, "path", file.getAbsolutePath());
      put(value, "model", ModelCatalog.metadata());
      put(value, "bytes", ModelCatalog.EXPECTED_BYTES);
      json = value.toString();
    }

    boolean unchanged() {
      try {
        StructStat parent = Os.lstat(file.getParent());
        return parent.st_ino == parentIdentity.st_ino && parent.st_dev == parentIdentity.st_dev
            && OsConstants.S_ISDIR(parent.st_mode) && sameIdentity(identity, Os.lstat(file.getPath()))
            && file.lastModified() == modified;
      } catch (ErrnoException unavailable) {
        return false;
      }
    }
  }

  private static final class InstallerException extends IOException {
    private static final long serialVersionUID = 1L;
    final String code;

    InstallerException(String code, String message) {
      super(message);
      this.code = code;
    }
  }

  private SamModelInstaller(Context application) {
    app = application;
    publish();
    worker.execute(() -> run("recovery"));
  }

  public static SamModelInstaller getInstance(Context context) {
    if (context == null || context.getApplicationContext() == null) {
      throw new IllegalArgumentException("An application context is required.");
    }
    SamModelInstaller value = instance;
    if (value == null) {
      synchronized (SamModelInstaller.class) {
        value = instance;
        if (value == null) instance = value = new SamModelInstaller(context.getApplicationContext());
      }
    }
    return value;
  }

  /** No model reads, directory scans, hashing, or network activity on the caller's thread. */
  public String getStatus() {
    String published;
    String currentOperation;
    boolean working;
    synchronized (control) {
      // Pair the snapshot with the busy flag before a worker can finish or a new command can start.
      published = status;
      working = busy;
      currentOperation = operation;
    }
    JSONObject value = parse(published);
    put(value, "availableStorageBytes", availableStorage());
    put(value, "busy", working);
    put(value, "operation", working ? currentOperation : null);
    long started = liveStartedMs;
    if (working && started >= 0) put(value, "elapsedMs", SystemClock.elapsedRealtime() - started);
    long networkStarted = downloadStartedMs;
    if (working && networkStarted > 0 && "downloading".equals(value.optString("state"))) {
      long duration = SystemClock.elapsedRealtime() - networkStarted;
      JSONObject current = value.optJSONObject("metrics").optJSONObject("lastAttempt");
      put(value, "averageBytesPerSecond", duration > 0 && current != null
          ? current.optLong("networkBytes") * 1000.0 / duration : 0);
    }
    if (!"downloading".equals(value.optString("state"))
        || SystemClock.elapsedRealtime() - lastNetworkUpdateMs > 2000) {
      put(value, "recentBytesPerSecond", 0);
    }
    Installed trusted = installed;
    if (trusted != null && !trusted.unchanged()) {
      put(value, "state", "invalid");
      put(value, "installedBytes", 0);
      put(value, "error", error("FILE_CHANGED", "Installed model changed; verify or download again."));
    }
    return value.toString();
  }

  public String getModelMetadata() {
    return ModelCatalog.getModelMetadata();
  }

  public String getInstalledModel() {
    Installed trusted = installed;
    return trusted != null && trusted.unchanged() ? trusted.json : "null";
  }

  /** Budget for a fresh download, without credit for a partial that will be discarded. */
  public String getRequiredStorage() {
    JSONObject value = new JSONObject();
    put(value, "availableBytes", availableStorage());
    put(value, "requiredBytes", ModelCatalog.EXPECTED_BYTES + ModelCatalog.HEADROOM_BYTES);
    put(value, "headroomBytes", ModelCatalog.HEADROOM_BYTES);
    return value.toString();
  }

  public void download() { submit("download"); }
  public void verify() { submit("verify"); }
  public void install() { submit("install"); }
  public void remove() { submit("remove"); }

  public void cancelDownload() {
    synchronized (control) {
      if (!busy || !"download".equals(operation)) return;
      cancelled = true;
      Call call = activeCall;
      if (call != null) call.cancel();
    }
  }

  private void submit(String requested) {
    synchronized (control) {
      // All busy commands are no-ops, including during startup recovery. Poll busy before retrying.
      if (busy) return;
      cancelled = false;
      busy = true;
      operation = requested;
      worker.execute(() -> run(requested));
    }
  }

  private void run(String requested) {
    boolean attemptBegun = false;
    attempt = new JSONObject();
    finalized = false;
    error = null;
    try {
      initializeFiles();
      if ("recovery".equals(requested)) restore();
      beginAttempt(requested);
      attemptBegun = true;
      persist();
      switch (requested) {
        case "recovery": recover(); break;
        case "download": downloadAndInstall(); break;
        case "verify": verifyFiles(false); break;
        case "install": verifyFiles(true); break;
        case "remove": removeFiles(); break;
        default: throw new IllegalStateException("Unknown operation");
      }
      put(attempt, "outcome", "success");
    } catch (Exception failure) {
      handleFailure(failure);
    } finally {
      activeCall = null;
      if (attemptBegun) {
        put(attempt, "completedAt", System.currentTimeMillis());
        put(attempt, "totalElapsedMs", SystemClock.elapsedRealtime() - attemptStartedMs);
        put(attempt, "availableStorageAfterBytes", availableStorage());
        put(metrics, "lastAttempt", attempt);
        if ("download".equals(requested)) put(metrics, "lastDownload", copy(attempt));
        if (finalized) put(metrics, "lastSuccessfulInstall", copy(attempt));
      }
      try {
        if (metadata != null) persist(false);
      } catch (Exception persistenceFailure) {
        // Never hide a persistence failure or revoke a hash-verified file just because metadata failed.
        JSONObject persistenceError = error("METADATA_IO", "Could not durably save installer metadata. Retry verification.");
        put(metrics, "lastPersistenceError", errorWithTime(persistenceError));
        if (error == null) error = persistenceError;
        put(metrics, "lastError", errorWithTime(error));
        if (attemptBegun && "success".equals(attempt.optString("outcome"))) {
          increment("failures");
          put(attempt, "outcome", "error");
          put(attempt, "error", error);
        }
        if (installed != null && installed.unchanged()) state = "installed";
        else if (!"invalid".equals(state)) state = "error";
      }
      liveStartedMs = -1;
      recentSpeed = 0;
      publish();
      synchronized (control) {
        busy = false;
        cancelled = false;
      }
    }
  }

  private void initializeFiles() throws IOException, ErrnoException {
    if (directory != null) {
      checkDirectory();
      return;
    }
    // Resolve Android's /data/data alias once, then reject symlinks beneath this trusted root.
    File root = app.getNoBackupFilesDir().getCanonicalFile();
    File target = new File(root, "models");
    if (!target.getCanonicalFile().equals(target.getAbsoluteFile())) {
      throw new InstallerException("UNSAFE_PATH", "Model directory must not be a symbolic link.");
    }
    if (!target.isDirectory() && !target.mkdir()) {
      throw new InstallerException("STORAGE_IO", "Could not create the private model directory.");
    }
    if (!OsConstants.S_ISDIR(Os.lstat(target.getPath()).st_mode)) {
      throw new InstallerException("UNSAFE_PATH", "Model storage is not a directory.");
    }
    modelFile = new File(target, ModelCatalog.FILENAME);
    partFile = new File(target, ModelCatalog.FILENAME + ".part");
    metadataFile = new File(target, "sam-embedding-install.json");
    metadata = new AtomicFile(metadataFile);
    directory = target;
    checkDirectory();
  }

  private void checkDirectory() throws IOException {
    File dir = directory;
    if (dir == null || !dir.getCanonicalFile().equals(dir.getAbsoluteFile()) || !dir.isDirectory()) {
      throw new InstallerException("UNSAFE_PATH", "Private model directory changed.");
    }
  }

  private StructStat checkFile(File file) throws IOException {
    checkDirectory();
    if (!file.getParentFile().equals(directory)
        || !file.getCanonicalFile().equals(file.getAbsoluteFile())) {
      throw new InstallerException("UNSAFE_PATH", "Installer file must remain in private model storage.");
    }
    try {
      StructStat stat = Os.lstat(file.getPath());
      if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_nlink != 1) {
        throw new InstallerException("UNSAFE_PATH", "Installer file is not a private regular file.");
      }
      return stat;
    } catch (ErrnoException failure) {
      if (failure.errno != OsConstants.ENOENT) throw new IOException("Could not inspect installer file.", failure);
      return null;
    }
  }

  private static boolean sameIdentity(StructStat first, StructStat second) {
    return first != null && second != null && first.st_ino == second.st_ino
        && first.st_dev == second.st_dev && first.st_size == second.st_size
        && first.st_mtime == second.st_mtime && first.st_ctime == second.st_ctime
        && OsConstants.S_ISREG(second.st_mode) && second.st_nlink == 1;
  }

  private void checkMetadata() throws IOException {
    checkFile(metadataFile);
    checkFile(new File(directory, metadataFile.getName() + ".bak"));
    checkFile(new File(directory, metadataFile.getName() + ".new"));
  }

  private void restore() throws IOException {
    checkMetadata();
    if (!metadataFile.exists() && !new File(directory, metadataFile.getName() + ".bak").exists()) {
      deleteOwned(new File(directory, metadataFile.getName() + ".new"));
      return;
    }
    try (FileInputStream input = metadata.openRead(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[4096];
      int count;
      while ((count = input.read(buffer)) != -1) {
        if (bytes.size() + count > 64 * 1024) throw new JSONException("Metadata is too large");
        bytes.write(buffer, 0, count);
      }
      JSONObject saved = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
      if (saved.optInt("schemaVersion") != 1 || !ModelCatalog.REVISION.equals(saved.optString("revision"))) {
        throw new JSONException("Unsupported metadata");
      }
      JSONObject savedMetrics = saved.optJSONObject("metrics");
      if (savedMetrics != null) metrics = savedMetrics;
      recoveryError = saved.optJSONObject("error");
      if (saved.optBoolean("active", false)) {
        increment("interrupted");
        JSONObject previous = metrics.optJSONObject("lastAttempt");
        if (previous != null) {
          put(previous, "outcome", "interrupted");
          put(metrics, "lastInterruptedAttempt", copy(previous));
          if ("download".equals(previous.optString("operation"))) {
            put(metrics, "lastDownload", copy(previous));
          }
        }
        recoveryError = error("INTERRUPTED", "Previous operation was interrupted by process exit.");
        put(metrics, "lastError", errorWithTime(recoveryError));
      }
    } catch (JSONException | IOException corrupt) {
      // Metadata is advisory only. Recovery still hashes any final model from scratch.
      put(metrics, "lastError", errorWithTime(error("METADATA_RECOVERED", "Installer metadata was unreadable; files will be rechecked.")));
    }
    deleteOwned(new File(directory, metadataFile.getName() + ".new"));
  }

  private void beginAttempt(String requested) throws IOException {
    checkFile(modelFile);
    checkFile(partFile);
    if (installed != null && !installed.unchanged()) installed = null;
    error = null;
    finalized = false;
    attempt = new JSONObject();
    attemptStartedMs = SystemClock.elapsedRealtime();
    liveStartedMs = attemptStartedMs;
    downloadStartedMs = 0;
    lastPublishMs = attemptStartedMs;
    lastPersistMs = attemptStartedMs;
    downloadedBytes = installed != null ? ModelCatalog.EXPECTED_BYTES
        : (partFile.exists() ? partFile.length() : modelFile.length());
    verifiedBytes = 0;
    recentSpeed = 0;
    put(attempt, "operation", requested);
    put(attempt, "startedAt", System.currentTimeMillis());
    put(attempt, "outcome", "running");
    put(attempt, "downloadDurationMs", 0);
    put(attempt, "verificationDurationMs", 0);
    put(attempt, "finalizationDurationMs", 0);
    put(attempt, "totalElapsedMs", 0);
    put(attempt, "networkBytes", 0);
    put(attempt, "averageBytesPerSecond", 0);
    put(attempt, "timeToFirstByteMs", null);
    put(attempt, "availableStorageBeforeBytes", availableStorage());
    put(attempt, "availableStorageAfterBytes", null);
    put(metrics, "lastAttempt", attempt);
    for (String key : new String[] {"downloadAttempts", "verificationAttempts", "installAttempts",
        "removeAttempts", "failures", "cancelled", "interrupted"}) {
      if (!metrics.has(key)) put(metrics, key, 0);
    }
    if ("download".equals(requested)) increment("downloadAttempts");
    if ("install".equals(requested)) increment("installAttempts");
    if ("remove".equals(requested)) increment("removeAttempts");
    state = "download".equals(requested) ? "downloading" : "verifying";
    publish();
  }

  private void recover() throws IOException, ErrnoException {
    if (acceptExistingFinal()) return;
    if (partFile.exists()) {
      downloadedBytes = partFile.length();
      if (downloadedBytes > ModelCatalog.EXPECTED_BYTES) {
        throw new FileIntegrity.InvalidFileException("SIZE_MISMATCH", "Interrupted partial exceeds the official artifact size.");
      }
      state = "partial";
      error = recoveryError;
    } else if (modelFile.exists()) {
      throw new FileIntegrity.InvalidFileException("HASH_MISMATCH", "Existing model failed integrity verification.");
    } else {
      state = "not_installed";
      error = recoveryError;
    }
  }

  /** Only a previously verified, unchanged final can bypass hashing in this process. */
  private boolean acceptExistingFinal() throws IOException, ErrnoException {
    checkFile(modelFile);
    if (!modelFile.exists()) {
      installed = null;
      return false;
    }
    if (installed == null || !installed.unchanged()) {
      installed = null;
      try {
        verifyArtifact(modelFile);
      } catch (FileIntegrity.InvalidFileException invalid) {
        put(metrics, "lastError", errorWithTime(error(invalid.code, invalid.getMessage())));
        return false;
      }
      installed = new Installed(modelFile);
    }
    state = "installed";
    downloadedBytes = ModelCatalog.EXPECTED_BYTES;
    deleteOwned(partFile);
    return true;
  }

  private void verifyFiles(boolean finalizePart) throws IOException, ErrnoException {
    // Explicit verify always rehashes; install/download are idempotent for a trusted installation.
    if (!finalizePart) installed = null;
    if (acceptExistingFinal()) return;
    if (!partFile.exists()) {
      if (modelFile.exists()) {
        throw new FileIntegrity.InvalidFileException("HASH_MISMATCH", "Existing model failed integrity verification.");
      }
      throw new InstallerException("NO_MODEL", "No installed model or partial is available.");
    }
    downloadedBytes = partFile.length();
    StructStat verified = verifyArtifact(partFile);
    if (finalizePart) finalizePartial(verified);
    else state = "partial";
  }

  private void downloadAndInstall() throws IOException, ErrnoException {
    checkCancelled();
    if (acceptExistingFinal()) return;
    // No Range or If-Range is sent: a retry truncates only our partial, never the final artifact.
    deleteOwned(partFile);
    downloadedBytes = 0;
    requireStorage(ModelCatalog.EXPECTED_BYTES + ModelCatalog.HEADROOM_BYTES);
    state = "downloading";
    persist();
    publish();
    if (client == null) {
      client = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
          .retryOnConnectionFailure(false).connectTimeout(30, TimeUnit.SECONDS)
          .readTimeout(60, TimeUnit.SECONDS).build();
    }
    downloadStartedMs = SystemClock.elapsedRealtime();
    long sampleTime = downloadStartedMs;
    long sampleBytes = 0;
    try (Response response = openResponse()) {
      ResponseBody body = response.body();
      if (response.code() != 200 || body == null || response.header("Content-Range") != null) {
        throw new InstallerException("HTTP_ERROR", "Expected a complete HTTP 200 response (received " + response.code() + ").");
      }
      String encoding = response.header("Content-Encoding");
      if (encoding != null && !"identity".equalsIgnoreCase(encoding)) {
        throw new InstallerException("HTTP_ENCODING", "Compressed HTTP transfer is not accepted for this artifact.");
      }
      if (body.contentLength() != -1 && body.contentLength() != ModelCatalog.EXPECTED_BYTES) {
        throw new InstallerException("HTTP_SIZE", "HTTP content length does not match the official artifact.");
      }
      checkFile(partFile);
      try (InputStream input = body.byteStream(); FileOutputStream output = new FileOutputStream(partFile, false)) {
        byte[] buffer = new byte[128 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) {
          checkCancelled();
          if (count == 0) continue;
          if (attempt.isNull("timeToFirstByteMs")) {
            put(attempt, "timeToFirstByteMs", SystemClock.elapsedRealtime() - downloadStartedMs);
          }
          if (count > ModelCatalog.EXPECTED_BYTES - downloadedBytes) {
            throw new FileIntegrity.InvalidFileException("SIZE_MISMATCH", "Download exceeds the official artifact size.");
          }
          output.write(buffer, 0, count);
          downloadedBytes += count;
          put(attempt, "networkBytes", downloadedBytes);
          long now = SystemClock.elapsedRealtime();
          lastNetworkUpdateMs = now;
          if (now - sampleTime >= 500) {
            recentSpeed = (downloadedBytes - sampleBytes) * 1000.0 / (now - sampleTime);
            sampleTime = now;
            sampleBytes = downloadedBytes;
          }
          updateDownloadMetrics();
          if (now - lastPersistMs >= 2000) {
            requireStorage(ModelCatalog.EXPECTED_BYTES - downloadedBytes + ModelCatalog.HEADROOM_BYTES);
          }
          checkpoint();
        }
        checkCancelled();
        if (downloadedBytes != ModelCatalog.EXPECTED_BYTES) {
          throw new InstallerException("DOWNLOAD_INCOMPLETE", "Connection ended before the complete artifact arrived.");
        }
        output.getFD().sync();
      }
    } finally {
      updateDownloadMetrics();
      downloadStartedMs = 0;
      activeCall = null;
      recentSpeed = 0;
    }
    StructStat verified = verifyArtifact(partFile);
    finalizePartial(verified);
  }

  private Response openResponse() throws IOException {
    HttpUrl url = HttpUrl.get(ModelCatalog.DOWNLOAD_URL);
    for (int redirects = 0; redirects <= 5; redirects++) {
      checkCancelled();
      if (!safeUrl(url)) {
        throw new InstallerException("UNSAFE_REDIRECT", "Only HTTPS redirects to official Hugging Face hosts are accepted.");
      }
      Request request = new Request.Builder().url(url).header("Accept-Encoding", "identity")
          .header("User-Agent", "SAM-ModelInstaller/1").get().build();
      Call call = client.newCall(request);
      activeCall = call;
      checkCancelled();
      Response response = call.execute();
      int code = response.code();
      if (code != 301 && code != 302 && code != 303 && code != 307 && code != 308) return response;
      String location = response.header("Location");
      HttpUrl next = location == null ? null : url.resolve(location);
      response.close();
      if (next == null || !safeUrl(next)) {
        throw new InstallerException("UNSAFE_REDIRECT", "Download redirect was missing or outside the HTTPS host allowlist.");
      }
      url = next;
    }
    throw new InstallerException("TOO_MANY_REDIRECTS", "Download exceeded five redirects.");
  }

  static boolean safeUrl(HttpUrl url) {
    String host = url.host();
    return url.isHttps() && url.port() == 443 && url.username().isEmpty() && url.password().isEmpty()
        && (host.equals("huggingface.co") || host.endsWith(".huggingface.co")
            || host.equals("hf.co") || host.endsWith(".hf.co"));
  }

  private StructStat verifyArtifact(File file) throws IOException {
    checkCancelled();
    StructStat before = checkFile(file);
    state = "verifying";
    verifiedBytes = 0;
    increment("verificationAttempts");
    long started = SystemClock.elapsedRealtime();
    long previousDuration = attempt.optLong("verificationDurationMs");
    boolean valid = false;
    publish();
    persist();
    try {
      FileIntegrity.verify(file, ModelCatalog.EXPECTED_BYTES, ModelCatalog.SHA256, bytes -> {
        checkCancelled();
        verifiedBytes = bytes;
        put(attempt, "verificationDurationMs", previousDuration + SystemClock.elapsedRealtime() - started);
        checkpoint();
      });
      StructStat after = checkFile(file);
      if (!sameIdentity(before, after)) {
        throw new FileIntegrity.InvalidFileException("FILE_CHANGED", "Model file was replaced during verification.");
      }
      valid = true;
      return after;
    } finally {
      long duration = SystemClock.elapsedRealtime() - started;
      put(attempt, "verificationDurationMs", previousDuration + duration);
      JSONObject verification = new JSONObject();
      put(verification, "durationMs", duration);
      put(verification, "bytes", verifiedBytes);
      put(verification, "valid", valid);
      put(verification, "source", file.equals(modelFile) ? "installed" : "partial");
      put(verification, "timestamp", System.currentTimeMillis());
      put(metrics, "lastVerification", verification);
    }
  }

  private void finalizePartial(StructStat verified) throws IOException, ErrnoException {
    checkCancelled();
    long started = SystemClock.elapsedRealtime();
    state = "installing";
    publish();
    try {
      persist();
      if (!sameIdentity(verified, checkFile(partFile))) {
        throw new FileIntegrity.InvalidFileException("FILE_CHANGED", "Partial changed after verification; it was not installed.");
      }
      checkFile(modelFile);
      requireStorage(ModelCatalog.HEADROOM_BYTES);
      try (RandomAccessFile file = new RandomAccessFile(partFile, "rw")) {
        file.getFD().sync();
      }
      checkCancelled();
      // Same-directory POSIX rename is atomic. A good final has already returned idempotently.
      // After this commit point cancellation does not roll back the verified installation.
      Os.rename(partFile.getPath(), modelFile.getPath());
      syncDirectory();
      installed = new Installed(modelFile);
      state = "installed";
      downloadedBytes = ModelCatalog.EXPECTED_BYTES;
      persist();
      finalized = true;
    } finally {
      put(attempt, "finalizationDurationMs", SystemClock.elapsedRealtime() - started);
    }
  }

  private void removeFiles() throws IOException, ErrnoException {
    // The caller must unload inference first. Do not delete the models directory or other files.
    installed = null;
    deleteOwned(modelFile);
    deleteOwned(partFile);
    deleteOwned(new File(directory, metadataFile.getName() + ".new"));
    syncDirectory();
    downloadedBytes = 0;
    verifiedBytes = 0;
    state = "not_installed";
  }

  private void deleteOwned(File file) throws IOException {
    checkFile(file);
    if (file.exists() && !file.delete()) {
      throw new InstallerException("DELETE_FAILED", "Could not remove an installer-owned file; retry the operation.");
    }
  }

  private void syncDirectory() throws ErrnoException {
    FileDescriptor descriptor = Os.open(directory.getPath(), OsConstants.O_RDONLY, 0);
    try {
      if (!OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode)) {
        throw new ErrnoException("sync model directory", OsConstants.ENOTDIR);
      }
      Os.fsync(descriptor);
    } finally {
      Os.close(descriptor);
    }
  }

  private void checkCancelled() throws InstallerException {
    if (cancelled && "download".equals(operation)) {
      throw new InstallerException("CANCELLED", "Download cancelled. Any partial is uninstalled and will restart on retry.");
    }
  }

  private void requireStorage(long required) throws InstallerException {
    long available = availableStorage();
    if (available < 0) throw new InstallerException("STORAGE_UNAVAILABLE", "Available private storage could not be measured.");
    if (available < required) throw new InstallerException("INSUFFICIENT_STORAGE", "Not enough private storage including the 128 MiB safety headroom.");
  }

  private long availableStorage() {
    File dir = directory;
    if (dir == null) return -1;
    try {
      return new StatFs(dir.getPath()).getAvailableBytes();
    } catch (RuntimeException unavailable) {
      return -1;
    }
  }

  private void updateDownloadMetrics() {
    if (downloadStartedMs == 0) return;
    long duration = SystemClock.elapsedRealtime() - downloadStartedMs;
    put(attempt, "downloadDurationMs", duration);
    put(attempt, "averageBytesPerSecond", duration > 0 ? attempt.optLong("networkBytes") * 1000.0 / duration : 0);
  }

  private void checkpoint() throws IOException {
    long now = SystemClock.elapsedRealtime();
    put(attempt, "totalElapsedMs", now - attemptStartedMs);
    if (now - lastPublishMs >= 250) {
      publish();
      lastPublishMs = now;
    }
    if (now - lastPersistMs >= 2000) {
      persist();
      lastPersistMs = now;
    }
  }

  private void handleFailure(Exception failure) {
    String code;
    String message;
    if ((failure instanceof InstallerException && "CANCELLED".equals(((InstallerException) failure).code))
        || (cancelled && "download".equals(operation) && installed == null)) {
      code = "CANCELLED";
      message = "Download cancelled. Partial data is not installed; retry restarts safely.";
      increment("cancelled");
      put(attempt, "outcome", "cancelled");
    } else {
      increment("failures");
      put(attempt, "outcome", "error");
      if (failure instanceof FileIntegrity.InvalidFileException) {
        code = ((FileIntegrity.InvalidFileException) failure).code;
        message = failure.getMessage();
      } else if (failure instanceof InstallerException) {
        code = ((InstallerException) failure).code;
        message = failure.getMessage();
      } else {
        code = "downloading".equals(state) ? "NETWORK_IO" : "STORAGE_IO";
        // Exception strings can contain signed CDN URLs. Never expose or persist them.
        message = "Model operation failed due to an I/O error. Check connectivity and private storage, then retry.";
      }
    }
    error = error(code, message);
    put(attempt, "error", error);
    put(metrics, "lastError", errorWithTime(error));
    if (installed != null && installed.unchanged()) {
      state = "installed";
    } else if (failure instanceof FileIntegrity.InvalidFileException || "UNSAFE_PATH".equals(code)) {
      installed = null;
      state = "invalid";
    } else {
      installed = null;
      downloadedBytes = partFile == null ? 0 : partFile.length();
      state = downloadedBytes > 0 ? "partial" : "error";
      if ("NO_MODEL".equals(code) || ("CANCELLED".equals(code) && downloadedBytes == 0)) {
        state = "not_installed";
      }
    }
  }

  private void persist() throws IOException { persist(true); }

  private void persist(boolean active) throws IOException {
    checkMetadata();
    JSONObject saved = new JSONObject();
    put(saved, "schemaVersion", 1);
    put(saved, "revision", ModelCatalog.REVISION);
    put(saved, "active", active);
    put(saved, "state", state);
    put(saved, "downloadedBytes", downloadedBytes);
    put(saved, "metrics", metrics);
    put(saved, "error", error);
    put(saved, "installed", installed == null ? null : parse(installed.json));
    byte[] bytes = saved.toString().getBytes(StandardCharsets.UTF_8);
    FileOutputStream output = null;
    try {
      output = metadata.startWrite();
      output.write(bytes);
      output.getFD().sync();
      metadata.finishWrite(output);
      output = null;
      // AtomicFile logs some rename failures instead of throwing. Confirm the committed bytes.
      checkMetadata();
      try (FileInputStream input = new FileInputStream(metadataFile)) {
        byte[] actual = new byte[bytes.length];
        int offset = 0;
        while (offset < actual.length) {
          int count = input.read(actual, offset, actual.length - offset);
          if (count < 0) break;
          offset += count;
        }
        if (offset != bytes.length || input.read() != -1 || !java.util.Arrays.equals(bytes, actual)
            || new File(directory, metadataFile.getName() + ".new").exists()
            || new File(directory, metadataFile.getName() + ".bak").exists()) {
          throw new IOException("Atomic metadata commit did not complete.");
        }
      }
      syncDirectory();
    } catch (IOException | ErrnoException failure) {
      if (output != null) metadata.failWrite(output);
      throw new InstallerException("METADATA_IO", "Could not durably save installer metadata.");
    }
  }

  private void publish() {
    JSONObject value = new JSONObject();
    put(value, "state", state);
    put(value, "downloadedBytes", downloadedBytes);
    put(value, "expectedBytes", ModelCatalog.EXPECTED_BYTES);
    put(value, "progressPercent", Math.min(100.0, downloadedBytes * 100.0 / ModelCatalog.EXPECTED_BYTES));
    put(value, "verifiedBytes", verifiedBytes);
    put(value, "verificationProgressPercent", Math.min(100.0, verifiedBytes * 100.0 / ModelCatalog.EXPECTED_BYTES));
    put(value, "elapsedMs", liveStartedMs >= 0 ? SystemClock.elapsedRealtime() - liveStartedMs : attempt.optLong("totalElapsedMs"));
    put(value, "recentBytesPerSecond", recentSpeed);
    put(value, "averageBytesPerSecond", attempt.optDouble("averageBytesPerSecond", 0));
    put(value, "availableStorageBytes", -1);
    put(value, "installedBytes", installed == null ? 0 : ModelCatalog.EXPECTED_BYTES);
    put(value, "model", ModelCatalog.metadata());
    put(value, "metrics", metrics);
    if (error != null) put(value, "error", error);
    status = value.toString();
  }

  private void increment(String key) {
    put(metrics, key, Math.max(0, metrics.optLong(key)) + 1);
  }

  private static JSONObject error(String code, String message) {
    JSONObject value = new JSONObject();
    put(value, "code", code);
    put(value, "message", message);
    return value;
  }

  private static JSONObject errorWithTime(JSONObject error) {
    JSONObject value = copy(error);
    put(value, "timestamp", System.currentTimeMillis());
    return value;
  }

  private static JSONObject copy(JSONObject value) { return parse(value.toString()); }

  private static JSONObject parse(String value) {
    try {
      return new JSONObject(value);
    } catch (JSONException impossible) {
      throw new IllegalStateException(impossible);
    }
  }

  private static void put(JSONObject object, String key, Object value) {
    ModelCatalog.put(object, key, value);
  }
}
