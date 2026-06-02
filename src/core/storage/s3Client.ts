import { S3Client } from "@aws-sdk/client-s3";
import type { S3Config } from "../../types/bookmark";

export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    region: config.region || "auto",
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle ?? true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}
