const PBKDF2_ITERATIONS = 210_000;
const AES_KEY_LENGTH = 256;

export interface DerivedKeyResult {
  key: CryptoKey;
  salt: string;
}

export async function deriveAesGcmKey(password: string, salt?: string): Promise<DerivedKeyResult> {
  const saltBytes = salt ? base64ToBytes(salt) : randomBytes(16);
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: bytesToArrayBuffer(saltBytes),
      iterations: PBKDF2_ITERATIONS
    },
    passwordKey,
    {
      name: "AES-GCM",
      length: AES_KEY_LENGTH
    },
    false,
    ["encrypt", "decrypt"]
  );

  return {
    key,
    salt: bytesToBase64(saltBytes)
  };
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
