/**
 * Seeds an organisation with an admin user, default permission templates, pipeline, fields and templates.
 * Idempotent: re-running updates defaults without touching existing leads/users.
 *
 *   npm run seed            # base setup
 *   npm run seed -- --demo  # + demo teams, users (password: Demo@12345) and sample leads
 */
import bcrypt from 'bcryptjs';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { connectDb, disconnectDb } from '../config/db';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_MIGRATIONS } from '../common/permissions';
import { ROLE_LABELS, ROLES } from '../common/types';
import {
  Organisation, User, Team, PermissionTemplate, Stage, Status, Source, StageDirective, FieldDefinition,
  MessageTemplate, Lead, Activity, AssignmentRule, ListView, TrainingCategory, DocFolder,
} from '../models';
import { backfillTopUpReminders } from '../services/topup.service';
import { logActivity } from '../services/activity.service';

const demo = process.argv.includes('--demo') || process.env.SEED_DEMO === 'true';

const STAGES = [
  { name: 'Lead', color: '#6B7280' }, { name: 'Prospect', color: '#185FA5' }, { name: 'Hot Prospect', color: '#D97706' },
  { name: 'Login Pending', color: '#7C3AED' }, { name: 'Logged', color: '#0891B2' }, { name: 'Underwriting', color: '#BE185D' },
  { name: 'Approved', color: '#1B8A5A', isWon: true }, { name: 'Customer Cancelled', color: '#C23B3B', isLost: true },
];
const STATUSES = [
  { name: 'Callback', color: '#2563EB', subStatuses: ['Callback Requested', 'Busy — Call Later', 'Asked to Call Tomorrow'] }, { name: 'Interested', color: '#1B8A5A', subStatuses: ['Documents Requested', 'Comparing Offers', 'Ready to Apply'] }, { name: 'Not Interested', color: '#C23B3B', subStatuses: ['Rate Too High', 'Already Availed', 'No Requirement'] },
  { name: 'RNR', color: '#6B7280', subStatuses: ['Ringing No Response', 'Switched Off', 'Not Reachable'] }, { name: 'Docs Pending', color: '#0891B2', subStatuses: ['KYC Pending', 'Income Proof Pending', 'Bank Statement Pending'] }, { name: 'Logged', color: '#D97706', subStatuses: [] },
  { name: 'Rejected', color: '#EA580C', subStatuses: ['CIBIL', 'Income Criteria', 'Policy'] }, { name: 'Others', color: '#7C3AED', subStatuses: [] },
];
const SYSTEM_TABS = [
  { name: 'Contacted Today', baseTab: 'contacted_today' }, { name: 'Assigned Today', baseTab: 'assigned_today' }, { name: 'All Leads', baseTab: 'all', isDefault: true },
  { name: 'Created Today', baseTab: 'created_today' }, { name: 'Follow-ups Today', baseTab: 'followup_today' }, { name: 'Overdue', baseTab: 'overdue' }, { name: 'Unassigned', baseTab: 'unassigned', roles: ['admin', 'branch_manager', 'team_lead'] }, { name: 'Today List', baseTab: 'today_list' },
];
const TRAINING_CATEGORIES = ['Getting Started', 'Lead Management', 'Lead Assignment', 'Notes', 'Call Logs', 'Sales Process', 'Reports', 'Files', 'Project Administration', 'Settings', 'Other'];
const DOC_FOLDERS = ['Rules & Regulations', 'Policies', 'Process Documents', 'Product Guidelines', 'Training Documents', 'SOPs', 'Circulars', 'Company Notices'];
const SOURCES = ['Facebook', 'Google Ads', 'Website', 'Referral', 'Cold Call', 'Walk-in', 'Partner', 'Bulk Upload'];

