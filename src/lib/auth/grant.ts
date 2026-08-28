/**
 * What a correct password buys you.
 *
 * `checkPassword` returns a **grant, never a boolean** (docs/PLAN.md D5). Today there is one
 * shared password and it grants everything, so a boolean would work — right up until the first
 * time you want to hand one friend a password for one event. At that point a boolean has to be
 * replaced everywhere it was stored, checked and serialised; a grant only needs a new variant.
 *
 * The cookie stores the grant, so authorisation is answered from the session without another
 * lookup.
 */

export type Grant = { scope: "all" } | { scope: { event: string } };

/** Does this grant permit reading the given event's photos? */
export function grantAllowsEvent(grant: Grant, event: string): boolean {
  return grant.scope === "all" || grant.scope.event === event;
}

/**
 * Runtime type guard, used when decoding an untrusted cookie payload. The signature proves the
 * cookie is ours; this proves it still has the shape this version of the code expects — an old
 * cookie from a future or past deploy is rejected rather than trusted.
 */
export function isGrant(value: unknown): value is Grant {
  if (typeof value !== "object" || value === null || !("scope" in value)) return false;
  const { scope } = value as { scope: unknown };
  if (scope === "all") return true;
  return (
    typeof scope === "object" &&
    scope !== null &&
    "event" in scope &&
    typeof (scope as { event: unknown }).event === "string"
  );
}
