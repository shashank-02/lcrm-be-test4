import { renderTemplate, whatsappLink, whatsappNumber, mailtoLink, telLink } from '../../src/services/template.service';

describe('template rendering', () => {
  const ctx = { lead: { name: 'Arjun', phone: '9876543210', customFields: { productType: 'Home Loan', requiredAmount: 500000 } }, owner: { name: 'Anita', phone: '9800000003' }, stage: 'Prospect', status: 'Interested', source: 'Website' };

  it('replaces lead, owner, custom and pipeline placeholders', () => {
    expect(renderTemplate('Hi {{name}}, {{owner.name}} here about your {{custom.productType}} ({{ custom.requiredAmount }}). Stage: {{stage}}/{{status}}/{{source}}', ctx))
      .toBe('Hi Arjun, Anita here about your Home Loan (500000). Stage: Prospect/Interested/Website');
  });
  it('renders unknown placeholders as empty strings', () => {
    expect(renderTemplate('{{nope}}|{{custom.missing}}|{{owner.email}}', ctx)).toBe('||');
  });
  it('normalises Indian numbers for wa.me', () => {
    expect(whatsappNumber('98765 43210')).toBe('919876543210');
    expect(whatsappNumber('09876543210')).toBe('919876543210');
    expect(whatsappNumber('+91 98765-43210')).toBe('919876543210');
    expect(whatsappNumber('+14155552671')).toBe('14155552671');
  });
  it('builds deep links', () => {
    expect(whatsappLink('9876543210', 'Hi there & welcome')).toBe('https://wa.me/919876543210?text=Hi%20there%20%26%20welcome');
    expect(mailtoLink('a@b.com', 'Sub ject', 'Body')).toBe('mailto:a@b.com?subject=Sub%20ject&body=Body');
    expect(telLink('+91 98765-43210')).toBe('tel:+919876543210');
  });
});
