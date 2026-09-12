package com.sam.embeddings

import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

/** Context-free, FIFO embedding engine. Call close() when its owner is finished. */
class SamEmbeddingEngine internal constructor(private val backend: Backend) : AutoCloseable {
    constructor() : this(JniBackend())

    private class Request(val operation: String) {
        var cancelled = false
        var terminal: String? = null
    }

    private val gate = Any()
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "sam-embeddings").apply { isDaemon = true }
    }
    private val requests = mutableMapOf<String, Request>()
    private var active: Request? = null
    private var handle = 0L
    private var closed = false
    @Volatile private var loaded = false
    @Volatile private var state = "unloaded"
    @Volatile private var modelInfo = MODEL_INFO

    fun loadModel(path: String): String = submit("load") {
        state = "loading"
        if (path.isBlank() || '\u0000' in path) error("INVALID_PATH", "Expected an absolute model file path")
        else if (hasUnpairedSurrogate(path)) error("INVALID_PATH", "Model path contains an unpaired Unicode surrogate")
        else backend.loadModel(handle, path.toByteArray(Charsets.UTF_8))
    }

    fun unloadModel(): String = submit("unload") {
        state = "unloading"
        backend.unloadModel(handle)
    }

    fun embedQuery(text: String): String = submit("embed") {
        validateText(text) ?: backend.embedQuery(handle, text.toByteArray(Charsets.UTF_8))
    }

    fun embedDocument(text: String): String = submit("embed") {
        validateText(text) ?: backend.embedDocument(handle, text.toByteArray(Charsets.UTF_8))
    }

    fun embedBatch(texts: Array<String>): String = submitBatch(texts, "true_batch", 100, 4096, true)

    fun embedBatchWithOptions(texts: Array<String>, mode: String, maxSequences: Int, maxTokens: Int): String =
        submitBatch(texts, mode, maxSequences, maxTokens, false)

    private fun submitBatch(texts: Array<String>, mode: String, maxSequences: Int, maxTokens: Int, legacy: Boolean): String {
        if (texts.size > 1000) return submit("batch") { error("INVALID_ARGUMENT", "Batch exceeds 1000 documents") }
        val snapshot = texts.copyOf()
        return submit("batch") {
            if (mode !in listOf("sequential", "true_batch") || maxSequences !in 1..100 || maxTokens !in 1..4096)
                return@submit error("INVALID_ARGUMENT", "Expected mode sequential|true_batch, maxSequences 1..100, maxTokens 1..4096")
            if (snapshot.isEmpty()) return@submit error("EMPTY_INPUT", "Batch must not be empty")
            for (text in snapshot) {
                if (synchronized(gate) { active?.cancelled == true }) return@submit cancelled()
                validateText(text)?.let { return@submit it }
            }
            val response = backend.embedBatch(handle, Array(snapshot.size) { snapshot[it].toByteArray(Charsets.UTF_8) },
                mode.toByteArray(Charsets.UTF_8), maxSequences, maxTokens)
            if (!legacy) return@submit response
            val envelope = JSONObject(response)
            if (envelope.getString("status") == "completed")
                envelope.put("result", envelope.getJSONObject("result").getJSONArray("embeddings"))
            envelope.toString()
        }
    }

    fun tokenize(text: String, kind: String): String = submit("tokenize") {
        if (kind != "query" && kind != "document") error("INVALID_ARGUMENT", "kind must be query or document")
        else validateText(text) ?: backend.tokenize(handle, text.toByteArray(Charsets.UTF_8), kind.toByteArray(Charsets.UTF_8))
    }

    /** Terminal responses are consumed exactly once. Unknown/consumed IDs return UNKNOWN_REQUEST. */
    fun poll(requestId: String): String = synchronized(gate) {
        val request = requests[requestId] ?: return@synchronized error("UNKNOWN_REQUEST", "Unknown or consumed request ID")
        request.terminal?.also { requests.remove(requestId) } ?: "{\"status\":\"pending\"}"
    }

    fun cancel(requestId: String) = synchronized(gate) {
        val request = requests[requestId] ?: return@synchronized
        if (request.terminal != null) return@synchronized
        request.cancelled = true
        // The only cross-thread JNI operation writes an atomic flag. The same gate
        // protects handle creation/destruction and the active-request transition.
        if (active === request && handle != 0L) backend.cancel(handle)
    }

    fun isLoaded(): Boolean = loaded
    fun getState(): String = state
    fun getModelInfo(): String = modelInfo

    override fun close() = synchronized(gate) {
        if (closed) return@synchronized
        closed = true
        requests.values.filter { it.terminal == null }.forEach { it.cancelled = true }
        if (active != null && handle != 0L) backend.cancel(handle)
        worker.execute {
            synchronized(gate) {
                state = "unloading"
                try { if (handle != 0L) backend.destroy(handle) }
                finally { handle = 0; loaded = false; modelInfo = MODEL_INFO; state = "unloaded" }
            }
        }
        worker.shutdown()
    }

    private fun submit(operation: String, action: () -> String): String = synchronized(gate) {
        val id = UUID.randomUUID().toString()
        val request = Request(operation)
        requests[id] = request
        if (closed) {
            request.terminal = error("ENGINE_CLOSED", "Engine is closed; create a new instance")
            return@synchronized id
        }
        worker.execute {
            var response: String
            var loadedModelInfo: String? = null
            try {
                val run = synchronized(gate) {
                    if (request.cancelled) false
                    else {
                        if (handle == 0L) handle = backend.create()
                        check(handle != 0L) { "Native engine initialization failed" }
                        backend.begin(handle)
                        active = request
                        true
                    }
                }
                response = if (run) action() else cancelled()
                if (run && operation == "load") {
                    val envelope = JSONObject(response)
                    if (envelope.optString("status") == "completed")
                        loadedModelInfo = envelope.getJSONObject("result").getJSONObject("modelInfo").toString()
                }
            } catch (e: LinkageError) {
                response = error("NATIVE_INIT_FAILED", e.message ?: "Cannot load native library")
            } catch (e: OutOfMemoryError) {
                response = error("OUT_OF_MEMORY", "Embedding allocation failed")
            } catch (e: Exception) {
                response = error(if (handle == 0L) "NATIVE_INIT_FAILED" else "NATIVE_ERROR", e.message ?: "Embedding operation failed")
            }
            synchronized(gate) {
                // A cancelled load must not leave a newly loaded model published.
                if (request.cancelled && request.operation == "load" && active === request && handle != 0L) {
                    backend.unloadModel(handle)
                }
                loaded = handle != 0L && backend.isLoaded(handle)
                if (!loaded) modelInfo = MODEL_INFO
                else if (!request.cancelled) loadedModelInfo?.let { modelInfo = it }
                state = if (loaded) "ready" else if (JSONObject(response).optString("status") == "error") "error" else "unloaded"
                request.terminal = if (request.cancelled) cancelled() else response
                if (active === request) active = null
            }
        }
        id
    }

    private fun validateText(text: String): String? {
        if (text.isBlank()) return error("EMPTY_INPUT", "Text must not be empty or whitespace only")
        if (hasUnpairedSurrogate(text)) return error("INVALID_ARGUMENT", "Text contains an unpaired Unicode surrogate")
        return null
    }

    private fun hasUnpairedSurrogate(text: String): Boolean {
        // Reject malformed UTF-16 instead of silently replacing unpaired surrogates.
        var i = 0
        while (i < text.length) {
            val c = text[i++]
            if (Character.isHighSurrogate(c)) {
                if (i >= text.length || !Character.isLowSurrogate(text[i++]))
                    return true
            } else if (Character.isLowSurrogate(c)) return true
        }
        return false
    }

    private fun error(code: String, message: String): String = JSONObject()
        .put("status", "error").put("error", JSONObject().put("code", code).put("message", message)).toString()
    private fun cancelled(): String = "{\"status\":\"cancelled\"}"

    companion object {
        private const val MODEL_INFO = "{\"modelId\":\"LiquidAI/LFM2.5-Embedding-350M\",\"revision\":\"a80de9c5b941d429104f0038292a0ef5a860e486\",\"quantization\":\"Q8_0\",\"dimensions\":1024,\"maxTokens\":512,\"backendRevision\":\"465e49b9cea78a68b9c244ffb48d0ee24a82873d\",\"batchMode\":\"true_batch\"}"
    }
}

