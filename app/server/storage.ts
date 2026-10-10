/**
 * Object storage for case files, over the S3 protocol: Alibaba Cloud OSS, Tencent COS, Cloudflare
 * R2, AWS S3, or a server of your own (RustFS, MinIO, SeaweedFS).
 *
 *   FDEGYM_S3_ENDPOINT           e.g. https://oss-cn-hangzhou.aliyuncs.com (not needed for AWS itself)
 *   FDEGYM_S3_REGION             default us-east-1; for OSS the region's name, e.g. oss-cn-hangzhou
 *   FDEGYM_S3_BUCKET             default fdegym
 *   FDEGYM_S3_ACCESS_KEY_ID      \
 *   FDEGYM_S3_SECRET_ACCESS_KEY  /  the key pair
 *   FDEGYM_S3_FORCE_PATH_STYLE   1: http://host/bucket/key (a server of your own); 0: http://bucket.host/key
 *                                (the cloud services, OSS among them). Default 1 when an endpoint is set.
 *   FDEGYM_S3_PREFIX             a folder inside the bucket to keep everything under
 *
 * With none of these set, the server uses the store that `docker compose up -d storage` starts on
 * this machine.
 */
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const env = process.env;
/** Local development only: what docker-compose.yml starts. */
const LOCAL = { endpoint: 'http://127.0.0.1:9000', accessKeyId: 'fdegym', secretAccessKey: 'fdegym-local-secret' };
const configured = !!(env.FDEGYM_S3_ENDPOINT || env.FDEGYM_S3_ACCESS_KEY_ID);

const endpoint = configured ? env.FDEGYM_S3_ENDPOINT || undefined : LOCAL.endpoint;
export const BUCKET = env.FDEGYM_S3_BUCKET || 'fdegym';
const prefix = (env.FDEGYM_S3_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
const at = (key: string) => (prefix ? `${prefix}/${key}` : key);

let client: S3Client | undefined;
function s3(): S3Client {
  client ??= new S3Client({
    region: env.FDEGYM_S3_REGION || 'us-east-1',
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: env.FDEGYM_S3_FORCE_PATH_STYLE ? env.FDEGYM_S3_FORCE_PATH_STYLE === '1' : !!endpoint,
    credentials: {
      accessKeyId: configured ? env.FDEGYM_S3_ACCESS_KEY_ID ?? '' : LOCAL.accessKeyId,
      secretAccessKey: configured ? env.FDEGYM_S3_SECRET_ACCESS_KEY ?? '' : LOCAL.secretAccessKey,
    },
    // Checksums the newer SDK adds on its own are refused by several S3-compatible services.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

/** Where the store is, for messages; never the keys. */
export const storageName = () => `${endpoint ?? 'AWS S3'} bucket ${BUCKET}${prefix ? `/${prefix}` : ''}`;

const status = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;

/**
 * Check the bucket can be reached, creating it where the store lets this key do so (a store of your
 * own, freshly started). On a cloud service the bucket is made in its console beforehand.
 */
export async function ensureBucket() {
  for (let attempt = 1; ; attempt++) {
    try {
      await s3().send(new HeadBucketCommand({ Bucket: BUCKET }));
      return;
    } catch (e) {
      if (status(e) === 404) { await s3().send(new CreateBucketCommand({ Bucket: BUCKET })); return; }
      // No answer at all: the store is still starting.
      if (status(e) === undefined && attempt < 30) { await new Promise((r) => setTimeout(r, 1000)); continue; }
      throw new Error(`cannot use object storage at ${storageName()}: ${(e as Error).name} ${(e as Error).message}`);
    }
  }
}

export async function hasObject(key: string): Promise<boolean> {
  try { await s3().send(new HeadObjectCommand({ Bucket: BUCKET, Key: at(key) })); return true; } catch (e) {
    if (status(e) === 404) return false;
    throw e;
  }
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: at(key), Body: body, ContentType: contentType, ContentLength: body.length }));
}

export async function getObject(key: string): Promise<Buffer> {
  const r = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: at(key) }));
  return Buffer.from(await r.Body!.transformToByteArray());
}