type F = { key: string; label: string; type?: string; options?: string[]; tab: string; section: string; showInCreate?: boolean; showInList?: boolean; required?: boolean };
const FIELDS: F[] = [
  // Basic info
  { key: 'productType', label: 'Product Type', type: 'select', options: ['Personal Loan', 'Business Loan', 'Home Loan', 'Credit Card', 'Loan Against Property', 'Car Loan'], tab: 'Basic Info', section: 'Requirement', showInCreate: true, showInList: true },
  { key: 'requiredAmount', label: 'Required Amount', type: 'currency', tab: 'Basic Info', section: 'Requirement', showInCreate: true, showInList: true },
  { key: 'employmentType', label: 'Employment Type', type: 'select', options: ['Salaried', 'Self-employed', 'Business Owner', 'Professional'], tab: 'Basic Info', section: 'Profile', showInCreate: true },
  { key: 'companyName', label: 'Company Name', tab: 'Basic Info', section: 'Profile', showInCreate: true },
  { key: 'designation', label: 'Designation', tab: 'Basic Info', section: 'Profile' },
  { key: 'monthlyIncome', label: 'Monthly Income', type: 'currency', tab: 'Basic Info', section: 'Profile', showInCreate: true },
  { key: 'dateOfBirth', label: 'Date of Birth', type: 'date', tab: 'Basic Info', section: 'Profile' },
  { key: 'panNumber', label: 'PAN Number', tab: 'Basic Info', section: 'Profile' },
  { key: 'pincode', label: 'Pincode', tab: 'Basic Info', section: 'Address' },
  { key: 'existingEmi', label: 'Existing EMIs (monthly)', type: 'currency', tab: 'Basic Info', section: 'Obligations' },
  // Credit card details
  { key: 'cardBank', label: 'Bank', tab: 'Credit Card Details', section: 'Card', showInCreate: false },
  { key: 'cardType', label: 'Card Type', type: 'select', options: ['Regular', 'Gold', 'Platinum', 'Signature', 'Infinite'], tab: 'Credit Card Details', section: 'Card' },
  { key: 'cardLimit', label: 'Card Limit', type: 'currency', tab: 'Credit Card Details', section: 'Card' },
  { key: 'cardIssueDate', label: 'Card Issue Date', type: 'date', tab: 'Credit Card Details', section: 'Card' },
  { key: 'cardUsagePct', label: 'Card Usage (%)', type: 'percent', tab: 'Credit Card Details', section: 'Usage' },
  { key: 'cardOutstanding', label: 'Outstanding Amount', type: 'currency', tab: 'Credit Card Details', section: 'Usage' },
  // Disbursed format
  { key: 'disbursedBank', label: 'Disbursed Bank', tab: 'Disbursed Format', section: 'Disbursement' },
  { key: 'disbursedAmount', label: 'Disbursed Amount', type: 'currency', tab: 'Disbursed Format', section: 'Disbursement' },
  { key: 'disbursedDate', label: 'Disbursed Date', type: 'date', tab: 'Disbursed Format', section: 'Disbursement' },
  { key: 'payoutPct', label: 'Payout (%)', type: 'percent', tab: 'Disbursed Format', section: 'Commercials' },
  { key: 'payoutAmount', label: 'Payout Amount', type: 'currency', tab: 'Disbursed Format', section: 'Commercials' },
  { key: 'invoiceNumber', label: 'Invoice Number', tab: 'Disbursed Format', section: 'Commercials' },
  // Loan details
  { key: 'loanBank', label: 'Applied Bank / NBFC', tab: 'Loan Details', section: 'Application' },
  { key: 'loanAmount', label: 'Loan Amount', type: 'currency', tab: 'Loan Details', section: 'Application' },
  { key: 'tenureMonths', label: 'Tenure (months)', type: 'number', tab: 'Loan Details', section: 'Application' },
  { key: 'interestRate', label: 'Interest Rate (%)', type: 'percent', tab: 'Loan Details', section: 'Application' },
  { key: 'emi', label: 'EMI', type: 'currency', tab: 'Loan Details', section: 'Application' },
  { key: 'loginDate', label: 'Login Date', type: 'date', tab: 'Loan Details', section: 'Timeline' },
  { key: 'sanctionDate', label: 'Sanction Date', type: 'date', tab: 'Loan Details', section: 'Timeline' },
  { key: 'applicationNumber', label: 'Application Number', tab: 'Loan Details', section: 'Timeline' },
  { key: 'cibilScore', label: 'CIBIL Score', type: 'number', tab: 'Loan Details', section: 'Eligibility' },
  // Loan products
  { key: 'interestedProducts', label: 'Interested Products', type: 'multiselect', options: ['Personal Loan', 'Business Loan', 'Home Loan', 'Credit Card', 'Loan Against Property', 'Car Loan', 'Insurance'], tab: 'Loan Products', section: 'Interest' },
  { key: 'crossSellDone', label: 'Cross-sell discussed', type: 'boolean', tab: 'Loan Products', section: 'Interest' },
];

