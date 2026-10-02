import { Types } from 'mongoose';
import { AssignmentRule, Lead, User, Team } from '../models';
import { logActivities } from './activity.service';
import { notify } from './notification.service';

interface LeadLike {
  _id: Types.ObjectId;
  sourceId?: Types.ObjectId | null;
  stageId?: Types.ObjectId | null;
  city?: string;
  state?: string;
}

function matches(rule: { conditions: { sourceIds: Types.ObjectId[]; stageIds: Types.ObjectId[]; cities: string[]; states: string[] } }, lead: LeadLike) {
  const c = rule.conditions;
  if (c.sourceIds.length && !(lead.sourceId && c.sourceIds.some((s) => s.equals(lead.sourceId!)))) return false;
  if (c.stageIds.length && !(lead.stageId && c.stageIds.some((s) => s.equals(lead.stageId!)))) return false;
  if (c.cities.length && !c.cities.map((x) => x.toLowerCase()).includes((lead.city ?? '').toLowerCase())) return false;
  if (c.states.length && !c.states.map((x) => x.toLowerCase()).includes((lead.state ?? '').toLowerCase())) return false;
  return true;
}

async function candidateUsers(orgId: Types.ObjectId, rule: { targetUserIds: Types.ObjectId[]; targetTeamId?: Types.ObjectId | null }) {
  if (rule.targetUserIds.length) {
    return User.find({ _id: { $in: rule.targetUserIds }, orgId, isActive: true }).select('_id teamId').lean();
  }
  if (rule.targetTeamId) {
    return User.find({ orgId, teamId: rule.targetTeamId, isActive: true, role: { $in: ['agent', 'team_lead'] } })
      .select('_id teamId')
      .lean();
  }
  return [];
}

/**
 * Applies assignment rules to a set of unassigned leads.
 * Returns the number of leads assigned. Safe to call for one lead or thousands.
 */
export async function applyAssignmentRules(orgId: string | Types.ObjectId, leadIds: Types.ObjectId[]): Promise<number> {
  if (!leadIds.length) return 0;
  const org = new Types.ObjectId(String(orgId));
  const rules = await AssignmentRule.find({ orgId: org, isActive: true }).sort({ priority: 1 }).lean();
  if (!rules.length) return 0;

  const leads = await Lead.find({ _id: { $in: leadIds }, orgId: org, ownerId: null, isDeleted: false })
    .select('_id sourceId stageId city state')
    .lean();
  if (!leads.length) return 0;

  const teamCache = new Map<string, Types.ObjectId | null>();
  const managerFor = async (teamId: Types.ObjectId | null | undefined) => {
    if (!teamId) return null;
    const k = String(teamId);
    if (!teamCache.has(k)) {
      const t = await Team.findById(teamId).select('managerId').lean();
      teamCache.set(k, t?.managerId ?? null);
    }
    return teamCache.get(k) ?? null;
  };

  let assigned = 0;
  const ops: Parameters<typeof Lead.bulkWrite>[0] = [];
  const notices: { leadId: Types.ObjectId; ownerId: Types.ObjectId; rule: string }[] = [];
  const logs: Parameters<typeof logActivities>[0] = [];

  for (const rule of rules) {
    const remaining = leads.filter((l) => !ops.some((o) => 'updateOne' in o && String(o.updateOne.filter._id) === String(l._id)));
    if (!remaining.length) break;
    const matching = remaining.filter((l) => matches(rule as never, l));
    if (!matching.length) continue;
    const users = await candidateUsers(org, rule as never);
    if (!users.length) continue;

    let loads: Map<string, number> | null = null;
    if (rule.strategy === 'least_loaded') {
      const counts = await Lead.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { orgId: org, isDeleted: false, ownerId: { $in: users.map((u) => u._id) } } },
        { $group: { _id: '$ownerId', n: { $sum: 1 } } },
      ]);
      loads = new Map(users.map((u) => [String(u._id), 0]));
      counts.forEach((c) => loads!.set(String(c._id), c.n));
    }

    for (const lead of matching) {
      let target = users[0];
      if (rule.strategy === 'round_robin') {
        const updated = await AssignmentRule.findByIdAndUpdate(rule._id, { $inc: { cursor: 1, assignedCount: 1 } }, { new: true }).lean();
        target = users[((updated?.cursor ?? 1) - 1) % users.length];
      } else if (rule.strategy === 'least_loaded' && loads) {
        target = users.reduce((a, b) => ((loads!.get(String(b._id)) ?? 0) < (loads!.get(String(a._id)) ?? 0) ? b : a));
        loads.set(String(target._id), (loads.get(String(target._id)) ?? 0) + 1);
      }
      const managerId = await managerFor(target.teamId);
      ops.push({
        updateOne: {
          filter: { _id: lead._id },
          update: { $set: { ownerId: target._id, teamId: target.teamId ?? null, managerId, assignedAt: new Date() } },
        },
      });
      logs.push({ orgId: org, leadId: lead._id, userId: null, type: 'assigned', description: `Auto-assigned by rule "${rule.name}"`, payload: { ruleId: rule._id, ownerId: target._id } });
      notices.push({ leadId: lead._id, ownerId: target._id, rule: rule.name });
      assigned++;
    }
  }
  if (ops.length) {
    await Lead.bulkWrite(ops, { ordered: false });
    await logActivities(logs);
    // Auto-assigned owners get the same "new lead" notification as manual assignment.
    const names = new Map((await Lead.find({ _id: { $in: notices.map((n) => n.leadId) } }).select('name phone').lean()).map((l) => [String(l._id), l.name || l.phone]));
    await Promise.all(notices.map((n) => notify({ orgId: org, userId: n.ownerId, leadId: n.leadId, leadName: names.get(String(n.leadId)) ?? '', type: 'lead_assigned', title: 'New lead assigned', body: `${names.get(String(n.leadId)) ?? 'A lead'} was auto-assigned to you by rule "${n.rule}".` })));
  }
  return assigned;
}
