import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { signAccessToken } from './token.service';

/**
 * Storage adapter. Files are uploaded by the browser directly to the storage target
 * (presigned PUT for S3; an authenticated PUT to this API for the local driver) and
 * only metadata is written to MongoDB.
 */
export interface StorageDriver {
  readonly name: 'local' | 's3';
  presignUpload(key: string, mimeType: string, meta: { fileId: string; userId: string; orgId: string; role: string }): Promise<string>;
  presignDownload(key: string, fileName: string): Promise<string>;
  putObject(key: string, body: Buffer, mimeType: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
}

class LocalDriver implements StorageDriver {
  readonly name = 'local' as const;
  private root = path.resolve(env.LOCAL_STORAGE_DIR);
  private full(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root)) throw new Error('Invalid storage key');
    return p;
  }
  async presignUpload(key: string, _mime: string, meta: { fileId: string; userId: string; orgId: string; role: string }) {
    // Short-lived access token lets the browser PUT straight to /files/:id/upload
    const token = signAccessToken(meta.userId, meta.orgId, meta.role);
    return `${env.PUBLIC_API_URL}/api/v1/files/${meta.fileId}/upload?token=${encodeURIComponent(token)}&key=${encodeURIComponent(key)}`;
  }
  async presignDownload(key: string, _fileName: string) {
    return `${env.PUBLIC_API_URL}/api/v1/files/raw/${encodeURIComponent(key)}`;
  }
  async putObject(key: string, body: Buffer) {
    const p = this.full(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
  }
  async getObject(key: string) {
    return fs.readFile(this.full(key));
  }
  async deleteObject(key: string) {
    await fs.rm(this.full(key), { force: true });
  }
}

class S3Driver implements StorageDriver {
  readonly name = 's3' as const;
  private client = new S3Client({ region: env.AWS_REGION });
  private bucket = env.S3_BUCKET!;
  async presignUpload(key: string, mimeType: string) {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mimeType });
    return getSignedUrl(this.client, cmd, { expiresIn: 900 });
  }
  async presignDownload(key: string, fileName: string) {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: 300 });
  }
  async putObject(key: string, body: Buffer, mimeType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mimeType }));
  }
  async getObject(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async deleteObject(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let driver: StorageDriver | null = null;
export function storage(): StorageDriver {
  if (!driver) {
    if (env.STORAGE_DRIVER === 's3') {
      if (!env.S3_BUCKET || !env.AWS_REGION) throw new Error('S3_BUCKET and AWS_REGION are required when STORAGE_DRIVER=s3');
      driver = new S3Driver();
    } else driver = new LocalDriver();
  }
  return driver;
}

export function buildStorageKey(orgId: string, folder: string, fileName: string) {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
  return `${orgId}/${folder}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safe}`;
}
