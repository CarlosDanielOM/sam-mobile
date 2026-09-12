package org.nativescript.nativesam.http;

import java.io.InputStream;
import java.util.Arrays;
import okhttp3.Call;
import okhttp3.Response;
import okhttp3.ResponseBody;

public final class StreamPump {
  private StreamPump() {}

  public static void start(final Call call, final Response response, final StreamPumpListener listener) {
    Thread thread =
        new Thread(
            new Runnable() {
              @Override
              public void run() {
                pump(call, response, listener);
              }
            },
            "sam-http");
    thread.start();
  }

  static void pump(Call call, Response response, StreamPumpListener listener) {
    try {
      ResponseBody body = response.body();
      if (body == null) {
        listener.onEnd();
        return;
      }
      InputStream stream = body.byteStream();
      byte[] buf = new byte[8192];
      int n;
      while (!call.isCanceled()) {
        n = stream.read(buf);
        if (n < 0) {
          break;
        }
        if (n == 0) {
          continue;
        }
        listener.onBytes(Arrays.copyOf(buf, n));
      }
      listener.onEnd();
    } catch (Exception error) {
      String message = error.getMessage();
      listener.onError(message != null ? message : error.getClass().getName());
    } finally {
      try {
        response.close();
      } catch (Exception ignored) {
      }
    }
  }
}
