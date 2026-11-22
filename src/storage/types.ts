import type { Readable } from "node:stream";

export interface PutObjectInput {
  key: string;
  body: Readable | Buffer;
  contentType: string;
}

export interface StoredObject {
  body: Readable;
  contentType: string | null;
  contentLength: number | null;
}

export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: Date;
}

/**
 * Contract every storage adapter implements (S3-compatible, local disk, ...).
 * Keys are opaque, server-generated paths like `userId/uuid.png`.
 */
export interface StorageProvider {
  readonly name: string;
  put(input: PutObjectInput): Promise<void>;
  /** Returns `null` when the object does not exist. */
  get(key: string): Promise<StoredObject | null>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Direct browser-to-bucket upload URL. Optional: providers without
   * presigned URLs (local disk) leave it undefined.
   */
  createUploadUrl?(input: {
    key: string;
    contentType: string;
    /** Exact size in bytes. The URL must only accept an upload of this size. */
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload>;
}
