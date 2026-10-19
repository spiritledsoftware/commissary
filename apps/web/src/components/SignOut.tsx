// Ends the session of Commissary Cloud on the auth host (ADR 0030) and goes to the sign-in page. Rendered only where `me.deployment.hosted` is true: a button
// on the org chooser and the People page, an item of the account menu in the shell.
import { LogOut } from "lucide-react";
import { type Ref, useState } from "react";
import { AUTH_ROUTES, SIGN_IN_PAGE_PATH } from "@commissary/contract/sign-in";
import { onAuthHost } from "../auth-origin.ts";

export interface SignOutProps {
  readonly className?: string | undefined;
  /** As an item of a menu: `menuitem`, out of the tab order. */
  readonly role?: "menuitem" | undefined;
  readonly ref?: Ref<HTMLButtonElement> | undefined;
}

export const SignOut = ({ className, role, ref }: SignOutProps) => {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const signOut = async () => {
    setBusy(true);
    setFailed(false);

    try {
      const response = await fetch(onAuthHost(AUTH_ROUTES.signOut), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      if (response.ok) {
        window.location.assign(SIGN_IN_PAGE_PATH);

        return;
      }
    } catch {
      // The failure is reported below, like a refusal.
    }

    setFailed(true);
    setBusy(false);
  };

  return (
    <button
      ref={ref}
      type="button"
      role={role}
      tabIndex={role === undefined ? undefined : -1}
      className={className}
      disabled={busy}
      aria-busy={busy}
      title={failed ? "Sign-out failed. Try again." : "Sign out"}
      onClick={signOut}
    >
      <LogOut aria-hidden="true" size={16} strokeWidth={2.25} />
      <span>{failed ? "Try sign out again" : "Sign out"}</span>
    </button>
  );
};
