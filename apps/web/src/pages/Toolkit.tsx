// One toolkit (/tools/$toolkitId, #208): what it is and where it comes from, what needs attention, its sign-ins (the
// shared credential for org admins, the caller's own where the toolkit and the org take one), its tool list, its prices
// (org admins) and approval rules (org admins, or the owner of a private toolkit, #209), and, for its managers, its
// settings. The server decides what the caller sees; the page offers only what it would accept
// (`controlsFor`).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import type { ToolkitView } from "@commissary/contract/tools";
import { meAtom, toolkitsAtom } from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatCount, formatDate } from "../lib/format.ts";
import {
  acceptsLabel,
  controlsFor,
  flagsOf,
  kindLabel,
  noPrivateCredentialText,
  sourceText,
  type ToolkitControls,
  type ToolsCaller,
  toolsCallerOf,
} from "../lib/toolkits.ts";
import { type ApproverDirectory, rulesSummary } from "../lib/approval-rules.ts";
import { approvalRulesWarnings } from "../lib/approvals.ts";
import { callPriceText, formatPrice } from "../lib/tool-prices.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { directoryOf, WithApproverDirectory } from "./ApproverDirectory.tsx";
import { CredentialSlotBlock } from "./ToolkitCredential.tsx";
import { TrailMark } from "../components/Signs.tsx";
import { Flags } from "./ToolkitFlags.tsx";
import { ToolkitApprovals } from "./ToolkitApprovals.tsx";
import { ToolkitPrices } from "./ToolkitPrices.tsx";
import { ToolkitSettings } from "./ToolkitSettings.tsx";
import { ToolList } from "./ToolkitTools.tsx";
import styles from "./Tools.module.css";

const route = getRouteApi("/tools/$toolkitId");

/**
 * Loads the toolkits and the caller, then renders `children` with the toolkit `id` names (the list holds every toolkit
 * the caller may see; there is no read of one).
 */
export const WithToolkit = ({
  id,
  children,
}: {
  readonly id: string;
  readonly children: (toolkit: ToolkitView, caller: ToolsCaller) => ReactNode;
}) => {
  const result = useAtomValue(toolkitsAtom);
  const retry = useAtomRefresh(toolkitsAtom);
  const me = useAtomValue(meAtom);

  if (!AsyncResult.isSuccess(me)) return null;
  const caller = toolsCallerOf(me.value);

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the toolkit…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load the toolkit. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => {
      const toolkit = value.toolkits.find((each) => each.id === id);

      return toolkit === undefined ? (
        <Problem>
          That toolkit is gone, or is not one you can use. An org admin grants an org
          toolkit&rsquo;s tools on the Grants page.
        </Problem>
      ) : (
        children(toolkit, caller)
      );
    },
  });
};

