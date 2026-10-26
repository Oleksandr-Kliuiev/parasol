import type { TFunction } from 'i18next';
import type { ActionRequest } from '../actions/types';
import type { Alert } from '../service/types';

/** Huntress's word for where an incident stands, in the reader's language; an unknown word as Huntress wrote it. */
export const incidentStatus = (t: TFunction, status: string) => t(`security.incident.statuses.${status}`, { defaultValue: status });

/** A kind of indicator (`footholds`) in the reader's language; one the interface does not know yet in Huntress's words, readable. */
export const indicatorName = (t: TFunction, type: string) =>
  t(`security.indicators.${type}`, { defaultValue: type.replaceAll('_', ' ') });

export const remediationType = (t: TFunction, type: string) => t(`security.remediation.types.${type}`, { defaultValue: type });

export const remediationStatus = (t: TFunction, status: string) => t(`security.remediation.statuses.${status}`, { defaultValue: status });

export const noticeStatus = (t: TFunction, status: string) => t(`security.notice.statuses.${status}`, { defaultValue: status });

/** The reasons Huntress takes for sending a plan back: for a computer, and for Microsoft 365. */
export const rejectionReasons = {
  endpoint: ['approved_application', 'manually_remediated', 'host_reimaged', 'testing_security_controls', 'other'],
  m365: [
    'approved_user_login_location_m365', 'approved_user_email_forwarding_rule_m365', 'approved_application_m365', 'manually_remediated_m365',
    'testing_security_controls_m365', 'approved_vpn_or_proxy_usage_m365', 'other_m365',
  ],
} as const;

/** The longest comment, or explanation of a rejection, Huntress takes. */
export const maxSecurityText = 2048;

/** An unwanted-access escalation (a login from an unexpected country or VPN): it takes an answer whether the access was expected. */
export const isAccessEscalation = (typeCode: string | null) => typeCode !== null && /country_access|vpn_access/.test(typeCode);

/** An action at Huntress about the record behind an alert: the alert's id names it. */
export const alertActionRequest = (alert: Pick<Alert, 'system' | 'externalId'>, kind: string, parameters: Record<string, unknown> = {}): ActionRequest =>
  ({ system: alert.system, kind, targetType: 'alert', targetId: alert.externalId, parameters });

/** An action at Huntress about an agent: the source's agent id names it. */
export const deviceActionRequest = (system: string, externalId: string, kind: string): ActionRequest =>
  ({ system, kind, targetType: 'device', targetId: externalId, parameters: {} });

/** The isolation states of a host that is cut off from the network, or about to be. */
export const isIsolated = (isolation: string | null | undefined) => isolation === 'Isolated' || isolation === 'Pending Isolation';
