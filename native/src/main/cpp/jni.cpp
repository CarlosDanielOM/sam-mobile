#include "engine.h"
#include "nlohmann/json.hpp"
#include <jni.h>
#include <new>

using json = nlohmann::ordered_json;
static sam::Engine & engine(jlong handle) {
    if (!handle) throw sam::Error("NATIVE_INIT_FAILED", "Native engine is unavailable");
    return *reinterpret_cast<sam::Engine *>(handle);
}
static std::string utf8(JNIEnv * env, jbyteArray bytes) {
    if (!bytes) throw sam::Error("INVALID_ARGUMENT", "Expected UTF-8 bytes");
    const auto size = env->GetArrayLength(bytes);
    std::string result(size, '\0');
    env->GetByteArrayRegion(bytes, 0, size, reinterpret_cast<jbyte *>(result.data()));
    if (env->ExceptionCheck()) throw sam::Error("NATIVE_ERROR", "Cannot read UTF-8 bytes");
    return result;
}
template<class F> static jstring response(JNIEnv * env, F action) {
    std::string output;
    try { output = json{{"status", "completed"}, {"result", action()}}.dump(-1, ' ', true); }
    catch (const sam::Error & e) { output = sam::error_json(e); }
    catch (const std::bad_alloc &) { output = sam::error_json({"OUT_OF_MEMORY", "Native allocation failed"}); }
    catch (const std::exception & e) { output = sam::error_json({"NATIVE_ERROR", e.what()}); }
    catch (...) { output = sam::error_json({"NATIVE_ERROR", "Unknown native exception"}); }
    if (env->ExceptionCheck()) return nullptr;
    // All response JSON is ASCII-escaped. Text input never uses modified UTF-8.
    return env->NewStringUTF(output.c_str());
}
#define JNI_METHOD(name) Java_com_sam_embeddings_JniBackend_##name
extern "C" {
JNIEXPORT jlong JNICALL JNI_METHOD(nativeCreate)(JNIEnv *, jobject) {
    try { return reinterpret_cast<jlong>(new sam::Engine()); } catch (...) { return 0; }
}
JNIEXPORT void JNICALL JNI_METHOD(nativeDestroy)(JNIEnv *, jobject, jlong h) {
    delete reinterpret_cast<sam::Engine *>(h);
}
JNIEXPORT void JNICALL JNI_METHOD(nativeBegin)(JNIEnv *, jobject, jlong h) {
    if (h) reinterpret_cast<sam::Engine *>(h)->begin();
}
JNIEXPORT void JNICALL JNI_METHOD(nativeCancel)(JNIEnv *, jobject, jlong h) {
    if (h) reinterpret_cast<sam::Engine *>(h)->cancel();
}
JNIEXPORT jboolean JNICALL JNI_METHOD(nativeIsLoaded)(JNIEnv *, jobject, jlong h) {
    return h && reinterpret_cast<sam::Engine *>(h)->loaded();
}
JNIEXPORT jstring JNICALL JNI_METHOD(nativeLoadModel)(JNIEnv * env, jobject, jlong h, jbyteArray path) {
    return response(env, [&] {
        const auto duration = engine(h).load(utf8(env, path));
        return json{{"loadDurationMs", duration}, {"modelInfo", json::parse(engine(h).loaded_model_info())}};
    });
}
JNIEXPORT jstring JNICALL JNI_METHOD(nativeUnloadModel)(JNIEnv * env, jobject, jlong h) {
    return response(env, [&] { engine(h).unload(); return json{{"unloaded", true}}; });
}
JNIEXPORT jstring JNICALL JNI_METHOD(nativeEmbedQuery)(JNIEnv * env, jobject, jlong h, jbyteArray text) {
    return response(env, [&] { return json::parse(sam::embedding_json(engine(h).embed(utf8(env, text), "query"))); });
}
JNIEXPORT jstring JNICALL JNI_METHOD(nativeEmbedDocument)(JNIEnv * env, jobject, jlong h, jbyteArray text) {
    return response(env, [&] { return json::parse(sam::embedding_json(engine(h).embed(utf8(env, text), "document"))); });
}
JNIEXPORT jstring JNICALL JNI_METHOD(nativeEmbedBatch)(JNIEnv * env, jobject, jlong h, jobjectArray texts,
                                                      jbyteArray mode, jint max_sequences, jint max_tokens) {
    return response(env, [&] {
        if (!texts) throw sam::Error("INVALID_ARGUMENT", "Expected an array of UTF-8 documents");
        const auto count = env->GetArrayLength(texts);
        if (count > sam::max_documents) throw sam::Error("INVALID_ARGUMENT", "Batch exceeds 1000 documents");
        std::vector<std::string> documents;
        documents.reserve(count);
        for (jsize i = 0; i < count; ++i) {
            engine(h).check_cancelled();
            auto bytes = static_cast<jbyteArray>(env->GetObjectArrayElement(texts, i));
            try { documents.push_back(utf8(env, bytes)); }
            catch (...) { env->DeleteLocalRef(bytes); throw; }
            env->DeleteLocalRef(bytes);
        }
        return json::parse(sam::batch_json(engine(h).embed_batch(documents, utf8(env, mode), max_sequences, max_tokens)));
    });
}
JNIEXPORT jstring JNICALL JNI_METHOD(nativeTokenize)(JNIEnv * env, jobject, jlong h, jbyteArray text, jbyteArray kind) {
    return response(env, [&] { return json{{"tokenCount", engine(h).tokenize(utf8(env, text), utf8(env, kind)).size()}}; });
}
}