const TEMPLATES = [
  { name: 'WhatsApp — Introduction', channel: 'whatsapp', body: 'Hi {{name}}, this is {{owner.name}} from {{org}}. Thanks for your interest in a {{custom.productType}}. When is a good time to talk today?' },
  { name: 'WhatsApp — Documents needed', channel: 'whatsapp', body: 'Hi {{name}}, to proceed with your {{custom.productType}} application please share: PAN, Aadhaar, last 3 months bank statements and salary slips. Reply here or call me at {{owner.phone}}.' },
  { name: 'WhatsApp — Follow-up', channel: 'whatsapp', body: 'Hi {{name}}, following up on our conversation about your loan requirement of {{custom.requiredAmount}}. Are you still looking? I can share the best available offers. — {{owner.name}}' },
  { name: 'Email — Introduction', channel: 'email', subject: 'Your loan enquiry — next steps', body: 'Dear {{name}},\n\nThank you for your interest. I am {{owner.name}}, your relationship manager. Based on your requirement ({{custom.productType}}, {{custom.requiredAmount}}), I will share suitable options shortly.\n\nRegards,\n{{owner.name}}\n{{owner.phone}}' },
];

async function upsertMany<T extends { name: string }>(model: { findOneAndUpdate: Function }, orgId: unknown, items: T[], extra: (item: T, i: number) => Record<string, unknown> = () => ({})) {
  for (let i = 0; i < items.length; i++) {
    await model.findOneAndUpdate({ orgId, name: items[i].name }, { $setOnInsert: { orgId, ...items[i], ...extra(items[i], i) } }, { upsert: true, new: true });
  }
}

