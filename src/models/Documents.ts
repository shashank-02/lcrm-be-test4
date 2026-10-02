import { Schema, model, type InferSchemaType } from 'mongoose';
import { toJSONPlugin } from '../common/mongoose';

/** Who may see a document/folder/training item. `all` overrides everything else. */
export const audienceSchema = new Schema(
  {
    all: { type: Boolean, default: false },
    /** 'managers' = branch_manager + team_lead, 'agents' = agent, 'admins' = admin */
    roles: { type: [String], default: [] },
    teamIds: { type: [Schema.Types.ObjectId], default: [] },
    userIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { _id: false },
);

const folderSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    name: { type: String, required: true, trim: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'DocFolder', default: null },
    audience: { type: audienceSchema, default: () => ({ all: true }) },
    order: { type: Number, default: 0 },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
folderSchema.index({ orgId: 1, parentId: 1, name: 1 }, { unique: true });
folderSchema.plugin(toJSONPlugin);
export type DocFolderDoc = InferSchemaType<typeof folderSchema>;
export const DocFolder = model('DocFolder', folderSchema);

const documentSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    folderId: { type: Schema.Types.ObjectId, ref: 'DocFolder', default: null },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    docType: { type: String, default: '' }, // pdf, docx, xlsx...
    size: { type: Number, default: 0 },
    storageDriver: { type: String, enum: ['local', 's3'], required: true },
    storageKey: { type: String, required: true },
    audience: { type: audienceSchema, default: () => ({ all: true }) },
    version: { type: Number, default: 1 },
    isActive: { type: Boolean, default: true },
    uploadedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedById: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
documentSchema.index({ orgId: 1, folderId: 1, isActive: 1, name: 1 });
documentSchema.index({ orgId: 1, 'audience.teamIds': 1 });
documentSchema.index({ orgId: 1, 'audience.userIds': 1 });
documentSchema.index({ orgId: 1, docType: 1 });
documentSchema.index({ orgId: 1, createdAt: -1 });
documentSchema.index({ name: 'text', description: 'text' });
documentSchema.plugin(toJSONPlugin);
export type DocumentDoc = InferSchemaType<typeof documentSchema>;
export const Document = model('Document', documentSchema);