const Facts = ({
  toolkit,
  directory,
  approvals,
}: {
  readonly toolkit: ToolkitView;
  /** Whether the page has the Approvals section, which holds the full warning. */
  readonly approvals: boolean;
  /** The members and teams, to name approvers: org admins have them. */
  readonly directory: ApproverDirectory | undefined;
}) => {
  const list = toolkit.tool_list;
  const summary = rulesSummary(toolkit.approval_rules, directory);

  const warnings =
    toolkit.approval_rules === undefined ? [] : approvalRulesWarnings(toolkit.approval_rules);

  return (
    <dl className={styles["facts"]}>
      <dt>Kind</dt>
      <dd>{kindLabel(toolkit.kind)}</dd>
      <dt>Source</dt>
      <dd>{sourceText(toolkit)}</dd>
      {toolkit.base_url === undefined ? null : (
        <>
          <dt>Base URL</dt>
          <dd>{toolkit.base_url}</dd>
        </>
      )}
      <dt>Whose</dt>
      <dd>{toolkit.private ? "Yours, private" : "The org's"}</dd>
      {toolkit.private || toolkit.built_in === true ? null : (
        <>
          <dt>Accepts</dt>
          <dd>{acceptsLabel(toolkit.accepts)}</dd>
        </>
      )}
      {toolkit.credentials.private_count === undefined ? null : (
        <>
          <dt>Private credentials</dt>
          <dd>
            {toolkit.credentials.private_count === 1
              ? "1 member connected one"
              : `${formatCount(toolkit.credentials.private_count)} members connected one`}
          </dd>
        </>
      )}
      {toolkit.private || toolkit.built_in === true ? null : (
        <>
          <dt>Price</dt>
          <dd>
            {callPriceText(toolkit.price_micros)}
            {toolkit.price_micros === undefined ? "" : ", unless a tool is priced on its own"}
          </dd>
        </>
      )}
      {toolkit.browser_hour_price_micros === undefined ? null : (
        <>
          <dt>Price</dt>
          <dd>{formatPrice(toolkit.browser_hour_price_micros)} per browser hour</dd>
        </>
      )}
      {toolkit.computer_hour_price_micros === undefined ? null : (
        <>
          <dt>Price</dt>
          <dd>{formatPrice(toolkit.computer_hour_price_micros)} per computer hour</dd>
        </>
      )}
      {summary === undefined ? null : (
        <>
          <dt>Approval</dt>
          <dd>
            {summary}
            {warnings.length === 0 ? null : approvals ? (
              <span className={styles["flag"]}>
                <TrailMark />
                <a href="#approvals">
                  {warnings.length === 1
                    ? "A rule nobody can approve under"
                    : `${warnings.length} rules nobody can approve under`}
                  : see Approvals
                </a>
              </span>
            ) : (
              <Flags
                flags={warnings.map((text) => ({ text, severity: "failing" as const }))}
                label="Rules nobody can approve under"
              />
            )}
          </dd>
        </>
      )}
      <dt>Listed</dt>
      <dd>{list.built_at === undefined ? "Not yet" : formatDate(Date.parse(list.built_at))}</dd>
      {toolkit.catalog === undefined ? null : (
        <>
          <dt>From the catalog</dt>
          <dd>{toolkit.catalog.service}</dd>
        </>
      )}
    </dl>
  );
};

const SignIns = ({
  toolkit,
  caller,
  controls,
}: {
  readonly toolkit: ToolkitView;
  readonly caller: ToolsCaller;
  readonly controls: ToolkitControls;
}) => (
  <Section title="Sign-in" className={styles["section"]}>
    {!controls.shared && !controls.private ? (
      <p className={styles["empty"]}>{noPrivateCredentialText(toolkit, caller)}</p>
    ) : (
      <div className={styles["slots"]}>
        {controls.shared ? (
          <CredentialSlotBlock toolkit={toolkit} slot="shared" manage={controls.manage} />
        ) : null}
        {controls.private ? (
          <CredentialSlotBlock toolkit={toolkit} slot="private" manage={controls.manage} />
        ) : null}
      </div>
    )}
  </Section>
);

const Details = ({
  toolkit,
  caller,
}: {
  readonly toolkit: ToolkitView;
  readonly caller: ToolsCaller;
}) => {
  const controls = controlsFor(toolkit, caller);
  const flags = flagsOf(toolkit);

  return (
    <>
      <WithApproverDirectory admin={caller.admin}>
        {(state) => (
          <>
            <Facts
              toolkit={toolkit}
              directory={directoryOf(state)}
              approvals={controls.approvals}
            />
            <Flags flags={flags} label="Needs attention" />
            <SignIns toolkit={toolkit} caller={caller} controls={controls} />
            <ToolList
              toolkit={toolkit}
              manage={controls.manage}
              refresh={controls.refresh}
              directory={directoryOf(state)}
            />
          </>
        )}
      </WithApproverDirectory>
      {controls.prices ? <ToolkitPrices toolkit={toolkit} /> : null}
      {controls.approvals ? <ToolkitApprovals toolkit={toolkit} admin={caller.admin} /> : null}
      {controls.manage && toolkit.built_in !== true ? <ToolkitSettings toolkit={toolkit} /> : null}
    </>
  );
};

export const ToolkitPage = () => {
  const { toolkitId } = route.useParams();
  const list = useAtomValue(toolkitsAtom);

  const name = AsyncResult.isSuccess(list)
    ? list.value.toolkits.find((each) => each.id === toolkitId)?.name
    : undefined;

  usePageTitle(name ?? "Toolkit");

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <Link to="/tools" className={styles["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Tools
        </Link>
        <h1 className={styles["title"]}>{name ?? "Toolkit"}</h1>
      </header>
      <WithToolkit id={toolkitId}>
        {(toolkit, caller) => <Details toolkit={toolkit} caller={caller} />}
      </WithToolkit>
    </div>
  );
};
