package com.sam.embeddings

import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class SamEmbeddingEngineTest {
    private class FakeBackend : Backend {
        var loaded = false
        var failCreate = false
        var block = false
        var blockLoad = false
        @Volatile var aborted = false
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val destroyed = CountDownLatch(1)
        val calls = Collections.synchronizedList(mutableListOf<String>())
        val threads = Collections.synchronizedSet(mutableSetOf<Long>())
        var lastBytes = byteArrayOf()
        var lastBatch = emptyArray<ByteArray>()
        var lastMode = ""
        var lastSequences = 0
        var lastTokens = 0
        var failBatch = false
        private fun record(name: String) { calls.add(name); threads.add(Thread.currentThread().id) }
        override fun create(): Long {
            record("create")
            if (failCreate) throw UnsatisfiedLinkError("test missing library")
            return 1
        }
        override fun destroy(handle: Long) { record("destroy"); loaded = false; destroyed.countDown() }
        override fun begin(handle: Long) { record("begin"); aborted = false }
        override fun cancel(handle: Long) { aborted = true }
        override fun isLoaded(handle: Long): Boolean { record("isLoaded"); return loaded }
        override fun loadModel(handle: Long, path: ByteArray): String {
            record("load"); loaded = true; lastBytes = path
            if (blockLoad) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            return "{\"status\":\"completed\",\"result\":{\"modelInfo\":{\"batchMode\":\"true_batch\",\"batchLimits\":{\"nCtx\":4096}}}}"
        }
        override fun unloadModel(handle: Long): String {
            record("unload"); loaded = false
            return "{\"status\":\"completed\",\"result\":{\"unloaded\":true}}"
        }
        override fun embedQuery(handle: Long, text: ByteArray): String {
            record("query"); lastBytes = text
            if (block) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            return "{\"status\":\"completed\",\"result\":{\"tokenCount\":7}}"
        }
        override fun embedDocument(handle: Long, text: ByteArray): String {
            record("document"); return embedQuery(handle, text)
        }
        override fun embedBatch(handle: Long, texts: Array<ByteArray>, mode: ByteArray, maxSequences: Int, maxTokens: Int): String {
            record("batch"); lastBatch = texts; lastBytes = texts.last(); lastMode = mode.toString(Charsets.UTF_8)
            lastSequences = maxSequences; lastTokens = maxTokens
            if (block) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            if (failBatch) return "{\"status\":\"error\",\"error\":{\"code\":\"INFERENCE_FAILED\"}}"
            val embeddings = JSONArray()
            for (text in texts) embeddings.put(JSONObject().put("text", text.toString(Charsets.UTF_8)).put("inferenceDurationMs", JSONObject.NULL))
            return JSONObject().put("status", "completed").put("result", JSONObject().put("embeddings", embeddings)
                .put("metrics", JSONObject().put("mode", lastMode).put("requestedBatchSize", maxSequences))).toString()
        }
        override fun tokenize(handle: Long, text: ByteArray, kind: ByteArray): String {
            record("tokenize"); lastBytes = text
            return "{\"status\":\"completed\",\"result\":{\"tokenCount\":604}}"
        }
    }

    private fun await(engine: SamEmbeddingEngine, id: String): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadline) {
            val result = JSONObject(engine.poll(id))
            if (result.getString("status") != "pending") return result
            Thread.sleep(1)
        }
        error("Request did not finish")
    }

    @Test fun terminalResultsAreConsumedAndLifecycleIsSerial() {
        val backend = FakeBackend()
        val engine = SamEmbeddingEngine(backend)
        val load = engine.loadModel("/model.gguf")
        assertEquals("completed", await(engine, load).getString("status"))
        assertEquals("UNKNOWN_REQUEST", JSONObject(engine.poll(load)).getJSONObject("error").getString("code"))
        assertTrue(engine.isLoaded())
        assertEquals("ready", engine.getState())
        val batch = await(engine, engine.embedBatch(arrayOf("one", "two")))
        assertEquals(2, batch.getJSONArray("result").length())
        assertEquals(1, backend.calls.count { it == "batch" })
        assertFalse(backend.calls.contains("document"))
        await(engine, engine.unloadModel())
        await(engine, engine.unloadModel())
        assertFalse(engine.isLoaded())
        assertEquals("unloaded", engine.getState())
        engine.close(); engine.close()
        assertTrue(backend.destroyed.await(5, TimeUnit.SECONDS))
        assertEquals(1, backend.threads.size)
        assertEquals("ENGINE_CLOSED", await(engine, engine.embedQuery("hello")).getJSONObject("error").getString("code"))
    }

    @Test fun queuedAndActiveCancellationAreSafeAndReset() {
        val backend = FakeBackend()
        val engine = SamEmbeddingEngine(backend)
        try {
            await(engine, engine.loadModel("/model.gguf"))
            backend.block = true
            val active = engine.embedQuery("active")
            assertTrue(backend.entered.await(5, TimeUnit.SECONDS))
            val queued = engine.embedDocument("queued")
            engine.cancel(queued); engine.cancel(active)
            assertTrue(backend.aborted)
            assertEquals("pending", JSONObject(engine.poll(active)).getString("status"))
            backend.release.countDown()
            assertEquals("cancelled", await(engine, active).getString("status"))
            assertEquals("cancelled", await(engine, queued).getString("status"))
            assertFalse(backend.calls.contains("document"))
            backend.block = false
            assertEquals("completed", await(engine, engine.embedQuery("next")).getString("status"))
            assertFalse(backend.aborted)
        } finally { backend.release.countDown(); engine.close() }
    }

    @Test fun closeCancelsAndQueuesDestructionAfterInference() {
        val backend = FakeBackend().apply { block = true }
        val engine = SamEmbeddingEngine(backend)
        val active = engine.embedQuery("active")
        assertTrue(backend.entered.await(5, TimeUnit.SECONDS))
        val queued = engine.loadModel("/model.gguf")
        engine.close()
        assertEquals(1L, backend.destroyed.count)
        backend.release.countDown()
        assertEquals("cancelled", await(engine, active).getString("status"))
        assertEquals("cancelled", await(engine, queued).getString("status"))
        assertTrue(backend.destroyed.await(5, TimeUnit.SECONDS))
        assertFalse(backend.calls.contains("load"))
    }

    @Test fun unicodeUsesStandardUtf8AndInvalidTextIsStructured() {
        val backend = FakeBackend()
        SamEmbeddingEngine(backend).use { engine ->
            val text = "caf\u00e9 \u65e5\u672c\u8a9e \uD83D\uDE80 \u0000"
            await(engine, engine.embedQuery(text))
            assertArrayEquals(text.toByteArray(Charsets.UTF_8), backend.lastBytes)
            assertTrue(backend.lastBytes.contains(0))
            assertEquals("INVALID_ARGUMENT", await(engine, engine.embedQuery("\uD800")).getJSONObject("error").getString("code"))
            assertEquals("EMPTY_INPUT", await(engine, engine.embedQuery(" \n\u2003")).getJSONObject("error").getString("code"))
            assertEquals("EMPTY_INPUT", await(engine, engine.embedBatch(emptyArray())).getJSONObject("error").getString("code"))
            assertEquals("INVALID_ARGUMENT", await(engine, engine.tokenize("text", "chat")).getJSONObject("error").getString("code"))
            assertEquals("INVALID_PATH", await(engine, engine.loadModel("")).getJSONObject("error").getString("code"))
            assertEquals(604, await(engine, engine.tokenize("long text", "document")).getJSONObject("result").getInt("tokenCount"))
        }
    }

    @Test fun prefixLikeTextIsRawAndNeverEmpty() {
        val backend = FakeBackend()
        SamEmbeddingEngine(backend).use { engine ->
            for (kind in listOf("query", "document")) {
                for (text in listOf("$kind:", "$kind: ", "$kind: \u2003", "$kind: foo")) {
                    val id = if (kind == "query") engine.embedQuery(text) else engine.embedDocument(text)
                    assertEquals("completed", await(engine, id).getString("status"))
                    assertArrayEquals(text.toByteArray(Charsets.UTF_8), backend.lastBytes)
                    assertEquals("completed", await(engine, engine.tokenize(text, kind)).getString("status"))
                    assertArrayEquals(text.toByteArray(Charsets.UTF_8), backend.lastBytes)
                }
            }
            assertEquals("completed", await(engine, engine.embedBatch(arrayOf("document: "))).getString("status"))
            assertArrayEquals("document: ".toByteArray(Charsets.UTF_8), backend.lastBytes)
        }
    }

    @Test fun malformedPathSurrogatesAreRejectedBeforeBackendLoad() {
        val backend = FakeBackend()
        SamEmbeddingEngine(backend).use { engine ->
            for (path in listOf("/model\uD800", "/\uDC00.gguf", "/\uD800x.gguf")) {
                assertEquals("INVALID_PATH", await(engine, engine.loadModel(path)).getJSONObject("error").getString("code"))
                assertFalse(backend.calls.contains("load"))
            }
            val valid = "/caf\u00e9-\uD83D\uDE80.gguf"
            assertEquals("completed", await(engine, engine.loadModel(valid)).getString("status"))
            assertArrayEquals(valid.toByteArray(Charsets.UTF_8), backend.lastBytes)
        }
    }

    @Test fun nativeInitErrorIsTerminalAndRetryable() {
        val backend = FakeBackend().apply { failCreate = true }
        SamEmbeddingEngine(backend).use { engine ->
            assertEquals("NATIVE_INIT_FAILED", await(engine, engine.loadModel("/model.gguf")).getJSONObject("error").getString("code"))
            assertEquals("error", engine.getState())
            backend.failCreate = false
            assertEquals("completed", await(engine, engine.loadModel("/model.gguf")).getString("status"))
            assertEquals("ready", engine.getState())
        }
    }

    @Test fun cancelledActiveLoadDoesNotPublishAModel() {
        val backend = FakeBackend().apply { blockLoad = true }
        val engine = SamEmbeddingEngine(backend)
        try {
            val id = engine.loadModel("/model.gguf")
            assertTrue(backend.entered.await(5, TimeUnit.SECONDS))
            engine.cancel(id)
            backend.release.countDown()
            assertEquals("cancelled", await(engine, id).getString("status"))
            assertFalse(engine.isLoaded())
            assertEquals("unloaded", engine.getState())
            assertTrue(backend.calls.contains("unload"))
            backend.blockLoad = false
            assertEquals("completed", await(engine, engine.loadModel("/model.gguf")).getString("status"))
            assertTrue(engine.isLoaded())
        } finally { backend.release.countDown(); engine.close() }
    }

    @Test fun concurrentSubmittersUseOnlyOneWorker() {
        val backend = FakeBackend()
        SamEmbeddingEngine(backend).use { engine ->
            val ids = Collections.synchronizedList(mutableListOf<String>())
            val callers = (1..8).map {
                Thread { repeat(20) { ids.add(engine.embedQuery("hello")) } }.apply { start() }
            }
            callers.forEach { it.join() }
            ids.forEach { assertEquals("completed", await(engine, it).getString("status")) }
            assertEquals(1, backend.threads.size)
            assertEquals(160, backend.calls.count { it == "query" })
        }
    }

    @Test fun batchOptionsValidateUpfrontAndPreserveUtf8AndArraySnapshot() {
        val backend = FakeBackend().apply { blockLoad = true }
        val engine = SamEmbeddingEngine(backend)
        try {
            val load = engine.loadModel("/model.gguf")
            assertTrue(backend.entered.await(5, TimeUnit.SECONDS))
            val texts = arrayOf("document: ", "caf\u00e9 \uD83D\uDE80 \u0000")
            val expected = texts.copyOf()
            val id = engine.embedBatchWithOptions(texts, "true_batch", 7, 80)
            texts[0] = "mutated"
            backend.release.countDown()
            await(engine, load)
            val result = await(engine, id).getJSONObject("result")
            assertEquals(2, result.getJSONArray("embeddings").length())
            assertEquals("true_batch", result.getJSONObject("metrics").getString("mode"))
            expected.indices.forEach { assertArrayEquals(expected[it].toByteArray(Charsets.UTF_8), backend.lastBatch[it]) }
            assertEquals(7, backend.lastSequences); assertEquals(80, backend.lastTokens)
            for (mode in listOf("", "batch", "TRUE_BATCH"))
                assertEquals("INVALID_ARGUMENT", await(engine, engine.embedBatchWithOptions(arrayOf("hi"), mode, 1, 512)).getJSONObject("error").getString("code"))
            for (sequences in listOf(-1, 0, 101))
                assertEquals("INVALID_ARGUMENT", await(engine, engine.embedBatchWithOptions(arrayOf("hi"), "true_batch", sequences, 512)).getJSONObject("error").getString("code"))
            for (tokens in listOf(-1, 0, 4097))
                assertEquals("INVALID_ARGUMENT", await(engine, engine.embedBatchWithOptions(arrayOf("hi"), "true_batch", 1, tokens)).getJSONObject("error").getString("code"))
            assertEquals("EMPTY_INPUT", await(engine, engine.embedBatchWithOptions(emptyArray(), "true_batch", 1, 512)).getJSONObject("error").getString("code"))
            assertEquals("INVALID_ARGUMENT", await(engine, engine.embedBatch(Array(1001) { "hi" })).getJSONObject("error").getString("code"))
            assertEquals("INVALID_ARGUMENT", await(engine, engine.embedBatch(arrayOf("hi", "\uD800"))).getJSONObject("error").getString("code"))
            assertEquals("EMPTY_INPUT", await(engine, engine.embedBatch(arrayOf("hi", " "))).getJSONObject("error").getString("code"))
            assertEquals(1, backend.calls.count { it == "batch" })
            await(engine, engine.embedBatchWithOptions(arrayOf("hi"), "sequential", 100, 4096))
            assertEquals("sequential", backend.lastMode)
        } finally { backend.release.countDown(); engine.close() }
    }

    @Test fun batchCancellationFailureAndRecoveryPublishNoPartialResults() {
        val backend = FakeBackend().apply { block = true }
        val engine = SamEmbeddingEngine(backend)
        try {
            val active = engine.embedBatchWithOptions(arrayOf("one", "two"), "true_batch", 2, 512)
            assertTrue(backend.entered.await(5, TimeUnit.SECONDS))
            val queued = engine.embedBatch(arrayOf("queued"))
            engine.cancel(active); engine.cancel(queued)
            assertTrue(backend.aborted)
            backend.release.countDown()
            for (id in listOf(active, queued)) {
                val response = await(engine, id)
                assertEquals("cancelled", response.getString("status")); assertFalse(response.has("result"))
            }
            assertEquals(1, backend.calls.count { it == "batch" })
            backend.block = false; backend.failBatch = true
            for (id in listOf(engine.embedBatch(arrayOf("hi")), engine.embedBatchWithOptions(arrayOf("hi"), "true_batch", 1, 512))) {
                val response = await(engine, id)
                assertEquals("INFERENCE_FAILED", response.getJSONObject("error").getString("code")); assertFalse(response.has("result"))
            }
            backend.failBatch = false
            assertEquals("completed", await(engine, engine.embedBatch(arrayOf("recovered"))).getString("status"))
            assertFalse(backend.aborted)
        } finally { backend.release.countDown(); engine.close() }
    }

    @Test fun modelLimitsAreWorkerPublishedAndClearedOnUnload() {
        val backend = FakeBackend()
        val engine = SamEmbeddingEngine(backend)
        assertEquals("true_batch", JSONObject(engine.getModelInfo()).getString("batchMode"))
        assertFalse(JSONObject(engine.getModelInfo()).has("batchLimits"))
        await(engine, engine.loadModel("/model.gguf"))
        assertEquals(4096, JSONObject(engine.getModelInfo()).getJSONObject("batchLimits").getInt("nCtx"))
        val calls = backend.calls.size
        repeat(100) { engine.getModelInfo() }
        assertEquals(calls, backend.calls.size)
        await(engine, engine.loadModel(""))
        assertTrue(JSONObject(engine.getModelInfo()).has("batchLimits"))
        await(engine, engine.unloadModel())
        assertFalse(JSONObject(engine.getModelInfo()).has("batchLimits"))
        await(engine, engine.loadModel("/model.gguf"))
        engine.close()
        assertTrue(backend.destroyed.await(5, TimeUnit.SECONDS))
        // Destruction signals from inside the lifetime lock; polling acquires it.
        engine.poll("unknown")
        assertFalse(JSONObject(engine.getModelInfo()).has("batchLimits"))
    }
}
