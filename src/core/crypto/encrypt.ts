import type { EncryptedPayload } from "../../types/bookmark";
import {
  base64ToBytes,
  bytesToArrayBuffer,
  bytesToBase64,
  deriveAesGcmKey,
  randomBytes
} from "./keyDerivation";

export async function encryptJson(value: unknown, password: string): Promise<EncryptedPayload> {
  if (!password) {
    throw new Error("启用加密时必须填写加密密码。");
  }

  const iv = randomBytes(12);
  const derived = await deriveAesGcmKey(password);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bytesToArrayBuffer(iv)
    },
    derived.key,
    bytesToArrayBuffer(plaintext)
  );

  return {
    version: 1,
    algorithm: "AES-GCM",
    kdf: "PBKDF2",
    salt: derived.salt,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted))
  };
}

export async function decryptJson<T>(payload: EncryptedPayload, password: string): Promise<T> {
  if (!password) {
    throw new Error("远程文件已加密，请先填写加密密码。");
  }

  if (payload.version !== 1 || payload.algorithm !== "AES-GCM" || payload.kdf !== "PBKDF2") {
    throw new Error("不支持的加密文件格式。");
  }

  try {
    const derived = await deriveAesGcmKey(password, payload.salt);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesToArrayBuffer(base64ToBytes(payload.iv))
      },
      derived.key,
      bytesToArrayBuffer(base64ToBytes(payload.data))
    );

    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  } catch (error) {
    throw new Error(error instanceof Error ? `解密失败：${error.message}` : "解密失败，请检查密码。");
  }
}
