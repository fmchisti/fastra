import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { StorageProvider } from "../../src/storage/types.ts";

export interface MemoryStorage extends StorageProvider {
  objects: Map<string, { data: Buffer; contentType: string }>;
}

export const createMemoryStorage = (options: { presign?: boolean } = {}): MemoryStorage => {
  const objects = new Map<string, { data: Buffer; contentType: string }>();

  return {
    name: "memory",
    objects,
    put: async ({ key, body, contentType }) => {
      const data = Buffer.isBuffer(body) ? body : await buffer(body);
      objects.set(key, { data, contentType });
    },
    get: async (key) => {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: Readable.from(object.data),
        contentType: object.contentType,
        contentLength: object.data.length,
      };
    },
    delete: async (key) => {
      objects.delete(key);
    },
    ...(options.presign && {
      createUploadUrl: async ({ key, contentType, contentLength, expiresInSeconds }) => ({
        url: `https://bucket.example.com/${key}?size=${contentLength}&signature=fake`,
        method: "PUT" as const,
        headers: { "content-type": contentType },
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      }),
    }),
  };
};