async function main() {
  await connectDb();
  const slug = env.SEED_ORG_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const org = await Organisation.findOneAndUpdate({ slug }, { $setOnInsert: { name: env.SEED_ORG_NAME, slug } }, { upsert: true, new: true });
  logger.info({ org: org.name }, 'Organisation ready');

  // Permission templates
  for (const role of ROLES) {
    if (role === 'admin') continue;
    await PermissionTemplate.findOneAndUpdate(
      { orgId: org._id, role, isSystem: true },
      { $setOnInsert: { orgId: org._id, role, name: `${ROLE_LABELS[role]} (default)`, description: 'System default. Edit to change what this role can do.', isSystem: true, isDefault: true, permissions: DEFAULT_ROLE_PERMISSIONS[role] } },
      { upsert: true },
    );
  }
  // Policy migrations for orgs seeded before a permission existed (e.g. agents lose note edit/delete by default).
  for (const m of PERMISSION_MIGRATIONS) {
    if (m.add.length) await PermissionTemplate.updateMany({ orgId: org._id, role: m.role, isSystem: true }, { $addToSet: { permissions: { $each: m.add } } });
    if (m.remove.length) await PermissionTemplate.updateMany({ orgId: org._id, role: m.role, isSystem: true }, { $pull: { permissions: { $in: m.remove } } });
  }

  // Admin user
  const adminEmail = env.SEED_ADMIN_EMAIL.toLowerCase();
  let admin = await User.findOne({ orgId: org._id, email: adminEmail });
  if (!admin) {
    admin = await User.create({ orgId: org._id, name: env.SEED_ADMIN_NAME, email: adminEmail, phone: env.SEED_ADMIN_PHONE, username: 'admin', passwordHash: await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 10), role: 'admin', mustChangePassword: false });
    logger.info({ email: adminEmail }, 'Admin user created');
  } else logger.info({ email: adminEmail }, 'Admin user exists');

  // Pipeline
  await upsertMany(Stage, org._id, STAGES, (_s, i) => ({ order: i }));
  await upsertMany(Status, org._id, STATUSES, (_s, i) => ({ order: i }));
  await upsertMany(Source, org._id, SOURCES.map((name) => ({ name })));
  await upsertMany(MessageTemplate, org._id, TEMPLATES);
  for (let i = 0; i < FIELDS.length; i++) {
    const f = FIELDS[i];
    await FieldDefinition.findOneAndUpdate({ orgId: org._id, key: f.key }, { $setOnInsert: { orgId: org._id, ...f, order: i } }, { upsert: true });
  }
  for (const s of STATUSES) await Status.updateOne({ orgId: org._id, name: s.name, subStatuses: { $size: 0 } }, { $set: { subStatuses: s.subStatuses } });
  for (let i = 0; i < SYSTEM_TABS.length; i++) {
    const t = SYSTEM_TABS[i];
    await ListView.findOneAndUpdate({ orgId: org._id, userId: null, baseTab: t.baseTab, isSystem: true }, { $setOnInsert: { orgId: org._id, name: t.name, baseTab: t.baseTab, columns: [], filters: {}, isDefault: !!t.isDefault, roles: t.roles ?? [], isSystem: true, isActive: true, order: i } }, { upsert: true });
  }
  for (let i = 0; i < TRAINING_CATEGORIES.length; i++) await TrainingCategory.findOneAndUpdate({ orgId: org._id, name: TRAINING_CATEGORIES[i] }, { $setOnInsert: { orgId: org._id, name: TRAINING_CATEGORIES[i], order: i } }, { upsert: true });
  for (let i = 0; i < DOC_FOLDERS.length; i++) await DocFolder.findOneAndUpdate({ orgId: org._id, parentId: null, name: DOC_FOLDERS[i] }, { $setOnInsert: { orgId: org._id, name: DOC_FOLDERS[i], parentId: null, order: i, audience: { all: true }, createdById: admin._id } }, { upsert: true });
  const logged = await Stage.findOne({ orgId: org._id, name: 'Logged' });
  const approved = await Stage.findOne({ orgId: org._id, name: 'Approved' });
  if (logged) await StageDirective.findOneAndUpdate({ orgId: org._id, name: 'Logging requires loan details' }, { $setOnInsert: { orgId: org._id, name: 'Logging requires loan details', toStageId: logged._id, requiredFields: ['custom.loanBank', 'custom.loanAmount'], requireRemark: true } }, { upsert: true });
  if (approved) await StageDirective.findOneAndUpdate({ orgId: org._id, name: 'Approval by team lead or above' }, { $setOnInsert: { orgId: org._id, name: 'Approval by team lead or above', toStageId: approved._id, allowedRoles: ['team_lead', 'branch_manager', 'admin'], requireRemark: true, requiredFields: ['custom.sanctionDate'] } }, { upsert: true });
  logger.info('Pipeline, fields and templates ready');

  if (demo) await seedDemo(org._id, admin._id);
  const backfilled = await backfillTopUpReminders(org._id);
  if (backfilled) logger.info({ backfilled }, 'Top-up reminders created for already-disbursed leads');

  await disconnectDb();
  // eslint-disable-next-line no-console
  console.log(`\n✔ Seed complete. Login: ${adminEmail} / ${env.SEED_ADMIN_PASSWORD}${demo ? '\n  Demo users (password Demo@12345): meera.manager@demo.local, ravi.tl@demo.local, anita.agent@demo.local, karan.agent@demo.local, priya.agent@demo.local' : ''}\n`);
}

