import { mailStatus, maskEmail, sender, credentialsEmail, otpEmail } from '../../src/services/mail.service';

describe('mail configuration exposure', () => {
  it('masks everything that could identify credentials and never includes the password', () => {
    const s = mailStatus() as unknown as Record<string, unknown>;
    expect(JSON.stringify(s)).not.toMatch(/SMTP_PASS|pass/i);
    expect(maskEmail('karan.mehta@gmail.com')).toBe('ka****@gmail.com');
    expect(maskEmail('a@b.io')).toBe('a****@b.io');
    expect(s.provider).toBeDefined(); expect(s.status).toBeDefined(); expect(typeof s.connected).toBe('boolean');
  });
  it('derives the sender from SMTP_FROM_* with MAIL_FROM/SMTP_USER as fallbacks', () => {
    const s = sender();
    expect(s.email).toContain('@'); expect(s.name.length).toBeGreaterThan(0);
  });
  it('templates carry the code/credentials in the body but tag their kind for redacted logging', () => {
    const otp = otpEmail('DBS', 'Karan', '123456', 5);
    expect(otp.kind).toBe('otp'); expect(otp.text).toContain('123456'); expect(otp.subject).not.toContain('123456'); // subject is logged by relays; keep the code out of it
    const cred = credentialsEmail('DBS', 'Karan', 'karan', 'Secret123!', 'https://app.dbs.test', true);
    expect(cred.kind).toBe('password_reset'); expect(cred.text).toContain('Secret123!'); expect(cred.html).toContain('https://app.dbs.test'); expect(cred.subject).toContain('reset');
    const welcome = credentialsEmail('DBS', 'Karan', 'karan', 'Secret123!', 'https://app.dbs.test', false);
    expect(welcome.kind).toBe('credentials'); expect(welcome.subject).toContain('Welcome');
  });
});
