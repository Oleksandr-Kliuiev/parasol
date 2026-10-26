import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import type { CoverageRule } from '../types';

/** Parasoll's own coverage rules with their settings (M40); a change of one reads them again everywhere. */
export const coverageKeys = { rules: ['service', 'coverage', 'rules'] as const };

export function useCoverageRules(enabled = true) {
  return useQuery({
    queryKey: coverageKeys.rules,
    enabled,
    queryFn: async ({ signal }) => (await api.get<CoverageRule[]>('/api/v1/service/coverage/rules', signal)).data,
  });
}

/** Switches a rule on or off with its limit, with the ETag of the rule the person read. Answers with the rule as it is now. */
export const changeCoverageRule = (rule: CoverageRule, enabled: boolean, threshold: number | null) =>
  api.put<CoverageRule>(`/api/v1/service/coverage/rules/${encodeURIComponent(rule.code)}`, { enabled, threshold }, rule.etag);

/** A limit a person typed: a whole number in the rule's range, or null when it is not one. */
export function limitValue(text: string, rule: CoverageRule): number | null {
  if (!rule.threshold || !/^\d{1,4}$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= rule.threshold.min && value <= rule.threshold.max ? value : null;
}
