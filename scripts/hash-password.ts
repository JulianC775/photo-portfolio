/**
 * Turns a password into the value for `FRIENDS_PASSWORD_HASH`.
 *
 *   npm run hash-password -- 'the shared password'
 *   npm run hash-password              # prompts, so the password stays out of your shell history
 *
 * The hash is safe to paste into the Vercel dashboard and into `.env.local`; the password itself
 * should never be stored anywhere (docs/PLAN.md D5).
 */
import { createInterface } from "node:readline/promises";

import { hashPassword } from "../src/lib/auth/password";

async function main() {
  // Everything after `--`. Joined rather than [0] so an unquoted password with spaces still works.
  const fromArgs = process.argv.slice(2).join(" ").trim();
  const password = fromArgs || (await prompt());

  if (!password) {
    console.error("No password given.");
    process.exit(1);
  }
  if (password.length < 8) {
    // Not a policy, a floor. This password is shared by hand with friends, so length is the only
    // strength lever that survives being read aloud over the phone.
    console.error("That's under 8 characters. Pick something longer.");
    process.exit(1);
  }

  const hash = await hashPassword(password);

  console.log("\nAdd this to .env.local and to the Vercel environment variables:\n");
  console.log(`FRIENDS_PASSWORD_HASH=${hash}\n`);
  if (fromArgs) {
    console.log("Note: the password was passed as an argument, so it's in your shell history.");
    console.log("Run `history -d` (or clear it) if that matters to you.\n");
  }
}

async function prompt(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Not masked: Node's readline can't hide input without more machinery than this is worth, and
    // the alternative (an argument) is worse because it persists in history.
    return (await rl.question("Password to hash (visible as you type): ")).trim();
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
