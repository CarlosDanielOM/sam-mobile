package com.sam.embeddings;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Pure Java streaming integrity check, also exercised by tests/file-integrity.jsh. */
final class FileIntegrity {
  interface Observer {
    void onBytes(long bytes) throws IOException;
  }

  static final class InvalidFileException extends IOException {
    private static final long serialVersionUID = 1L;
    final String code;

    InvalidFileException(String code, String message) {
      super(message);
      this.code = code;
    }
  }

  private FileIntegrity() {}

  static void verify(File file, long expectedBytes, String expectedHash, Observer observer)
      throws IOException {
    if (!file.isFile() || file.length() != expectedBytes) {
      throw new InvalidFileException("SIZE_MISMATCH", "Model size does not match the official artifact.");
    }
    long modified = file.lastModified();
    MessageDigest digest;
    try {
      digest = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
    long bytes = 0;
    byte[] buffer = new byte[128 * 1024];
    observer.onBytes(0);
    try (FileInputStream input = new FileInputStream(file)) {
      int count;
      while ((count = input.read(buffer)) != -1) {
        bytes += count;
        if (bytes > expectedBytes) {
          throw new InvalidFileException("SIZE_MISMATCH", "Model grew during verification.");
        }
        digest.update(buffer, 0, count);
        observer.onBytes(bytes);
      }
    }
    StringBuilder actual = new StringBuilder(64);
    for (byte value : digest.digest()) {
      actual.append(Character.forDigit((value & 255) >>> 4, 16));
      actual.append(Character.forDigit(value & 15, 16));
    }
    if (bytes != expectedBytes || file.length() != expectedBytes || file.lastModified() != modified) {
      throw new InvalidFileException("FILE_CHANGED", "Model changed during verification.");
    }
    if (!actual.toString().equals(expectedHash)) {
      throw new InvalidFileException("HASH_MISMATCH", "Model SHA-256 does not match the official artifact.");
    }
  }
}
