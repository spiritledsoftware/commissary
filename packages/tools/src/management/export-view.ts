/**
 * Tools' section of the export of an org (`GET /v9/management/export`, ADR 0027; the app Worker's `org-routes.ts` builds
 * the rest, #134 "The area package convention"): the toolkits the caller reaches, with their sources, which credentials
 * they accept, what kind of credential is connected (never a secret), the overrides on their tools and, in an org
 * admin's export, each org toolkit's tool grants (subjects by email or team name, tools by upstream name), and their
 * approval rules (approvers by email or team name). Tool lists are not part of it: they are rebuilt from the sources;
 * nor are pending approvals, which hold a call's arguments for an hour at most, nor uploaded documents (OpenAPI or
 * Discovery documents, GraphQL schemas; a toolkit built from one says `uploaded: true`): its managers download one from
 * `GET /toolkits/:id/document`.
 */
import { Effect } from "effect";
import { currentViewer } from "@commissary/auth";
import { toolsControlPlane } from "../env.ts";

/** Tools' section of the current org's export, as the caller may see it. */
export const exportSection = Effect.gen(function* () {
  const viewer = yield* currentViewer;

  const toolkits = yield* toolsControlPlane("exportToolkits", (stub) =>
    // This Worker decodes the agents toolkit's kind (#229).
    stub.tools().exportToolkits(viewer, { agentsToolkit: true }),
  );

  return { toolkits };
});
