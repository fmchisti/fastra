import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import { HttpError } from "../../lib/errors.ts";
import type { PresignedUpload, StorageProvider, StoredObject } from "../../storage/index.ts";
import type { UploadedFile } from "./schema.ts";

export interface FilesConfig {
  maxFileSizeBytes: number;
  /** Exact types (`image/png`) or wildcards (`image/*`). */
  allowedContentTypes: string[];
  uploadUrlExpiresInSeconds: number;
  /** Uploads, and upload URLs, one client may request per minute (each has its own count). */
  uploadsPerMinute: number;
}

const SAFE_OWNER = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_EXTENSION = /^\.[a-z0-9]{1,10}$/;

/** Folder name for a user. Ids with unusual characters are hashed so keys stay path-safe. */
export const ownerPrefix = (userId: string): string =>
  SAFE_OWNER.test(userId) ? userId : createHash("sha256").update(userId).digest("hex").slice(0, 32);

const buildKey = (userId: string, filename: string): string => {
  const extension = path.extname(filename).toLowerCase();
  return `${ownerPrefix(userId)}/${randomUUID()}${SAFE_EXTENSION.test(extension) ? extension : ""}`;
};

export const isContentTypeAllowed = (contentType: string, allowed: string[]): boolean => {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return allowed.some((pattern) =>
    pattern.endsWith("/*") ? normalized.startsWith(pattern.slice(0, -1)) : normalized === pattern,
  );
};

export interface FilesService {
  upload(
    userId: string,
    file: { filename: string; contentType: string; stream: Readable },
  ): Promise<UploadedFile>;
  download(userId: string, key: string): Promise<StoredObject>;
  delete(userId: string, key: string): Promise<void>;
  createUploadUrl(
    userId: string,
    input: { filename: string; contentType: string; size: number },
  ): Promise<PresignedUpload & { key: string }>;
}

export const createFilesService = (storage: StorageProvider, config: FilesConfig): FilesService => {
  const assertAllowed = (contentType: string) => {
    if (!isContentTypeAllowed(contentType, config.allowedContentTypes)) {
      throw new HttpError(415, `Content type ${contentType} is not allowed`);
    }
  };

  // Users may only touch keys under their own prefix
  const assertOwner = (userId: string, key: string) => {
    if (!key.startsWith(`${ownerPrefix(userId)}/`)) {
      throw new HttpError(403, "You do not have access to this file");
    }
  };

  return {
    upload: async (userId, { filename, contentType, stream }) => {
      assertAllowed(contentType);
      const key = buildKey(userId, filename);
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
      });

      try {
        await storage.put({ key, body: stream, contentType });
      } catch (error) {
        // Remove partial uploads (e.g. size limit exceeded mid-stream)
        await storage.delete(key).catch(() => undefined);
        throw error;
      }
      return { key, contentType, size };
    },

    download: async (userId, key) => {
      assertOwner(userId, key);
      const object = await storage.get(key);
      if (!object) throw new HttpError(404, "File not found");
      return object;
    },

    delete: async (userId, key) => {
      assertOwner(userId, key);
      await storage.delete(key);
    },

    createUploadUrl: async (userId, { filename, contentType, size }) => {
      if (!storage.createUploadUrl) {
        throw new HttpError(501, `Storage provider "${storage.name}" does not support upload URLs`);
      }
      assertAllowed(contentType);
      if (size > config.maxFileSizeBytes) {
        throw new HttpError(413, `File exceeds ${config.maxFileSizeBytes} bytes`);
      }
      const key = buildKey(userId, filename);
      const upload = await storage.createUploadUrl({
        key,
        contentType,
        contentLength: size,
        expiresInSeconds: config.uploadUrlExpiresInSeconds,
      });
      return { key, ...upload };
    },
  };
};
