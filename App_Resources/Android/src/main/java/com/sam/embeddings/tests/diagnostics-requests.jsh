// Put a JVM org.json jar BEFORE android.jar on the classpath. No Android framework methods run.
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;

class DiagnosticsChecks {
  int passed;
  final Class<?> diagnostics = Class.forName("com.sam.embeddings.SamDeviceDiagnostics");
  final Method begin = diagnostics.getDeclaredMethod("beginRequest", String.class);
  final Method complete = diagnostics.getDeclaredMethod("complete", String.class, JSONObject.class, String.class, String.class);
  final Method poll = diagnostics.getMethod("poll", String.class);
  final Method validate = diagnostics.getDeclaredMethod("validateReport", String.class);
  final Field registry = diagnostics.getDeclaredField("REQUESTS");

  DiagnosticsChecks() throws Exception {
    begin.setAccessible(true);
    complete.setAccessible(true);
    validate.setAccessible(true);
    registry.setAccessible(true);
  }

  void check(boolean condition, String label) {
    if (!condition) throw new AssertionError(label);
    passed++;
  }

  String begin(String operation) throws Exception { return (String) begin.invoke(null, operation); }
  JSONObject poll(String id) throws Exception { return new JSONObject((String) poll.invoke(null, id)); }
  void finish(String id) throws Exception { complete.invoke(null, id, new JSONObject().put("ok", true), null, null); }

  void expired(String id) throws Exception {
    Object request = ((Map<?, ?>) registry.get(null)).get(id);
    Field completed = request.getClass().getDeclaredField("completedNanos");
    completed.setAccessible(true);
    completed.setLong(request, System.nanoTime() - TimeUnit.MINUTES.toNanos(11));
  }

  void rejectsAdmission(String operation) throws Exception {
    try {
      begin(operation);
      throw new AssertionError("Expected request admission rejection");
    } catch (InvocationTargetException failure) {
      check(failure.getCause() instanceof IllegalStateException, "bounded admission");
    }
  }

  void rejectsReport(String text, String code) throws Exception {
    try {
      validate.invoke(null, text);
      throw new AssertionError("Expected report rejection");
    } catch (InvocationTargetException failure) {
      Field field = failure.getCause().getClass().getDeclaredField("code");
      field.setAccessible(true);
      check(code.equals(field.get(failure.getCause())), "report validation: " + code);
    }
  }

  void run() throws Exception {
    String first = begin("sample");
    String second = begin("sample");
    check(!first.equals(second) && first.length() == 36, "unique opaque IDs");
    JSONObject pending = poll(first);
    check(pending.getString("state").equals("pending") && pending.getString("operation").equals("sample"), "pending envelope");
    check(pending.isNull("result") && pending.isNull("error"), "pending has no result/error");
    check(poll(first).getString("state").equals("pending"), "pending poll is not destructive");
    finish(first);
    complete.invoke(null, first, null, "SHOULD_NOT_OVERWRITE", "duplicate completion");
    JSONObject result = poll(first);
    check(result.getString("state").equals("completed") && result.getJSONObject("result").getBoolean("ok"), "first completion wins");
    check(result.isNull("error"), "successful result has no error");
    check(poll(first).getJSONObject("error").getString("code").equals("UNKNOWN_REQUEST"), "terminal poll consumes result");
    complete.invoke(null, second, null, "DIAGNOSTICS_FAILED", "Unavailable");
    JSONObject failed = poll(second);
    check(failed.isNull("result") && failed.getJSONObject("error").getString("code").equals("DIAGNOSTICS_FAILED"), "terminal error envelope");
    check(poll(null).isNull("requestId"), "null ID handled");
    check(poll("x".repeat(1000)).isNull("requestId"), "oversized unknown ID not reflected");

    String share = begin("export_report");
    rejectsAdmission("export_report");
    String sample = begin("sample");
    check(poll(sample).getString("state").equals("pending"), "sample allowed while chooser is pending");
    finish(share);
    String nextShare = begin("export_report");
    for (String id : new String[] {share, sample, nextShare}) { finish(id); poll(id); }

    List<String> ids = new ArrayList<>();
    for (int i = 0; i < 16; i++) ids.add(begin("sample"));
    rejectsAdmission("sample");
    finish(ids.get(0));
    rejectsAdmission("sample");
    poll(ids.remove(0));
    ids.add(begin("sample"));
    check(ids.size() == 16, "consuming completion releases capacity");
    for (String id : ids) { finish(id); expired(id); }
    String fresh = begin("sample");
    check(((Map<?, ?>) registry.get(null)).size() == 1, "admission reclaims expired terminal results");
    finish(fresh);
    expired(fresh);
    check(poll(fresh).getJSONObject("error").getString("code").equals("UNKNOWN_REQUEST"), "poll enforces result expiry");

    String concurrent = begin("sample");
    finish(concurrent);
    ExecutorService readers = Executors.newFixedThreadPool(8);
    try {
      List<Callable<Boolean>> calls = new ArrayList<>();
      for (int i = 0; i < 8; i++) calls.add(() -> !poll(concurrent).isNull("result"));
      int winners = 0;
      for (Future<Boolean> answer : readers.invokeAll(calls)) if (answer.get()) winners++;
      check(winners == 1, "concurrent terminal polls consume exactly once");
    } finally { readers.shutdownNow(); }

    rejectsReport(null, "INVALID_REPORT");
    rejectsReport("x".repeat(1048577), "REPORT_TOO_LARGE");
    rejectsReport("\u20ac".repeat(400000), "REPORT_TOO_LARGE");
    rejectsReport("{\"invalid\":\"\ud800\"}", "INVALID_REPORT");
    Field filename = diagnostics.getDeclaredField("REPORT_NAME");
    filename.setAccessible(true);
    String pattern = (String) filename.get(null);
    String validName = "sam-embeddings-report-1788700000000-" + UUID.randomUUID() + ".json";
    check(validName.matches(pattern), "owned report filename recognized");
    check(!("../" + validName).matches(pattern) && !"unrelated.json".matches(pattern), "cleanup name scope");
    for (String name : new String[] {"snapshot", "sample"}) {
      Method method = diagnostics.getMethod(name, android.content.Context.class);
      check(Modifier.isStatic(method.getModifiers()) && method.getReturnType() == String.class, name + " signature");
    }
    Method export = diagnostics.getMethod("exportReport", android.content.Context.class, String.class);
    check(Modifier.isStatic(export.getModifiers()) && export.getReturnType() == String.class, "async export signature");
    check(Modifier.isStatic(poll.getModifiers()) && poll.getReturnType() == String.class, "poll signature");
    check(((Map<?, ?>) registry.get(null)).isEmpty(), "no results leak after polling");
    System.out.println("PASS: " + passed + " diagnostics polling, bounds, scope, and API checks");
  }
}

int testExitCode = 0;
try { new DiagnosticsChecks().run(); } catch (Throwable failure) { failure.printStackTrace(); testExitCode = 1; }
/exit testExitCode
