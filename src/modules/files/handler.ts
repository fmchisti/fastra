import { getAuthUser } from "../../auth/middleware.ts";
import { HttpError } from "../../lib/errors.ts";
import type { StorageProvider } from "../../storage/index.ts";
import type { ZodRouteHandler } from "../../types/fastify.ts";
import type {
  CreateUploadUrlSchema,
  DeleteFileSchema,
  DownloadFileSchema,
  UploadFileSchema,
} from "./schema.ts";
import { type FilesConfig, type FilesService, isContentTypeAllowed } from "./service.ts";

// Only these are rendered inline; everything else downloads, so it cannot execute in our origin
const INLINE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export interface FileHandlerOptions {
  service: FilesService;
  storage: StorageProvider;
  config: FilesConfig;
}

export const createFileHandlers = ({ service, storage, config }: FileHandlerOptions) => {
  const upload: ZodRouteHandler<typeof UploadFileSchema> = async (request, reply) => {
    const file = await request.file();
    if (!file) throw new HttpError(400, "Missing file field");

    const uploaded = await service.upload(getAuthUser(request).id, {
      filename: file.filename,
      contentType: file.mimetype,
      stream: file.file,
    });
    // The stream is truncated (not errored) when it hits the size limit
    if (file.file.truncated) {
      await storage.delete(uploaded.key);
      throw new HttpError(413, `File exceeds ${config.maxFileSizeBytes} bytes`);
    }
    return reply.status(201).send(uploaded);
  };

  const createUploadUrl: ZodRouteHandler<typeof CreateUploadUrlSchema> = async (request) =>
    service.createUploadUrl(getAuthUser(request).id, request.body);

  const download: ZodRouteHandler<typeof DownloadFileSchema> = async (request, reply) => {
    const object = await service.download(getAuthUser(request).id, request.params["*"]);
    const contentType = object.contentType ?? "application/octet-stream";
    const inline = isContentTypeAllowed(contentType, INLINE_CONTENT_TYPES);

    reply
      .header("content-type", inline ? contentType : "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", inline ? "inline" : "attachment");
    if (object.contentLength !== null) reply.header("content-length", object.contentLength);
    return reply.send(object.body);
  };

  const remove: ZodRouteHandler<typeof DeleteFileSchema> = async (request, reply) => {
    await service.delete(getAuthUser(request).id, request.params["*"]);
    return reply.status(204).send(null);
  };

  return { upload, createUploadUrl, download, remove };
};
