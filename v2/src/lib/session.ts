import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Session-scoped isolation, per the plan: no accounts, no roles, no RBAC — but
 * also not anonymous free-for-all, because two visitors on the same deployment
 * seeing each other's uploaded code would be a correctness bug.
 *
 * The owner id is an opaque random value in an httpOnly cookie. It is a
 * visibility scope, not a credential: it is not authenticated, so this must not
 * be presented as a security boundary. What it does guarantee is that a
 * session's project list contains only that session's projects.
 */

export const OWNER_COOKIE = "mc_owner";
export const OWNER_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** Reads the owner id if this request already has one. Safe in any server component. */
export async function getOwnerId(): Promise<string | null> {
  const store = await cookies();
  return store.get(OWNER_COOKIE)?.value ?? null;
}

/** Creates a new owner id value. Callers set it via {@link setOwnerCookie}. */
export function newOwnerId(): string {
  return randomUUID();
}

/**
 * Sets the owner cookie. Only callable from a Server Action or Route Handler —
 * Next.js forbids cookie writes during a plain render, which is why the write
 * lives here rather than inside a page.
 */
export async function setOwnerCookie(ownerId: string): Promise<void> {
  const store = await cookies();
  store.set(OWNER_COOKIE, ownerId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: OWNER_COOKIE_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
}

/**
 * Returns the current owner id, minting and setting one if absent. The single
 * entry point every create path should use, so `ownerId` can never be null.
 */
export async function ensureOwnerId(): Promise<string> {
  const existing = await getOwnerId();
  if (existing) return existing;
  const ownerId = newOwnerId();
  await setOwnerCookie(ownerId);
  return ownerId;
}
