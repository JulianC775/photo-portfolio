"use client";

/**
 * The one Client Component in the app so far, and the reason is `useActionState`.
 *
 * A plain form posting to the Server Action would work without any JavaScript — and still does if
 * JS fails to load, because that's what a form action degrades to. What client state buys is
 * showing "that password doesn't match" inline without putting the failure in the URL, and
 * disabling the button while the check is in flight. Since the check is a deliberately slow scrypt
 * derivation, a submit button with no pending state invites double-submits.
 */
import { useActionState } from "react";

import { signIn, type LoginState } from "./actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(signIn, {});

  return (
    <form action={formAction} className="mt-8">
      {/* Where to land after signing in. Validated server-side — never trusted from here. */}
      {next && <input type="hidden" name="next" value={next} />}

      <label htmlFor="password" className="block text-sm text-muted">
        Password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        required
        autoFocus
        autoComplete="current-password"
        aria-describedby={state.error ? "password-error" : undefined}
        aria-invalid={state.error ? true : undefined}
        className="mt-2 w-full border-b border-line bg-transparent pb-2 text-base text-paper outline-none transition-colors focus:border-paper"
      />

      {state.error && (
        // aria-live so the message is announced when it appears, not just visible.
        <p id="password-error" role="alert" aria-live="polite" className="mt-3 text-sm text-paper/90">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-8 border-b border-line pb-1 text-sm tracking-wide text-paper transition-colors hover:border-paper disabled:cursor-not-allowed disabled:text-muted"
      >
        {pending ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}
