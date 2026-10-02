import { Types } from 'mongoose';
import { encryptField, decryptField, mask, sha256, timingSafeEqualHex, randomDigits } from '../../src/services/crypto.service';
import { canSee, audienceFilter, roleGroup } from '../../src/services/access.service';
import { computePriority, matchesRule } from '../../src/services/prioritization.service';
import { maskEmail } from '../../src/services/otp.service';
import type { AuthUser } from '../../src/common/types';

const mk = (over: Partial<AuthUser>): AuthUser => ({ id: new Types.ObjectId().toString(), orgId: new Types.ObjectId().toString(), name: 'x', email: 'x@x', role: 'agent', teamId: null, managedTeamIds: [], permissions: new Set(), timezone: 'Asia/Kolkata', ...over });

describe('field encryption', () => {
  it('round-trips and never repeats ciphertext', () => {
    const a = encryptField('1234567890'); const b = encryptField('1234567890');
    expect(a).not.toBe(b); expect(decryptField(a)).toBe('1234567890'); expect(decryptField(b)).toBe('1234567890');
    expect(decryptField('garbage')).toBe(''); expect(encryptField('')).toBe('');
  });
  it('masks all but the last four characters', () => { expect(mask('1234567890')).toBe('••••••7890'); expect(mask('')).toBe(''); });
  it('hashes and compares in constant time', () => { const h = sha256('abc'); expect(timingSafeEqualHex(h, sha256('abc'))).toBe(true); expect(timingSafeEqualHex(h, sha256('abd'))).toBe(false); expect(randomDigits(6)).toMatch(/^\d{6}$/); });
  it('masks emails for the OTP screen', () => { expect(maskEmail('anita.agent@demo.local')).toBe('an*********@demo.local'); });
});

describe('audience visibility (documents / training)', () => {
  const team = new Types.ObjectId().toString(); const other = new Types.ObjectId().toString();
  const agentInTeam = mk({ role: 'agent', teamId: team }); const managerOther = mk({ role: 'branch_manager', managedTeamIds: [other] });
  it('admins always see; all=true opens to everyone', () => { expect(canSee(mk({ role: 'admin' }), { all: false })).toBe(true); expect(canSee(agentInTeam, { all: true })).toBe(true); });
  it('role + team must BOTH match when both are set', () => {
    const aud = { roles: ['agents'], teamIds: [team] };
    expect(canSee(agentInTeam, aud)).toBe(true);
    expect(canSee(mk({ role: 'agent', teamId: other }), aud)).toBe(false);
    expect(canSee(mk({ role: 'team_lead', teamId: team }), aud)).toBe(false);
  });
  it('role only / team only / specific user', () => {
    expect(canSee(managerOther, { roles: ['managers'] })).toBe(true);
    expect(canSee(agentInTeam, { roles: ['managers'] })).toBe(false);
    expect(canSee(managerOther, { teamIds: [other] })).toBe(true);
    expect(canSee(agentInTeam, { userIds: [agentInTeam.id] })).toBe(true);
    expect(canSee(agentInTeam, {})).toBe(false);
    expect(roleGroup('team_lead')).toBe('managers');
  });
  it('builds a Mongo filter for admins as empty and $or for others', () => { expect(audienceFilter(mk({ role: 'admin' }))).toEqual({}); expect(audienceFilter(agentInTeam).$or).toHaveLength(5); });
});

describe('prioritisation rules', () => {
  const lead = { qualityScore: 70, contactCount: 0, nextFollowUpAt: new Date(Date.now() - 86_400_000), stageId: 's1', createdAt: new Date(Date.now() - 10 * 86_400_000), customFields: { requiredAmount: 500000, productType: 'Home Loan' } };
  it('evaluates operators', () => {
    expect(matchesRule({ factor: 'qualityScore', fieldKey: '', operator: 'gte', value: 60, points: 10 }, lead)).toBe(true);
    expect(matchesRule({ factor: 'nextFollowUpAt', fieldKey: '', operator: 'overdue', value: null, points: 10 }, lead)).toBe(true);
    expect(matchesRule({ factor: 'customField', fieldKey: 'requiredAmount', operator: 'gt', value: 1000000, points: 10 }, lead)).toBe(false);
    expect(matchesRule({ factor: 'customField', fieldKey: 'productType', operator: 'in', value: ['Home Loan', 'LAP'], points: 10 }, lead)).toBe(true);
    expect(matchesRule({ factor: 'stage', fieldKey: '', operator: 'eq', value: 's1', points: 10 }, lead)).toBe(true);
    expect(matchesRule({ factor: 'leadAgeDays', fieldKey: '', operator: 'lte', value: 7, points: 10 }, lead)).toBe(false);
  });
  it('sums points and caps at 0..100', () => {
    const rules = [{ factor: 'qualityScore', fieldKey: '', operator: 'gte', value: 60, points: 60 }, { factor: 'nextFollowUpAt', fieldKey: '', operator: 'overdue', value: null, points: 60 }, { factor: 'contactCount', fieldKey: '', operator: 'gt', value: 3, points: 20 }];
    expect(computePriority(rules as never, lead)).toBe(100);
    expect(computePriority([{ factor: 'contactCount', fieldKey: '', operator: 'gt', value: 3, points: -20 }] as never, lead)).toBe(0);
  });
});
