import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { sdkStreamMixin } from "@smithy/util-stream";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { createS3Storage } from "../../src/storage/providers/s3/index.ts";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const s3 = mockClient(client);
const storage = createS3Storage({ client, bucket: "test-bucket" });

describe("S3 storage provider", () => {
  afterEach(() => s3.reset());

  it("uploads with bucket, key, and content type", async () => {
    s3.on(PutObjectCommand).resolves({});

    await storage.put({ key: "u1/a.png", body: Buffer.from("png"), contentType: "image/png" });

    const input = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ Bucket: "test-bucket", Key: "u1/a.png", ContentType: "image/png" });
  });

  it("streams objects back", async () => {
    s3.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Readable.from(["file", "-data"])),
      ContentType: "image/png",
      ContentLength: 9,
    });

    const object = await storage.get("u1/a.png");

    expect(object).toMatchObject({ contentType: "image/png", contentLength: 9 });
    expect(object && (await text(object.body))).toBe("file-data");
  });

  it("returns null for missing objects", async () => {
    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: "missing", $metadata: {} }));

    expect(await storage.get("u1/missing.png")).toBeNull();
  });

  it("rethrows other errors", async () => {
    s3.on(GetObjectCommand).rejects(new Error("AccessDenied"));

    await expect(storage.get("u1/a.png")).rejects.toThrow("AccessDenied");
  });

  it("deletes objects", async () => {
    s3.on(DeleteObjectCommand).resolves({});

    await storage.delete("u1/a.png");

    expect(s3.commandCalls(DeleteObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: "test-bucket",
      Key: "u1/a.png",
    });
  });

  it("creates a presigned PUT URL bound to the content type and the exact size", async () => {
    const upload = await storage.createUploadUrl?.({
      key: "u1/a.png",
      contentType: "image/png",
      contentLength: 1234,
      expiresInSeconds: 60,
    });

    expect(upload?.method).toBe("PUT");
    const url = new URL(upload?.url ?? "");
    expect(url.pathname).toContain("u1/a.png");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    // S3 rejects a request whose signed headers differ: another type or another size
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
      expect.arrayContaining(["content-type", "content-length"]),
    );
    expect(upload?.headers).toEqual({ "content-type": "image/png" });
  });
});
