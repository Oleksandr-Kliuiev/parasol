import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChangeList } from './ChangeList';

describe('ChangeList', () => {
  it('shows field changes as old → new', () => {
    render(<ChangeList changes={{ Name: { old: 'Fjord IT', new: 'Fjord IT AS' }, Status: { new: 'Customer' } }} />);
    expect(screen.getByText('Fjord IT')).toBeInTheDocument();
    expect(screen.getByText('Fjord IT AS')).toBeInTheDocument();
    expect(screen.getByText('Customer')).toBeInTheDocument();
  });

  it('shows details of non-edit actions such as exports as named pairs, not JSON', () => {
    render(<ChangeList changes={{ filters: { search: 'fjord', status: null }, rows: 12 }} />);
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('search: fjord · Status: —')).toBeInTheDocument();
    expect(screen.queryByText(/\{"search"/)).not.toBeInTheDocument();
  });

  it('keeps nested values and JSON text one step away, formatted', () => {
    const plan = JSON.stringify([{ record: { module: 'customers', entityType: 'Contact' }, action: 'Pseudonymize' }]);
    render(<ChangeList changes={{ Plan: { new: plan }, Anomalies: { new: [{ Code: 'BIL_CUSTOMER_NOT_LINKED' }] } }} />);
    expect(screen.queryByText(/\[\{"record"/)).not.toBeInTheDocument();
    const summaries = screen.getAllByText('Show details (1)');
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText(/"action": "Pseudonymize"/)).toBeInTheDocument();
  });
});
