import { createHash } from "node:crypto";

/**
 * Content hash of an uploaded archive, used for duplicate detection.
 *
 * Hashing the archive bytes (not the extracted files) is the same choice V1
 * made and it is the right one: it makes "same upload" exact and cheap, and it
 * cannot be fooled by two archives that extract to identical trees but differ in
 * entry order or timestamps — those genuinely are separate uploads as far as the
 * user is concerned.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
