import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import { getConfig, isConfigComplete } from "../config/configStore";
import { createS3Client } from "./s3Client";

export interface ObjectTextResult {
  text: string;
  eTag: string | null;
}

export interface PutObjectTextOptions {
  ifMatch?: string;
  ifNoneMatch?: string;
}

export class ConditionalWriteError extends Error {
  constructor(message = "对象条件写入失败。") {
    super(message);
    this.name = "ConditionalWriteError";
  }
}

export async function getObjectText(key: string): Promise<string | null> {
  const result = await getObjectTextWithETag(key);
  return result?.text ?? null;
}

export async function getObjectTextWithETag(key: string): Promise<ObjectTextResult | null> {
  const config = await requireConfig();
  const client = createS3Client(config);

  try {
    const result = await client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: resolveKey(config.prefix, key)
      })
    );

    return {
      text: result.Body ? await bodyToText(result.Body) : "",
      eTag: result.ETag ?? null
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

export async function putObjectText(
  key: string,
  body: string,
  options: PutObjectTextOptions = {}
): Promise<void> {
  const config = await requireConfig();
  const client = createS3Client(config);

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: resolveKey(config.prefix, key),
        Body: body,
        ContentType: "application/json; charset=utf-8",
        IfMatch: options.ifMatch,
        IfNoneMatch: options.ifNoneMatch
      })
    );
  } catch (error) {
    if (isConditionalWriteConflict(error)) {
      throw new ConditionalWriteError();
    }

    throw error;
  }
}

export async function deleteObjectIfExists(key: string): Promise<void> {
  const config = await requireConfig();
  const client = createS3Client(config);

  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: resolveKey(config.prefix, key)
      })
    );
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }

    throw error;
  }
}

export async function objectExists(key: string): Promise<boolean> {
  const config = await requireConfig();
  const client = createS3Client(config);

  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: resolveKey(config.prefix, key)
      })
    );
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

export async function testS3Connection(): Promise<void> {
  const config = await requireConfig();
  const client = createS3Client(config);

  await client.send(
    new HeadBucketCommand({
      Bucket: config.bucket
    })
  );
}

export function resolveKey(prefix: string, key: string): string {
  const cleanPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
  const cleanKey = key.trim().replace(/^\/+/g, "");

  return cleanPrefix ? `${cleanPrefix}/${cleanKey}` : cleanKey;
}

async function requireConfig() {
  const config = await getConfig();

  if (!isConfigComplete(config)) {
    throw new Error("请先完整填写 S3 配置。");
  }

  return config;
}

async function bodyToText(body: unknown): Promise<string> {
  if (typeof body === "string") {
    return body;
  }

  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }

  if (body instanceof Blob) {
    return body.text();
  }

  if (isTransformableBody(body)) {
    return body.transformToString();
  }

  if (isReadableStream(body)) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      chunks.push(result.value);
    }

    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const bytes = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    return new TextDecoder().decode(bytes);
  }

  return String(body);
}

function isTransformableBody(body: unknown): body is { transformToString: () => Promise<string> } {
  return Boolean(
    body
      && typeof body === "object"
      && "transformToString" in body
      && typeof (body as { transformToString?: unknown }).transformToString === "function"
  );
}

function isReadableStream(body: unknown): body is ReadableStream<Uint8Array> {
  return Boolean(body && typeof body === "object" && "getReader" in body);
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };

  return (
    candidate.name === "NoSuchKey"
    || candidate.name === "NotFound"
    || candidate.$metadata?.httpStatusCode === 404
  );
}

function isConditionalWriteConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };

  return (
    candidate.name === "PreconditionFailed"
    || candidate.name === "ConditionalRequestConflict"
    || candidate.$metadata?.httpStatusCode === 409
    || candidate.$metadata?.httpStatusCode === 412
  );
}
