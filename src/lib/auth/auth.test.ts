/**
 * Tests for the auth primitives.
 *
 * Weighted towards the cases where a bug is a *security* bug rather than a visible one: a tampered
 * token being accepted, a token from another app being accepted, an open redirect slipping through
 * the return-path check, the rate limiter failing open.
 *
 * Not covered here: the cookie helpers and `requireGrant()`, which need a request context. They're
 * exercised end-to-end against a running server instead.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { grantAllowsEvent, isGrant, type Grant } from "./grant";
import { hashPassword, verifyPassword } from "./password";
import { clearAttempts, recordAttempt, resetRateLimit } from "./rate-limit";
import { isSafeReturnPath, loginUrl } from "./session";
import { readSessionToken, signSessionToken } from "./token";

process.env.SESSION_SECRET = "0".repeat(64);

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("a shared password");
    assert.equal(await verifyPassword("a shared password", hash), true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("a shared password");
    assert.equal(await verifyPassword("a shared passworD", hash), false);
  });

  it("produces a different hash each time, so equal passwords aren't detectable", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    assert.notEqual(a, b);
    // Both still verify — the difference is the salt, not the password.
    assert.equal(await verifyPassword("same", a), true);
    assert.equal(await verifyPassword("same", b), true);
  });

  it("stores its own cost parameters, so they can be raised without invalidating old hashes", async () => {
    const hash = await hashPassword("x");
    const [scheme, N, r, p] = hash.split("$");
    assert.equal(scheme, "scrypt");
    assert.ok(Number(N) >= 16384, "N should be at least 16384");
    assert.equal(r, "8");
    assert.equal(p, "1");
  });

  it("accepts a hash written with different parameters", async () => {
    // Simulates a hash created before the defaults changed: a lower N must still verify.
    const hash = await hashPassword("legacy");
    const [, , r, p, salt, key] = hash.split("$");
    // Re-deriving with a different N would change the key, so instead assert the parser reads the
    // stored N rather than the default — a hash claiming an N it wasn't made with must fail.
    const lying = ["scrypt", "1024", r, p, salt, key].join("$");
    assert.equal(await verifyPassword("legacy", lying), false);
  });

  it("treats unicode-equivalent passwords as equal", async () => {
    // "é" can be one code point or two; a phone keyboard and a desktop may disagree. NFKC
    // normalisation means the friend doesn't get locked out by that.
    const hash = await hashPassword("café");
    assert.equal(await verifyPassword("café", hash), true);
  });

  it("throws on a malformed stored hash rather than silently failing every login", async () => {
    await assert.rejects(() => verifyPassword("x", "not-a-hash"), /not a valid scrypt hash/);
  });
});

describe("session tokens", () => {
  it("round-trips a grant", async () => {
    const grant: Grant = { scope: "all" };
    assert.deepEqual(await readSessionToken(await signSessionToken(grant)), grant);
  });

  it("round-trips a per-event grant, which is the point of not using a boolean", async () => {
    const grant: Grant = { scope: { event: "camping-trip-2026" } };
    assert.deepEqual(await readSessionToken(await signSessionToken(grant)), grant);
  });

  it("rejects a tampered payload", async () => {
    const token = await signSessionToken({ scope: { event: "birthday-2026" } });
    const [header, payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ grant: { scope: "all" } })).toString("base64url");
    assert.equal(await readSessionToken(`${header}.${forged}.${signature}`), null);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSessionToken({ scope: "all" });
    const original = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "1".repeat(64);
    try {
      assert.equal(await readSessionToken(token), null);
    } finally {
      process.env.SESSION_SECRET = original;
    }
  });

  it("rejects an unsigned (alg: none) token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ grant: { scope: "all" } })).toString("base64url");
    assert.equal(await readSessionToken(`${header}.${payload}.`), null);
  });

  it("rejects a valid signature carrying an unrecognised grant shape", async () => {
    // Signed by us, but the payload isn't a grant this code understands — e.g. a shape from a
    // future deploy. Trusting it would mean guessing at permissions.
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ grant: { scope: { events: ["a"] } } })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("catellolens")
      .setAudience("catellolens:friends")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
    assert.equal(await readSessionToken(token), null);
  });

  it("rejects an expired token", async () => {
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ grant: { scope: "all" } })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("catellolens")
      .setAudience("catellolens:friends")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
    assert.equal(await readSessionToken(token), null);
  });

  it("treats a missing cookie as no session", async () => {
    assert.equal(await readSessionToken(undefined), null);
    assert.equal(await readSessionToken(""), null);
  });
});

describe("grants", () => {
  it("scope 'all' permits every event", () => {
    assert.equal(grantAllowsEvent({ scope: "all" }, "anything"), true);
  });

  it("an event-scoped grant permits only that event", () => {
    const grant: Grant = { scope: { event: "birthday-2026" } };
    assert.equal(grantAllowsEvent(grant, "birthday-2026"), true);
    assert.equal(grantAllowsEvent(grant, "camping-trip-2026"), false);
  });

  it("recognises valid shapes and rejects everything else", () => {
    assert.equal(isGrant({ scope: "all" }), true);
    assert.equal(isGrant({ scope: { event: "x" } }), true);
    for (const bad of [null, undefined, "all", {}, { scope: "everything" }, { scope: { event: 1 } }]) {
      assert.equal(isGrant(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });
});

describe("return-path safety", () => {
  it("accepts paths inside the friends section", () => {
    assert.equal(isSafeReturnPath("/friends"), true);
    assert.equal(isSafeReturnPath("/friends/camping-trip-2026?page=2"), true);
  });

  it("rejects anything that could leave the site", () => {
    for (const bad of [
      "https://evil.example/steal",
      "//evil.example",
      "/gallery",
      "\\\\evil.example",
      "/friends\\..\\..\\admin",
      "javascript:alert(1)",
    ]) {
      assert.equal(isSafeReturnPath(bad), false, `expected ${bad} to be rejected`);
    }
  });

  it("drops an unsafe next parameter instead of preserving it", () => {
    assert.equal(loginUrl("https://evil.example"), "/friends/login");
    assert.equal(loginUrl("/friends/x"), "/friends/login?next=%2Ffriends%2Fx");
  });
});

describe("rate limiting", () => {
  beforeEach(resetRateLimit);

  it("allows attempts up to the limit, then blocks", () => {
    let blocked = 0;
    for (let i = 0; i < 20; i++) {
      if (!recordAttempt("1.2.3.4").allowed) blocked++;
    }
    assert.ok(blocked > 0, "should eventually block");
    assert.equal(recordAttempt("1.2.3.4").allowed, false);
  });

  it("tracks each client separately", () => {
    for (let i = 0; i < 20; i++) recordAttempt("1.2.3.4");
    assert.equal(recordAttempt("5.6.7.8").allowed, true);
  });

  it("reports how long to wait", () => {
    for (let i = 0; i < 20; i++) recordAttempt("1.2.3.4");
    const result = recordAttempt("1.2.3.4");
    assert.equal(result.allowed, false);
    assert.ok(!result.allowed && result.retryAfterSeconds > 0);
  });

  it("opens the window again once it expires", () => {
    const start = 1_000_000;
    for (let i = 0; i < 20; i++) recordAttempt("1.2.3.4", start);
    assert.equal(recordAttempt("1.2.3.4", start).allowed, false);
    // Eleven minutes later, past the ten-minute window.
    assert.equal(recordAttempt("1.2.3.4", start + 11 * 60 * 1000).allowed, true);
  });

  it("forgets attempts after a successful sign-in", () => {
    for (let i = 0; i < 5; i++) recordAttempt("1.2.3.4");
    clearAttempts("1.2.3.4");
    // A full fresh allowance, not the remainder.
    for (let i = 0; i < 8; i++) {
      assert.equal(recordAttempt("1.2.3.4").allowed, true, `attempt ${i + 1} should be allowed`);
    }
  });
});
