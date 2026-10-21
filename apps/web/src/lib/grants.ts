// The Grants page's model (ADR 0023): a grant as the form edits it, what is wrong with a draft, the body a draft becomes,
// what a refused write tells the operator, and how grants are read by member, by team or by credential. Pure: no DOM,
// tested in test/grants.test.ts.
import type { Grant, GrantBody, GrantScope, GrantSubject } from "@commissary/contract/grants";
import type { MemberView, TeamView } from "@commissary/contract/members";
import { Option, Schema } from "effect";
import { flow } from "effect/Function";
import { asSentence } from "./failure.ts";
import { lenient } from "./usage.ts";

/** Which grants the page lists: those of models or those of tools (#209). */
export type GrantsArea = "models" | "tools";

export const GRANTS_AREAS: ReadonlyArray<{ readonly id: GrantsArea; readonly label: string }> = [
  { id: "models", label: "Models" },
  { id: "tools", label: "Tools" },
];

/** The page's address: `/grants?area=tools`. A malformed parameter reads as none, which is the model grants. */
export const GrantsSearch = Schema.Struct({ area: lenient(Schema.Literals(["models", "tools"])) });

export type GrantsSearch = typeof GrantsSearch.Type;

export const readGrantsSearch = flow(
  Schema.decodeUnknownOption(GrantsSearch),
  Option.getOrElse((): GrantsSearch => ({})),
);

/** The area an address names. */
export const grantsAreaOf = (search: GrantsSearch): GrantsArea =>
  search.area === "tools" ? "tools" : "models";

export type GrantsView = "member" | "team" | "credential";

export const GRANTS_VIEWS: ReadonlyArray<{ readonly view: GrantsView; readonly label: string }> = [
  { view: "member", label: "By member" },
  { view: "team", label: "By team" },
  { view: "credential", label: "By credential" },
];

/** Provider keys of accounts and keys Commissary serves: suggestions for a provider scope. */
export const GRANT_PROVIDERS: ReadonlyArray<string> = [
  "antigravity",
  "claude",
  "codex",
  "devin",
  "gemini",
  "gemini-interactions",
  "kimi",
  "meta",
  "opencode-go",
  "opencode-zen",
  "subq",
  "typesafe",
  "vertex",
  "xai",
];

/** Each field as chosen or typed. `subjectId` is a member or team id, `scopeValue` a provider key or credential id. */
export interface GrantDraft {
  readonly subjectKind: GrantSubject["kind"];
  readonly subjectId: string;
  readonly scopeKind: GrantScope["kind"];
  readonly scopeValue: string;
  /** Model patterns, separated by commas, spaces or lines. */
  readonly models: string;
}

/** The message of each field that is wrong; a subject and scope another grant already has is reported under `subject`. */
export interface GrantErrors {
  subject?: string;
  scope?: string;
  models?: string;
}

export const EMPTY_GRANT_DRAFT: GrantDraft = {
  subjectKind: "member",
  subjectId: "",
  scopeKind: "all",
  scopeValue: "",
  models: "",
};

/** Patterns as the server keeps them: lower-case, trimmed, de-duplicated, in the order first written. */
export const parsePatterns = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map((pattern) => pattern.trim().toLowerCase())
      .filter((pattern) => pattern !== ""),
  ),
];

const patternsText = (models: ReadonlyArray<string>): string => models.join(", ");

export const subjectOf = (draft: GrantDraft): GrantSubject =>
  draft.subjectKind === "everyone"
    ? { kind: "everyone" }
    : { kind: draft.subjectKind, id: draft.subjectId.trim() };

export const scopeOf = (draft: GrantDraft): GrantScope => {
  switch (draft.scopeKind) {
    case "all":
      return { kind: "all" };
    case "provider":
      return { kind: "provider", provider: draft.scopeValue.trim().toLowerCase() };
    case "credential":
      return { kind: "credential", id: draft.scopeValue.trim() };
  }
};

