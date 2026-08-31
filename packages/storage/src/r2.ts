import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type ObjectStorageConfig = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type CreateObjectUploadUrlInput = {
  objectKey: string;
  contentType: string;
  expiresInSeconds: number;
};

export type UploadInstruction = {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
};

export type StoredObjectMetadata = {
  contentType: string | null;
  sizeBytes: number | null;
};

export interface ObjectStorage {
  createUploadUrl(input: CreateObjectUploadUrlInput): Promise<UploadInstruction>;
  createDownloadUrl(objectKey: string, expiresInSeconds: number): Promise<string>;
  headObject(objectKey: string): Promise<StoredObjectMetadata | null>;
  deleteObject(objectKey: string): Promise<void>;
  readObject(objectKey: string, abortSignal?: AbortSignal): Promise<Uint8Array>;
  writeObject(input: {
    objectKey: string;
    data: Uint8Array;
    contentType: string;
    abortSignal?: AbortSignal;
  }): Promise<void>;
}

export function createR2ObjectStorage(
  config: ObjectStorageConfig,
): ObjectStorage {
  const client = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async readObject(objectKey, abortSignal) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }),
        { abortSignal },
      );

      if (!result.Body) {
        throw new Error("R2 对象缺少响应体");
      }

      return result.Body.transformToByteArray();
    },

    async writeObject({ objectKey, data, contentType, abortSignal }) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: objectKey,
          Body: data,
          ContentType: contentType,
          ContentLength: data.byteLength,
        }),
        { abortSignal },
      );
    },

    async createUploadUrl(input) {
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
      });
      const url = await getSignedUrl(client, command, {
        expiresIn: input.expiresInSeconds,
      });

      return {
        method: "PUT",
        url,
        headers: { "Content-Type": input.contentType },
      };
    },

    async createDownloadUrl(objectKey, expiresInSeconds) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }),
        { expiresIn: expiresInSeconds },
      );
    },

    async headObject(objectKey) {
      try {
        const result = await client.send(
          new HeadObjectCommand({
            Bucket: config.bucket,
            Key: objectKey,
          }),
        );

        return {
          contentType: result.ContentType ?? null,
          sizeBytes: result.ContentLength ?? null,
        };
      } catch (error) {
        if (
          error instanceof S3ServiceException &&
          error.$metadata.httpStatusCode === 404
        ) {
          return null;
        }

        throw error;
      }
    },

    async deleteObject(objectKey) {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey }),
      );
    },
  };
}
