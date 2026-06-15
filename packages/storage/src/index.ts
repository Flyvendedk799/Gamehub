/** @playforge/storage — content-addressed file storage for project snapshots.
 *  Blobs are keyed by SHA-256 (dedup); snapshots are manifests pointing at blobs. */
export { isSafeBundlePath, assertSafeBundlePath } from './paths';
export {
  type BlobStore,
  InMemoryBlobStore,
  LocalFsBlobStore,
  blobKey,
  sha256,
} from './blob-store';
export {
  SnapshotStore,
  type SnapshotManifest,
  type ManifestEntry,
  type SnapshotInputFile,
  type WriteResult,
  contentTypeFor,
  manifestKeyFor,
} from './snapshot-store';
