/**
 * Grant subjects (`@commissary/contract/grants`: everyone, one member or one team) as the Tools part's grants store and
 * read them: tool grants (`store.ts`) and browser profile grants (`browser/profiles.ts`, #215) alike.
 */
import type { GrantSubject } from "@commissary/contract/grants";

/** Who asks: the member of the request, if any, and the teams they belong to. */
export interface GrantHolder {
  readonly member?: string | undefined;
  readonly teams: ReadonlyArray<string>;
}

/** Whether `subject` names `holder`: everyone does, a member subject their member id, a team subject one of their teams. */
export const namesHolder = (subject: GrantSubject, holder: GrantHolder): boolean => {
  switch (subject.kind) {
    case "everyone":
      return true;
    case "member":
      return holder.member !== undefined && subject.id === holder.member;
    case "team":
      return holder.teams.includes(subject.id);
  }
};

/** A subject with its id trimmed. */
export const trimmedSubject = (subject: GrantSubject): GrantSubject =>
  subject.kind === "everyone" ? subject : { kind: subject.kind, id: subject.id.trim() };

/** The `subject_kind` and `subject_id` columns of a subject. */
export const subjectColumns = (subject: GrantSubject): readonly [string, string] =>
  subject.kind === "everyone" ? ["everyone", ""] : [subject.kind, subject.id];

/** The subject of a row's columns; none for a kind this version does not know (it gives nothing, never everyone). */
export const subjectOfColumns = (kind: string, id: string): GrantSubject | undefined => {
  switch (kind) {
    case "everyone":
      return { kind: "everyone" };
    case "member":
    case "team":
      return { kind, id };
    default:
      return undefined;
  }
};