internal interface Backend {
    fun create(): Long
    fun destroy(handle: Long)
    fun begin(handle: Long)
    fun cancel(handle: Long)
    fun isLoaded(handle: Long): Boolean
    fun loadModel(handle: Long, path: ByteArray): String
    fun unloadModel(handle: Long): String
    fun embedQuery(handle: Long, text: ByteArray): String
    fun embedDocument(handle: Long, text: ByteArray): String
    fun embedBatch(handle: Long, texts: Array<ByteArray>, mode: ByteArray, maxSequences: Int, maxTokens: Int): String
    fun tokenize(handle: Long, text: ByteArray, kind: ByteArray): String
}

internal class JniBackend : Backend {
    override fun create(): Long {
        System.loadLibrary("sam-embeddings")
        return nativeCreate()
    }
    override fun destroy(handle: Long) = nativeDestroy(handle)
    override fun begin(handle: Long) = nativeBegin(handle)
    override fun cancel(handle: Long) = nativeCancel(handle)
    override fun isLoaded(handle: Long) = nativeIsLoaded(handle)
    override fun loadModel(handle: Long, path: ByteArray) = nativeLoadModel(handle, path)
    override fun unloadModel(handle: Long) = nativeUnloadModel(handle)
    override fun embedQuery(handle: Long, text: ByteArray) = nativeEmbedQuery(handle, text)
    override fun embedDocument(handle: Long, text: ByteArray) = nativeEmbedDocument(handle, text)
    override fun embedBatch(handle: Long, texts: Array<ByteArray>, mode: ByteArray, maxSequences: Int, maxTokens: Int) =
        nativeEmbedBatch(handle, texts, mode, maxSequences, maxTokens)
    override fun tokenize(handle: Long, text: ByteArray, kind: ByteArray) = nativeTokenize(handle, text, kind)
    private external fun nativeCreate(): Long
    private external fun nativeDestroy(handle: Long)
    private external fun nativeBegin(handle: Long)
    private external fun nativeCancel(handle: Long)
    private external fun nativeIsLoaded(handle: Long): Boolean
    private external fun nativeLoadModel(handle: Long, path: ByteArray): String
    private external fun nativeUnloadModel(handle: Long): String
    private external fun nativeEmbedQuery(handle: Long, text: ByteArray): String
    private external fun nativeEmbedDocument(handle: Long, text: ByteArray): String
    private external fun nativeEmbedBatch(handle: Long, texts: Array<ByteArray>, mode: ByteArray, maxSequences: Int, maxTokens: Int): String
    private external fun nativeTokenize(handle: Long, text: ByteArray, kind: ByteArray): String
}
