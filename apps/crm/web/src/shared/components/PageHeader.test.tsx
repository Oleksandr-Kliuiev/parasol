import { afterEach, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from './PageHeader';

afterEach(() => { document.title = 'Parasoll'; });

it('names the browser tab after the visible page heading and follows navigation', () => {
  const view = render(<PageHeader title="My day" />);
  expect(document.title).toBe('My day · Parasoll');
  view.rerender(<PageHeader title="Synthetic Client AS" />);
  expect(document.title).toBe('Synthetic Client AS · Parasoll');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Synthetic Client AS');
});

it('uses rendered heading text for rich titles and updated language', () => {
  const view = render(<PageHeader title={<><span>Synthetic customer</span>{' '}<strong>review</strong></>} />);
  expect(document.title).toBe('Synthetic customer review · Parasoll');
  view.rerender(<PageHeader title="Kundar" />);
  expect(document.title).toBe('Kundar · Parasoll');
});

it('gives greeting pages a stable descriptive browser title while retaining their heading', () => {
  render(<PageHeader title="Hello, Synthetic" documentTitle="My day" />);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello, Synthetic');
  expect(document.title).toBe('My day · Parasoll');
});

it('clears a previous customer title when its header is removed during loading or logout', () => {
  const view = render(<PageHeader title="Synthetic Client AS" />);
  view.rerender(<p>Loading</p>);
  expect(document.title).toBe('Parasoll');
});

it('does not overwrite a newer owner of the document title on cleanup', () => {
  const view = render(<PageHeader title="Old page" />);
  document.title = 'New page · Parasoll';
  view.unmount();
  expect(document.title).toBe('New page · Parasoll');
});

it('keeps source markup as text in the heading and title', () => {
  const text = '<img src=x onerror=alert(1)>';
  render(<PageHeader title={text} />);
  expect(document.title).toBe(`${text} · Parasoll`);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(text);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
