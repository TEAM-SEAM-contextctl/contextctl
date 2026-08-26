/**
 * Runtime surface loaded only inside the daemon-owned local embedding Worker.
 *
 * The ordinary package entry intentionally exposes the complete Ingestion API.
 * Loading it in a fresh Worker would evaluate Markdown, Qdrant and durable-store
 * modules that physical inference never calls. The daemon activates this entry
 * with a private Node export condition while keeping the package-root import and
 * the same two public symbols.
 */
export {
  loadLocalDocumentEmbeddingInferenceResource,
} from "./transformers-js-local-embedding-adapter.js";
export { EmbeddingProviderFault } from "../ports/embedding.js";
