import mongoose, { Document, Model, Schema } from 'mongoose';
import { ADMIN_ROLES, type AdminPermissionLevels } from '../utils/adminRbac/types';

const SINGLETON_ID = 'admin-role-access';

export interface IAdminRoleAccess extends Omit<Document, '_id'> {
  _id: string;
  roles: Partial<Record<(typeof ADMIN_ROLES)[number], AdminPermissionLevels>>;
  lastModifiedBy?: mongoose.Types.ObjectId;
  lastModified: Date;
}

interface IAdminRoleAccessModel extends Model<IAdminRoleAccess> {
  getCurrentConfig(): Promise<IAdminRoleAccess>;
}

const schema = new Schema<IAdminRoleAccess>({
  _id: { type: String, default: SINGLETON_ID },
  roles: { type: Schema.Types.Mixed, default: {} },
  lastModifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  lastModified: { type: Date, default: Date.now },
});

schema.statics.getCurrentConfig = async function (): Promise<IAdminRoleAccess> {
  return this.findOneAndUpdate(
    { _id: SINGLETON_ID },
    { $setOnInsert: { roles: {}, lastModified: new Date() } },
    { upsert: true, new: true },
  );
};

export default mongoose.model<IAdminRoleAccess, IAdminRoleAccessModel>('AdminRoleAccess', schema);
