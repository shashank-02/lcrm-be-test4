import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

export const ASSIGNMENT_STRATEGIES = ['round_robin', 'least_loaded', 'specific_user'] as const;

/**
 * Evaluated in `priority` order (lowest first) for every new lead without an owner.
 * First matching rule wins.
 */
const schema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true, index: true },
    name: { type: String, required: true, trim: true },
    priority: { type: Number, default: 100 },
    isActive: { type: Boolean, default: true },
    conditions: {
      sourceIds: { type: [Schema.Types.ObjectId], default: [] },
      stageIds: { type: [Schema.Types.ObjectId], default: [] },
      cities: { type: [String], default: [] },
      states: { type: [String], default: [] },
    },
    strategy: { type: String, enum: ASSIGNMENT_STRATEGIES, default: 'round_robin' },
    targetUserIds: { type: [Schema.Types.ObjectId], default: [] },
    targetTeamId: { type: Schema.Types.ObjectId, ref: 'Team', default: null },
    /** round-robin cursor, advanced atomically */
    cursor: { type: Number, default: 0 },
    assignedCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);
schema.index({ orgId: 1, isActive: 1, priority: 1 });
schema.plugin(toJSONPlugin);

export type AssignmentRuleDoc = InferSchemaType<typeof schema>;
export const AssignmentRule = model('AssignmentRule', schema);
