#include "engine.h"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <cmath>
#include <future>
#include <iostream>
#include <thread>
#include <sys/resource.h>

static void require(bool ok, const char * message) {
    if (!ok) throw std::runtime_error(message);
}
static double dot(const sam::Embedding & a, const sam::Embedding & b) {
    double sum = 0;
    for (int i = 0; i < sam::dimensions; ++i) sum += double(a.vector[i]) * b.vector[i];
    return sum;
}
int main(int argc, char ** argv) {
    if (argc != 2) { std::cerr << "Usage: sam-host-smoke /tmp/opencode/...gguf\n"; return 2; }
    try {
        std::vector<std::string> allocation_logs;
        llama_log_set([](ggml_log_level level, const char * text, void * data) {
            if (level == GGML_LOG_LEVEL_ERROR) std::cerr << text;
            const std::string line(text);
            if (line.find("buffer size") != std::string::npos || line.find("size =") != std::string::npos)
                static_cast<std::vector<std::string> *>(data)->push_back(line);
        }, &allocation_logs);
        sam::Engine engine;
        engine.begin();
        const auto load_ms = engine.load(argv[1]);
        const auto limits = engine.batch_limits();
        require(limits.n_batch == 1024 && limits.n_ubatch == 1024 && limits.n_ctx == 4096 && limits.n_ctx_seq == 512,
                "Private sequence contexts do not have the fixed token budget");
        require(limits.max_parallel_sequences == std::min(8, limits.backend_max_parallel_sequences), "Sequence limit mismatch");
        const auto loaded_info = nlohmann::json::parse(engine.loaded_model_info());
        require(loaded_info["batchMode"] == "true_batch" && loaded_info["batchLimits"]["backendSequenceExecution"] == "serial_ubatches", "Untruthful model limits");
        require(engine.tokenize("What is panda?", "query") == std::vector<llama_token>({1,11582,535,3747,856,64192,540}), "Official BOS/prefix tokens differ");
        for (const std::string kind : {"query", "document"}) {
            const auto plain = engine.tokenize("What is panda?", kind);
            const auto literal = engine.tokenize(kind + ": What is panda?", kind);
            require(literal.size() == plain.size() + 2, "Literal user prefix was removed");
            for (const auto & raw : {kind + ":", kind + ": "}) {
                require(!engine.tokenize(raw, kind).empty(), "Prefix-like raw text was rejected");
            }
        }
        const auto special = engine.tokenize("<|startoftext|> hello <|endoftext|>", "query");
        require(std::count(special.begin(), special.end(), 1) == 1 && std::count(special.begin(), special.end(), 2) == 0, "User special tokens parsed");
        auto q = engine.embed("What is panda?", "query");
        auto hi = engine.embed("hi", "document");
        auto bear = engine.embed("it is a bear", "document");
        auto panda = engine.embed("The giant panda (Ailuropoda melanoleuca), sometimes called a panda bear or simply panda, is a bear species endemic to China.", "document");
        require(q.vector.size() == 1024 && std::abs(dot(q,q) - 1) < 1e-5, "Invalid dimensions or norm");
        require(!q.warm && panda.warm, "Warm flag incorrect");
        require(dot(q,panda) > dot(q,bear) && dot(q,bear) > dot(q,hi), "Retrieval ranking incorrect");
        require(std::abs(q.vector[0] - (-0.0278193)) < 0.001, "Does not match upstream CLI CLS embedding");
        auto repeated = engine.embed("What is panda?", "query");
        require(dot(q,repeated) > 0.99999, "State leaked between sequences");
        auto q_es = engine.embed(u8"\u00bfQu\u00e9 es un panda?", "query");
        const auto panda_es = engine.embed(u8"El panda gigante (Ailuropoda melanoleuca), tambi\u00e9n llamado oso panda, es una especie de oso originaria de China.", "document");
        const auto bicycle_en = engine.embed("A bicycle has two wheels and pedals and is used for transportation.", "document");
        const auto bicycle_es = engine.embed(u8"Una bicicleta tiene dos ruedas y pedales y se utiliza como medio de transporte.", "document");
        auto bilingual_scores = nlohmann::json::array();
        for (const auto * query : {&q, &q_es}) {
            const double en = dot(*query, panda);
            const double es = dot(*query, panda_es);
            const double unrelated_en = dot(*query, bicycle_en);
            const double unrelated_es = dot(*query, bicycle_es);
            require(std::min(en, es) > std::max(unrelated_en, unrelated_es), "English/Spanish cross-language retrieval ranking incorrect");
            bilingual_scores.push_back({en, es, unrelated_en, unrelated_es});
        }
        const auto unicode = std::string(u8"caf\u00e9 \u65e5\u672c\u8a9e \U0001f680 ") + '\0';
        const auto unicode_count = engine.tokenize(unicode, "query").size();
        require(engine.embed(unicode, "query").token_count == int(unicode_count), "Unicode token counts differ");
        std::string long_text;
        for (int i = 0; i < 600; ++i) long_text += " hello";
        const auto count = engine.tokenize(long_text, "document").size();
        require(count > 512, "Oversized tokenization was truncated");
        try { engine.embed(long_text, "document"); throw std::runtime_error("Oversized embedding accepted"); }
        catch (const sam::Error & e) { require(e.code == "INPUT_TOO_LONG" && e.actual_tokens == int(count), "Wrong oversized error"); }
        std::string boundary = "hello";
        for (int i = 0; i < 508; ++i) boundary += " hello";
        require(engine.embed(boundary, "document").token_count == 512, "Exact 512-token embedding failed");
        try { engine.embed(boundary + " hello", "document"); throw std::runtime_error("513-token embedding accepted"); }
        catch (const sam::Error & e) { require(e.code == "INPUT_TOO_LONG" && e.actual_tokens == 513, "Wrong 513-token error"); }
        for (const std::string kind : {"query", "document"}) {
            for (const auto & raw : {kind + ":", kind + ": ", kind + ": foo"}) {
                require(engine.embed(raw, kind).token_count == int(engine.tokenize(raw, kind).size()), "Literal prefix embedding/tokenization mismatch");
            }
        }
        const std::vector<std::string> docs{"hi", "it is a bear", unicode, "document: foo", "A bicycle has two wheels and pedals.", boundary};
        const auto baseline = engine.embed_batch(docs, "sequential", 100, 4096);
        require(baseline.decodes.size() == docs.size() && baseline.effective_batch_size == 1, "Sequential decode count incorrect");
        double minimum_cosine = 1;
        int cosine_failures = 0;
        auto compare = [&](const sam::BatchResult & batch) {
            require(batch.embeddings.size() == docs.size(), "Batch cardinality changed");
            int total = 0;
            for (size_t i = 0; i < docs.size(); ++i) {
                require(batch.embeddings[i].token_count == baseline.embeddings[i].token_count, "Batch order/token count changed");
                const double cosine = dot(batch.embeddings[i], baseline.embeddings[i]);
                minimum_cosine = std::min(minimum_cosine, cosine);
                if (cosine < 0.99999) {
                    std::cerr << "mode=" << batch.mode << " target=" << batch.requested_batch_size << " doc=" << i
                              << " cosine=" << dot(batch.embeddings[i], baseline.embeddings[i]) << '\n';
                    ++cosine_failures;
                }
                require(std::abs(dot(batch.embeddings[i], batch.embeddings[i]) - 1) < 1e-5, "Batch not normalized");
                total += batch.embeddings[i].token_count;
            }
            require(total == batch.total_tokens, "Total token metric incorrect");
            const auto response = nlohmann::json::parse(sam::batch_json(batch));
            for (const auto & e : response["embeddings"]) require(e["inferenceDurationMs"].is_null(), "Invented per-document latency");
            const auto & m = response["metrics"];
            require(m.size() == 13, "BatchMetrics schema differs");
            require(m["nativeDecodeCount"] == batch.decodes.size(), "Decode count metric incorrect");
            require(batch.total_elapsed_ms >= batch.native_decode_ms + batch.preparation_ms, "Overlapping phase metrics");
            require(std::abs(m["effectiveMsPerDocument"].get<double>() * docs.size() - batch.total_elapsed_ms) < 1e-6, "Amortized metric incorrect");
        };
        compare(baseline);
        sam::BatchResult packed;
        for (int repeat = 0; repeat < 3; ++repeat) {
            packed = engine.embed_batch(docs, "true_batch", 100, 4096);
            compare(packed);
            require(packed.decodes.size() == 1 && packed.decodes[0].sequences == int(docs.size()), "Not one multi-sequence llama_decode");
            auto seq_packed = engine.embed_batch(docs, "true_batch", 4, 4096);
            compare(seq_packed);
            require(seq_packed.decodes.size() == 2 && seq_packed.decodes[0].sequences == 4 && seq_packed.decodes[1].sequences == 2, "Partial sequence packing incorrect");
            auto token_packed = engine.embed_batch(docs, "true_batch", 100, 512);
            compare(token_packed);
            require(token_packed.decodes.size() == 2 && token_packed.decodes[0].sequences == 5 && token_packed.decodes[1].tokens == 512, "Token packing incorrect");
        }
        const auto singleton = nlohmann::json::parse(sam::batch_json(engine.embed_batch({"hi"}, "true_batch", 100, 4096)));
        require(singleton["embeddings"][0]["inferenceDurationMs"].get<double>() > 0, "Singleton latency is not actual");
        // Exercise the actual decode budget and the maximum sequence ID.
        const auto full = engine.embed_batch(std::vector<std::string>(9, boundary), "true_batch", 100, 4096);
        require(full.decodes.size() == 5 && full.decodes[0].tokens == 1024 && full.decodes[0].sequences == 2 && full.decodes.back().sequences == 1, "Reported decode budget packing incorrect");
        for (const auto & e : full.embeddings) require(dot(e, baseline.embeddings.back()) >= 0.99999, "Full-context sequence isolation failed");
        const auto many = engine.embed_batch(std::vector<std::string>(101, "hi"), "true_batch", 100, 4096);
        require(many.decodes.size() == 13 && many.decodes[0].sequences == 8 && many.decodes.back().sequences == 5, "Requested target was not capped at actual sequence capacity");
        for (const auto & e : many.embeddings) require(dot(e, hi) >= 0.99999, "High sequence ID isolation failed");
        std::vector<std::string> varied;
        for (int length : {4, 7, 17, 127, 255, 256, 257, 512}) {
            const std::string word = length % 2 ? "world" : "hello";
            std::string text = word;
            for (int i = 4; i < length; ++i) text += " " + word;
            require(engine.tokenize(text, "document").size() == size_t(length), "Variable-length fixture changed");
            varied.push_back(text);
        }
        const auto varied_baseline = engine.embed_batch(varied, "sequential", 100, 4096);
        std::vector<size_t> order{0, 1, 2, 3, 4, 5, 6, 7};
        for (int rotation = 0; rotation < 3; ++rotation) {
            std::vector<std::string> input;
            for (size_t i : order) input.push_back(varied[i]);
            const auto actual = engine.embed_batch(input, "true_batch", 100, 4096);
            for (size_t i = 0; i < order.size(); ++i) {
                const double cosine = dot(actual.embeddings[i], varied_baseline.embeddings[order[i]]);
                minimum_cosine = std::min(minimum_cosine, cosine);
                require(cosine >= 0.99999, "Private streams changed variable-length sequence embeddings");
            }
            if (rotation == 0) std::reverse(order.begin(), order.end());
            else std::rotate(order.begin(), order.begin() + 3, order.end());
        }
        int decode_attempts = 0;
        engine.test_hook = [&](const char * stage, size_t) { if (std::string(stage) == "before_decode") ++decode_attempts; };
        auto reject = [&](const std::vector<std::string> & input, const std::string & mode, int sequences, int tokens, const char * code) {
            try { engine.embed_batch(input, mode, sequences, tokens); throw std::runtime_error("Invalid batch accepted"); }
            catch (const sam::Error & e) { require(e.code == code, "Wrong batch validation error"); }
        };
        reject({}, "true_batch", 100, 4096, "EMPTY_INPUT");
        reject({"hi", " "}, "true_batch", 100, 4096, "EMPTY_INPUT");
        reject({"hi", long_text}, "true_batch", 100, 4096, "INPUT_TOO_LONG");
        reject({"hi", boundary}, "true_batch", 100, 511, "INVALID_ARGUMENT");
        reject({"hi"}, "true_batch", 100, 1, "INVALID_ARGUMENT");
        reject(std::vector<std::string>(1001, "hi"), "true_batch", 100, 4096, "INVALID_ARGUMENT");
        reject({"hi"}, "other", 100, 4096, "INVALID_ARGUMENT");
        for (int sequences : {-1, 0, 101}) reject({"hi"}, "true_batch", sequences, 4096, "INVALID_ARGUMENT");
        for (int tokens : {-1, 0, 4097}) reject({"hi"}, "true_batch", 100, tokens, "INVALID_ARGUMENT");
        require(decode_attempts == 0, "Validation decoded a partial request");
        for (int repeat = 0; repeat < 2; ++repeat) {
            for (const std::string stage : {"allocation", "after_decode", "before_decode", "cancel_after_decode"}) {
                engine.test_hook = [&](const char * point, size_t decode) {
                    if (decode != 1) return;
                    if (stage == "allocation" && stage == point) throw std::bad_alloc();
                    if (stage == "after_decode" && stage == point) throw sam::Error("INFERENCE_FAILED", "Injected post-decode failure");
                    if ((stage == "before_decode" && stage == point) || (stage == "cancel_after_decode" && std::string(point) == "after_decode")) engine.cancel();
                };
                bool failed = false;
                try { engine.embed_batch(docs, "true_batch", 2, 4096); }
                catch (const std::bad_alloc &) { failed = stage == "allocation"; }
                catch (const sam::Error & e) { failed = e.code == (stage == "after_decode" ? "INFERENCE_FAILED" : "CANCELLED"); }
                require(failed, "Injected failure did not fail atomically");
                engine.test_hook = {};
                engine.begin();
                compare(engine.embed_batch(docs, "true_batch", 100, 4096));
            }
        }
        engine.begin();
        std::promise<void> started;
        engine.test_hook = [&](const char * stage, size_t decode) {
            if (std::string(stage) == "before_decode" && decode == 0) started.set_value();
        };
        auto future = std::async(std::launch::async, [&] {
            try { engine.embed_batch(std::vector<std::string>(20, boundary), "true_batch", 100, 4096); return false; }
            catch (const sam::Error & e) { return e.code == "CANCELLED"; }
        });
        started.get_future().wait();
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        engine.cancel();
        require(future.get(), "Cooperative cancellation failed");
        engine.test_hook = {};
        engine.begin();
        require(dot(q, engine.embed("What is panda?", "query")) > 0.99999, "Abort left stale state");
        engine.load(argv[1]);
        engine.unload(); engine.unload();
        require(!engine.loaded(), "Unload failed");
        engine.begin(); engine.load(argv[1]);
        const auto cold_batch = engine.embed_batch({"hi", "it is a bear"}, "true_batch", 100, 4096);
        require(!cold_batch.embeddings[0].warm && !cold_batch.embeddings[1].warm, "First decode did not share cold warm state");
        require(engine.embed("What is panda?", "query").warm, "Successful batch did not warm context");
        engine.unload();
        require(!nlohmann::json::parse(engine.loaded_model_info()).contains("batchLimits"), "Unloaded limits leaked");
        struct rusage usage{};
        getrusage(RUSAGE_SELF, &usage);
        std::cout << nlohmann::json{{"status", cosine_failures ? "failed_cosine_tolerance" : "passed"}, {"loadDurationMs", load_ms},
            {"minimumBatchCosine", minimum_cosine}, {"cosineToleranceFailures", cosine_failures},
            {"batchMetrics", nlohmann::json::parse(sam::batch_json(packed))["metrics"]},
            {"fullContextDecodes", full.decodes.size()}, {"hundredDocumentDecodes", many.decodes.size()},
            {"peakRssKiB", usage.ru_maxrss}, {"allocationLogs", allocation_logs},
            {"dimensions", q.vector.size()}, {"norm", std::sqrt(dot(q,q))},
            {"scores", {dot(q,hi), dot(q,bear), dot(q,panda)}}, {"oversizedTokens", count},
            {"bilingualRanking", {{"queries", {"en", "es"}},
                {"documents", {"panda_en", "panda_es", "bicycle_en", "bicycle_es"}}, {"scores", bilingual_scores}}},
            {"unicodeTokens", unicode_count}}.dump() << '\n';
        require(cosine_failures == 0, "Batch cosine must be >= 0.99999 for every packing layout");
    } catch (const std::exception & e) { std::cerr << e.what() << '\n'; return 1; }
}
