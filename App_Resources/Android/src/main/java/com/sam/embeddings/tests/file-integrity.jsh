// Run with jshell --class-path <compiled classes + Android/OkHttp/Kotlin/Okio jars> this-file.jsh.
// No Android methods are executed. Optional: -R-Dsam.fixture=/path/to/official/model.gguf.
import java.io.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import okhttp3.HttpUrl;

class InstallerChecks {
  interface Action { void run() throws Exception; }
  interface Observer { void accept(long bytes) throws IOException; }
  int passed;
  final Class<?> integrity = Class.forName("com.sam.embeddings.FileIntegrity");
  final Class<?> observerType = Class.forName("com.sam.embeddings.FileIntegrity$Observer");
  final Method verify = integrity.getDeclaredMethod("verify", File.class, long.class, String.class, observerType);
  final Class<?> installer = Class.forName("com.sam.embeddings.SamModelInstaller");
  final Method safeUrl = installer.getDeclaredMethod("safeUrl", HttpUrl.class);

  InstallerChecks() throws Exception {
    verify.setAccessible(true);
    safeUrl.setAccessible(true);
  }

  void check(boolean condition, String label) {
    if (!condition) throw new AssertionError(label);
    passed++;
  }

  void verify(File file, long size, String hash, Observer observer) throws Exception {
    Object proxy = java.lang.reflect.Proxy.newProxyInstance(observerType.getClassLoader(), new Class<?>[] {observerType},
        (target, method, args) -> { observer.accept((Long) args[0]); return null; });
    try {
      verify.invoke(null, file, size, hash, proxy);
    } catch (InvocationTargetException failure) {
      Throwable cause = failure.getCause();
      if (cause instanceof Exception) throw (Exception) cause;
      throw (Error) cause;
    }
  }

  void rejects(String code, Action action) throws Exception {
    try {
      action.run();
      throw new AssertionError("Expected " + code);
    } catch (IOException failure) {
      if (code.equals("cancelled")) check(code.equals(failure.getMessage()), code);
      else {
        Field field = failure.getClass().getDeclaredField("code");
        field.setAccessible(true);
        check(code.equals(field.get(failure)), "Expected " + code + ": " + failure);
      }
    }
  }

  String hash(byte[] bytes) throws Exception {
    StringBuilder text = new StringBuilder();
    for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) text.append(String.format("%02x", value & 255));
    return text.toString();
  }

  void run() throws Exception {
    Path path = Files.createTempFile("sam-integrity-", ".part");
    File file = path.toFile();
    String abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    try {
      Files.write(path, new byte[] {97, 98, 99});
      long[] progress = {-1};
      verify(file, 3, abcHash, bytes -> progress[0] = bytes);
      check(progress[0] == 3, "valid file and final progress");
      rejects("SIZE_MISMATCH", () -> verify(file, 4, abcHash, bytes -> {}));
      rejects("HASH_MISMATCH", () -> verify(file, 3, "0".repeat(64), bytes -> {}));
      Files.write(path, new byte[] {97, 98, 100});
      rejects("HASH_MISMATCH", () -> verify(file, 3, abcHash, bytes -> {}));
      Files.write(path, new byte[] {97, 98, 99});
      rejects("SIZE_MISMATCH", () -> verify(file, 3, abcHash, bytes -> {
        if (bytes == 0) Files.write(path, new byte[] {97, 98, 99, 100});
      }));
      Files.write(path, new byte[] {97, 98, 99});
      rejects("FILE_CHANGED", () -> verify(file, 3, abcHash, bytes -> {
        if (bytes == 0) Files.write(path, new byte[] {97, 98});
      }));
      byte[] large = new byte[400000];
      new Random(7).nextBytes(large);
      Files.write(path, large);
      int[] callbacks = {0};
      verify(file, large.length, hash(large), bytes -> callbacks[0]++);
      check(callbacks[0] >= 4, "streaming across multiple chunks");
      rejects("cancelled", () -> verify(file, large.length, hash(large), bytes -> {
        if (bytes > 0) throw new IOException("cancelled");
      }));
      Files.delete(path);
      rejects("SIZE_MISMATCH", () -> verify(file, 3, abcHash, bytes -> {}));
    } finally {
      Files.deleteIfExists(path);
    }
    for (String url : new String[] {"https://huggingface.co/repo/resolve/revision/file", "https://cdn-lfs.huggingface.co/file",
        "https://cas-bridge.xethub.hf.co/file?signature=test", "https://hf.co/file"}) {
      check((Boolean) safeUrl.invoke(null, HttpUrl.get(url)), "allowed " + url);
    }
    for (String url : new String[] {"http://huggingface.co/file", "https://huggingface.co.evil.example/file",
        "https://evilhf.co/file", "https://hf.co@evil.example/file", "https://user:password@huggingface.co/file",
        "https://huggingface.co:8443/file", "https://127.0.0.1/file", "https://unrelated.example/file"}) {
      check(!(Boolean) safeUrl.invoke(null, HttpUrl.get(url)), "rejected " + url);
    }
    for (String name : new String[] {"getStatus", "getInstalledModel", "getRequiredStorage", "getModelMetadata"}) {
      check(installer.getMethod(name).getReturnType() == String.class, name + " bridge signature");
    }
    for (String name : new String[] {"download", "cancelDownload", "verify", "install", "remove"}) {
      check(installer.getMethod(name).getReturnType() == void.class, name + " bridge signature");
    }
    check(Modifier.isStatic(installer.getMethod("getInstance", android.content.Context.class).getModifiers()), "singleton signature");
    Class<?> catalog = Class.forName("com.sam.embeddings.ModelCatalog");
    check(catalog.getField("EXPECTED_BYTES").getLong(null) == 379216640L, "official byte count");
    check(catalog.getField("SHA256").get(null).equals("6ec5f8e8750dbc8a0e40c431fd1b7b07a13688136b2244c5a1364b54d9032599"), "official digest");
    check(catalog.getField("REVISION").get(null).equals("a80de9c5b941d429104f0038292a0ef5a860e486"), "immutable revision");
    check((Boolean) safeUrl.invoke(null, HttpUrl.get((String) catalog.getField("DOWNLOAD_URL").get(null))), "official download URL allowed");
    check(catalog.getMethod("getModelMetadata").getReturnType() == String.class, "catalog JSON bridge signature");
    Method diagnostics = Class.forName("com.sam.embeddings.SamDeviceDiagnostics").getMethod("snapshot", android.content.Context.class);
    check(Modifier.isStatic(diagnostics.getModifiers()) && diagnostics.getReturnType() == String.class, "diagnostics JSON bridge signature");
    String fixture = System.getProperty("sam.fixture");
    if (fixture != null) {
      verify(new File(fixture), 379216640L, "6ec5f8e8750dbc8a0e40c431fd1b7b07a13688136b2244c5a1364b54d9032599", bytes -> {});
      check(true, "official full-size artifact");
    }
    System.out.println("PASS: " + passed + " installer integrity, redirect, and API checks");
  }
}

int testExitCode = 0;
try { new InstallerChecks().run(); } catch (Throwable failure) { failure.printStackTrace(); testExitCode = 1; }
/exit testExitCode
