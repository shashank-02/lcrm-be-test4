import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { asyncHandler, ok, created } from '../../common/http';
import { badRequest, conflict, notFound } from '../../common/errors';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { idParam, normalise } from '../../common/crud';
import { Lead, Team, User } from '../../models';
import { visibleTeamIds } from '../../services/scope.service';
import { audit } from '../../services/audit.service';

export const teamsRouter = Router();
const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'Invalid id');

const teamSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  managerId: objectId.nullable().optional(),
  teamLeadId: objectId.nullable().optional(),
  permissionTemplateId: objectId.nullable().optional(),
  isActive: z.boolean().optional(),
});

teamsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { orgId: req.user!.orgId };
    const visible = visibleTeamIds(req.user!);
    if (visible) filter._id = { $in: visible };
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    const teams = await Team.find(filter).sort({ name: 1 }).lean();
    const counts = await User.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { orgId: new Types.ObjectId(req.user!.orgId), isActive: true, teamId: { $in: teams.map((t) => t._id) } } },
      { $group: { _id: '$teamId', n: { $sum: 1 } } },
    ]);
    const leadCounts = await Lead.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { orgId: new Types.ObjectId(req.user!.orgId), isDeleted: false, teamId: { $in: teams.map((t) => t._id) } } },
      { $group: { _id: '$teamId', n: { $sum: 1 } } },
    ]);
    const cMap = new Map(counts.map((c) => [String(c._id), c.n]));
    const lMap = new Map(leadCounts.map((c) => [String(c._id), c.n]));
    ok(res, teams.map((t) => ({ ...normalise(t), memberCount: cMap.get(String(t._id)) ?? 0, leadCount: lMap.get(String(t._id)) ?? 0 })));
  }),
);

teamsRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const team = await Team.findOne({ _id: req.params.id, orgId: req.user!.orgId }).lean();
    if (!team) throw notFound('Team');
    const members = await User.find({ teamId: team._id, orgId: req.user!.orgId }).select('name email phone role isActive avatarColor').sort({ role: 1, name: 1 }).lean();
    ok(res, { ...normalise(team), members: members.map(normalise) });
  }),
);

teamsRouter.post(
  '/',
  requirePermission('admin.teams'),
  validate({ body: teamSchema }),
  asyncHandler(async (req, res) => {
    await validateRoles(req.user!.orgId, req.body);
    const team = await Team.create({ ...req.body, orgId: req.user!.orgId });
    await syncTeamLead(team);
    audit(req.user!, { action: 'team.create', entity: 'Team', entityId: team._id, summary: `Created team ${team.name}`, after: team.toJSON(), ip: req.ip });
    created(res, team.toJSON());
  }),
);

teamsRouter.patch(
  '/:id',
  requirePermission('admin.teams'),
  validate({ params: idParam, body: teamSchema.partial() }),
  asyncHandler(async (req, res) => {
    const team = await Team.findOne({ _id: req.params.id, orgId: req.user!.orgId });
    if (!team) throw notFound('Team');
    await validateRoles(req.user!.orgId, req.body);
    const before = team.toJSON();
    team.set(req.body);
    await team.save();
    await syncTeamLead(team);
    audit(req.user!, { action: 'team.update', entity: 'Team', entityId: team._id, summary: `Updated team ${team.name}`, before, after: team.toJSON(), ip: req.ip });
    if (req.body.managerId !== undefined) {
      await Lead.updateMany({ teamId: team._id }, { $set: { managerId: team.managerId ?? null } });
    }
    ok(res, team.toJSON());
  }),
);

/** Add or move members into a team (updates their teamId). */
teamsRouter.post(
  '/:id/members',
  requirePermission('admin.teams'),
  validate({ params: idParam, body: z.object({ userIds: z.array(objectId).min(1) }) }),
  asyncHandler(async (req, res) => {
    const team = await Team.findOne({ _id: req.params.id, orgId: req.user!.orgId });
    if (!team) throw notFound('Team');
    const r = await User.updateMany(
      { _id: { $in: req.body.userIds }, orgId: req.user!.orgId, role: { $in: ['agent', 'team_lead'] } },
      { $set: { teamId: team._id } },
    );
    // Moving a user moves their leads' team + manager for correct visibility.
    await Lead.updateMany({ ownerId: { $in: req.body.userIds }, isDeleted: false }, { $set: { teamId: team._id, managerId: team.managerId ?? null } });
    audit(req.user!, { action: 'team.members_add', entity: 'Team', entityId: team._id, summary: `Added ${r.modifiedCount} member(s) to ${team.name}`, after: { userIds: req.body.userIds }, ip: req.ip });
    ok(res, { updated: r.modifiedCount });
  }),
);

teamsRouter.delete(
  '/:id/members/:userId',
  requirePermission('admin.teams'),
  validate({ params: idParam.extend({ userId: objectId }) }),
  asyncHandler(async (req, res) => {
    const team = await Team.findOne({ _id: req.params.id, orgId: req.user!.orgId });
    if (!team) throw notFound('Team');
    const open = await Lead.countDocuments({ ownerId: req.params.userId, isDeleted: false });
    if (open > 0) throw conflict(`This member owns ${open} lead(s). Reassign them before removing from the team.`, { leadCount: open });
    await User.updateOne({ _id: req.params.userId, teamId: team._id }, { $set: { teamId: null } });
    if (String(team.teamLeadId) === req.params.userId) { team.teamLeadId = null; await team.save(); }
    ok(res, { removed: true });
  }),
);

teamsRouter.delete(
  '/:id',
  requirePermission('admin.teams'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const team = await Team.findOne({ _id: req.params.id, orgId: req.user!.orgId });
    if (!team) throw notFound('Team');
    const [members, leads] = await Promise.all([
      User.countDocuments({ teamId: team._id, isActive: true }),
      Lead.countDocuments({ teamId: team._id, isDeleted: false }),
    ]);
    if (members || leads) throw conflict(`Team has ${members} member(s) and ${leads} lead(s). Move them first or deactivate the team.`, { members, leads });
    await team.deleteOne();
    ok(res, { deleted: true });
  }),
);

async function validateRoles(orgId: string, body: { managerId?: string | null; teamLeadId?: string | null }) {
  if (body.managerId) {
    const m = await User.findOne({ _id: body.managerId, orgId, isActive: true }).select('role').lean();
    if (!m || !['branch_manager', 'admin'].includes(m.role)) throw badRequest('Manager must be an active Branch Manager or Admin');
  }
  if (body.teamLeadId) {
    const tl = await User.findOne({ _id: body.teamLeadId, orgId, isActive: true }).select('role').lean();
    if (!tl || tl.role !== 'team_lead') throw badRequest('Team lead must be an active user with the Team Lead role');
  }
}

async function syncTeamLead(team: { _id: unknown; teamLeadId?: unknown; managerId?: unknown }) {
  if (team.teamLeadId) await User.updateOne({ _id: team.teamLeadId }, { $set: { teamId: team._id } });
}
