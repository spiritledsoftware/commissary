// The members and teams an org admin may name as approvers, read for a toolkit's page (#209): approvers show by name
// in a rule's summary, in a tool's row and in the rules editor. A plain member has neither list (the server keeps them
// from it), so for them there is no directory and a rule that names a team or members reads without names.
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { membersAtom, teamsAtom } from "../api/client.ts";
import type { ApproverDirectory } from "../lib/approval-rules.ts";

/** Where the lists are: not asked for (a plain member), loading, failed, or here. */
export type DirectoryState =
  | { readonly state: "none" }
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | { readonly state: "ready"; readonly directory: ApproverDirectory };

const AdminDirectory = ({
  children,
}: {
  readonly children: (state: DirectoryState) => ReactNode;
}) => {
  const members = useAtomValue(membersAtom);
  const teams = useAtomValue(teamsAtom);

  if (AsyncResult.isFailure(members) || AsyncResult.isFailure(teams))
    return children({ state: "failed" });

  if (!AsyncResult.isSuccess(members) || !AsyncResult.isSuccess(teams))
    return children({ state: "loading" });

  return children({
    state: "ready",
    directory: { members: members.value.members, teams: teams.value.teams },
  });
};

/** Reads the members and teams for an org admin only, and hands what it has to `children`. */
export const WithApproverDirectory = ({
  admin,
  children,
}: {
  readonly admin: boolean;
  readonly children: (state: DirectoryState) => ReactNode;
}) => (admin ? <AdminDirectory>{children}</AdminDirectory> : children({ state: "none" }));

/** The directory a state holds, if it is ready. */
export const directoryOf = (state: DirectoryState): ApproverDirectory | undefined =>
  state.state === "ready" ? state.directory : undefined;
