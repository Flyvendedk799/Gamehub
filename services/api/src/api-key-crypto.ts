import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const CIPHER_VERSION = 'v1';

function keyFromSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function last4OfApiKey(apiKey: string): string {
  return apiKey.trim().slice(-4);
}

export function encryptApiKey(apiKey: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CIPHER_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export function decryptApiKey(envelope: string, secret: string): string {
  const [version, ivRaw, tagRaw, ciphertextRaw] = envelope.split(':');
  if (
    version !== CIPHER_VERSION ||
    ivRaw === undefined ||
    tagRaw === undefined ||
    ciphertextRaw === undefined
  ) {
    throw new Error('unsupported_api_key_ciphertext');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFromSecret(secret),
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}
