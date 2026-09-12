#include "engine.h"
#include "gguf.h"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <memory>
#include <mutex>
#include <sys/stat.h>
#include <thread>

namespace sam {
using json = nlohmann::ordered_json;
using Clock = std::chrono::steady_clock;
static double elapsed(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
std::string model_info() {
    return json{{"modelId", "LiquidAI/LFM2.5-Embedding-350M"},
        {"revision", "a80de9c5b941d429104f0038292a0ef5a860e486"},
        {"quantization", "Q8_0"}, {"dimensions", dimensions}, {"maxTokens", max_tokens},
        {"backendRevision", "465e49b9cea78a68b9c244ffb48d0ee24a82873d"},
        {"batchMode", "true_batch"}}.dump();
}
static json limits_json(const BatchLimits & limits) {
    return {{"nBatch", limits.n_batch}, {"nUbatch", limits.n_ubatch},
        {"nCtx", limits.n_ctx}, {"nCtxSeq", limits.n_ctx_seq},
        {"maxParallelSequences", limits.max_parallel_sequences},
        {"backendMaxParallelSequences", limits.backend_max_parallel_sequences},
        {"backendSequenceExecution", "serial_ubatches"}};
}
BatchLimits Engine::batch_limits() const {
    if (!loaded()) throw Error("MODEL_NOT_LOADED", "Load a model first");
    return {int(llama_n_batch(context)), int(llama_n_ubatch(context)),
        int(llama_n_ctx(context)), int(llama_n_ctx_seq(context)),
        int(llama_n_seq_max(context)), int(llama_max_parallel_sequences())};
}
std::string Engine::loaded_model_info() const {
    auto result = json::parse(model_info());
    if (loaded()) result["batchLimits"] = limits_json(batch_limits());
    return result.dump();
}
std::string embedding_json(const Embedding & e, bool include_duration) {
    auto result = json::parse(model_info());
    result.erase("maxTokens"); result.erase("backendRevision"); result.erase("batchMode");
    result["vector"] = e.vector;
    result["tokenCount"] = e.token_count;
    result["inferenceDurationMs"] = include_duration ? json(e.duration_ms) : json(nullptr);
    result["warm"] = e.warm;
    return result.dump();
}
std::string batch_json(const BatchResult & r) {
    auto embeddings = json::array();
    for (const auto & e : r.embeddings) embeddings.push_back(json::parse(embedding_json(e, r.embeddings.size() == 1)));
    auto decodes = json::array();
    for (const auto & d : r.decodes) decodes.push_back({{"sequences", d.sequences}, {"tokens", d.tokens}, {"nativeDecodeMs", d.native_decode_ms}});
    return json{{"embeddings", embeddings}, {"metrics", {
        {"mode", r.mode}, {"requestedBatchSize", r.requested_batch_size},
        {"effectiveBatchSize", r.effective_batch_size}, {"nativeDecodeCount", r.decodes.size()},
        {"totalTokens", r.total_tokens}, {"totalElapsedMs", r.total_elapsed_ms},
        {"nativeDecodeMs", r.native_decode_ms}, {"preparationMs", r.preparation_ms},
        {"effectiveMsPerDocument", r.total_elapsed_ms / r.embeddings.size()},
        {"documentsPerSecond", r.total_elapsed_ms > 0 ? 1000.0 * r.embeddings.size() / r.total_elapsed_ms : 0},
        {"tokensPerSecond", r.total_elapsed_ms > 0 ? 1000.0 * r.total_tokens / r.total_elapsed_ms : 0},
        {"limits", limits_json(r.limits)}, {"decodes", decodes}}}}.dump();
}
std::string error_json(const Error & e) {
    json error{{"code", e.code}, {"message", e.what()}};
    if (e.actual_tokens >= 0) {
        error["actualTokens"] = e.actual_tokens;
        error["maxTokens"] = max_tokens;
    }
    return json{{"status", e.code == "CANCELLED" ? "cancelled" : "error"}, {"error", error}}.dump(-1, ' ', true);
}
Engine::Engine() {
    static std::once_flag once;
    // Backend registration is process-wide. Do not free it while other instances exist.
    std::call_once(once, [] { llama_backend_init(); });
}
Engine::~Engine() { unload(); }
bool Engine::abort(void * data) { return static_cast<Engine *>(data)->cancelled.load(); }
bool Engine::progress(float, void * data) { return !abort(data); }
void Engine::check_cancelled() const {
    if (cancelled.load()) throw Error("CANCELLED", "Request cancelled");
}
void Engine::unload() {
    if (context) llama_free(context);
    context = nullptr;
    if (model) llama_model_free(model);
    model = nullptr;
    path.clear();
    warm = false;
}
double Engine::load(const std::string & new_path) {
    const auto start = Clock::now();
    check_cancelled();
    struct stat st{};
    if (new_path.empty() || new_path.front() != '/' || new_path.find('\0') != std::string::npos ||
        stat(new_path.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) {
        throw Error("INVALID_PATH", "Model path must be an existing absolute regular file");
    }
    if (st.st_size != 379216640) throw Error("INVALID_MODEL", "Model file size does not match the official Q8_0 artifact");
    if (loaded() && path == new_path) return elapsed(start);
    std::unique_ptr<gguf_context, decltype(&gguf_free)> metadata(
        gguf_init_from_file(new_path.c_str(), {true, nullptr}), gguf_free);
    if (!metadata) throw Error("INVALID_MODEL", "Cannot parse GGUF metadata");
    auto * g = metadata.get();
    auto key = [g](const char * name, gguf_type type) {
        const auto id = gguf_find_key(g, name);
        if (id < 0 || gguf_get_kv_type(g, id) != type)
            throw Error("INVALID_MODEL", std::string("Missing or invalid GGUF metadata: ") + name);
        return id;
    };
    if (std::string(gguf_get_val_str(g, key("general.architecture", GGUF_TYPE_STRING))) != "lfm2" ||
        gguf_get_val_u32(g, key("lfm2.embedding_length", GGUF_TYPE_UINT32)) != dimensions ||
        gguf_get_val_bool(g, key("lfm2.attention.causal", GGUF_TYPE_BOOL)) ||
        gguf_get_val_u32(g, key("lfm2.pooling_type", GGUF_TYPE_UINT32)) != LLAMA_POOLING_TYPE_CLS ||
        gguf_get_val_u32(g, key("general.file_type", GGUF_TYPE_UINT32)) != LLAMA_FTYPE_MOSTLY_Q8_0 ||
        !gguf_get_val_bool(g, key("tokenizer.ggml.add_bos_token", GGUF_TYPE_BOOL)) ||
        gguf_get_val_bool(g, key("tokenizer.ggml.add_eos_token", GGUF_TYPE_BOOL))) {
        throw Error("INVALID_MODEL", "Expected lfm2, 1024 dimensions, noncausal CLS, Q8_0, BOS true and EOS false");
    }
    int q8_count = 0;
    int f32_count = 0;
    for (int64_t i = 0; i < gguf_get_n_tensors(g); ++i) {
        const auto type = gguf_get_tensor_type(g, i);
        if (type == GGML_TYPE_Q8_0) ++q8_count;
        else if (type == GGML_TYPE_F32) ++f32_count;
        else throw Error("INVALID_MODEL", "Unexpected tensor quantization in Q8_0 artifact");
    }
    if (q8_count != 93 || f32_count != 55)
        throw Error("INVALID_MODEL", "Tensor inventory does not match the official Q8_0 artifact");
    check_cancelled();
    // Validate first, then replace. Never hold two mutable contexts or two models.
    unload();
    try {
        auto mp = llama_model_default_params();
        mp.n_gpu_layers = 0;
        mp.progress_callback = progress;
        mp.progress_callback_user_data = this;
        model = llama_model_load_from_file(new_path.c_str(), mp);
        check_cancelled();
        if (!model) throw Error("MODEL_LOAD_FAILED", "llama.cpp could not load the model");
        const auto * vocab = llama_model_get_vocab(model);
        if (llama_model_n_embd_out(model) != dimensions || !llama_vocab_get_add_bos(vocab) ||
            llama_vocab_get_add_eos(vocab) || llama_vocab_bos(vocab) != 1)
            throw Error("INVALID_MODEL", "Unexpected output dimension or tokenizer configuration");
        auto cp = llama_context_default_params();
        // Bound allocation to eight private 512-token streams. Unified KV changes
        // attention reduction alignment with pack order and fails the cosine gate.
        cp.n_seq_max = std::min<size_t>(8, llama_max_parallel_sequences());
        cp.n_ctx = max_tokens * cp.n_seq_max;
        cp.n_batch = cp.n_ubatch = 1024;
        cp.kv_unified = false;
        cp.embeddings = true;
        cp.pooling_type = LLAMA_POOLING_TYPE_CLS;
        cp.attention_type = LLAMA_ATTENTION_TYPE_NON_CAUSAL;
        cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
        cp.offload_kqv = cp.op_offload = false;
        cp.n_threads = cp.n_threads_batch = std::max(1u, std::min(4u, std::thread::hardware_concurrency()));
        cp.abort_callback = abort;
        cp.abort_callback_data = this;
        context = llama_init_from_model(model, cp);
        check_cancelled();
        if (!context) throw Error("NATIVE_INIT_FAILED", "llama.cpp could not allocate the embedding context");
        path = new_path;
        return elapsed(start);
    } catch (...) { unload(); throw; }
}
std::vector<llama_token> Engine::tokenize(const std::string & text, const std::string & kind) const {
    check_cancelled();
    if (kind != "query" && kind != "document") throw Error("INVALID_ARGUMENT", "kind must be query or document");
    if (text.empty() || text.find_first_not_of(" \t\r\n\f\v") == std::string::npos)
        throw Error("EMPTY_INPUT", "Text must not be empty or whitespace only");
    if (!loaded()) throw Error("MODEL_NOT_LOADED", "Load a model first");
    const std::string input = kind + ": " + text;
    if (input.size() > static_cast<size_t>(std::numeric_limits<int32_t>::max() - 1))
        throw Error("INVALID_ARGUMENT", "Text is too large to tokenize");
    const auto * vocab = llama_model_get_vocab(model);
    int count = llama_tokenize(vocab, input.data(), input.size(), nullptr, 0, true, false);
    if (count == INT32_MIN) throw Error("TOKENIZATION_FAILED", "Token count overflow");
    if (count >= 0) throw Error("TOKENIZATION_FAILED", "Tokenizer returned no required buffer size");
    std::vector<llama_token> tokens(-count);
    count = llama_tokenize(vocab, input.data(), input.size(), tokens.data(), tokens.size(), true, false);
    if (count <= 0) throw Error("TOKENIZATION_FAILED", "Tokenizer failed");
    tokens.resize(count);
    check_cancelled();
    return tokens;
}
Embedding Engine::embed(const std::string & text, const std::string & kind) {
    return embed_impl({text}, kind, "sequential", 1, batch_tokens).embeddings.front();
}
BatchResult Engine::embed_batch(const std::vector<std::string> & texts, const std::string & mode,
                               int max_sequences, int max_batch_tokens) {
    return embed_impl(texts, "document", mode, max_sequences, max_batch_tokens);
}
BatchResult Engine::embed_impl(const std::vector<std::string> & texts, const std::string & kind,
                              const std::string & mode, int max_sequences, int max_batch_tokens) {
    const auto start = Clock::now();
    // Also clears on preparation, allocation, extraction and cancellation exceptions.
    struct MemoryGuard {
        llama_context * context;
        void clear() {
            if (!context) return;
            llama_synchronize(context);
            llama_memory_clear(llama_get_memory(context), true);
            context = nullptr;
        }
        ~MemoryGuard() { clear(); }
    } request_memory{context};
    check_cancelled();
    if ((mode != "sequential" && mode != "true_batch") || max_sequences < 1 || max_sequences > batch_sequences ||
        max_batch_tokens < 1 || max_batch_tokens > batch_tokens || texts.size() > max_documents)
        throw Error("INVALID_ARGUMENT", "Expected mode sequential|true_batch, maxSequences 1..100, maxTokens 1..4096, and at most 1000 documents");
    if (texts.empty()) throw Error("EMPTY_INPUT", "Batch must not be empty");
    BatchResult result;
    result.mode = mode;
    result.requested_batch_size = max_sequences;
    result.limits = batch_limits();
    const int token_limit = std::min({max_batch_tokens, result.limits.n_batch, result.limits.n_ubatch, result.limits.n_ctx});
    const int sequence_limit = mode == "sequential" ? 1 : std::min(max_sequences, result.limits.max_parallel_sequences);
    std::vector<std::vector<llama_token>> documents;
    documents.reserve(texts.size());
    for (const auto & text : texts) {
        auto tokens = tokenize(text, kind);
        if (tokens.size() > max_tokens) throw Error("INPUT_TOO_LONG", "Input exceeds 512 tokens including prefix and BOS", tokens.size());
        if (int(tokens.size()) > token_limit || int(tokens.size()) > result.limits.n_ctx_seq)
            throw Error("INVALID_ARGUMENT", "Document exceeds the requested or loaded token budget; inputs are never split or truncated");
        result.total_tokens += tokens.size();
        documents.push_back(std::move(tokens));
    }
    result.embeddings.reserve(texts.size());
    result.preparation_ms = elapsed(start);
    for (size_t first = 0; first < documents.size();) {
        check_cancelled();
        const auto preparation_start = Clock::now();
        size_t end = first;
        int token_count = 0;
        while (end < documents.size() && int(end - first) < sequence_limit &&
               token_count + int(documents[end].size()) <= token_limit) {
            token_count += documents[end++].size();
        }
        const auto inference_start = Clock::now();
        MemoryGuard decode_memory{context};
        llama_memory_clear(llama_get_memory(context), true);
#ifndef __ANDROID__
        if (test_hook) test_hook("allocation", result.decodes.size());
#endif
        // Own the official llama_batch buffers with RAII: allocation failures throw,
        // unlike llama_batch_init's unchecked per-token mallocs in the pinned backend.
        std::vector<llama_token> tokens(token_count);
        std::vector<llama_pos> positions(token_count);
        std::vector<int32_t> sequence_counts(token_count, 1);
        std::vector<llama_seq_id> sequence_ids(token_count);
        std::vector<llama_seq_id *> sequence_ptrs(token_count);
        std::vector<int8_t> outputs(token_count, true);
        int offset = 0;
        for (size_t doc = first; doc < end; ++doc) {
            for (size_t pos = 0; pos < documents[doc].size(); ++pos, ++offset) {
                tokens[offset] = documents[doc][pos];
                positions[offset] = pos;
                sequence_ids[offset] = doc - first;
                sequence_ptrs[offset] = &sequence_ids[offset];
            }
        }
        llama_batch batch{token_count, tokens.data(), nullptr, positions.data(), sequence_counts.data(), sequence_ptrs.data(), outputs.data()};
        result.preparation_ms += elapsed(preparation_start);
        check_cancelled();
#ifndef __ANDROID__
        if (test_hook) test_hook("before_decode", result.decodes.size());
#endif
        check_cancelled();
        const auto decode_start = Clock::now();
        const int rc = llama_decode(context, batch);
        llama_synchronize(context);
        const double decode_ms = elapsed(decode_start);
#ifndef __ANDROID__
        if (test_hook) test_hook("after_decode", result.decodes.size());
#endif
        check_cancelled();
        if (rc != 0) throw Error("INFERENCE_FAILED", "llama_decode failed with code " + std::to_string(rc));
        for (size_t doc = first; doc < end; ++doc) {
            const auto * data = llama_get_embeddings_seq(context, doc - first);
            if (!data) throw Error("INFERENCE_FAILED", "CLS embedding was not produced");
            Embedding embedding{{data, data + dimensions}, int(documents[doc].size()), 0, warm};
            double sum = 0;
            for (float v : embedding.vector) {
                if (!std::isfinite(v)) throw Error("INFERENCE_FAILED", "Embedding contains non-finite values");
                sum += static_cast<double>(v) * v;
            }
            if (!(sum > 0)) throw Error("INFERENCE_FAILED", "Embedding has zero norm");
            for (auto & v : embedding.vector) v /= std::sqrt(sum);
            if (texts.size() == 1) embedding.duration_ms = elapsed(inference_start);
            result.embeddings.push_back(std::move(embedding));
        }
        check_cancelled();
        const int sequences = end - first;
        result.decodes.push_back({sequences, token_count, decode_ms});
        result.native_decode_ms += decode_ms;
        result.effective_batch_size = std::max(result.effective_batch_size, sequences);
        warm = true;
        first = end;
    }
    check_cancelled();
    request_memory.clear();
    result.total_elapsed_ms = elapsed(start);
    return result;
}
}
