const assert = require("node:assert/strict");
const test = require("node:test");
const {
  EmbeddingUnavailableError,
  resolveEmbeddingConfig,
  createDisabledEmbeddingProvider,
  createEmbeddingProvider,
  validateEmbeddingProvider,
  assertEmbeddingBatch,
} = require("../../src/storage/embedding-provider");

test("embedding configuration defaults to disabled and bounded values", () => {
  assert.deepEqual(resolveEmbeddingConfig({}), {
    enabled: false,
    provider: "disabled",
    model: "",
    dimensions: 0,
    batchSize: 16,
    timeoutMs: 5000,
    baseUrl: "",
    apiKey: "",
  });
  assert.deepEqual(
    resolveEmbeddingConfig({
      SHIFT_EMBEDDING_ENABLED: "true",
      SHIFT_EMBEDDING_PROVIDER: "local",
      SHIFT_EMBEDDING_MODEL: "mini",
      SHIFT_EMBEDDING_DIMENSIONS: "384",
      SHIFT_EMBEDDING_BATCH_SIZE: "8",
      SHIFT_EMBEDDING_TIMEOUT_MS: "2500",
    }),
    {
      enabled: true,
      provider: "local",
      model: "mini",
      dimensions: 384,
      batchSize: 8,
      timeoutMs: 2500,
      baseUrl: "",
      apiKey: "",
    }
  );
});

test("OpenAI-compatible provider batches documents and validates dimensions", async () => {
  const requests = [];
  const provider = createEmbeddingProvider(
    {
      enabled: true,
      provider: "openai-compatible",
      model: "embed-test",
      dimensions: 3,
      timeoutMs: 1000,
      baseUrl: "http://embedding.test/v1",
      apiKey: "secret",
    },
    {
      fetch: async (url, init) => {
        requests.push({ url, init });
        return {
          ok: true,
          async json() {
            return {
              data: [
                { index: 1, embedding: [0, 1, 0] },
                { index: 0, embedding: [1, 0, 0] },
              ],
            };
          },
        };
      },
    }
  );

  const vectors = await provider.embedDocuments(["first", "second"]);
  assert.deepEqual(Array.from(vectors[0]), [1, 0, 0]);
  assert.deepEqual(Array.from(vectors[1]), [0, 1, 0]);
  assert.equal(requests[0].url, "http://embedding.test/v1/embeddings");
  assert.equal(requests[0].init.headers.authorization, "Bearer secret");
});

test("disabled embedding provider fails without affecting recall availability", async () => {
  const provider = createDisabledEmbeddingProvider();
  await assert.rejects(() => provider.embedQuery("query"), EmbeddingUnavailableError);
  await assert.rejects(
    () => provider.embedDocuments(["document"]),
    /Embedding is disabled/
  );
});

test("embedding provider validation rejects malformed vector batches", () => {
  const provider = {
    available: true,
    model: "test",
    dimensions: 3,
    async embedDocuments() {},
    async embedQuery() {},
  };
  assert.equal(validateEmbeddingProvider(provider), provider);
  assert.deepEqual(
    assertEmbeddingBatch([new Float32Array([1, 0, 0])], 1, 3),
    [new Float32Array([1, 0, 0])]
  );
  assert.throws(
    () => assertEmbeddingBatch([new Float32Array([1, 0])], 1, 3),
    /invalid vector/
  );
});
