/**
 * OpenAPI / Swagger documentation for file endpoints.
 * Spread these into route schemas for consistent API docs.
 */

const base = { tags: ["Files"], security: [{ bearerAuth: [] }] };

export const uploadFileDocs = {
  ...base,
  summary: "Upload a file",
  description: "multipart/form-data with a single `file` field.",
};
export const createUploadUrlDocs = {
  ...base,
  summary: "Create a presigned upload URL",
  description:
    "Upload directly to the bucket with the returned method and headers. Not supported by local storage.",
};
export const downloadFileDocs = { ...base, summary: "Download a file" };
export const deleteFileDocs = { ...base, summary: "Delete a file" };
