import fastifyMultipart from "@fastify/multipart";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticate } from "../../auth/middleware.ts";
import { loadEnv } from "../../config/env.ts";
import type { StorageProvider } from "../../storage/index.ts";
import * as docs from "./docs.ts";
import { createFileHandlers } from "./handler.ts";
import { CreateUploadUrlSchema, DeleteFileSchema, DownloadFileSchema, UploadFileSchema } from "./schema.ts";
import { createFilesService, type FilesConfig } from "./service.ts";

const filesEnvSchema = z.object({
  UPLOAD_MAX_FILE_SIZE_MB: z.coerce.number<string>().positive().default(10),
  // SVG and HTML are excluded by default: they can run scripts when opened in a browser
  UPLOAD_ALLOWED_CONTENT_TYPES: z
    .string()
    .default("image/png,image/jpeg,image/webp,image/gif,application/pdf")
    .transform((value) =>
      value
        .split(",")
        .map((type) => type.trim().toLowerCase())
        .filter(Boolean),
    ),
  UPLOAD_URL_EXPIRES_IN_SECONDS: z.coerce.number<string>().int().positive().default(300),
});

export const loadFilesConfig = (source: NodeJS.ProcessEnv = process.env): FilesConfig => {
  const env = loadEnv(filesEnvSchema, source, "file upload env");
  return {
    maxFileSizeBytes: Math.floor(env.UPLOAD_MAX_FILE_SIZE_MB * 1024 * 1024),
    allowedContentTypes: env.UPLOAD_ALLOWED_CONTENT_TYPES,
    uploadUrlExpiresInSeconds: env.UPLOAD_URL_EXPIRES_IN_SECONDS,
  };
};

export interface FileRoutesOptions {
  storage: StorageProvider;
  config?: FilesConfig;
}

const fileRoutes: FastifyPluginAsyncZod<FileRoutesOptions> = async (fastify, options) => {
  const config = options.config ?? loadFilesConfig();
  const handlers = createFileHandlers({
    service: createFilesService(options.storage, config),
    storage: options.storage,
    config,
  });

  await fastify.register(fastifyMultipart, {
    limits: { fileSize: config.maxFileSizeBytes, files: 1 },
  });
  fastify.addHook("onRequest", authenticate);

  fastify.route({
    method: "POST",
    url: "/files",
    schema: { ...UploadFileSchema, ...docs.uploadFileDocs },
    handler: handlers.upload,
  });

  fastify.route({
    method: "POST",
    url: "/files/upload-url",
    schema: { ...CreateUploadUrlSchema, ...docs.createUploadUrlDocs },
    handler: handlers.createUploadUrl,
  });

  fastify.route({
    method: "GET",
    url: "/files/*",
    schema: { ...DownloadFileSchema, ...docs.downloadFileDocs },
    handler: handlers.download,
  });

  fastify.route({
    method: "DELETE",
    url: "/files/*",
    schema: { ...DeleteFileSchema, ...docs.deleteFileDocs },
    handler: handlers.remove,
  });
};

export default fileRoutes;