export const grantBody = (draft: GrantDraft): GrantBody => ({
  subject: subjectOf(draft),
  scope: scopeOf(draft),
  models: parsePatterns(draft.models),
});

/** The form's fields for a grant being edited. */
const scopeValueOf = (scope: GrantScope): string => {
  switch (scope.kind) {
    case "all":
      return "";
    case "provider":
      return scope.provider;
    case "credential":
      return scope.id;
  }
};

export const draftOf = (grant: Grant): GrantDraft => ({
  subjectKind: grant.subject.kind,
  subjectId: grant.subject.kind === "everyone" ? "" : grant.subject.id,
  scopeKind: grant.scope.kind,
  scopeValue: scopeValueOf(grant.scope),
  models: patternsText(grant.models),
});

const sameSubject = (a: GrantSubject, b: GrantSubject): boolean =>
  a.kind === b.kind && (a.kind === "everyone" || (b.kind !== "everyone" && a.id === b.id));

const sameScope = (a: GrantScope, b: GrantScope): boolean => {
  switch (a.kind) {
    case "all":
      return b.kind === "all";
    case "provider":
      return b.kind === "provider" && a.provider === b.provider;
    case "credential":
      return b.kind === "credential" && a.id === b.id;
  }
};

/** The grant that already has the draft's subject and scope, other than the one being edited. */
const grantOfPair = (
  draft: GrantDraft,
  grants: ReadonlyArray<Grant>,
  editing?: Grant,
): Grant | undefined =>
  grants.find(
    (grant) =>
      grant.id !== editing?.id &&
      sameSubject(grant.subject, subjectOf(draft)) &&
      sameScope(grant.scope, scopeOf(draft)),
  );

/** What is wrong with a draft, mirroring the server's checks; empty when it will do. */
export const validateGrant = (
  draft: GrantDraft,
  grants: ReadonlyArray<Grant>,
  editing?: Grant,
): GrantErrors => {
  const errors: GrantErrors = {};

  if (draft.subjectKind !== "everyone" && draft.subjectId.trim() === "")
    errors.subject = draft.subjectKind === "member" ? "Choose a member." : "Choose a team.";

  if (draft.scopeKind === "provider" && draft.scopeValue.trim() === "")
    errors.scope = "Name the provider.";

  if (draft.scopeKind === "credential" && draft.scopeValue.trim() === "")
    errors.scope = "Choose an account.";

  if (parsePatterns(draft.models).length === 0)
    errors.models = "Name at least one model, or * for every model.";

  if (
    errors.subject === undefined &&
    errors.scope === undefined &&
    grantOfPair(draft, grants, editing) !== undefined
  )
    errors.subject = "This subject already has a grant for these accounts. Edit that one.";

  return errors;
};

export const hasGrantErrors = (errors: GrantErrors): boolean => Object.keys(errors).length > 0;

