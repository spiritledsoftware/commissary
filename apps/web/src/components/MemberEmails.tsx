// The org's members' emails by id, for the pages that name a starter by id (#234: the runs list and a run's page). Only
// an org admin reads the members (`GET /members` answers anyone else `403`), so only their pages ask: anyone else's get
// no emails, and nothing is read for them.
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { membersAtom } from "../api/client.ts";

const NO_EMAILS: ReadonlyMap<string, string> = new Map();

type Render = (emails: ReadonlyMap<string, string>) => ReactNode;

/** An org admin's: reads the members, and hands `children` their emails once read (none until then). */
const AdminEmails = ({ children }: { readonly children: Render }) => {
  const members = useAtomValue(membersAtom);

  return children(
    AsyncResult.isSuccess(members)
      ? new Map(members.value.members.map((member) => [member.id, member.email]))
      : NO_EMAILS,
  );
};

/** Hands `children` the members' emails by id: read for an org admin (`admin`), none for anyone else. */
export const WithMemberEmails = ({
  admin,
  children,
}: {
  readonly admin: boolean;
  readonly children: Render;
}) => (admin ? <AdminEmails>{children}</AdminEmails> : children(NO_EMAILS));
