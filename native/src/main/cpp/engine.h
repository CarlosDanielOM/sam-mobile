#pragma once
#include "llama.h"
#include <atomic>
#include <stdexcept>
#include <string>
#include <vector>
#ifndef __ANDROID__
#include <functional>
#endif

namespace sam {
constexpr int max_tokens = 512;
constexpr int dimensions = 1024;
constexpr int batch_tokens = 4096;
constexpr int batch_sequences = 100;
constexpr int max_documents = 1000;
struct Error : std::runtime_error {
    std::string code;
    int actual_tokens;
    Error(std::string code, std::string message, int actual = -1)
        : std::runtime_error(message), code(std::move(code)), actual_tokens(actual) {}
};
struct Embedding {
    std::vector<float> vector;
    int token_count;
    double duration_ms;
    bool warm;
};
struct BatchLimits {
    int n_batch, n_ubatch, n_ctx, n_ctx_seq, max_parallel_sequences, backend_max_parallel_sequences;
};
struct DecodeMetrics {
    int sequences, tokens;
    double native_decode_ms;
};
struct BatchResult {
    std::vector<Embedding> embeddings;
    std::string mode;
    int requested_batch_size, effective_batch_size = 0, total_tokens = 0;
    double total_elapsed_ms = 0, native_decode_ms = 0, preparation_ms = 0;
    BatchLimits limits;
    std::vector<DecodeMetrics> decodes;
};
// Except cancel(), all methods belong to the owning worker thread.
class Engine {
public:
    Engine();
    ~Engine();
    Engine(const Engine &) = delete;
    Engine & operator=(const Engine &) = delete;
    void begin() { cancelled.store(false); }
    void cancel() { cancelled.store(true); }
    void check_cancelled() const;
    double load(const std::string & path);
    void unload();
    std::vector<llama_token> tokenize(const std::string & text, const std::string & kind) const;
    Embedding embed(const std::string & text, const std::string & kind);
    BatchResult embed_batch(const std::vector<std::string> & texts, const std::string & mode,
                           int max_sequences, int max_batch_tokens);
    BatchLimits batch_limits() const;
    std::string loaded_model_info() const;
    bool loaded() const { return model != nullptr && context != nullptr; }
#ifndef __ANDROID__
    // Deterministic failure/cancellation injection, absent from Android builds.
    std::function<void(const char *, size_t)> test_hook;
#endif
private:
    BatchResult embed_impl(const std::vector<std::string> & texts, const std::string & kind,
                           const std::string & mode, int max_sequences, int max_batch_tokens);
    std::atomic<bool> cancelled{false};
    llama_model * model = nullptr;
    llama_context * context = nullptr;
    std::string path;
    bool warm = false;
    static bool abort(void * data);
    static bool progress(float, void * data);
};
std::string model_info();
std::string embedding_json(const Embedding & embedding, bool include_duration = true);
std::string batch_json(const BatchResult & result);
std::string error_json(const Error & error);
}