/** What a refused grant write says, by the server's error code. */
export const grantProblem = (error: string | undefined, message: string): string => {
  switch (error) {
    case "conflict":
      return "The grants changed elsewhere while this page was open. Reload to see the current grants, then make the edit again.";
    case "invalid_config":
      return asSentence(message);
    default:
      return message;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Reading grants

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface Directory {
  readonly members: ReadonlyArray<MemberView>;
  readonly teams: ReadonlyArray<TeamView>;
}

export const subjectLabel = (subject: GrantSubject, directory: Directory): string => {
  switch (subject.kind) {
    case "everyone":
      return "Everyone";
    case "member":
      return directory.members.find((member) => member.id === subject.id)?.email ?? subject.id;
    case "team":
      return directory.teams.find((team) => team.id === subject.id)?.name ?? subject.id;
  }
};

export const scopeLabel = (scope: GrantScope): string => {
  switch (scope.kind) {
    case "all":
      return "All shared credentials";
    case "provider":
      return `Every ${scope.provider} account`;
    case "credential":
      return scope.id;
  }
};

/** Everyone first, then teams, then members; each by name. */
export const sortGrants = (
  grants: ReadonlyArray<Grant>,
  directory: Directory,
): ReadonlyArray<Grant> => {
  const rank = { everyone: 0, team: 1, member: 2 } as const;

  return grants.toSorted(
    (a, b) =>
      rank[a.subject.kind] - rank[b.subject.kind] ||
      compare(subjectLabel(a.subject, directory), subjectLabel(b.subject, directory)) ||
      compare(scopeLabel(a.scope), scopeLabel(b.scope)),
  );
};

/** A heading and the grants listed under it. */
export interface GrantGroup {
  readonly key: string;
  readonly label: string;
  readonly grants: ReadonlyArray<Grant>;
}

const appliesToMember = (grant: Grant, member: MemberView): boolean => {
  switch (grant.subject.kind) {
    case "everyone":
      return true;
    case "member":
      return grant.subject.id === member.id;
    case "team":
      return member.teams.includes(grant.subject.id);
  }
};

const scopeKey = (scope: GrantScope): string => {
  switch (scope.kind) {
    case "all":
      return "all";
    case "provider":
      return `provider:${scope.provider}`;
    case "credential":
      return `credential:${scope.id}`;
  }
};

/**
 * The grants read by member (what reaches each member: their own, their teams' and everyone's), by team (what each
 * team and everyone is given) or by credential (who may use each account, provider or all of them).
 */
export const groupGrants = (
  grants: ReadonlyArray<Grant>,
  view: GrantsView,
  directory: Directory,
): ReadonlyArray<GrantGroup> => {
  const sorted = sortGrants(grants, directory);

  switch (view) {
    case "member":
      return directory.members
        .toSorted((a, b) => compare(a.email, b.email))
        .map((member) => ({
          key: member.id,
          label: member.email,
          grants: sorted.filter((grant) => appliesToMember(grant, member)),
        }));
    case "team":
      return [
        {
          key: "everyone",
          label: "Everyone",
          grants: sorted.filter((grant) => grant.subject.kind === "everyone"),
        },
        ...directory.teams
          .toSorted((a, b) => compare(a.name, b.name))
          .map((team) => ({
            key: team.id,
            label: team.name,
            grants: sorted.filter(
              (grant) => grant.subject.kind === "team" && grant.subject.id === team.id,
            ),
          })),
      ];
    case "credential": {
      const scopes = new Map<string, { label: string; grants: Grant[] }>();

      for (const grant of sorted) {
        const key = scopeKey(grant.scope);
        const group = scopes.get(key) ?? { label: scopeLabel(grant.scope), grants: [] };
        group.grants.push(grant);
        scopes.set(key, group);
      }

      return [...scopes]
        .toSorted(([a], [b]) => compare(a, b))
        .map(([key, group]) => ({ key, ...group }));
    }
  }
};

/** Whether a grant gives every model. */
export const givesEveryModel = (grant: Pick<Grant, "models">): boolean =>
  grant.models.includes("*");

// ---------------------------------------------------------------------------------------------------------------
// My models

/** The models whose id or display name contains `query` (case-insensitive); all of them for a blank query. */
export const filterMyModels = <A extends { readonly id: string; readonly display_name?: string }>(
  models: ReadonlyArray<A>,
  query: string,
): ReadonlyArray<A> => {
  const needle = query.trim().toLowerCase();

  return needle === ""
    ? models
    : models.filter(
        (model) =>
          model.id.toLowerCase().includes(needle) ||
          (model.display_name ?? "").toLowerCase().includes(needle),
      );
};

/** What an empty list of models means to the member who reads it. */
export const modelsNote = (count: number): string =>
  count === 0
    ? "No models are granted to you yet. Ask an org admin to give you or your team some on the Grants page."
    : "";
