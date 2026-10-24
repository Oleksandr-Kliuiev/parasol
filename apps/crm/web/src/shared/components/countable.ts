import { createElement, type ReactNode } from 'react';
import { wrapAtCurrency } from '../utils/format';
import { CountUp } from './CountUp';

/** Plain figures count up when they appear; anything richer (a badge, a link) is shown as it is. */
export function countable(value: ReactNode): ReactNode {
  return typeof value === 'string' || typeof value === 'number' ? createElement(CountUp, { text: wrapAtCurrency(String(value)) }) : value;
}
