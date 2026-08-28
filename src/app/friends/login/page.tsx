import { isSafeReturnPath } from "@/lib/auth";
import { LoginForm } from "./login-form";

// Metadata (including noindex) comes from the friends layout — see the note there. This page needs
// no metadata of its own beyond the title the layout template supplies.
export const metadata = { title: "Friends" };

type Props = { searchParams: Promise<{ next?: string }> };

export default async function LoginPage({ searchParams }: Props) {
  const { next } = await searchParams;
  // Sanitised here as well as in the action: this value is about to be rendered into the page, and
  // an unchecked one would be an open-redirect waiting for the form to trust it.
  const returnTo = next && isSafeReturnPath(next) ? next : undefined;

  return (
    <div className="mx-auto flex min-h-[70svh] max-w-sm flex-col justify-center px-6 py-24">
      <h1 className="text-2xl font-light tracking-tight">Friends</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted">
        Photos of you, sorted by event, at full resolution. Enter the password I sent you.
      </p>

      <LoginForm next={returnTo} />
    </div>
  );
}
