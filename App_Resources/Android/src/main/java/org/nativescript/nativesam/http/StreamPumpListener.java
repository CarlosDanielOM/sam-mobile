package org.nativescript.nativesam.http;

public interface StreamPumpListener {
  void onBytes(byte[] chunk);

  void onEnd();

  void onError(String message);
}
