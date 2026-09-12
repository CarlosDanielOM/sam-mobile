#include "llama.h"
#include "ggml-backend.h"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::ordered_json;
using Vector = std::vector<float>;
static double cosine(const Vector & a, const Vector & b) {
    double ab = 0, aa = 0, bb = 0;
    for (size_t i = 0; i < a.size(); ++i) { ab += double(a[i])*b[i]; aa += double(a[i])*a[i]; bb += double(b[i])*b[i]; }
    return ab / std::sqrt(aa*bb);
}
struct Trace {
    bool enabled = false;
    size_t kv_offset = 0;
    size_t next_offset = 0;
    std::vector<size_t> kv_offsets;
    double masked_probability_max = 0;
    std::vector<std::pair<std::string, Vector>> rows;
    static bool callback(ggml_tensor * tensor, bool ask, void * data) {
        auto & trace = *static_cast<Trace *>(data);
        const std::string name(tensor->name);
        const bool attention = (name == "kq-2" || name == "kq_soft_max-2") && tensor->ne[1] == 512;
        const bool selected = trace.enabled && tensor->type == GGML_TYPE_F32 &&
            (attention || (tensor->ne[0] == 1024 && tensor->ne[1] == 512 && tensor->ne[2] == 1));
        if (ask) return selected;
        if (selected) {
            if (name == "model.embed_tokens") trace.kv_offset = trace.kv_offsets.at(trace.next_offset++);
            if (attention) {
                Vector values(512 * 512 * tensor->ne[2]);
                Vector row(tensor->ne[0]);
                for (int64_t head = 0; head < tensor->ne[2]; ++head)
                    for (size_t token = 0; token < 512; ++token) {
                        ggml_backend_tensor_get(tensor, row.data(), head*tensor->nb[2] + token*tensor->nb[1], row.size()*sizeof(float));
                        std::copy_n(row.data() + trace.kv_offset, 512, values.data() + (head*512 + token)*512);
                        if (name == "kq_soft_max-2")
                            for (size_t j = 0; j < row.size(); ++j)
                                if (j < trace.kv_offset || j >= trace.kv_offset + 512)
                                    trace.masked_probability_max = std::max(trace.masked_probability_max, std::abs(double(row[j])));
                    }
                trace.rows.emplace_back(name, std::move(values));
                return true;
            }
            const bool full = name == "l_out-0" || name == "l_out-1" || name == "l_out-2" || name == "kqv_out-2";
            Vector row(full ? ggml_nelements(tensor) : 1024);
            ggml_backend_tensor_get(tensor, row.data(), 0, row.size()*sizeof(float));
            trace.rows.emplace_back(tensor->name, std::move(row));
        }
        return true;
    }
};
int main(int argc, char ** argv) {
    if (argc < 2) return 2;
    try {
        const std::string variant = argc > 2 ? argv[2] : "default";
        llama_log_set([](ggml_log_level level, const char * text, void *) {
            if (level == GGML_LOG_LEVEL_ERROR) std::cerr << text;
        }, nullptr);
        llama_backend_init();
        auto mp = llama_model_default_params(); mp.n_gpu_layers = 0;
        std::unique_ptr<llama_model, decltype(&llama_model_free)> model(llama_model_load_from_file(argv[1], mp), llama_model_free);
        if (!model) throw std::runtime_error("Model load failed");
        Trace trace;
        auto cp = llama_context_default_params();
        cp.n_ctx = cp.n_batch = cp.n_ubatch = 1024;
        cp.n_seq_max = 100; cp.kv_unified = true;
        cp.embeddings = true; cp.pooling_type = LLAMA_POOLING_TYPE_CLS;
        cp.attention_type = LLAMA_ATTENTION_TYPE_NON_CAUSAL;
        cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
        cp.offload_kqv = cp.op_offload = false;
        cp.n_threads = cp.n_threads_batch = 4;
        if (variant == "trace") { cp.cb_eval = Trace::callback; cp.cb_eval_user_data = &trace; }
        if (variant == "one_thread") cp.n_threads = cp.n_threads_batch = 1;
        if (variant == "perf") cp.no_perf = false;
        if (variant == "op_offload") cp.op_offload = true;
        if (variant == "separate_kv") { cp.kv_unified = false; cp.n_seq_max = 2; }
        if (variant == "separate_kv_8") { cp.kv_unified = false; cp.n_seq_max = 8; cp.n_ctx = 4096; }
        std::unique_ptr<llama_context, decltype(&llama_free)> context(llama_init_from_model(model.get(), cp), llama_free);
        if (!context) throw std::runtime_error("Context allocation failed");
        if (variant == "warmup") llama_set_warmup(context.get(), true);
        std::string kind = "document";
        auto tokenize = [&](const std::string & text) {
            const auto * vocab = llama_model_get_vocab(model.get());
            const std::string input = kind + ": " + text;
            int n = -llama_tokenize(vocab, input.data(), input.size(), nullptr, 0, true, false);
            if (n < 1) throw std::runtime_error("Tokenization failed");
            std::vector<llama_token> tokens(n);
            if (llama_tokenize(vocab, input.data(), input.size(), tokens.data(), n, true, false) != n)
                throw std::runtime_error("Tokenization count changed");
            return tokens;
        };
        auto decode = [&](const std::vector<std::pair<std::string, int>> & documents) {
            trace.kv_offsets.clear(); trace.next_offset = 0; trace.masked_probability_max = 0;
            std::vector<llama_token> tokens;
            std::vector<llama_pos> positions;
            std::vector<llama_seq_id> ids;
            for (const auto & [text, id] : documents) {
                const auto input = tokenize(text);
                if (input.size() == 512) trace.kv_offsets.push_back(cp.kv_unified ? tokens.size() : 0);
                for (size_t i = 0; i < input.size(); ++i) { tokens.push_back(input[i]); positions.push_back(i); ids.push_back(id); }
            }
            std::vector<int32_t> counts(tokens.size(), 1);
            std::vector<int8_t> outputs(tokens.size(), 1);
            std::vector<llama_seq_id *> pointers;
            for (auto & id : ids) pointers.push_back(&id);
            llama_batch batch{int(tokens.size()), tokens.data(), nullptr, positions.data(), counts.data(), pointers.data(), outputs.data()};
            llama_memory_clear(llama_get_memory(context.get()), true);
            trace.rows.clear();
            const int rc = llama_decode(context.get(), batch);
            llama_synchronize(context.get());
            if (rc) throw std::runtime_error("Decode failed: " + std::to_string(rc));
            std::vector<Vector> vectors;
            for (const auto & doc : documents) {
                const auto * data = llama_get_embeddings_seq(context.get(), doc.second);
                if (!data) throw std::runtime_error("No sequence embedding");
                vectors.emplace_back(data, data + 1024);
            }
            llama_memory_clear(llama_get_memory(context.get()), true);
            return vectors;
        };
        std::string boundary = "hello";
        for (int i = 0; i < 508; ++i) boundary += " hello";
        const std::string bicycle = "A bicycle has two wheels and pedals.";
        trace.enabled = variant == "trace";
        const auto reference = decode({{boundary, 0}})[0];
        const auto reference_trace = trace.rows;
        const std::vector<std::string> singles{boundary, bicycle, "What is panda?", "document: foo",
            std::string(u8"caf\u00e9 \u65e5\u672c\u8a9e \U0001f680 ") + '\0'};
        std::vector<Vector> current_singles;
        for (const std::string input_kind : {"query", "document"}) {
            kind = input_kind;
            for (const auto & text : singles) current_singles.push_back(decode({{text, 0}})[0]);
        }
        auto selected_context = std::move(context);
        auto legacy_cp = cp;
        legacy_cp.n_ctx = legacy_cp.n_batch = legacy_cp.n_ubatch = 512;
        legacy_cp.n_seq_max = 1; legacy_cp.kv_unified = false;
        legacy_cp.cb_eval = nullptr; legacy_cp.cb_eval_user_data = nullptr;
        context.reset(llama_init_from_model(model.get(), legacy_cp));
        if (!context) throw std::runtime_error("Legacy context allocation failed");
        double singleton_difference = 0;
        size_t index = 0;
        for (const std::string input_kind : {"query", "document"}) {
            kind = input_kind;
            for (const auto & text : singles) {
                const auto legacy = decode({{text, 0}})[0];
                for (size_t i = 0; i < legacy.size(); ++i)
                    singleton_difference = std::max(singleton_difference, std::abs(double(legacy[i])-current_singles[index][i]));
                ++index;
            }
        }
        context = std::move(selected_context);
        kind = "document";
        json results = json::array();
        auto test = [&](const char * label, const std::vector<std::pair<std::string, int>> & docs, size_t target) {
            const auto actual = decode(docs)[target];
            double max_error = 0;
            for (size_t i = 0; i < actual.size(); ++i) max_error = std::max(max_error, std::abs(double(reference[i])-actual[i]));
            results.push_back({{"case", label}, {"cosine", cosine(reference, actual)}, {"maxRawDifference", max_error}});
            if (trace.enabled && std::string(label) == "bicycle_before") {
                json changes = json::array();
                for (size_t i = 0; i < std::min(reference_trace.size(), trace.rows.size()); ++i) {
                    const auto & a = reference_trace[i]; const auto & b = trace.rows[i];
                    double max_diff = 0;
                    for (size_t j = 0; j < a.second.size(); ++j) max_diff = std::max(max_diff, std::abs(double(a.second[j])-b.second[j]));
                    if ((max_diff || a.first == "kq-2" || a.first == "kq_soft_max-2") && changes.size() < 12)
                        changes.push_back({{"name", a.first}, {"actualName", b.first}, {"elements", a.second.size()}, {"maxRawDifference", max_diff}});
                }
                results.back()["trace"] = changes;
                results.back()["maskedProbabilityMax"] = trace.masked_probability_max;
            }
        };
        test("singleton_id_1", {{boundary, 1}}, 0);
        if (cp.n_seq_max > 99) test("singleton_id_99", {{boundary, 99}}, 0);
        test("singleton_max_id", {{boundary, int(cp.n_seq_max - 1)}}, 0);
        test("bicycle_before", {{bicycle, 0}, {boundary, 1}}, 1);
        test("bicycle_before_reversed_ids", {{bicycle, 1}, {boundary, 0}}, 1);
        test("bicycle_after", {{boundary, 0}, {bicycle, 1}}, 0);
        test("same_length_same_content", {{boundary, 0}, {boundary, 1}}, 1);
        if (variant == "default" || !cp.kv_unified) {
            std::string other = "world";
            for (int i = 0; i < 508; ++i) other += " world";
            test("same_length_other_content", {{other, 0}, {boundary, 1}}, 1);
            for (int length : {4, 8, 12, 13, 14, 15, 16, 17, 20, 24, 32}) {
                std::string prefix = "hello";
                while (int(tokenize(prefix).size()) < length) prefix += " hello";
                test(("prefix_tokens_" + std::to_string(tokenize(prefix).size())).c_str(), {{prefix, 0}, {boundary, 1}}, 1);
            }
        }
        test("singleton_after_all", {{boundary, 0}}, 0);
        const bool passed = std::all_of(results.begin(), results.end(), [](const json & r) { return r["cosine"].get<double>() >= 0.99999; });
        std::cout << json{{"variant", variant}, {"meetsCosineTolerance", passed}, {"legacySingletonMaxRawDifference", singleton_difference},
            {"bicycleTokens", tokenize(bicycle).size()}, {"boundaryTokens", tokenize(boundary).size()}, {"results", results}}.dump() << '\n';
        if (!cp.kv_unified && (!passed || singleton_difference != 0))
            throw std::runtime_error("Private KV must preserve original singleton values and meet cosine >= 0.99999");
    } catch (const std::exception & e) { std::cerr << e.what() << '\n'; return 1; }
}
