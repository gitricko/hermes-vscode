import escapeHtmlLib from 'escape-html';

export function escapeHtml(value: string): string {
  return escapeHtmlLib(value);
}
