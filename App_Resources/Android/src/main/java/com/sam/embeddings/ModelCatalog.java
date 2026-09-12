package com.sam.embeddings;

import org.json.JSONException;
import org.json.JSONObject;

/** Pinned official artifact metadata; this catalog is independent of inference. */
public final class ModelCatalog {
  public static final String MODEL_ID = "LiquidAI/LFM2.5-Embedding-350M";
  public static final String REPOSITORY = "LiquidAI/LFM2.5-Embedding-350M-GGUF";
  public static final String REVISION = "a80de9c5b941d429104f0038292a0ef5a860e486";
  public static final String FILENAME = "LFM2.5-Embedding-350M-Q8_0.gguf";
  public static final long EXPECTED_BYTES = 379216640L;
  public static final String SHA256 =
      "6ec5f8e8750dbc8a0e40c431fd1b7b07a13688136b2244c5a1364b54d9032599";
  public static final String DOWNLOAD_URL =
      "https://huggingface.co/" + REPOSITORY + "/resolve/" + REVISION + "/" + FILENAME;
  public static final long HEADROOM_BYTES = 128L * 1024 * 1024;

  private ModelCatalog() {}

  public static String getModelMetadata() {
    return metadata().toString();
  }

  static JSONObject metadata() {
    JSONObject result = new JSONObject();
    put(result, "modelId", MODEL_ID);
    put(result, "repository", REPOSITORY);
    put(result, "revision", REVISION);
    put(result, "filename", FILENAME);
    put(result, "expectedBytes", EXPECTED_BYTES);
    put(result, "sha256", SHA256);
    put(result, "dimensions", 1024);
    put(result, "maxTokens", 512);
    put(result, "quantization", "Q8_0");
    put(result, "format", "GGUF");
    put(result, "downloadUrl", DOWNLOAD_URL);
    return result;
  }

  static void put(JSONObject object, String key, Object value) {
    try {
      object.put(key, value == null ? JSONObject.NULL : value);
    } catch (JSONException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
}
