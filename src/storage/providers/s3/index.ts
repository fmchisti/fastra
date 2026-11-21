import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { loadEnv } from "../../../config/env.ts";
import type { StorageProvider } from "../../types.ts";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const s3EnvSchema = z.object({
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),
  // Set for S3-compatible services: Cloudflare R2, MinIO, Railway Buckets, DigitalOcean Spaces
  S3_ENDPOINT: z.url().optional(),
  S3_FORCE_PATH_STYLE: booleanString,
  // Omit both to use the default AWS credential chain (IAM role, ~/.aws, ...)
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

export interface S3StorageOptions {
  client: S3Client;
  bucket: string;
}

const isNotFound = (error: unknown): boolean =>
  error instanceof NoSuchKey || (error instanceof Error && error.name === "NotFound");

export const createS3Storage = ({ client, bucket }: S3StorageOptions): StorageProvider => ({
  name: "s3",

  put: async ({ key, body, contentType }) => {
    // Upload handles streams of unknown length with multipart uploads
    await new Upload({
      client,
      params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType },
    }).done();
  },

  get: async (key) => {
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!(result.Body instanceof Readable)) return null;
      return {
        body: result.Body,
        contentType: result.ContentType ?? null,
        contentLength: result.ContentLength ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },

  delete: async (key) => {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },

  createUploadUrl: async ({ key, contentType, contentLength, expiresInSeconds }) => {
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
      // Sign type and size, so the URL cannot be used for another type or a larger file.
      // Without the size, one URL accepts up to 5 GB.
      { expiresIn: expiresInSeconds, signableHeaders: new Set(["content-type", "content-length"]) },
    );
    return {
      url,
      method: "PUT",
      headers: { "content-type": contentType },
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  },
});

export const createStorage = (): StorageProvider => {
  const env = loadEnv(s3EnvSchema, process.env, "S3 storage env");
  const credentials =
    env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
      : undefined;

  const client = new S3Client({
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT }),
    ...(credentials && { credentials }),
  });
  return createS3Storage({ client, bucket: env.S3_BUCKET });
};
