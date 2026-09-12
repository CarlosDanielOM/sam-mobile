package com.sam.embeddings

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.sqrt

@RunWith(AndroidJUnit4::class)
class SamEmbeddingEngineInstrumentedTest {
    private fun await(engine: SamEmbeddingEngine, id: String): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(3)
        while (System.nanoTime() < deadline) {
            val result = JSONObject(engine.poll(id))
            if (result.getString("status") != "pending") return result
            Thread.sleep(10)
        }
        error("Native request timed out")
    }

    @Test fun jniLoadsAndInvalidPathsReturnErrors() {
        SamEmbeddingEngine().use { engine ->
            assertEquals("true_batch", JSONObject(engine.getModelInfo()).getString("batchMode"))
            assertFalse(JSONObject(engine.getModelInfo()).has("batchLimits"))
            val response = await(engine, engine.loadModel("/does-not-exist/model.gguf"))
            assertEquals("INVALID_PATH", response.getJSONObject("error").getString("code"))
            for (path in listOf("/model\uD800", "/\uDC00.gguf")) {
                assertEquals("INVALID_PATH", await(engine, engine.loadModel(path)).getJSONObject("error").getString("code"))
            }
            assertFalse(engine.isLoaded())
            assertEquals("MODEL_NOT_LOADED", await(engine, engine.embedQuery("hello")).getJSONObject("error").getString("code"))
            assertEquals("completed", await(engine, engine.unloadModel()).getString("status"))
            assertEquals("INVALID_ARGUMENT", await(engine, engine.embedBatchWithOptions(arrayOf("hi"), "bad", 1, 512)).getJSONObject("error").getString("code"))
        }
    }

    @Test fun suppliedPrivateModelEmbedsAndRecoversAfterCancellation() {
        val path = InstrumentationRegistry.getArguments().getString("modelPath")
        assumeTrue("Supply -e modelPath with an existing app-private official GGUF", path != null)
        val file = File(path!!)
        assertTrue(file.isFile)
        assertEquals(379216640L, file.length())
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(1024 * 1024)
            while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
        }
        assertEquals("6ec5f8e8750dbc8a0e40c431fd1b7b07a13688136b2244c5a1364b54d9032599", digest.digest().joinToString("") { "%02x".format(it) })
        SamEmbeddingEngine().use { engine ->
            assertEquals("completed", await(engine, engine.loadModel(path)).getString("status"))
            val limits = JSONObject(engine.getModelInfo()).getJSONObject("batchLimits")
            assertEquals(4096, limits.getInt("nCtx"))
            assertEquals(512, limits.getInt("nCtxSeq"))
            assertEquals(1024, limits.getInt("nBatch"))
            assertEquals(1024, limits.getInt("nUbatch"))
            assertEquals(8, limits.getInt("maxParallelSequences"))
            assertEquals("serial_ubatches", limits.getString("backendSequenceExecution"))
            val q = await(engine, engine.embedQuery("What is panda?")).getJSONObject("result")
            assertEquals(1024, q.getJSONArray("vector").length())
            assertEquals(7, q.getInt("tokenCount"))
            assertFalse(q.getBoolean("warm"))
            val vector = q.getJSONArray("vector")
            val norm = sqrt((0 until 1024).sumOf { val v = vector.getDouble(it); assertTrue(v.isFinite()); v * v })
            assertTrue(abs(norm - 1) < 1e-5)
            assertEquals(-0.0278193, vector.getDouble(0), 0.002)
            assertEquals(9, await(engine, engine.tokenize("query: What is panda?", "query")).getJSONObject("result").getInt("tokenCount"))
            assertEquals(9, await(engine, engine.embedQuery("query: What is panda?")).getJSONObject("result").getInt("tokenCount"))
            for (kind in listOf("query", "document")) {
                for (text in listOf("$kind:", "$kind: ")) {
                    val tokens = await(engine, engine.tokenize(text, kind)).getJSONObject("result").getInt("tokenCount")
                    val id = if (kind == "query") engine.embedQuery(text) else engine.embedDocument(text)
                    assertEquals(tokens, await(engine, id).getJSONObject("result").getInt("tokenCount"))
                }
            }
            val unicode = "caf\u00e9 \u65e5\u672c\u8a9e \uD83D\uDE80 \u0000"
            val count = await(engine, engine.tokenize(unicode, "query")).getJSONObject("result").getInt("tokenCount")
            assertEquals(11, count)
            assertEquals(count, await(engine, engine.embedQuery(unicode)).getJSONObject("result").getInt("tokenCount"))
            val oversized = " hello".repeat(600)
            val actual = await(engine, engine.tokenize(oversized, "document")).getJSONObject("result").getInt("tokenCount")
            assertTrue(actual > 512)
            val error = await(engine, engine.embedDocument(oversized)).getJSONObject("error")
            assertEquals("INPUT_TOO_LONG", error.getString("code"))
            assertEquals(actual, error.getInt("actualTokens"))
            assertEquals(512, error.getInt("maxTokens"))
            val boundary = "hello" + " hello".repeat(508)
            val documents = arrayOf("hi", "it is a bear", unicode, "document: foo", "A bicycle has two wheels and pedals.", boundary)
            val baseline = await(engine, engine.embedBatchWithOptions(documents, "sequential", 100, 4096)).getJSONObject("result")
            assertEquals(documents.size, baseline.getJSONObject("metrics").getInt("nativeDecodeCount"))
            assertEquals(1, baseline.getJSONObject("metrics").getInt("effectiveBatchSize"))
            var minimumCosine = 1.0
            repeat(2) {
                for ((sequences, tokens) in listOf(100 to 4096, 4 to 4096, 100 to 512)) {
                    val response = await(engine, engine.embedBatchWithOptions(documents, "true_batch", sequences, tokens))
                    assertEquals("completed", response.getString("status"))
                    val result = response.getJSONObject("result")
                    val embeddings = result.getJSONArray("embeddings")
                    val metrics = result.getJSONObject("metrics")
                    val decodes = metrics.getJSONArray("decodes")
                    assertEquals(documents.size, embeddings.length())
                    assertEquals(if (sequences == 100 && tokens == 4096) 1 else 2, metrics.getInt("nativeDecodeCount"))
                    assertEquals(if (tokens == 512) 5 else minOf(sequences, documents.size), metrics.getInt("effectiveBatchSize"))
                    var totalTokens = 0
                    for (i in documents.indices) {
                        val embedding = embeddings.getJSONObject(i)
                        val reference = baseline.getJSONArray("embeddings").getJSONObject(i)
                        assertTrue(embedding.isNull("inferenceDurationMs"))
                        assertEquals(reference.getInt("tokenCount"), embedding.getInt("tokenCount"))
                        totalTokens += embedding.getInt("tokenCount")
                        val vectorA = embedding.getJSONArray("vector")
                        val vectorB = reference.getJSONArray("vector")
                        val cosine = (0 until 1024).sumOf { vectorA.getDouble(it) * vectorB.getDouble(it) }
                        minimumCosine = minOf(minimumCosine, cosine)
                    }
                    assertEquals(totalTokens, metrics.getInt("totalTokens"))
                    assertEquals(totalTokens, (0 until decodes.length()).sumOf { decodes.getJSONObject(it).getInt("tokens") })
                    assertTrue(metrics.getDouble("totalElapsedMs") >= metrics.getDouble("nativeDecodeMs") + metrics.getDouble("preparationMs"))
                    assertEquals(metrics.getDouble("totalElapsedMs"), metrics.getDouble("effectiveMsPerDocument") * documents.size, 1e-6)
                }
            }
            val singleton = await(engine, engine.embedBatchWithOptions(arrayOf("hi"), "true_batch", 100, 4096))
                .getJSONObject("result").getJSONArray("embeddings").getJSONObject(0)
            assertTrue(singleton.getDouble("inferenceDurationMs") > 0)
            assertEquals(2, await(engine, engine.embedBatch(arrayOf("one", "two"))).getJSONArray("result").length())
            for (id in listOf(
                engine.embedBatch(arrayOf("hi", oversized)),
                engine.embedBatchWithOptions(arrayOf("hi", boundary), "true_batch", 100, 511),
                engine.embedBatchWithOptions(arrayOf("hi"), "true_batch", 0, 4096),
                engine.embedBatchWithOptions(arrayOf("hi"), "true_batch", 101, 4096),
                engine.embedBatchWithOptions(arrayOf("hi"), "true_batch", 100, 4097),
                engine.embedBatch(Array(1001) { "hi" })
            )) {
                val failed = await(engine, id)
                assertEquals("error", failed.getString("status"))
                assertFalse(failed.has("result"))
            }
            val batch = engine.embedBatch(Array(20) { " hello".repeat(500) })
            val queued = engine.embedBatchWithOptions(arrayOf("queued"), "true_batch", 1, 512)
            engine.cancel(queued)
            Thread.sleep(50)
            engine.cancel(batch)
            assertEquals("cancelled", await(engine, batch).getString("status"))
            assertEquals("cancelled", await(engine, queued).getString("status"))
            val recovered = await(engine, engine.embedQuery("What is panda?")).getJSONObject("result")
            for (i in 0 until 1024) assertEquals(vector.getDouble(i), recovered.getJSONArray("vector").getDouble(i), 1e-5)
            val ids = (1..4).map { engine.embedDocument("document $it") }
            ids.forEach { assertEquals("completed", await(engine, it).getString("status")) }
            await(engine, engine.loadModel(path))
            assertTrue(await(engine, engine.embedQuery("hello")).getJSONObject("result").getBoolean("warm"))
            await(engine, engine.unloadModel()); await(engine, engine.unloadModel())
            assertFalse(engine.isLoaded())
            assertFalse(JSONObject(engine.getModelInfo()).has("batchLimits"))
            await(engine, engine.loadModel(path))
            assertFalse(await(engine, engine.embedQuery("hello")).getJSONObject("result").getBoolean("warm"))
            assertTrue("Minimum batch cosine=$minimumCosine", minimumCosine >= 0.99999)
        }
    }
}
