import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const aar = 'native/build/outputs/aar/sam-embeddings.aar';
const apk = 'platforms/android/app/build/outputs/apk/debug/app-debug.apk';
const sdk = process.env.ANDROID_HOME ?? '/home/dom/Android/Sdk';
const options = { maxBuffer: 100 * 1024 * 1024 };
const list = file => execFileSync('unzip', ['-Z1', file], options).toString().trim().split('\n');
const entry = (file, path) => execFileSync('unzip', ['-p', file, path], options);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

for (const file of [aar, apk]) {
  const paths = list(file);
  assert(!paths.some(path => /\.(gguf|safetensors|gguf\.part)$/i.test(path)), 'Models must not be packaged');
  assert(paths.filter(path => /^(jni|lib)\/.+\.so$/.test(path)).every(path => path.includes('/arm64-v8a/')), 'ARM64 only');
  assert(statSync(file).size < 100 * 1024 * 1024, 'Unexpected model-sized artifact');
  console.log(`${file}: ${statSync(file).size} bytes; SHA-256 ${sha(readFileSync(file))}`);
}
const library = entry(aar, 'jni/arm64-v8a/libsam-embeddings.so');
assert(library.includes(Buffer.from('Java_com_sam_embeddings_JniBackend_nativeEmbedBatch')), 'Native batch JNI export missing');
assert.equal(sha(library), sha(entry(apk, 'lib/arm64-v8a/libsam-embeddings.so')), 'APK must contain this exact AAR runtime');
assert.equal(library.readUInt16LE(18), 183, 'ELF machine must be AArch64');
// ELF64 program headers: each loadable segment must be 16 KB aligned.
const offset = Number(library.readBigUInt64LE(32));
const size = library.readUInt16LE(54);
const count = library.readUInt16LE(56);
for (let i = 0; i < count; i++) {
  const header = offset + i * size;
  if (library.readUInt32LE(header) === 1) assert(library.readBigUInt64LE(header + 48) >= 16384n, 'ELF LOAD alignment');
}
const strings = entry(apk, 'assets/metadata/treeStringsStream.dat').toString();
console.log('NativeScript metadata names:', Object.fromEntries(
  ['SamEmbeddingEngine', 'SamModelInstaller', 'SamDeviceDiagnostics', 'OkHttpClient'].map(name => [name, strings.includes(name)])));
for (const name of ['SamEmbeddingEngine', 'embedBatchWithOptions', 'SamModelInstaller', 'SamDeviceDiagnostics']) {
  assert(strings.includes(name), `NativeScript metadata must expose ${name}`);
}
const manifest = execFileSync(join(sdk, 'cmdline-tools/latest/bin/apkanalyzer'), ['manifest', 'print', apk], options).toString();
assert(manifest.includes('org.nativescript.nativesam.embeddings.reports'), 'Report authority missing');
assert(manifest.includes('android.support.FILE_PROVIDER_PATHS') && list(apk).includes('res/xml/embedding_report_paths.xml'), 'Report provider paths missing');
assert(manifest.includes('GenerationForegroundService'), 'Existing foreground generation service missing');
execFileSync(join(sdk, 'build-tools/35.0.0/apksigner'), ['verify', apk], options);
execFileSync(join(sdk, 'build-tools/35.0.0/zipalign'), ['-c', '-P', '16', '4', apk], options);
console.log('PASS: no bundled model; ARM64 JNI matches AAR; ELF/ZIP 16 KB alignment; NativeScript metadata; report provider; debug signature.');