async function seedDemo(orgId: Types.ObjectId, adminId: Types.ObjectId) {
  if (await Team.exists({ orgId })) { logger.info('Demo data already present, skipping'); return; }
  const pw = await bcrypt.hash('Demo@12345', 10);
  const mk = (name: string, email: string, phone: string, username: string, role: string, teamId: unknown = null) =>
    User.create({ orgId, name, email, phone, username, passwordHash: pw, role, teamId, mustChangePassword: false, avatarColor: ['#185FA5', '#1B8A5A', '#B7791F', '#7C3AED', '#BE185D'][Math.floor(Math.random() * 5)] });
  const manager = await mk('Meera Nair', 'meera.manager@demo.local', '9800000001', 'meera', 'branch_manager');
  const teamA = await Team.create({ orgId, name: 'Bengaluru — Personal Loans', managerId: manager._id });
  const teamB = await Team.create({ orgId, name: 'Bengaluru — Credit Cards', managerId: manager._id });
  const tl = await mk('Ravi Kumar', 'ravi.tl@demo.local', '9800000002', 'ravi', 'team_lead', teamA._id);
  teamA.teamLeadId = tl._id; await teamA.save();
  const agents = await Promise.all([
    mk('Anita Sharma', 'anita.agent@demo.local', '9800000003', 'anita', 'agent', teamA._id),
    mk('Karan Mehta', 'karan.agent@demo.local', '9800000004', 'karan', 'agent', teamA._id),
    mk('Priya Iyer', 'priya.agent@demo.local', '9800000005', 'priya', 'agent', teamB._id),
  ]);
  await AssignmentRule.create({ orgId, name: 'Round-robin new leads to PL team', priority: 10, strategy: 'round_robin', targetUserIds: [agents[0]._id, agents[1]._id] });

  const stages = await Stage.find({ orgId }).sort({ order: 1 }).lean();
  const statuses = await Status.find({ orgId }).lean();
  const sources = await Source.find({ orgId }).lean();
  const first = ['Arjun', 'Divya', 'Rahul', 'Sneha', 'Vikram', 'Pooja', 'Aditya', 'Neha', 'Rohan', 'Kavya', 'Suresh', 'Lakshmi', 'Manoj', 'Deepa', 'Sanjay', 'Ritu'];
  const last = ['Reddy', 'Patel', 'Shetty', 'Rao', 'Gowda', 'Menon', 'Verma', 'Joshi', 'Pillai', 'Das'];
  const cities = ['Bengaluru', 'Mysuru', 'Hubballi', 'Mangaluru', 'Chennai', 'Hyderabad'];
  const products = ['Personal Loan', 'Business Loan', 'Home Loan', 'Credit Card'];
  const owners = [agents[0], agents[1], agents[2], tl];
  const now = Date.now();
  for (let i = 0; i < 60; i++) {
    const owner = i % 7 === 6 ? null : owners[i % owners.length];
    const team = owner ? await Team.findById(owner.teamId).lean() : null;
    const stage = stages[Math.min(stages.length - 1, Math.floor(Math.pow(Math.random(), 1.8) * stages.length))];
    const createdAt = new Date(now - Math.floor(Math.random() * 30) * 86_400_000 - Math.floor(Math.random() * 36_000_000));
    const contacted = Math.random() > 0.35;
    const lead = await Lead.create({
      orgId, name: `${first[i % first.length]} ${last[(i * 3) % last.length]}`, phone: `98${String(10000000 + i * 7919).padStart(8, '0')}`,
      email: `lead${i + 1}@example.com`, city: cities[i % cities.length], state: 'Karnataka', country: 'India',
      stageId: stage._id, statusId: contacted ? statuses[i % statuses.length]._id : null, sourceId: sources[i % sources.length]._id,
      ownerId: owner?._id ?? null, teamId: owner?.teamId ?? null, managerId: team?.managerId ?? null, createdById: adminId,
      assignedAt: owner ? createdAt : null, createdAt,
      lastContactedAt: contacted ? new Date(createdAt.getTime() + Math.random() * (now - createdAt.getTime())) : null,
      firstContactedAt: contacted ? createdAt : null, contactCount: contacted ? 1 + Math.floor(Math.random() * 4) : 0,
      nextFollowUpAt: Math.random() > 0.5 ? new Date(now + (Math.floor(Math.random() * 5) - 1) * 86_400_000) : null,
      remarks: contacted ? ['Interested, wants lower ROI', 'Call back after 6pm', 'Needs docs list', 'Comparing with another bank', ''][i % 5] : '',
      customFields: { productType: products[i % products.length], requiredAmount: [200000, 500000, 750000, 1200000, 2500000][i % 5], employmentType: i % 3 ? 'Salaried' : 'Self-employed', companyName: ['Infosys', 'Wipro', 'TCS', 'Own business', 'Accenture'][i % 5], monthlyIncome: [45000, 65000, 90000, 120000][i % 4], cibilScore: 650 + (i * 13) % 150 },
    });
    await logActivity({ orgId, leadId: lead._id, userId: adminId, type: 'created', description: 'Lead created (demo)' });
    if (owner) await Activity.create({ orgId, leadId: lead._id, userId: adminId, type: 'assigned', description: `Assigned to ${owner.name}`, createdAt });
  }
  logger.info('Demo teams, users and 60 leads created');
}

main().catch((err) => { logger.error({ err }, 'Seed failed'); process.exit(1); });
