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

  it('shows details of non-edit actions such as exports', () => {
    render(<ChangeList changes={{ filters: { search: 'fjord', status: null }, rows: 12 }} />);
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('{"search":"fjord","status":null}')).toBeInTheDocument();
  });
});
