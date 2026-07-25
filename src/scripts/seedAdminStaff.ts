import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import User from '../models/user';
import connectDB from '../config/db';
import type { AdminRole } from '../utils/adminRbac/types';
import { ADMIN_ROLES } from '../utils/adminRbac/types';

const PASSWORD = 'StaffTest123!';

const STAFF: Array<{ name: string; email: string; adminRole: AdminRole; phone: string }> = [
  { name: 'Super Admin', email: 'super.admin@fixtract.test', adminRole: 'super', phone: '+32000000001' },
  { name: 'Care Agent', email: 'care.admin@fixtract.test', adminRole: 'care', phone: '+32000000002' },
  { name: 'Marketing Lead', email: 'marketing.admin@fixtract.test', adminRole: 'marketing', phone: '+32000000003' },
  { name: 'Quality Reviewer', email: 'quality.admin@fixtract.test', adminRole: 'quality', phone: '+32000000004' },
  { name: 'Finance Analyst', email: 'finance.admin@fixtract.test', adminRole: 'finance', phone: '+32000000005' },
];

async function upsertStaff() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seedAdminStaff is disabled in production');
  }

  await connectDB();
  const hashed = await bcrypt.hash(PASSWORD, 12);

  // Ensure legacy admins get super
  await User.updateMany(
    { role: 'admin', $or: [{ adminRole: { $exists: false } }, { adminRole: null }] },
    { $set: { adminRole: 'super' } }
  );

  for (const member of STAFF) {
    const existing = await User.findOne({ email: member.email });
    if (existing) {
      existing.name = member.name;
      existing.role = 'admin';
      (existing as any).adminRole = member.adminRole;
      existing.accountStatus = 'active';
      existing.isEmailVerified = true;
      existing.isPhoneVerified = true;
      existing.password = hashed;
      await existing.save();
      console.log(`updated ${member.email} (${member.adminRole})`);
    } else {
      await User.create({
        name: member.name,
        email: member.email,
        phone: member.phone,
        password: hashed,
        role: 'admin',
        adminRole: member.adminRole,
        isEmailVerified: true,
        isPhoneVerified: true,
        accountStatus: 'active',
      });
      console.log(`created ${member.email} (${member.adminRole})`);
    }
  }

  console.log('\nDummy staff ready for local testing.');
  console.log('Roles:', ADMIN_ROLES.join(', '));
  await mongoose.disconnect();
}

if (require.main === module) {
  upsertStaff().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export default upsertStaff;
