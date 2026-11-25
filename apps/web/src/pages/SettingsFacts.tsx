// The read-only parts of the Settings page: payload rule counts, and the account error rules. Payload and error rules are set by importing a Go config document.
import type { ReactNode } from "react";
import type { RequestScopedErrorRule } from "@commissary/contract/provider-keys";
import type { SettingsView } from "@commissary/contract/settings";
import { formatCount } from "../lib/format.ts";
import { providerName } from "../lib/providers.ts";
import styles from "./Settings.module.css";

/** Payload and error rules are not edited in the panel: a config import sets them. */
const SetByImport = ({ what }: { readonly what: string }) => (
  <p className={styles["quiet"]}>
    Set {what} by importing a Go config document (POST /settings/import).
  </p>
);

/** A section without a form: heading and body. */
export const PlainSection = ({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) => (
  <section id={id} className={styles["section"]} aria-labelledby={`${id}-title`}>
    <header className={styles["sectionHead"]}>
      <h2 id={`${id}-title`} className={styles["sectionTitle"]}>
        {title}
      </h2>
    </header>
    {children}
  </section>
);

const PAYLOAD_KINDS: ReadonlyArray<readonly [keyof SettingsView["payload"], string, string]> = [
  ["default", "Default", "Set a parameter only when the request does not have it."],
  ["default-raw", "Default, raw JSON", "The same, with a raw JSON value."],
  ["override", "Override", "Set a parameter, replacing what the client sent."],
  ["override-raw", "Override, raw JSON", "The same, with a raw JSON value."],
  ["replace", "Replace", "Rewrite text in messages or fields, literally or by pattern."],
  ["filter", "Filter", "Remove a parameter from the request."],
];

export const PayloadRules = ({ payload }: { readonly payload: SettingsView["payload"] }) => (
  <PlainSection id="payload" title="Payload rules">
    <p className={styles["lead"]}>
      Rules that change request bodies for the models they name, as the last step before a request
      goes to the provider.
    </p>
    <ul className={styles["counts"]}>
      {PAYLOAD_KINDS.map(([kind, name, meaning]) => (
        <li key={kind} className={styles["countRow"]}>
          <span className={styles["count"]}>{formatCount(payload[kind])}</span>
          <span className={styles["countName"]}>{name}</span>
          <span className={styles["countMeaning"]}>{meaning}</span>
        </li>
      ))}
    </ul>
    <SetByImport what="payload rules" />
  </PlainSection>
);

const ACTIONS = new Map([
  ["stop", "Answer with the error"],
  ["stop-and-cooldown", "Answer with the error and cool the account down"],
  ["continue", "Try the next credential"],
  ["continue-and-cooldown", "Cool the account down and try the next"],
]);

const matchText = (rule: RequestScopedErrorRule): string => {
  const texts = (rule.match ?? []).map((text) => `“${text}”`);
  const patterns = (rule["match-regexr"] ?? []).map((pattern) => `/${pattern}/`);
  const all = [...texts, ...patterns];

  return all.length === 0 ? "Any body" : all.join(" or ");
};

/** `oauth.request-scoped-errors`, compactly: one row per rule, the provider once per group. */
export const ErrorRules = ({
  rules,
}: {
  readonly rules: SettingsView["request_scoped_errors"];
}) => {
  const providers = Object.entries(rules).filter(([, list]) => list.length > 0);

  return (
    <div className={styles["sub"]}>
      <h3 className={styles["subTitle"]}>Account error rules</h3>
      <p className={styles["hint"]}>
        What a failed request does next, per provider, for accounts without rules of their own.
      </p>
      {providers.length === 0 ? (
        <p className={styles["quiet"]}>No account error rules.</p>
      ) : (
        <table className={styles["table"]}>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Status</th>
              <th scope="col">Body contains</th>
              <th scope="col">Then</th>
            </tr>
          </thead>
          <tbody>
            {providers.flatMap(([provider, list]) =>
              list.map((rule, index) => (
                <tr key={`${provider}-${String(index)}`}>
                  <td>{index === 0 ? providerName(provider) : null}</td>
                  <td data-label="Status">
                    {rule.status === undefined ? "Any" : String(rule.status)}
                  </td>
                  <td className={styles["matchCell"]}>{matchText(rule)}</td>
                  <td data-label="Then">
                    {ACTIONS.get(rule.action ?? "") ?? rule.action ?? "Default"}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
      <SetByImport what="error rules" />
    </div>
  );
};
