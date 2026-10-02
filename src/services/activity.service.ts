import { Types } from 'mongoose';
import { Activity, type ActivityType } from '../models';

interface LogInput {
  orgId: string | Types.ObjectId;
  leadId: string | Types.ObjectId;
  userId?: string | Types.ObjectId | null;
  type: ActivityType;
  description: string;
  payload?: Record<string, unknown>;
}

export async function logActivity(input: LogInput) {
  return Activity.create({
    orgId: input.orgId,
    leadId: input.leadId,
    userId: input.userId ?? null,
    type: input.type,
    description: input.description,
    payload: input.payload ?? {},
  });
}

export async function logActivities(inputs: LogInput[]) {
  if (!inputs.length) return;
  await Activity.insertMany(
    inputs.map((i) => ({
      orgId: i.orgId,
      leadId: i.leadId,
      userId: i.userId ?? null,
      type: i.type,
      description: i.description,
      payload: i.payload ?? {},
    })),
    { ordered: false },
  );
}
