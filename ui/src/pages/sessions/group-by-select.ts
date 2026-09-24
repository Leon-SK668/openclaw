import { html } from "lit";
import { live } from "lit/directives/live.js";
import { t } from "../../i18n/index.ts";
import { SESSION_GROUP_MODES, type SessionsGroupBy } from "../../lib/sessions/grouping.ts";

const SESSION_GROUP_MODE_LABELS = {
  none: "sessionsView.groupByNone",
  category: "sessionsView.groupByCategory",
  person: "sessionsView.groupByPerson",
  channel: "sessionsView.groupByChannel",
  kind: "sessionsView.groupByKind",
  agent: "sessionsView.groupByAgent",
  date: "sessionsView.groupByDate",
} as const satisfies Record<SessionsGroupBy, string>;

export function renderSessionsGroupBySelect(params: {
  groupBy: SessionsGroupBy;
  personGroupingAvailable: boolean;
  onGroupByChange: (mode: SessionsGroupBy) => void;
}) {
  // Popover reattachment can reset the native select without changing props;
  // live() restores the component-owned grouping instead of keeping that drift.
  const selectedGroup = live(params.groupBy);
  const modes = SESSION_GROUP_MODES.filter(
    (mode) => mode !== "person" || params.personGroupingAvailable,
  );
  return html`
    <label class="session-groupby">
      <span class="session-groupby__label">${t("sessionsView.groupBy")}</span>
      <select
        class="session-groupby__select"
        .value=${selectedGroup}
        @change=${(event: Event) =>
          params.onGroupByChange((event.target as HTMLSelectElement).value as SessionsGroupBy)}
      >
        ${modes.map(
          (mode) => html`
            <option value=${mode} ?selected=${params.groupBy === mode}>
              ${t(SESSION_GROUP_MODE_LABELS[mode])}
            </option>
          `,
        )}
      </select>
    </label>
  `;
}
