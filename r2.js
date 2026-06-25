// Cloudflare R2 (S3-compatible) storage helper.
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import 'dotenv/config'

const BUCKET = process.env.R2_BUCKET

export const r2Enabled = !!(process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && BUCKET)

const client = r2Enabled
  ? new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null

export async function putObject(key, buffer, contentType) {
  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType || 'application/octet-stream',
  }))
  return key
}

// returns { stream, contentType } for piping to the HTTP response
export async function getObjectStream(key) {
  const out = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  return { stream: out.Body, contentType: out.ContentType }
}

export async function deleteObject(key) {
  try { await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })) } catch { /* ignore */ }
}
